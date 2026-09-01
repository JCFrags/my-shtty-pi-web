import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { BrowserProtocolError, PROTOCOL_VERSION, type ActorIdentity, type BrowserRequest } from "@webx/browser-protocol";
import type { BrowserResourceReason } from "../src/resources/supervisor.js";
import { BrowserRuntime } from "../src/registry/runtime.js";

const owner: ActorIdentity = { principalId: "principal:resource-terminal", agentSessionId: "agent:resource-terminal" };
const otherOwner: ActorIdentity = { principalId: "principal:other", agentSessionId: "agent:other" };
const runtimes: BrowserRuntime[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.close()));
});

interface FakeSession {
  readonly actor: ActorIdentity;
  readonly control?: { assertAgentAdmission(): void };
  setResourceStatus(status: unknown): void;
  close(): Promise<void>;
  descriptor?(): unknown;
}

interface InternalRuntime {
  readonly sessions: Map<string, FakeSession>;
  readonly resourceLimitTerminals: Map<string, unknown>;
  terminateResourceLimitedSession(browserSessionId: string, reason: Exclude<BrowserResourceReason, "none" | "sampling-unavailable">): Promise<void>;
}

function runtime(): BrowserRuntime {
  const value = new BrowserRuntime({ resourceSupervisor: { autoStart: false } });
  runtimes.push(value);
  return value;
}

function internal(value: BrowserRuntime): InternalRuntime {
  return value as unknown as InternalRuntime;
}

function tabList(browserSessionId: string, requestId: string): BrowserRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "tab.list",
    requestId,
    operationId: `operation:${requestId}`,
    deadline: new Date(Date.now() + 5_000).toISOString(),
    browserSessionId,
    controlEpoch: 1,
  };
}

function fakeSession(actor: ActorIdentity, onClose: () => void = () => undefined): FakeSession {
  return {
    actor,
    setResourceStatus: () => undefined,
    close: async () => { onClose(); },
  };
}

async function expectCode(task: Promise<unknown>, code: BrowserProtocolError["code"], reason?: string): Promise<void> {
  await assert.rejects(task, (error) => error instanceof BrowserProtocolError && error.code === code && (reason === undefined || error.details?.reason === reason));
}

describe("resource-limit terminal classification", () => {
  it("keeps a bounded same-owner resource classification after exact session cleanup without retaining the session", async () => {
    const value = runtime();
    const state = internal(value);
    let closes = 0;
    state.sessions.set("session:limited", fakeSession(owner, () => { closes++; }));

    await state.terminateResourceLimitedSession("session:limited", "profile-storage");

    assert.equal(closes, 1);
    assert.deepEqual(await value.dispatch(owner, {
      protocolVersion: PROTOCOL_VERSION,
      kind: "session.list",
      requestId: "request:list-after-limit",
      operationId: "operation:list-after-limit",
      deadline: new Date(Date.now() + 5_000).toISOString(),
    }), { kind: "sessions", sessions: [] });
    await expectCode(value.dispatch(owner, tabList("session:limited", "same-owner")), "BROWSER_RESOURCE_LIMIT", "profile-storage");
    await expectCode(value.dispatch(otherOwner, tabList("session:limited", "other-owner")), "SESSION_NOT_FOUND");
  });

  it("evicts the oldest terminal at 64 entries and expires retained classifications after 60 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const value = runtime();
    const state = internal(value);

    for (let index = 0; index < 65; index++) {
      const browserSessionId = `session:limited:${index}`;
      state.sessions.set(browserSessionId, fakeSession(owner));
      await state.terminateResourceLimitedSession(browserSessionId, "session-memory");
    }

    assert.equal(state.resourceLimitTerminals.size, 64);
    await expectCode(value.dispatch(owner, tabList("session:limited:0", "evicted")), "SESSION_NOT_FOUND");
    await expectCode(value.dispatch(owner, tabList("session:limited:64", "retained")), "BROWSER_RESOURCE_LIMIT", "session-memory");

    await vi.advanceTimersByTimeAsync(59_999);
    await expectCode(value.dispatch(owner, tabList("session:limited:64", "before-expiry")), "BROWSER_RESOURCE_LIMIT", "session-memory");
    await vi.advanceTimersByTimeAsync(1);
    await expectCode(value.dispatch(owner, tabList("session:limited:64", "expired")), "SESSION_NOT_FOUND");
    assert.equal(state.resourceLimitTerminals.size, 0);
  });

  it("does not classify an ordinary owner-requested session close as a resource limit", async () => {
    const value = runtime();
    const state = internal(value);
    const browserSessionId = "session:ordinary-close";
    const session = fakeSession(owner) as FakeSession & { descriptor(): unknown; control: { assertAgentAdmission(): void } };
    session.descriptor = () => ({ kind: "session", browserSessionId, state: "closed" });
    session.control = { assertAgentAdmission: () => undefined };
    state.sessions.set(browserSessionId, session);

    await value.dispatch(owner, {
      protocolVersion: PROTOCOL_VERSION,
      kind: "session.close",
      requestId: "request:ordinary-close",
      operationId: "operation:ordinary-close",
      deadline: new Date(Date.now() + 5_000).toISOString(),
      browserSessionId,
      controlEpoch: 1,
    });

    await expectCode(value.dispatch(owner, tabList(browserSessionId, "after-ordinary-close")), "SESSION_NOT_FOUND");
    assert.equal(state.resourceLimitTerminals.size, 0);
  });
});
