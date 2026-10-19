# gnome-benq-monitor-control

GNOME Shell 50 extension: DDC/CI control of the BenQ MA320U via the `ddcutil` CLI. GJS port of
`../benq-monitor-control` (KDE tray app, PySide6) — same VCP map, locks, scenario JSON format.
Design: `docs/specs/gnome-benq-monitor-control.html`.

- `extension/lib/`: no shell imports (GLib/Gio only), unit-tested with `gjs -m tests/run.js`.
  `session.js` serializes every ddcutil call through one promise queue; `MonitorController` adds
  latest-value-wins slider coalescing and shown-until-confirmed values. `flow.js` = scenario
  activation/scheduling; `scheduler.js`/`sun.js` ported 1:1 from the Python app (sun times checked
  against it in the tests).
- `extension/ui/indicator.js`: PanelMenu.Button menu; `extension.js`: wiring (hotplug via
  `monitors-changed`, resume via LoginManager `prepare-for-sleep`, lock screen via session modes
  `user` + `unlock-dialog`, indicator hidden while locked). `prefs.js`: Adw, scenario editor saves
  every edit to the `scenarios` GSettings key.
- Brightness keys: `ui/brightnessKeys.js` replaces GNOME's `screen-brightness-*` keybindings (owned by
  `Main.brightnessManager`), calls GNOME's handler first, then steps VCP 0x10; restores GNOME's handlers
  on disable. Pure step/routing logic in `lib/brightnessKeys.js`. Setting `brightness-keys`.
- i18n: lookup tables keyed by English text (`lib/i18n-de.js`), no gettext (msgfmt not installed).
  Add new UI strings to the DE table.
- Verify shell APIs against the installed shell: `gresource extract /usr/lib/gnome-shell/libshell-18.so /org/gnome/shell/ui/popupMenu.js`.
- Release zip: `./pack.sh` (dist/, gitignored). CI: `.github/workflows/tests.yml` runs the gjs tests.
- Test changes: `./install.sh`, then log out/in (Wayland); logs via `journalctl -f /usr/bin/gnome-shell`.
  Prefs can be run without the shell: load `/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource`,
  set `GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0 LD_LIBRARY_PATH=/usr/lib/gnome-shell`, import prefs.js.
- Never write VCP codes other than 0xDC, 0x10, 0x62, 0x60, 0x19, 0x81.
