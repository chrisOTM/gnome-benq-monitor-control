// Preferences: FloW scenario editor, location and sync interval, about.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {_, fmt} from './lib/i18n.js';
import {Feature, MA320U} from './lib/model.js';
import {
    ACTION_FEATURE, ActionType, MAX_OFFSET_MIN, ScheduleKind,
    dumpScenarios, loadScenarios, newScenario, parseTime,
} from './lib/scenario.js';
import {formatTime} from './lib/scheduler.js';
import {sunTimes} from './lib/sun.js';

const ACTION_LABELS = {
    [ActionType.PICTURE_MODE]: 'Picture mode',
    [ActionType.BRIGHTNESS]: 'Brightness',
    [ActionType.VOLUME]: 'Volume',
    [ActionType.LOW_BLUE_LIGHT]: 'Low Blue Light',
    [ActionType.BRIGHTNESS_INTELLIGENCE]: 'Brightness Intelligence',
    [ActionType.OPEN_APP]: 'Open application',
};

const SCHEDULE_KINDS = [
    [ScheduleKind.MANUAL, 'Manual'],
    [ScheduleKind.TIME, 'Time'],
    [ScheduleKind.SUNRISE, 'Sunrise'],
    [ScheduleKind.SUNSET, 'Sunset'],
];

function iconButton(iconName, tooltip, onClick, sensitive = true) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        sensitive,
    });
    button.add_css_class('flat');
    button.connect('clicked', onClick);
    return button;
}

function listApps() {
    return Gio.AppInfo.get_all()
        .filter(app => app.should_show() && app.get_id())
        .map(app => ({id: app.get_id(), name: app.get_display_name()}))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function todaySun(settings) {
    if (!settings.get_boolean('location-enabled'))
        return null;
    const now = new Date();
    const sun = sunTimes(now.getFullYear(), now.getMonth(), now.getDate(),
        settings.get_double('latitude'), settings.get_double('longitude'));
    return sun.sunrise ? sun : null;
}

function scheduleSummary(schedule) {
    const offset = schedule.offset_min ? ` ${schedule.offset_min > 0 ? '+' : '−'}${Math.abs(schedule.offset_min)} min` : '';
    switch (schedule.kind) {
    case ScheduleKind.TIME:
        return fmt('Daily at %1', schedule.at);
    case ScheduleKind.SUNRISE:
        return _('Sunrise') + offset;
    case ScheduleKind.SUNSET:
        return _('Sunset') + offset;
    default:
        return _('Manual');
    }
}

/** Scenario list in GSettings, shared by the list page and the editor. */
class ScenarioModel {
    constructor(settings) {
        this._settings = settings;
        this.scenarios = loadScenarios(settings.get_string('scenarios')).scenarios;
    }

    find(id) {
        return this.scenarios.find(s => s.id === id) ?? null;
    }

    save() {
        this._settings.set_string('scenarios', dumpScenarios(this.scenarios));
    }

    add(name) {
        const scenario = newScenario(name);
        this.scenarios.push(scenario);
        this.save();
        return scenario;
    }

    remove(id) {
        this.scenarios = this.scenarios.filter(s => s.id !== id);
        this.save();
    }

    move(id, delta) {
        const i = this.scenarios.findIndex(s => s.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= this.scenarios.length)
            return;
        [this.scenarios[i], this.scenarios[j]] = [this.scenarios[j], this.scenarios[i]];
        this.save();
    }
}

class ScenarioEditor {
    constructor(window, model, scenario, settings) {
        this._window = window;
        this._model = model;
        this._scenario = scenario;
        this._settings = settings;
        this._apps = null;
        this._actionRows = [];

        const page = new Adw.PreferencesPage();
        this._buildScenarioGroup(page);
        this._buildScheduleGroup(page);
        this._buildActionsGroup(page);
        this._buildDeleteGroup(page);

        const toolbar = new Adw.ToolbarView({content: page});
        toolbar.add_top_bar(new Adw.HeaderBar());
        this.page = new Adw.NavigationPage({title: scenario.name, child: toolbar});
    }

    _save() {
        this._model.save();
    }

    _buildScenarioGroup(page) {
        const group = new Adw.PreferencesGroup();
        const name = new Adw.EntryRow({title: _('Name'), text: this._scenario.name});
        name.connect('changed', () => {
            const text = name.text.trim();
            if (text) {
                name.remove_css_class('error');
                this._scenario.name = text;
                this.page.title = text;
                this._save();
            } else {
                name.add_css_class('error');
            }
        });
        group.add(name);

        const notify = new Adw.SwitchRow({
            title: _('Notify me when this scenario is activated'),
            active: this._scenario.notify,
        });
        notify.connect('notify::active', () => {
            this._scenario.notify = notify.active;
            this._save();
        });
        group.add(notify);
        page.add(group);
    }

    _buildScheduleGroup(page) {
        const schedule = this._scenario.schedule;
        const group = new Adw.PreferencesGroup({title: _('Schedule')});

        const kind = new Adw.ComboRow({
            title: _('Start'),
            model: Gtk.StringList.new(SCHEDULE_KINDS.map(([, label]) => _(label))),
            selected: SCHEDULE_KINDS.findIndex(([k]) => k === schedule.kind),
        });
        group.add(kind);

        const at = new Adw.EntryRow({title: _('At (HH:MM)'), text: schedule.at ?? '07:00'});
        at.connect('changed', () => {
            const parsed = parseTime(at.text);
            if (!parsed) {
                at.add_css_class('error');
                return;
            }
            at.remove_css_class('error');
            schedule.at = `${String(parsed[0]).padStart(2, '0')}:${String(parsed[1]).padStart(2, '0')}`;
            this._save();
        });
        group.add(at);

        const offset = Adw.SpinRow.new_with_range(-MAX_OFFSET_MIN, MAX_OFFSET_MIN, 5);
        offset.title = _('Offset (minutes)');
        offset.value = schedule.offset_min ?? 0;
        offset.connect('notify::value', () => {
            schedule.offset_min = Math.round(offset.value);
            this._save();
        });
        group.add(offset);

        const sunHint = new Adw.ActionRow({subtitle_selectable: false});
        sunHint.add_css_class('property');
        group.add(sunHint);

        const sync = () => {
            const k = schedule.kind;
            const sunKind = k === ScheduleKind.SUNRISE || k === ScheduleKind.SUNSET;
            at.visible = k === ScheduleKind.TIME;
            offset.visible = sunKind;
            const sun = todaySun(this._settings);
            sunHint.visible = sunKind;
            sunHint.title = sun
                ? fmt('Today: sunrise %1, sunset %2', formatTime(sun.sunrise), formatTime(sun.sunset))
                : _('Set a location under General to use sunrise and sunset.');
        };
        kind.connect('notify::selected', () => {
            schedule.kind = SCHEDULE_KINDS[kind.selected][0];
            if (schedule.kind === ScheduleKind.TIME && !parseTime(schedule.at ?? ''))
                schedule.at = parseTime(at.text) ? at.text.trim() : '07:00';
            if (schedule.kind !== ScheduleKind.TIME)
                delete schedule.at;
            if (schedule.kind === ScheduleKind.TIME || schedule.kind === ScheduleKind.MANUAL)
                offset.value = 0; // an offset is only offered for sun times; saves via notify::value
            this._save();
            sync();
        });
        sync();
        page.add(group);
    }

    _buildActionsGroup(page) {
        this._actionsGroup = new Adw.PreferencesGroup({
            title: _('Actions'),
            description: _('Applied from top to bottom; the picture mode always comes first.'),
        });

        const menu = new Gio.Menu();
        for (const type of Object.values(ActionType))
            menu.append(_(ACTION_LABELS[type]), `editor.add-action::${type}`);
        const add = new Gtk.MenuButton({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('Add action'),
            menu_model: menu,
            valign: Gtk.Align.CENTER,
        });
        add.add_css_class('flat');
        this._actionsGroup.set_header_suffix(add);

        const actions = new Gio.SimpleActionGroup();
        const addAction = new Gio.SimpleAction({name: 'add-action', parameter_type: new GLib.VariantType('s')});
        addAction.connect('activate', (_a, param) => this._addAction(param.unpack()));
        actions.add_action(addAction);
        add.insert_action_group('editor', actions);

        this._rebuildActions();
        page.add(this._actionsGroup);
    }

    _addAction(type) {
        let action;
        if (type === ActionType.OPEN_APP) {
            const [first] = this._appList();
            if (!first)
                return;
            action = {type, desktop_id: first.id};
        } else {
            const defaults = {
                [ActionType.PICTURE_MODE]: MA320U.spec(Feature.PICTURE_MODE).choices[0].value,
                [ActionType.BRIGHTNESS]: 50,
                [ActionType.VOLUME]: 20,
                [ActionType.LOW_BLUE_LIGHT]: 0,
                [ActionType.BRIGHTNESS_INTELLIGENCE]: 0,
            };
            action = {type, value: defaults[type]};
        }
        this._scenario.actions.push(action);
        this._save();
        this._rebuildActions();
    }

    _appList() {
        this._apps ??= listApps();
        return this._apps;
    }

    _rebuildActions() {
        for (const row of this._actionRows)
            this._actionsGroup.remove(row);
        this._actionRows = [];
        const actions = this._scenario.actions;
        if (!actions.length) {
            const empty = new Adw.ActionRow({title: _('No actions yet.')});
            empty.add_css_class('dim-label');
            this._actionsGroup.add(empty);
            this._actionRows.push(empty);
            return;
        }
        actions.forEach((action, index) => {
            const row = this._actionRow(action);
            row.add_suffix(iconButton('go-up-symbolic', _('Move up'), () => this._moveAction(index, -1), index > 0));
            row.add_suffix(iconButton('go-down-symbolic', _('Move down'), () => this._moveAction(index, 1),
                index < actions.length - 1));
            row.add_suffix(iconButton('user-trash-symbolic', _('Remove'), () => {
                actions.splice(index, 1);
                this._save();
                this._rebuildActions();
            }));
            this._actionsGroup.add(row);
            this._actionRows.push(row);
        });
    }

    _moveAction(index, delta) {
        const actions = this._scenario.actions;
        [actions[index], actions[index + delta]] = [actions[index + delta], actions[index]];
        this._save();
        this._rebuildActions();
    }

    _actionRow(action) {
        const title = _(ACTION_LABELS[action.type]);
        if (action.type === ActionType.PICTURE_MODE || action.type === ActionType.OPEN_APP) {
            const isApp = action.type === ActionType.OPEN_APP;
            const options = isApp
                ? this._appList().map(a => ({key: a.id, label: a.name}))
                : MA320U.spec(Feature.PICTURE_MODE).choices.map(c => ({key: c.value, label: c.label}));
            const current = isApp ? action.desktop_id : action.value;
            if (!options.some(o => o.key === current))
                options.unshift({key: current, label: fmt('%1 (not installed)', current)});
            const row = new Adw.ComboRow({
                title,
                model: Gtk.StringList.new(options.map(o => o.label)),
                selected: options.findIndex(o => o.key === current),
                enable_search: isApp,
            });
            row.connect('notify::selected', () => {
                const key = options[row.selected].key;
                if (isApp)
                    action.desktop_id = key;
                else
                    action.value = key;
                this._save();
            });
            return row;
        }
        if (action.type === ActionType.BRIGHTNESS_INTELLIGENCE) {
            const row = new Adw.SwitchRow({title, active: action.value !== 0});
            row.connect('notify::active', () => {
                action.value = row.active ? 1 : 0;
                this._save();
            });
            return row;
        }
        const spec = MA320U.spec(ACTION_FEATURE[action.type]);
        const row = Adw.SpinRow.new_with_range(spec.minimum, spec.editorMaximum, 1);
        row.title = title;
        row.value = action.value;
        row.connect('notify::value', () => {
            action.value = Math.round(row.value);
            this._save();
        });
        return row;
    }

    _buildDeleteGroup(page) {
        const group = new Adw.PreferencesGroup();
        const remove = new Adw.ButtonRow({title: _('Delete scenario')});
        remove.add_css_class('destructive-action');
        remove.connect('activated', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('Delete scenario?'),
                body: this._scenario.name,
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('delete', _('Delete'));
            dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_d, response) => {
                if (response !== 'delete')
                    return;
                this._model.remove(this._scenario.id);
                this._window.pop_subpage();
            });
            dialog.present(this._window);
        });
        group.add(remove);
        page.add(group);
    }
}

export default class BenqMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);
        window.add(this._flowPage(window, settings));
        window.add(this._generalPage(settings));
        window.add(this._aboutPage());
    }

    _flowPage(window, settings) {
        const model = new ScenarioModel(settings);
        const page = new Adw.PreferencesPage({title: _('FloW'), icon_name: 'view-list-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: _('FloW scenarios'),
            description: _('A scenario applies a set of monitor settings — from the menu, or every day at a set time, sunrise or sunset.'),
        });
        const add = iconButton('list-add-symbolic', _('Add scenario'), () => {
            const scenario = model.add(_('New scenario'));
            rebuild();
            openEditor(scenario);
        });
        group.set_header_suffix(add);
        page.add(group);

        let rows = [];
        const openEditor = scenario => {
            const editor = new ScenarioEditor(window, model, scenario, settings);
            window.push_subpage(editor.page);
        };
        const rebuild = () => {
            for (const row of rows)
                group.remove(row);
            rows = [];
            if (!model.scenarios.length) {
                const empty = new Adw.ActionRow({title: _('No scenario yet.')});
                empty.add_css_class('dim-label');
                group.add(empty);
                rows.push(empty);
                return;
            }
            model.scenarios.forEach((scenario, index) => {
                const count = scenario.actions.length;
                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(scenario.name, -1),
                    subtitle: `${scheduleSummary(scenario.schedule)} · ${fmt(count === 1 ? '%1 action' : '%1 actions', count)}`,
                    activatable: true,
                });
                row.add_suffix(iconButton('go-up-symbolic', _('Move up'), () => {
                    model.move(scenario.id, -1);
                    rebuild();
                }, index > 0));
                row.add_suffix(iconButton('go-down-symbolic', _('Move down'), () => {
                    model.move(scenario.id, 1);
                    rebuild();
                }, index < model.scenarios.length - 1));
                row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
                row.connect('activated', () => openEditor(scenario));
                group.add(row);
                rows.push(row);
            });
        };
        rebuild();
        // Every edit saves at once; keep names, schedules and counts in the list current.
        settings.connect('changed::scenarios', () => rebuild());
        return page;
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});

        const location = new Adw.PreferencesGroup({
            title: _('Location for sunrise and sunset'),
            description: _('Sun times are computed on this computer; nothing is sent anywhere.'),
        });
        const enabled = new Adw.SwitchRow({title: _('Use location')});
        settings.bind('location-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        location.add(enabled);
        for (const [key, title, limit] of [
            ['latitude', _('Latitude, e.g. 52.52'), 90],
            ['longitude', _('Longitude, e.g. 13.40'), 180],
        ]) {
            const row = Adw.SpinRow.new_with_range(-limit, limit, 0.01);
            row.title = title;
            row.digits = 4;
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            enabled.bind_property('active', row, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
            location.add(row);
        }
        const sunRow = new Adw.ActionRow();
        sunRow.add_css_class('property');
        const syncSun = () => {
            const sun = todaySun(settings);
            sunRow.visible = sun !== null;
            if (sun)
                sunRow.title = fmt('Today: sunrise %1, sunset %2', formatTime(sun.sunrise), formatTime(sun.sunset));
        };
        for (const key of ['location-enabled', 'latitude', 'longitude'])
            settings.connect(`changed::${key}`, syncSun);
        syncSun();
        location.add(sunRow);
        page.add(location);

        const monitor = new Adw.PreferencesGroup({title: _('Monitor')});
        const interval = Adw.SpinRow.new_with_range(2, 60, 1);
        interval.title = _('Sync interval (s)');
        interval.subtitle = _('How often the values are read while the menu is open.');
        settings.bind('sync-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        monitor.add(interval);
        page.add(monitor);
        return page;
    }

    _aboutPage() {
        const page = new Adw.PreferencesPage({title: _('Info'), icon_name: 'help-about-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'BenQ Monitor Control',
            description: _('DDC/CI control for the BenQ MA320U, whose picture modes and eye-care settings are not in its on-screen menu.'),
        });
        const version = new Adw.ActionRow({title: _('Version'), subtitle: this.metadata['version-name'] ?? ''});
        version.add_css_class('property');
        group.add(version);
        const author = new Adw.ActionRow({title: _('Made by chrisOTM.'), subtitle: this.metadata.url ?? ''});
        const link = iconButton('web-browser-symbolic', _('Open on GitHub'), () =>
            new Gtk.UriLauncher({uri: this.metadata.url}).launch(null, null, null));
        author.add_suffix(link);
        group.add(author);
        group.add(new Adw.ActionRow({title: _('License: MIT')}));
        page.add(group);

        const notes = new Adw.PreferencesGroup();
        notes.add(new Adw.ActionRow({
            title: _('Safety'),
            subtitle: _('Writes only picture mode, brightness, volume, input, Low Blue Light and Brightness Intelligence, and checks every write by reading it back.'),
        }));
        notes.add(new Adw.ActionRow({
            subtitle: _('Not affiliated with BenQ. BenQ and MA320U are trademarks of BenQ Corporation.'),
        }));
        page.add(notes);
        return page;
    }
}
