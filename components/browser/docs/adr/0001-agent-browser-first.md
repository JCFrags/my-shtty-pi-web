# ADR 0001: Use agent-browser as the initial browser backend

- Status: accepted
- Date: 2026-07-27

## Context

The product requires Chromium and Lightpanda, named sessions, persistent profiles, extension loading, compact accessibility observations, debugging, uploads/downloads, screenshots, and a bidirectional live viewport. Reimplementing these before validating an existing driver would delay the user-visible vertical slice and increase protocol risk.

## Decision

Use agent-browser as an external, version-ranged dependency behind `BrowserController`. Give every host a unique backend session within `AGENT_BROWSER_NAMESPACE=pi-web-v1`. Invoke structured JSON mode and preserve complete backend output as artifacts. Do not fork it in the initial release.

## Consequences

The adapter must compensate for focus-addressed operations by atomically selecting the intended tab. Backend IDs never escape as coordinator identities. Upstream incompatibilities receive a narrow shim or documented issue; alternate backends can pass the same conformance suite without changing Pi tools or the workspace.
