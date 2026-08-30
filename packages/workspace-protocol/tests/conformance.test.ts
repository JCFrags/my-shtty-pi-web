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
  parseWorkspaceBind, validWorkspaceBindFixture, validWorkspaceFrameHeaderFixture,
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

describe("workspace.v1 conformance", () => {
  it("accepts strict bounded bind, commands, snapshots, and frames", () => {
    assert.equal(Check(WorkspaceBindSchema, validWorkspaceBindFixture), true);
    assert.deepEqual(parseWorkspaceBind(validWorkspaceBindFixture), validWorkspaceBindFixture);
    assert.equal(Check(WorkspaceClientCommandSchema, { protocolVersion: "workspace.v1", kind: "snapshot.get", requestId: "request:snapshot" }), true);
    assert.equal(Check(WorkspaceSnapshotSchema, validWorkspaceSnapshotFixture), true);
    assert.equal(Check(WorkspaceFrameHeaderSchema, validWorkspaceFrameHeaderFixture), true);
  });

  it("rejects invalid, secret-bearing, arbitrary, and unbounded records", () => {
    for (const fixture of invalidWorkspaceFixtures) {
      const accepted = Check(WorkspaceBindSchema, fixture.value) || Check(WorkspaceClientCommandSchema, fixture.value) || Check(WorkspaceSnapshotSchema, fixture.value);
      assert.equal(accepted, false, fixture.name);
    }
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
    const one = encodeWorkspaceRecord({ protocolVersion: "workspace.v1", kind: "status", status: { connection: "ready", browserd: "ready" } });
    const two = encodeWorkspaceRecord({ protocolVersion: "workspace.v1", kind: "status", status: { connection: "closed", browserd: "unavailable" } });
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
