#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-dev}"
OUT="$ROOT/dist-release"
STAGE="$OUT/pixel"
APP="$STAGE/electron/Pixel.app"

rm -rf "$OUT"
mkdir -p "$STAGE"/{bin,cli/dist,browser/dist,browser/native,electron,assets/fonts}

(cd "$ROOT/engine" && cargo build -p pixel-node --release)
cp "${CARGO_TARGET_DIR:-$ROOT/engine/target}/release/libpixel_node.dylib" "$STAGE/browser/native/pixel.node"

ESBUILD="$ROOT/node_modules/.bin/esbuild"
bundle() {
  "$ESBUILD" "$1" \
    --bundle --platform=node --format=cjs \
    --external:electron '--external:*.node' \
    --alias:pixel-react="$ROOT/engine/packages/pixel-react/src/index.ts" \
    --alias:pixel-terminals="$ROOT/terminals/src/index.ts" \
    --alias:pixel-store="$ROOT/store/src/index.ts" \
    --define:process.env.NODE_ENV='"production"' \
    --sourcemap --outfile="$2" --log-level=warning
}
bundle "$ROOT/cli/src/main.ts" "$STAGE/cli/dist/main.js"
bundle "$ROOT/browser/src/main.tsx" "$STAGE/browser/dist/main.js"

cp "$ROOT/assets/fonts/JetBrainsMono-Regular.ttf" "$STAGE/assets/fonts/"

ELECTRON_DIST="$(node -e 'const p=require("path");console.log(p.join(p.dirname(require.resolve("electron/package.json",{paths:[process.argv[1]]})),"dist"))' "$ROOT/browser")"
# The electron package ships no postinstall, so pnpm never fetches the binary.
# install.js pulls it from the mirror and caches it in ~/Library/Caches/electron.
if [ ! -d "$ELECTRON_DIST/Electron.app" ]; then
  (cd "$(dirname "$ELECTRON_DIST")" && node install.js)
fi

if ! grep -qi "zenbu-labs" "$ROOT/.npmrc"; then
  echo "refusing to build: .npmrc no longer points at the patched electron mirror" >&2
  exit 1
fi


ditto "$ELECTRON_DIST/Electron.app" "$APP"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Pixel"
/usr/libexec/PlistBuddy \
  -c "Set :CFBundleExecutable Pixel" \
  -c "Set :CFBundleName Pixel" \
  -c "Set :CFBundleDisplayName Pixel" \
  -c "Set :CFBundleIdentifier dev.zenbu.pixel" \
  "$APP/Contents/Info.plist" >/dev/null
codesign --force --sign - --timestamp=none "$APP" 2>/dev/null

cat > "$STAGE/bin/pixel" <<'EOF'
#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
export PIXEL_DIST_ROOT="$ROOT"
export ELECTRON_RUN_AS_NODE=1
exec "$ROOT/electron/Pixel.app/Contents/MacOS/Pixel" "$ROOT/cli/dist/main.js" "$@"
EOF
chmod +x "$STAGE/bin/pixel"
echo "$VERSION" > "$STAGE/VERSION"

TARBALL="$OUT/pixel-darwin-arm64.tar.gz"
tar -czf "$TARBALL" -C "$OUT" pixel

split -b 45m "$TARBALL" "$OUT/pixel-chunk-"
{
  shasum -a 256 "$TARBALL" | cut -d' ' -f1
  (cd "$OUT" && ls pixel-chunk-*)
} > "$OUT/chunks.txt"

du -h "$TARBALL"
echo "chunks: $(cd "$OUT" && ls pixel-chunk-* | wc -l | tr -d ' ')"
