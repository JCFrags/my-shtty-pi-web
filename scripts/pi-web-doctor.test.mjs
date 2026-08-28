import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { doctorReport, documentAssetReadiness, probeWebx, profileDoctorChecks, runDoctor } from "./pi-web-doctor.mjs";

async function fixture(catalog) {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-doctor-"));
  const socketPath = join(directory, "webxd.sock");
  const server = createServer((socket) => {
    if (catalog === undefined) {
      socket.resume();
      return;
    }
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (request.bind) socket.write(`${JSON.stringify({ bindingId: "binding", bindingSecret: "secret" })}\n`);
        else socket.write(`${JSON.stringify({ status: 200, headers: {}, body: catalog })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function runCli(scriptPath, env) {
  const child = spawn(process.execPath, [scriptPath, "--json"], { env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr };
}

test("doctor CLI runs once through direct and stable symlink paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-doctor-cli-"));
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const direct = fileURLToPath(new URL("./pi-web-doctor.mjs", import.meta.url));
  const stable = join(directory, "pi-web-tools");
  await symlink(projectRoot, stable, "dir");
  try {
    for (const scriptPath of [direct, join(stable, "scripts/pi-web-doctor.mjs")]) {
      const result = await runCli(scriptPath, { WEBXD_SOCKET: join(directory, "missing.sock") });
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.ok, false);
      assert.equal(report.checks.length, 1);
      assert.equal(report.checks[0]?.name, "webxd");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor keeps optional browser failure nonfatal", async () => {
  const catalog = {
    apiVersion: "2.0.0",
    capabilities: [
      { id: "search", enabled: true, healthy: true },
      { id: "read", enabled: true, healthy: true },
      { id: "browser", enabled: true, healthy: false, reason: "browser daemon is unavailable" },
    ],
    browserPaths: [],
  };
  const service = await fixture(catalog);
  try {
    assert.deepEqual(await probeWebx(service.socketPath), catalog);
    const report = await runDoctor(service.socketPath);
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks.find((item) => item.name === "browser"), {
      name: "browser", required: false, ok: false, detail: "browser daemon is unavailable",
    });
  } finally {
    await service.close();
  }
});

test("doctor makes search or static reader failure fatal", () => {
  for (const failed of ["search", "read"]) {
    const report = doctorReport({
      apiVersion: "2.0.0",
      capabilities: ["search", "read", "browser"].map((id) => ({ id, enabled: true, healthy: id !== failed })),
      browserPaths: [],
    });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((item) => item.name === failed)?.required, true);
  }
});

test("doctor checks the installed profile and reviewed core limits", () => {
  const profile = {
    schemaVersion: 1,
    resolvedProfiles: ["web-core", "browser"],
    resourceLimits: {
      "pi-web-reader.service": { MemoryMax: "2G", TasksMax: 512 },
      "pi-web-searxng.service": { MemoryMax: "2G", TasksMax: 512 },
    },
  };
  const checks = profileDoctorChecks(profile);
  assert.equal(checks.find((item) => item.name === "installed-profile")?.ok, true);
  assert.equal(checks.find((item) => item.name === "core-resource-limits")?.ok, true);
  const report = doctorReport({
    apiVersion: "2.0.0",
    capabilities: [
      { id: "search", enabled: true, healthy: true },
      { id: "read", enabled: true, healthy: true },
      { id: "browser", enabled: true, healthy: false },
    ],
  }, profile);
  assert.equal(report.checks.find((item) => item.name === "browser")?.required, true);
  assert.equal(report.ok, false);
});

test("doctor reports bounded documents and refuses unvalidated model claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-assets-"));
  try {
    const bytes = Buffer.from("reviewed model bytes");
    await writeFile(join(directory, "model.bin"), bytes);
    await writeFile(join(directory, "model-assets.json"), JSON.stringify({ schemaVersion: 1, capabilities: ["office"], files: [{ path: "model.bin", sha256: "0".repeat(64) }] }));
    assert.equal(documentAssetReadiness(directory).office, false);
    await writeFile(join(directory, "model-assets.json"), JSON.stringify({ schemaVersion: 1, assetSetId: "unvalidated-local-set", capabilities: ["office"], files: [{ path: "model.bin", sha256: "1".repeat(64) }] }));
    assert.deepEqual(documentAssetReadiness(directory), { manifestValidated: false, office: false, scannedPdf: false, detail: "model asset set has no validated acceptance record in this release" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const checks = profileDoctorChecks({ schemaVersion: 1, resolvedProfiles: ["web-core", "documents"], resourceLimits: {
    "pi-web-reader.service": { MemoryMax: "2G", TasksMax: 512 },
    "pi-web-searxng.service": { MemoryMax: "2G", TasksMax: 512 },
    "pi-web-docling.service": { MemoryMax: "4G", TasksMax: 128, Concurrency: 1, QueueSize: 2, TimeoutSeconds: 120, MaxInputBytes: 268435456, MaxTempBytes: 536870912, MaxOutputBytes: 16777216 },
  } });
  assert.equal(checks.find((item) => item.name === "document-resource-limits")?.ok, true);
  assert.equal(checks.find((item) => item.name === "office-model-assets")?.required, false);
});

test("doctor reports an unavailable authority as fatal", async () => {
  const report = await runDoctor(join(tmpdir(), `missing-webxd-${process.pid}.sock`));
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks[0]?.name, "webxd");
});

test("doctor times out when an authority accepts but never responds", async () => {
  const service = await fixture(undefined);
  try {
    const report = await runDoctor(service.socketPath, 25);
    assert.equal(report.ok, false);
    assert.equal(report.checks[0]?.detail, "WebX doctor probe timed out after 25 ms");
  } finally {
    await service.close();
  }
});
