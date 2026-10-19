#!/bin/bash
# Build the zip for extensions.gnome.org (or `gnome-extensions install`) into dist/.
set -eu
cd "$(dirname "$0")"
mkdir -p dist
gnome-extensions pack extension --force --out-dir=dist --extra-source=lib --extra-source=ui
ls dist/*.zip
