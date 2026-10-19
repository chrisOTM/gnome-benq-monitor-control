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

export class MonitorSession {
    constructor(backend, model) {
        this.backend = backend;
        this.model = model;
        this._handle = null;
        this._values = new Map();
        this._maxima = new Map();
        this._learned = new Set(); // `${mode}/${feature}`
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
        return this._enqueue(() => this._read(this.model.codes(true)));
    }

    /** @returns {Promise<string>} an ApplyResult */
    apply(feature, value) {
        return this._enqueue(() => this._apply(feature, value));
    }

    isLocked(feature) {
        return this.model.isLocked(feature, this.mode) || this._learned.has(`${this.mode}/${feature}`);
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
            if (e instanceof WriteRejected) {
                console.log(`benq-monitor-control: monitor rejected ${feature}=${value} in mode ${this.mode}`);
                if (!NOT_LEARNED.has(feature))
                    this._learned.add(`${this.mode}/${feature}`);
                await this._read([spec.code]);
                return ApplyResult.REJECTED;
            }
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
        if (feature === Feature.PICTURE_MODE)
            await this._read(this.model.codes()); // values are stored per mode on the monitor
        else
            this._values.set(feature, value); // ddcutil verified the write by reading it back
        if (isInput)
            this._handle = null; // the monitor now shows another source
        return ApplyResult.APPLIED;
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
        const maximum = this._maxima.get(spec.feature) ?? spec.maximum ?? 100;
        return spec.minimum <= value && value <= maximum;
    }

    _fail(e) {
        console.warn(`benq-monitor-control: DDC unavailable: ${e.message}`);
        this._error = e.message;
        this._hint = e.hint || null;
        this._handle = null;
    }
}

function monotonicMs() {
    return GLib.get_monotonic_time() / 1000;
}

/**
 * UI-facing state on top of the session: shows the user's value until the monitor
 * confirms or rejects it, sends only the latest slider value per feature, and keeps
 * polling away from writes.
 *
 * Events: 'changed' (), 'write-failed' (feature, reason)
 */
export class MonitorController extends Emitter {
    constructor(session, {quietAfterWriteMs = 2000, clock = monotonicMs} = {}) {
        super();
        this.session = session;
        this.model = session.model;
        this._quietAfter = quietAfterWriteMs;
        this._clock = clock;
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

    /** Re-read everything (menu opened), or reconnect when unreachable. */
    refresh() {
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
            return await job();
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
