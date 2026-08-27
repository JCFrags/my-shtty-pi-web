#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PI_WEB_PREFIX:-$HOME/.local}"
INSTALL_ROOT="${PI_WEB_INSTALL_ROOT:-$PREFIX/lib/pi-web-tools}"
BIN_DIR="$PREFIX/bin"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
UNIT_DIR="$CONFIG_HOME/systemd/user"
QUADLET_DIR="$CONFIG_HOME/containers/systemd"
PI_EXTENSION="$HOME/.pi/agent/extensions/pi-web"
DESKTOP_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor/scalable/apps"
BROWSER_ROOT="$INSTALL_ROOT/components/browser"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[[ -f /etc/fedora-release ]] || die "This installer supports Fedora Linux."
have sudo || die "sudo is required to install Fedora packages."

log "Installing required Fedora packages"
packages=(gcc gcc-c++ make pkgconf-pkg-config git jq openssl-devel chromium podman python3 python3-devel rust cargo webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel gtk3-devel glib2-devel cairo-devel pango-devel gdk-pixbuf2-devel)
missing=()
for package in "${packages[@]}"; do rpm -q "$package" >/dev/null 2>&1 || missing+=("$package"); done
((${#missing[@]} == 0)) || sudo dnf install -y "${missing[@]}"

have node || die "Node.js 24 or newer is required."
have npm || die "npm is required."
(( $(node -p 'Number(process.versions.node.split(".")[0])') >= 24 )) || die "Node.js 24 or newer is required."
mkdir -p "$BIN_DIR"
export PATH="$BIN_DIR:$HOME/.cargo/bin:$PATH"
if ! have pnpm || [[ "$(pnpm --version)" != "10.13.1" ]]; then npm install --global --prefix "$PREFIX" pnpm@10.13.1; fi
if ! have uv; then
  tmp="$(mktemp)"; curl --fail --location https://astral.sh/uv/0.12.0/install.sh -o "$tmp"; sh "$tmp"; rm -f "$tmp"
  export PATH="$BIN_DIR:$PATH"
fi
have pi || die "Pi must be installed before Pi Web Tools."
if ! have agent-browser || ! agent-browser --version 2>&1 | grep -Fq '0.33.1'; then npm install --global --prefix "$PREFIX" agent-browser@0.33.1; fi

log "Staging the source tree"
mkdir -p "$(dirname "$INSTALL_ROOT")" "$DATA_HOME/pi-web" "$CACHE_HOME/pi-web/build"
chmod 0700 "$DATA_HOME/pi-web" "$CACHE_HOME/pi-web"
export UV_PROJECT_ENVIRONMENT="$DATA_HOME/pi-web/python-env"
export CARGO_TARGET_DIR="$CACHE_HOME/pi-web/build/cargo-target"
if [[ "$SOURCE_ROOT" != "$INSTALL_ROOT" ]]; then
  stage="$INSTALL_ROOT.new"
  rm -rf "$stage"
  mkdir -m 0700 "$stage"
  tar --exclude=.git --exclude=node_modules --exclude=target --exclude=dist --exclude=.venv --exclude=.pytest_cache -C "$SOURCE_ROOT" -cf - . | tar -C "$stage" -xf -
  rm -rf "$INSTALL_ROOT.old"
  [[ ! -e "$INSTALL_ROOT" ]] || mv "$INSTALL_ROOT" "$INSTALL_ROOT.old"
  mv "$stage" "$INSTALL_ROOT"
fi
cd "$INSTALL_ROOT"

log "Installing locked dependencies and building the product"
pnpm install --frozen-lockfile
(cd "$BROWSER_ROOT" && uv sync --all-packages --frozen)
PLAYWRIGHT_BROWSERS_PATH="$DATA_HOME/pi-web/crawl4ai-browsers" "$DATA_HOME/pi-web/python-env/bin/python" -m playwright install chromium
pnpm -r --if-present build
(cd "$BROWSER_ROOT" && cargo build --release -p pi-browserd -p pi-browser-workspace)
install -m 0755 "$CARGO_TARGET_DIR/release/pi-browserd" "$BIN_DIR/pi-browserd"
install -m 0755 "$CARGO_TARGET_DIR/release/pi-browser-workspace" "$BIN_DIR/pi-browser-workspace"

log "Installing configuration and user services"
mkdir -p "$CONFIG_HOME/pi-web/searxng" "$DATA_HOME/pi-web/exports" "$CACHE_HOME/pi-web/responses" "${XDG_STATE_HOME:-$HOME/.local/state}/pi-web/audit/events" "$UNIT_DIR" "$QUADLET_DIR" "$DESKTOP_DIR" "$ICON_DIR" "$(dirname "$PI_EXTENSION")"
[[ -O "$CONFIG_HOME/pi-web/searxng" ]] || podman unshare chown -R 0:0 "$CONFIG_HOME/pi-web/searxng"
chmod 0700 "$CONFIG_HOME/pi-web" "$CONFIG_HOME/pi-web/searxng" "$DATA_HOME/pi-web" "$DATA_HOME/pi-web/exports" "$CACHE_HOME/pi-web" "$CACHE_HOME/pi-web/responses" "${XDG_STATE_HOME:-$HOME/.local/state}/pi-web" "${XDG_STATE_HOME:-$HOME/.local/state}/pi-web/audit" "${XDG_STATE_HOME:-$HOME/.local/state}/pi-web/audit/events"
ln -sfn "$INSTALL_ROOT/apps/pi-webx" "$PI_EXTENSION"
[[ -f "$CONFIG_HOME/pi-web/config.toml" ]] || install -m 0600 "$BROWSER_ROOT/deploy/config.toml" "$CONFIG_HOME/pi-web/config.toml"
[[ -f "$CONFIG_HOME/pi-web/profiles.toml" ]] || install -m 0600 "$BROWSER_ROOT/deploy/profiles.toml" "$CONFIG_HOME/pi-web/profiles.toml"
systemctl --user stop pi-web-searxng.service >/dev/null 2>&1 || true
secret_file="$CONFIG_HOME/pi-web/searxng/.secret"
if [[ ! -s "$secret_file" ]]; then umask 077; openssl rand -hex 32 > "$secret_file"; fi
secret="$(cat "$secret_file")"
sed "s/__SEARXNG_SECRET__/$secret/" "$BROWSER_ROOT/deploy/searxng/settings.yml.in" > "$CONFIG_HOME/pi-web/searxng/settings.yml"
install -m 0600 "$BROWSER_ROOT/deploy/searxng/limiter.toml" "$CONFIG_HOME/pi-web/searxng/limiter.toml"
searxng_image="$(sed -n 's/^SEARXNG_IMAGE=//p' "$BROWSER_ROOT/deploy/versions.env")"
[[ "$searxng_image" == docker.io/searxng/searxng@sha256:* ]] || die "The SearXNG image must use a reviewed immutable digest."
sed "s|__SEARXNG_IMAGE__|$searxng_image|" "$BROWSER_ROOT/deploy/quadlet/pi-web-searxng.container" > "$QUADLET_DIR/pi-web-searxng.container"

cat > "$UNIT_DIR/pi-web-egress-proxy.service" <<EOF
[Unit]
Description=Pi Web connection-bound egress proxy
After=network-online.target
[Service]
ExecStart=/usr/bin/python3 $BROWSER_ROOT/scripts/secure_egress_proxy.py
Environment=PI_WEB_EGRESS_HOST=127.0.0.1
Environment=PI_WEB_EGRESS_PORT=8877
Restart=on-failure
[Install]
WantedBy=default.target
EOF
cat > "$UNIT_DIR/pi-browserd.service" <<EOF
[Unit]
Description=Pi Web visual browser coordinator
After=network-online.target
[Service]
ExecStart=$BIN_DIR/pi-browserd
Environment=PATH=$BIN_DIR:/usr/local/bin:/usr/bin
Environment=RUST_LOG=pi_browserd=info,pi_web=info
Restart=on-failure
[Install]
WantedBy=default.target
EOF
cat > "$UNIT_DIR/pi-web-docling.service" <<EOF
[Unit]
Description=Pi Web document converter
After=network-online.target
[Service]
WorkingDirectory=$BROWSER_ROOT
ExecStart=$DATA_HOME/pi-web/python-env/bin/pi-web-docling
Environment=PI_WEB_DOCLING_HOST=127.0.0.1
Environment=PI_WEB_DOCLING_PORT=8792
Environment=DOCLING_ARTIFACTS_PATH=$CACHE_HOME/pi-web/document-models
Restart=on-failure
[Install]
WantedBy=default.target
EOF
cat > "$UNIT_DIR/pi-web-crawl.service" <<EOF
[Unit]
Description=Pi Web bounded Crawl4AI service
After=network-online.target pi-web-egress-proxy.service
Requires=pi-web-egress-proxy.service
[Service]
WorkingDirectory=$BROWSER_ROOT
ExecStart=$DATA_HOME/pi-web/python-env/bin/pi-web-crawl
Environment=PI_WEB_CRAWL_HOST=127.0.0.1
Environment=PI_WEB_CRAWL_PORT=8793
Environment=PI_WEB_CRAWL_PROXY=http://127.0.0.1:8877
Environment=PLAYWRIGHT_BROWSERS_PATH=$DATA_HOME/pi-web/crawl4ai-browsers
Restart=on-failure
[Install]
WantedBy=default.target
EOF
cat > "$UNIT_DIR/pi-web-reader.service" <<EOF
[Unit]
Description=Pi Web direct reader
After=network-online.target pi-web-docling.service
[Service]
WorkingDirectory=$BROWSER_ROOT
ExecStart=$DATA_HOME/pi-web/python-env/bin/pi-web-reader
Environment=PI_WEB_READER_HOST=127.0.0.1
Environment=PI_WEB_READER_PORT=8787
Environment=PI_WEB_DOCLING_URL=http://127.0.0.1:8792/
Restart=on-failure
[Install]
WantedBy=default.target
EOF
cat > "$UNIT_DIR/webxd.service" <<EOF
[Unit]
Description=Pi Web authority
After=pi-browserd.service pi-web-reader.service pi-web-crawl.service pi-web-egress-proxy.service pi-web-searxng.service
Requires=pi-browserd.service pi-web-reader.service pi-web-crawl.service pi-web-egress-proxy.service
[Service]
WorkingDirectory=$INSTALL_ROOT
ExecStart=/usr/bin/node $INSTALL_ROOT/apps/webxd/dist/apps/webxd/src/main.js
Environment=PATH=$BIN_DIR:/usr/local/bin:/usr/bin
Environment=WEBX_EGRESS_PROXY=http://127.0.0.1:8877/
Environment=WEBX_CACHE_DIR=$CACHE_HOME/pi-web/responses
Environment=WEBX_CRAWL_URL=http://127.0.0.1:8793/
Restart=on-failure
[Install]
WantedBy=default.target
EOF

cat > "$BIN_DIR/pi-web" <<EOF
#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  doctor) shift; exec "$BIN_DIR/pi-browserd" doctor "\$@" ;;
  workspace) shift; exec "$BIN_DIR/pi-browser-workspace" "\$@" ;;
  audit) shift; exec /usr/bin/node "$INSTALL_ROOT/scripts/pi-web-audit.mjs" "\$@" ;;
  status) exec systemctl --user status webxd pi-browserd pi-web-reader pi-web-crawl pi-web-docling pi-web-searxng ;;
  *) echo 'usage: pi-web {doctor|workspace|audit|status}' >&2; exit 2 ;;
esac
EOF
chmod 0755 "$BIN_DIR/pi-web"
install -m 0644 "$BROWSER_ROOT/apps/workspace/src-tauri/icons/icon.svg" "$ICON_DIR/pi-browser-workspace.svg"
cat > "$DESKTOP_DIR/pi-browser-workspace.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pi Web Workspace
Comment=View and control Pi browser sessions
Exec=$BIN_DIR/pi-web workspace
Icon=pi-browser-workspace
Terminal=false
Categories=Development;Network;
EOF

log "Starting services"
systemctl --user daemon-reload
systemctl --user enable pi-web-egress-proxy.service pi-web-docling.service pi-web-reader.service pi-web-crawl.service pi-browserd.service webxd.service
systemctl --user restart pi-web-egress-proxy.service pi-web-docling.service pi-web-reader.service pi-web-crawl.service pi-browserd.service webxd.service pi-web-searxng.service
# The container maps this directory to its internal service user. Keep the host
# directory private after the image entrypoint adjusts its ownership.
podman unshare chmod 0700 "$CONFIG_HOME/pi-web/searxng"

log "Verifying the installation"
systemctl --user --quiet is-active pi-web-egress-proxy pi-web-docling pi-web-reader pi-web-crawl pi-browserd pi-web-searxng webxd
"$BIN_DIR/pi-browserd" doctor --json || true
rm -rf "$CARGO_TARGET_DIR"
if [[ "$SOURCE_ROOT" != "$INSTALL_ROOT" ]]; then rm -rf "$INSTALL_ROOT.old"; fi
printf '\nPi Web Tools installed at %s. Run `pi-web status` for service status.\n' "$INSTALL_ROOT"
