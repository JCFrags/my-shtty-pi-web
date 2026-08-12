#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'PIN_USAGE'
usage: scripts/update-pins.sh --agent-browser VERSION --lightpanda VERSION --searxng IMAGE [--pi VERSION]

This command only updates reviewed pins. Run the protocol, backend conformance,
password-manager spike, and representative workflow benchmarks before committing.
PIN_USAGE
}

PI=""; AGENT_BROWSER=""; LIGHTPANDA=""; SEARXNG=""
while (($#)); do
  case "$1" in
    --pi) PI="$2"; shift 2 ;;
    --agent-browser) AGENT_BROWSER="$2"; shift 2 ;;
    --lightpanda) LIGHTPANDA="$2"; shift 2 ;;
    --searxng) SEARXNG="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -n "$AGENT_BROWSER" && -n "$LIGHTPANDA" && -n "$SEARXNG" ]] || { usage >&2; exit 2; }

python - "$PI" "$AGENT_BROWSER" "$LIGHTPANDA" "$SEARXNG" <<'PIN_PY'
from pathlib import Path
import re, sys
pi, agent, lightpanda, searxng = sys.argv[1:]
root = Path.cwd()

p = root / "VERSION_PINS.toml"
s = p.read_text()
if pi:
    s = re.sub(r'(\[pi\][\s\S]*?version = ")[^"]+', rf'\g<1>{pi}', s, count=1)
s = re.sub(r'(\[agent_browser\][\s\S]*?version = ")[^"]+', rf'\g<1>{agent}', s, count=1)
s = re.sub(r'(\[searxng\][\s\S]*?image = ")[^"]+', rf'\g<1>{searxng}', s, count=1)
s = re.sub(r'(\[lightpanda\][\s\S]*?version = ")[^"]+', rf'\g<1>{lightpanda}', s, count=1)
p.write_text(s)

p = root / "deploy/versions.env"
s = p.read_text()
if pi: s = re.sub(r'^PI_VERSION=.*$', f'PI_VERSION={pi}', s, flags=re.M)
s = re.sub(r'^AGENT_BROWSER_VERSION=.*$', f'AGENT_BROWSER_VERSION={agent}', s, flags=re.M)
s = re.sub(r'^LIGHTPANDA_VERSION=.*$', f'LIGHTPANDA_VERSION={lightpanda}', s, flags=re.M)
s = re.sub(r'^SEARXNG_IMAGE=.*$', f'SEARXNG_IMAGE={searxng}', s, flags=re.M)
p.write_text(s)
PIN_PY

node scripts/check-repo.mjs
printf 'Pins updated. Do not commit until conformance and workflow benchmarks pass.\n'
