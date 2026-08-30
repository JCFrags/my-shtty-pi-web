import { WorkspaceProtocolError } from "./errors.js";
import { MAX_WORKSPACE_HEADER_BYTES, MAX_WORKSPACE_PAYLOAD_BYTES, MAX_WORKSPACE_RECORD_BYTES } from "./schema.js";
import type { WorkspaceWireRecord } from "./types.js";

const PREFIX_BYTES = 8;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function encodeWorkspaceRecord(header: unknown, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  assertLengths(headerBytes.byteLength, payload.byteLength);
  const output = new Uint8Array(PREFIX_BYTES + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint32(0, headerBytes.byteLength, false);
  view.setUint32(4, payload.byteLength, false);
  output.set(headerBytes, PREFIX_BYTES);
  output.set(payload, PREFIX_BYTES + headerBytes.byteLength);
  return output;
}

export class WorkspaceRecordDecoder {
  #buffer = new Uint8Array();
  push(chunk: Uint8Array): WorkspaceWireRecord<unknown>[] {
    if (chunk.byteLength === 0) return [];
    if (this.#buffer.byteLength + chunk.byteLength > MAX_WORKSPACE_RECORD_BYTES) throw new WorkspaceProtocolError("LIMIT_EXCEEDED", "Workspace incomplete record exceeds its bound.");
    const combined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    combined.set(this.#buffer); combined.set(chunk, this.#buffer.byteLength); this.#buffer = combined;
    const records: WorkspaceWireRecord<unknown>[] = [];
    let offset = 0;
    while (this.#buffer.byteLength - offset >= PREFIX_BYTES) {
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + offset, this.#buffer.byteLength - offset);
      const headerLength = view.getUint32(0, false);
      const payloadLength = view.getUint32(4, false);
      assertLengths(headerLength, payloadLength);
      const recordLength = PREFIX_BYTES + headerLength + payloadLength;
      if (this.#buffer.byteLength - offset < recordLength) break;
      const headerStart = offset + PREFIX_BYTES;
      let header: unknown;
      try { header = JSON.parse(textDecoder.decode(this.#buffer.subarray(headerStart, headerStart + headerLength))); }
      catch { throw new WorkspaceProtocolError("INVALID_REQUEST", "Workspace record header is not valid UTF-8 JSON."); }
      const payload = this.#buffer.slice(headerStart + headerLength, headerStart + headerLength + payloadLength);
      records.push({ header, payload });
      offset += recordLength;
    }
    this.#buffer = offset === 0 ? this.#buffer : this.#buffer.slice(offset);
    return records;
  }
  finish(): void {
    if (this.#buffer.byteLength !== 0) throw new WorkspaceProtocolError("INVALID_REQUEST", "Workspace record is truncated.");
  }
  get incompleteBytes(): number { return this.#buffer.byteLength; }
}

function assertLengths(headerLength: number, payloadLength: number): void {
  if (!Number.isSafeInteger(headerLength) || headerLength < 2 || headerLength > MAX_WORKSPACE_HEADER_BYTES) throw new WorkspaceProtocolError("LIMIT_EXCEEDED", "Workspace header length is invalid.");
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 0 || payloadLength > MAX_WORKSPACE_PAYLOAD_BYTES) throw new WorkspaceProtocolError("LIMIT_EXCEEDED", "Workspace payload length is invalid.");
  if (PREFIX_BYTES + headerLength + payloadLength > MAX_WORKSPACE_RECORD_BYTES) throw new WorkspaceProtocolError("LIMIT_EXCEEDED", "Workspace record length is invalid.");
}
