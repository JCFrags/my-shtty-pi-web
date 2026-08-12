# Dependency inventory and notices

`deploy/dependency-catalog.json` is the reviewed direct-dependency input. The pipeline generates:

- `deploy/dependency-inventory.json`, the complete machine-readable direct inventory;
- `deploy/sbom.cdx.json`, a CycloneDX 1.6 JSON SBOM;
- `THIRD_PARTY_NOTICES.md`, the direct-component notice report.

Run:

```sh
./scripts/dependency-inventory
./scripts/dependency-inventory --check
./scripts/dependency-inventory --mode release --check
```

Development mode permits an exact later-owned selection to remain unresolved. Release mode rejects an enabled direct component with an unresolved license. A safely disabled optional model selection does not block the release check until it is enabled.

The check cross-references every component-lock ID. It also compares every direct npm and Python manifest entry with the inventory. It rejects duplicate IDs, incomplete fields, version drift, unknown component references, secret-like source values, private host paths, and generated output drift.

The current release check must remain red for these later-owned records:

- `component:schema-generator-set`, owned by `WX-M0-004`;
- `component:remaining-deployment-image-set`, owned by `WX-M0-012`.

Image transitive package inventories require the selected image SBOM or equivalent upstream package evidence before release qualification. This M0 pipeline does not pull images or infer package contents.
