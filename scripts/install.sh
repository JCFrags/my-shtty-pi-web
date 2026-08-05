#!/bin/bash
set -euo pipefail

DOWNLOAD_URL="__DOWNLOAD_URL__"
VERSION="__VERSION__"
CHANNEL="__CHANNEL__"
SHA256="__SHA256__"
SIZE="__SIZE__"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "terminal-browser currently supports Apple Silicon macOS only" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TARBALL="$TMP/terminal-browser.tar.gz"
echo "downloading terminal-browser $VERSION ($((SIZE / 1000000)) MB)"
curl -fL --retry 3 --retry-delay 2 --progress-bar "$DOWNLOAD_URL" -o "$TARBALL"

echo "$SHA256  $TARBALL" | shasum -a 256 -c - >/dev/null || {
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

AGENT_SKILLS="${AGENT_SKILLS_HOME:-$HOME/.agents/skills}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
RECEIPT="$STATE_HOME/terminal-browser/skills.links"
WROTE="$(mktemp)"
trap 'rm -rf "$TMP" "$WROTE"' EXIT

link() {
  mkdir -p "$(dirname "$2")"
  ln -sfn "$1" "$2"
  printf '%s\n' "$2" >> "$WROTE"
}

LINKED=""
while read -r kind name location variant; do
  [ "$kind" = agent ] || continue
  DIR="$HOME/$location"
  [ -d "$DIR" ] || continue
  MADE=""
  while read -r skind skill; do
    [ "$skind" = skill ] || continue
    TARGET="$APP/skills/${variant:-default}/$skill"
    [ -d "$TARGET" ] || continue
    LINK="$DIR/$skill"
    if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
      echo "leaving $LINK alone, it is not a link we made"
      continue
    fi
    link "$TARGET" "$LINK"
    MADE=1
  done < "$APP/skills/manifest"
  if [ -n "$MADE" ]; then LINKED="$LINKED $name"; fi
done < "$APP/skills/manifest"

while read -r kind skill; do
  [ "$kind" = skill ] || continue
  [ -d "$APP/skills/default/$skill" ] || continue
  SHARED="$AGENT_SKILLS/$skill"
  if [ -d "$SHARED" ] && [ ! -L "$SHARED" ]; then
    rm -f "$SHARED/SKILL.md"
    rmdir "$SHARED" 2>/dev/null || true
  fi
  if [ -e "$SHARED" ] && [ ! -L "$SHARED" ]; then
    echo "leaving $SHARED alone, it holds files we did not put there"
    continue
  fi
  link "$APP/skills/default/$skill" "$SHARED"
done < "$APP/skills/manifest"

if [ -f "$RECEIPT" ]; then
  while read -r stale; do
    [ -n "$stale" ] || continue
    grep -qxF "$stale" "$WROTE" && continue
    [ -L "$stale" ] || continue
    case "$(readlink "$stale")" in "$APP"/*) rm -f "$stale"; echo "removed $stale" ;; esac
  done < "$RECEIPT"
fi
mkdir -p "$(dirname "$RECEIPT")"
sort -u "$WROTE" > "$RECEIPT"

echo "installed terminal-browser $(cat "$APP/VERSION")${CHANNEL:+ ($CHANNEL)}"
echo "skills $AGENT_SKILLS${LINKED:+ (linked into$LINKED)}"

if [ -z "${TERMINAL_BROWSER_SKIP_EDITOR_SETUP:-}" ]; then
  "$APP/bin/terminal-browser" setup || true
fi
case ":$PATH:" in
  *":$BIN_HOME:"*) ;;
  *)
    echo
    echo "add $BIN_HOME to your PATH first:"
    echo "  echo 'export PATH=\"$BIN_HOME:\$PATH\"' >> ~/.zshrc && exec zsh"
    ;;
esac
echo
echo "terminal-browser open terminal-browser.com"
