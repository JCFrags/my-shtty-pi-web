#!/usr/bin/env bash
set -Eeuo pipefail

PREFIX="${PI_WEB_PREFIX:-$HOME/.local}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
UNITS=(webxd.service pi-browserd.service pi-web-reader.service pi-web-docling.service pi-web-egress-proxy.service pi-web-searxng.service)
systemctl --user disable --now "${UNITS[@]}" 2>/dev/null || true
rm -f "$CONFIG_HOME/systemd/user/webxd.service" "$CONFIG_HOME/systemd/user/pi-browserd.service" "$CONFIG_HOME/systemd/user/pi-web-reader.service" "$CONFIG_HOME/systemd/user/pi-web-docling.service" "$CONFIG_HOME/systemd/user/pi-web-egress-proxy.service"
rm -f "$CONFIG_HOME/containers/systemd/pi-web-searxng.container"
rm -f "$PREFIX/bin/pi-browserd" "$PREFIX/bin/pi-browser-workspace" "$PREFIX/bin/pi-web"
rm -f "$DATA_HOME/applications/pi-browser-workspace.desktop" "$DATA_HOME/icons/hicolor/scalable/apps/pi-browser-workspace.svg"
rm -f "$HOME/.pi/agent/extensions/pi-web"
rm -rf "$PREFIX/lib/pi-web-tools" "$PREFIX/lib/pi-web-tools.old"
systemctl --user daemon-reload
printf 'Pi Web Tools was removed. Configuration, cache, profiles, and browser data remain under XDG user directories.\n'
printf 'To remove retained user data, review these paths first: %s %s %s\n' "$CONFIG_HOME/pi-web" "$DATA_HOME/pi-web" "${XDG_CACHE_HOME:-$HOME/.cache}/pi-web"
