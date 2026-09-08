import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_DIR_NAME, DAEMON_SOCKET, INSTALLATION, RUNTIME_IDENTITY, processStart, runtimeMatches } from "pixel-store";
import { daemonRequest } from "./daemon-status";

const hex = (value: unknown, length: number) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value) ? value : null;
const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
function boundedJson(file: string, limit = 16384): any {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("invalid metadata");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function identity(value: any) {
  if (!value || value.protocol !== 2 || !hex(value.build, 64) || !Number.isSafeInteger(value.pid) || value.pid < 1 || !identifier(value.instanceId)) throw new Error("unknown runtime identity");
  return { artifactId: hex(value.artifactId, 64), sourceRevision: hex(value.sourceRevision, 40), build: hex(value.build, 64), protocol: 2, pid: value.pid, processStart: identifier(value.processStart), instanceId: identifier(value.instanceId) };
}
export function safeDaemonStatus(value: any) {
  if (value?.ok !== true || value.complete !== true || !Array.isArray(value.sessions) || value.sessions.length > 256) throw new Error("incomplete daemon status");
  const captured = identity(value.identity);
  const sessions = value.sessions.map((entry: any) => {
    if (!identifier(entry.key)) throw new Error("invalid session identity");
    const owner = entry.owner === null ? null : { workspaceId: identifier(entry.owner?.workspaceId), tabId: identifier(entry.owner?.tabId), paneId: identifier(entry.owner?.paneId) };
    if (owner && Object.values(owner).some((field) => field === null)) throw new Error("invalid owner identity");
    return { key: entry.key, owner, terminal: identifier(entry.terminal), tab: identifier(entry.tab), pane: identifier(entry.pane) };
  });
  return { identity: captured, sessions, complete: true };
}
function selectedArtifact(link: string, suffix: string) {
  try {
    const selected = fs.realpathSync(link);
    if (!selected.endsWith(suffix)) return { state: "unknown", artifactId: null };
    const root = selected.slice(0, -suffix.length);
    const manifest = boundedJson(path.join(root, "build-manifest.json"), 2 * 1024 * 1024);
    return { state: "selected", artifactId: hex(manifest.artifactId, 64) };
  } catch { return { state: "unknown", artifactId: null }; }
}
export async function doctor() {
  const dist = process.env.TERMINAL_BROWSER_DIST_ROOT;
  const installationFile = process.env.TERMINAL_BROWSER_INSTALLATION ?? (dist ? path.resolve(dist, "../../../installation.json") : "");
  let selected: any = { cli: { state: "unknown" }, pi: { state: "unknown" }, herdr: { state: "unknown" } };
  let candidates: string[] = [];
  if (INSTALLATION) {
    try {
      const receipt = boundedJson(installationFile);
      selected.cli = selectedArtifact(receipt.selection.cli, "/bin/terminal-browser");
      const plugins = boundedJson(receipt.selection.herdrRegistry, 1024 * 1024);
      if (Array.isArray(plugins)) {
        const matches = plugins.filter((entry: any) => entry?.plugin_id === "zenbu-labs.terminal-browser");
        if (matches.length === 1 && typeof matches[0].plugin_root === "string" && matches[0].manifest_path === path.join(matches[0].plugin_root, "herdr-plugin.toml")) selected.herdr = { ...selectedArtifact(matches[0].plugin_root, "/herdr-plugin"), enabled: matches[0].enabled === true };
      }
      const settings = boundedJson(receipt.selection.piSettings, 1024 * 1024);
      const packages = settings.packages;
      const releases = path.join(path.dirname(installationFile), "releases");
      if (Array.isArray(packages)) {
        const roots = packages.map((entry: any) => typeof entry === "string" ? entry : entry?.source).filter((source: any) => typeof source === "string" && source.startsWith(`${releases}/`) && source.endsWith("/pi-extension"));
        if (roots.length === 1) selected.pi = selectedArtifact(roots[0], "/pi-extension");
      }
      candidates = fs.readdirSync(releases).filter((entry) => Boolean(hex(entry, 64))).slice(0, 128);
    } catch {}
  }
  let daemon: any = { state: fs.existsSync(DAEMON_SOCKET) ? "unknown-or-stale-socket" : "unknown", remedy: "Use daemon-status. Unknown or legacy processes require explicit inspection; do not delete sockets or kill a guessed PID." };
  try {
    const status = safeDaemonStatus(await daemonRequest({ cmd: "status" }));
    const start = processStart(status.identity.pid);
    daemon = { state: start && start === status.identity.processStart ? "running" : "unverified", matchesCandidate: runtimeMatches(status.identity), ...status };
  } catch {}
  const loadedPi: any[] = [];
  const stateHome = INSTALLATION?.paths.stateHome ?? process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state");
  const receipts = path.join(stateHome, APP_DIR_NAME, "pi-loaded");
  try {
    const names = fs.readdirSync(receipts);
    if (names.length <= 128) for (const name of names) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const receipt = boundedJson(path.join(receipts, name));
        const captured = identity(receipt.identity);
        const start = processStart(captured.pid);
        loadedPi.push({ identity: captured, state: start && start === captured.processStart ? "loaded" : "unverified", matchesSelected: captured.artifactId !== null && captured.artifactId === selected.pi.artifactId });
      } catch {}
    }
  } catch {}
  return {
    schemaVersion: 1,
    sourceRevision: RUNTIME_IDENTITY.sourceRevision,
    candidate: { artifactId: RUNTIME_IDENTITY.artifactId, installed: INSTALLATION ? true : null, candidates },
    selectedNextLaunch: selected,
    daemon,
    pi: { loaded: loadedPi, state: loadedPi.length ? "receipts-found" : "unknown", remedy: "Use an exact versioned package source at the same settings index. Only reload an idle Pi session with an empty draft after approval." },
    herdrOwnership: "unknown; persisted plugin registration does not prove the running Herdr registration",
    graphics: { state: "unknown", reason: process.stdout.isTTY ? "visible terminal rendering has not been verified" : "non-TTY invocation; internal Chromium frames are not visible rendering evidence" },
    dependencies: { bundledRuntime: Boolean(dist && fs.existsSync(path.join(dist, "build-manifest.json"))), systemLibraries: "unknown; not executed", piCompatibility: "requires Pi 0.85.1", herdrCompatibility: "requires separate registration verification" },
    automaticRepair: false,
  };
}
