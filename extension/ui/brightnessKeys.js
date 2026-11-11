// Takes over GNOME's screen brightness keys so they also change the monitor.
// GNOME's handler still runs first (it steps the laptop panel, if one is active).

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Direction, Scope, connectorName, otherInputShown, route, stepValue} from '../lib/brightnessKeys.js';
import {Feature} from '../lib/model.js';

const SCHEMA = 'org.gnome.shell.keybindings';

// keybinding -> [GNOME's handler on Main.brightnessManager, scope, direction]
const KEYS = {
    'screen-brightness-up': ['_screenBrightnessUp', Scope.GLOBAL, Direction.UP],
    'screen-brightness-down': ['_screenBrightnessDown', Scope.GLOBAL, Direction.DOWN],
    'screen-brightness-up-monitor': ['_screenBrightnessUpCurrentMonitor', Scope.MONITOR, Direction.UP],
    'screen-brightness-down-monitor': ['_screenBrightnessDownCurrentMonitor', Scope.MONITOR, Direction.DOWN],
};

export class BrightnessKeys {
    /** @param {() => (number|null)} homeInput this computer's input value; null: guard off or not learned */
    constructor(controller, homeInput = () => null) {
        this._controller = controller;
        this._homeInput = homeInput;
        this._originals = null; // name -> GNOME's bound handler, while taken over
    }

    /** Take the keys over (true) or give them back (false). */
    setActive(active) {
        if (active)
            this._takeOver();
        else
            this._restore();
    }

    destroy() {
        this._restore();
    }

    _takeOver() {
        if (this._originals)
            return;
        const manager = Main.brightnessManager;
        if (!manager || Object.values(KEYS).some(([method]) => typeof manager[method] !== 'function')) {
            console.warn('benq-monitor-control: GNOME brightness manager not found; brightness keys left untouched');
            return;
        }
        this._originals = new Map();
        for (const [name, [method, scope, direction]] of Object.entries(KEYS)) {
            const original = manager[method].bind(manager);
            this._originals.set(name, original);
            Main.wm.removeKeybinding(name);
            this._add(name, () => this._onKey(original, scope, direction));
        }
    }

    _restore() {
        if (!this._originals)
            return;
        for (const [name, original] of this._originals) {
            Main.wm.removeKeybinding(name);
            this._add(name, original);
        }
        this._originals = null;
    }

    _add(name, handler) {
        Main.wm.addKeybinding(name, new Gio.Settings({schema_id: SCHEMA}),
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL, handler);
    }

    _onKey(original, scope, direction) {
        const snap = this._controller.snapshot;
        const connector = connectorName(snap.connector);
        const decision = route({
            scope,
            usable: snap.reachable && !this._controller.isLocked(Feature.BRIGHTNESS),
            connector,
            pointerConnectors: scope === Scope.MONITOR ? this._pointerConnectors() : [],
        });

        if (decision.delegate)
            original();
        if (!decision.stepMonitor)
            return;

        this._stepMonitor(scope, direction, decision).catch(e =>
            console.error(`benq-monitor-control: brightness key failed: ${e}`));
    }

    // Steps from a fresh base: the monitor's own buttons or Brightness Intelligence may have
    // changed the value since it was last read. Quick presses share one read and then run in order.
    async _stepMonitor(scope, direction, decision) {
        await this._controller.freshen();
        if (!this._originals)
            return; // destroyed or given back while waiting
        const snap = this._controller.snapshot;
        if (!snap.reachable || this._controller.isLocked(Feature.BRIGHTNESS))
            return; // e.g. the fresh read revealed an HDR mode
        // The monitor answers DDC/CI while it shows another computer: leave its brightness alone.
        if (otherInputShown(this._homeInput(), snap.values.get(Feature.INPUT_SOURCE)))
            return;
        const connector = connectorName(snap.connector);
        const maximum = snap.maxima.get(Feature.BRIGHTNESS) ?? 100;
        const current = this._controller.value(Feature.BRIGHTNESS);
        const target = stepValue(current, maximum, direction);
        if (target !== current)
            this._controller.setValue(Feature.BRIGHTNESS, target);
        if (decision.osd)
            this._showOsd(scope, connector, target / maximum, decision.delegate);
    }

    _pointerConnectors() {
        const logical = global.backend.get_current_logical_monitor();
        return logical ? logical.get_monitors().map(m => m.get_connector()) : [];
    }

    _logicalMonitorOf(connector) {
        const manager = global.backend.get_monitor_manager();
        return manager.get_logical_monitors().find(l =>
            l.get_monitors().some(m => m.get_connector() === connector)) ?? null;
    }

    // One call for everything: the OSD manager cancels windows that are not in `levels`.
    _showOsd(scope, connector, level, withGnomeScales) {
        const levels = {};
        if (withGnomeScales && scope === Scope.GLOBAL) {
            for (const scale of Main.brightnessManager?.scales ?? [])
                levels[scale.monitor.get_number()] = {level: scale.value};
        }
        const logical = this._logicalMonitorOf(connector);
        if (logical)
            levels[logical.get_number()] = {level};
        Main.osdWindowManager.show(Gio.Icon.new_for_string('display-brightness-symbolic'), null, levels);
    }
}
