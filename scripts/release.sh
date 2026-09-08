#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-dev}"
CHANNEL="${2:-dev}"
OUT="${TERMINAL_BROWSER_RELEASE_OUT:-$ROOT/dist-release}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
if [ -e "$OUT/manifest-linux-x64.json" ] || [ -e "$OUT/manifest-linux-arm64.json" ] || [ -e "$OUT/manifest-darwin-x64.json" ] || [ -e "$OUT/manifest-darwin-arm64.json" ]; then
  echo "choose a fresh TERMINAL_BROWSER_RELEASE_OUT; existing artifacts are not overwritten" >&2; exit 1
fi
WORK="$(mktemp -d "$OUT/.build-XXXXXX")"
STAGE="$WORK/terminal-browser"
trap 'echo "build workspace: $WORK" >&2' EXIT

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64; DARWIN_ARCH=arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64; DARWIN_ARCH=x86_64 ;;
  Linux-x86_64|Linux-amd64) TARGET=linux-x64; DARWIN_ARCH= ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64; DARWIN_ARCH= ;;
  *) echo "unsupported build host: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

node "$ROOT/scripts/dist-manifest.mjs" source "$ROOT" "$WORK/source.json"
node -e 'const fs=require("fs"); if(!fs.readFileSync(process.argv[1]).equals(fs.readFileSync(process.argv[2]))) throw Error("installed pnpm lock differs; prepare locked dependencies before building")' "$ROOT/pnpm-lock.yaml" "$ROOT/node_modules/.pnpm/lock.yaml"
mkdir -p "$STAGE"/{bin,cli/dist,browser/dist,browser/native,agent-browser/bin,assets/fonts,scripts,pi-extension/dist,herdr-plugin,metadata,licenses} "$WORK/home"
NATIVE_TARGET="${TERMINAL_BROWSER_NATIVE_TARGET:-$WORK/native}"
mkdir -p "$NATIVE_TARGET"
NATIVE_TARGET="$(cd "$NATIVE_TARGET" && pwd -P)"
case "$NATIVE_TARGET/" in "$ROOT/engine/target/"*) echo "release must not use the development native target directory" >&2; exit 1 ;; esac
(cd "$ROOT/engine" && CARGO_TARGET_DIR="$NATIVE_TARGET" cargo build --locked -p pixel-node --release)
if [ -n "$DARWIN_ARCH" ]; then
  NATIVE_LIB=libpixel_node.dylib
  swiftc -O -target "$DARWIN_ARCH-apple-macos11" "$ROOT/engine/crates/pixel-core/native-scroll-helper.swift" -o "$STAGE/bin/native-scroll-helper"
else
  NATIVE_LIB=libpixel_node.so
fi
cp "$NATIVE_TARGET/release/$NATIVE_LIB" "$STAGE/browser/native/pixel.node"

AGENT_SOURCE="${TERMINAL_BROWSER_AGENT_SOURCE:-$WORK/agent-browser-source}"
AGENT_TARGET="${TERMINAL_BROWSER_AGENT_TARGET:-$WORK/agent-native}"
mkdir -p "$AGENT_TARGET"
AGENT_TARGET="$(cd "$AGENT_TARGET" && pwd -P)"
AGENT_BROWSER_BIN="$("$ROOT/scripts/agent-browser.sh" --build "$AGENT_SOURCE" "$AGENT_TARGET")"
cp "$AGENT_BROWSER_BIN" "$STAGE/agent-browser/bin/agent-browser"

cd "$ROOT"
"$ROOT/scripts/bundle.sh" "$ROOT/cli/src/main.ts" "$STAGE/cli/dist/main.js"
"$ROOT/scripts/bundle.sh" "$ROOT/browser/src/main.tsx" "$STAGE/browser/dist/main.js"
"$ROOT/scripts/bundle.sh" "$ROOT/scripts/test/runtime-smoke.ts" "$STAGE/browser/dist/runtime-check.js"
"$ROOT/pi-extension/node_modules/.bin/tsc" -p "$ROOT/pi-extension/tsconfig.json" --outDir "$STAGE/pi-extension/dist"
printf 'export const launchMode = "bundle";\n' > "$STAGE/pi-extension/dist/launch-mode.js"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));delete p.scripts;delete p.devDependencies;fs.writeFileSync(process.argv[2],JSON.stringify(p,null,2)+"\n")' "$ROOT/pi-extension/package.json" "$STAGE/pi-extension/package.json"
cp "$ROOT/herdr-plugin/"*.sh "$STAGE/herdr-plugin/"
node -e 'const fs=require("fs");const text=fs.readFileSync(process.argv[1],"utf8"); const result=text.replace(/\[\[build\]\][\s\S]*?(?=\[\[)/g,""); if(result===text) throw Error("missing Herdr build block"); fs.writeFileSync(process.argv[2],result)' "$ROOT/herdr-plugin/herdr-plugin.toml" "$STAGE/herdr-plugin/herdr-plugin.toml"
cat > "$STAGE/herdr-plugin/launch.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
self="$(readlink -f "${BASH_SOURCE[0]}")"
root="$(cd "$(dirname "$self")/.." && pwd -P)"
exec "$root/bin/terminal-browser" "$@"
EOF
cp "$ROOT/scripts/apparmor.sh" "$ROOT/scripts/dist-manifest.mjs" "$ROOT/scripts/install-manager.mjs" "$ROOT/scripts/extract-dist.py" "$ROOT/scripts/install.sh" "$ROOT/scripts/install-local.sh" "$STAGE/scripts/"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
cp "$ROOT/pnpm-lock.yaml" "$ROOT/upstreams.lock.json" "$STAGE/metadata/"
cp "$ROOT/engine/Cargo.lock" "$STAGE/metadata/Cargo.lock"
cp "$AGENT_SOURCE/cli/Cargo.lock" "$STAGE/metadata/agent-browser-Cargo.lock"
cp "$AGENT_SOURCE/LICENSE" "$STAGE/licenses/agent-browser-LICENSE"
env -i PATH="$PATH" HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/config" XDG_DATA_HOME="$WORK/home/data" XDG_STATE_HOME="$WORK/home/state" XDG_CACHE_HOME="$WORK/home/cache" XDG_RUNTIME_DIR="$WORK/home/runtime" TERMINAL_BROWSER_APPDATA="$WORK/home/appdata" TERMINAL_BROWSER_INTEROP_DIR="$WORK/home/interop" PI_CODING_AGENT_DIR="$WORK/home/pi" TERMINAL_BROWSER_SKILL_OUT="$STAGE/skills" "$ROOT/scripts/generate-skill.sh"
cp "$ROOT/assets/fonts/JetBrainsMono-Regular.ttf" "$ROOT/assets/fonts/LICENSE.txt" "$STAGE/assets/fonts/"
mkdir -p "$STAGE/assets/react-grab"
REACT_GRAB="$(node -e 'console.log(require.resolve("react-grab/dist/index.global.js",{paths:[process.argv[1]]}))' "$ROOT/browser")"
cp "$REACT_GRAB" "$STAGE/assets/react-grab/index.global.js"
"$ROOT/scripts/fetch-electron.sh" --dest "$STAGE/electron"

if [ -n "$DARWIN_ARCH" ]; then
  APP="$STAGE/electron/terminal-browser.app"
  mv "$STAGE/electron/Electron.app" "$APP"
  mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/terminal-browser"
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable terminal-browser" -c "Set :CFBundleName terminal-browser" -c "Set :CFBundleDisplayName terminal-browser" -c "Set :CFBundleIdentifier dev.zenbu.terminal-browser" -c "Add :LSUIElement bool true" "$APP/Contents/Info.plist" >/dev/null
  ELECTRON_EXE="electron/terminal-browser.app/Contents/MacOS/terminal-browser"
  NATIVE_SCROLL='export NATIVE_SCROLL_HELPER="$ROOT/bin/native-scroll-helper"'
else
  ELECTRON_EXE="electron/electron"
  NATIVE_SCROLL=""
fi
cat > "$STAGE/bin/terminal-browser" <<EOF
#!/bin/sh
SELF="\$0"
while [ -L "\$SELF" ]; do
  LINK="\$(readlink "\$SELF")"
  case "\$LINK" in
    /*) SELF="\$LINK" ;;
    *) SELF="\$(dirname -- "\$SELF")/\$LINK" ;;
  esac
done
ROOT="\$(CDPATH= cd -- "\$(dirname -- "\$SELF")/.." && pwd -P)"
export TERMINAL_BROWSER_DIST_ROOT="\$ROOT"
export ELECTRON_RUN_AS_NODE=1
$NATIVE_SCROLL
exec "\$ROOT/$ELECTRON_EXE" "\$ROOT/cli/dist/main.js" "\$@"
EOF
chmod +x "$STAGE/bin/terminal-browser" "$STAGE/herdr-plugin/launch.sh"
node "$ROOT/scripts/dist-seal.mjs" prepare "$ROOT" "$STAGE" "$WORK/source.json" "$AGENT_SOURCE" "$VERSION" "$CHANNEL" "$TARGET"
if [ -n "$DARWIN_ARCH" ]; then "$ROOT/scripts/macos-sign.sh" "$STAGE" "$CHANNEL"; fi
ID="$(node "$ROOT/scripts/dist-seal.mjs" seal "$ROOT" "$STAGE" "$WORK/source.json")"
mkdir "$OUT/$ID"
mv "$STAGE" "$OUT/$ID/terminal-browser"
STAGE="$OUT/$ID/terminal-browser"
TARBALL="$OUT/terminal-browser-$TARGET.tar.gz"
tar -czf "$TARBALL" -C "$OUT/$ID" terminal-browser
node "$ROOT/scripts/dist-seal.mjs" archive "$STAGE" "$TARBALL" "$OUT/manifest-$TARGET.json"
node "$ROOT/scripts/dist-manifest.mjs" verify "$STAGE" "$OUT/manifest-$TARGET.json"
du -h "$TARBALL"
