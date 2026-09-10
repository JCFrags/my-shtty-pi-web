const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const {
  bindStartupPane,
  createStartupAttempt,
  readStartupFailure,
  removeStartupAttempt,
  startupEnvironment,
  waitForSpawnedDaemon,
  waitForStartup,
  writeStartupFailure,
} = require("../dist/startup");

test("startup channel is exclusive, bounded and attempt correlated", (t) => {
  const startup = createStartupAttempt();
  t.after(() => removeStartupAttempt(startup));
  const environment = { ...startupEnvironment(startup), HERDR_PANE_ID: "w1:p8" };
  const report = writeStartupFailure(Object.assign(new Error("original ownership refusal"), { code: "EOWNER" }), {}, environment);
  assert.deepEqual(readStartupFailure(startup), report);
  assert.equal(report.attempt, startup.attempt);
  assert.equal(report.code, "EOWNER");
  assert.equal(report.message, "original ownership refusal");
  assert.equal(report.pane, "w1:p8");
  assert.equal(report.exitCode, 1);
  assert.equal(report.signal, null);
  assert.equal(report.doctorCommand, "terminal-browser doctor --json");
  assert.equal(report.cleanup.status, "not-attempted");
  assert.equal(fs.statSync(startup.file).mode & 0o077, 0);
  assert.equal(fs.statSync(`${startup.file}.failure`).mode & 0o077, 0);
  assert.equal(writeStartupFailure(new Error("replacement"), {}, environment), null);
  assert.equal(readStartupFailure(startup).message, "original ownership refusal");
});

test("startup channel rejects symlinked and oversized files before reading", (t) => {
  const linked = createStartupAttempt();
  const oversized = createStartupAttempt();
  const target = `${linked.file}.target`;
  t.after(() => {
    removeStartupAttempt(linked);
    removeStartupAttempt(oversized);
    try { fs.unlinkSync(target); } catch {}
  });
  fs.writeFileSync(target, "{}", { mode: 0o600 });
  fs.symlinkSync(target, `${linked.file}.failure`);
  assert.equal(readStartupFailure(linked), null);
  assert.equal(writeStartupFailure(new Error("must not follow"), {}, startupEnvironment(linked)), null);
  fs.writeFileSync(oversized.file, "x".repeat(17 * 1024), { mode: 0o600 });
  assert.equal(writeStartupFailure(new Error("must not read"), {}, startupEnvironment(oversized)), null);
});

test("concurrent startup channels do not cross attempts and bound original messages", (t) => {
  const startup = createStartupAttempt();
  const concurrent = createStartupAttempt();
  t.after(() => { removeStartupAttempt(startup); removeStartupAttempt(concurrent); });
  assert.notEqual(startup.attempt, concurrent.attempt);
  writeStartupFailure(new Error("concurrent"), {}, startupEnvironment(concurrent));
  assert.equal(readStartupFailure(startup), null);
  assert.equal(readStartupFailure(concurrent).message, "concurrent");
  assert.equal(writeStartupFailure(new Error("wrong"), {}, {
    TERMINAL_BROWSER_STARTUP_ATTEMPT: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  }), null);
  const report = writeStartupFailure(new Error("x".repeat(20_000)), {}, startupEnvironment(startup));
  assert(report.message.length <= 8192);
  assert(fs.statSync(startup.file).size < 16 * 1024);
});

test("owner and pane correlation reject crossed reports", (t) => {
  const owner = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", sessionId: "s", projectDir: "/tmp" };
  const crossedOwner = createStartupAttempt(owner);
  const crossedPane = createStartupAttempt();
  t.after(() => { removeStartupAttempt(crossedOwner); removeStartupAttempt(crossedPane); });
  assert.equal(writeStartupFailure(new Error("wrong owner"), {}, {
    ...startupEnvironment(crossedOwner),
    TERMINAL_BROWSER_OWNER_WORKSPACE_ID: "w1",
    TERMINAL_BROWSER_OWNER_TAB_ID: "w1:t1",
    TERMINAL_BROWSER_OWNER_PANE_ID: "w1:p2",
  }), null);
  writeStartupFailure(new Error("wrong pane"), { pane: "w1:p9" }, startupEnvironment(crossedPane));
  const rejected = readStartupFailure(crossedPane, "w1:p8");
  assert.equal(rejected.code, "STARTUP_CORRELATION_FAILED");
  assert.equal(rejected.pane, "w1:p8");
  assert.doesNotMatch(rejected.message, /wrong pane/);
  const bound = createStartupAttempt();
  t.after(() => removeStartupAttempt(bound));
  bindStartupPane(bound, "w1:p8");
  assert.equal(writeStartupFailure(new Error("crossed"), { pane: "w1:p9" }, startupEnvironment(bound)), null);
  assert.equal(writeStartupFailure(new Error("bound"), { pane: "w1:p8" }, startupEnvironment(bound)).pane, "w1:p8");
});

test("startup supervisor reports a clean child exit before readiness", (t) => {
  const startup = createStartupAttempt();
  t.after(() => removeStartupAttempt(startup));
  execFileSync(process.execPath, [require.resolve("../dist/main"), "supervise-startup", "--", "--version"], {
    env: { ...process.env, ...startupEnvironment(startup) },
  });
  const report = readStartupFailure(startup);
  assert.equal(report.code, "BROWSER_EXIT_0");
  assert.equal(report.exitCode, 0);
});

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    wait: async (milliseconds) => { time += milliseconds; },
  };
}

function startupReport(error) {
  assert.equal(error.name, "StartupFailure");
  return error.report;
}

test("startup timeout retains the pane without a cleanup query", async (t) => {
  const startup = createStartupAttempt();
  t.after(() => removeStartupAttempt(startup));
  const clock = fakeClock();
  let cleanupQueries = 0;
  await assert.rejects(waitForStartup({
    startup,
    pane: "w1:p4",
    timeoutMs: 100,
    timeoutMessage: "deterministic timeout",
    findReady: async () => null,
    paneStatus: async () => { cleanupQueries += 1; return "absent"; },
    ...clock,
  }), (error) => {
    const report = startupReport(error);
    assert.equal(report.code, "BROWSER_START_TIMEOUT");
    assert.equal(report.cleanup.status, "retained");
    assert.match(report.cleanup.nextStep, /complete late/);
    return true;
  });
  assert.equal(cleanupQueries, 0);
});

test("failed startup observes exact pane exit and retains a present repurposed pane", async (t) => {
  const exited = createStartupAttempt();
  const retained = createStartupAttempt();
  t.after(() => { removeStartupAttempt(exited); removeStartupAttempt(retained); });
  bindStartupPane(exited, "w1:p5");
  bindStartupPane(retained, "w1:p6");
  writeStartupFailure(new Error("exited child"), { pane: "w1:p5" }, startupEnvironment(exited));
  writeStartupFailure(new Error("failed child"), { pane: "w1:p6" }, startupEnvironment(retained));
  const exitedClock = fakeClock();
  let exitedQueries = 0;
  await assert.rejects(waitForStartup({
    startup: exited,
    pane: "w1:p5",
    timeoutMs: 100,
    timeoutMessage: "unused",
    findReady: async () => null,
    paneStatus: async () => ++exitedQueries === 1 ? "present" : "absent",
    ...exitedClock,
  }), (error) => startupReport(error).cleanup.status === "exited");
  assert.equal(exitedQueries, 2);
  const retainedClock = fakeClock();
  let retainedQueries = 0;
  await assert.rejects(waitForStartup({
    startup: retained,
    pane: "w1:p6",
    timeoutMs: 100,
    timeoutMessage: "unused",
    findReady: async () => null,
    paneStatus: async () => { retainedQueries += 1; return "present"; },
    cleanupWaitMs: 100,
    ...retainedClock,
  }), (error) => {
    const report = startupReport(error);
    assert.equal(report.message, "failed child");
    assert.equal(report.cleanup.status, "retained");
    assert.match(report.cleanup.nextStep, /w1:p6/);
    return true;
  });
  assert.equal(retainedQueries, 2);
});

test("cleanup query failure preserves startup failure and reports cleanup failure", async (t) => {
  const startup = createStartupAttempt();
  t.after(() => removeStartupAttempt(startup));
  bindStartupPane(startup, "w1:p7");
  writeStartupFailure(new Error("original startup failure"), { pane: "w1:p7" }, startupEnvironment(startup));
  await assert.rejects(waitForStartup({
    startup,
    pane: "w1:p7",
    timeoutMs: 100,
    timeoutMessage: "unused",
    findReady: async () => null,
    paneStatus: async () => { throw new Error("Herdr status unavailable"); },
  }), (error) => {
    const report = startupReport(error);
    assert.equal(report.message, "original startup failure");
    assert.equal(report.cleanup.status, "failed");
    assert.equal(report.cleanup.error, "Herdr status unavailable");
    return true;
  });
});

test("late readiness does not alter a completed timeout", async (t) => {
  const startup = createStartupAttempt();
  t.after(() => removeStartupAttempt(startup));
  const clock = fakeClock();
  let ready = false;
  let checks = 0;
  let captured;
  await assert.rejects(waitForStartup({
    startup,
    pane: "w1:p8",
    timeoutMs: 100,
    timeoutMessage: "late readiness timeout",
    findReady: async () => { checks += 1; return ready ? { pane: "w1:p8" } : null; },
    ...clock,
  }), (error) => {
    captured = startupReport(error);
    return true;
  });
  const checksAtTimeout = checks;
  ready = true;
  await clock.wait(500);
  assert.equal(checks, checksAtTimeout);
  assert.equal(captured.cleanup.status, "retained");
  assert.equal(captured.code, "BROWSER_START_TIMEOUT");
});

test("concurrent readiness selects only each exact startup attempt", async (t) => {
  const first = createStartupAttempt();
  const second = createStartupAttempt();
  t.after(() => { removeStartupAttempt(first); removeStartupAttempt(second); });
  const records = [
    { startupAttempt: second.attempt, pane: "w1:p10" },
    { startupAttempt: first.attempt, pane: "w1:p9" },
  ];
  const findReady = async (attempt) => records.find((record) => record.startupAttempt === attempt) ?? null;
  const [firstReady, secondReady] = await Promise.all([
    waitForStartup({ startup: first, pane: "w1:p9", timeoutMs: 100, timeoutMessage: "unused", findReady }),
    waitForStartup({ startup: second, pane: "w1:p10", timeoutMs: 100, timeoutMessage: "unused", findReady }),
  ]);
  assert.equal(firstReady.pane, "w1:p9");
  assert.equal(secondReady.pane, "w1:p10");
});

test("spawn failure is returned before the daemon startup timeout", async () => {
  const spawnError = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
  let time = 0;
  let connects = 0;
  await assert.rejects(waitForSpawnedDaemon({
    connect: async () => { connects += 1; throw new Error("ENOENT"); },
    failure: () => spawnError,
    timeoutMs: 15_000,
    now: () => time,
    wait: async (milliseconds) => { time += milliseconds; },
  }), (error) => error === spawnError);
  assert.equal(connects, 1);
  assert.equal(time, 0);
});

test("pane binding cannot overwrite an already published child failure", (t) => {
  const startup = createStartupAttempt();
  t.after(() => removeStartupAttempt(startup));
  const report = writeStartupFailure(new Error("child won race"), { pane: "w1:p11" }, startupEnvironment(startup));
  bindStartupPane(startup, "w1:p11");
  assert.deepEqual(readStartupFailure(startup, "w1:p11"), report);
  assert.equal(writeStartupFailure(new Error("replacement"), { pane: "w1:p11" }, startupEnvironment(startup)), null);
});

test("companion launcher spawn refusal preserves its error without inventing a failed pane", () => {
  let failure;
  try {
    execFileSync(process.execPath, [require.resolve("../dist/main"), "companion", "open", "--no-focus"], {
      env: { ...process.env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "startup-test", HERDR_TAB_ID: "startup-test:t1", HERDR_PANE_ID: "startup-test:p1", HERDR_BIN_PATH: "/nonexistent-startup-test/herdr" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) { failure = error; }
  assert(failure);
  const report = JSON.parse(failure.stderr.toString().replace(/^terminal-browser:\s*/, "").trim());
  assert.equal(report.code, "ENOENT");
  assert.match(report.message, /ENOENT/);
  assert.equal(report.pane, null);
  assert.equal(report.cleanup.status, "not-attempted");
});

test("child exit and signal details remain structured", (t) => {
  const exited = createStartupAttempt();
  const signaled = createStartupAttempt();
  t.after(() => { removeStartupAttempt(exited); removeStartupAttempt(signaled); });
  const exitError = Object.assign(new Error("daemon exited early"), { code: "DAEMON_EXIT_7", exitCode: 7 });
  assert.equal(writeStartupFailure(exitError, {}, startupEnvironment(exited)).exitCode, 7);
  const signalError = Object.assign(new Error("daemon interrupted"), { signal: "SIGTERM", exitCode: null });
  const report = writeStartupFailure(signalError, {}, startupEnvironment(signaled));
  assert.equal(report.exitCode, null);
  assert.equal(report.signal, "SIGTERM");
});
