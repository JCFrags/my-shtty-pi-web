# WebX SDK

`@webx/sdk` is the stable typed client boundary for WebX API major 1.

It provides:

- API-major negotiation;
- bounded authenticated HTTP and injected Unix NDJSON transports;
- stable search, read, research, page, artifact, capability, browser frame, and browser action methods;
- one idempotency key for each mutation;
- `AbortSignal` propagation;
- explicit untrusted-content fields;
- exactly two browser path IDs.

The SDK has no policy, direct data access, browser provider access, or fallback path.
