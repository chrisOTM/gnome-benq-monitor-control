// BenQ Monitor Control: DDC/CI control of the BenQ MA320U from the GNOME top bar.

import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';

import {DdcutilCli} from './lib/ddcutil.js';
import {FlowService} from './lib/flow.js';
import {fmt} from './lib/i18n.js';
import {MA320U} from './lib/model.js';
import {NightLight} from './lib/nightLight.js';
import {loadScenarios} from './lib/scenario.js';
import {MonitorController, MonitorSession} from './lib/session.js';
import {BrightnessKeys} from './ui/brightnessKeys.js';
import {MonitorIndicator} from './ui/indicator.js';

const RETRY_INTERVAL_S = 60;
// After an output change the monitor needs a moment before it answers DDC/CI.
const HOTPLUG_DELAYS_S = [3, 10];

export default class BenqMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._timers = new Set();
        this._hotplugTimers = [];

        const session = new MonitorSession(new DdcutilCli(), MA320U);
        this._controller = new MonitorController(session);
        this._nightLight = new NightLight();
        this._flow = new FlowService({
            controller: this._controller,
            location: () => this._location(),
            launch: desktopId => this._launch(desktopId),
        });
        this._flow.connect('activated', (_flow, name, skipped) => {
            this._notify(skipped
                ? fmt('Scenario %1 activated · %2 action(s) skipped', name, skipped)
                : fmt('Scenario %1 activated', name));
        });
        this._loadScenarios();

        this._settings.connectObject(
            'changed::scenarios', () => this._loadScenarios(),
            'changed::location-enabled', () => this._flow.replan(),
            'changed::latitude', () => this._flow.replan(),
            'changed::longitude', () => this._flow.replan(),
            'changed::brightness-keys', () => this._syncBrightnessKeys(),
            this);

        this._indicator = new MonitorIndicator({
            extension: this,
            controller: this._controller,
            flow: this._flow,
            nightLight: this._nightLight,
            settings: this._settings,
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        Main.layoutManager.connectObject('monitors-changed', () => this._onMonitorsChanged(), this);
        LoginManager.getLoginManager().connectObject('prepare-for-sleep',
            (_manager, aboutToSuspend) => {
                if (!aboutToSuspend)
                    this._onResume();
            }, this);
        // Enabled on the lock screen too, so scheduled scenarios still fire; only the
        // indicator is hidden there.
        Main.sessionMode.connectObject('updated', () => this._syncSessionMode(), this);
        this._syncSessionMode();

        this._brightnessKeys = new BrightnessKeys(this._controller);
        this._syncBrightnessKeys();

        this._addTimer(RETRY_INTERVAL_S, () => {
            if (!this._controller.reachable)
                this._controller.detect();
            return GLib.SOURCE_CONTINUE;
        });

        // The session queue runs the detection before the scenario's writes.
        this._controller.detect();
        this._flow.start();
    }

    disable() {
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers = null;
        this._hotplugTimers = null;
        this._brightnessKeys.destroy(); // gives GNOME's keys back
        this._brightnessKeys = null;
        Main.layoutManager.disconnectObject(this);
        LoginManager.getLoginManager().disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._settings.disconnectObject(this);

        this._indicator.destroy();
        this._indicator = null;
        this._flow.destroy();
        this._flow = null;
        this._nightLight.destroy();
        this._nightLight = null;
        this._controller.destroy();
        this._controller = null;
        this._source?.destroy();
        this._source = null;
        this._settings = null;
    }

    _loadScenarios() {
        const {scenarios, errors} = loadScenarios(this._settings.get_string('scenarios'));
        for (const error of errors)
            console.warn(`benq-monitor-control: skipped an invalid scenario: ${error}`);
        this._flow.setScenarios(scenarios);
    }

    _syncBrightnessKeys() {
        this._brightnessKeys.setActive(this._settings.get_boolean('brightness-keys'));
    }

    _location() {
        if (!this._settings.get_boolean('location-enabled'))
            return null;
        return {
            latitude: this._settings.get_double('latitude'),
            longitude: this._settings.get_double('longitude'),
        };
    }

    _launch(desktopId) {
        const app = Shell.AppSystem.get_default().lookup_app(desktopId);
        if (!app)
            return false;
        app.open_new_window(-1);
        return true;
    }

    _notify(title) {
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: 'BenQ Monitor Control',
                iconName: 'video-display-symbolic',
            });
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const notification = new MessageTray.Notification({source: this._source, title, isTransient: true});
        this._source.addNotification(notification);
    }

    _onMonitorsChanged() {
        for (const id of this._hotplugTimers)
            this._removeTimer(id); // no-op for timers that already ran
        this._hotplugTimers = HOTPLUG_DELAYS_S.map(delay => this._addTimer(delay, () => {
            this._controller.detect();
            return GLib.SOURCE_REMOVE;
        }));
    }

    async _onResume() {
        await this._controller.detect();
        if (!this._flow)
            return; // disabled meanwhile
        this._flow.reapplyCurrent();
        this._flow.replan();
    }

    _syncSessionMode() {
        const locked = Main.sessionMode.isLocked;
        if (locked)
            this._indicator.menu.close();
        this._indicator.visible = !locked;
    }

    _addTimer(seconds, callback) {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            const result = callback();
            if (result === GLib.SOURCE_REMOVE)
                this._timers.delete(id);
            return result;
        });
        this._timers.add(id);
        return id;
    }

    _removeTimer(id) {
        if (this._timers.delete(id))
            GLib.source_remove(id);
    }
}
