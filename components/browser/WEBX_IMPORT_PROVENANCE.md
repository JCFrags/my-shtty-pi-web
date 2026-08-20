# WebX browser import provenance

## Initial import

- Source: the separately reviewed Pi browser source repository.
- Frozen commit: `a660eb076ffd15de556082404c23f30c9c731ec9`.
- Frozen tree: `4f3133a940070ed8043d9bbb4c57d7dfccf6d384`.
- Baseline: `f0ce7cc27c0cb154239b535dd840f14eacfb6e48`.
- Changed-path manifest SHA-256: `dfe0d1766d85ade9c2b335660a790d411dc7aa45064252a928b86d4f8dd2a86a`.
- Imported: 2026-08-12 by `webx_build` under the frozen L1 intake.

## Accepted-source update

- Current reviewed browser commit: `7421586a5781d5d26f47605b1a950b421bdc5c70`.
- Current reviewed browser tree: `0189f124d1b42434564f5e81400d57a4d282c27a`.
- DNS-pinned egress commit: `7340f7e7524080ff78d354d90eb82a3810a0aa3b`.
- Archive Range Reader commit: `a52122749aff022aebdc1a5c62795d22743c4766`.
- PinchTab control-plane correction commit: `7421586a5781d5d26f47605b1a950b421bdc5c70`.
- Updated: 2026-08-20 by `webx_build` after focused real acceptance and independent review.

The update imports reviewed changes after the initial browser intake. Existing monorepo-only safety and qualification changes remain in place when they do not conflict with the accepted browser result.

## Boundaries

- License: Apache-2.0. The browser `LICENSE` remains in this subtree.
- `packages/pi-extension` is intentionally excluded. WebX ships one Pi package from `apps/pi-webx`.
- The monorepo `components/browser/uv.lock` remains preserved. It is not replaced from an absent source lock.
- Generated caches, build output, fixture uploads, local environments, service state, credentials, and private acceptance evidence are excluded.
