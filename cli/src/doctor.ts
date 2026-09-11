import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_DIR_NAME, DAEMON_SOCKET, INSTALLATION, RUNTIME_IDENTITY, processStart, runtimeMatches } from "pixel-store";
import { daemonRequest } from "./daemon-status";
import { profileOwnership, socketEvidence } from "./profile-ownership";

const hex = (value: unknown, length: number) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value) ? value : null;
const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
const receiptFilename = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;
const processIdentity = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[0-9]+$/;
function boundedJson(file: string, limit = 16384): any {
  const observed = fs.lstatSync(file);
  if (!observed.isFile() || observed.isSymbolicLink()) throw new Error("invalid metadata");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw new Error("invalid metadata");
    const buffer = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    while (length <= limit) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const after = fs.fstatSync(fd);
    if (length > limit || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("invalid metadata");
    return JSON.parse(buffer.toString("utf8", 0, length));
  } finally {
    fs.closeSync(fd);
  }
}
function identity(value: any) {
  const build = hex(value?.build, 64);
  const instanceId = identifier(value?.instanceId);
  if (!value || value.protocol !== 2 || !build || !Number.isSafeInteger(value.pid) || value.pid < 1 || !instanceId) throw new Error("unknown runtime identity");
  return { artifactId: hex(value.artifactId, 64), sourceRevision: hex(value.sourceRevision, 40), build, protocol: 2, pid: value.pid, processStart: identifier(value.processStart), instanceId };
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
type PiReceiptEvidence = {
  file: string;
  state: "live" | "history" | "invalid" | "unreadable" | "incomplete";
  reason?: string;
  identity?: ReturnType<typeof identity>;
  receiptId?: string | null;
  createdAt?: string | null;
  sequence?: number | null;
  matchesSelected?: boolean;
};

function receiptMetadata(value: any, file: string) {
  const receiptId = identifier(value?.receipt?.id);
  const createdAt = typeof value?.receipt?.createdAt === "string" && Number.isFinite(Date.parse(value.receipt.createdAt)) ? value.receipt.createdAt : null;
  const sequence = Number.isSafeInteger(value?.receipt?.sequence) && value.receipt.sequence > 0 ? value.receipt.sequence : null;
  const expectedId = file.slice(0, -5);
  if (receiptId !== null && receiptId !== expectedId) throw new Error("receipt identity does not match filename");
  return { receiptId, createdAt, sequence };
}

function orderedReload(entries: PiReceiptEvidence[]) {
  if (entries.length === 1) return entries[0];
  if (entries.some((entry) => entry.receiptId === null || entry.sequence === null || entry.createdAt === null)) return null;
  const highest = Math.max(...entries.map((entry) => entry.sequence!));
  const newest = entries.filter((entry) => entry.sequence === highest);
  return newest.length === 1 ? newest[0] : null;
}

export function inspectPiReceipts(
  directory: string,
  selectedArtifactId: string | null,
  readProcessStart: (pid: number) => string | null = processStart,
  processExists: (pid: number) => boolean = (pid) => {
    try { fs.lstatSync(`/proc/${pid}`); return true; }
    catch (error) { return (error as NodeJS.ErrnoException)?.code !== "ENOENT"; }
  },
) {
  const evidence: PiReceiptEvidence[] = [];
  const starts = new Map<number, string | null>();
  let complete = true;
  let directoryReason: string | undefined;
  let handle: fs.Dir | undefined;
  try {
    handle = fs.opendirSync(directory);
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      const file = entry.name;
      if (!receiptFilename.test(file)) {
        evidence.push({ file, state: "invalid", reason: "invalid-filename" });
        continue;
      }
      try {
        const value = boundedJson(path.join(directory, file));
        if (!value || typeof value !== "object" || !value.identity) {
          evidence.push({ file, state: "incomplete", reason: "missing-identity" });
          continue;
        }
        const captured = identity(value.identity);
        if (captured.processStart === null || !processIdentity.test(captured.processStart)) {
          evidence.push({ file, state: "incomplete", reason: "missing-process-identity" });
          continue;
        }
        const metadata = receiptMetadata(value, file);
        if (!starts.has(captured.pid)) starts.set(captured.pid, readProcessStart(captured.pid));
        evidence.push({ file, state: "history", identity: captured, ...metadata, matchesSelected: captured.artifactId !== null && captured.artifactId === selectedArtifactId });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const unreadable = code === "EACCES" || code === "EPERM";
        const incomplete = code === "ENOENT" || code === "ESTALE";
        evidence.push({ file, state: unreadable ? "unreadable" : incomplete ? "incomplete" : "invalid", reason: unreadable ? "read-denied" : incomplete ? "changed-during-scan" : "invalid-receipt" });
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      complete = false;
      directoryReason = code === "EACCES" || code === "EPERM" ? "directory-unreadable" : "enumeration-failed";
    }
  } finally {
    try { handle?.closeSync(); } catch { complete = false; directoryReason ??= "enumeration-failed"; }
  }

  const ends = new Map<number, string | null>();
  const exists = new Map<number, boolean>();
  for (const pid of starts.keys()) {
    ends.set(pid, readProcessStart(pid));
    exists.set(pid, processExists(pid));
  }
  const stable = new Map<string, PiReceiptEvidence[]>();
  for (const entry of evidence) {
    if (!entry.identity) continue;
    const start = starts.get(entry.identity.pid) ?? null;
    const end = ends.get(entry.identity.pid) ?? null;
    if (start === null || end === null) {
      if (exists.get(entry.identity.pid)) {
        entry.state = "incomplete";
        entry.reason = "process-identity-unavailable";
      } else {
        entry.reason = "process-exited";
      }
    } else if (start !== entry.identity.processStart) {
      entry.reason = "process-not-current";
    } else if (end !== start) {
      entry.reason = "process-identity-changed";
    } else {
      const key = `${entry.identity.pid}:${entry.identity.processStart}`;
      const group = stable.get(key) ?? [];
      group.push(entry);
      stable.set(key, group);
    }
  }
  for (const entries of stable.values()) {
    const newest = orderedReload(entries);
    for (const entry of entries) {
      if (!newest) {
        entry.state = "incomplete";
        entry.reason = "ambiguous-reload-order";
      } else if (entry === newest) {
        entry.state = "live";
      } else {
        entry.reason = "superseded-reload";
      }
    }
  }
  evidence.sort((left, right) => left.file.localeCompare(right.file));
  const counts = { live: 0, history: 0, invalid: 0, unreadable: 0, incomplete: 0 };
  for (const entry of evidence) counts[entry.state] += 1;
  if (counts.invalid > 0 || counts.unreadable > 0 || counts.incomplete > 0) complete = false;
  return { state: complete ? "complete" : "incomplete", complete, ...(directoryReason ? { reason: directoryReason } : {}), total: evidence.length, counts, evidence };
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
  const socket = socketEvidence(DAEMON_SOCKET);
  let daemon: any = { state: "unknown", socket, remedy: "Use daemon-status. Unknown or legacy processes require explicit inspection; do not delete sockets or kill a guessed PID." };
  try {
    const status = safeDaemonStatus(await daemonRequest({ cmd: "status" }));
    const start = processStart(status.identity.pid);
    daemon = { state: start && start === status.identity.processStart ? "running" : "unverified", matchesCandidate: runtimeMatches(status.identity), ...status };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    daemon.reason = "No verified daemon status reply was received; socket state alone does not establish profile ownership.";
    daemon.probeCode = typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "INVALID_OR_INCOMPLETE_STATUS";
  }
  const stateHome = INSTALLATION?.paths.stateHome ?? process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state");
  const receipts = path.join(stateHome, APP_DIR_NAME, "pi-loaded");
  const receiptScan = inspectPiReceipts(receipts, selected.pi.artifactId ?? null);
  const loadedPi = receiptScan.evidence.filter((entry) => entry.identity).map((entry) => ({
    identity: entry.identity,
    state: entry.state === "live" ? "loaded" : "unverified",
    matchesSelected: entry.matchesSelected,
    receipt: { file: entry.file, id: entry.receiptId ?? null, createdAt: entry.createdAt ?? null, sequence: entry.sequence ?? null },
    evidenceState: entry.state,
    ...(entry.reason ? { reason: entry.reason } : {}),
  }));
  return {
    schemaVersion: 1,
    sourceRevision: RUNTIME_IDENTITY.sourceRevision,
    candidate: { artifactId: RUNTIME_IDENTITY.artifactId, installed: INSTALLATION ? true : null, candidates },
    selectedNextLaunch: selected,
    daemon,
    profileOwnership: INSTALLATION
      ? profileOwnership(path.join(INSTALLATION.paths.appData, APP_DIR_NAME))
      : { state: "unverifiable", reason: "No active installation receipt; profile path was not inferred from shell defaults." },
    pi: { loaded: loadedPi, state: loadedPi.length ? "receipts-found" : "unknown", receipts: receiptScan, remedy: "Use an exact versioned package source at the same settings index. Only reload an idle Pi session with an empty draft after approval." },
    herdrOwnership: "unknown; persisted plugin registration does not prove the running Herdr registration",
    graphics: { state: "unknown", reason: process.stdout.isTTY ? "visible terminal rendering has not been verified" : "non-TTY invocation; internal Chromium frames are not visible rendering evidence" },
    dependencies: { bundledRuntime: Boolean(dist && fs.existsSync(path.join(dist, "build-manifest.json"))), systemLibraries: "unknown; not executed", piCompatibility: "requires Pi >=0.84.2 <0.86.0; host availability unknown", herdrCompatibility: "requires separate registration verification" },
    automaticRepair: false,
  };
}
