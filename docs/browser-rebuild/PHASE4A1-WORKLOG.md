# Phase 4A.1 recovery worklog

## Checkpoint 0 — inherited f8 baseline verified

- Current Git SHA: `f8f5c20f9c902868441da46adcc64d6a9a023e26`.
- Exact commands run: `git fetch origin`; `git switch rebuild/screenshot-first-browser`; `git status --short --branch`; `git rev-parse HEAD`; `git rev-parse origin/rebuild/screenshot-first-browser`; `git log --oneline --decorate -12`; `git diff --check`; `~/.local/bin/pi-webctl version --json`; `~/.local/bin/pi-webctl status --json`; `~/.local/bin/pi-webctl doctor --json`; bounded `systemctl --user is-active` checks for ordinary and qualification units; bounded installation-root residue checks.
- Pass/fail classification: PASS — branch and upstream match; tree is clean; inherited installed state is healthy; exact f8 CI run `33677880097` is complete and successful with all eight jobs successful; qualification services, runtime, and activation transaction are absent.
- Current immutable installed release ID: `phase4a-d5c2920faf104a92252e5a6f823bd0e2842f3b79`.
- Current backend classification: repository default is `legacy`; installed release selects `agentcursor`; ordinary selected services are active; qualification services are inactive.
- Current Phase 4A.1 blocker: qualification runner/controller failures lose the bounded tool code, status, stage, and operation context; the prior short-soak failure is therefore not actionable.
- Next concrete step: implement and test the finite privacy-safe classified qualification-failure envelope and controller publication/cleanup path before another live qualification run.

This worklog contains no runtime descriptors, secrets, lease identifiers, endpoints, process identifiers, profile paths, raw browser URLs, page content, input, canaries, or journal output.
