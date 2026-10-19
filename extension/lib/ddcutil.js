// Talk to the monitor through the ddcutil CLI, asynchronously.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

export const TIMEOUT_STATUS = 124;
export const PERMISSION_HINT =
    "Grant access to /dev/i2c-*: install ddcutil's udev rule or add your user " +
    'to the i2c group, then log in again.';

export class DdcError extends Error {}

/** ddcutil is missing or may not open /dev/i2c-*. */
export class DdcUnavailable extends DdcError {
    constructor(message, hint = '') {
        super(message);
        this.hint = hint;
    }
}

/** The monitor does not answer (unplugged, standby, other input active). */
export class Unreachable extends DdcError {}

/** The monitor refused the value (read-back differs or feature unsupported). */
export class WriteRejected extends DdcError {}

// Simple non-continuous features report no maximum; any byte value is possible.
export const SNC_MAXIMUM = 0xFF;

const CONTINUOUS = /^VCP ([0-9A-Fa-f]{2}) C (\d+) (\d+)$/;
const SIMPLE_NC = /^VCP ([0-9A-Fa-f]{2}) SNC x([0-9A-Fa-f]{2})$/;
const COMPLEX_NC = /^VCP ([0-9A-Fa-f]{2}) CNC x([0-9A-Fa-f]{2}) x([0-9A-Fa-f]{2}) x([0-9A-Fa-f]{2}) x([0-9A-Fa-f]{2})$/;

/** @returns {Map<number, {code: number, current: number, maximum: number}>} */
export function parseGetvcpTerse(text) {
    const values = new Map();
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        let m;
        if ((m = CONTINUOUS.exec(line))) {
            const code = parseInt(m[1], 16);
            values.set(code, {code, current: Number(m[2]), maximum: Number(m[3])});
        } else if ((m = SIMPLE_NC.exec(line))) {
            const code = parseInt(m[1], 16);
            values.set(code, {code, current: parseInt(m[2], 16), maximum: SNC_MAXIMUM});
        } else if ((m = COMPLEX_NC.exec(line))) {
            const code = parseInt(m[1], 16);
            const [mh, ml, sh, sl] = m.slice(2, 6).map(h => parseInt(h, 16));
            values.set(code, {code, current: (sh << 8) | sl, maximum: (mh << 8) | ml});
        }
    }
    return values;
}

export function parseDetectTerse(text) {
    const displays = [];
    for (const block of text.trim().split(/\n\s*\n/)) {
        const lines = block.split('\n').map(l => l.trim()).filter(l => l);
        if (!lines.length || !lines[0].startsWith('Display '))
            continue;
        const fields = {};
        for (const line of lines.slice(1)) {
            const i = line.indexOf(':');
            if (i >= 0)
                fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
        const bus = /i2c-(\d+)/.exec(fields['I2C bus'] ?? '');
        if (!bus)
            continue;
        const [manufacturer, model, serial] = `${fields['Monitor'] ?? ''}::`.split(':');
        displays.push({
            bus: Number(bus[1]),
            connector: fields['DRM connector'] ?? '',
            manufacturer, model, serial,
        });
    }
    return displays;
}

export const ErrorKind = Object.freeze({
    VERIFY_FAILED: 'verify_failed',
    UNSUPPORTED_FEATURE: 'unsupported_feature',
    NO_DISPLAY: 'no_display',
    PERMISSION: 'permission',
    OTHER: 'other',
});

export function classifyError(text) {
    const t = text.toLowerCase();
    if (t.includes('verification failed'))
        return ErrorKind.VERIFY_FAILED;
    if (t.includes('unrecognized vcp feature') || t.includes('unsupported feature'))
        return ErrorKind.UNSUPPORTED_FEATURE;
    if (t.includes('permission denied') || t.includes('eacces'))
        return ErrorKind.PERMISSION;
    if (['no monitor detected', 'display not found', 'ddc communication failed', 'invalid display'].some(s => t.includes(s)))
        return ErrorKind.NO_DISPLAY;
    return ErrorKind.OTHER;
}

/**
 * Run a command, killing it after timeoutMs.
 *
 * @returns {Promise<{status: number, output: string}>} stdout and stderr merged
 */
export async function runCommand(argv, timeoutMs) {
    let proc;
    try {
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    } catch (e) {
        if (e.matches?.(GLib.spawn_error_quark(), GLib.SpawnError.NOENT))
            throw new DdcUnavailable('ddcutil is not installed', 'sudo apt install ddcutil');
        throw e;
    }
    let timedOut = false;
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        timedOut = true;
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [stdout] = await proc.communicate_utf8_async(null, null);
        await proc.wait_async(null);
        if (timedOut)
            return {status: TIMEOUT_STATUS, output: 'timeout'};
        return {status: proc.get_if_exited() ? proc.get_exit_status() : -1, output: stdout ?? ''};
    } finally {
        if (!timedOut)
            GLib.source_remove(timer);
    }
}

export class DdcutilCli {
    constructor({run = runCommand, binary = 'ddcutil', timeoutMs = 10000} = {}) {
        this._run = run;
        this._binary = binary;
        this._timeoutMs = timeoutMs;
    }

    async detect(modelName) {
        const result = await this._exec('detect', '--terse');
        const displays = parseDetectTerse(result.output);
        const found = displays.find(d => d.model === modelName);
        if (found)
            return {bus: found.bus, model: found.model, serial: found.serial};
        if (!displays.length && classifyError(result.output) === ErrorKind.PERMISSION)
            throw new DdcUnavailable('No permission for /dev/i2c-*', PERMISSION_HINT);
        return null;
    }

    async read(handle, codes) {
        const hex = codes.map(c => c.toString(16).toUpperCase().padStart(2, '0'));
        const result = await this._exec('--bus', String(handle.bus), '--terse', 'getvcp', ...hex);
        const values = parseGetvcpTerse(result.output);
        if (values.size)
            return values;
        if (classifyError(result.output) === ErrorKind.PERMISSION)
            throw new DdcUnavailable('No permission for /dev/i2c-*', PERMISSION_HINT);
        throw new Unreachable(result.output.trim() || `no reply on bus ${handle.bus}`);
    }

    async write(handle, code, value, verify = true) {
        const args = ['--bus', String(handle.bus), '--permit-unknown-feature'];
        if (!verify)
            args.push('--noverify');
        const result = await this._exec(...args, 'setvcp',
            code.toString(16).toUpperCase().padStart(2, '0'), `0x${value.toString(16).toUpperCase()}`);
        if (result.status === 0)
            return;
        const kind = classifyError(result.output);
        if (kind === ErrorKind.VERIFY_FAILED || kind === ErrorKind.UNSUPPORTED_FEATURE)
            throw new WriteRejected(result.output.trim());
        if (kind === ErrorKind.PERMISSION)
            throw new DdcUnavailable('No permission for /dev/i2c-*', PERMISSION_HINT);
        throw new Unreachable(result.output.trim() || 'setvcp failed');
    }

    async _exec(...args) {
        const argv = [this._binary, ...args];
        let result = await this._run(argv, this._timeoutMs);
        if (result.status === TIMEOUT_STATUS && result.output === 'timeout')
            result = await this._run(argv, this._timeoutMs);
        return result;
    }
}
