# Reference Compose skeleton

This directory contains the rootless-oriented WebX Compose skeleton. It is a static deployment contract. It is not a runnable WebX release.

`compose.yaml` marks all first-party services and optional runtimes as `implementation-pending`. These services use the locked Playwright image only as an inert placeholder identity. The file does not claim that the image implements those services. Do not start the skeleton.

## Profiles

- `core`: `webxd`, the mandatory `egressd` gateway, Meilisearch, SearXNG, and core workers.
- `full`: the core set plus archive, monitoring, YaCy, and basic observability placeholders.
- `llama-cpu`: the core set plus the model gateway and llama.cpp placeholders.
- `vllm-gpu`: the core set plus the model gateway and vLLM placeholders. A later host overlay must add the reviewed GPU reservation.
- `offline`: local control, corpus, document, media, and archive workers. It excludes `egressd`, SearXNG, YaCy, and every WAN-capable service.

Every service uses the internal `webx_control` network. Only `egressd` also uses `webx_wan`. Workers have proxy endpoints for `egressd`, but network topology denies direct WAN access. The offline profile omits the gateway, so these proxy endpoints fail closed.

The skeleton publishes no host port. A later explicit admin endpoint can publish only a loopback address. Client access uses the `webx_run` volume for the Unix socket by default.

## Locked images

`images.lock.json` maps every service to an immutable OCI index digest already present in `deploy/component-lock.json`. It contains no floating tag. The component and dependency inventory include this complete service-to-image map.

The skeleton does not mount a host home, broad secret directory, browser profile, container socket, or final artifact path into a worker. It uses individual Compose secrets and named volumes. Every container is non-root, read-only, capability-free, and protected with `no-new-privileges`.

## Static checks

Run checks without a container runtime:

```sh
python3 deploy/compose/validate.py
python3 -m unittest discover -s deploy/compose/tests -p 'test_*.py'
```

The validator parses the Compose model, resolves all five profiles, checks the image lock against the component lock, and enforces the network and container security boundary. Seeded negative fixtures prove that it rejects direct worker WAN access, public sensitive ports, privileged containers, host-home mounts, floating images, offline egress, and literal secret values.

These commands do not pull or start an image.
