#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -e 'console.log(require(process.argv[1]+"/package.json").devDependencies.electron)' "$ROOT/browser")"
if [ "${1:-}" = --dest ]; then
  DEST="${2:?destination required}"
  if [ -e "$DEST" ]; then echo "fetch-electron: destination already exists: $DEST" >&2; exit 1; fi
else
  DEST="$(node -e 'const p=require("path");console.log(p.join(p.dirname(require.resolve("electron/package.json",{paths:[process.argv[1]]})),"dist"))' "$ROOT/browser")"
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="darwin-x64" ;;
  Linux-x86_64) PLATFORM="linux-x64" ;;
  Linux-aarch64) PLATFORM="linux-arm64" ;;
  *) echo "fetch-electron: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

MIRROR="https://github.com/zenbu-labs/electron-releases/releases/download/v$VERSION"
ZIP="electron-v$VERSION-$PLATFORM.zip"
MARKER="$DEST/.zenbu-electron-sha256"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    echo "fetch-electron: sha256sum or shasum is required to verify $1" >&2
    return 1
  fi
}

expected="$(node -e 'const p=require(process.argv[1]); if(p.electron.version!==process.argv[2]) throw Error("Electron version differs from upstream lock"); process.stdout.write(p.electron.archives[process.argv[3]] || "")' "$ROOT/upstreams.lock.json" "$VERSION" "$PLATFORM")"
if [ -z "$expected" ]; then
  echo "fetch-electron: $ZIP is missing from upstreams.lock.json" >&2
  exit 1
fi
if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$expected" ] && [ "$(cat "$DEST/version")" = "$VERSION" ]; then
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "fetch-electron: downloading patched electron v$VERSION ($PLATFORM)" >&2
curl -fL --retry 3 --progress-bar "$MIRROR/$ZIP" -o "$TMP/$ZIP"
actual="$(sha256_file "$TMP/$ZIP")"
if [ "$actual" != "$expected" ]; then
  echo "fetch-electron: $ZIP does not match upstreams.lock.json" >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi
unzip -q "$TMP/$ZIP" -d "$TMP/app"
stamped="$(cat "$TMP/app/version")"
if [ "$stamped" != "$VERSION" ]; then
  echo "fetch-electron: fetched electron stamps itself $stamped, expected $VERSION" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$TMP/app" "$DEST"
echo "$expected" > "$MARKER"
echo "fetch-electron: installed patched electron v$VERSION into $DEST" >&2
