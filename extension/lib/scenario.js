// FloW scenarios: named action lists with an optional daily schedule.
// JSON format identical to the KDE app's scenarios.json (version 1).

import GLib from 'gi://GLib';

import {Feature} from './model.js';

export const FORMAT_VERSION = 1;
export const MAX_OFFSET_MIN = 120;

export const ActionType = Object.freeze({
    PICTURE_MODE: 'picture_mode',
    BRIGHTNESS: 'brightness',
    VOLUME: 'volume',
    LOW_BLUE_LIGHT: 'low_blue_light',
    BRIGHTNESS_INTELLIGENCE: 'brightness_intelligence',
    OPEN_APP: 'open_app',
});

export const ACTION_FEATURE = Object.freeze({
    [ActionType.PICTURE_MODE]: Feature.PICTURE_MODE,
    [ActionType.BRIGHTNESS]: Feature.BRIGHTNESS,
    [ActionType.VOLUME]: Feature.VOLUME,
    [ActionType.LOW_BLUE_LIGHT]: Feature.LOW_BLUE_LIGHT,
    [ActionType.BRIGHTNESS_INTELLIGENCE]: Feature.BRIGHTNESS_INTELLIGENCE,
});

export const ScheduleKind = Object.freeze({
    MANUAL: 'manual',
    TIME: 'time',
    SUNRISE: 'sunrise',
    SUNSET: 'sunset',
});

function require(condition, message) {
    if (!condition)
        throw new Error(message);
}

export function newScenario(name, id = GLib.uuid_string_random()) {
    return {id, name, notify: true, schedule: {kind: ScheduleKind.MANUAL, offset_min: 0}, actions: []};
}

export function actionFromJson(data) {
    require(data !== null && typeof data === 'object' && !Array.isArray(data), 'each action must be an object');
    require(Object.values(ActionType).includes(data.type), `unknown action type: ${JSON.stringify(data.type)}`);
    if (data.type === ActionType.OPEN_APP) {
        require(typeof data.desktop_id === 'string' && data.desktop_id.endsWith('.desktop'),
            'open_app needs a desktop_id ending in .desktop');
        return {type: data.type, desktop_id: data.desktop_id};
    }
    require(Number.isInteger(data.value), `${data.type} needs an integer value`);
    return {type: data.type, value: data.value};
}

export function scheduleFromJson(data) {
    require(data !== null && typeof data === 'object' && !Array.isArray(data), 'schedule must be an object');
    const kind = data.kind ?? ScheduleKind.MANUAL;
    require(Object.values(ScheduleKind).includes(kind), `unknown schedule kind: ${JSON.stringify(kind)}`);
    const offset = data.offset_min ?? 0;
    require(Number.isInteger(offset) && Math.abs(offset) <= MAX_OFFSET_MIN,
        `offset_min must be between -${MAX_OFFSET_MIN} and ${MAX_OFFSET_MIN}`);
    const schedule = {kind, offset_min: offset};
    if (kind === ScheduleKind.TIME) {
        require(typeof data.at === 'string', "a time schedule needs 'at'");
        require(parseTime(data.at) !== null, `'at' must be HH:MM, got ${JSON.stringify(data.at)}`);
        schedule.at = data.at;
    }
    return schedule;
}

/** @returns {[number, number]|null} hours and minutes */
export function parseTime(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59)
        return null;
    return [Number(m[1]), Number(m[2])];
}

export function scenarioFromJson(data) {
    require(data !== null && typeof data === 'object' && !Array.isArray(data), 'a scenario must be an object');
    require(typeof data.id === 'string' && data.id !== '', 'a scenario needs an id');
    require(typeof data.name === 'string' && data.name.trim() !== '', 'a scenario needs a name');
    const notify = data.notify ?? true;
    require(typeof notify === 'boolean', 'notify must be true or false');
    const actions = data.actions ?? [];
    require(Array.isArray(actions), 'actions must be a list');
    return {
        id: data.id,
        name: data.name.trim(),
        notify,
        schedule: scheduleFromJson(data.schedule ?? {}),
        actions: actions.map(actionFromJson),
    };
}

/**
 * Parse the stored document. Invalid scenarios are dropped and reported, so one broken
 * entry does not hide the others.
 *
 * @returns {{scenarios: object[], errors: string[]}}
 */
export function loadScenarios(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return {scenarios: [], errors: [`not valid JSON: ${e.message}`]};
    }
    if (data === null || typeof data !== 'object' || data.version !== FORMAT_VERSION || !Array.isArray(data.scenarios))
        return {scenarios: [], errors: ['unsupported file format']};
    const scenarios = [];
    const errors = [];
    for (const item of data.scenarios) {
        try {
            scenarios.push(scenarioFromJson(item));
        } catch (e) {
            errors.push(e.message);
        }
    }
    return {scenarios, errors};
}

export function dumpScenarios(scenarios) {
    return JSON.stringify({version: FORMAT_VERSION, scenarios});
}
