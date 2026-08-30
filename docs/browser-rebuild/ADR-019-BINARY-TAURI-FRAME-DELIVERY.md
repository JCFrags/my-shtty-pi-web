# ADR-019: Binary Tauri frame delivery

## Status

Accepted for Phase 3A.

## Decision

`workspace.v1` uses one bounded record format between webxd and Tauri Rust: a big-endian unsigned 32-bit JSON-header length, a big-endian unsigned 32-bit payload length, the UTF-8 JSON header, and optional raw payload bytes. Headers and incomplete buffers are bounded; payloads are limited to 4 MiB. The parser supports fragmentation and multiple records per read and rejects malformed, overflowing, or truncated records.

Tauri Rust validates selection identity, runtime identity, sequence, generations, media type, length, digest, and dimensions. It delivers the encoded frame to the frontend through a Tauri channel as an `ArrayBuffer`. Screenshot bytes are never base64 and never a JSON array of numbers. Global Tauri events are not used for frames.

Rust retains at most one in-flight and one pending frame. The frontend retains only the displayed frame and latest replacement, permits one live `ImageBitmap`, closes it after drawing, and rejects frames after selection, runtime, document, viewport, sequence, digest, length, or decoded-dimension changes. Selection evidence is emitted only after any prior frontend frame settles, which makes the switch barrier measurable and prevents a former-selection paint after that barrier.

## Evidence

The binary IPC probe delivers 100 distinct synthetic 1 MiB payloads with exact order and digest. The graphical route and 1,811.605-second soak report:

- frontend byte type: `ArrayBuffer`;
- base64 frame bytes: 0;
- maximum Rust-retained frames: 2;
- maximum frontend-retained frames: 1;
- maximum concurrent frontend `ImageBitmap` objects: 1;
- `ImageBitmap` objects after settlement: 0;
- stale former-selection paints: 0;
- cross-agent paints: 0;
- non-monotonic paints: 0.

## Consequences

Slow consumers receive the latest useful frame rather than an unbounded history. Snapshot and status records remain non-droppable. Frame records can be coalesced or dropped. A switch may wait for one previously delivered frontend frame to settle before its acceptance barrier, but no old paint can cross that barrier.

## Rejected alternatives

Base64 increases size and copies. JSON byte arrays are much larger and expensive to parse. Global events do not provide the required bounded binary stream. Frontend network access would violate the trusted workspace boundary.
