// GNOME Night Light state over the session D-Bus (gsd-color). It warms the signal before
// it leaves the computer; together with the monitor's Low Blue Light both filters add up.

import Gio from 'gi://Gio';

import {Emitter} from './emitter.js';

const BUS_NAME = 'org.gnome.SettingsDaemon.Color';
const OBJECT_PATH = '/org/gnome/SettingsDaemon/Color';
const IFACE = `<node>
  <interface name="org.gnome.SettingsDaemon.Color">
    <property name="NightLightActive" type="b" access="read"/>
  </interface>
</node>`;
const IFACE_INFO = Gio.DBusNodeInfo.new_for_xml(IFACE).interfaces[0];

/** Events: 'changed' () */
export class NightLight extends Emitter {
    constructor() {
        super();
        this._active = false;
        this._cancellable = new Gio.Cancellable();
        this._proxy = null;
        this._proxyId = 0;
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START, IFACE_INFO,
            BUS_NAME, OBJECT_PATH, IFACE_INFO.name, this._cancellable,
            (_source, result) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.log(`benq-monitor-control: Night Light unavailable: ${e.message}`);
                    return;
                }
                this._proxyId = this._proxy.connect('g-properties-changed', () => this.refresh());
                this.refresh();
            });
    }

    /** Whether Night Light is warming the screen right now. */
    get active() {
        return this._active;
    }

    refresh() {
        const active = this._proxy?.get_cached_property('NightLightActive')?.unpack() ?? false;
        if (active !== this._active) {
            this._active = active;
            this.emit('changed');
        }
    }

    destroy() {
        this._cancellable.cancel();
        if (this._proxyId)
            this._proxy.disconnect(this._proxyId);
        this._proxy = null;
        this.disconnectAll();
    }
}
