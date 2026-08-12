import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, root), "utf8");
}

test("J4 requires active queued and running cancellation with terminal and cleanup proof", async () => {
  const plan = await source("qualification/actual-check.mjs");
  const bridge = await source("qualification/bridge.mjs");
  for (const value of [
    'phase: "queued"', 'phase: "running"', 'pathId: PATHS[0]', 'pathId: PATHS[1]',
    'actionRejectedAsCancelled: true', 'final.data?.state === "cancelled"',
    'remainingProcessesAboveBaseline: 0', 'remainingArtifactFilesAboveBaseline: 0', 'leaseReleasedAndReacquired: true',
    'operation.cancel-queued-pinchtab', 'operation.cancel-queued-visual', 'operationKind: "workspace-input"',
    'queueBoundary: "browserd-host"', 'noInputSideEffect: true', 'noNavigationSideEffect: true',
  ]) assert.ok(`${plan}\n${bridge}`.includes(value), value);
  assert.doesNotMatch(bridge, /controller\.abort\(\);\s*await assertRejects\(\(\) => call\(owner, "web\.search"/u);
});

test("J1 J2 and J5 retain their bound marked frame before close", async () => {
  const plan = await source("qualification/actual-check.mjs");
  const bridge = await source("qualification/bridge.mjs");
  const fixture = await source("../../components/browser/packages/test-fixtures/src/server.mjs");
  for (const caseId of ["J1", "J2", "J5"]) {
    assert.ok(plan.includes(`case=${caseId}&state=`), caseId);
    const caseLine = plan.split("\n").find((line) => line.includes(`id: "${caseId}"`));
    assert.ok(caseLine?.includes("evidence.retain-visual") || caseLine?.includes("retainBoundFrame: true"), caseId);
    const retainIndex = Math.max(caseLine?.indexOf("evidence.retain-visual") ?? -1, caseLine?.indexOf("retainBoundFrame: true") ?? -1);
    assert.ok(retainIndex >= 0 && retainIndex < (caseLine?.lastIndexOf("browser.close") ?? -1), caseId);
  }
  assert.match(bridge, /testedAction: \{ \.\.\.testedAction, visualGuard \}/u);
  assert.match(bridge, /retainedBeforeClose: session\.state !== "closed"/u);
  assert.match(fixture, /PI-WEB-JOURNEY:\$\{caseId\}:\$\{state\}/u);
});
