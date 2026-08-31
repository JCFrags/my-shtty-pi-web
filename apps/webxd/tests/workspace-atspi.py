#!/usr/bin/python3
"""Bounded AT-SPI driver for the real Pi Browser Workspace acceptance route."""

from __future__ import annotations

import json
import sys
import time
from typing import Callable

import pyatspi

ACTIONS = {"inspect", "take-control", "return-control", "exercise-input", "exercise-pointer", "hold-input"}
MAX_NODES = 5_000
WAIT_SECONDS = 20.0
INPUT_WAIT_SECONDS = 30.0


def children(accessible):
    try:
        count = min(int(accessible.childCount), 512)
    except Exception:
        return
    for index in range(count):
        try:
            child = accessible.getChildAtIndex(index)
        except Exception:
            continue
        if child is not None:
            yield child


def find_matching(
    matches: Callable[[str], bool],
    ready: Callable[[object], bool] = lambda _item: True,
    wait_seconds: float = WAIT_SECONDS,
):
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        queue = list(children(pyatspi.Registry.getDesktop(0)))
        visited = 0
        while queue and visited < MAX_NODES:
            item = queue.pop(0)
            visited += 1
            try:
                if matches(item.name or "") and ready(item):
                    return item
            except Exception:
                pass
            queue.extend(children(item))
        time.sleep(0.05)
    raise RuntimeError("target")


def find_named(name: str, ready: Callable[[object], bool] = lambda _item: True):
    return find_matching(lambda value: value == name, ready)


def is_editable(item) -> bool:
    try:
        return item.getState().contains(pyatspi.STATE_EDITABLE)
    except Exception:
        return False


def is_enabled(item) -> bool:
    try:
        return item.getState().contains(pyatspi.STATE_ENABLED)
    except Exception:
        return False


def invoke_accessible(item) -> None:
    try:
        action = item.queryAction()
        if action.nActions < 1 or not action.doAction(0):
            raise RuntimeError("action")
    except Exception as error:
        raise RuntimeError("action") from error


def invoke_button(name: str) -> None:
    invoke_accessible(find_named(name, is_enabled))


def invoke_fixed_input(prefix: str, event_count: int) -> int:
    find_named("Live browser screenshot under human control", is_editable)
    item = find_matching(lambda value: value.startswith(prefix), is_enabled)
    prior = item.name
    try:
        invoke_accessible(item)
    except Exception as error:
        raise RuntimeError("invoke") from error
    # A short pointer-only run can move from running to complete before a fresh
    # AT-SPI tree walk observes the transient running label. Wait for the fixed
    # terminal label directly so completion cannot race the acceptance driver.
    try:
        terminal = find_matching(
            lambda value: (
                value.startswith(f"{prefix} complete")
                or value.startswith(f"{prefix} failed")
            )
            and value != prior,
            wait_seconds=INPUT_WAIT_SECONDS,
        )
    except Exception as error:
        raise RuntimeError("terminal-timeout") from error
    if terminal.name.startswith(f"{prefix} failed"):
        raise RuntimeError("terminal-failed")
    return event_count


def exercise_pointer() -> int:
    return invoke_fixed_input("Run pointer input", 2)


def exercise_input() -> int:
    return invoke_fixed_input("Run control input", 23)


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ACTIONS:
        return 2
    action = sys.argv[1]
    try:
        if action == "inspect":
            find_named("Pi Browser Workspace")
            result = {"ok": True, "action": action, "eventCount": 0}
        elif action == "take-control":
            invoke_button("Take control")
            result = {"ok": True, "action": action, "eventCount": 1}
        elif action == "return-control":
            invoke_button("Return to agent")
            result = {"ok": True, "action": action, "eventCount": 1}
        elif action == "exercise-pointer":
            result = {"ok": True, "action": action, "eventCount": exercise_pointer()}
        elif action == "hold-input":
            result = {"ok": True, "action": action, "eventCount": invoke_fixed_input("Run held input", 2)}
        else:
            result = {"ok": True, "action": action, "eventCount": exercise_input()}
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
        return 0
    except Exception as error:
        # Emit only one allowlisted harness state. Never include an accessible
        # name, page value, input value, or library exception in output.
        code = str(error)
        if code not in {"invoke", "terminal-timeout", "terminal-failed"}:
            code = "unclassified"
        sys.stderr.write(f"workspace AT-SPI action failed:{code}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
