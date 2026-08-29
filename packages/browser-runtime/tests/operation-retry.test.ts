import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BrowserProtocolError, PROTOCOL_VERSION, type BrowserRequest } from "@webx/browser-protocol";
import { canonicalOperationFingerprint } from "../src/operations/registry.js";
import { BrowserRuntime } from "../src/registry/runtime.js";

const actor = { principalId: "owner:retry", agentSessionId: "agent:retry" } as const;
const deadline = (): string => new Date(Date.now() + 5_000).toISOString();
const base = { protocolVersion: PROTOCOL_VERSION, requestId: "request:retry", operationId: "operation:retry", deadline: deadline() } as const;
const address = { browserSessionId: "session:deleted", tabId: "tab:deleted", targetId: "target:deleted", controlEpoch: 1 } as const;

function fingerprint(request: BrowserRequest, connectionId?: string): string {
  const semantics = { ...request } as Record<string, unknown>;
  delete semantics.requestId;
  delete semantics.deadline;
  if (request.kind === "frames.subscribe" || request.kind === "frames.unsubscribe") semantics.connectionId = connectionId ?? "unbound";
  return canonicalOperationFingerprint(semantics);
}

async function seed(runtime: BrowserRuntime, request: BrowserRequest, result: unknown, connectionId?: string, error?: BrowserProtocolError): Promise<void> {
  runtime.operations.submit(actor, { operationId: request.operationId, fingerprint: fingerprint(request, connectionId), laneKey: "seed", deadline: request.deadline }, async (context) => {
    context.markDispatched();
    if (error !== undefined) throw error;
    return result;
  });
  await runtime.operations.wait(actor, request.operationId);
}

describe("operation retry before resource lookup", () => {
  it("returns committed session.close and tab.close results after their resources disappeared", async () => {
    for (const request of [
      { ...base, operationId: "operation:session-close", kind: "session.close", browserSessionId: "session:deleted", controlEpoch: 1 },
      { ...base, operationId: "operation:tab-close", kind: "tab.close", address },
    ] as BrowserRequest[]) {
      const runtime = new BrowserRuntime();
      const expected = request.kind === "session.close"
        ? { kind: "session", browserSessionId: "session:deleted", controlEpoch: 1, state: "closed", personaId: "persona_retry", cursor: { x: 0, y: 0, pathSequence: 0, sampleSequence: 0, personaId: "persona_retry", visible: true }, tabs: [] }
        : { kind: "ack", operationId: request.operationId };
      await seed(runtime, request, expected);
      assert.deepEqual(await runtime.dispatch(actor, { ...request, requestId: `${request.requestId}:again`, deadline: deadline() }), expected);
      await runtime.close();
    }
  });

  it("returns an original failed tab.create and target-crash failure without creating another side effect", async () => {
    for (const [operationId, error] of [
      ["operation:tab-create-failed", new BrowserProtocolError("CDP_ERROR", "Page.enable failed")],
      ["operation:target-crashed", new BrowserProtocolError("TARGET_CRASHED", "Target crashed")],
    ] as const) {
      const runtime = new BrowserRuntime();
      const request = { ...base, operationId, kind: "tab.create", browserSessionId: "session:deleted", controlEpoch: 1 } as BrowserRequest;
      await seed(runtime, request, undefined, undefined, error);
      await assert.rejects(() => runtime.dispatch(actor, { ...request, requestId: `${request.requestId}:again`, deadline: deadline() }), (caught) => caught instanceof BrowserProtocolError && caught.code === error.code);
      assert.equal(runtime.operations.size, 1);
      await runtime.close();
    }
  });

  it("rejects a semantic conflict before session or tab lookup", async () => {
    const runtime = new BrowserRuntime();
    const request = { ...base, operationId: "operation:conflict-before-lookup", kind: "tab.close", address } as BrowserRequest;
    await seed(runtime, request, { kind: "ack", operationId: request.operationId });
    const conflicting = { ...request, requestId: "request:conflict", deadline: deadline(), address: { ...address, tabId: "tab:other", targetId: "target:other" } } as BrowserRequest;
    await assert.rejects(() => runtime.dispatch(actor, conflicting), (error) => error instanceof BrowserProtocolError && error.code === "OPERATION_CONFLICT");
    await runtime.close();
  });

  it("binds frame-operation retry semantics to one connection and never returns false success after reconnect", async () => {
    const runtime = new BrowserRuntime();
    const request = { ...base, operationId: "operation:subscribe-lost", kind: "frames.subscribe", address, subscriptionId: "subscription_retry", interest: "selected" } as BrowserRequest;
    const expected = { kind: "subscription", operationId: request.operationId, subscriptionId: "subscription_retry", subscribed: true };
    await seed(runtime, request, expected, "connection:old");
    assert.deepEqual(await runtime.dispatch(actor, { ...request, requestId: "request:same-connection", deadline: deadline() }, undefined, "connection:old"), expected);
    runtime.releaseConnection("connection:old");
    await assert.rejects(() => runtime.dispatch(actor, { ...request, requestId: "request:new-connection", deadline: deadline() }, undefined, "connection:new"), (error) => error instanceof BrowserProtocolError && error.code === "OPERATION_CONFLICT");
    await runtime.close();
  });
});
