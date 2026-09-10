#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
WORK="$(mktemp -d "${RUNNER_TEMP:-/var/tmp}/terminal-browser-ci-XXXXXX")"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export HOME="$WORK/home"
export XDG_CONFIG_HOME="$HOME/config" XDG_DATA_HOME="$HOME/data" XDG_STATE_HOME="$HOME/state" XDG_CACHE_HOME="$HOME/cache" XDG_RUNTIME_DIR="$HOME/runtime"
export TERMINAL_BROWSER_APPDATA="$HOME/appdata" TERMINAL_BROWSER_INTEROP_DIR="$HOME/interop" PI_CODING_AGENT_DIR="$HOME/pi" PI_OFFLINE=1
while IFS='=' read -r name _; do
  case "$name" in HERDR_*|TERMINAL_BROWSER_OWNER_*|TERMINAL_BROWSER_DIST_ROOT|TERMINAL_BROWSER_INSTALLATION|TERMINAL_BROWSER_COMPANION_*|PI_SESSION_ID|PI_WEB_*) unset "$name" ;; esac
done < <(env)
mkdir -m 700 -p "$HOME" "$XDG_RUNTIME_DIR"
export TERMINAL_BROWSER_NATIVE_TARGET="${TERMINAL_BROWSER_NATIVE_TARGET:-$WORK/native}"
export TERMINAL_BROWSER_AGENT_SOURCE="${TERMINAL_BROWSER_AGENT_SOURCE:-$WORK/agent-source}"
export TERMINAL_BROWSER_AGENT_TARGET="${TERMINAL_BROWSER_AGENT_TARGET:-$WORK/agent-native}"
cd "$ROOT"
node --version
pnpm --version
rustc --version
python3 --version
bwrap --version
pnpm test:dist
CARGO_TARGET_DIR="$TERMINAL_BROWSER_NATIVE_TARGET" cargo test --release --locked --manifest-path engine/Cargo.toml -p pixel-core terminal::tty_tests
for release in a b; do
  TERMINAL_BROWSER_RELEASE_OUT="$WORK/$release" scripts/release.sh "ci-$release-$(git rev-parse --short HEAD)"
done
ARTIFACT="$(node -p 'require(process.argv[1]).artifactId' "$WORK/a/manifest-linux-x64.json")"
TERMINAL_BROWSER_TEST_ELECTRON="$WORK/a/$ARTIFACT/terminal-browser/electron/electron" node --test scripts/test/profile-startup-cleanup.test.mjs
pnpm test:dist:smoke "$WORK/a/$ARTIFACT/terminal-browser"
pnpm test:dist:recovery "$WORK/a" "$WORK/b"
printf 'packaged evidence: %s\n' "$WORK"
