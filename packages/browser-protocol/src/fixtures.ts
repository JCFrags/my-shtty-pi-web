import { PROTOCOL_VERSION } from "./schema.js";

export const validBindFixture = {
  protocolVersion: PROTOCOL_VERSION,
  kind: "bind",
  requestId: "request:bind:1",
  bindingSecret: "a".repeat(43),
  actor: { principalId: "owner:alpha", agentSessionId: "agent:alpha" },
} as const;

export const validRequestFixture = {
  protocolVersion: PROTOCOL_VERSION,
  kind: "session.create",
  requestId: "request:create:1",
  operationId: "operation:create:1",
  deadline: "2099-01-01T00:00:00.000Z",
  initialUrl: "http://127.0.0.1:8080/fixture",
} as const;

export const invalidRequestFixtures: ReadonlyArray<{ name: string; value: unknown }> = [
  { name: "unknown field", value: { ...validRequestFixture, ownerId: "attacker" } },
  { name: "unknown kind", value: { ...validRequestFixture, kind: "evaluate" } },
  { name: "unbounded coordinate", value: { protocolVersion: PROTOCOL_VERSION, kind: "action.coordinate", requestId: "r:1", operationId: "o:1", deadline: "2099-01-01T00:00:00.000Z", address: { browserSessionId: "session:1", tabId: "tab:1", targetId: "abcdefghijklmnop", controlEpoch: 1 }, observationId: "abcdefghijklmnop", action: { kind: "move", to: { x: Number.POSITIVE_INFINITY, y: 1 } } } },
  { name: "file URL", value: { ...validRequestFixture, initialUrl: "file:///etc/passwd" } },
  { name: "profile path", value: { ...validRequestFixture, profilePath: "/home/user/.config/chrome" } },
];
