// Pure logic for the brightness keys: step size, routing and connector names.
// No shell imports; the shell glue lives in ui/brightnessKeys.js.

export const STEPS = 20;

export const Direction = Object.freeze({UP: 1, DOWN: -1});

export const Scope = Object.freeze({
    GLOBAL: 'global', // Fn + brightness key: every screen
    MONITOR: 'monitor', // Shift + key: the screen under the pointer
});

/** 'card1-DP-1' (ddcutil, DRM) -> 'DP-1' (Meta); '' -> null. */
export function connectorName(drmConnector) {
    const name = (drmConnector ?? '').trim().replace(/^card\d+-/, '');
    return name || null;
}

/** One key press moves 1/20 of the maximum (5 for 0..100), clamped to 0..maximum. */
export function stepValue(current, maximum, direction) {
    const step = Math.max(1, Math.round(maximum / STEPS));
    return Math.min(maximum, Math.max(0, current + direction * step));
}

/**
 * Decide what a key press does.
 *
 * @param {object} p
 * @param {string} p.scope a Scope
 * @param {boolean} p.usable monitor reachable and brightness not locked
 * @param {string|null} p.connector Meta connector of the monitor, null when unknown
 * @param {string[]} p.pointerConnectors connectors of the screen under the pointer
 * @returns {{delegate: boolean, stepMonitor: boolean, osd: boolean}}
 *   delegate: run GNOME's own handler; stepMonitor: change the monitor; osd: add its level to the OSD
 */
export function route({scope, usable, connector, pointerConnectors = []}) {
    if (!usable)
        return {delegate: true, stepMonitor: false, osd: false};
    if (scope === Scope.GLOBAL)
        return {delegate: true, stepMonitor: true, osd: connector !== null};
    const underPointer = connector !== null && pointerConnectors.includes(connector);
    return underPointer
        ? {delegate: false, stepMonitor: true, osd: true}
        : {delegate: true, stepMonitor: false, osd: false};
}
