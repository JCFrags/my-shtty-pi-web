# WebX ownership map

| Path | Owner |
|---|---|
| Root manifests, lockfiles, `Makefile`, generated contracts, Compose, acceptance matrix | `webx_build` integration owner; delegated writer named in the active contract |
| `apps/webxd`, `apps/webx-cli`, `apps/pi-webx`, `packages/sdk` | `webx_control` |
| `packages/contracts`, `packages/db`, `packages/artifacts` | `webx_data` |
| `services/egressd`, `services/browserd`, `services/pyfetchd`, `packages/routing` | `webx_retrieval` |
| `services/docd`, `services/mediad`, `services/archived`, `services/monitord`, `services/model-gateway` | `webx_content` |
| `packages/policy` | `webx_security` |
| `packages/test-fixtures` and gate harness | `webx_quality` |
| `packages/config`, `deploy`, release and operation scripts | `webx_platform` |

`webx_build` serializes controlled shared-file merges. A task contract can narrow these paths further.
