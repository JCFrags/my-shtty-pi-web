import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { BrowserProtocolError, type ActorIdentity } from "@webx/browser-protocol";
import { OperationRegistry } from "../src/operations/registry.js";
import {
  BrowserResourceSupervisor,
  MIB,
  ProcfsBrowserResourceSampler,
  parseProcessStat,
  parseSmapsRollup,
  profileTreeBytes,
  type BrowserResourceLimits,
  type BrowserResourceSample,
  type BrowserResourceSampler,
  type BrowserResourceSessionHooks,
  type BrowserResourceStatus,
} from "../src/resources/supervisor.js";

const supervisors: BrowserResourceSupervisor[] = [];
afterEach(async () => { await Promise.all(supervisors.splice(0).map(async (supervisor) => await supervisor.close())); });

function limits(overrides: Partial<BrowserResourceLimits> = {}): BrowserResourceLimits {
  return {
    perSessionSoftPssBytes: 1024 * MIB,
    perSessionHardPssBytes: 1280 * MIB,
    globalChromePssBytes: 4096 * MIB,
    profileSoftBytes: 512 * MIB,
    profileHardBytes: 1024 * MIB,
    samplingIntervalMs: 5_000,
    drainTimeoutMs: 1_000,
    emergencyTimeoutMs: 1_000,
    ...overrides,
  };
}

class FakeSampler implements BrowserResourceSampler {
  readonly samples = new Map<number, BrowserResourceSample | Error>();
  async sample(identity: { pid: number }): Promise<BrowserResourceSample> {
    const value = this.samples.get(identity.pid);
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error("missing sample");
    return value;
  }
}

interface HookHarness {
  readonly hooks: BrowserResourceSessionHooks;
  readonly statuses: BrowserResourceStatus[];
  readonly calls: string[];
  running: boolean;
  control: ReturnType<BrowserResourceSessionHooks["controlState"]>;
  settlement?: Promise<void>;
  returnFailure?: boolean;
  closeFailures?: number;
  closeGate?: Promise<void>;
}

function hooks(id: string, pid: number, calls: string[] = []): HookHarness {
  const statuses: BrowserResourceStatus[] = [];
  const harness: HookHarness = {
    statuses, calls, running: false, control: "agent",
    hooks: {
      browserSessionId: id,
      processIdentity: { pid, processStartTicks: String(pid * 10) },
      profileDirectory: `/profile/${id}`,
      controlState: () => harness.control,
      hasRunningWork: () => harness.running,
      fence: (reason) => calls.push(`${id}:fence:${reason}`),
      cancelOperations: () => calls.push(`${id}:cancel`),
      awaitOperationSettlement: async (signal) => {
        calls.push(`${id}:settle`);
        signal.throwIfAborted();
        await harness.settlement;
        signal.throwIfAborted();
      },
      returnHumanControl: async (signal) => {
        calls.push(`${id}:return`);
        signal.throwIfAborted();
        if (harness.returnFailure) throw new Error("injected return failure");
        harness.control = "agent";
      },
      close: async (reason) => { calls.push(`${id}:close:${reason}`); if ((harness.closeFailures ?? 0) > 0) { harness.closeFailures = (harness.closeFailures ?? 0) - 1; throw new Error("injected close failure"); } await harness.closeGate; },
      changed: (status) => statuses.push(status),
    },
  };
  return harness;
}

function sample(pssMiB: number, profileMiB = 1): BrowserResourceSample {
  return { pssBytes: pssMiB * MIB, privateDirtyBytes: Math.floor(pssMiB / 2) * MIB, profileBytes: profileMiB * MIB, processCount: 3, rendererCount: 1 };
}

function createSupervisor(sampler: BrowserResourceSampler, value = limits()): BrowserResourceSupervisor {
  const supervisor = new BrowserResourceSupervisor(value, { sampler, autoStart: false });
  supervisors.push(supervisor);
  return supervisor;
}

describe("BrowserResourceSupervisor", () => {
  it("publishes and clears a bounded soft warning without fencing admission", async () => {
    const sampler = new FakeSampler();
    const session = hooks("session:soft", 101);
    sampler.samples.set(101, sample(1100));
    const supervisor = createSupervisor(sampler);
    supervisor.register(session.hooks);
    await supervisor.sampleNow();
    assert.deepEqual(supervisor.status("session:soft"), { state: "warning", reason: "session-memory" });
    assert.doesNotThrow(() => supervisor.assertAdmission("session:soft"));
    sampler.samples.set(101, sample(400));
    await supervisor.sampleNow();
    assert.deepEqual(supervisor.status("session:soft"), { state: "normal", reason: "none" });
    assert.deepEqual(session.calls, []);
  });

  it("atomically fences hard memory admission, cancels work, and closes exactly once", async () => {
    const sampler = new FakeSampler();
    const session = hooks("session:hard", 102);
    const gate = deferred();
    session.running = true;
    session.settlement = gate.promise;
    sampler.samples.set(102, sample(1400));
    const supervisor = createSupervisor(sampler);
    supervisor.register(session.hooks);
    const enforcement = supervisor.sampleNow();
    await until(() => session.calls.includes("session:hard:settle"));
    assert.throws(() => supervisor.assertAdmission("session:hard"), (error) => error instanceof BrowserProtocolError && error.code === "BROWSER_RESOURCE_LIMIT" && error.details?.reason === "session-memory");
    gate.resolve();
    await enforcement;
    await supervisor.sampleNow();
    assert.equal(session.calls.filter((value) => value === "session:hard:close:session-memory").length, 1);
    assert.equal(supervisor.summary().terminalLimitEvents, 1);
  });

  it("uses deterministic global order and avoids a human session when an idle agent session suffices", async () => {
    const sampler = new FakeSampler();
    const calls: string[] = [];
    const human = hooks("session:human", 201, calls); human.control = "human";
    const running = hooks("session:running", 202, calls); running.running = true;
    const idle = hooks("session:idle", 203, calls);
    sampler.samples.set(201, sample(600)); sampler.samples.set(202, sample(600)); sampler.samples.set(203, sample(600));
    const supervisor = createSupervisor(sampler, limits({ globalChromePssBytes: 1500 * MIB }));
    supervisor.register(human.hooks); supervisor.register(running.hooks); supervisor.register(idle.hooks);
    await supervisor.sampleNow();
    assert.equal(calls.find((value) => value.includes(":close:")), "session:idle:close:global-memory");
    assert.equal(calls.some((value) => value.startsWith("session:human:close")), false);
    assert.equal(calls.some((value) => value.startsWith("session:running:close")), false);
  });

  it("enforces profile storage and still closes after human return fails", async () => {
    const sampler = new FakeSampler();
    const session = hooks("session:profile", 301);
    session.control = "human";
    session.returnFailure = true;
    sampler.samples.set(301, sample(400, 1100));
    const supervisor = createSupervisor(sampler);
    supervisor.register(session.hooks);
    await supervisor.sampleNow();
    assert.ok(session.calls.includes("session:profile:return"));
    assert.ok(session.calls.includes("session:profile:close:profile-storage"));
    assert.equal(supervisor.summary().lastTerminalReason, "profile-storage");
  });

  it("retries an exact session close after bounded cleanup fails", async () => {
    const sampler = new FakeSampler();
    const session = hooks("session:retry", 350);
    session.closeFailures = 1;
    sampler.samples.set(350, sample(1400));
    const supervisor = createSupervisor(sampler);
    supervisor.register(session.hooks);
    await supervisor.sampleNow();
    assert.deepEqual(supervisor.status("session:retry"), { state: "resource-limited", reason: "session-memory" });
    await supervisor.sampleNow();
    assert.equal(session.calls.filter((value) => value === "session:retry:close:session-memory").length, 2);
    assert.equal(supervisor.summary().terminalLimitEvents, 1);
  });

  it("does not duplicate an exact close attempt after its bounded wait expires", async () => {
    vi.useFakeTimers();
    try {
      const sampler = new FakeSampler();
      const session = hooks("session:slow-close", 375);
      const gate = deferred();
      session.closeGate = gate.promise;
      sampler.samples.set(375, sample(1400));
      const supervisor = createSupervisor(sampler);
      supervisor.register(session.hooks);
      const first = supervisor.sampleNow();
      await vi.advanceTimersByTimeAsync(1_000);
      await first;
      const retry = supervisor.sampleNow();
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(session.calls.filter((value) => value === "session:slow-close:close:session-memory").length, 1);
      gate.resolve();
      await retry;
      assert.equal(supervisor.summary().terminalLimitEvents, 1);
    } finally { vi.useRealTimers(); }
  });

  it("degrades on sampling failure without signalling or closing a process", async () => {
    const sampler = new FakeSampler();
    const session = hooks("session:sample", 401);
    sampler.samples.set(401, new Error("private sampler detail"));
    const supervisor = createSupervisor(sampler);
    supervisor.register(session.hooks);
    await supervisor.sampleNow();
    assert.deepEqual(supervisor.status("session:sample"), { state: "warning", reason: "sampling-unavailable" });
    assert.deepEqual(session.calls, []);
  });
});

describe("procfs resource accounting", () => {
  it("parses PID start identity after a parenthesized command and parses PSS", () => {
    const record = parseProcessStat(12, statText(12, 1, "987654", "name with ) paren"));
    assert.deepEqual(record, { pid: 12, parentPid: 1, processStartTicks: "987654" });
    assert.deepEqual(parseSmapsRollup("Pss:                123 kB\nPrivate_Dirty:       45 kB\n"), { pssBytes: 123 * 1024, privateDirtyBytes: 45 * 1024 });
  });

  it("accounts only the exact root process tree and never follows profile symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "resource-proc-"));
    const proc = join(root, "proc");
    const profile = join(root, "profile");
    await Promise.all([mkdir(proc), mkdir(profile)]);
    await processFixture(proc, 10, 1, "100", 100, 40, "browser");
    await processFixture(proc, 11, 10, "110", 50, 20, "--type=renderer");
    await processFixture(proc, 99, 1, "990", 9000, 8000, "unrelated");
    await writeFile(join(profile, "owned"), Buffer.alloc(17));
    const external = join(root, "external");
    await writeFile(external, Buffer.alloc(4096));
    await symlink(external, join(profile, "not-owned"));
    const sampler = new ProcfsBrowserResourceSampler({ procRoot: proc, maxProcesses: 10, maxProfileEntries: 10 });
    const result = await sampler.sample({ pid: 10, processStartTicks: "100" }, profile);
    assert.deepEqual(result, { pssBytes: 150 * 1024, privateDirtyBytes: 60 * 1024, profileBytes: 17, processCount: 2, rendererCount: 1 });
    assert.equal(await profileTreeBytes(profile, 10), 17);
    await assert.rejects(() => sampler.sample({ pid: 10, processStartTicks: "reused" }, profile), /identity/i);
  });
});

describe("resource-limit operation settlement", () => {
  it("fails queued and running session operations with the typed resource code", async () => {
    const registry = new OperationRegistry();
    const actor: ActorIdentity = { principalId: "principal:resource", agentSessionId: "agent:resource" };
    const gate = deferred();
    registry.submit(actor, { operationId: "operation:resource", kind: "navigate", laneKey: "motor", deadline: new Date(Date.now() + 10_000).toISOString(), browserSessionId: "session:resource", controlEpoch: 1 }, async (context) => { await gate.promise; context.checkpoint(); });
    await until(() => registry.status(actor, "operation:resource").state === "running");
    registry.limitSession(actor, "session:resource");
    assert.equal(registry.status(actor, "operation:resource").error?.code, "BROWSER_RESOURCE_LIMIT");
    gate.resolve();
    await registry.awaitSessionSettlement(actor, "session:resource");
    assert.equal(registry.status(actor, "operation:resource").state, "failed");
  });
});

async function processFixture(proc: string, pid: number, ppid: number, start: string, pssKiB: number, dirtyKiB: number, command: string): Promise<void> {
  const directory = join(proc, String(pid));
  await mkdir(directory);
  await writeFile(join(directory, "stat"), statText(pid, ppid, start, command));
  await writeFile(join(directory, "smaps_rollup"), `Pss: ${pssKiB} kB\nPrivate_Dirty: ${dirtyKiB} kB\n`);
  await writeFile(join(directory, "cmdline"), `${command}\0`);
}

function statText(pid: number, ppid: number, start: string, command = "chrome"): string {
  return `${pid} (${command}) S ${ppid} ${Array.from({ length: 17 }, () => "0").join(" ")} ${start}\n`;
}

function deferred(): { promise: Promise<undefined>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<undefined>((resolvePromise) => { resolve = () => resolvePromise(undefined); });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 1)); }
  throw new Error("condition did not settle");
}
