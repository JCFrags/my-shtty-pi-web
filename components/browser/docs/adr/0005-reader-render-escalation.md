# ADR 0005: The coordinator owns reader render escalation

- Status: accepted
- Date: 2026-07-29

## Context

The HTTP reader can cheaply identify a JavaScript shell but does not own Pi identity, profiles, browser sessions, or artifact/download directories. Letting it launch a browser would create unowned global state and bypass engine routing.

## Decision

The reader returns bounded static evidence with `renderRequired`. `pi-browserd` creates an explicitly agent-owned transient Lightpanda session, observes main content, and closes it. A failed Lightpanda attempt may escalate to ephemeral Chromium, with all attempts recorded in metadata. Authenticated reads use an already addressed Chromium tab and never migrate state.

## Consequences

Browser lifecycle and resource limits remain centralized. Background rendering does not steal focus. Failures are visible and static evidence is retained rather than silently replaced.
