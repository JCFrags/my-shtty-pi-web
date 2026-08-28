# Canonical stored-content record

Status: accepted for WP1-M1, WP1-M3, and WP1-M4.

## Decision

A normal direct read stores one canonical normalized source segment before Webxd applies a query or outline selection. The opaque `contentId` identifies that stored segment. `web_content` reads this record without a network request.

Raw views and structured JSON projections are specialized representations. They remain explicit records. A crawl aggregate is also explicit. The `representation` value is one of:

- `canonical-normalized`
- `raw-projection`
- `structured-projection`
- `crawl-aggregate`

A record contains normalized text only. It never contains source response bytes, document base64, credentials, or browser state.

## Record schema

Persistent record version 2 contains these fields:

| Field | Meaning |
| --- | --- |
| `recordVersion` | Persistent schema version. The value is `2`. |
| `contentId` | Random opaque ID with the `cnt_` prefix. |
| `ownerPrincipalId` | Owner scope used for every lookup. |
| `title`, `url` | Public content identity retained for compatibility. |
| `requestedUrl`, `finalUrl` | URL before and after reader redirects. |
| `representation` | Explicit representation class. |
| `sourceOffset` | Offset of this normalized source segment. |
| `sourceComplete` | True only when the reader proves that the source is complete. |
| `nextSourceOffset` | Upstream continuation offset, or null when none is proven. |
| `extractor` | Reader extractor or local source name. |
| `mediaType` | Media type of the normalized representation. |
| `contentSha256` | SHA-256 of the UTF-8 normalized text. |
| `content` | Canonical or explicitly specialized normalized text. |
| `createdAt`, `expiresAt` | Creation and expiry times in Unix milliseconds. |
| `sizeBytes` | UTF-8 byte count used for store bounds. |

Public SDK metadata uses the same provenance names. It exposes creation and expiry as ISO 8601 strings.

## Continuation order

Exact `web_content` continuation has strict precedence:

1. If local text remains, return `nextOffset` and do not return an upstream continuation.
2. At local EOF, return `nextContentOffset` only when `sourceComplete` is false and the record has a proven `nextSourceOffset`.
3. Never derive an upstream offset from selected text, returned presentation length, or stored segment length.
4. The next source segment requires a new `web_read` call with the reported `contentOffset` and the same source options.

Focused `findText` and `query` retrieval do not return source continuation offsets.

## Bounds and ownership

The store keeps its existing finite limits for entries, total UTF-8 bytes, item bytes, retention, and startup scans. Every lookup includes the caller principal. A missing, expired, invalid, or other-owner ID has the same public not-found result.

## Migration and invalidation

Persistent version-1 records do not prove representation or source provenance. Startup rejects and removes them. It also removes records with an invalid digest, size, source bound, expiry, or filename-to-ID match.

The read cache format version is 11. This invalidates cached responses that refer to pre-canonical records. Audit metadata uses version 3 in `events/metadata-v3`. Historical audit records remain unchanged and are not interpreted as canonical records.

## Compatibility

The existing `BoundedContent` fields and tool input schemas do not change. New provenance metadata is additive. Raw and structured behavior stays specialized. Owner checks and finite storage limits do not change.
