# Accepted local WebX source update — 2026-08-20

## Repository mapping

The publication repository `JCFrags/my-shtty-pi-web` is the monorepo for the accepted local WebX product.

- Prior publication main: `7bfe4370ecd58757bfbc56ef7e0070d17ba344`.
- Prior publication tag: `webx-complete-2026-08-12-r1`.
- Accepted WebX source: `ffc73a565607198b5c9cce701d54dcc7cbcf40b8`.
- Accepted WebX tree before this publication update: `140e7d0bbe9695eb77c57b012033b4a1d37f1e49`.
- Archive Range authority: `ccfe2e8ac59a03e26eba4bbbf443046b386f34ab`.
- Accepted browser source: `7421586a5781d5d26f47605b1a950b421bdc5c70`.
- Accepted browser tree: `0189f124d1b42434564f5e81400d57a4d282c27a`.
- Accepted Reader source: `a52122749aff022aebdc1a5c62795d22743c4766`.

The accepted WebX branch is a direct descendant of prior publication main. The browser subtree started from the recorded frozen browser import and now includes the reviewed accepted-source changes.

## Included changes

- Recallable and bounded public reads, structured JSON filtering, and public extraction fixes.
- DNS-pinned public egress support and tests.
- Bounded archive Range transport, Reader endpoint, WebX authority, binary artifact integrity, owner isolation, and cancellation tests.
- PinchTab loopback control commands no longer inherit the origin-facing proxy environment.
- SDK actor bindings renew once after the exact Webxd restart rejection. Other errors are not retried.
- Browser and SDK independent-review reports and acceptance documentation already recorded in the monorepo history.
- Source provenance and release identity documentation.

## Deployment and rollback boundary

The repository keeps deployment actions explicit and reversible:

- `scripts/pi-package-stage` creates a clean package without changing registration.
- `scripts/pi-package-cutover` checks prior and candidate tree identities, changes one symbolic link atomically, prints the exact inverse command, and does not issue `/reload`.
- Browser service installation remains under `components/browser/deploy`.
- Operators must preserve the prior immutable package, Browserd binary, and unit before activation. Rollback must verify the active candidate identity before restoring prior bytes.

No live unit, process state, local socket, local registration link, credential, secret, private corpus data, or private evidence is part of this source update.

## Acceptance identity

The locally reviewed package aggregate was `93d0f37edd35da18df74b41ff900fcb430cbdce4caba8dec0c586d33e688e110`. The reviewed Browserd binary SHA-256 was `36b0384bf268618baca2664a98c343c606f04194fa5ec0108a5aa17ca98a6ee9`.

These hashes identify the accepted local build. They do not replace reproducible source validation for a new checkout.
