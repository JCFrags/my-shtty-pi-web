import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doctorReport, probeWebx, runDoctor } from "./pi-web-doctor.mjs";

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
