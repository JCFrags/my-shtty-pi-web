# Protocol 2 observations

An observation is owner-scoped and path-bound. It includes its observation ID, operation ID, owner, full protocol address, immutable path identity, sequence, capture time, view, title, URL, content, and truncation state.

## Views

- `main` contains bounded main content, headings, alerts, and dialogs.
- `interactive` contains useful controls with stable references, roles, names, state, value, and optional CSS bounds.
- `visual` contains current screenshot binding and a small semantic summary.
- `full` stores the complete source as an owned artifact. Inline content stays bounded.
- `diff` contains semantic changes after an action. It reports an explicit lack of change when nothing changed.

A successful backend command is not action evidence. Every action result refers to a post-action observation and includes a semantic summary and changed items.

## Screenshot binding

A current screenshot records:

- owned artifact ID and SHA-256;
- screenshot sequence and capture time;
- image pixel width and height;
- viewport ID and viewport generation;
- CSS viewport width and height;
- device scale factor;
- scroll X and Y;
- `css-viewport-top-left` coordinate space.

The image dimensions must agree with the CSS viewport and device scale factor. The capture implementation must define how it handles fractional scale. It must not infer coordinates from image pixels alone.

A coordinate action supplies a `VisualGuard`. The daemon compares the viewport ID, viewport generation, screenshot digest, and screenshot sequence with the current screenshot. Any mismatch returns `stale-visual`. The client must observe again. The daemon does not dispatch the action against newer content.

The daemon rejects a point when `x < 0`, `y < 0`, `x >= cssWidth`, or `y >= cssHeight`. It also rejects non-finite values. This check is required because the primary backend can report success for an out-of-range move.

## Context limits and artifacts

Large full observations, screenshots, PDFs, diagnostics, and downloads use owned artifacts. Inline content follows the request bound. Truncation is explicit. An artifact read verifies the SHA-256 of the stored bytes before it returns data.

The workspace stream is not an observation artifact. It uses an owner-scoped lease for one selected owned tab and one viewport generation. A takeover, return, tab change, viewport change, close, or owner disconnect revokes or replaces the lease.

## Privacy

Observation status and errors are sanitized before persistence and display. They do not contain cookies, authorization headers, tokens, profile paths, upload staging paths, backend command lines, or raw debug output. Debug output becomes an owned artifact only after the debug policy removes secrets.
