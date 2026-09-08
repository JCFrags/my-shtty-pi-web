import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function sandbox(program, bindings, extra = {}) {
  const args = ["--unshare-all", "--die-with-parent", "--ro-bind", "/usr", "/usr", "--tmpfs", "/usr/local", "--ro-bind", "/etc", "/etc", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/runtime", "--dir", "/home", "--dir", "/home/smoke", "--ro-bind", process.execPath, "/host-node"];
  for (const [from, to] of bindings) args.push("--ro-bind", fs.realpathSync(from), to);
  args.push("--chdir", "/tmp", "/host-node", "--input-type=module", "-e", "(await import('node:fs')).chmodSync('/tmp/runtime', 0o700);\n" + program);
  const result = spawnSync("bwrap", args, {
    encoding: "utf8", timeout: 300000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: "/home/smoke", XDG_DATA_HOME: "/home/smoke/data", XDG_STATE_HOME: "/home/smoke/state", XDG_CACHE_HOME: "/home/smoke/cache", XDG_CONFIG_HOME: "/home/smoke/config", XDG_RUNTIME_DIR: "/tmp/runtime", TERMINAL_BROWSER_APPDATA: "/home/smoke/appdata", TERMINAL_BROWSER_INTEROP_DIR: "/home/smoke/interop", PI_CODING_AGENT_DIR: "/home/smoke/pi", PI_OFFLINE: "1", TERMINAL_BROWSER_SHM: "0", PI_WEB_SEARCH_READ_EXTENSION: "/absent", ...extra },
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.status, 0, "isolated packaged check failed");
}

export const repository = path.resolve(import.meta.dirname, "../..");
