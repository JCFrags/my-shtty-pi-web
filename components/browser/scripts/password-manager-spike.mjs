#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AgentBrowserRunner,
  cdpCall,
  deepFind,
  findString,
  resetDirectory,
  startFixtureServer,
} from "./lib/agent-browser.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = new Set(process.argv.slice(2));
const requireReal = args.has("--require-real") || process.env.PI_WEB_REQUIRE_PASSWORD_MANAGER === "1";
const runHeaded = args.has("--headed") || process.env.PI_WEB_SPIKE_HEADED === "1";
const namespace = process.env.AGENT_BROWSER_NAMESPACE || `pi-web-extension-spike-${process.pid}`;
const dataRoot = resolve(process.env.PI_WEB_SPIKE_ROOT || join(tmpdir(), `pi-web-extension-spike-${process.pid}`));
const profile = resolve(process.env.PI_WEB_SPIKE_PROFILE || join(dataRoot, "profile"));
const downloadPath = join(dataRoot, "downloads");
const fixtureExtension = resolve(process.env.PI_WEB_FIXTURE_EXTENSION || join(root, "fixtures/browser-extension"));
const realExtension = process.env.PI_WEB_PASSWORD_MANAGER_EXTENSION ? resolve(process.env.PI_WEB_PASSWORD_MANAGER_EXTENSION) : undefined;
const reportPath = resolve(process.env.PI_WEB_SPIKE_REPORT || join(dataRoot, "report.json"));
const report = {
  generatedAt: new Date().toISOString(),
  namespace,
  profile,
  fixtureExtension,
  realPasswordManager: realExtension || null,
  headless: {},
  restart: {},
  headed: { skipped: !runHeaded },
  passwordManager: { skipped: !realExtension },
  ok: false,
};

await access(fixtureExtension, constants.R_OK);
await resetDirectory(dataRoot);
await mkdir(profile, { recursive: true });
await mkdir(downloadPath, { recursive: true });
const fixture = await startFixtureServer(root);

try {
  report.headless = await runFixtureMode({
    session: `fixture-headless-${process.pid}`,
    headed: false,
    url: `${fixture.baseUrl}/auth`,
  });

  report.restart = await verifyProfileRestart(`${fixture.baseUrl}/auth`);

  if (runHeaded) {
    report.headed = await runFixtureMode({
      session: `fixture-headed-${process.pid}`,
      headed: true,
      url: `${fixture.baseUrl}/auth`,
    });
  }

  if (realExtension) {
    report.passwordManager = await runRealPasswordManager();
  } else if (requireReal) {
    throw new Error("PI_WEB_PASSWORD_MANAGER_EXTENSION is required for the real password-manager gate");
  }

  report.ok = Boolean(
    report.headless.extensionLoaded &&
    report.headless.shortcutWorked &&
    report.headless.stream?.port &&
    report.headless.extensionTargets > 0 &&
    report.restart.profileStatePersisted &&
    (!runHeaded || report.headed.extensionLoaded) &&
    (!realExtension || report.passwordManager.ok),
  );
} catch (error) {
  report.error = serializeError(error);
  process.exitCode = 1;
} finally {
  await fixture.stop();
  await mkdir(resolve(reportPath, ".."), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  if (!report.ok && process.exitCode === undefined) process.exitCode = 1;
}

async function runFixtureMode({ session, headed, url }) {
  const runner = new AgentBrowserRunner({
    namespace,
    session,
    engine: "chrome",
    profile,
    extensions: [fixtureExtension],
    downloadPath,
    headed,
  });
  try {
    const open = runner.run(["open", url]);
    runner.run(["wait", "750"]);
    const marker = runner.run(["eval", "document.documentElement.dataset.piWebFixtureExtension"]);
    runner.run(["press", "Control+Shift+l"]);
    runner.run(["wait", "250"]);
    const shortcut = runner.run(["eval", "({value: document.querySelector('input[autocomplete=username]')?.value, marker: document.documentElement.dataset.piWebFixtureShortcut})"]);
    runner.run(["eval", "localStorage.setItem('piWebProfileSpike','persisted'); document.cookie='piWebProfileCookie=persisted; path=/'; true"]);
    const stream = runner.run(["stream", "status"]);
    const cdp = runner.run(["get", "cdp-url"]);
    const webSocketUrl = findString(cdp.json, (value) => value.startsWith("ws://") || value.startsWith("wss://"));
    const targets = webSocketUrl ? await cdpCall(webSocketUrl, "Target.getTargets") : { targetInfos: [] };
    const extensionTargets = (targets.targetInfos || []).filter((target) => String(target.url || "").startsWith("chrome-extension://"));
    return {
      headed,
      openMs: open.elapsedMs,
      extensionLoaded: findString(marker.json, (value) => value === "loaded") === "loaded",
      shortcutWorked: findString(shortcut.json, (value) => value === "pi") === "pi",
      shortcutMarker: findString(shortcut.json, (value) => value === "invoked") === "invoked",
      stream: {
        port: deepFind(stream.json, (value, key) => key === "port" && Number.isInteger(value)),
        connected: deepFind(stream.json, (value, key) => key === "connected" && typeof value === "boolean"),
        screencasting: deepFind(stream.json, (value, key) => key === "screencasting" && typeof value === "boolean"),
      },
      cdpWebSocket: Boolean(webSocketUrl),
      extensionTargets: extensionTargets.length,
      extensionTargetTypes: [...new Set(extensionTargets.map((target) => target.type))],
    };
  } finally {
    runner.close();
  }
}

async function verifyProfileRestart(url) {
  const runner = new AgentBrowserRunner({
    namespace,
    session: `fixture-restart-${process.pid}`,
    engine: "chrome",
    profile,
    extensions: [fixtureExtension],
    downloadPath,
  });
  try {
    runner.run(["open", url]);
    runner.run(["wait", "500"]);
    const state = runner.run(["eval", "({local: localStorage.getItem('piWebProfileSpike'), cookie: document.cookie})"]);
    return {
      profileStatePersisted:
        findString(state.json, (value) => value === "persisted") === "persisted" ||
        Boolean(findString(state.json, (value) => value.includes("piWebProfileCookie=persisted"))),
      state: state.value,
    };
  } finally {
    runner.close();
  }
}

async function runRealPasswordManager() {
  await access(realExtension, constants.R_OK);
  const url = process.env.PI_WEB_PASSWORD_MANAGER_URL || `${fixture.baseUrl}/auth`;
  const shortcut = process.env.PI_WEB_PASSWORD_MANAGER_SHORTCUT || "Control+Shift+l";
  const assertion = process.env.PI_WEB_PASSWORD_MANAGER_ASSERT_JS || "Boolean(document.querySelector('input[autocomplete=username]')?.value || document.querySelector('input[autocomplete=current-password]')?.value)";
  const runner = new AgentBrowserRunner({
    namespace,
    session: `password-manager-${process.pid}`,
    engine: "chrome",
    profile: resolve(process.env.PI_WEB_PASSWORD_MANAGER_PROFILE || join(dataRoot, "password-manager-profile")),
    extensions: [realExtension],
    downloadPath,
  });
  try {
    runner.run(["open", url]);
    runner.run(["wait", String(Number(process.env.PI_WEB_PASSWORD_MANAGER_SETTLE_MS || 2_000))]);
    const cdp = runner.run(["get", "cdp-url"]);
    const webSocketUrl = findString(cdp.json, (value) => value.startsWith("ws://") || value.startsWith("wss://"));
    const targetsBefore = webSocketUrl ? await cdpCall(webSocketUrl, "Target.getTargets") : { targetInfos: [] };
    runner.run(["press", shortcut]);
    await sleep(Number(process.env.PI_WEB_PASSWORD_MANAGER_AUTOFILL_MS || 1_000));
    const asserted = runner.run(["eval", assertion]);
    const extensionTargets = (targetsBefore.targetInfos || []).filter((target) => String(target.url || "").startsWith("chrome-extension://"));
    return {
      ok: extensionTargets.length > 0 && Boolean(deepFind(asserted.value, (value) => value === true)),
      shortcut,
      assertion,
      extensionTargets: extensionTargets.length,
      targetTypes: [...new Set(extensionTargets.map((target) => target.type))],
      assertionResult: asserted.value,
    };
  } finally {
    runner.close();
  }
}

function serializeError(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  return { message: error.message, stack: error.stack, command: error.record };
}
