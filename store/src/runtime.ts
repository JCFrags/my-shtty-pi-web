import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RUNTIME_PROTOCOL = 2;

export function processStart(pid: number): string | null {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.length > 8192) return null;
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return /^[0-9]+$/.test(ticks) && /^[a-f0-9-]{36}$/.test(boot) ? `${boot}:${ticks}` : null;
  } catch { return null; }
}

export function artifactIdentity(root: string) {
  const main = path.join(root, "browser/dist/main.js");
  let build: string | null = null;
  const metadataOnly = process.argv[2] === "doctor";
  if (!metadataOnly) { try { build = createHash("sha256").update(fs.readFileSync(main)).digest("hex"); } catch {} }
  let artifactId: string | null = null;
  let sourceRevision: string | null = null;
  try {
    const file = path.join(root, "build-manifest.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("invalid manifest");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const expectedBuild = manifest.files?.find((entry: { path: string }) => entry.path === "browser/dist/main.js")?.sha256;
    if (metadataOnly && /^[a-f0-9]{64}$/.test(expectedBuild)) build = expectedBuild;
    if (!/^[a-f0-9]{64}$/.test(manifest.artifactId) || !/^[a-f0-9]{40}$/.test(manifest.identity?.source?.commit) || manifest.files?.find((entry: { path: string }) => entry.path === "browser/dist/main.js")?.sha256 !== build) throw new Error("artifact identity mismatch");
    artifactId = manifest.artifactId;
    sourceRevision = manifest.identity.source.commit;
  } catch {}
  return { artifactId, sourceRevision, build, protocol: RUNTIME_PROTOCOL };
}

export const RUNTIME_IDENTITY = Object.freeze({
  ...artifactIdentity(process.env.TERMINAL_BROWSER_DIST_ROOT ?? path.resolve(__dirname, "../..")),
  pid: process.pid,
  processStart: processStart(process.pid),
  instanceId: randomUUID(),
});

export function runtimeMatches(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const identity = value as typeof RUNTIME_IDENTITY;
  return Boolean(RUNTIME_IDENTITY.build) && (!process.env.TERMINAL_BROWSER_DIST_ROOT || RUNTIME_IDENTITY.artifactId !== null) && identity.protocol === RUNTIME_PROTOCOL && identity.build === RUNTIME_IDENTITY.build && identity.artifactId === RUNTIME_IDENTITY.artifactId;
}
