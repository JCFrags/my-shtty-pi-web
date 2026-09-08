#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="$(node -p 'require(process.argv[1]).agentBrowser.tag' "$ROOT/upstreams.lock.json")"
COMMIT="$(node -p 'require(process.argv[1]).agentBrowser.commit' "$ROOT/upstreams.lock.json")"

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/terminal-browser/agent-browser/$COMMIT"
BIN="$CACHE/bin/agent-browser"

if [ "${1:-}" = "--ref" ]; then
  echo "$REF"
  exit 0
fi

if [ "${1:-}" = --build ]; then
  SOURCE="${2:?source directory required}"
  TARGET="${3:?target directory required}"
  if [ ! -d "$SOURCE" ]; then
    git clone --quiet --depth 1 --branch "$REF" https://github.com/vercel-labs/agent-browser "$SOURCE"
  fi
  if [ "$(git -C "$SOURCE" rev-parse HEAD)" != "$COMMIT" ] || [ -n "$(git -C "$SOURCE" status --porcelain)" ]; then
    echo "agent-browser: source does not match clean pinned commit $COMMIT" >&2; exit 1
  fi
  CARGO_TARGET_DIR="$TARGET" cargo build --locked --release --manifest-path "$SOURCE/cli/Cargo.toml" >&2
  echo "$TARGET/release/agent-browser"
  exit 0
fi

if [ ! -x "$BIN" ] || [ "${1:-}" = "--force" ]; then
  echo "building agent-browser $REF (first run, a few minutes)…" >&2
  cargo install --git https://github.com/vercel-labs/agent-browser \
    --rev "$COMMIT" --locked --root "$CACHE" agent-browser >&2
fi

echo "$BIN"
