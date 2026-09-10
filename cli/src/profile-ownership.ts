import fs from "node:fs";
import path from "node:path";

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN";
}

export function socketEvidence(socket: string) {
  try {
    const stat = fs.lstatSync(socket);
    return { path: socket, state: stat.isSocket() ? "present" : "wrong-file-type", device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 };
  } catch (error) {
    const code = errorCode(error);
    return { path: socket, state: code === "ENOENT" ? "missing" : "unverifiable", code };
  }
}

export function profileOwnership(profile: string, procRoot = "/proc") {
  const lock = path.join(profile, "terminal-browser.lock");
  const remedy = "Inspect the receipt-defined profile and recorded process before explicit recovery. A missing PID alone does not authorize lock removal.";
  let fd: number | undefined;
  let observed = false;
  try {
    const before = fs.lstatSync(lock);
    observed = true;
    const metadata = { path: lock, device: before.dev, inode: before.ino, uid: before.uid, mode: before.mode & 0o777, size: before.size };
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > 64) {
      return { state: "unverifiable", reason: "unsafe-lock-metadata", lock: metadata, remedy };
    }
    fd = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.ctimeMs !== before.ctimeMs) {
      return { state: "unverifiable", reason: "lock-changed", lock: metadata, remedy };
    }
    const bytes = Buffer.alloc(65);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.lstatSync(lock);
    const held = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || held.ctimeMs !== opened.ctimeMs || after.ctimeMs !== opened.ctimeMs || count !== opened.size) {
      return { state: "unverifiable", reason: "lock-changed", lock: metadata, remedy };
    }
    const text = bytes.subarray(0, count).toString("utf8");
    const pid = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(pid) || pid > 2147483647) return { state: "unverifiable", reason: "invalid-pid-record", lock: metadata, remedy };
    let ownerProcess: { state: string; code?: string };
    try {
      fs.statSync(path.join(procRoot, String(pid)));
      ownerProcess = { state: "present-unverified" };
    } catch (error) {
      const code = errorCode(error);
      ownerProcess = { state: code === "ENOENT" ? "missing" : "unverifiable", code };
    }
    return { state: "occupied", lock: metadata, recordedPid: pid, recordFormat: "pid-only", processIdentity: "not-recorded; PID reuse and boot identity cannot be resolved from this lock", ownerProcess, remedy };
  } catch (error) {
    const code = errorCode(error);
    return { state: code === "ENOENT" && !observed ? "not-observed" : "unverifiable", reason: code, lock: { path: lock }, remedy };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
