# Multi-agent and profile concurrency

## Identity and liveness

The extension derives a stable `agentId` from the Pi session ID/file and creates a process-specific `clientId`. It registers on `session_start`, sends a heartbeat every five seconds, and unregisters on shutdown. The daemon marks a client disconnected after fifteen seconds and retains any owned browser state. An agent row is removed once it has neither a connected client nor an owned browser session; orphan rows with no recoverable browser state are also discarded on daemon restart. Forked Pi sessions receive a new browser mapping unless explicitly attached.

## Allocation

- Anonymous Lightpanda work: independent host/session by default.
- Ephemeral Chromium: independent host/session by default.
- Named persistent profile: one Chromium host for the profile and agent-owned tabs inside it.

Two Chromium processes never open the same user-data directory. Profile creation and host startup are protected by a profile lock. Profile-global settings cannot be changed while that profile host is running.

## Queues

The initial scheduler uses one FIFO queue per host. A queue entry performs:

```text
validate ownership → wait for human control to end → focus intended tab
→ execute one operation → collect page delta/artifacts → release
```

Host-global work such as extension pages, browser settings, and downloads therefore cannot collide. Different hosts have independent locks and execute concurrently. The backend interface permits a later per-tab queue when a driver provides safe direct tab addressing.

## Human takeover

Pointer or keyboard input in the selected viewport sets that tab to `human`. Agent actions for that tab wait; other tabs and hosts continue. `Return to agent` releases queued work. An optional inactivity timeout can do the same. This state is coordination, not a permission decision.

## Focus and attention

Background work updates state, activity, thumbnails, and attention badges. It does not change workspace selection. `/browser` explicitly raises the one workspace process and selects the invoking agent. A selected or human-controlled browser is not eligible for idle cleanup; persistent profile hosts remain alive by default.

The model-facing `browser_tabs` tool lists every session and tab owned by the invoking agent and can explicitly close a tab or stop a session. Closing the final tab stops that owned session cleanly. Browser state is never closed merely because a heartbeat was missed.
