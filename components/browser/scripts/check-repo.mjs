#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const required = [
  "Cargo.toml", "package.json", "pnpm-workspace.yaml", "AGENTS.md",
  "schema/protocol.schema.json", "crates/browserd/src/coordinator.rs",
  "crates/backend-agent-browser/src/lib.rs", "packages/pi-extension/src/index.ts",
  "apps/workspace/src/App.tsx", "services/reader/src/pi_web_reader/pipeline.py",
  "services/docling/src/pi_web_docling/converter.py", "deploy/install-fedora.sh",
  "tools/stream-viewer/index.html", "scripts/password-manager-spike.mjs",
  "tests/observations/corpus.json", "docs/implementation-brief.md", "BUILD_REPORT.md",
  "VALIDATION.json", "apps/workspace/src-tauri/icons/icon.svg",
];

for (const relative of required) {
  assert.equal((await stat(resolve(root, relative))).isFile(), true, `missing required file: ${relative}`);
}

const schema = JSON.parse(await text("schema/protocol.schema.json"));
const tsProtocol = await text("packages/protocol-ts/src/index.ts");
const rustProtocol = await text("crates/protocol/src/lib.rs");
for (const method of schema.methods) {
  assert.match(tsProtocol, new RegExp(escapeRegExp(method)), `TypeScript protocol missing ${method}`);
  assert.match(rustProtocol, new RegExp(escapeRegExp(method)), `Rust protocol missing ${method}`);
}
for (const event of schema.events) {
  assert.match(tsProtocol, new RegExp(escapeRegExp(event)), `TypeScript protocol missing ${event}`);
  assert.match(rustProtocol, new RegExp(escapeRegExp(event)), `Rust protocol missing ${event}`);
}

const coordinator = await text("crates/browserd/src/coordinator.rs");
const backend = await text("crates/backend-agent-browser/src/lib.rs");
const extension = await text("packages/pi-extension/src/index.ts");
const rpc = await text("packages/pi-extension/src/rpc.ts");
const workspace = await text("apps/workspace/src/App.tsx");
const workspaceRpc = await text("apps/workspace/src/lib/rpc.ts");
const viewport = await text("apps/workspace/src/components/Viewport.tsx");
const server = await text("crates/browserd/src/server.rs");
const capability = JSON.parse(await text("apps/workspace/src-tauri/capabilities/default.json"));

for (const id of ["agent_id", "browser_session_id", "tab_id"]) {
  assert.match(coordinator, new RegExp(id), `coordinator must retain explicit ${id}`);
}
assert.doesNotMatch(coordinator, /global[_ ]current[_ ](?:browser|tab|agent)/i);
assert.match(backend, /AGENT_BROWSER_NAMESPACE/);
assert.match(backend, /operation_lock/);
assert.match(backend, /AGENT_BROWSER_DOWNLOAD_PATH/);
assert.match(backend, /launch_args\.join\(","\)/);
assert.match(backend, /tab actions require stable-to-backend ID resolution/);
assert.doesNotMatch(
  backend,
  /AGENT_BROWSER_HEADED.*runtime\.launch\.visible/s,
  "visible workspace sessions must not open ordinary Chrome windows by default",
);
assert.match(extension, /setActiveTools/);
assert.match(extension, /source: "agent"/);
assert.match(rpc, /PI_BROWSERD_REQUEST_TIMEOUT_MS/);
assert.doesNotMatch(rpc, /setTimeout\(90_000/, "browser calls must not have a capability-limiting hard timeout");
assert.match(workspace, /Return to agent/);
assert.match(workspace, /selectOwnedTab/);
assert.match(workspace, /controlState: "takeover-pending"/);
assert.match(viewport, /releasePressedInput/);
assert.match(viewport, /onTakeover/);
assert.match(viewport, /inputSequence/);
for (const permission of [
  "core:window:allow-show", "core:window:allow-hide",
  "core:window:allow-unminimize", "core:window:allow-set-focus",
]) assert.ok(capability.permissions.includes(permission), `missing Tauri permission ${permission}`);
assert.match(server, /workspace_token/);
assert.match(server, /header::AUTHORIZATION/);
assert.match(server, /Permissions::from_mode\(0o600\)/);
assert.doesNotMatch(workspaceRpc, /searchParams\.set\("token"/);
assert.match(workspaceRpc, /authenticated HTTP/);
assert.match(workspaceRpc, /authorization: `Bearer \$\{descriptor\.workspaceToken\}`/);

const readerClient = await text("crates/reader-client/src/lib.rs");
const readerPipeline = await text("services/reader/src/pi_web_reader/pipeline.py");
assert.match(readerClient, /PI_WEB_SEARCH_TIMEOUT_MS/);
assert.match(readerClient, /PI_WEB_READER_TIMEOUT_MS/);
assert.match(readerPipeline, /PI_WEB_HTTP_TIMEOUT_SECONDS/);
assert.match(readerPipeline, /PI_WEB_MAX_DOWNLOAD_BYTES/);

const versions = parseTomlSections(await text("VERSION_PINS.toml"));
const env = Object.fromEntries((await text("deploy/versions.env")).split(/\r?\n/)
  .filter((line) => /^[A-Z0-9_]+=/.test(line))
  .map((line) => line.split(/=(.*)/s).slice(0, 2)));
assert.equal(versions.pi.version, env.PI_VERSION);
assert.equal(versions.agent_browser.version, env.AGENT_BROWSER_VERSION);
assert.equal(versions.lightpanda.version, env.LIGHTPANDA_VERSION);
assert.equal(versions.searxng.image, env.SEARXNG_IMAGE);

console.log(JSON.stringify({ ok: true, protocolVersion: schema.version, checkedFiles: required.length }));

async function text(relative) { return await readFile(resolve(root, relative), "utf8"); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function parseTomlSections(value) {
  const result = {};
  let section;
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const header = line.match(/^\[([^\]]+)]$/);
    if (header) { section = header[1]; result[section] ??= {}; continue; }
    const pair = line.match(/^([A-Za-z0-9_]+)\s*=\s*"(.*)"$/);
    if (pair && section) result[section][pair[1]] = pair[2];
  }
  return result;
}
