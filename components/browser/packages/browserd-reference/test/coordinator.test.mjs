import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Coordinator, MockBrowserBackend, removeTree } from "../src/core.mjs";

async function fixture(options = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), "pi-web-reference-"));
  const backend = options.backend ?? new MockBrowserBackend(options.backendOptions);
  const coordinator = new Coordinator({ dataRoot, backend, heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 15_000 });
  await coordinator.initialize();
  return { coordinator, backend, async close() { await removeTree(dataRoot); } };
}

function registration(number) {
  return { agentId: `agent-${number}`, clientId: `client-${number}`, piSessionId: `pi-${number}`, piSessionName: `agent ${number}`, cwd: `/work/${number}`, pid: 4000 + number, mode: "tui" };
}

async function registerAndStart(coordinator, number, engine = "chromium") {
  await coordinator.call("agent.register", registration(number));
  return coordinator.call("browser.start", { agentId: `agent-${number}`, engine, label: `session-${number}`, url: `https://agent-${number}.test/` });
}

test("three agents never cross action, observation, or artifact boundaries", async (t) => {
  const environment = await fixture(); t.after(environment.close);
  const { coordinator } = environment;
  const [a, b, c] = await Promise.all([registerAndStart(coordinator, 1, "chromium"), registerAndStart(coordinator, 2, "lightpanda"), registerAndStart(coordinator, 3, "chromium")]);
  const values = [a, b, c];
  await Promise.all(values.map((value, index) => coordinator.call("browser.act", { agentId: `agent-${index + 1}`, browserSessionId: value.browserSession.browserSessionId, tabId: value.tab.tabId, action: { kind: "fill", ref: "e1", text: `secret-${index + 1}` } })));
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const observation = await coordinator.call("browser.observe", { agentId: `agent-${index + 1}`, browserSessionId: value.browserSession.browserSessionId, tabId: value.tab.tabId, view: "full" });
    assert.match(observation.url, new RegExp(`agent-${index + 1}\\.test`));
    assert.match(observation.content, new RegExp(`secret-${index + 1}`));
    for (let other = 0; other < values.length; other += 1) if (other !== index) assert.doesNotMatch(observation.content, new RegExp(`secret-${other + 1}`));
  }
  await assert.rejects(() => coordinator.call("browser.observe", { agentId: "agent-1", browserSessionId: b.browserSession.browserSessionId, tabId: b.tab.tabId }), /belongs to another agent/);
  const download = await coordinator.call("browser.act", { agentId: "agent-1", browserSessionId: a.browserSession.browserSessionId, tabId: a.tab.tabId, action: { kind: "download", ref: "e2" } });
  const page = await coordinator.call("artifact.get", { artifactId: download.downloadArtifactId, offset: 0, limit: 1024 });
  assert.equal(page.record.ownerAgentId, "agent-1"); assert.equal(page.record.browserSessionId, a.browserSession.browserSessionId); assert.equal(page.record.tabId, a.tab.tabId);
});

test("same-host actions serialize while unrelated hosts execute concurrently", async (t) => {
  const environment = await fixture({ backendOptions: { actionDelayMs: 60 } }); t.after(environment.close);
  const { coordinator, backend } = environment;
  await coordinator.call("agent.register", registration(1));
  const first = await coordinator.call("browser.start", { agentId: "agent-1", engine: "chromium", url: "https://one.test" });
  const secondTab = await coordinator.call("browser.openTab", { agentId: "agent-1", browserSessionId: first.browserSession.browserSessionId, url: "https://two.test" });
  const other = await registerAndStart(coordinator, 2, "chromium");
  const started = Date.now();
  await Promise.all([
    coordinator.call("browser.act", { agentId: "agent-1", browserSessionId: first.browserSession.browserSessionId, tabId: first.tab.tabId, action: { kind: "click", ref: "e1" } }),
    coordinator.call("browser.act", { agentId: "agent-1", browserSessionId: first.browserSession.browserSessionId, tabId: secondTab.tabId, action: { kind: "click", ref: "e2" } }),
    coordinator.call("browser.act", { agentId: "agent-2", browserSessionId: other.browserSession.browserSessionId, tabId: other.tab.tabId, action: { kind: "click", ref: "e1" } }),
  ]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 110, `same-host actions should serialize, elapsed=${elapsed}`);
  assert.ok(elapsed < 230, `unrelated host should overlap, elapsed=${elapsed}`);
  assert.equal(backend.maxConcurrentOperations, 2);
});

test("one persistent profile maps to one host and agent-owned tabs", async (t) => {
  const environment = await fixture(); t.after(environment.close);
  const { coordinator } = environment;
  await coordinator.call("agent.register", registration(1)); await coordinator.call("agent.register", registration(2));
  const profile = await coordinator.call("profile.create", { name: "main", dataDir: "/tmp/pi-web-test-profile" });
  const [first, second] = await Promise.all([
    coordinator.call("browser.start", { agentId: "agent-1", profileId: profile.profileId, url: "https://one.test" }),
    coordinator.call("browser.start", { agentId: "agent-2", profileId: profile.profileId, url: "https://two.test" }),
  ]);
  assert.equal(first.host.hostId, second.host.hostId);
  assert.notEqual(first.browserSession.browserSessionId, second.browserSession.browserSessionId);
  assert.notEqual(first.tab.tabId, second.tab.tabId);
  assert.equal(first.tab.ownerAgentId, "agent-1"); assert.equal(second.tab.ownerAgentId, "agent-2");
});

test("human takeover queues agent work until explicit return", async (t) => {
  const environment = await fixture(); t.after(environment.close);
  const { coordinator } = environment;
  const started = await registerAndStart(coordinator, 1);
  const address = { agentId: "agent-1", browserSessionId: started.browserSession.browserSessionId, tabId: started.tab.tabId };
  await coordinator.call("browser.setControl", { ...address, control: "human" });
  let completed = false;
  const pending = coordinator.call("browser.act", { ...address, action: { kind: "click", ref: "e2" } }).then((value) => { completed = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(completed, false);
  await coordinator.call("browser.setControl", { ...address, control: "agent" });
  const result = await pending; assert.equal(result.ok, true); assert.equal(completed, true);
});

test("heartbeat timeout disconnects a client without deleting browser state", async (t) => {
  const environment = await fixture({ heartbeatTimeoutMs: 10 }); t.after(environment.close);
  const { coordinator } = environment;
  const started = await registerAndStart(coordinator, 1);
  const client = coordinator.clients.get("client-1");
  client.lastHeartbeatAt = new Date(Date.now() - 1000).toISOString();
  assert.deepEqual(coordinator.sweepDisconnected(), ["client-1"]);
  const state = await coordinator.call("browser.list", { agentId: "agent-1" });
  assert.equal(state.sessions[0].browserSessionId, started.browserSession.browserSessionId);
});

test("human takeover also queues direct and cross-tab focus or close operations", async (t) => {
  const environment = await fixture(); t.after(environment.close);
  const { coordinator } = environment;
  const started = await registerAndStart(coordinator, 1);
  const second = await coordinator.call("browser.openTab", {
    agentId: "agent-1",
    browserSessionId: started.browserSession.browserSessionId,
    url: "https://second.test",
  });
  const firstAddress = {
    agentId: "agent-1",
    browserSessionId: started.browserSession.browserSessionId,
    tabId: started.tab.tabId,
  };
  const secondAddress = { ...firstAddress, tabId: second.tabId };

  await coordinator.call("browser.setControl", { ...secondAddress, control: "human" });
  let focusCompleted = false;
  const pendingFocus = coordinator.call("browser.focusTab", secondAddress).then((value) => {
    focusCompleted = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(focusCompleted, false);
  const humanFocus = await coordinator.call("browser.focusTab", { ...secondAddress, source: "human" });
  assert.equal(humanFocus.focused, true);
  assert.equal(focusCompleted, false);
  await coordinator.call("browser.setControl", { ...secondAddress, control: "agent" });
  assert.equal((await pendingFocus).focused, true);

  await coordinator.call("browser.setControl", { ...secondAddress, control: "human" });
  let closeCompleted = false;
  const pendingClose = coordinator.call("browser.act", {
    ...firstAddress,
    action: { kind: "tab-close", tabId: second.tabId },
  }).then((value) => {
    closeCompleted = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(closeCompleted, false);
  await coordinator.call("browser.setControl", { ...secondAddress, control: "agent" });
  const closed = await pendingClose;
  assert.equal(closed.ok, true);
  assert.equal(closed.tabId, second.tabId);
});
