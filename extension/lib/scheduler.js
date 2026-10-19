// Which scenario is active now, and which one starts next (KDE app spec §7.3).
// Days are local calendar days; JS Date handles the zone and DST transitions.

import {ScheduleKind, parseTime} from './scenario.js';
import {sunTimes} from './sun.js';

/** @returns {Date|null} start of the scenario on the local day of `day` */
export function startOn(scenario, day, location) {
    const {kind, offset_min: offset = 0} = scenario.schedule;
    let base;
    if (kind === ScheduleKind.TIME) {
        const [h, m] = parseTime(scenario.schedule.at);
        base = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
    } else if (kind === ScheduleKind.SUNRISE || kind === ScheduleKind.SUNSET) {
        if (!location)
            return null;
        const sun = sunTimes(day.getFullYear(), day.getMonth(), day.getDate(), location.latitude, location.longitude);
        base = kind === ScheduleKind.SUNRISE ? sun.sunrise : sun.sunset;
        if (!base)
            return null;
    } else {
        return null;
    }
    return new Date(base.getTime() + offset * 60000);
}

function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The scheduled scenario with the latest start <= now; ties go to the one listed first. */
export function activeAt(scenarios, now, location) {
    let best = null;
    for (const day of [addDays(now, -1), addDays(now, 0)]) {
        for (const scenario of scenarios) {
            const start = startOn(scenario, day, location);
            if (start && start <= now && (!best || start > best.start))
                best = {start, scenario};
        }
    }
    return best?.scenario ?? null;
}

/** @returns {{start: Date, scenario: object}|null} */
export function nextStart(scenarios, now, location) {
    let best = null;
    for (const offset of [0, 1, 2]) {
        const day = addDays(now, offset);
        for (const scenario of scenarios) {
            const start = startOn(scenario, day, location);
            if (start && start > now && (!best || start < best.start))
                best = {start, scenario};
        }
    }
    return best;
}

export function formatTime(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
