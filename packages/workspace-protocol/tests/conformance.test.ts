import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { Check } from "typebox/value";
import {
  WorkspaceBindSchema, WorkspaceClientCommandSchema, WorkspaceFrameHeaderSchema,
  WorkspaceProtocolError, WorkspaceProtocolSchemaDocument, WorkspaceRecordDecoder,
  WorkspaceSnapshotSchema, encodeWorkspaceRecord, invalidWorkspaceFixtures,
  parseWorkspaceBind, parseWorkspaceClientCommand, validWorkspaceBindFixture, validWorkspaceFrameHeaderFixture,
  validWorkspaceSnapshotFixture,
} from "../src/index.js";

const splitEveryBoundary = (bytes: Uint8Array): void => {
  for (let split = 1; split < bytes.byteLength; split++) {
    const decoder = new WorkspaceRecordDecoder();
    const first = decoder.push(bytes.subarray(0, split));
    const second = decoder.push(bytes.subarray(split));
    assert.equal(first.length + second.length, 1, `split ${split}`);
    decoder.finish();
  }
};

describe("workspace.v2 conformance", () => {
  it("accepts strict bounded bind, commands, snapshots, and frames", () => {
    assert.equal(Check(WorkspaceBindSchema, validWorkspaceBindFixture), true);
    assert.deepEqual(parseWorkspaceBind(validWorkspaceBindFixture), validWorkspaceBindFixture);
    assert.equal(Check(WorkspaceClientCommandSchema, { protocolVersion: "workspace.v2", kind: "snapshot.get", requestId: "request:snapshot" }), true);
    assert.equal(Check(WorkspaceSnapshotSchema, validWorkspaceSnapshotFixture), true);
    assert.equal(Check(WorkspaceSnapshotSchema, {
      ...validWorkspaceSnapshotFixture,
      sessions: [{ ...validWorkspaceSnapshotFixture.sessions[0], leaseId: "lease_control_0001" }],
    }), false);
    assert.equal(Check(WorkspaceFrameHeaderSchema, validWorkspaceFrameHeaderFixture), true);
  });

  it("rejects invalid, secret-bearing, arbitrary, and unbounded records", () => {
    for (const fixture of invalidWorkspaceFixtures) {
      const accepted = Check(WorkspaceBindSchema, fixture.value) || Check(WorkspaceClientCommandSchema, fixture.value) || Check(WorkspaceSnapshotSchema, fixture.value);
      assert.equal(accepted, false, fixture.name);
    }
  });

  it("accepts strict control and input commands without a raw lease", () => {
    const frame = {
      selectionId: validWorkspaceFrameHeaderFixture.selectionId,
      browserdRuntimeInstanceId: validWorkspaceFrameHeaderFixture.browserdRuntimeInstanceId,
      browserSessionId: validWorkspaceFrameHeaderFixture.browserSessionId,
      tabId: validWorkspaceFrameHeaderFixture.tabId,
      subscriptionId: validWorkspaceFrameHeaderFixture.subscriptionId,
      controlEpoch: validWorkspaceFrameHeaderFixture.controlEpoch,
      frameSequence: validWorkspaceFrameHeaderFixture.frameSequence,
      documentGeneration: validWorkspaceFrameHeaderFixture.documentGeneration,
      viewportGeneration: validWorkspaceFrameHeaderFixture.viewportGeneration,
      imagePixelWidth: validWorkspaceFrameHeaderFixture.imagePixelWidth,
      imagePixelHeight: validWorkspaceFrameHeaderFixture.imagePixelHeight,
      cssViewportWidth: validWorkspaceFrameHeaderFixture.cssViewportWidth,
      cssViewportHeight: validWorkspaceFrameHeaderFixture.cssViewportHeight,
      devicePixelRatio: validWorkspaceFrameHeaderFixture.devicePixelRatio,
      paintedAt: "2026-08-30T12:00:00.020Z",
    } as const;
    const acquire = {
      protocolVersion: "workspace.v2", kind: "control.acquire", requestId: "request:acquire",
      browserSessionId: frame.browserSessionId, tabId: frame.tabId, expectedControlEpoch: 4, frame,
    } as const;
    const input = {
      protocolVersion: "workspace.v2", kind: "input.batch", requestId: "request:input",
      browserSessionId: frame.browserSessionId, tabId: frame.tabId, controlEpoch: 5,
      inputBatchSequence: 1, inputTargetGeneration: 1, frame: { ...frame, controlEpoch: 5 },
      events: [{ kind: "pointerMove", point: { imageX: 1, imageY: 1 } }, { kind: "text", text: "snowman-☃" }],
    } as const;
    assert.deepEqual(parseWorkspaceClientCommand(acquire), acquire);
    assert.deepEqual(parseWorkspaceClientCommand({
      protocolVersion: "workspace.v2", kind: "control.heartbeat", requestId: "request:heartbeat",
      browserSessionId: frame.browserSessionId, controlEpoch: 5,
    }), {
      protocolVersion: "workspace.v2", kind: "control.heartbeat", requestId: "request:heartbeat",
      browserSessionId: frame.browserSessionId, controlEpoch: 5,
    });
    assert.deepEqual(parseWorkspaceClientCommand(input), input);
    assert.throws(
      () => parseWorkspaceClientCommand(input, 64 * 1024 + 1),
      (error: unknown) => error instanceof WorkspaceProtocolError && error.code === "LIMIT_EXCEEDED",
    );
    assert.equal(Check(WorkspaceClientCommandSchema, { ...acquire, leaseId: "raw_lease_0000001" }), false);
    assert.equal(Check(WorkspaceClientCommandSchema, { ...input, connectionId: "broker_connection" }), false);
    assert.equal(Check(WorkspaceClientCommandSchema, { ...input, events: Array.from({ length: 33 }, () => input.events[0]) }), false);
    assert.throws(
      () => parseWorkspaceClientCommand({ ...input, events: [{ kind: "text", text: "☃".repeat(1_366) }] }),
      (error: unknown) => error instanceof WorkspaceProtocolError && error.code === "LIMIT_EXCEEDED",
    );
  });

  it("round-trips raw binary payloads at every framing boundary", () => {
    const payload = Uint8Array.from({ length: 1024 }, (_, index) => index % 251);
    const header = { ...validWorkspaceFrameHeaderFixture, byteLength: payload.byteLength };
    const bytes = encodeWorkspaceRecord(header, payload);
    splitEveryBoundary(bytes);
    const decoder = new WorkspaceRecordDecoder();
    const records = decoder.push(bytes);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]?.header, header);
    assert.deepEqual(records[0]?.payload, payload);
    assert.equal(Buffer.from(bytes).includes(Buffer.from(payload.toString())), false);
  });

  it("parses multiple records and rejects malformed, oversized, and truncated records", () => {
    const one = encodeWorkspaceRecord({ protocolVersion: "workspace.v2", kind: "status", status: { connection: "ready", browserd: "ready" } });
    const two = encodeWorkspaceRecord({ protocolVersion: "workspace.v2", kind: "status", status: { connection: "closed", browserd: "unavailable" } });
    const joined = new Uint8Array(one.byteLength + two.byteLength); joined.set(one); joined.set(two, one.byteLength);
    assert.equal(new WorkspaceRecordDecoder().push(joined).length, 2);
    const malformed = new Uint8Array(8); new DataView(malformed.buffer).setUint32(0, 65_537, false);
    assert.throws(() => new WorkspaceRecordDecoder().push(malformed), WorkspaceProtocolError);
    const truncated = new WorkspaceRecordDecoder(); truncated.push(one.subarray(0, one.byteLength - 1));
    assert.throws(() => truncated.finish(), WorkspaceProtocolError);
  });

  it("keeps deterministic checked-in JSON schema output", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const output = await readFile(resolve(here, "../schema/workspace-protocol.schema.json"), "utf8");
    assert.equal(output, `${JSON.stringify(WorkspaceProtocolSchemaDocument, null, 2)}\n`);
  });
});
