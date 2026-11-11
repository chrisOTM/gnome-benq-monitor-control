// FloW: scenario activation and scheduling.

import GLib from 'gi://GLib';

import {otherInputShown} from './brightnessKeys.js';
import {Emitter} from './emitter.js';
import {Feature} from './model.js';
import {ACTION_FEATURE, ActionType} from './scenario.js';
import {activeAt, nextStart} from './scheduler.js';
import {ApplyResult} from './session.js';

const CLOCK_JUMP_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3; // failed activation attempts per trigger while the monitor is unreachable

/**
 * Apply a scenario's actions: picture mode first (it changes which settings the monitor
 * accepts), then the rest in list order. open_app only when includeApps. `cancelled` is checked
 * before every action, so a stopped service does not keep writing.
 *
 * @returns {Promise<{applied: string[], skipped: [string, string][]}>}
 */
export async function runActivation(scenario, apply, launch, includeApps, cancelled = () => false) {
    const applied = [];
    const skipped = [];
    const ordered = [
        ...scenario.actions.filter(a => a.type === ActionType.PICTURE_MODE),
        ...scenario.actions.filter(a => a.type !== ActionType.PICTURE_MODE),
    ];
    for (const action of ordered) {
        if (cancelled())
            break;
        if (action.type === ActionType.OPEN_APP) {
            if (!includeApps)
                continue;
            if (launch(action.desktop_id))
                applied.push(action.type);
            else
                skipped.push([action.type, 'launch_failed']);
            continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const result = await apply(ACTION_FEATURE[action.type], action.value);
        if (result === ApplyResult.APPLIED)
            applied.push(action.type);
        else
            skipped.push([action.type, result]);
    }
    return {applied, skipped};
}

/**
 * Events: 'changed' () when the active or next scenario or the paused state changes,
 * 'activated' (name, skippedCount) for activations that should notify.
 *
 * Automatic activations (scheduled start, resume, retries) are held back while the monitor
 * shows another computer; a manual one from the menu always runs. Activations run one after
 * another, so their actions never interleave in the session queue.
 */
export class FlowService extends Emitter {
    constructor({
        controller, location, launch,
        now = () => new Date(),
        wall = () => GLib.get_real_time() / 1000,
        mono = () => GLib.get_monotonic_time() / 1000,
        tickIntervalS = 60,
        homeInput = () => null, // this computer's input value; null: guard off or not learned
        learnHomeInput = _value => {},
    }) {
        super();
        this._controller = controller;
        this._location = location;
        this._launch = launch;
        this._now = now;
        this._wall = wall;
        this._mono = mono;
        this._tickInterval = tickIntervalS;
        this._homeInput = homeInput;
        this._learnHomeInput = learnHomeInput;
        this._scenarios = [];
        this._activeId = '';
        this._next = null;
        this._manual = null; // {id, at}: the last scenario picked from the menu
        this._pending = false; // the current scenario still has to be applied (monitor away or other input)
        this._attempts = 0; // failed attempts since the last trigger
        this._paused = false; // pending because the monitor shows another input
        this._inflight = 0;
        this._chain = Promise.resolve();
        this._destroyed = false;
        this._clock = null;
        this._timer = 0;
        this._controllerId = controller.connect('changed', () => this._onMonitorState());
    }

    get scenarios() {
        return this._scenarios;
    }

    get activeId() {
        return this._activeId;
    }

    get active() {
        return this._find(this._activeId);
    }

    get paused() {
        return this._paused;
    }

    /** @returns {{start: Date, scenario: object}|null} */
    get next() {
        return this._next;
    }

    /** Resolves when every queued activation has finished. */
    async idle() {
        while (this._inflight > 0)
            await this._chain; // eslint-disable-line no-await-in-loop
    }

    setScenarios(scenarios) {
        this._scenarios = scenarios;
        if (!this._find(this._activeId))
            this._activeId = '';
        this.replan();
    }

    start() {
        this.rebaseClock();
        this.reapplyCurrent();
        this.replan();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._tickInterval, () => {
            this.tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._controller.disconnect(this._controllerId);
        this.disconnectAll();
    }

    /** Take the clocks as they are now, so the next tick does not report a resume as a clock jump. */
    rebaseClock() {
        this._clock = {wall: this._wall(), mono: this._mono()};
    }

    tick() {
        if (this._destroyed)
            return;
        if (this._clockJumped()) {
            console.log('benq-monitor-control: clock jump detected; re-applying the current scenario');
            this.reapplyCurrent();
            this.replan();
            return;
        }
        if (this._next && this._now() >= this._next.start) {
            const {scenario} = this._next;
            this._manual = null; // a scheduled start replaces what the user picked by hand
            this._attempts = 0;
            this._activate(scenario, {includeApps: true, notify: true, automatic: true});
            this.replan();
            return;
        }
        // The cached input is not trustworthy (nothing reads while the menu is closed), so a
        // held or pending activation decides on its own fresh read.
        this._tryPending({trustCache: false});
    }

    /** Automatic trigger (start, resume, clock jump): apply whatever is current now, no apps, no notification. */
    reapplyCurrent() {
        this._attempts = 0;
        return this._applyCurrent();
    }

    /** Re-evaluate a pending activation, e.g. after the input-guard settings changed. */
    recheck() {
        this._attempts = 0;
        this._tryPending({trustCache: false});
    }

    replan() {
        if (this._destroyed)
            return;
        this._next = nextStart(this._scenarios, this._now(), this._location());
        this.emit('changed');
    }

    /** Manual activation from the menu: ignores the input guard. */
    activate(id) {
        const scenario = this._find(id);
        if (!scenario || this._destroyed)
            return Promise.resolve();
        this._manual = {id: scenario.id, at: this._now()};
        this._attempts = 0;
        this._activeId = scenario.id;
        this.emit('changed');
        return this._activate(scenario, {includeApps: true, notify: true, automatic: false});
    }

    /** The manual scenario while no scheduled start has passed since the click, else the scheduled one. */
    _current() {
        const now = this._now();
        if (this._manual) {
            const scenario = this._find(this._manual.id);
            if (scenario) {
                const upcoming = nextStart(this._scenarios, this._manual.at, this._location());
                if (!upcoming || upcoming.start > now)
                    return scenario;
            }
            this._manual = null;
        }
        return activeAt(this._scenarios, now, this._location());
    }

    _applyCurrent() {
        const scenario = this._current();
        if (!scenario) {
            this._pending = false;
            this._setPaused(false);
            return Promise.resolve();
        }
        return this._activate(scenario, {includeApps: false, notify: false, automatic: true});
    }

    // Queue one activation behind the running ones; never rejects.
    _activate(scenario, options) {
        this._inflight++;
        const run = this._chain
            .then(() => this._runJob(scenario, options))
            .catch(e => console.error(`benq-monitor-control: activating ${scenario.name} failed: ${e}`))
            .finally(() => {
                this._inflight--;
            });
        this._chain = run;
        return run;
    }

    async _runJob(scenario, {includeApps, notify, automatic}) {
        if (this._destroyed)
            return;
        const home = automatic ? this._homeInput() : null;
        if (home !== null) {
            // The monitor keeps answering DDC while it shows another computer, so ask it now.
            await this._controller.freshen({force: true});
            if (this._destroyed)
                return;
            const shown = this._controller.reachable
                ? this._controller.snapshot.values.get(Feature.INPUT_SOURCE) : undefined;
            if (otherInputShown(home, shown)) {
                console.log(`benq-monitor-control: monitor shows another input; holding back scenario ${scenario.name}`);
                this._pending = true;
                this._setPaused(true);
                return;
            }
        }
        const report = await runActivation(scenario, (f, v) => this._controller.apply(f, v),
            this._launch, includeApps, () => this._destroyed);
        if (this._destroyed)
            return;
        this._afterActivation(scenario, report, notify);
    }

    _afterActivation(scenario, report, notify) {
        if (this._activeId !== scenario.id) {
            this._activeId = scenario.id;
            this.emit('changed');
        }
        this._setPaused(false);
        const unreachable = report.skipped.some(([, reason]) => reason === ApplyResult.UNREACHABLE);
        if (unreachable) {
            this._attempts++;
            this._pending = true;
            if (this._attempts >= MAX_ATTEMPTS) {
                console.warn(`benq-monitor-control: scenario ${scenario.name}: giving up after ` +
                    `${this._attempts} attempts until the next trigger`);
            }
        } else {
            this._pending = false;
        }
        if (report.skipped.length)
            console.log(`benq-monitor-control: scenario ${scenario.name} skipped ${JSON.stringify(report.skipped)}`);
        const nothingApplied = report.applied.every(type => type === ActionType.OPEN_APP);
        // Nothing reached the monitor: say nothing, the retry applies the scenario silently later.
        if (notify && scenario.notify && !(unreachable && nothingApplied))
            this.emit('activated', scenario.name, report.skipped.length);
    }

    _onMonitorState() {
        if (this._destroyed || !this._controller.reachable)
            return;
        const shown = this._controller.snapshot.values.get(Feature.INPUT_SOURCE);
        if (shown !== undefined)
            this._learnHomeInput(shown);
        this._tryPending({trustCache: true});
    }

    _tryPending({trustCache}) {
        // 'changed' fires inside the activation's own reads: never nest a second activation.
        if (this._destroyed || !this._pending || this._inflight > 0)
            return;
        const home = this._homeInput();
        if (home === null)
            this._setPaused(false);
        if (!this._controller.reachable)
            return;
        if (trustCache && otherInputShown(home, this._controller.snapshot.values.get(Feature.INPUT_SOURCE))) {
            this._setPaused(true); // cheap check on the cached value: no bus traffic, no attempt
            return;
        }
        if (this._attempts >= MAX_ATTEMPTS)
            return;
        this._applyCurrent();
    }

    _setPaused(paused) {
        if (paused === this._paused)
            return;
        this._paused = paused;
        if (!this._destroyed)
            this.emit('changed');
    }

    _clockJumped() {
        const wall = this._wall();
        const mono = this._mono();
        const previous = this._clock;
        this._clock = {wall, mono};
        if (!previous)
            return false;
        return Math.abs((wall - previous.wall) - (mono - previous.mono)) > CLOCK_JUMP_MS;
    }

    _find(id) {
        return this._scenarios.find(s => s.id === id) ?? null;
    }
}
