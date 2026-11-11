// Unit tests for the shell-independent modules: gjs -m tests/run.js
// Expected sun times come from the KDE app's Python implementation (flow/sun.py).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {Direction, Scope, connectorName, otherInputShown, route, stepValue} from '../extension/lib/brightnessKeys.js';
import {DdcutilCli, Unreachable, WriteRejected, classifyError, ErrorKind, parseDetectTerse, parseGetvcpTerse, runCommand} from '../extension/lib/ddcutil.js';
import {FlowService, runActivation} from '../extension/lib/flow.js';
import {fmt, setLanguage} from '../extension/lib/i18n.js';
import {Feature, MA320U} from '../extension/lib/model.js';
import {loadScenarios, dumpScenarios, scenarioFromJson} from '../extension/lib/scenario.js';
import {activeAt, nextStart} from '../extension/lib/scheduler.js';
import {ApplyResult, MonitorController, MonitorSession} from '../extension/lib/session.js';
import {sunTimes} from '../extension/lib/sun.js';

const tests = [];
const test = (name, fn) => tests.push({name, fn});

function assertEqual(actual, expected, message = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message} expected ${e}, got ${a}`);
}

function assert(condition, message = 'assertion failed') {
    if (!condition)
        throw new Error(message);
}

async function assertRejects(promise, cls) {
    try {
        await promise;
    } catch (e) {
        assert(e instanceof cls, `expected ${cls.name}, got ${e}`);
        return;
    }
    throw new Error(`expected ${cls.name}, nothing thrown`);
}

const FIXTURE_GETVCP = `VCP 10 C 75 100
VCP 19 CNC x00 x05 x00 x00
VCP 60 SNC x13
VCP 62 CNC x00 x32 x00 x14
VCP 81 CNC x00 x02 x00 x00
VCP DC SNC x0f
`;

const FIXTURE_DETECT = `Invalid display
   I2C bus:          /dev/i2c-14
   DRM connector:    card1-eDP-1
   drm_connector_id: 392
   Monitor:          SDC:ATNA40HQ02-0:

Display 1
   I2C bus:          /dev/i2c-15
   DRM connector:    card1-DP-1
   drm_connector_id: 401
   Monitor:          BNQ:BenQ MA320U:SERIAL000001
`;

// --- ddcutil -----------------------------------------------------------

test('parse getvcp terse (live output 2026-10-19)', () => {
    const v = parseGetvcpTerse(FIXTURE_GETVCP);
    assertEqual(v.get(0x10), {code: 0x10, current: 75, maximum: 100});
    assertEqual(v.get(0x19), {code: 0x19, current: 0, maximum: 5});
    assertEqual(v.get(0x60).current, 0x13);
    assertEqual(v.get(0x62), {code: 0x62, current: 20, maximum: 50});
    assertEqual(v.get(0x81), {code: 0x81, current: 0, maximum: 2});
    assertEqual(v.get(0xDC).current, 0x0F);
});

test('parse detect terse skips invalid displays', () => {
    assertEqual(parseDetectTerse(FIXTURE_DETECT), [{
        bus: 15, connector: 'card1-DP-1', manufacturer: 'BNQ', model: 'BenQ MA320U', serial: 'SERIAL000001',
    }]);
});

test('classify errors', () => {
    assertEqual(classifyError('Verification failed for feature 19'), ErrorKind.VERIFY_FAILED);
    assertEqual(classifyError('open: Permission denied'), ErrorKind.PERMISSION);
    assertEqual(classifyError('DDC communication failed'), ErrorKind.NO_DISPLAY);
});

test('cli builds commands and maps failures', async () => {
    const calls = [];
    const replies = [];
    const cli = new DdcutilCli({run: argv => {
        calls.push(argv.join(' '));
        return Promise.resolve(replies.shift());
    }});
    replies.push({status: 0, output: FIXTURE_DETECT});
    const handle = await cli.detect('BenQ MA320U');
    assertEqual(handle.bus, 15);
    replies.push({status: 0, output: FIXTURE_GETVCP});
    await cli.read(handle, [0xDC, 0x10]);
    assertEqual(calls[1], 'ddcutil --bus 15 --terse getvcp DC 10');
    replies.push({status: 1, output: 'Verification failed'});
    await assertRejects(cli.write(handle, 0x19, 3), WriteRejected);
    assertEqual(calls[2], 'ddcutil --bus 15 --permit-unknown-feature --verify setvcp 19 0x3');
    replies.push({status: 1, output: ''});
    await assertRejects(cli.write(handle, 0x60, 0x11, false), Unreachable);
    assertEqual(calls[3], 'ddcutil --bus 15 --permit-unknown-feature --noverify setvcp 60 0x11');
    replies.push({status: 124, output: 'timeout'}, {status: 0, output: FIXTURE_GETVCP});
    await cli.read(handle, [0x10]);
    assertEqual(calls.length, 6, 'one retry after a timeout');
});

// --- session -----------------------------------------------------------

class FakeBackend {
    constructor() {
        this.values = new Map([[0xDC, 0x0F], [0x10, 75], [0x62, 20], [0x60, 0x13], [0x19, 0], [0x81, 0], [0xC9, 0x0102]]);
        this.present = true;
        this.reject = new Set(); // `${mode}/${code}` the monitor refuses
        this.writes = [];
        this.reads = 0;
        this.rejectNext = 0; // the next N writes are rejected whatever the mode
        this.noMaximum = new Set(); // codes whose maximum the monitor does not report
    }

    detect() {
        return Promise.resolve(this.present ? {bus: 15, model: 'BenQ MA320U', serial: 'x', connector: 'card1-DP-1'} : null);
    }

    read(_handle, codes) {
        if (!this.present)
            return Promise.reject(new Unreachable('gone'));
        this.reads++;
        const max = {0x10: 100, 0x62: 50, 0x19: 5};
        return Promise.resolve(new Map(codes.map(c => [c, {
            code: c, current: this.values.get(c), maximum: this.noMaximum.has(c) ? undefined : max[c] ?? 255,
        }])));
    }

    write(_handle, code, value) {
        this.writes.push([code, value]);
        if (this.rejectNext > 0) {
            this.rejectNext--;
            return Promise.reject(new WriteRejected('Verification failed'));
        }
        if (this.reject.has(`${this.values.get(0xDC)}/${code}`))
            return Promise.reject(new WriteRejected('Verification failed'));
        this.values.set(code, value);
        return Promise.resolve();
    }
}

test('session connects, reads and applies with static and learned locks', async () => {
    const backend = new FakeBackend();
    const session = new MonitorSession(backend, MA320U);
    assert(await session.connect());
    const snap = session.snapshot();
    assertEqual(snap.values.get(Feature.BRIGHTNESS), 75);
    assertEqual(snap.maxima.get(Feature.VOLUME), 50);
    assertEqual(snap.firmware, '1.2');
    assertEqual(await session.apply(Feature.BRIGHTNESS, 101), ApplyResult.INVALID);
    assertEqual(await session.apply(Feature.PICTURE_MODE, 0x0A), ApplyResult.APPLIED);
    assertEqual(await session.apply(Feature.LOW_BLUE_LIGHT, 2), ApplyResult.LOCKED, 'static lock in sRGB');
    assertEqual(await session.apply(Feature.PICTURE_MODE, 0x12), ApplyResult.APPLIED);
    backend.reject.add(`${0x12}/${0x81}`);
    assertEqual(await session.apply(Feature.BRIGHTNESS_INTELLIGENCE, 1), ApplyResult.REJECTED);
    assert(!session.isLocked(Feature.BRIGHTNESS_INTELLIGENCE), 'one rejection does not lock');
    assertEqual(await session.apply(Feature.BRIGHTNESS_INTELLIGENCE, 1), ApplyResult.REJECTED);
    assert(session.isLocked(Feature.BRIGHTNESS_INTELLIGENCE), 'learned lock after the second');
    assertEqual(await session.apply(Feature.INPUT_SOURCE, 0x11), ApplyResult.APPLIED);
    assert(session.reachable, 'the monitor still answers while it shows another input');
    assertEqual(session.snapshot().values.get(Feature.INPUT_SOURCE), 0x11);
});

test('session: an input write that was rejected but arrived keeps the handle too', async () => {
    const backend = new FakeBackend();
    const session = new MonitorSession(backend, MA320U);
    await session.connect();
    backend.write = (_h, code, value) => {
        backend.values.set(code, value);
        return Promise.reject(new WriteRejected('Verification failed'));
    };
    assertEqual(await session.apply(Feature.INPUT_SOURCE, 0x11), ApplyResult.APPLIED);
    assert(session.reachable);
    assertEqual(session.snapshot().values.get(Feature.INPUT_SOURCE), 0x11);
});

test('session: one rejection does not lock, the second consecutive one does, a success resets', async () => {
    const backend = new FakeBackend();
    backend.values.set(0xDC, 0x12);
    const session = new MonitorSession(backend, MA320U);
    await session.connect();
    backend.rejectNext = 1;
    assertEqual(await session.apply(Feature.BRIGHTNESS, 50), ApplyResult.REJECTED);
    assert(!session.isLocked(Feature.BRIGHTNESS));
    assertEqual(await session.apply(Feature.BRIGHTNESS, 50), ApplyResult.APPLIED, 'still writable');
    backend.rejectNext = 1;
    assertEqual(await session.apply(Feature.BRIGHTNESS, 60), ApplyResult.REJECTED);
    assert(!session.isLocked(Feature.BRIGHTNESS), 'the success reset the count');
    backend.rejectNext = 1;
    assertEqual(await session.apply(Feature.BRIGHTNESS, 60), ApplyResult.REJECTED);
    assert(session.isLocked(Feature.BRIGHTNESS), 'second consecutive rejection');
    assertEqual(await session.apply(Feature.BRIGHTNESS, 60), ApplyResult.LOCKED);
});

test('session: rejections of picture mode and input are never counted', async () => {
    const backend = new FakeBackend();
    const session = new MonitorSession(backend, MA320U);
    await session.connect();
    backend.rejectNext = 2;
    await session.apply(Feature.PICTURE_MODE, 0x0A);
    await session.apply(Feature.PICTURE_MODE, 0x0A);
    assert(!session.isLocked(Feature.PICTURE_MODE));
});

test('session: a learned lock expires after the TTL', async () => {
    const backend = new FakeBackend();
    let now = 0;
    const session = new MonitorSession(backend, MA320U, {clock: () => now, learnedLockTtlMs: 1000});
    await session.connect();
    backend.rejectNext = 2;
    await session.apply(Feature.BRIGHTNESS, 50);
    await session.apply(Feature.BRIGHTNESS, 50);
    assert(session.isLocked(Feature.BRIGHTNESS));
    now = 999;
    assert(session.isLocked(Feature.BRIGHTNESS), 'not yet expired');
    now = 1001;
    assert(!session.isLocked(Feature.BRIGHTNESS), 'expired');
    assertEqual(await session.apply(Feature.BRIGHTNESS, 50), ApplyResult.APPLIED);
});

test('session: forgetLearnedLocks clears locks and rejection counts', async () => {
    const backend = new FakeBackend();
    const session = new MonitorSession(backend, MA320U);
    await session.connect();
    backend.rejectNext = 2;
    await session.apply(Feature.BRIGHTNESS, 50);
    await session.apply(Feature.BRIGHTNESS, 50);
    assert(session.isLocked(Feature.BRIGHTNESS));
    const reads = backend.reads;
    session.forgetLearnedLocks();
    assert(!session.isLocked(Feature.BRIGHTNESS));
    assertEqual(backend.reads, reads, 'no bus traffic');
    backend.rejectNext = 1;
    await session.apply(Feature.BRIGHTNESS, 50);
    assert(!session.isLocked(Feature.BRIGHTNESS), 'the count starts again');
});

test('session: a rejection where the monitor holds the value anyway counts as applied', async () => {
    const backend = new FakeBackend();
    const session = new MonitorSession(backend, MA320U);
    await session.connect();
    backend.write = (_h, code, value) => {
        backend.values.set(code, value); // arrived, but ddcutil's read-back failed
        return Promise.reject(new WriteRejected('Verification failed'));
    };
    assertEqual(await session.apply(Feature.BRIGHTNESS, 40), ApplyResult.APPLIED);
    assertEqual(session.snapshot().values.get(Feature.BRIGHTNESS), 40);
    assertEqual(await session.apply(Feature.BRIGHTNESS, 30), ApplyResult.APPLIED);
    assert(!session.isLocked(Feature.BRIGHTNESS));
});

test('session: a rejection after the monitor entered HDR behind our back is LOCKED, nothing learned', async () => {
    const backend = new FakeBackend();
    backend.values.set(0xDC, 0x12);
    const session = new MonitorSession(backend, MA320U);
    await session.connect();
    backend.values.set(0xDC, 0x23); // changed with the monitor's own buttons
    backend.reject.add(`${0x23}/${0x10}`);
    assertEqual(await session.apply(Feature.BRIGHTNESS, 50), ApplyResult.LOCKED);
    assert(session.snapshot().hdrActive);
    backend.values.set(0xDC, 0x12);
    backend.reject.clear();
    await session.readAll();
    assert(!session.isLocked(Feature.BRIGHTNESS), 'nothing learned under the old or new mode');
    assertEqual(await session.apply(Feature.BRIGHTNESS, 50), ApplyResult.APPLIED);
});

test('session: a rejection re-reads every code and reports an unreachable monitor', async () => {
    const backend = new FakeBackend();
    const session = new MonitorSession(backend, MA320U);
    await session.connect();
    backend.write = () => {
        backend.present = false;
        return Promise.reject(new WriteRejected('Verification failed'));
    };
    assertEqual(await session.apply(Feature.BRIGHTNESS, 50), ApplyResult.UNREACHABLE);
});

test('session: range values without a known maximum are invalid (fail closed)', async () => {
    const backend = new FakeBackend();
    backend.noMaximum.add(0x62);
    const session = new MonitorSession(backend, MA320U);
    await session.connect();
    assertEqual(await session.apply(Feature.VOLUME, 10), ApplyResult.INVALID);
    assertEqual(backend.writes.length, 0);
});

test('model: brightness has a pinned maximum of 100', async () => {
    assertEqual(MA320U.spec(Feature.BRIGHTNESS).maximum, 100);
    const backend = new FakeBackend();
    backend.noMaximum.add(0x10);
    const session = new MonitorSession(backend, MA320U);
    await session.connect();
    assertEqual(session.snapshot().maxima.get(Feature.BRIGHTNESS), 100);
    assertEqual(await session.apply(Feature.BRIGHTNESS, 50), ApplyResult.APPLIED);
    assertEqual(await session.apply(Feature.BRIGHTNESS, 101), ApplyResult.INVALID);
});

test('session: readPolled re-reads everything when the picture mode changed on the monitor', async () => {
    const backend = new FakeBackend();
    const session = new MonitorSession(backend, MA320U);
    await session.connect();
    backend.values.set(0x19, 3);
    await session.readPolled();
    assertEqual(session.snapshot().values.get(Feature.LOW_BLUE_LIGHT), 0, 'mode unchanged: not polled');
    backend.values.set(0xDC, 0x12);
    await session.readPolled();
    assertEqual(session.snapshot().values.get(Feature.LOW_BLUE_LIGHT), 3, 'mode changed: everything current');
});

test('cli passes --verify or --noverify explicitly', async () => {
    const calls = [];
    const cli = new DdcutilCli({run: argv => {
        calls.push(argv.join(' '));
        return Promise.resolve({status: 0, output: ''});
    }});
    const handle = {bus: 15};
    await cli.write(handle, 0x10, 50);
    await cli.write(handle, 0x60, 0x11, false);
    assert(calls[0].includes(' --verify ') && !calls[0].includes('--noverify'), calls[0]);
    assert(calls[1].includes(' --noverify ') && !calls[1].includes('--verify'), calls[1]);
});

test('controller: freshen reads only when the values are stale', async () => {
    const backend = new FakeBackend();
    let now = 0;
    const controller = new MonitorController(new MonitorSession(backend, MA320U), {clock: () => now, freshForMs: 10000});
    await controller.detect();
    backend.values.set(0x10, 40); // changed with the monitor's own buttons
    let reads = backend.reads;
    now = 5000;
    await controller.freshen();
    assertEqual(backend.reads, reads, 'fresh: no read');
    assertEqual(controller.value(Feature.BRIGHTNESS), 75);
    now = 10001;
    await controller.freshen();
    assertEqual(backend.reads, reads + 1);
    assertEqual(controller.value(Feature.BRIGHTNESS), 40);
    reads = backend.reads;
    await controller.freshen();
    assertEqual(backend.reads, reads, 'the read made it fresh again');
});

test('controller: freshen({force}) reads while the values are fresh or a write is pending', async () => {
    const backend = new FakeBackend();
    const controller = new MonitorController(new MonitorSession(backend, MA320U), {clock: () => 0});
    await controller.detect();
    backend.values.set(0x60, 0x12);
    let reads = backend.reads;
    await controller.freshen();
    assertEqual(backend.reads, reads, 'fresh: no read without force');
    await controller.freshen({force: true});
    assertEqual(backend.reads, reads + 1);
    assertEqual(controller.snapshot.values.get(Feature.INPUT_SOURCE), 0x12);
    controller.setValue(Feature.BRIGHTNESS, 30);
    reads = backend.reads;
    await controller.freshen({force: true});
    assertEqual(backend.reads, reads + 1, 'forced even with a write pending');
    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => resolve() || GLib.SOURCE_REMOVE));
    const idle = new MonitorController(new MonitorSession(new FakeBackend(), MA320U));
    await idle.freshen({force: true}); // unreachable: resolves at once
});

test('controller: freshen shares one read between concurrent callers', async () => {
    const backend = new FakeBackend();
    let now = 0;
    const controller = new MonitorController(new MonitorSession(backend, MA320U), {clock: () => now});
    await controller.detect();
    now = 60000;
    const reads = backend.reads;
    await Promise.all([controller.freshen(), controller.freshen(), controller.freshen()]);
    assertEqual(backend.reads, reads + 1);
});

test('controller: freshen does not read while a write is pending or when unreachable', async () => {
    const backend = new FakeBackend();
    let now = 0;
    const controller = new MonitorController(new MonitorSession(backend, MA320U), {clock: () => now});
    await controller.detect();
    now = 60000;
    controller.setValue(Feature.BRIGHTNESS, 30);
    const reads = backend.reads;
    await controller.freshen();
    assertEqual(backend.reads, reads);
    assertEqual(controller.value(Feature.BRIGHTNESS), 30, 'the user value stays');
    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => resolve() || GLib.SOURCE_REMOVE));
    const idle = new MonitorController(new MonitorSession(new FakeBackend(), MA320U));
    await idle.freshen(); // never connected
});

test('controller: redetect and refresh forget learned locks, detect does not', async () => {
    const backend = new FakeBackend();
    backend.values.set(0xDC, 0x12);
    const session = new MonitorSession(backend, MA320U);
    const controller = new MonitorController(session);
    await controller.detect();
    const learn = async () => {
        backend.rejectNext = 2;
        await controller.apply(Feature.BRIGHTNESS, 50);
        await controller.apply(Feature.BRIGHTNESS, 50);
        assert(session.isLocked(Feature.BRIGHTNESS));
    };
    await learn();
    await controller.detect();
    assert(session.isLocked(Feature.BRIGHTNESS), 'detect keeps it');
    await controller.redetect();
    assert(!session.isLocked(Feature.BRIGHTNESS), 'redetect forgets');
    await learn();
    await controller.refresh();
    assert(!session.isLocked(Feature.BRIGHTNESS), 'refresh forgets');
});

test('session marks the monitor unreachable when it stops answering', async () => {
    const backend = new FakeBackend();
    const session = new MonitorSession(backend, MA320U);
    await session.connect();
    backend.present = false;
    await session.readPolled();
    assert(!session.reachable);
    assertEqual(await session.apply(Feature.BRIGHTNESS, 10), ApplyResult.UNREACHABLE);
});

test('controller sends only the latest pending slider value', async () => {
    const backend = new FakeBackend();
    const session = new MonitorSession(backend, MA320U);
    const controller = new MonitorController(session, {clock: () => 0});
    await controller.detect();
    controller.setValue(Feature.BRIGHTNESS, 10);
    controller.setValue(Feature.BRIGHTNESS, 20);
    controller.setValue(Feature.BRIGHTNESS, 30);
    assertEqual(controller.value(Feature.BRIGHTNESS), 30, 'shows the user value at once');
    await session.readAll(); // queued behind the writes
    await new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => resolve() ?? GLib.SOURCE_REMOVE));
    assertEqual(backend.writes, [[0x10, 10], [0x10, 30]]);
    assertEqual(controller.value(Feature.BRIGHTNESS), 30);
});

test('controller notifies subscribers after detection', async () => {
    const controller = new MonitorController(new MonitorSession(new FakeBackend(), MA320U));
    let seen = null;
    const id = controller.connect('changed', c => {
        seen = c.reachable;
    });
    assert(typeof id === 'number', 'connect must register a handler, not start a detection');
    await controller.detect();
    assertEqual(seen, true);
});

// --- scenarios and schedule ---------------------------------------------

const BERLIN = {latitude: 52.52, longitude: 13.40};

function scenario(id, schedule, actions = []) {
    return scenarioFromJson({id, name: id, schedule, actions});
}

test('sun times match the Python implementation', () => {
    const near = (date, iso) => assert(Math.abs(date.getTime() - Date.parse(iso)) < 1000, `${date.toISOString()} vs ${iso}`);
    let s = sunTimes(2026, 5, 21, 52.52, 13.40);
    near(s.sunrise, '2026-06-21T02:43:10.846Z');
    near(s.sunset, '2026-06-21T19:33:15.095Z');
    s = sunTimes(2026, 11, 21, 52.52, 13.40);
    near(s.sunrise, '2026-12-21T07:15:00.621Z');
    near(s.sunset, '2026-12-21T14:53:54.409Z');
    s = sunTimes(2026, 8, 1, -33.87, 151.21);
    near(s.sunrise, '2026-08-31T20:13:46.149Z');
    near(s.sunset, '2026-09-01T07:36:51.357Z');
    assertEqual(sunTimes(2026, 5, 21, 69.65, 18.96), {sunrise: null, sunset: null});
});

test('scenario validation and round trip (KDE app format)', () => {
    const text = JSON.stringify({version: 1, scenarios: [
        {id: 'a', name: ' Evening ', schedule: {kind: 'sunset', offset_min: 0},
            actions: [{type: 'picture_mode', value: 15}, {type: 'open_app', desktop_id: 'spotify.desktop'}]},
        {id: 'b', name: 'Broken', schedule: {kind: 'time', at: '25:00'}},
    ]});
    const {scenarios, errors} = loadScenarios(text);
    assertEqual(scenarios.length, 1);
    assertEqual(scenarios[0].name, 'Evening');
    assertEqual(errors.length, 1);
    assertEqual(loadScenarios(dumpScenarios(scenarios)).scenarios, scenarios);
    assertEqual(loadScenarios('{"version":2}').errors, ['unsupported file format']);
});

test('active and next scenario across midnight', () => {
    const day = scenario('day', {kind: 'time', at: '07:00'});
    const night = scenario('night', {kind: 'time', at: '22:00'});
    const manual = scenario('manual', {kind: 'manual'});
    const all = [day, night, manual];
    assertEqual(activeAt(all, new Date(2026, 9, 19, 6, 0), null).id, 'night', 'before 07:00 yesterday evening is active');
    assertEqual(activeAt(all, new Date(2026, 9, 19, 12, 0), null).id, 'day');
    const next = nextStart(all, new Date(2026, 9, 19, 23, 0), null);
    assertEqual(next.scenario.id, 'day');
    assertEqual(next.start.getTime(), new Date(2026, 9, 20, 7, 0).getTime());
});

test('sun schedules need a location and honour the offset', () => {
    const evening = scenario('evening', {kind: 'sunset', offset_min: -30});
    assertEqual(nextStart([evening], new Date(2026, 5, 21, 12, 0), null), null);
    const next = nextStart([evening], new Date(Date.UTC(2026, 5, 21, 10, 0)), BERLIN);
    assert(Math.abs(next.start.getTime() - (Date.parse('2026-06-21T19:33:15Z') - 30 * 60000)) < 1000);
});

test('activation applies the picture mode first and apps only when asked', async () => {
    const s = scenario('s', {kind: 'manual'}, [
        {type: 'brightness', value: 40},
        {type: 'open_app', desktop_id: 'x.desktop'},
        {type: 'picture_mode', value: 0x0A},
        {type: 'low_blue_light', value: 2},
    ]);
    const applied = [];
    const apply = (f, v) => {
        applied.push([f, v]);
        return Promise.resolve(f === Feature.LOW_BLUE_LIGHT ? ApplyResult.LOCKED : ApplyResult.APPLIED);
    };
    const launched = [];
    let report = await runActivation(s, apply, id => launched.push(id) > 0, false);
    assertEqual(applied.map(([f]) => f), [Feature.PICTURE_MODE, Feature.BRIGHTNESS, Feature.LOW_BLUE_LIGHT]);
    assertEqual(report.skipped, [['low_blue_light', 'locked']]);
    assertEqual(launched, []);
    report = await runActivation(s, apply, id => launched.push(id) > 0, true);
    assertEqual(launched, ['x.desktop']);
});

test('translations fill placeholders', () => {
    setLanguage('de');
    assertEqual(fmt('FloW: %1 until %2', 'Abend', '07:12'), 'FloW: Abend bis 07:12');
    setLanguage('en');
    assertEqual(fmt('Scenario %1 activated', 'Evening'), 'Scenario Evening activated');
});

// --- brightness keys -----------------------------------------------------

test('connector names drop the DRM card prefix', () => {
    assertEqual(connectorName('card1-DP-1'), 'DP-1');
    assertEqual(connectorName('card0-HDMI-A-2'), 'HDMI-A-2');
    assertEqual(connectorName('DP-1'), 'DP-1');
    assertEqual(connectorName(''), null);
    assertEqual(connectorName(null), null);
});

test('detect keeps the connector of the monitor', async () => {
    const cli = new DdcutilCli({run: () => Promise.resolve({status: 0, output: FIXTURE_DETECT})});
    assertEqual((await cli.detect('BenQ MA320U')).connector, 'card1-DP-1');
});

test('session snapshot exposes the connector', async () => {
    const session = new MonitorSession(new FakeBackend(), MA320U);
    assertEqual(session.snapshot().connector, null);
    await session.connect();
    assertEqual(session.snapshot().connector, 'card1-DP-1');
});

test('step is 1/20 of the maximum, clamped', () => {
    assertEqual(stepValue(75, 100, Direction.UP), 80);
    assertEqual(stepValue(75, 100, Direction.DOWN), 70);
    assertEqual(stepValue(98, 100, Direction.UP), 100);
    assertEqual(stepValue(3, 100, Direction.DOWN), 0);
    assertEqual(stepValue(0, 100, Direction.DOWN), 0);
    assertEqual(stepValue(100, 100, Direction.UP), 100);
    assertEqual(stepValue(10, 40, Direction.UP), 12);
    assertEqual(stepValue(5, 10, Direction.UP), 6, 'at least 1');
});

test('routing: global keys', () => {
    const base = {scope: Scope.GLOBAL, usable: true, connector: 'DP-1', pointerConnectors: []};
    assertEqual(route(base), {delegate: true, stepMonitor: true, osd: true});
    assertEqual(route({...base, connector: null}), {delegate: true, stepMonitor: true, osd: false});
    assertEqual(route({...base, usable: false}), {delegate: true, stepMonitor: false, osd: false});
});

test('routing: current-monitor keys', () => {
    const base = {scope: Scope.MONITOR, usable: true, connector: 'DP-1'};
    assertEqual(route({...base, pointerConnectors: ['DP-1']}), {delegate: false, stepMonitor: true, osd: true});
    assertEqual(route({...base, pointerConnectors: ['eDP-1']}), {delegate: true, stepMonitor: false, osd: false});
    assertEqual(route({...base, connector: null, pointerConnectors: ['DP-1']}), {delegate: true, stepMonitor: false, osd: false});
    assertEqual(route({...base, usable: false, pointerConnectors: ['DP-1']}), {delegate: true, stepMonitor: false, osd: false});
});

test('held key: steps build on the shown target and coalesce into one pending write', async () => {
    const backend = new FakeBackend();
    const controller = new MonitorController(new MonitorSession(backend, MA320U));
    await controller.detect();
    for (let i = 0; i < 4; i++) {
        const max = controller.snapshot.maxima.get(Feature.BRIGHTNESS);
        controller.setValue(Feature.BRIGHTNESS, stepValue(controller.value(Feature.BRIGHTNESS), max, Direction.DOWN));
    }
    assertEqual(controller.value(Feature.BRIGHTNESS), 55);
    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => resolve() || GLib.SOURCE_REMOVE));
    assertEqual(backend.values.get(0x10), 55);
    assert(backend.writes.length <= 2, `expected coalesced writes, got ${backend.writes.length}`);
});

test('a time schedule ignores offset_min, sun schedules honour it', () => {
    const timed = scenario('t', {kind: 'time', at: '07:00', offset_min: 30});
    const next = nextStart([timed], new Date(2026, 9, 19, 6, 0), null);
    assertEqual(next.start.getTime(), new Date(2026, 9, 19, 7, 0).getTime());
});

test('open_app desktop_id must be a plain file name', () => {
    const make = id => () => scenarioFromJson({id: 'a', name: 'A', actions: [{type: 'open_app', desktop_id: id}]});
    make('spotify.desktop')();
    for (const bad of ['../x.desktop', '/usr/share/applications/x.desktop', 'a/b.desktop']) {
        let thrown = false;
        try {
            make(bad)();
        } catch {
            thrown = true;
        }
        assert(thrown, `${bad} must be rejected`);
    }
});

test('invalid scenarios survive a load/dump round trip, in order', () => {
    const good1 = {id: 'a', name: 'A', schedule: {kind: 'manual'}, actions: []};
    const bad1 = {id: 'b', name: 'B', schedule: {kind: 'time', at: '25:00'}};
    const bad2 = 'garbage';
    const good2 = {id: 'c', name: 'C', schedule: {kind: 'manual'}, actions: []};
    const loaded = loadScenarios(JSON.stringify({version: 1, scenarios: [good1, bad1, bad2, good2]}));
    assertEqual(loaded.scenarios.map(s => s.id), ['a', 'c']);
    assertEqual(loaded.invalid, [bad1, bad2]);
    assertEqual(loaded.errors.length, 2);
    const again = loadScenarios(dumpScenarios(loaded.scenarios, loaded.invalid));
    assertEqual(again.scenarios, loaded.scenarios);
    assertEqual(again.invalid, [bad1, bad2]);
    assertEqual(loadScenarios(dumpScenarios(loaded.scenarios)).invalid, [], 'default: nothing extra');
    assertEqual(loadScenarios('not json').invalid, []);
});

test('otherInputShown is true only for a known home input and a different shown input', () => {
    assertEqual(otherInputShown(0x13, 0x12), true);
    assertEqual(otherInputShown(0x13, 0x13), false);
    assertEqual(otherInputShown(null, 0x12), false, 'guard off');
    assertEqual(otherInputShown(0x13, undefined), false, 'nothing read');
    assertEqual(otherInputShown(0x13, null), false);
    assertEqual(otherInputShown(0, 0x12), true, 'zero is a value');
});

// --- FlowService (port of the KDE app's tests/flow/test_flow_activation.py) ---

const HOME = 0x13;
const OTHER = 0x12;
const BRIGHTNESS = 0x10;
const INPUT = 0x60;

const TIMED = (id, at, actions) => scenarioFromJson({id, name: id, schedule: {kind: 'time', at}, actions});
const MANUAL = (id, actions) => scenarioFromJson({id, name: id, schedule: {kind: 'manual'}, actions});
const APP = {type: 'open_app', desktop_id: 'spotify.desktop'};
const BR = value => ({type: 'brightness', value});
const DAY = () => TIMED('Day', '07:00', [BR(70), APP]);
const EVENING = () => TIMED('Evening', '20:00', [BR(30), APP]);
const MOVIE = () => MANUAL('Movie', [BR(20), APP]);

class Flaky extends FakeBackend {
    // Detects and reads fine, but every write fails like a monitor that dropped off the bus.
    constructor() {
        super();
        this.attempts = 0;
    }

    write() {
        this.attempts++;
        return Promise.reject(new Unreachable('DDC communication failed'));
    }
}

class Clocks {
    constructor() {
        this.now = new Date(2026, 9, 13, 12, 0);
        this.wall = 1e9;
        this.mono = 5e5;
    }

    advance(seconds, suspended = false) {
        this.now = new Date(this.now.getTime() + seconds * 1000);
        this.wall += seconds * 1000;
        if (!suspended)
            this.mono += seconds * 1000;
    }
}

const sleepMs = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => resolve() || GLib.SOURCE_REMOVE));

async function flowEnv(scenarios, {backend = new FakeBackend(), home = null} = {}) {
    const t = {value: 0};
    const controller = new MonitorController(new MonitorSession(backend, MA320U), {clock: () => t.value});
    await controller.detect();
    const clocks = new Clocks();
    const e = {backend, controller, clocks, t, launched: [], notes: [], learned: [], home: {value: home}};
    e.service = new FlowService({
        controller,
        location: () => null,
        launch: id => e.launched.push(id) > 0,
        now: () => clocks.now,
        wall: () => clocks.wall,
        mono: () => clocks.mono,
        homeInput: () => e.home.value,
        learnHomeInput: v => e.learned.push(v),
    });
    e.service.connect('activated', (_s, name, skipped) => e.notes.push([name, skipped]));
    e.service.setScenarios(scenarios);
    return e;
}

// Like start() without the GLib timer.
async function begin(e) {
    e.service.rebaseClock();
    await e.service.reapplyCurrent();
    e.service.replan();
}

async function poll(e, seconds = 5) {
    e.t.value += seconds;
    await e.controller.poll();
    await e.service.idle();
}

async function redetect(e, times = 1) {
    for (let i = 0; i < times; i++) {
        await e.controller.detect(); // eslint-disable-line no-await-in-loop
        await e.service.idle(); // eslint-disable-line no-await-in-loop
    }
}

async function tick(e) {
    e.service.tick();
    await e.service.idle();
}

const brightness = e => e.backend.values.get(BRIGHTNESS);

async function eveningThenManualMovie(e) {
    await begin(e);
    e.clocks.advance(8 * 3600); // 20:00
    await tick(e);
    e.clocks.advance(3600); // 21:00
    await e.service.activate(MOVIE().id);
    e.launched.length = 0;
    e.notes.length = 0;
}

async function resume(e, seconds) {
    e.clocks.advance(seconds, true);
    e.service.rebaseClock();
    await e.service.reapplyCurrent();
    e.service.replan();
}

test('flow: resume re-applies the manual scenario without apps or notification', async () => {
    const e = await flowEnv([DAY(), EVENING(), MOVIE()]);
    await eveningThenManualMovie(e);
    e.backend.values.set(BRIGHTNESS, 5);
    await resume(e, 1800);
    assertEqual(brightness(e), 20);
    assertEqual(e.service.active.name, 'Movie');
    assertEqual([e.launched, e.notes], [[], []]);
});

test('flow: the manual pick expires when a scheduled start passed while suspended', async () => {
    const e = await flowEnv([DAY(), EVENING(), MOVIE()]);
    await eveningThenManualMovie(e);
    await resume(e, 11 * 3600); // 08:00, Day's 07:00 passed
    assertEqual(brightness(e), 70);
    assertEqual(e.service.active.name, 'Day');
});

test('flow: a scheduled start replaces the manual scenario', async () => {
    const e = await flowEnv([DAY(), EVENING(), MOVIE()]);
    await eveningThenManualMovie(e);
    e.clocks.advance(10 * 3600); // 07:00
    await tick(e);
    assertEqual(brightness(e), 70);
    assertEqual(e.launched, ['spotify.desktop']);
    assertEqual(e.notes, [['Day', 0]]);
    e.backend.values.set(BRIGHTNESS, 5);
    await resume(e, 600);
    assertEqual(brightness(e), 70);
    assertEqual(e.service.active.name, 'Day');
});

test('flow: a removed manual scenario falls back to the schedule', async () => {
    const all = [DAY(), EVENING(), MOVIE()];
    const e = await flowEnv(all);
    await begin(e);
    await e.service.activate('Movie');
    e.service.setScenarios(all.filter(s => s.id !== 'Movie'));
    await resume(e, 600);
    assertEqual(brightness(e), 70);
    assertEqual(e.service.active.name, 'Day');
});

test('flow: resume followed by a tick applies once', async () => {
    const e = await flowEnv([DAY()]);
    await begin(e);
    const before = e.backend.writes.length;
    await resume(e, 3 * 3600); // wall clock jumped, monotonic did not
    await tick(e);
    assertEqual(e.backend.writes.length - before, 1);
});

test('flow: a clock jump without resume is still detected by tick', async () => {
    const e = await flowEnv([DAY()]);
    await begin(e);
    const before = e.backend.writes.length;
    e.clocks.advance(3 * 3600, true);
    await tick(e);
    assertEqual(e.backend.writes.length - before, 1);
});

test('flow: failing writes are attempted at most three times per trigger', async () => {
    const e = await flowEnv([DAY()], {backend: new Flaky()});
    await begin(e);
    await redetect(e, 12);
    assertEqual(e.backend.attempts, 3);
    await redetect(e); // still at the limit: nothing happens
    await e.service.reapplyCurrent(); // a new trigger counts again
    await redetect(e, 12);
    assertEqual(e.backend.attempts, 6);
    e.service.recheck();
    await e.service.idle();
    await redetect(e, 12);
    assertEqual(e.backend.attempts, 9);
});

test('flow: a manual activation restarts the count', async () => {
    const e = await flowEnv([DAY(), MOVIE()], {backend: new Flaky()});
    await begin(e);
    await redetect(e, 12);
    assertEqual(e.backend.attempts, 3);
    await e.service.activate('Movie');
    await redetect(e, 12);
    assertEqual(e.backend.attempts, 6);
});

test('flow: no notification while the monitor is absent, then a silent retry', async () => {
    const e = await flowEnv([DAY(), EVENING()]);
    await begin(e);
    e.backend.present = false;
    await redetect(e);
    e.clocks.advance(8 * 3600);
    await tick(e); // Evening starts, nothing can be applied
    assertEqual(e.notes, []);
    assertEqual(brightness(e), 70);
    e.backend.present = true;
    await redetect(e);
    assertEqual(brightness(e), 30);
    assertEqual(e.notes, []);
});

test('flow: a partial success notifies with the skipped count', async () => {
    const mixed = MANUAL('Mixed', [BR(40), {type: 'volume', value: 999}]);
    const e = await flowEnv([mixed]);
    await begin(e);
    await e.service.activate('Mixed');
    assertEqual(brightness(e), 40);
    assertEqual(e.notes, [['Mixed', 1]]);
});

test('flow: an app-only scenario still notifies while the monitor is absent', async () => {
    const e = await flowEnv([MANUAL('Apps', [APP])]);
    await begin(e);
    e.backend.present = false;
    await redetect(e);
    await e.service.activate('Apps');
    assertEqual(e.launched, ['spotify.desktop']);
    assertEqual(e.notes, [['Apps', 0]]);
});

async function guarded() {
    const e = await flowEnv([DAY(), EVENING(), MOVIE()], {home: HOME});
    await begin(e);
    e.launched.length = 0;
    return e;
}

test('flow guard: a scheduled start is held back while another input is shown', async () => {
    const e = await guarded();
    const writes = e.backend.writes.length;
    e.backend.values.set(INPUT, OTHER); // the controller's cached value is still HOME
    e.clocks.advance(8 * 3600); // 20:00
    await tick(e);
    assertEqual(e.backend.writes.length, writes);
    assertEqual([e.notes, e.launched], [[], []]);
    assertEqual([e.service.paused, e.service.activeId], [true, 'Day']);
});

test('flow guard: resume is held back while another input is shown', async () => {
    const e = await guarded();
    const writes = e.backend.writes.length;
    e.backend.values.set(INPUT, OTHER);
    await resume(e, 600);
    assertEqual([e.backend.writes.length, e.service.paused, e.launched], [writes, true, []]);
});

test('flow guard: the current scenario is applied silently when the input returns', async () => {
    const e = await guarded();
    e.backend.values.set(INPUT, OTHER);
    e.clocks.advance(8 * 3600); // 20:00 blocked
    await tick(e);
    e.clocks.advance(11 * 3600); // 07:00 next day, no tick: Day is current now
    e.backend.values.set(INPUT, HOME);
    await poll(e);
    assertEqual(brightness(e), 70);
    assertEqual(e.service.active.name, 'Day');
    assertEqual([e.service.paused, e.launched, e.notes], [false, [], []]);
});

test('flow guard: a manual activation ignores the guard', async () => {
    const e = await guarded();
    e.backend.values.set(INPUT, OTHER);
    e.clocks.advance(8 * 3600);
    await tick(e);
    assertEqual(e.service.paused, true);
    await e.service.activate('Evening');
    assertEqual(brightness(e), 30);
    assertEqual(e.launched, ['spotify.desktop']);
    assertEqual([e.notes, e.service.paused], [[['Evening', 0]], false]);
});

test('flow guard: a pending activation stays held after switching away through the menu', async () => {
    const e = await guarded();
    e.backend.present = false;
    await redetect(e);
    e.clocks.advance(8 * 3600);
    await tick(e); // pending: monitor absent
    assertEqual(e.service.paused, false);
    const writes = e.backend.writes.length;
    e.backend.values.set(INPUT, 0x11); // what the menu's own input switch leaves behind
    e.backend.present = true;
    await redetect(e);
    assertEqual([e.service.paused, e.backend.writes.length], [true, writes]);
});

test('flow guard: without a home input nothing is checked', async () => {
    const e = await flowEnv([DAY()], {home: null});
    e.backend.values.set(INPUT, OTHER);
    await e.controller.refresh();
    await begin(e);
    assertEqual([brightness(e), e.service.paused], [70, false]);
});

test('flow guard: blocked attempts do not count and cost no writes', async () => {
    const e = await guarded();
    e.backend.values.set(INPUT, OTHER);
    e.clocks.advance(8 * 3600);
    await tick(e);
    const writes = e.backend.writes.length;
    for (let i = 0; i < 10; i++)
        await poll(e); // eslint-disable-line no-await-in-loop
    assertEqual([e.backend.writes.length, e.service.paused], [writes, true]);
    e.backend.values.set(INPUT, HOME);
    await poll(e);
    assertEqual([brightness(e), e.backend.writes.length], [30, writes + 1]);
});

test('flow guard: a paused activation is released by tick once the input returned, without any event', async () => {
    const e = await guarded();
    e.backend.values.set(INPUT, OTHER);
    e.clocks.advance(8 * 3600);
    await tick(e);
    assertEqual(e.service.paused, true);
    e.backend.values.set(INPUT, HOME); // nothing reads the monitor, so no changed event
    e.clocks.advance(60);
    await tick(e);
    assertEqual([brightness(e), e.service.paused], [30, false]);
});

test('flow: the home input is reported on every reachable state change', async () => {
    const e = await flowEnv([DAY()]);
    await e.controller.refresh();
    assertEqual(e.learned[e.learned.length - 1], HOME);
    e.learned.length = 0;
    e.backend.present = false;
    await e.controller.detect(); // unreachable: nothing to learn
    assertEqual(e.learned, []);
});

test('flow guard: recheck releases a held activation when the guard is switched off', async () => {
    const e = await guarded();
    e.backend.values.set(INPUT, OTHER);
    e.clocks.advance(8 * 3600);
    await tick(e);
    assertEqual(e.service.paused, true);
    e.home.value = null;
    e.service.recheck();
    await e.service.idle();
    assertEqual([brightness(e), e.service.paused], [30, false]);
});

test('flow: overlapping activations do not interleave their actions', async () => {
    const a = MANUAL('A', [BR(10), {type: 'volume', value: 10}]);
    const b = MANUAL('B', [BR(20), {type: 'volume', value: 20}]);
    const e = await flowEnv([a, b]);
    await begin(e);
    e.backend.writes.length = 0;
    await Promise.all([e.service.activate('A'), e.service.activate('B')]);
    assertEqual(e.backend.writes, [[0x10, 10], [0x62, 10], [0x10, 20], [0x62, 20]]);
});

test('flow: nothing is applied or emitted after destroy', async () => {
    const three = MANUAL('Three', [BR(10), {type: 'volume', value: 10}, {type: 'low_blue_light', value: 1}]);
    const e = await flowEnv([three, DAY()]);
    const write = e.backend.write.bind(e.backend);
    e.backend.write = (...args) => {
        e.service.destroy(); // mid-activation, e.g. the extension is disabled
        return write(...args);
    };
    e.backend.writes.length = 0;
    await e.service.activate('Three');
    assertEqual(e.backend.writes.length, 1, 'the remaining actions are skipped');
    assertEqual(e.notes, []);
    e.clocks.advance(8 * 3600);
    e.service.tick();
    await e.service.idle();
    assertEqual(e.backend.writes.length, 1);
});

test('flow guard: the start is held back while the first detection is still running', async () => {
    const backend = new FakeBackend();
    backend.values.set(INPUT, OTHER);
    const controller = new MonitorController(new MonitorSession(backend, MA320U));
    const clocks = new Clocks();
    const service = new FlowService({
        controller, location: () => null, launch: () => true,
        now: () => clocks.now, wall: () => clocks.wall, mono: () => clocks.mono,
        homeInput: () => HOME,
    });
    service.setScenarios([DAY()]);
    controller.detect(); // as in enable(): not awaited, the snapshot is still unreachable
    await service.reapplyCurrent();
    assertEqual([backend.writes.length, service.paused], [0, true]);
    service.destroy();
});

test('model: the home input must fit the connector of this computer', () => {
    assert(MA320U.canBeHomeInput('card1-DP-1', 0x13), 'USB-C arrives as DisplayPort');
    assert(!MA320U.canBeHomeInput('card1-DP-1', 0x11), 'HDMI shown on a DP connector is another computer');
    assert(MA320U.canBeHomeInput('card0-HDMI-A-2', 0x12));
    assert(!MA320U.canBeHomeInput('card0-HDMI-A-2', 0x13));
    assert(MA320U.canBeHomeInput('', 0x11), 'unknown connector: any input of the monitor');
    assert(MA320U.canBeHomeInput(null, 0x13));
    assert(!MA320U.canBeHomeInput('card1-DP-1', 0x0F), 'not an input of this monitor');
});

test('runCommand kills a command at the timeout and when cancelled', async () => {
    assertEqual(await runCommand(['sh', '-c', 'echo hi'], 5000), {status: 0, output: 'hi\n'});
    assertEqual(await runCommand(['sleep', '5'], 100), {status: 124, output: 'timeout'});
    const cancellable = new Gio.Cancellable();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => cancellable.cancel() ?? GLib.SOURCE_REMOVE);
    const started = GLib.get_monotonic_time();
    assertEqual((await runCommand(['sleep', '5'], 5000, cancellable)).output, 'cancelled');
    assert(GLib.get_monotonic_time() - started < 2e6, 'cancelled long before sleep ends');
    assertEqual((await runCommand(['sleep', '5'], 5000, cancellable)).output, 'cancelled', 'nothing is started after cancel');
});

test('a destroyed controller stops the backend: no command runs afterwards', async () => {
    const calls = [];
    const cli = new DdcutilCli({run: argv => {
        calls.push(argv.join(' '));
        return Promise.resolve({status: 0, output: argv.includes('detect') ? FIXTURE_DETECT : FIXTURE_GETVCP});
    }});
    const session = new MonitorSession(cli, MA320U);
    const controller = new MonitorController(session);
    await controller.detect();
    const before = calls.length;
    controller.destroy();
    assertEqual(await session.apply(Feature.BRIGHTNESS, 10), ApplyResult.UNREACHABLE);
    await session.connect();
    assertEqual(calls.length, before);
    assert(!session.reachable);
});

test('controller: isLocked is live, so a learned lock expires for the keys without any job', async () => {
    const backend = new FakeBackend();
    let now = 0;
    const session = new MonitorSession(backend, MA320U, {clock: () => now, learnedLockTtlMs: 1000});
    const controller = new MonitorController(session, {clock: () => now});
    await controller.detect();
    backend.rejectNext = 2;
    assertEqual(await controller.apply(Feature.BRIGHTNESS, 60), ApplyResult.REJECTED);
    assertEqual(await controller.apply(Feature.BRIGHTNESS, 60), ApplyResult.REJECTED);
    assert(controller.isLocked(Feature.BRIGHTNESS), 'locked after two rejections');
    now += 1001; // nothing reads, writes or publishes in between
    assert(controller.snapshot.locked.get(Feature.BRIGHTNESS), 'the cached snapshot still says locked');
    assert(!controller.isLocked(Feature.BRIGHTNESS), 'the live query sees the expiry');
});

// --- runner --------------------------------------------------------------

const loop = new GLib.MainLoop(null, false);
let failed = 0;
(async () => {
    for (const {name, fn} of tests) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await fn();
            print(`ok   ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}\n     ${e.message}\n${e.stack}`);
        }
    }
    print(`\n${tests.length - failed} passed, ${failed} failed`);
    loop.quit();
})();
loop.run();
System.exit(failed ? 1 : 0);
