#!/usr/bin/env python3
"""Validate the fixed GitHub Actions workflow security and M0 command policy."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parent.parent
WORKFLOW: Final = ROOT / ".github/workflows/m0.yml"
CHECKOUT_SHA: Final = "11bd71901bbe5b1630ceea73d27597364c9af683"
ACTION: Final = re.compile(r"(?m)^\s*uses:\s*([^\s#]+)")
FULL_ACTION: Final = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}$")
FORBIDDEN: Final = (
    "pull_request_target:",
    "workflow_run:",
    "curl ",
    "wget ",
    "docker ",
    "podman ",
    "docker://",
    "continue-on-error:",
    "retry",
)


def validate(text: str) -> list[str]:
    failures: list[str] = []
    required = {
        "pull_request trigger": "  pull_request:\n",
        "main push trigger": "      - main\n",
        "read-only contents": "  contents: read\n",
        "self-hosted runner": "      - self-hosted\n",
        "pinned toolchain runner": "      - webx-toolchain\n",
        "ephemeral runner": "      - webx-ephemeral\n",
        "timeout": "    timeout-minutes: 30\n",
        "credential removal": "          persist-credentials: false\n",
        "shallow checkout": "          fetch-depth: 1\n",
        "workflow validation": "        run: python3 scripts/ci_validate.py\n",
        "fixed release target": "        run: make release-check\n",
    }
    for name, token in required.items():
        if token not in text:
            failures.append(f"workflow lacks {name}")
    if "permissions:\n  contents: read\n" not in text:
        failures.append("workflow permissions are not top-level read-only contents")
    for token in FORBIDDEN:
        if token.lower() in text.lower():
            failures.append(f"workflow contains forbidden token: {token}")
    actions = ACTION.findall(text)
    if actions != [f"actions/checkout@{CHECKOUT_SHA}"]:
        failures.append(f"workflow external actions differ: {actions!r}")
    for action in actions:
        if not FULL_ACTION.fullmatch(action):
            failures.append(f"external action is not pinned by full commit SHA: {action}")
    return failures


def main() -> int:
    workflow_dir = WORKFLOW.parent
    discovered = sorted(
        path
        for pattern in ("*.yml", "*.yaml")
        for path in workflow_dir.glob(pattern)
        if path.is_file()
    )
    if discovered != [WORKFLOW]:
        names = [path.name for path in discovered]
        print(f"ci-validate: ERROR: unexpected workflow set: {names!r}", file=sys.stderr)
        return 1
    try:
        text = WORKFLOW.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        print(f"ci-validate: ERROR: {WORKFLOW}: {error}", file=sys.stderr)
        return 2
    failures = validate(text)
    if failures:
        for failure in failures:
            print(f"ci-validate: ERROR: {WORKFLOW.relative_to(ROOT)}: {failure}", file=sys.stderr)
        return 1
    print(f"ci-validate: OK workflow={WORKFLOW.relative_to(ROOT)} actions=1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
