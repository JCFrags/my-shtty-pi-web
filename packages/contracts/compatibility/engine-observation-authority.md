# Engine observation authority compatibility

## Change

`engine-observation.json` no longer contains worker-produced `accepted` or `rejection_reasons` fields.

The downloaded pre-M0 schema required `accepted`. That field conflicted with the worker trust boundary. A hostile-content worker supplies evidence and quality facts only. It cannot accept or reject content for WebX.

## Compatibility disposition

This is an intentional pre-generation correction to the unreleased 1.0 contract baseline. No released WebX client or stored worker record uses the removed fields.

- `WX-M0-004` must generate types from the corrected schema.
- `WX-M0-005` must use the corrected schema in the worker OpenAPI contract.
- A worker that sends `accepted` or `rejection_reasons` fails strict schema validation.
- `webxd` records its final admission decision in daemon-owned state after it validates the observation and normalized content.
- The `engine_observations.accepted` SQLite column is daemon-owned post-admission state. It is not populated from an untrusted worker field.

Do not add an alias or compatibility fallback that copies a worker value into daemon-owned acceptance state.
