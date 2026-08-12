import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonRpcUnixClient } from "../src/client.mjs";
import { removeTree } from "../src/core.mjs";
import { startReferenceServer } from "../src/server.mjs";

test("newline-delimited JSON-RPC and loopback HTTP share coordinator state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-server-test-"));
  const runtimeDir = join(root, "run"); const dataRoot = join(root, "data");
  const server = await startReferenceServer({ runtimeDir, dataRoot });
  t.after(async () => { await server.close(); await removeTree(root); });
  const client = new JsonRpcUnixClient(server.descriptor.socketPath); t.after(() => client.close());
  const ping = await client.call("system.ping"); assert.equal(ping.protocolVersion, "1.0.0");
  await client.call("agent.register", { agentId: "a", clientId: "c", cwd: "/tmp", pid: 1, mode: "tui" });
  const browser = await client.call("browser.start", { agentId: "a", engine: "lightpanda", url: "https://socket.test" });
  const unauthenticated = await fetch(`${server.descriptor.workspaceEndpoint}/state`); assert.equal(unauthenticated.status, 401);
  const response = await fetch(`${server.descriptor.workspaceEndpoint}/state`, {
    headers: { authorization: `Bearer ${server.descriptor.workspaceToken}` },
  });
  assert.equal(response.status, 200);
  const state = await response.json(); assert.equal(state.tabs[0].tabId, browser.tab.tabId);
});
