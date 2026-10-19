// Translations as lookup tables keyed by the English text (as in the KDE app), so the
// extension needs no gettext tooling. The language follows the session locale.

import GLib from 'gi://GLib';

import {DE} from './i18n-de.js';

const TABLES = {de: DE};

function detectLanguage() {
    for (const name of GLib.get_language_names()) {
        const lang = name.split(/[_.@]/)[0];
        if (lang === 'C' || lang === 'POSIX')
            continue;
        return lang;
    }
    return 'en';
}

let table = TABLES[detectLanguage()] ?? {};

/** For tests. */
export function setLanguage(lang) {
    table = TABLES[lang] ?? {};
}

export function _(text) {
    return table[text] ?? text;
}

/** Translate and fill %1, %2, … */
export function fmt(text, ...args) {
    return _(text).replace(/%(\d)/g, (m, i) => String(args[Number(i) - 1] ?? m));
}
