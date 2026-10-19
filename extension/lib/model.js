// BenQ MA320U — v1 features, verified live on 2026-10-13 with the KDE app
// (benq-monitor-control, tests/fixtures/ddcutil-2026-10-13).

export const Feature = Object.freeze({
    PICTURE_MODE: 'picture_mode',
    BRIGHTNESS: 'brightness',
    VOLUME: 'volume',
    INPUT_SOURCE: 'input_source',
    LOW_BLUE_LIGHT: 'low_blue_light',
    BRIGHTNESS_INTELLIGENCE: 'brightness_intelligence',
});

export const Kind = Object.freeze({
    RANGE: 'range',
    CHOICE: 'choice',
    TOGGLE: 'toggle',
});

const PICTURE_MODES = [
    {value: 0x0F, label: 'Tux-Book'}, // BenQ: M-Book
    {value: 0x0A, label: 'sRGB'},
    {value: 0x22, label: 'Display P3'}, // inferred: gamut switches to 0x03
    {value: 0x32, label: 'Cinema'},
    {value: 0x28, label: 'Game'},
    {value: 0x12, label: 'User'},
];

// The MA320U has three inputs (OSD order). Its capabilities string lists 0x0F DisplayPort
// and 0x15 instead of 0x13, but there is no DisplayPort input; USB-C reads and writes 0x13.
const INPUTS = [
    {value: 0x13, label: 'USB-C'},
    {value: 0x11, label: 'HDMI 1'},
    {value: 0x12, label: 'HDMI 2'},
];

/**
 * @typedef {object} FeatureSpec
 * @property {string} feature
 * @property {number} code VCP code
 * @property {string} kind
 * @property {number} minimum
 * @property {number|null} maximum null: use the maximum the monitor reports
 * @property {number} editorMaximum upper bound offered in the scenario editor
 * @property {{value: number, label: string}[]} choices
 * @property {boolean} polled can change on the monitor itself; re-read periodically
 */

/** @returns {FeatureSpec} */
function spec(feature, code, kind, extra = {}) {
    return {
        feature, code, kind, minimum: 0, maximum: null, editorMaximum: 100,
        choices: [], polled: false, ...extra,
    };
}

export class MonitorModel {
    constructor({modelName, displayName, features, hdrModes = [], hdrLocks = [], locks = {}, firmwareCode = 0xC9}) {
        this.modelName = modelName;
        this.displayName = displayName;
        this.features = features;
        this.hdrModes = new Set(hdrModes);
        this.hdrLocks = new Set(hdrLocks);
        this.locks = new Map(Object.entries(locks).map(([mode, fs]) => [Number(mode), new Set(fs)]));
        this.firmwareCode = firmwareCode;
    }

    spec(feature) {
        const found = this.features.find(s => s.feature === feature);
        if (!found)
            throw new Error(`unknown feature ${feature}`);
        return found;
    }

    codes(polledOnly = false) {
        return this.features.filter(s => s.polled || !polledOnly).map(s => s.code);
    }

    isLocked(feature, mode) {
        if (this.hdrModes.has(mode))
            return this.hdrLocks.has(feature);
        return this.locks.get(mode)?.has(feature) ?? false;
    }

    choiceLabel(feature, value) {
        return this.spec(feature).choices.find(c => c.value === value)?.label ?? null;
    }
}

export const MA320U = new MonitorModel({
    modelName: 'BenQ MA320U',
    displayName: 'BenQ MA320U',
    features: [
        spec(Feature.PICTURE_MODE, 0xDC, Kind.CHOICE, {choices: PICTURE_MODES, polled: true}),
        spec(Feature.BRIGHTNESS, 0x10, Kind.RANGE, {polled: true}),
        spec(Feature.VOLUME, 0x62, Kind.RANGE, {polled: true, editorMaximum: 50}),
        spec(Feature.INPUT_SOURCE, 0x60, Kind.CHOICE, {choices: INPUTS, polled: true}),
        spec(Feature.LOW_BLUE_LIGHT, 0x19, Kind.RANGE, {maximum: 5, editorMaximum: 5}),
        spec(Feature.BRIGHTNESS_INTELLIGENCE, 0x81, Kind.TOGGLE),
    ],
    hdrModes: [0x23, 0x27],
    hdrLocks: [Feature.PICTURE_MODE, Feature.BRIGHTNESS, Feature.LOW_BLUE_LIGHT, Feature.BRIGHTNESS_INTELLIGENCE],
    // Hardware check 2026-10-13: Low Blue Light is rejected in sRGB and Display P3;
    // everything else is accepted in every SDR mode.
    locks: {0x0A: [Feature.LOW_BLUE_LIGHT], 0x22: [Feature.LOW_BLUE_LIGHT]},
});
