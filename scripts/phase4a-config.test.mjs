import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_INSTALLED_CONFIG,
  parseInstalledConfig,
  redactedEffectiveConfig,
  renderUnitTemplate,
  serializeEnvironmentFile,
  serviceEnvironment,
} from "./phase4a-config.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const configRoot = `${root}/deploy/phase4a/config`;
const unitRoot = `${root}/deploy/phase4a/systemd`;

/** @param {(value: any) => void} [mutator] */
function candidate(mutator = () => {}) {
  const value = structuredClone(DEFAULT_INSTALLED_CONFIG);
  mutator(value);
  return value;
}

test("the installed default is exact, closed, and remains legacy", async () => {
  const onDisk = JSON.parse(await readFile(`${configRoot}/default.json`, "utf8"));
  assert.deepEqual(onDisk, DEFAULT_INSTALLED_CONFIG);
  const parsed = parseInstalledConfig(onDisk);
  assert.equal(parsed.backend, "legacy");
  assert.equal(parsed.release.pointer, "current");
  assert.equal(parsed.workspace.executable, "release");
  assert.equal(parsed.resources.maxBrowserSessions, 2, "installed capacity must stay within the qualified two-session evidence");
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.resources));
});

test("unknown fields and unbounded or inconsistent values fail closed", () => {
  /** @type {Array<(value: any) => void>} */
  const mutations = [
    (value) => { value.shellCommand = "echo no"; },
    (value) => { value.browser.flags = ["--no-sandbox"]; },
    (value) => { value.browser.executable = "/tmp/chrome"; },
    (value) => { value.proxy.host = "0.0.0.0"; },
    (value) => { value.browser.screenshotObservationTtlMs = 9_999; },
    (value) => { value.browser.frames.burstIntervalMs = 600; value.browser.frames.selectedIntervalMs = 500; },
    (value) => { value.resources.perSessionSoftPssMiB = value.resources.perSessionHardPssMiB; },
    (value) => { value.resources.globalChromePssMiB = 2_000; },
    (value) => { value.resources.profileSoftMiB = value.resources.profileHardMiB; },
    (value) => { value.services.stopTimeoutSec = 121; },
    (value) => { value.workspace.executable = "/tmp/workspace"; },
  ];
  for (const mutate of mutations) assert.throws(() => parseInstalledConfig(candidate(mutate)));
});

test("service environment contains only reviewed fixed choices and no secrets", () => {
  const parsed = parseInstalledConfig(candidate((value) => {
    value.backend = "agentcursor";
    value.browser.product = "chromium";
    value.proxy.port = 19_001;
    value.workspace.diagnosticMode = true;
  }));
  const values = serviceEnvironment(parsed, { releaseRoot: "/home/test/.local/share/pi-web/current", runtimeRoot: "/run/user/1000" });
  assert.equal(values.WEBX_BROWSER_BACKEND, "agentcursor");
  assert.equal(values.BROWSERD_CHROME_BIN, "/usr/bin/chromium-browser");
  assert.equal(values.WEBX_EGRESS_PROXY, "http://127.0.0.1:19001/");
  assert.equal(values.BROWSERD_EGRESS_PROXY, "http://127.0.0.1:19001/");
  assert.equal(values.PI_WEB_EGRESS_HOST, "127.0.0.1");
  assert.equal(values.PI_WEB_EGRESS_PORT, "19001");
  assert.equal(values.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(values.BROWSERD_PROFILE_ROOT, "/run/user/1000/pi-web-agentcursor/profiles");
  assert.equal(values.PI_WEB_WORKSPACE_BIN, "/home/test/.local/share/pi-web/current/bin/pi-browser-workspace");
  assert.equal(values.PI_WEB_DIAGNOSTIC_MODE, "1");
  const serialized = serializeEnvironmentFile(values);
  assert.doesNotMatch(serialized, /secret|token|descriptor|human|input\.batch/iu);
  assert.doesNotMatch(serialized, /node_modules|Projects\/|--no-sandbox|--disable-web-security/u);
  assert.match(serialized, /^WEBX_BROWSER_BACKEND="agentcursor"$/mu);
  assert.deepEqual(redactedEffectiveConfig(parsed).retainedSecrets, false);
});

test("candidate unit templates are fixed, independent, and render without source paths", async () => {
  const names = ["pi-web-agentcursor-egress-proxy.service", "pi-web-agentcursor-browserd.service", "webxd.service"];
  const rendered = new Map();
  for (const name of names) {
    const template = await readFile(`${unitRoot}/${name}.in`, "utf8");
    const unit = renderUnitTemplate(template, {
      currentRelease: "/home/test/.local/share/pi-web/current",
      configHome: "/home/test/.config",
      cacheHome: "/home/test/.cache",
      stateHome: "/home/test/.local/state",
      startTimeoutSec: 30,
      stopTimeoutSec: 30,
    });
    rendered.set(name, unit);
    assert.doesNotMatch(unit, /@[A-Z][A-Z0-9_]*@|node_modules|tsx|ts-node|vite|cargo\/target|Projects\//u);
    assert.doesNotMatch(unit, /(?:^|\n)ExecStart=.*(?:\/bin\/(?:ba)?sh|sh -c)/u);
    assert.match(unit, /Restart=on-failure/u);
    assert.match(unit, /UMask=0077/u);
    assert.match(unit, /TimeoutStartSec=30s/u);
    assert.match(unit, /TimeoutStopSec=30s/u);
  }
  assert.match(rendered.get("pi-web-agentcursor-egress-proxy.service"), /ProtectHome=read-only/u);
  assert.doesNotMatch(rendered.get("pi-web-agentcursor-egress-proxy.service"), /ProtectHome=yes/u);
  assert.match(rendered.get("pi-web-agentcursor-browserd.service"), /Wants=pi-web-agentcursor-egress-proxy\.service/u);
  assert.doesNotMatch(rendered.get("pi-web-agentcursor-browserd.service"), /Requires=/u);
  assert.match(rendered.get("webxd.service"), /Wants=pi-web-reader\.service pi-web-searxng\.service pi-web-agentcursor-browserd\.service/u);
  assert.doesNotMatch(rendered.get("webxd.service"), /Requires=/u);
  assert.match(rendered.get("webxd.service"), /ExecStart=\/usr\/bin\/node \/home\/test\/\.local\/share\/pi-web\/current\/bin\/pi-web-webxd\.mjs/u);
  assert.equal(names.some((name) => /workspace/u.test(name)), false, "Tauri must remain on-demand");
});

test("the declarative schema also closes every configuration object", async () => {
  const schema = JSON.parse(await readFile(`${configRoot}/config.schema.json`, "utf8"));
  assert.equal(schema.additionalProperties, false);
  for (const key of ["release", "browser", "proxy", "resources", "workspace", "services"]) assert.equal(schema.properties[key].additionalProperties, false);
  assert.equal(schema.properties.browser.properties.frames.additionalProperties, false);
  assert.deepEqual(schema.properties.backend.enum, ["legacy", "agentcursor"]);
  assert.equal(schema.properties.workspace.properties.executable.const, "release");
});
