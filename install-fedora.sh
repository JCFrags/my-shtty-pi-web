#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
usage() {
  echo "usage: $0 [--profile {web-core|documents|render|browser|full}]... [--stage [STAGE_OPTIONS] | --cutover-plan CANDIDATE EVIDENCE | --cutover-apply CANDIDATE EVIDENCE | --cutover-rollback RUN_ID]" >&2
}

case "${1:-}" in
  --stage)
    shift
    exec "$SOURCE_ROOT/scripts/pi-web-stage" --source "$SOURCE_ROOT" "$@"
    ;;
  --cutover-plan)
    [[ $# -eq 3 ]] || { usage; exit 2; }
    exec "$SOURCE_ROOT/scripts/pi-web-cutover" --plan --candidate "$2" --evidence "$3"
    ;;
  --cutover-apply)
    [[ $# -eq 3 ]] || { usage; exit 2; }
    exec "$SOURCE_ROOT/scripts/pi-web-cutover" --apply --candidate "$2" --evidence "$3"
    ;;
  --cutover-rollback)
    [[ $# -eq 2 ]] || { usage; exit 2; }
    exec "$SOURCE_ROOT/scripts/pi-web-cutover" --rollback "$2"
    ;;
esac

profiles=()
while (($#)); do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      profiles+=(--profile "$2"); shift 2
      ;;
    *) usage; exit 2 ;;
  esac
done

[[ -f /etc/fedora-release ]] || { echo "error: This installer supports Fedora Linux." >&2; exit 1; }
command -v sudo >/dev/null || { echo "error: sudo is required to install Fedora packages." >&2; exit 1; }
plan="$($SOURCE_ROOT/scripts/pi-web-profile --source "$SOURCE_ROOT" "${profiles[@]}")"
mapfile -t packages < <(/usr/bin/python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["fedoraPackages"]))' <<<"$plan")
missing=()
for package in "${packages[@]}"; do rpm -q "$package" >/dev/null 2>&1 || missing+=("$package"); done
if ((${#missing[@]})); then
  printf 'Installing Fedora packages for the selected profile.\n'
  sudo dnf install -y "${missing[@]}"
fi

command -v node >/dev/null || { echo "error: Node.js 24 or newer is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "error: npm is required." >&2; exit 1; }
(( $(node -p 'Number(process.versions.node.split(".")[0])') >= 24 )) || { echo "error: Node.js 24 or newer is required." >&2; exit 1; }
command -v pi >/dev/null || { echo "error: Pi must be installed before Pi Web Tools." >&2; exit 1; }
PREFIX="${PI_WEB_PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
mkdir -p "$BIN_DIR"
export PATH="$BIN_DIR:$HOME/.local/bin:$PATH"
if ! command -v pnpm >/dev/null || [[ "$(pnpm --version)" != "10.13.1" ]]; then
  npm install --global --prefix "$PREFIX" pnpm@10.13.1
fi
if ! command -v uv >/dev/null; then
  temporary_installer="$(mktemp)"
  trap 'rm -f "$temporary_installer"' EXIT
  curl --fail --location https://astral.sh/uv/0.12.0/install.sh -o "$temporary_installer"
  sh "$temporary_installer"
  rm -f "$temporary_installer"
  trap - EXIT
  export PATH="$BIN_DIR:$HOME/.local/bin:$PATH"
fi
command -v uv >/dev/null || { echo "error: uv 0.12.0 or newer is required." >&2; exit 1; }

candidate_json="$($SOURCE_ROOT/scripts/pi-web-stage --source "$SOURCE_ROOT" "${profiles[@]}")"
printf '%s\n' "$candidate_json"
printf 'Candidate staged. Run the deterministic gate, review the plan, and apply the cutover. No live path changed.\n' >&2
