import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileHash, inventory, objectHash, readJson, requiredFiles, writeJson } from "../dist-manifest.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pins = readJson(path.join(root, "upstreams.lock.json"));
export function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser artifact "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of requiredFiles("linux-x64")) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), file);
  }
  for (const file of ["bin/terminal-browser", "electron/electron", "agent-browser/bin/agent-browser"]) fs.chmodSync(path.join(dir, file), 0o755);
  fs.writeFileSync(path.join(dir, "VERSION"), "test-dirty-123\n");
  fs.writeFileSync(path.join(dir, "CHANNEL"), "dev\n");
  writeJson(path.join(dir, "metadata/upstreams.lock.json"), pins);
  const pi = readJson(path.join(root, "pi-extension/package.json"));
  writeJson(path.join(dir, "pi-extension/package.json"), pi);
  fs.writeFileSync(path.join(dir, "herdr-plugin/herdr-plugin.toml"), fs.readFileSync(path.join(root, "herdr-plugin/herdr-plugin.toml"), "utf8").replace(/\[\[build\]\][\s\S]*?(?=\[\[)/g, ""));
  const identity = {
    version: "test-dirty-123", channel: "dev", platform: "linux-x64",
    source: { commit: "a".repeat(40), dirty: true, treeSha256: "b".repeat(64) },
    locks: Object.fromEntries(Object.entries({ pnpm: "pnpm-lock.yaml", cargo: "Cargo.lock", upstreams: "upstreams.lock.json", agentBrowserCargo: "agent-browser-Cargo.lock" }).map(([name, file]) => [name, fileHash(path.join(dir, "metadata", file))])),
    runtimes: { electron: { version: pins.electron.version, archiveSha256: pins.electron.archives["linux-x64"] }, agentcursor: { version: "0.3.0", commit: pins.agentcursor.inspectedSha }, agentBrowser: { tag: pins.agentBrowser.tag, commit: pins.agentBrowser.commit } },
    tools: { node: "test", pnpm: "test", rustc: "test", esbuild: "test", host: "test" },
    integrations: { pi: { name: pi.name, version: pi.version, peerDependencies: pi.peerDependencies, node: pi.engines.node }, herdr: { id: "zenbu-labs.terminal-browser", version: "0.2.0", minimumVersion: "0.8.2" } },
  };
  const files = inventory(dir);
  const manifest = { schemaVersion: 1, artifactId: objectHash({ identity, files }), identity, files };
  writeJson(path.join(dir, "build-manifest.json"), manifest);
  return { dir, manifest };
}
