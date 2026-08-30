import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const frontendPaths = ["src/App.tsx", "src/bridge.ts", "src/FrameViewport.tsx", "src/main.tsx", "src/workspaceState.ts"];
const frontend = (await Promise.all(frontendPaths.map((path) => readFile(new URL(path, root), "utf8")))).join("\n");
const rustFiles = (await readdir(new URL("src-tauri/src/", root))).filter((name) => name.endsWith(".rs"));
const rust = (await Promise.all(rustFiles.map((name) => readFile(new URL(`src-tauri/src/${name}`, root), "utf8")))).join("\n");
const tauriConfig = await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8");
const capability = await readFile(new URL("src-tauri/capabilities/default.json", root), "utf8");

test("frontend has only narrow Tauri channels and no network or secret transport", () => {
  assert.match(frontend, /new Channel<ArrayBuffer>/);
  assert.match(frontend, /workspace_open/);
  for (const forbidden of ["fetch(", "new WebSocket", "EventSource", "dangerouslySetInnerHTML", "workspaceToken", "bindingSecret", "socketPath", "browserd_descriptor", "base64", "localStorage"]) assert.doesNotMatch(frontend, new RegExp(forbidden.replace(/[()]/g, "\\$&")), forbidden);
});

test("Rust alone discovers and validates the private workspace descriptor", () => {
  assert.match(rust, /XDG_RUNTIME_DIR/);
  assert.match(rust, /workspace\.json/);
  assert.match(rust, /process_start_ticks/);
  assert.match(rust, /is_socket/);
  assert.match(rust, /0o600/);
  assert.match(rust, /UnixStream/);
  assert.doesNotMatch(rust, /browserd\.json/);
  assert.doesNotMatch(rust, /TcpStream/);
});

test("CSP and capability exclude remote and broad privileges", () => {
  assert.match(tauriConfig, /default-src 'none'/);
  assert.match(tauriConfig, /connect-src ipc: http:\/\/ipc\.localhost/);
  for (const forbidden of ["unsafe-eval", "unsafe-inline", "ws://", "127.0.0.1:*", "data:"]) assert.equal(tauriConfig.includes(forbidden), false, forbidden);
  for (const forbidden of ["shell", "process", "filesystem", "http", "opener", "clipboard"]) assert.equal(capability.includes(forbidden), false, forbidden);
});

test("live and probe frame channels are raw, acknowledged, and single-inflight", () => {
  assert.match(rust, /Channel<Response>/);
  assert.match(rust, /Response::new\(envelope\)/);
  assert.match(rust, /workspace_frame_ack/);
  assert.match(rust, /maximum_inflight: 1/);
  assert.match(rust, /PROBE_RECORDS: u32 = 100/);
  assert.match(rust, /PROBE_PAYLOAD_BYTES: usize = 1024 \* 1024/);
  assert.doesNotMatch(rust, /STANDARD\.encode|base64::/);
});
