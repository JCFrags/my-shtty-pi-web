# ADR-027: Browser resource supervision

## Status

Accepted for the Phase 4A candidate runtime on 2026-09-01.

The deterministic hard-bound implementation and exact installed qualification are complete. The user superseded the original four-hour soak with a maximum of ten minutes; the exact candidate passed the fixed 300-second workload. This resolves ADR-012 for bounded Phase 4A canary use, not for a production-default switch. AgentCursor remains an explicit opt-in. The installed and repository default remains `legacy`.

## Context

The Phase 1.2 two-hour run did not prove a practical Chrome PSS plateau. Later 30-minute runs proved correctness and bounded application stores, but they were not long enough to remove the release risk. One Chrome process per browser session remains the required isolation model.

An unbounded Chrome process cannot be a production default. Automatic browser replacement under an existing session ID would hide state loss and break operation, observation, tab, and human-control authority. A release candidate therefore needs hard resource containment that ends only the affected session and reports the loss explicitly.

## Decision

`browserd` owns one `BrowserResourceSupervisor`. It registers every ready browser session with its exact Chrome root PID and `/proc` process-start ticks, disposable profile, operation hooks, control hooks, and close hook.

The supervisor samples on one serialized timer. It records process-tree PSS, private dirty memory, process count, renderer count, and profile bytes. PSS is the admission metric because RSS can count shared pages more than once. Profile traversal does not follow symbolic links and has an entry bound. Process samples verify root and descendant identities before and after reads. A missing, changed, or unreadable identity makes that sample unavailable; it does not authorize signaling or deletion.

The session state machine is:

- `normal`;
- `warning`;
- `draining`;
- `resource-limited`;
- `closing`;
- `closed`.

A sampling failure produces a bounded `warning` with reason `sampling-unavailable`. It does not silently close the session from an invented measurement.

### Candidate defaults

| Limit | Default |
|---|---:|
| Per-session soft PSS | 1,024 MiB |
| Per-session hard PSS | 1,280 MiB |
| Global Chrome PSS | 4,096 MiB |
| Profile soft bytes | 512 MiB |
| Profile hard bytes | 1,024 MiB |
| Sample interval | 5,000 ms |
| Drain timeout | 30,000 ms |
| Emergency close wait | 15,000 ms |
| Maximum browser sessions | 16 |
| Idle timeout | disabled |
| Maximum session age | disabled |

These memory defaults are above the previously observed normal per-session range. They are candidate limits, not a plateau claim. The Phase 4A installed acceptance proved one warning and one hard-limit closure; the shortened soak remained below the limits. A later reviewed adjustment requires new evidence. Configuration is strict and bounded. Unknown `PI_WEB_RESOURCE_*` variables fail startup. Soft limits must be below hard limits, the global limit cannot be below the per-session hard limit, and the emergency timeout cannot exceed the drain timeout.

### Soft limit

At a per-session PSS or profile soft limit, the session changes to `warning`. Current work continues. The private workspace and doctor receive only a bounded state and reason. Raw process, profile, path, and memory records do not cross into React or model output.

### Hard limit

At a per-session hard PSS or profile limit, the supervisor:

1. changes the session to `draining`;
2. fences new model mutations, observations, frame subscriptions, takeover, and human input with typed `BROWSER_RESOURCE_LIMIT`;
3. removes existing model and workspace frame subscriptions;
4. cancels queued and running operations at their bounded cancellation points;
5. waits for operation settlement within the drain budget;
6. requests safe return when human control is active and waits only within the same budget;
7. changes the session to `resource-limited` and then `closing`;
8. runs one shared close attempt, even when later samples or callers retry cleanup;
9. removes the session only after exact Chrome and profile cleanup succeeds;
10. retains one bounded terminal reason.

A close timeout does not start a second concurrent close. The existing close attempt remains authoritative. A failed settled close can be retried by a later supervisor sample. The session remains fenced while cleanup is incomplete.

The runtime never creates a replacement browser under the old session ID. The actor must open a new session. Old observations, tabs, operations, frame ledgers, and human leases are not remapped.

### Global emergency limit

When sampled Chrome PSS exceeds the global limit, the supervisor selects victims deterministically:

1. idle agent-controlled sessions;
2. sessions with active agent work;
3. sessions in takeover, human, disconnected-human, or return transfer state;
4. registration order as the stable tie breaker.

It closes one victim through the same hard-limit path, resamples open sessions, and repeats only while the measured total remains above the limit. It never signals a process that is not owned by an exact registered Chrome identity.

### Chrome and profile cleanup boundary

Each Chrome launch creates a unique POSIX process session. The runtime records PID, process-start ticks, and process-session ID before it publishes the host. Cleanup captures both the exact process tree and all members of that process session while the root identity is still alive.

Normal close uses CDP `Browser.close`, then exact-identity TERM and KILL only when required. Profile removal requires all of the following:

- the initial exact tree and process session were observed;
- the original root identity is gone, not reused or merely changed;
- every remembered descendant identity is gone;
- no same-UID process names the exact `--user-data-dir`;
- two final process-session scans are both empty.

A descendant created after the first tree scan remains in the isolated process session and blocks deletion. Capture failure, PID reuse, an identity change, a surviving descendant, a late process-session member, or an unreadable scan retains the profile and reports cleanup failure. Failed launch uses the same original identity and process-session boundary. It never invents an identity from the current occupant of a reused PID.

This is same-UID cooperative process supervision for the reviewed Chromium product. It is not hostile same-UID isolation.

## Private status and diagnostics

The private browser protocol and workspace protocol expose only:

- state;
- bounded reason;
- supervised-session count;
- warning-session count;
- limited-session count;
- bounded terminal-event count;
- last bounded terminal reason.

The doctor probes the private browserd status route directly and classifies its bounded reply. The workspace displays degraded or limited state without process IDs, paths, PSS values, profile values, descriptors, secrets, CDP endpoints, page content, or human input.

## Verification

Deterministic tests cover:

- soft PSS and profile warnings;
- hard limits while idle, running, queued, and under human control;
- failed human return and bounded lease cleanup;
- child-process accounting and PID reuse;
- global two-session victim order and unrelated-process protection;
- operation, observation, frame, and takeover fencing with `BROWSER_RESOURCE_LIMIT`;
- no duplicate close and retry of one failed close;
- no session remapping;
- strict installed configuration;
- bounded browser and workspace protocol status;
- doctor privacy and malformed-status classification;
- exact profile retention on uncertain tree, identity change, same-UID use, and late process-session membership;
- exact failed-launch settlement.

The base implementation is commit `02b6c78` on `rebuild/screenshot-first-browser`. Terminal classification and qualification races were corrected through exact candidate `30d76dc608cf9ce62d4c887cada02e63e93967b9`. Repository lint, typecheck, tests, schema checks, release-builder checks, exact Rust 1.88 workspace tests, and focused runtime tests passed. Installed acceptance proved one profile warning, one typed hard limit, same-owner bounded terminal classification, cross-owner nondisclosure, exact cleanup, and no remapping.

## Consequences

ADR-012 now has both a tested deterministic containment mechanism and representative evidence from the exact installed immutable release. The user-approved fixed soak completed in 315.024 seconds with 23 memory samples, start/end 670,356/660,692 KiB, min/max 474,260/694,004 KiB, and a full-window fitted slope of -120,709.733 KiB/hour. The short window is not a general Chrome plateau claim and cannot supply final-two-hour, final-hour, or final-30-minute slopes.

This is sufficient only for the Phase 4A canary because hard containment, typed loss, exact cleanup, unrelated-process protection, and no remapping were also proved. Therefore:

- AgentCursor remains non-default;
- `WEBX_BROWSER_BACKEND=legacy` remains the default;
- the legacy runtime and rollback switch remain installed;
- no Phase 4B default switch is authorized by this ADR.

A future default-cutover decision must review continued operational evidence and keep these limits as a safety backstop.
