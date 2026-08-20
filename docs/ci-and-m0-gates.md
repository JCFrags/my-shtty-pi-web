# CI and M0 gate orchestration

WX-M0-013 adds pull-request CI and two stable Make targets:

```sh
make compose-check
make release-check
```

This is an M0 repository and contract gate. It does not claim that the WebX product is ready for release.

## Compose check

`make compose-check` parses the reference Compose skeleton, validates all static profile and security rules, and runs its seeded tests. It does not start a container, pull an image, or contact a service.

## Fixed M0 gate

`scripts/ci-m0-gate` runs this exact sequence and stops on the first failure:

```sh
make bootstrap contracts-check format lint typecheck test-unit docs-check compose-check
```

The gate requires a clean checkout before and after the sequence. It sets pnpm and uv to offline mode. All behavioral tests use repository-local fixtures. It does not retry a failure.

## M0 release preparation

`make release-check` runs, in order:

1. the component lock in release mode;
2. the dependency inventory and license policy in release mode;
3. the fixed workflow policy validator;
4. the exact M0 gate.

A successful result is reported as `milestone=M0 release-readiness=not-claimed`. Later acceptance, clean-host, runtime, upgrade, backup, restore, performance, hardware-profile, and full-product release suites remain unimplemented until their assigned milestones.

## Selectors

`release-check` accepts one optional accepted `AC` and `PROFILE` selector:

```sh
make release-check AC=AC-001 PROFILE=core
```

Accepted AC values are `AC-001` through `AC-030`. Accepted profiles are `core`, `full`, `model`, `llama-cpu`, `vllm-gpu`, and `offline`. The Make boundary and release script both reject unknown, multi-value, path-like, and injection-shaped values.

At M0, a known selector does not run or claim its later acceptance suite. The command runs only M0 checks and prints an explicit `NOT IMPLEMENTED at M0` message for the selected product qualification.

The four language quality targets still reject `AC` and `PROFILE` because those selectors belong only to release orchestration.

## GitHub Actions security

`.github/workflows/m0.yml` runs on a fresh GitHub-hosted Ubuntu 24.04 runner. It installs the exact locked Node, Python, pnpm, and uv versions. It populates dependency caches from frozen lockfiles before the deterministic release gate switches to offline mode. The workflow:

- grants only `contents: read`;
- uses no repository or organization secrets and no private fixtures;
- does not use `pull_request_target`;
- checks out one revision and removes persisted credentials;
- installs exact tool versions and frozen dependencies;
- invokes only repository validation and Make targets;
- has no container start, image pull, public-site test, retry, or ignored failure;
- pins `actions/checkout` to commit `11bd71901bbe5b1630ceea73d27597364c9af683` (`v4.2.2`).

The external action is recorded in the component lock, dependency inventory, SBOM, and notices. `scripts/ci_validate.py` rejects policy drift, an unpinned action, write permission, container commands, retries, and dangerous workflow triggers.

Run workflow policy checks locally with:

```sh
make ci-validate
```
