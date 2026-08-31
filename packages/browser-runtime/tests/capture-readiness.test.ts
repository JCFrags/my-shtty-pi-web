import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { captureProofIdentity, SessionCaptureReadiness } from "../src/capture/readiness.js";
import type { TabRecord } from "../src/targets/registry.js";

function tab(tabId: string, documentGeneration = 1, viewportGeneration = 1): TabRecord {
  return { browserSessionId: "session:ready", tabId, targetId: `target_${tabId}_123456789`, cdpSessionId: `cdp_${tabId}`, documentGeneration, viewportGeneration, state: "open", latestFrameSequence: 0, url: "about:blank", title: "" };
}

describe("session capture readiness", () => {
  it("requires two exact governed captures and recovers an intervening failure only after a later success", () => {
    let changes = 0;
    const readiness = new SessionCaptureReadiness(() => { changes++; });
    const selected = tab("one");
    const identity = captureProofIdentity(selected, 1);
    assert.equal(readiness.state, "starting");
    readiness.begin(selected, 1);
    assert.equal(readiness.state, "warming");
    assert.equal(readiness.succeeded(identity), "warming");
    readiness.failed(identity);
    assert.equal(readiness.state, "degraded");
    assert.equal(readiness.succeeded(identity), "ready", "a later selected success recovers the failure and proves the required subsequent frame");
    readiness.failed(identity);
    assert.equal(readiness.state, "degraded");
    assert.equal(readiness.succeeded(identity), "ready");
    assert.equal(changes, 5, "internal proof counters must not publish workspace revisions");
  });

  it("keeps a session ready when another exact tab is ready and ignores stale outcomes", () => {
    const readiness = new SessionCaptureReadiness(() => undefined);
    const first = tab("one");
    const firstIdentity = captureProofIdentity(first, 1);
    readiness.begin(first, 1);
    readiness.succeeded(firstIdentity); readiness.succeeded(firstIdentity);
    assert.equal(readiness.state, "ready");

    const second = tab("two");
    const secondIdentity = captureProofIdentity(second, 1);
    readiness.begin(second, 1);
    assert.equal(readiness.state, "ready");
    readiness.failed(secondIdentity);
    assert.equal(readiness.state, "ready");

    const nextGeneration = tab("two", 2, 3);
    const nextIdentity = captureProofIdentity(nextGeneration, 2);
    readiness.begin(nextGeneration, 2);
    readiness.failed(secondIdentity);
    assert.equal(readiness.succeeded(secondIdentity), "warming");
    assert.equal(readiness.tabState("two"), "warming");
    readiness.succeeded(nextIdentity); readiness.succeeded(nextIdentity);
    assert.equal(readiness.state, "ready");
  });

  it("does not reset an exact ready proof when begin is repeated", () => {
    const readiness = new SessionCaptureReadiness(() => undefined);
    const selected = tab("one");
    const identity = captureProofIdentity(selected, 1);
    readiness.begin(selected, 1);
    readiness.succeeded(identity); readiness.succeeded(identity);
    readiness.begin(selected, 1);
    assert.equal(readiness.state, "ready");
  });

  it("keeps unavailable sticky and removes terminal tabs", () => {
    const readiness = new SessionCaptureReadiness(() => undefined);
    const selected = tab("one");
    readiness.begin(selected, 1);
    readiness.markUnavailable();
    readiness.begin(tab("two"), 2);
    assert.equal(readiness.state, "unavailable");
    assert.equal(readiness.tabState("two"), "unavailable");
    readiness.remove("one");
    assert.equal(readiness.state, "unavailable");
  });
});
