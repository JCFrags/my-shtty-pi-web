import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeFrameEnvelope, verifyFrameDigest, type FrameMetadata } from "../src/bridge";

function makeEnvelope(payload: Uint8Array): ArrayBuffer {
  const metadata: FrameMetadata = {
    deliveryId: 1,
    selectionId: "selection_AAAAAA",
    subscriptionId: "subscription_AAA",
    browserdRuntimeInstanceId: "runtime_AAAAAAAA",
    browserSessionId: "session:one",
    tabId: "tab:one",
    frameSequence: 8,
    documentGeneration: 3,
    viewportGeneration: 4,
    capturedAt: "2026-08-30T00:00:00.000Z",
    publishedAt: "2026-08-30T00:00:00.001Z",
    receivedAt: "2026-08-30T00:00:00.002Z",
    mediaType: "image/png",
    byteLength: payload.byteLength,
    sha256: createHash("sha256").update(payload).digest("hex"),
    width: 10,
    height: 10,
  };
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  const output = new Uint8Array(4 + header.byteLength + payload.byteLength);
  new DataView(output.buffer).setUint32(0, header.byteLength, false);
  output.set(header, 4);
  output.set(payload, 4 + header.byteLength);
  return output.buffer;
}

describe("frontend binary envelope", () => {
  it("returns an exact raw Uint8Array instead of base64 or a JSON number array", async () => {
    const payload = Uint8Array.from({ length: 512 }, (_, index) => index % 251);
    const decoded = decodeFrameEnvelope(makeEnvelope(payload));
    expect(decoded.bytes).toBeInstanceOf(Uint8Array);
    expect([...decoded.bytes]).toEqual([...payload]);
    expect(await verifyFrameDigest(decoded)).toBe(true);
  });

  it("rejects malformed bounds and detects payload corruption", async () => {
    expect(() => decodeFrameEnvelope(new ArrayBuffer(5))).toThrow(/length/i);
    const value = makeEnvelope(Uint8Array.of(1, 2, 3, 4));
    const decoded = decodeFrameEnvelope(value);
    decoded.bytes[0] ^= 0xff;
    expect(await verifyFrameDigest(decoded)).toBe(false);
    new DataView(value).setUint32(0, 64 * 1024, false);
    expect(() => decodeFrameEnvelope(value)).toThrow(/metadata length/i);
  });
});
