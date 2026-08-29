# Browser rebuild decisions

These decisions apply to the replacement browser runtime. They supersede conflicting Phase 0 draft text.

## ADR-001: Raw CDP plus selective AgentCursor core

**Decision:** Use one persistent browser-level Chrome DevTools Protocol connection per browser session. Selectively port AgentCursor path and persona source from version `0.3.0`, commit `b23c633c66fd240f836f5edd1034f6fcf678e237`.

**Reason:** CDP gives explicit target lifecycle, input, screenshot, and accessibility control. AgentCursor supplies useful human-style path and persona behavior without imposing its transport.

**Consequence:** This repository owns target mapping, overlay behavior, cancellation, and Chrome compatibility tests. The MIT license and exact upstream record stay beside the port.

## ADR-002: Separate browserd process

**Decision:** Run `apps/browserd` as a separate persistent Node process. `webxd` will use a private Unix protocol and must not import the full browser runtime.

**Reason:** Chrome and CDP failure must not disable healthy search, read, cache, or content services.

**Consequence:** Phase 1 implements and tests the transport but does not connect production `webxd` or Pi tools.

## ADR-003: One Chrome process per browser session

**Decision:** Give each browser session one headed Chrome or Chromium process and one runtime-created disposable profile.

**Reason:** A process boundary gives clear session isolation and failure ownership.

**Consequence:** Linux process-tree PSS, not summed RSS, is the primary memory metric. A weaker shared-context model requires a later explicit decision based on evidence.

## ADR-004: One motor per browser session

**Decision:** Store one persona, cursor position, path sequence, pressed-input state, and serialized input lane per browser session.

**Reason:** One simulated person must remain consistent while it moves between tabs.

**Consequence:** Pointer work across tabs in one session serializes. Different browser sessions can act concurrently. Document, viewport, observation, frame, overlay, and handle state remain per tab.

## ADR-005: Screenshot-first perception

**Decision:** Make an explicit lossless screenshot observation the primary agent perception primitive. Keep DOM or accessibility observation explicit and separate.

**Reason:** The product acts through visual grounding. Automatic DOM extraction would change the behavior model and increase data volume.

**Consequence:** Coordinate actions cite an observation ID and revalidate it immediately before irreversible dispatch.

## ADR-006: Separate agent observations and workspace frames

**Decision:** Keep agent observations and live workspace frames as different bounded products.

**Reason:** Agent observations need durable grounding metadata. Workspace frames need low-latency replacement and can drop intermediate images.

**Consequence:** Frame scheduling does not create model observations. The runtime stores only bounded observation metadata and owner-scoped artifact references.

## ADR-007: Connection-bound actor identity

**Decision:** Bind each browserd connection once to one principal and Pi agent session after validating the protocol version and per-start descriptor secret.

**Reason:** Ordinary requests must not select an owner or switch identity.

**Consequence:** Request schemas omit actor selectors. Status, cancellation, sessions, tabs, observations, frames, artifacts, and handles are actor-scoped. The Phase 1 secret proves same-user descriptor access, not actor-specific identity against a hostile same-user process. Phase 2 must add trusted-service attestation if that threat is in scope.

## ADR-008: No MCP or Chrome extension

**Decision:** Do not add AgentCursor MCP, its extension, stock extension transport, macOS driver, or full package.

**Reason:** They add process, packaging, and active-tab surfaces. Phase 0 and Phase 1 evidence shows that raw CDP covers the required browser capabilities.

**Consequence:** Reconsider an extension only after a deterministic test proves one named required capability cannot use CDP or a narrow preload script.

## ADR-009: No arbitrary evaluation API

**Decision:** Do not expose general JavaScript evaluation in protocol, service, Pi-facing API, or production exports.

**Reason:** Arbitrary evaluation expands authority and makes policy, privacy, and auditing harder.

**Consequence:** Runtime internals can use narrow fixed CDP operations. Live fixtures can use a private source-level adapter that request handling cannot enable.

## ADR-010: Temporary profiles in Phase 1

**Decision:** Support runtime-created disposable profiles only. Do not accept a host path or share a profile.

**Reason:** This gives deterministic ownership and cleanup while persistence policy is still undefined.

**Consequence:** Profile deletion requires an owned manifest under the configured root and a settled exact process. Persistent owner-scoped profiles remain a later design.

## ADR-011: Trust webxd, not arbitrary same-user clients

**Decision:** In production, `browserd` accepts only trusted `webxd` as its client. `webxd` authenticates and scopes the Pi connection before it supplies actor identity. The Pi extension and model requests do not receive the descriptor or binding secret.

**Reason:** Owner-only Unix permissions and a random descriptor secret isolate Unix users. They cannot isolate hostile processes that already run under the same Unix user ID.

**Consequence:** Direct browserd access is an administrator and developer capability. Hostile same-UID code remains outside the protection boundary unless a later separate-user or sandbox design is adopted. See `ADR-011-BROWSERD-TRUST-BOUNDARY.md`.

## Phase 1.1 confirmations

Phase 1.1 confirms that frame subscriptions are connection-, actor-, full-address-, epoch-, and subscription-ID-scoped. Operation IDs use canonical semantic fingerprints. Artifacts use actor, session, tab, purpose, media type, size, digest, and lifetime provenance. Screenshot metadata is checked before and after capture. Descriptor and profile ownership use runtime instance identity plus PID start identity.
