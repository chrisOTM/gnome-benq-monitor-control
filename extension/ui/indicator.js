// Top-bar button with the quick controls (the KDE app's quick panel).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {_, fmt} from '../lib/i18n.js';
import {Feature} from '../lib/model.js';
import {formatTime} from '../lib/scheduler.js';
import {ApplyResult} from '../lib/session.js';

const HINT_TIMEOUT_S = 4;

/** A menu item that runs its action without closing the menu. */
const StayOpenItem = GObject.registerClass(
class StayOpenItem extends PopupMenu.PopupMenuItem {
    _init(text, onActivate) {
        super._init(text);
        this._onActivate = onActivate;
    }

    activate(_event) {
        if (this.sensitive)
            this._onActivate();
    }
});

const SliderItem = GObject.registerClass(
class SliderItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, {format = v => String(v), onChange, onDragBegin, onDragEnd}) {
        super._init({activate: false});
        this._format = format;
        this._maximum = 100;
        this._current = -1;
        this._updating = false;
        this._dragging = false;

        const label = new St.Label({text, y_align: Clutter.ActorAlign.CENTER, style_class: 'benq-slider-label'});
        this.slider = new Slider.Slider(0);
        this.slider.x_expand = true;
        this.slider.accessible_name = text;
        this._valueLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER, style_class: 'benq-slider-value'});
        this.add_child(label);
        this.add_child(this.slider);
        this.add_child(this._valueLabel);

        this.slider.connect('notify::value', () => {
            if (this._updating)
                return;
            const value = Math.round(this.slider.value * this._maximum);
            this._valueLabel.text = this._format(value);
            if (value !== this._current) {
                this._current = value;
                onChange(value);
            }
        });
        this.slider.connect('drag-begin', () => {
            this._dragging = true;
            onDragBegin();
        });
        this.slider.connect('drag-end', () => {
            this._dragging = false;
            this._snap();
            onDragEnd();
        });
    }

    setValue(value, maximum) {
        this._maximum = Math.max(1, maximum);
        if (this._dragging)
            return;
        this._current = value;
        this._valueLabel.text = this._format(value);
        this._snap();
    }

    _snap() {
        this._updating = true;
        this.slider.value = Math.min(1, Math.max(0, this._current / this._maximum));
        this._updating = false;
    }

    // The item itself is never sensitive (activate: false); the slider takes focus and input.
    setSensitive(sensitive) {
        this.slider.reactive = sensitive;
        this.slider.can_focus = sensitive;
        this.opacity = sensitive ? 255 : 128;
    }
});

const StatusItem = GObject.registerClass(
class StatusItem extends PopupMenu.PopupBaseMenuItem {
    _init(title) {
        super._init({reactive: false});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(new St.Label({text: title, style_class: 'benq-title'}));
        this.label = new St.Label({style_class: 'benq-status'});
        this.label.clutter_text.line_wrap = true;
        box.add_child(this.label);
        this.add_child(box);
    }
});

const ConfirmInputDialog = GObject.registerClass(
class ConfirmInputDialog extends ModalDialog.ModalDialog {
    _init(inputLabel, onConfirm) {
        super._init({styleClass: 'benq-confirm-dialog'});
        this.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: fmt('Switch to %1?', inputLabel),
            description: _('This computer loses control of the monitor until you switch back.'),
        }));
        this.setButtons([
            {label: _('Cancel'), action: () => this.close(), key: Clutter.KEY_Escape},
            {
                label: _('Switch'),
                action: () => {
                    this.close();
                    onConfirm();
                },
                default: true,
            },
        ]);
    }
});

export const MonitorIndicator = GObject.registerClass(
class MonitorIndicator extends PanelMenu.Button {
    _init({extension, controller, flow, nightLight, settings}) {
        super._init(0.5, 'BenQ Monitor Control');
        this._extension = extension;
        this._controller = controller;
        this._model = controller.model;
        this._flow = flow;
        this._nightLight = nightLight;
        this._settings = settings;
        this._pollTimer = 0;
        this._hintTimer = 0;
        this._transientHint = '';
        this._syncing = false;

        this._icon = new St.Icon({icon_name: 'video-display-symbolic', style_class: 'system-status-icon'});
        this.add_child(this._icon);

        this._buildMenu();

        this._controllerIds = [
            controller.connect('changed', () => this._sync()),
            controller.connect('write-failed', (_c, _feature, reason) => this._onWriteFailed(reason)),
        ];
        this._flowId = flow.connect('changed', () => this._syncFlow());
        this._nightLightId = nightLight.connect('changed', () => this._sync());
        this.menu.connect('open-state-changed', (_menu, open) => this._onOpenStateChanged(open));

        this._sync();
        this._syncFlow();
    }

    _buildMenu() {
        const menu = this.menu;
        this.menu.box.add_style_class_name('benq-menu');

        this._status = new StatusItem(this._model.displayName);
        menu.addMenuItem(this._status);

        this._hint = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._hint.label.add_style_class_name('benq-hint');
        this._hint.label.clutter_text.line_wrap = true;
        menu.addMenuItem(this._hint);

        this._redetect = new StayOpenItem(_('Detect again'), () => this._controller.detect());
        menu.addMenuItem(this._redetect);

        // Picture mode
        this._modeSection = new PopupMenu.PopupMenuSection();
        this._modeSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Picture mode')));
        this._hdrItem = new PopupMenu.PopupMenuItem(_('HDR signal active'), {reactive: false});
        this._modeSection.addMenuItem(this._hdrItem);
        this._modeItems = this._model.spec(Feature.PICTURE_MODE).choices.map(choice => {
            const item = new StayOpenItem(choice.label, () => this._set(Feature.PICTURE_MODE, choice.value));
            item.choiceValue = choice.value;
            this._modeSection.addMenuItem(item);
            return item;
        });
        menu.addMenuItem(this._modeSection);

        // Picture & sound
        this._controlSection = new PopupMenu.PopupMenuSection();
        this._controlSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Picture & sound')));
        this._brightness = this._sliderItem(_('Brightness'), Feature.BRIGHTNESS);
        this._volume = this._sliderItem(_('Volume'), Feature.VOLUME);
        this._controlSection.addMenuItem(this._brightness);
        this._controlSection.addMenuItem(this._volume);

        // Eye care
        this._controlSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Eye care')));
        this._lowBlueLight = this._sliderItem(_('Low Blue Light'), Feature.LOW_BLUE_LIGHT,
            v => v === 0 ? _('Off') : String(v));
        this._controlSection.addMenuItem(this._lowBlueLight);
        this._eyeHint = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._eyeHint.label.add_style_class_name('benq-hint');
        this._eyeHint.label.clutter_text.line_wrap = true;
        this._controlSection.addMenuItem(this._eyeHint);
        this._intelligence = new PopupMenu.PopupSwitchMenuItem(_('Brightness Intelligence'), false);
        this._intelligence.activate = event => {
            // Toggle in place; the default implementation closes the menu.
            if (this._intelligence.sensitive)
                this._intelligence.toggle();
            return event;
        };
        this._intelligence.connect('toggled', (_item, state) => {
            if (!this._syncing)
                this._set(Feature.BRIGHTNESS_INTELLIGENCE, state ? 1 : 0);
        });
        this._controlSection.addMenuItem(this._intelligence);

        // Input
        this._input = new PopupMenu.PopupSubMenuMenuItem('', false);
        this._inputItems = this._model.spec(Feature.INPUT_SOURCE).choices.map(choice => {
            const item = new PopupMenu.PopupMenuItem(choice.label);
            item.choiceValue = choice.value;
            item.connect('activate', () => this._confirmInput(choice));
            this._input.menu.addMenuItem(item);
            return item;
        });
        this._controlSection.addMenuItem(this._input);
        menu.addMenuItem(this._controlSection);

        // FloW
        this._flowHeader = new PopupMenu.PopupSeparatorMenuItem(_('FloW'));
        menu.addMenuItem(this._flowHeader);
        this._flowSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._flowSection);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = new PopupMenu.PopupMenuItem(_('Settings…'));
        settingsItem.connect('activate', () => this._extension.openPreferences());
        menu.addMenuItem(settingsItem);
    }

    _sliderItem(text, feature, format = undefined) {
        return new SliderItem(text, {
            format,
            onChange: value => this._set(feature, value),
            onDragBegin: () => this._controller.beginDrag(feature),
            onDragEnd: () => this._controller.endDrag(feature),
        });
    }

    _set(feature, value) {
        this._controller.setValue(feature, value);
    }

    _confirmInput(choice) {
        if (choice.value === this._controller.value(Feature.INPUT_SOURCE))
            return;
        new ConfirmInputDialog(choice.label, () => this._set(Feature.INPUT_SOURCE, choice.value)).open();
    }

    _onOpenStateChanged(open) {
        if (open) {
            this._controller.refresh();
            this._nightLight.refresh();
            this._startPolling();
        } else {
            this._stopPolling();
            for (const feature of [Feature.BRIGHTNESS, Feature.VOLUME, Feature.LOW_BLUE_LIGHT])
                this._controller.endDrag(feature); // safety net when a release never arrives
        }
    }

    _startPolling() {
        this._stopPolling();
        const interval = this._settings.get_int('sync-interval');
        this._pollTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._controller.poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._pollTimer)
            GLib.source_remove(this._pollTimer);
        this._pollTimer = 0;
    }

    _onWriteFailed(reason) {
        this._transientHint = reason === ApplyResult.UNREACHABLE
            ? _('Monitor not reachable')
            : _('The monitor did not accept the change.');
        if (this._hintTimer)
            GLib.source_remove(this._hintTimer);
        this._hintTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, HINT_TIMEOUT_S, () => {
            this._hintTimer = 0;
            this._transientHint = '';
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
        this._sync();
    }

    _sync() {
        const c = this._controller;
        const snap = c.snapshot;
        const reachable = snap.reachable;

        this._icon.opacity = reachable ? 255 : 128;
        if (reachable) {
            const parts = [_('Connected'), fmt('I²C bus %1', snap.bus)];
            if (snap.firmware)
                parts.push(fmt('Firmware %1', snap.firmware));
            this._status.label.text = parts.join(' · ');
        } else {
            this._status.label.text = [_(snap.error ?? 'Monitor not reachable'), snap.hint ? _(snap.hint) : '']
                .filter(t => t).join('\n');
        }
        this._hint.label.text = this._transientHint;
        this._hint.visible = this._transientHint !== '';
        this._redetect.visible = !reachable;
        this._modeSection.actor.visible = reachable;
        this._controlSection.actor.visible = reachable;
        if (!reachable)
            return;

        const mode = c.value(Feature.PICTURE_MODE);
        this._hdrItem.visible = snap.hdrActive;
        for (const item of this._modeItems) {
            item.setOrnament(item.choiceValue === mode ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.setSensitive(!snap.locked.get(Feature.PICTURE_MODE));
        }

        const maximum = feature => snap.maxima.get(feature) ?? 100;
        for (const [item, feature] of [
            [this._brightness, Feature.BRIGHTNESS],
            [this._volume, Feature.VOLUME],
            [this._lowBlueLight, Feature.LOW_BLUE_LIGHT],
        ]) {
            item.setValue(c.value(feature), maximum(feature));
            item.setSensitive(!snap.locked.get(feature));
        }

        const lblLocked = snap.locked.get(Feature.LOW_BLUE_LIGHT);
        let eyeHint = '';
        if (lblLocked && !snap.hdrActive)
            eyeHint = _('Not available in the current picture mode.');
        else if (!lblLocked && c.value(Feature.LOW_BLUE_LIGHT) > 0 && this._nightLight.active)
            eyeHint = _('Night Light is active — the effects add up.');
        this._eyeHint.label.text = eyeHint;
        this._eyeHint.visible = eyeHint !== '';

        const intelligence = c.value(Feature.BRIGHTNESS_INTELLIGENCE) !== 0; // 2 also means on
        if (this._intelligence.state !== intelligence) {
            this._syncing = true;
            this._intelligence.setToggleState(intelligence);
            this._syncing = false;
        }
        this._intelligence.setSensitive(!snap.locked.get(Feature.BRIGHTNESS_INTELLIGENCE));

        const input = c.value(Feature.INPUT_SOURCE);
        this._input.label.text = fmt('Input: %1', this._model.choiceLabel(Feature.INPUT_SOURCE, input) ?? '—');
        for (const item of this._inputItems)
            item.setOrnament(item.choiceValue === input ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }

    _syncFlow() {
        const active = this._flow.active;
        const next = this._flow.next;
        if (active && next)
            this._flowHeader.label.text = fmt('FloW: %1 until %2', active.name, formatTime(next.start));
        else if (active)
            this._flowHeader.label.text = fmt('FloW: %1', active.name);
        else
            this._flowHeader.label.text = _('FloW');

        this._flowSection.removeAll();
        const scenarios = this._flow.scenarios;
        if (!scenarios.length) {
            this._flowSection.addMenuItem(new PopupMenu.PopupMenuItem(
                _('No scenario yet. Add one under Settings.'), {reactive: false}));
            return;
        }
        for (const scenario of scenarios) {
            const item = new StayOpenItem(scenario.name, () => this._flow.activate(scenario.id));
            item.setOrnament(scenario.id === this._flow.activeId ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            this._flowSection.addMenuItem(item);
        }
    }

    destroy() {
        this._stopPolling();
        if (this._hintTimer)
            GLib.source_remove(this._hintTimer);
        this._hintTimer = 0;
        for (const id of this._controllerIds)
            this._controller.disconnect(id);
        this._flow.disconnect(this._flowId);
        this._nightLight.disconnect(this._nightLightId);
        super.destroy();
    }
});
