#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";

const PRIMARY = "agent-browser/chrome";
const FALLBACK = "pinchtab/chrome";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  try { process.stdout.write(`${JSON.stringify({ id: request.id, result: await handle(request) })}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify({ id: request.id, error: { message: error.message } })}\n`); }
}

async function handle(request) {
  if (request.type === "handshake") return {
    ok: true,
    protocol: "pi-web-qualification/1",
    product: {
      protocolMajor: 2,
      supportedPaths: [PRIMARY, FALLBACK],
      pathIdentities: {
        [PRIMARY]: { pathId: PRIMARY, backendVersion: "0.33.1", provider: "chrome" },
        [FALLBACK]: { pathId: FALLBACK, backendVersion: "0.15.1", provider: "chrome" },
      },
    },
  };
  if (request.type === "cleanup") return { ok: true, evidence: { ok: true, remainingHosts: 0, remainingSessions: 0, remainingTabs: 0 } };
  if (request.type !== "case") throw new Error("unsupported request");
  const evidence = {
    pathIdentities: request.requiredPaths,
    publicFixture: true,
    cleanupRequired: false,
  };
  if (request.seededNegativeSelector) evidence.negativeSelector = { selector: request.seededNegativeSelector, dispatched: false, code: "invalid-selector-not-found" };
  if (request.operations.some((operation) => operation.action === "browser.observe" && operation.view === "visual" || operation.action === "workspace.capture") || ["J2"].includes(request.caseId)) {
    await mkdir(request.evidenceDir, { recursive: true });
    const sidecar = {
      pathId: request.requiredPaths[0] || PRIMARY,
      principalId: request.principals[0],
      sessionId: `session-${request.caseId}`,
      tabId: `tab-${request.caseId}`,
      observationId: `observation-${request.caseId}`,
      viewportId: `viewport-${request.caseId}`,
      sequence: 1,
      capturedAt: "2026-01-01T00:00:00.000Z",
      viewport: { width: 800, height: 600, coordinateSpace: "css-viewport" },
      imageGeometry: { width: 1, height: 1, deviceScaleFactor: 1 },
      sha256: createHash("sha256").update(png).digest("hex"),
    };
    await writeFile(join(request.evidenceDir, "public-fixture.png"), png);
    await writeFile(join(request.evidenceDir, "public-fixture.json"), `${JSON.stringify(sidecar)}\n`);
    evidence.visual = { image: "public-fixture.png", sidecar: "public-fixture.json" };
  }
  return { ok: true, executedSteps: request.operations.map((operation) => operation.step), evidence };
}
