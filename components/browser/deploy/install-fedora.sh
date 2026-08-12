#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=versions.env
source "$ROOT/deploy/versions.env"
PREFIX="${PI_WEB_PREFIX:-$HOME/.local}"
INSTALL_ROOT="${PI_WEB_INSTALL_ROOT:-$PREFIX/lib/pi-web-workspace}"
BIN_DIR="$PREFIX/bin"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pi-web"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-web"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/pi-web"
USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
QUADLET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
PI_EXTENSION_DIR="$HOME/.pi/agent/extensions/pi-web"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[[ -f /etc/fedora-release ]] || die "This installer targets Fedora Linux."
have sudo || die "sudo is required for system package installation."

log "Installing or validating Fedora dependencies"
packages=(
  gcc gcc-c++ make pkgconf-pkg-config curl wget2-wget git jq file openssl-devel
  webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel
  gtk3-devel glib2-devel cairo-devel pango-devel gdk-pixbuf2-devel
  chromium podman python3 python3-devel rust cargo
)
missing=()
for package in "${packages[@]}"; do
  if ! rpm -q "$package" >/dev/null 2>&1; then missing+=("$package"); fi
done
((${#missing[@]} == 0)) || sudo dnf install -y "${missing[@]}"

export PATH="$HOME/.cargo/bin:$BIN_DIR:$PATH"
if ! have cargo || ! have rustc; then
  log "Installing Rust using the official rustup installer"
  tmp="$(mktemp)"
  curl --fail --location --retry 3 https://sh.rustup.rs -o "$tmp"
  sh "$tmp" -y --profile minimal --default-toolchain 1.88.0
  rm -f "$tmp"
  export PATH="$HOME/.cargo/bin:$BIN_DIR:$PATH"
fi
read -r rust_major rust_minor < <(rustc --version | awk '{split($2, parts, "."); print parts[1], parts[2]}')
(( rust_major > 1 || (rust_major == 1 && rust_minor >= 88) )) || die "Rust 1.88+ is required; found $(rustc --version)."

have node || die "Node.js $NODE_MIN_MAJOR+ is required."
have npm || die "npm is required to install pinned JavaScript tools."
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
(( node_major >= NODE_MIN_MAJOR )) || die "Node.js $NODE_MIN_MAJOR+ is required; found major $node_major."
if ! have pnpm || [[ "$(pnpm --version)" != "$PNPM_VERSION" ]]; then
  log "Installing pnpm $PNPM_VERSION under $PREFIX"
  npm install --global --prefix "$PREFIX" "pnpm@$PNPM_VERSION"
fi

if ! have uv || [[ "$(uv --version 2>/dev/null | awk '{print $2}')" != "$UV_VERSION" ]]; then
  log "Installing uv $UV_VERSION"
  tmp="$(mktemp)"
  curl --fail --location --retry 3 "https://astral.sh/uv/$UV_VERSION/install.sh" -o "$tmp"
  sh "$tmp"
  rm -f "$tmp"
  export PATH="$HOME/.local/bin:$PATH"
fi

have pi || die "Pi $PI_VERSION is required. Install Pi, then rerun."
[[ "$(pi --version 2>/dev/null)" == "$PI_VERSION" ]] || die "Pi $PI_VERSION is required; found $(pi --version 2>/dev/null || echo unknown)."

cloak_wrapper="$(cloakbrowser info --quick --json 2>/dev/null | jq -r '.environment.wrapper // empty' || true)"
if [[ "$cloak_wrapper" != "$CLOAKBROWSER_WRAPPER_VERSION" ]]; then
  log "Installing CloakBrowser wrapper $CLOAKBROWSER_WRAPPER_VERSION"
  uv tool install --force "cloakbrowser==$CLOAKBROWSER_WRAPPER_VERSION"
fi
cloak_info="$(cloakbrowser info --quick --json)"
if [[ "$(jq -r '.binary.installed' <<<"$cloak_info")" != "true" ]]; then
  log "Installing the signed CloakBrowser Chromium binary"
  cloakbrowser install
  cloak_info="$(cloakbrowser info --quick --json)"
fi
cloak_browser_path="$(jq -r '.binary.path // empty' <<<"$cloak_info")"
[[ -x "$cloak_browser_path" ]] || die "CloakBrowser executable is unavailable: $cloak_browser_path"

mkdir -p "$BIN_DIR" "$CONFIG_DIR" "$DATA_DIR" "$CACHE_DIR" "$USER_UNIT_DIR" "$QUADLET_DIR" "$DESKTOP_DIR" "$ICON_DIR"

install_lightpanda() {
  local machine url expected target tmp actual
  machine="$(uname -m)"
  case "$machine" in
    x86_64) url="$LIGHTPANDA_LINUX_X86_64_URL"; expected="$LIGHTPANDA_LINUX_X86_64_SHA256" ;;
    aarch64) url="$LIGHTPANDA_LINUX_AARCH64_URL"; expected="$LIGHTPANDA_LINUX_AARCH64_SHA256" ;;
    *) die "No pinned Lightpanda binary for architecture $machine" ;;
  esac
  target="$BIN_DIR/lightpanda"
  if [[ -x "$target" ]] && "$target" version 2>&1 | grep -Fq "$LIGHTPANDA_VERSION"; then return; fi
  log "Installing pinned Lightpanda $LIGHTPANDA_VERSION"
  tmp="$(mktemp)"
  curl --fail --location --retry 3 "$url" -o "$tmp"
  if [[ -n "$expected" ]]; then
    actual="$(sha256sum "$tmp" | awk '{print $1}')"
    [[ "$actual" == "$expected" ]] || die "Lightpanda checksum mismatch: expected $expected, got $actual"
  fi
  install -m 0755 "$tmp" "$target"
  rm -f "$tmp"
  "$target" version
}
install_lightpanda

if ! have agent-browser || ! agent-browser --version 2>&1 | grep -Fq "$AGENT_BROWSER_VERSION"; then
  log "Installing agent-browser $AGENT_BROWSER_VERSION"
  npm install --global --prefix "$PREFIX" "agent-browser@$AGENT_BROWSER_VERSION"
fi
agent-browser doctor --offline --quick --json

log "Installing source tree at $INSTALL_ROOT"
mkdir -p "$(dirname "$INSTALL_ROOT")"
if [[ "$ROOT" != "$INSTALL_ROOT" ]]; then
  rm -rf "$INSTALL_ROOT.new"
  mkdir -p "$INSTALL_ROOT.new"
  tar --exclude=.git --exclude=node_modules --exclude=target --exclude=dist --exclude=.venv --exclude=.pytest_cache -C "$ROOT" -cf - . | tar -C "$INSTALL_ROOT.new" -xf -
  rm -rf "$INSTALL_ROOT.old"
  [[ ! -e "$INSTALL_ROOT" ]] || mv "$INSTALL_ROOT" "$INSTALL_ROOT.old"
  mv "$INSTALL_ROOT.new" "$INSTALL_ROOT"
fi
cd "$INSTALL_ROOT"

log "Installing JavaScript and Python dependencies"
pnpm install --frozen-lockfile=false
uv sync --all-packages

log "Building protocol packages, Pi extension, coordinator, and workspace"
pnpm -r build
cargo build --release -p pi-browserd
pnpm --filter @pi-web/workspace tauri build --no-bundle
install -m 0755 target/release/pi-browserd "$BIN_DIR/pi-browserd"
install -m 0755 target/release/pi-browser-workspace "$BIN_DIR/pi-browser-workspace"
ln -sfn "$INSTALL_ROOT/packages/browserd-reference/src/doctor.mjs" "$BIN_DIR/pi-web-doctor-reference"
cat > "$BIN_DIR/pi-web" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  doctor) shift; exec "$BIN_DIR/pi-browserd" doctor "$@" ;;
  workspace) shift; export GDK_BACKEND="${PI_WEB_GDK_BACKEND:-x11}" WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"; exec "$BIN_DIR/pi-browser-workspace" "$@" ;;
  *) echo "usage: pi-web {doctor|workspace}" >&2; exit 2 ;;
esac
EOF
chmod 0755 "$BIN_DIR/pi-web"

log "Installing Pi extension"
mkdir -p "$(dirname "$PI_EXTENSION_DIR")"
ln -sfn "$INSTALL_ROOT/packages/pi-extension" "$PI_EXTENSION_DIR"

log "Deploying SearXNG configuration"
# The rootless image chowns its bind mount to a subordinate UID. Stop it and
# map ownership back through Podman's user namespace before an upgrade.
systemctl --user stop pi-web-searxng.service >/dev/null 2>&1 || true
mkdir -p "$CONFIG_DIR/searxng"
secret_file="$CONFIG_DIR/searxng/.secret"
if [[ -e "$secret_file" && ! -r "$secret_file" ]]; then
  podman unshare chown -R 0:0 "$CONFIG_DIR/searxng"
fi
if [[ ! -s "$secret_file" ]]; then umask 077; openssl rand -hex 32 > "$secret_file"; fi
secret="$(cat "$secret_file")"
sed "s/__SEARXNG_SECRET__/$secret/" "$INSTALL_ROOT/deploy/searxng/settings.yml.in" > "$CONFIG_DIR/searxng/settings.yml"
install -m 0644 "$INSTALL_ROOT/deploy/searxng/limiter.toml" "$CONFIG_DIR/searxng/limiter.toml"
sed "s|__SEARXNG_IMAGE__|$SEARXNG_IMAGE|" "$INSTALL_ROOT/deploy/quadlet/pi-web-searxng.container" > "$QUADLET_DIR/pi-web-searxng.container"

[[ -f "$CONFIG_DIR/config.toml" ]] || install -m 0644 "$INSTALL_ROOT/deploy/config.toml" "$CONFIG_DIR/config.toml"
[[ -f "$CONFIG_DIR/profiles.toml" ]] || install -m 0644 "$INSTALL_ROOT/deploy/profiles.toml" "$CONFIG_DIR/profiles.toml"
cat > "$CONFIG_DIR/visual-browser.env" <<EOF
PI_WEB_VISUAL_CHROMIUM_EXECUTABLE="$cloak_browser_path"
PI_WEB_VISUAL_CHROMIUM_ARGS="--fingerprint-platform=windows"
EOF
chmod 0644 "$CONFIG_DIR/visual-browser.env"
for unit in pi-browserd.service pi-web-reader.service pi-web-docling.service; do
  install -m 0644 "$INSTALL_ROOT/deploy/systemd/$unit" "$USER_UNIT_DIR/$unit"
done
install -m 0644 "$INSTALL_ROOT/deploy/desktop/pi-browser-workspace.desktop" "$DESKTOP_DIR/pi-browser-workspace.desktop"
install -m 0644 "$INSTALL_ROOT/apps/workspace/src-tauri/icons/icon.svg" "$ICON_DIR/pi-browser-workspace.svg"

log "Starting local services"
systemctl --user daemon-reload
# `restart` also starts these on a first install and activates upgraded code.
systemctl --user enable pi-web-docling.service pi-web-reader.service pi-browserd.service
systemctl --user restart pi-web-docling.service pi-web-reader.service pi-browserd.service
# Quadlet units are generated; their [Install] section handles boot linkage and
# systemd rejects an explicit `enable` operation on the generated service.
systemctl --user restart pi-web-searxng.service

log "Running diagnostics"
"$BIN_DIR/pi-browserd" doctor --json || true
cat <<EOF

Pi Web Workspace installed.

  Pi extension:  $PI_EXTENSION_DIR
  Coordinator:   systemctl --user status pi-browserd
  Reader:        systemctl --user status pi-web-reader
  SearXNG:       systemctl --user status pi-web-searxng
  Diagnostics:   pi-web doctor --json
  Workspace:     pi-browser-workspace

Browser tools are enabled by default. In Pi, use /browser to open the visual workspace.
EOF
