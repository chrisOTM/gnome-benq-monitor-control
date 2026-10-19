// FloW: scenario activation and scheduling.

import GLib from 'gi://GLib';

import {Emitter} from './emitter.js';
import {ACTION_FEATURE, ActionType} from './scenario.js';
import {activeAt, nextStart} from './scheduler.js';
import {ApplyResult} from './session.js';

const CLOCK_JUMP_MS = 2 * 60 * 1000;

/**
 * Apply a scenario's actions: picture mode first (it changes which settings the monitor
 * accepts), then the rest in list order. open_app only when includeApps.
 *
 * @returns {Promise<{applied: string[], skipped: [string, string][]}>}
 */
export async function runActivation(scenario, apply, launch, includeApps) {
    const applied = [];
    const skipped = [];
    const ordered = [
        ...scenario.actions.filter(a => a.type === ActionType.PICTURE_MODE),
        ...scenario.actions.filter(a => a.type !== ActionType.PICTURE_MODE),
    ];
    for (const action of ordered) {
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
 * Events: 'changed' () when the active or next scenario changes,
 * 'activated' (name, skippedCount) for activations that should notify.
 */
export class FlowService extends Emitter {
    constructor({
        controller, location, launch,
        now = () => new Date(),
        wall = () => GLib.get_real_time() / 1000,
        mono = () => GLib.get_monotonic_time() / 1000,
        tickIntervalS = 60,
    }) {
        super();
        this._controller = controller;
        this._location = location;
        this._launch = launch;
        this._now = now;
        this._wall = wall;
        this._mono = mono;
        this._tickInterval = tickIntervalS;
        this._scenarios = [];
        this._activeId = '';
        this._next = null;
        this._retryId = ''; // scenario to re-apply once the monitor answers again
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

    /** @returns {{start: Date, scenario: object}|null} */
    get next() {
        return this._next;
    }

    setScenarios(scenarios) {
        this._scenarios = scenarios;
        if (!this._find(this._activeId))
            this._activeId = '';
        this.replan();
    }

    start() {
        this._clock = {wall: this._wall(), mono: this._mono()};
        this.reapplyCurrent();
        this.replan();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._tickInterval, () => {
            this.tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._controller.disconnect(this._controllerId);
        this.disconnectAll();
    }

    tick() {
        if (this._clockJumped()) {
            console.log('benq-monitor-control: clock jump detected; re-applying the current scenario');
            this.reapplyCurrent();
            this.replan();
            return;
        }
        if (this._next && this._now() >= this._next.start) {
            const {scenario} = this._next;
            this._activate(scenario, true, true);
            this.replan();
        }
    }

    /** After start, resume or a clock jump: no apps, no notification. */
    reapplyCurrent() {
        const scenario = activeAt(this._scenarios, this._now(), this._location());
        if (scenario)
            this._activate(scenario, false, false);
    }

    replan() {
        this._next = nextStart(this._scenarios, this._now(), this._location());
        this.emit('changed');
    }

    activate(id) {
        const scenario = this._find(id);
        if (scenario)
            return this._activate(scenario, true, true);
        return Promise.resolve();
    }

    async _activate(scenario, includeApps, notify) {
        this._activeId = scenario.id;
        this.emit('changed');
        const report = await runActivation(scenario, (f, v) => this._controller.apply(f, v), this._launch, includeApps);
        if (report.skipped.some(([, reason]) => reason === ApplyResult.UNREACHABLE))
            this._retryId = scenario.id;
        if (report.skipped.length)
            console.log(`benq-monitor-control: scenario ${scenario.name} skipped ${JSON.stringify(report.skipped)}`);
        if (notify && scenario.notify)
            this.emit('activated', scenario.name, report.skipped.length);
    }

    _onMonitorState() {
        if (!this._retryId || !this._controller.reachable)
            return;
        const scenario = this._find(this._retryId);
        this._retryId = '';
        if (scenario)
            this._activate(scenario, false, false);
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
