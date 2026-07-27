#!/bin/bash
set -euo pipefail

BASE_URL="__BASE_URL__"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "terminal-browser currently supports Apple Silicon macOS only" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "downloading terminal-browser..."
curl -fsSL "$BASE_URL/chunks.txt" -o "$TMP/chunks.txt"
SHA="$(head -1 "$TMP/chunks.txt")"
TARBALL="$TMP/terminal-browser.tar.gz"
: > "$TARBALL"
tail -n +2 "$TMP/chunks.txt" | while read -r chunk; do
  [ -n "$chunk" ] || continue
  echo "  $chunk"
  curl -fsSL --retry 3 "$BASE_URL/$chunk" >> "$TARBALL"
done
echo "$SHA  $TARBALL" | shasum -a 256 -c - >/dev/null || {
  echo "download corrupted (checksum mismatch), try again" >&2
  exit 1
}

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"

APP="$DATA_HOME/terminal-browser/app"
if [ -d "$APP" ]; then
  echo "updating existing install (was $(cat "$APP/VERSION" 2>/dev/null || echo unknown))"
else
  echo "installing to $APP"
fi
rm -rf "$APP.new"
mkdir -p "$APP.new"
tar -xzf "$TARBALL" -C "$APP.new" --strip-components 1
pkill -f 'terminal-browser/app/browser/dist/main\.js' 2>/dev/null || true
rm -rf "$APP"
mv "$APP.new" "$APP"

mkdir -p "$BIN_HOME"
cat > "$BIN_HOME/terminal-browser" <<EOF
#!/bin/sh
exec "$APP/bin/terminal-browser" "\$@"
EOF
chmod +x "$BIN_HOME/terminal-browser"

echo "installed terminal-browser $(cat "$APP/VERSION")"
case ":$PATH:" in
  *":$BIN_HOME:"*) ;;
  *)
    echo
    echo "add $BIN_HOME to your PATH first:"
    echo "  echo 'export PATH=\"$BIN_HOME:\$PATH\"' >> ~/.zshrc && exec zsh"
    ;;
esac
echo
echo "  terminal-browser open example.com"

