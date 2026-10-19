#!/bin/bash
# Install the extension for the current user and compile its settings schema.
set -eu
cd "$(dirname "$0")"

uuid=benq-monitor-control@chrisotm.github.io
dest=~/.local/share/gnome-shell/extensions/$uuid
rm -rf "$dest"
mkdir -p "$dest"
cp -r extension/metadata.json extension/extension.js extension/prefs.js extension/stylesheet.css \
    extension/lib extension/ui extension/schemas "$dest/"
glib-compile-schemas "$dest/schemas"
gnome-extensions enable "$uuid" 2>/dev/null || true

command -v ddcutil >/dev/null || echo "Warning: ddcutil is not installed (sudo apt install ddcutil)."
echo "Installed. On Wayland, log out and back in once; then: gnome-extensions enable $uuid"
