#!/usr/bin/env bash
set -Eeuo pipefail
systemctl --user disable --now pi-browserd.service pi-web-reader.service pi-web-docling.service pi-web-searxng.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/pi-browserd.service" "$HOME/.config/systemd/user/pi-web-reader.service" "$HOME/.config/systemd/user/pi-web-docling.service"
rm -f "$HOME/.config/containers/systemd/pi-web-searxng.container"
rm -f "$HOME/.local/bin/pi-browserd" "$HOME/.local/bin/pi-browser-workspace" "$HOME/.local/bin/pi-web" "$HOME/.local/bin/pi-web-doctor-reference"
rm -f "$HOME/.local/share/applications/pi-browser-workspace.desktop"
rm -f "$HOME/.local/share/icons/hicolor/scalable/apps/pi-browser-workspace.svg"
rm -f "$HOME/.pi/agent/extensions/pi-web"
systemctl --user daemon-reload
printf 'Binaries and services removed. Configuration, profiles, artifacts, downloads, and browser state were preserved.\n'
