import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { installedBrowserdOptions } from "../src/installed-config.js";

const runtime = "/run/user/1000";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    XDG_RUNTIME_DIR: runtime,
    BROWSERD_EGRESS_PROXY: "http://127.0.0.1:8877/",
    BROWSERD_RUNTIME_DIR: `${runtime}/pi-browserd`,
    BROWSERD_PROFILE_ROOT: `${runtime}/pi-web-agentcursor/profiles`,
    ...overrides,
  };
}

describe("installed browserd configuration", () => {
  it("uses bounded defaults and private runtime-owned paths", () => {
    const options = installedBrowserdOptions(environment());
    assert.equal(options.runtimeDirectory, `${runtime}/pi-browserd`);
    assert.equal(options.chrome?.profileRoot, `${runtime}/pi-web-agentcursor/profiles`);
    assert.deepEqual(options.chrome?.egressProxy, { host: "127.0.0.1", port: 8877 });
    assert.deepEqual(options.frameScheduler, { idleIntervalMs: 2_000, selectedIntervalMs: 500, burstIntervalMs: 100 });
    assert.equal(options.maxSessionsGlobal, 16);
    assert.deepEqual(options.resourceLimits, {
      perSessionSoftPssBytes: 1024 * 1024 * 1024,
      perSessionHardPssBytes: 1280 * 1024 * 1024,
      globalChromePssBytes: 4096 * 1024 * 1024,
      profileSoftBytes: 512 * 1024 * 1024,
      profileHardBytes: 1024 * 1024 * 1024,
      samplingIntervalMs: 5_000,
      drainTimeoutMs: 30_000,
      emergencyTimeoutMs: 15_000,
    });
  });

  it("accepts only the fixed reviewed browser products", () => {
    assert.equal(installedBrowserdOptions(environment({ BROWSERD_CHROME_BIN: "/usr/bin/chromium-browser" })).chrome?.executable, "/usr/bin/chromium-browser");
    for (const executable of ["/tmp/chrome", "/bin/sh", "chromium", "/usr/bin/chromium-browser --no-sandbox"]) {
      assert.throws(() => installedBrowserdOptions(environment({ BROWSERD_CHROME_BIN: executable })), /reviewed Chrome or Chromium/u);
    }
  });

  it("rejects escaped runtime paths, proxy credentials, gaps, and unbounded values", () => {
    for (const overrides of [
      { BROWSERD_RUNTIME_DIR: "/tmp/browserd" },
      { BROWSERD_PROFILE_ROOT: `${runtime}/../1001/profiles` },
      { BROWSERD_EGRESS_PROXY: "http://user:secret@127.0.0.1:8877/" },
      { BROWSERD_EGRESS_PROXY: "http://0.0.0.0:8877/" },
      { BROWSERD_SCREENSHOT_OBSERVATION_TTL_MS: "9999" },
      { BROWSERD_MAX_SESSIONS_GLOBAL: "17" },
      { BROWSERD_FRAME_IDLE_INTERVAL_MS: "500", BROWSERD_FRAME_SELECTED_INTERVAL_MS: "600" },
      { BROWSERD_FRAME_SELECTED_INTERVAL_MS: "100", BROWSERD_FRAME_BURST_INTERVAL_MS: "101" },
      { PI_WEB_RESOURCE_PER_SESSION_SOFT_PSS_MIB: "1280", PI_WEB_RESOURCE_PER_SESSION_HARD_PSS_MIB: "1280" },
      { PI_WEB_RESOURCE_GLOBAL_CHROME_PSS_MIB: "1024", PI_WEB_RESOURCE_PER_SESSION_HARD_PSS_MIB: "1280" },
      { PI_WEB_RESOURCE_PROFILE_SOFT_MIB: "1024", PI_WEB_RESOURCE_PROFILE_HARD_MIB: "1024" },
      { PI_WEB_RESOURCE_DRAIN_TIMEOUT_MS: "1000", PI_WEB_RESOURCE_EMERGENCY_TIMEOUT_MS: "1001" },
      { PI_WEB_RESOURCE_SAMPLING_INTERVAL_MS: "999" },
      { PI_WEB_RESOURCE_UNREVIEWED_LIMIT: "1" },
    ]) assert.throws(() => installedBrowserdOptions(environment(overrides)));
  });
});
