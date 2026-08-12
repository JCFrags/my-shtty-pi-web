# Fedora installation and operations

## Install

Run `./deploy/install-fedora.sh` as the desktop user. The script is idempotent and uses `sudo` only for Fedora packages. Browser, daemon, workspace, profile, and password-manager integration run natively. SearXNG runs as a rootless Podman Quadlet. Docling and the reader run as user services.

Runtime paths follow XDG conventions:

```text
$XDG_RUNTIME_DIR/pi-web/       socket, descriptor, streams, locks
~/.config/pi-web/              config.toml, profiles.toml, SearXNG
~/.local/share/pi-web/         SQLite, profiles, artifacts, downloads, logs
~/.cache/pi-web/               page cache, browser binaries, document models
```

The installer preserves these directories on upgrade and uninstall.

## Services

```bash
systemctl --user status pi-browserd pi-web-reader pi-web-docling pi-web-searxng
journalctl --user -u pi-browserd -f
systemctl --user restart pi-browserd
```

The workspace starts on demand through `/browser` or `pi-browser-workspace`. A second process signals and raises the existing window.

## Visual Chromium

Visible workspace hosts use the pinned CloakBrowser Chromium executable from `~/.config/pi-web/visual-browser.env`; background Chromium remains the Fedora system build and lightweight work remains on Lightpanda. CloakBrowser is still Chromium and agent-browser controls it through the same explicit session/tab boundary. Live JPEG streaming, human input, downloads, debugging, and persistent profile support remain unchanged.

The no-login wrapper currently provides the signed Chromium 146 build. It removes obvious automation signals (`navigator.webdriver`, `HeadlessChrome`) but does not guarantee access to protected sites; Reddit still presented its humanity page in validation. `cloakbrowser login` can obtain the current free build through a local GitHub sign-in, but that tier allows one concurrent CloakBrowser session. After changing the installed CloakBrowser tier or binary, rerun the Fedora installer to regenerate `visual-browser.env`. Never put a license key in repository files or chat.

Remove `PI_WEB_VISUAL_CHROMIUM_EXECUTABLE` from `visual-browser.env` and restart `pi-browserd` to return visible hosts to system Chromium. Existing hosts keep their original executable until stopped.

## Persistent profiles and password managers

Create a dedicated test profile first. Load KeePassXC-Browser or Bitwarden/Vaultwarden through a profile’s `extensions` list and use normal keyboard shortcuts for autofill; credentials are not passed through Pi tool arguments. Extension pages appear as CDP targets and can be opened as workspace tabs. Run `scripts/extension-spike.sh` to record headless and headed compatibility for the installed versions.

If an essential browser-native popup cannot be represented by the page stream, enable the documented optional full-window/Xpra compatibility path. It is not required or installed by default.

## Upgrade and rollback

The installer stages a new source tree before replacing the previous one at `~/.local/lib/pi-web-workspace`; the previous tree is retained as `.old`. Stop services, move the previous tree back, reinstall binaries, and restart services to roll back. Profile data and artifacts are independent of application binaries.

Dependency changes require updating `VERSION_PINS.toml` and `deploy/versions.env`, then running protocol, backend conformance, multi-agent, reader, workspace, and representative workflow benchmarks.

## Diagnostics

`pi-web doctor --json` checks paths, protocol files, browser binaries, service URLs, and agent-browser. `agent-browser doctor --offline --quick --json` provides driver-specific diagnostics. The daemon does not repair or delete profiles automatically.
