import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { BrowserSpike } from "./browser-spike.js";
import type { CoordinateAction } from "./cdp-browser-driver.js";
import { measureProcessResources } from "./process-metrics.js";
import { OwnershipError, StaleObservationError, type DomFallbackNode, type Observation } from "./types.js";

interface FixtureState { agent: string; count: number; text: string }
interface OverlayState { visible: boolean; sampleCount: number; pathSequence: number; x: number; y: number }
interface FrameEvent { agentSessionId: string; frameSequence: number; capturedAt: string; receivedAt: string }

const spike = new BrowserSpike();
let result: Record<string, unknown> | null = null;
let failure: unknown;

const emergencyClose = () => { void spike.close(); };
process.once("SIGINT", emergencyClose);
process.once("SIGTERM", emergencyClose);

try {
  await spike.start();
  const driverA = spike.driver("agent-a");
  const driverB = spike.driver("agent-b");
  const targetA = driverA.identity.targetId;
  const targetB = driverB.identity.targetId;
  const hostA = spike.hosts.get("agent-a");
  const hostB = spike.hosts.get("agent-b");
  if (!hostA || !hostB) throw new Error("both Chrome hosts must exist");

  assert.equal(spike.hosts.size, 2, "two Chrome hosts must run");
  assert.equal(spike.drivers.size, 2, "two explicit agent drivers must exist");
  assert.notEqual(targetA, targetB, "targets must be distinct");
  assert.notEqual(hostA.profileDirectory, hostB.profileDirectory);
  assert.notEqual(hostA.metrics.debuggingPort, hostB.metrics.debuggingPort);
  assert.ok([...spike.hosts.values()].every((host) => host.running && host.connected));

  const initialStarted = performance.now();
  const [initialA, initialB] = await Promise.all([
    driverA.screenshot("agent-a", targetA),
    driverB.screenshot("agent-b", targetB),
  ]);
  const initialParallelScreenshotMs = performance.now() - initialStarted;
  assert.match(initialA.url, /\/fixture\/agent-a$/);
  assert.match(initialB.url, /\/fixture\/agent-b$/);
  assert.equal(initialA.title, "Phase 0 agent-a");
  assert.equal(initialB.title, "Phase 0 agent-b");
  assert.notEqual(initialA.screenshotSha256, initialB.screenshotSha256, "independent pages must produce independent frames");
  assert.ok(initialA.screenshot.length > 5_000 && initialB.screenshot.length > 5_000);

  const [domA, domB] = await Promise.all([
    driverA.domFallback("agent-a", targetA),
    driverB.domFallback("agent-b", targetB),
  ]);
  const addOne = requiredNode(domA.nodes, "button", "Add one");
  const addTen = requiredNode(domB.nodes, "button", "Add ten");
  const inputA = requiredNode(domA.nodes, "textbox", "Agent text");
  const inputB = requiredNode(domB.nodes, "textbox", "Agent text");
  assert.match(addOne.handle, new RegExp(`^${domA.documentGeneration}:`));
  assert.ok(addOne.bounds && addTen.bounds && inputA.bounds && inputB.bounds);

  const ssePromise = collectFrameEvents(`${spike.server.origin}/events`, 6, 8_000);
  spike.startFramePump(500);
  const frameEvents = await ssePromise;
  assert.ok(new Set(frameEvents.map((event) => event.agentSessionId)).size === 2, "viewer must receive both sessions");
  assert.ok(frameEvents.filter((event) => event.agentSessionId === "agent-a").length >= 2, "viewer must receive repeated agent-a frames");
  assert.ok(frameEvents.filter((event) => event.agentSessionId === "agent-b").length >= 2, "viewer must receive repeated agent-b frames");
  const sessionsResponse = await fetch(`${spike.server.origin}/api/sessions`, { cache: "no-store" });
  assert.equal(sessionsResponse.status, 200);
  const viewerSessions = await sessionsResponse.json() as Array<{ agentSessionId: string; latestFrameSequence: number }>;
  assert.deepEqual(viewerSessions.map((session) => session.agentSessionId), ["agent-a", "agent-b"]);
  assert.ok(viewerSessions.every((session) => session.latestFrameSequence >= 2));
  for (const id of ["agent-a", "agent-b"] as const) {
    const response = await fetch(`${spike.server.origin}/api/frame/${id}`);
    assert.equal(response.status, 200);
    assert.ok(Number(response.headers.get("x-frame-sequence")) >= 2);
    assert.ok((await response.arrayBuffer()).byteLength > 5_000);
  }
  spike.stopFramePump();

  const [clickObsA, clickObsB] = await Promise.all([
    driverA.screenshot("agent-a", targetA),
    driverB.screenshot("agent-b", targetB),
  ]);
  const clickActionA = coordinate(clickObsA, center(addOne));
  const clickActionB = coordinate(clickObsB, center(addTen));
  const [clickTimingA, clickTimingB] = await Promise.all([
    driverA.click(clickActionA),
    driverB.click(clickActionB),
  ]);

  const [focusObsA, focusObsB] = await Promise.all([
    driverA.screenshot("agent-a", targetA),
    driverB.screenshot("agent-b", targetB),
  ]);
  await Promise.all([
    driverA.click(coordinate(focusObsA, center(inputA))),
    driverB.click(coordinate(focusObsB, center(inputB))),
  ]);
  await Promise.all([
    driverA.typeText("agent-a", targetA, "alpha-only", true),
    driverB.typeText("agent-b", targetB, "bravo-only", true),
  ]);

  const [stateA, stateB] = await Promise.all([
    driverA.evaluate<FixtureState>("agent-a", targetA, "globalThis.fixtureState()"),
    driverB.evaluate<FixtureState>("agent-b", targetB, "globalThis.fixtureState()"),
  ]);
  assert.deepEqual(stateA, { agent: "agent-a", count: 1, text: "alpha-only" });
  assert.deepEqual(stateB, { agent: "agent-b", count: 10, text: "bravo-only" });

  await assert.rejects(
    driverA.click({ ...clickActionA, targetId: targetB }),
    (error: unknown) => error instanceof OwnershipError,
    "cross-session target use must be rejected",
  );
  const stateBAfterRejectedCrossUse = await driverB.evaluate<FixtureState>("agent-b", targetB, "globalThis.fixtureState()");
  assert.deepEqual(stateBAfterRejectedCrossUse, stateB, "rejected agent-a action must not change agent-b");

  const beforeCursorA = await driverA.screenshot("agent-a", targetA);
  const beforeCursorB = await driverB.screenshot("agent-b", targetB);
  const [moveTimingA, moveTimingB] = await Promise.all([
    driverA.move(coordinate(beforeCursorA, { x: 760, y: 520 })),
    driverB.move(coordinate(beforeCursorB, { x: 700, y: 470 })),
  ]);
  const [afterCursorA, afterCursorB] = await Promise.all([
    driverA.screenshot("agent-a", targetA),
    driverB.screenshot("agent-b", targetB),
  ]);
  assert.notEqual(beforeCursorA.screenshotSha256, afterCursorA.screenshotSha256, "agent-a cursor must change its screenshot");
  assert.notEqual(beforeCursorB.screenshotSha256, afterCursorB.screenshotSha256, "agent-b cursor must change its screenshot");

  await Promise.all([
    driverA.evaluate("agent-a", targetA, "document.getElementById('__piBrowserCursor').style.visibility='hidden'"),
    driverB.evaluate("agent-b", targetB, "document.getElementById('__piBrowserCursor').style.visibility='hidden'"),
  ]);
  const [hiddenCursorA, hiddenCursorB] = await Promise.all([
    driverA.screenshot("agent-a", targetA),
    driverB.screenshot("agent-b", targetB),
  ]);
  await Promise.all([
    driverA.evaluate("agent-a", targetA, "document.getElementById('__piBrowserCursor').style.visibility='visible'"),
    driverB.evaluate("agent-b", targetB, "document.getElementById('__piBrowserCursor').style.visibility='visible'"),
  ]);
  const [visibleCursorA, visibleCursorB, overlayA, overlayB] = await Promise.all([
    driverA.screenshot("agent-a", targetA),
    driverB.screenshot("agent-b", targetB),
    overlayState(driverA, "agent-a", targetA),
    overlayState(driverB, "agent-b", targetB),
  ]);
  assert.notEqual(hiddenCursorA.screenshotSha256, visibleCursorA.screenshotSha256, "agent-a overlay must affect screenshot pixels");
  assert.notEqual(hiddenCursorB.screenshotSha256, visibleCursorB.screenshotSha256, "agent-b overlay must affect screenshot pixels");
  assert.ok(overlayA.visible && overlayB.visible, "both injected cursor overlays must be visible");
  assert.ok(overlayA.sampleCount > 8 && overlayB.sampleCount > 8, "both cursors must follow sampled paths");
  assert.notEqual(driverA.persona.seed, driverB.persona.seed, "personas must be session-specific");
  assert.notDeepEqual(driverA.status().cursor, driverB.status().cursor, "cursor state must stay independent");

  const launchCountBeforeWarmActions = spike.browserProcessLaunchCount;
  const hostPidsBeforeWarmActions = [...spike.hosts.values()].map((host) => host.process.pid);
  const screenshotLatencies: number[] = [];
  for (let index = 0; index < 6; index++) {
    const driver = index % 2 === 0 ? driverA : driverB;
    const id = index % 2 === 0 ? "agent-a" : "agent-b";
    const started = performance.now();
    await driver.screenshot(id, driver.identity.targetId);
    screenshotLatencies.push(performance.now() - started);
  }
  const roundTrips: number[] = [];
  for (let index = 0; index < 20; index++) roundTrips.push(await driverA.cdpRoundTrip("agent-a", targetA));
  assert.equal(spike.browserProcessLaunchCount, launchCountBeforeWarmActions, "warm actions must not launch browsers");
  assert.deepEqual([...spike.hosts.values()].map((host) => host.process.pid), hostPidsBeforeWarmActions, "warm actions must keep the same browser processes");

  spike.startFramePump(500);
  const resources = await measureProcessResources([
    process.pid,
    ...[...spike.hosts.values()].flatMap((host) => host.process.pid && host.process.pid > 0 ? [host.process.pid] : []),
  ], 2_000);
  spike.stopFramePump();

  const staleObservation = await driverA.screenshot("agent-a", targetA);
  await driverA.navigate("agent-a", targetA, `${spike.server.fixtureUrl("agent-a")}?generation=2`);
  await assert.rejects(
    driverA.move(coordinate(staleObservation, { x: 100, y: 100 })),
    (error: unknown) => error instanceof StaleObservationError,
    "navigation must stale document-scoped observations",
  );

  const chrome = await spike.chromeVersion();
  const startupTimes = [...spike.hosts.values()].map((host) => host.metrics.startupMs);
  const frameLatencies = frameEvents.map((event) => Date.parse(event.receivedAt) - Date.parse(event.capturedAt));
  result = {
    passed: true,
    sessions: ["agent-a", "agent-b"],
    chrome,
    agentCursor: { version: "0.3.0", commit: "b23c633c66fd240f836f5edd1034f6fcf678e237" },
    proof: {
      independentScreenshotHashes: [initialA.screenshotSha256, initialB.screenshotSha256],
      finalState: { "agent-a": stateA, "agent-b": stateB },
      cursorOverlay: { "agent-a": overlayA, "agent-b": overlayB },
      viewerFrameEvents: frameEvents.length,
      domFallbackNodes: { "agent-a": domA.nodes.length, "agent-b": domB.nodes.length },
      crossSessionRejected: true,
      staleObservationRejected: true,
      browserProcessLaunches: spike.browserProcessLaunchCount,
    },
    performance: {
      chromeStartupMs: summary(startupTimes),
      warmScreenshotMs: summary(screenshotLatencies),
      warmCdpRoundTripMs: summary(roundTrips),
      parallelInitialScreenshotsMs: initialParallelScreenshotMs,
      intentionalMousePathMs: summary([moveTimingA.pathDurationMs, moveTimingB.pathDurationMs]),
      mousePathWallMs: summary([moveTimingA.pathWallMs, moveTimingB.pathWallMs]),
      clickCompletionExcludingPathMs: summary([clickTimingA.completionAfterPathMs, clickTimingB.completionAfterPathMs]),
      frameUpdateLatencyMs: summary(frameLatencies),
      twoBrowserPollingResources: resources,
    },
  };
} catch (error) {
  failure = error;
} finally {
  await spike.close();
  const cleanup = {
    browserProcessesExited: [...spike.hosts.values()].every((host) => !host.running),
    cdpDisconnected: [...spike.hosts.values()].every((host) => !host.connected),
    temporaryProfilesRemoved: await spike.profilesAreRemoved(),
  };
  if (result) result.cleanup = cleanup;
  try {
    assert.deepEqual(cleanup, { browserProcessesExited: true, cdpDisconnected: true, temporaryProfilesRemoved: true });
  } catch (cleanupError) {
    failure ??= cleanupError;
  }
}

process.removeListener("SIGINT", emergencyClose);
process.removeListener("SIGTERM", emergencyClose);
if (failure) throw failure;
console.log(JSON.stringify(result, null, 2));

function requiredNode(nodes: DomFallbackNode[], role: string, name: string): DomFallbackNode {
  const node = nodes.find((candidate) => candidate.role === role && candidate.name === name);
  assert.ok(node, `DOM fallback must include ${role} ${name}`);
  return node;
}

function center(node: DomFallbackNode): { x: number; y: number } {
  assert.ok(node.bounds, `node ${node.name} must have bounds`);
  return { x: node.bounds.x + node.bounds.width / 2, y: node.bounds.y + node.bounds.height / 2 };
}

function coordinate(observation: Observation, point: { x: number; y: number }): CoordinateAction {
  return {
    agentSessionId: observation.agentSessionId,
    targetId: observation.targetId,
    observationId: observation.observationId,
    x: point.x,
    y: point.y,
  };
}

async function overlayState(
  driver: ReturnType<BrowserSpike["driver"]>,
  owner: "agent-a" | "agent-b",
  targetId: string,
): Promise<OverlayState> {
  return await driver.evaluate<OverlayState>(owner, targetId, `(() => {
    const host = document.getElementById('__piBrowserCursor');
    const state = globalThis.__piBrowserCursor;
    const style = host && getComputedStyle(host);
    return { visible: !!host && style.display !== 'none' && style.visibility !== 'hidden', sampleCount: state.sampleCount, pathSequence: state.pathSequence, x: state.x, y: state.y };
  })()`);
}

async function collectFrameEvents(url: string, count: number, timeoutMs: number): Promise<FrameEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const events: FrameEvent[] = [];
    while (events.length < count) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffered.indexOf("\n\n")) >= 0) {
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (!block.startsWith("event: frame")) continue;
        const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data) events.push({ ...(JSON.parse(data) as Omit<FrameEvent, "receivedAt">), receivedAt: new Date().toISOString() });
      }
    }
    await reader.cancel();
    assert.ok(events.length >= count, `expected ${count} frame events, got ${events.length}`);
    return events;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function summary(values: number[]): { min: number; median: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted.at(0);
  const max = sorted.at(-1);
  if (min === undefined || max === undefined) throw new Error("cannot summarize an empty measurement");
  return {
    min,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max,
  };
}

function percentile(sorted: number[], percentileValue: number): number {
  const value = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
  if (value === undefined) throw new Error("cannot select a percentile from an empty measurement");
  return value;
}
