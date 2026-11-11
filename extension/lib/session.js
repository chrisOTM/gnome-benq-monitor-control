// Monitor state and the only path to the bus: every ddcutil call runs through one queue,
// so no two commands ever overlap.

import GLib from 'gi://GLib';

import {DdcUnavailable, Unreachable, WriteRejected} from './ddcutil.js';
import {Emitter} from './emitter.js';
import {Feature, Kind} from './model.js';

// Rejections of these features depend on the value, not on the picture mode.
const NOT_LEARNED = new Set([Feature.PICTURE_MODE, Feature.INPUT_SOURCE]);

export const ApplyResult = Object.freeze({
    APPLIED: 'applied',
    LOCKED: 'locked',
    REJECTED: 'rejected',
    UNREACHABLE: 'unreachable',
    INVALID: 'invalid',
});

function monotonicMs() {
    return GLib.get_monotonic_time() / 1000;
}

// A rejection is only trusted as a lock when it repeats; locks are forgotten after a while.
const REJECTIONS_TO_LEARN = 2;

export class MonitorSession {
    constructor(backend, model, {clock = monotonicMs, learnedLockTtlMs = 10 * 60 * 1000} = {}) {
        this._clock = clock;
        this._learnedTtl = learnedLockTtlMs;
        this.backend = backend;
        this.model = model;
        this._handle = null;
        this._values = new Map();
        this._maxima = new Map();
        this._learned = new Map(); // `${mode}/${feature}` -> time learned
        this._rejections = new Map(); // `${mode}/${feature}` -> consecutive rejections
        this._firmware = null;
        this._error = null;
        this._hint = null;
        this._tail = Promise.resolve();
    }

    get reachable() {
        return this._handle !== null;
    }

    get mode() {
        return this._values.get(Feature.PICTURE_MODE) ?? null;
    }

    connect() {
        return this._enqueue(() => this._connect());
    }

    readAll() {
        return this._enqueue(() => this._read(this.model.codes()));
    }

    readPolled() {
        return this._enqueue(async () => {
            const before = this.mode;
            await this._read(this.model.codes(true));
            // The values that are not polled are stored per mode, so they are stale now.
            if (this._handle !== null && before !== null && this.mode !== before)
                await this._read(this.model.codes());
        });
    }

    /** @returns {Promise<string>} an ApplyResult */
    apply(feature, value) {
        return this._enqueue(() => this._apply(feature, value));
    }

    isLocked(feature) {
        if (this.model.isLocked(feature, this.mode))
            return true;
        const key = `${this.mode}/${feature}`;
        const learnedAt = this._learned.get(key);
        if (learnedAt === undefined)
            return false;
        if (this._clock() - learnedAt > this._learnedTtl) {
            this._learned.delete(key);
            return false;
        }
        return true;
    }

    /** Give every control a fresh chance (menu opened, detect again). No bus traffic. */
    forgetLearnedLocks() {
        this._learned.clear();
        this._rejections.clear();
    }

    snapshot() {
        return {
            reachable: this.reachable,
            values: new Map(this._values),
            maxima: new Map(this._maxima),
            locked: new Map(this.model.features.map(s => [s.feature, this.isLocked(s.feature)])),
            hdrActive: this.model.hdrModes.has(this.mode),
            firmware: this._firmware,
            bus: this._handle?.bus ?? null,
            connector: this._handle?.connector ?? null, // DRM name, e.g. card1-DP-1
            error: this._error,
            hint: this._hint,
        };
    }

    _enqueue(job) {
        const run = this._tail.then(job);
        this._tail = run.catch(e => console.error(`benq-monitor-control: monitor job failed: ${e}`));
        return run;
    }

    async _connect() {
        try {
            this._handle = await this.backend.detect(this.model.modelName);
        } catch (e) {
            if (e instanceof DdcUnavailable) {
                this._fail(e);
                return false;
            }
            throw e;
        }
        this._error = this._hint = null;
        if (this._handle === null)
            return false;
        await this._read(this.model.codes());
        if (this._handle !== null && this._firmware === null)
            await this._readFirmware();
        return this.reachable;
    }

    async _apply(feature, value) {
        if (this._handle === null)
            return ApplyResult.UNREACHABLE;
        const spec = this.model.spec(feature);
        if (!this._valid(spec, value))
            return ApplyResult.INVALID;
        if (this.isLocked(feature))
            return ApplyResult.LOCKED;
        const isInput = feature === Feature.INPUT_SOURCE;
        try {
            await this.backend.write(this._handle, spec.code, value, !isInput);
        } catch (e) {
            if (e instanceof WriteRejected)
                return this._rejected(spec, feature, value, e);
            if (e instanceof Unreachable) {
                this._handle = null;
                return ApplyResult.UNREACHABLE;
            }
            if (e instanceof DdcUnavailable) {
                this._fail(e);
                return ApplyResult.UNREACHABLE;
            }
            throw e;
        }
        this._rejections.delete(`${this.mode}/${feature}`);
        if (feature === Feature.PICTURE_MODE)
            await this._read(this.model.codes()); // values are stored per mode on the monitor
        else
            this._values.set(feature, value); // ddcutil verified the write by reading it back
        // The monitor now shows another source but keeps answering DDC/CI (measured 2026-11-11),
        // so the handle stays and the value just stored is what it shows.
        return ApplyResult.APPLIED;
    }

    // The monitor refused a write. Re-read everything first: the picture mode may have changed
    // on the monitor itself, and the write may have arrived although the read-back failed.
    async _rejected(spec, feature, value, error) {
        const modeBefore = this.mode;
        const detail = String(error.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
        console.log(`benq-monitor-control: monitor rejected ${feature}=${value} in mode ${modeBefore}: ${detail}`);
        await this._read(this.model.codes());
        if (this._handle === null)
            return ApplyResult.UNREACHABLE;
        const key = `${this.mode}/${feature}`;
        if (this._values.get(feature) === value) {
            this._rejections.delete(key);
            return ApplyResult.APPLIED;
        }
        if (this.model.isLocked(feature, this.mode))
            return ApplyResult.LOCKED;
        if (!NOT_LEARNED.has(feature)) {
            const count = (this._rejections.get(key) ?? 0) + 1;
            this._rejections.set(key, count);
            if (count >= REJECTIONS_TO_LEARN)
                this._learned.set(key, this._clock());
        }
        return ApplyResult.REJECTED;
    }

    async _read(codes) {
        if (this._handle === null)
            return;
        let raw;
        try {
            raw = await this.backend.read(this._handle, codes);
        } catch (e) {
            if (e instanceof Unreachable) {
                this._handle = null;
                return;
            }
            if (e instanceof DdcUnavailable) {
                this._fail(e);
                return;
            }
            throw e;
        }
        for (const spec of this.model.features) {
            const value = raw.get(spec.code);
            if (value === undefined)
                continue;
            this._values.set(spec.feature, value.current);
            this._maxima.set(spec.feature, spec.maximum ?? value.maximum);
        }
    }

    async _readFirmware() {
        try {
            const raw = await this.backend.read(this._handle, [this.model.firmwareCode]);
            const value = raw.get(this.model.firmwareCode);
            if (value !== undefined)
                this._firmware = `${value.current >> 8}.${value.current & 0xFF}`;
        } catch (e) {
            if (!(e instanceof Unreachable || e instanceof DdcUnavailable))
                throw e;
        }
    }

    _valid(spec, value) {
        if (!Number.isInteger(value))
            return false;
        if (spec.kind === Kind.CHOICE)
            return spec.choices.some(c => c.value === value);
        if (spec.kind === Kind.TOGGLE)
            return value === 0 || value === 1;
        const maximum = this._maxima.get(spec.feature) ?? spec.maximum;
        if (maximum === null || maximum === undefined)
            return false; // never write a value that cannot be bounded
        return spec.minimum <= value && value <= maximum;
    }

    _fail(e) {
        console.warn(`benq-monitor-control: DDC unavailable: ${e.message}`);
        this._error = e.message;
        this._hint = e.hint || null;
        this._handle = null;
    }
}

/**
 * UI-facing state on top of the session: shows the user's value until the monitor
 * confirms or rejects it, sends only the latest slider value per feature, and keeps
 * polling away from writes.
 *
 * Events: 'changed' (), 'write-failed' (feature, reason)
 */
export class MonitorController extends Emitter {
    constructor(session, {quietAfterWriteMs = 2000, freshForMs = 10000, clock = monotonicMs} = {}) {
        super();
        this.session = session;
        this.model = session.model;
        this._quietAfter = quietAfterWriteMs;
        this._clock = clock;
        this._freshForMs = freshForMs;
        this._freshAt = -Infinity; // last successful read or write
        this._freshening = null;
        this._snap = session.snapshot();
        this._shown = new Map();
        this._pending = new Map();
        this._inflight = new Set();
        this._dragging = new Set();
        this._quietUntil = -Infinity;
        this._busy = false;
        this._destroyed = false;
    }

    get snapshot() {
        return this._snap;
    }

    get reachable() {
        return this._snap.reachable;
    }

    value(feature) {
        return this._shown.get(feature) ?? this._snap.values.get(feature) ?? 0;
    }

    /** Find the monitor again (bus may have changed). Not `connect`: that is Emitter.connect. */
    detect() {
        return this._job(() => this.session.connect());
    }

    /** Like detect, but gives locked controls a fresh chance first. */
    redetect() {
        this.session.forgetLearnedLocks();
        return this.detect();
    }

    /**
     * Make the polled values current before a relative change (brightness keys) or a decision
     * on the shown input. Resolves at once while they are fresh, a write is pending or the
     * monitor is unreachable. `force` always goes through the session queue, so it also waits
     * for a detection that is still running and the snapshot afterwards is the monitor's answer.
     */
    freshen({force = false} = {}) {
        if (!force && (!this.reachable || this._writing || this._clock() - this._freshAt < this._freshForMs))
            return Promise.resolve();
        // Not _exclusive: that drops the call while a poll is in flight, and the caller must wait.
        this._freshening ??= this._job(() => this.session.readPolled())
            .catch(() => {}) // already logged by the session queue
            .finally(() => {
                this._freshening = null;
            });
        return this._freshening;
    }

    /** Re-read everything (menu opened), or reconnect when unreachable. */
    refresh() {
        this.session.forgetLearnedLocks();
        return this._exclusive(() => this.reachable ? this.session.readAll() : this.session.connect());
    }

    /** Periodic re-read of the values that can change on the monitor itself. */
    poll() {
        if (!this.reachable || this._dragging.size || this._writing || this._clock() < this._quietUntil)
            return Promise.resolve();
        return this._exclusive(() => this.session.readPolled());
    }

    setValue(feature, value) {
        value = Math.round(value);
        this._shown.set(feature, value);
        this._quietUntil = this._clock() + this._quietAfter;
        this.emit('changed');
        if (this._inflight.has(feature))
            this._pending.set(feature, value);
        else
            this._write(feature, value);
    }

    beginDrag(feature) {
        this._dragging.add(feature);
    }

    endDrag(feature) {
        this._dragging.delete(feature);
        this._quietUntil = this._clock() + this._quietAfter;
        this._release(feature);
    }

    /** Apply a value as part of a scenario: no coalescing, result returned to the caller. */
    async apply(feature, value) {
        const result = await this.session.apply(feature, value);
        if (result === ApplyResult.APPLIED)
            this._freshAt = this._clock();
        this._publish();
        return result;
    }

    destroy() {
        this._destroyed = true;
        this.disconnectAll();
    }

    get _writing() {
        return this._inflight.size > 0 || this._pending.size > 0;
    }

    async _write(feature, value) {
        this._inflight.add(feature);
        let result;
        try {
            for (;;) {
                result = await this.session.apply(feature, value);
                if (!this._pending.has(feature))
                    break;
                value = this._pending.get(feature);
                this._pending.delete(feature);
            }
        } catch {
            result = 'error'; // already logged by the session queue
            this._pending.delete(feature);
        }
        this._inflight.delete(feature);
        if (result === ApplyResult.APPLIED)
            this._freshAt = this._clock();
        this._quietUntil = this._clock() + this._quietAfter;
        this._publish();
        this._release(feature);
        if (result !== ApplyResult.APPLIED && !this._destroyed) {
            console.log(`benq-monitor-control: write ${feature} failed: ${result}`);
            this.emit('write-failed', feature, result);
        }
    }

    async _exclusive(job) {
        if (this._busy)
            return;
        this._busy = true;
        try {
            await this._job(job);
        } finally {
            this._busy = false;
        }
    }

    async _job(job) {
        try {
            const result = await job();
            if (this.session.reachable)
                this._freshAt = this._clock();
            return result;
        } finally {
            this._publish();
        }
    }

    _publish() {
        if (this._destroyed)
            return;
        this._snap = this.session.snapshot();
        if (!this._snap.reachable) {
            this._dragging.clear(); // a stuck drag must not block reconnecting
            for (const feature of [...this._shown.keys()])
                this._release(feature, false);
        }
        this.emit('changed');
    }

    _release(feature, notify = true) {
        if (this._inflight.has(feature) || this._pending.has(feature) || this._dragging.has(feature))
            return;
        if (this._shown.delete(feature) && notify && !this._destroyed)
            this.emit('changed');
    }
}
