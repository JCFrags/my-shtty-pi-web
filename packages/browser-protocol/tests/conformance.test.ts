import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { Check } from "typebox/value";
import {
  BindRequestSchema, BrowserProtocolError, BrowserRequestSchema, ProtocolSchemaDocument,
  ServerMessageSchema, invalidRequestFixtures, parseBindRequest, parseBrowserRequest,
  sanitizeMessage, validBindFixture, validRequestFixture,
} from "../src/index.js";

const now = Date.parse("2026-08-29T02:00:00.000Z");
const validDeadline = "2026-08-29T02:01:00.000Z";

describe("browser protocol conformance", () => {
  it("accepts the one-time actor binding and rejects extra authority fields", () => {
    assert.equal(Check(BindRequestSchema, validBindFixture), true);
    assert.deepEqual(parseBindRequest(validBindFixture), validBindFixture);
    assert.equal(Check(BindRequestSchema, { ...validBindFixture, ownerId: "replacement" }), false);
  });

  it("accepts a strict bounded request", () => {
    const request = { ...validRequestFixture, deadline: validDeadline };
    assert.equal(Check(BrowserRequestSchema, request), true);
    assert.deepEqual(parseBrowserRequest(request, now), request);
  });

  it("rejects unknown operations, fields, unsafe URLs, paths, and non-finite numbers", () => {
    for (const fixture of invalidRequestFixtures) {
      assert.equal(Check(BrowserRequestSchema, fixture.value), false, fixture.name);
    }
  });

  it("requires bounded opaque IDs for connection-scoped frame subscriptions", () => {
    const address = { browserSessionId: "session:frame", tabId: "tab:frame", targetId: "target_frame_0001", controlEpoch: 3 };
    const subscribe = { protocolVersion: "browser.v1", kind: "frames.subscribe", requestId: "request:subscribe", operationId: "operation:subscribe", deadline: validDeadline, address, subscriptionId: "subscription_0001", interest: "selected" };
    const { interest: _interest, ...subscriptionBase } = subscribe;
    const unsubscribe = { ...subscriptionBase, kind: "frames.unsubscribe" };
    assert.equal(Check(BrowserRequestSchema, subscribe), true);
    assert.equal(Check(BrowserRequestSchema, unsubscribe), true);
    assert.equal(Check(BrowserRequestSchema, { ...subscribe, subscriptionId: "short" }), false);
    assert.equal(Check(BrowserRequestSchema, { ...subscribe, connectionId: "internal" }), false);
  });

  it("enforces an absolute bounded deadline", () => {
    assert.throws(() => parseBrowserRequest({ ...validRequestFixture, deadline: "2026-08-29T01:59:59.000Z" }, now), (error: unknown) => error instanceof BrowserProtocolError && error.code === "DEADLINE_EXCEEDED");
    assert.throws(() => parseBrowserRequest({ ...validRequestFixture, deadline: "2026-08-29T02:10:00.000Z" }, now), (error: unknown) => error instanceof BrowserProtocolError && error.code === "INVALID_REQUEST");
  });

  it("has strict server response and event schemas", () => {
    assert.equal(Check(ServerMessageSchema, {
      protocolVersion: "browser.v1", kind: "bound", requestId: "request:1",
      actor: { principalId: "owner:1", agentSessionId: "agent:1" },
    }), true);
    assert.equal(Check(ServerMessageSchema, {
      protocolVersion: "browser.v1", kind: "bound", requestId: "request:1",
      actor: { principalId: "owner:1", agentSessionId: "agent:1" }, unexpected: true,
    }), false);
  });

  it("sanitizes filesystem and CDP endpoint details", () => {
    assert.equal(sanitizeMessage("failed at /tmp/profile-1 and ws://127.0.0.1:9000/devtools"), "failed at [redacted] and [redacted]");
  });

  it("keeps deterministic checked-in JSON schema output", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const output = await readFile(resolve(here, "../schema/browser-protocol.schema.json"), "utf8");
    assert.equal(output, `${JSON.stringify(ProtocolSchemaDocument, null, 2)}\n`);
  });
});
