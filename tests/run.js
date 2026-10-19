// Unit tests for the shell-independent modules: gjs -m tests/run.js
// Expected sun times come from the KDE app's Python implementation (flow/sun.py).

import GLib from 'gi://GLib';
import System from 'system';

import {Direction, Scope, connectorName, route, stepValue} from '../extension/lib/brightnessKeys.js';
import {DdcutilCli, Unreachable, WriteRejected, classifyError, ErrorKind, parseDetectTerse, parseGetvcpTerse} from '../extension/lib/ddcutil.js';
import {runActivation} from '../extension/lib/flow.js';
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
    assertEqual(calls[2], 'ddcutil --bus 15 --permit-unknown-feature setvcp 19 0x3');
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
    }

    detect() {
        return Promise.resolve(this.present ? {bus: 15, model: 'BenQ MA320U', serial: 'x', connector: 'card1-DP-1'} : null);
    }

    read(_handle, codes) {
        if (!this.present)
            return Promise.reject(new Unreachable('gone'));
        const max = {0x10: 100, 0x62: 50, 0x19: 5};
        return Promise.resolve(new Map(codes.map(c => [c, {code: c, current: this.values.get(c), maximum: max[c] ?? 255}])));
    }

    write(_handle, code, value) {
        this.writes.push([code, value]);
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
    assert(session.isLocked(Feature.BRIGHTNESS_INTELLIGENCE), 'learned lock');
    assertEqual(await session.apply(Feature.INPUT_SOURCE, 0x11), ApplyResult.APPLIED);
    assert(!session.reachable, 'input switch drops the handle');
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
