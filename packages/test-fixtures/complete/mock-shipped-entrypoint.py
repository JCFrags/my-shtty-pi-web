#!/usr/bin/env python3
"""Deterministic wiring fixture. This is not shipped-entrypoint acceptance evidence."""

import argparse
import base64
import hashlib
import json
import pathlib
import sys

PRIMARY = "agent-browser/chrome"
FALLBACK = "pinchtab/chrome"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
parser = argparse.ArgumentParser()
parser.add_argument("--false-pass")
args = parser.parse_args()


def nested_lifecycle(case_id):
    evidence = {
        "L01": {
            "package": {
                "oneExtension": True,
                "productionDependenciesResolved": True,
                "developerLinks": False,
            },
            "pi": {"version": "0.84.1"},
            "tools": {"registeredOnce": True, "healthControlled": True},
            "apiMajorMismatch": {"failedClosed": True},
            "daemonOutage": {"directFallback": False},
        },
        "L02": {
            "lifecycle": {"startupCount": 1, "shutdownCount": 1, "reloadIssued": False},
            "inventory": {
                "orphanTimers": 0,
                "orphanClients": 0,
                "orphanProcesses": 0,
                "orphanTabs": 0,
                "duplicateRegistrations": 0,
            },
        },
        "L03": {
            "private": {
                "ownerRead": True,
                "publicResultCount": 0,
                "wikiDeliveryCreated": False,
                "sensitiveOutputMatches": 0,
            }
        },
        "L04": {
            "backup": {"verified": True},
            "restore": {
                "cleanTarget": True,
                "manifestMatch": True,
                "artifactHashesVerified": True,
                "sqliteConsistent": True,
                "pendingDeliveriesReconciled": True,
                "doctorFull": True,
            },
        },
        "L05": {
            "rollback": {
                "identityChecked": True,
                "atomicLinkOnly": True,
                "priorBytesPreserved": True,
                "failedBytesPreserved": True,
                "reloadIssued": False,
                "priorIdentityRestored": True,
            }
        },
    }[case_id]
    if args.false_pass == case_id:
        if case_id == "L02":
            evidence["inventory"]["orphanTabs"] = 1
        else:
            evidence[next(iter(evidence))][next(iter(evidence[next(iter(evidence))]))] = False
    return evidence


def handle(request):
    if request["type"] == "handshake":
        return {
            "ok": True,
            "protocol": "pi-web-qualification/1",
            "product": {
                "protocolMajor": 2,
                "shippedEntrypoint": False,
                "supportedPaths": [PRIMARY, FALLBACK],
                "pathIdentities": {
                    PRIMARY: {"pathId": PRIMARY, "backendVersion": "0.33.1", "provider": "chrome"},
                    FALLBACK: {
                        "pathId": FALLBACK,
                        "backendVersion": "0.15.1",
                        "provider": "chrome",
                    },
                },
            },
        }
    if request["type"] == "cleanup":
        return {
            "ok": True,
            "evidence": {
                "ok": True,
                "remainingHosts": 0,
                "remainingSessions": 0,
                "remainingTabs": 0,
                "remainingProcesses": 0,
                "remainingTimers": 0,
            },
        }
    if request["type"] != "case":
        raise RuntimeError("unsupported request")
    case_id = request["caseId"]
    operations = request["operations"]
    if case_id.startswith("L"):
        return {
            "ok": True,
            "executedSteps": [item["step"] for item in operations],
            "evidence": nested_lifecycle(case_id),
        }
    evidence = {
        "pathIdentities": request.get("requiredPaths", []),
        "publicFixture": True,
        "cleanupRequired": False,
    }
    if request.get("seededNegativeSelector"):
        evidence["negativeSelector"] = {
            "selector": request["seededNegativeSelector"],
            "dispatched": False,
            "code": "invalid-selector-not-found",
        }
    visual = (
        any(
            item.get("action") == "workspace.capture"
            or (item.get("action") == "browser.observe" and item.get("view") == "visual")
            for item in operations
        )
        or case_id == "J2"
    )
    if visual:
        directory = pathlib.Path(request["evidenceDir"])
        directory.mkdir(parents=True, exist_ok=True)
        sidecar = {
            "pathId": request.get("requiredPaths", [PRIMARY])[0]
            if request.get("requiredPaths")
            else PRIMARY,
            "principalId": request.get("principals", ["fixture-agent-a"])[0],
            "sessionId": f"session-{case_id}",
            "tabId": f"tab-{case_id}",
            "observationId": f"observation-{case_id}",
            "viewportId": f"viewport-{case_id}",
            "sequence": 1,
            "capturedAt": "2026-01-01T00:00:00.000Z",
            "viewport": {"width": 800, "height": 600, "coordinateSpace": "css-viewport"},
            "imageGeometry": {"width": 1, "height": 1, "deviceScaleFactor": 1},
            "sha256": hashlib.sha256(PNG).hexdigest(),
        }
        (directory / "public-fixture.png").write_bytes(PNG)
        (directory / "public-fixture.json").write_text(json.dumps(sidecar) + "\n", encoding="utf-8")
        evidence["visual"] = {"image": "public-fixture.png", "sidecar": "public-fixture.json"}
    return {
        "ok": True,
        "executedSteps": [item["step"] for item in operations],
        "evidence": evidence,
    }


for line in sys.stdin:
    request = json.loads(line)
    try:
        response = {"id": request["id"], "result": handle(request)}
    except Exception as error:
        response = {"id": request.get("id"), "error": {"message": str(error)}}
    print(json.dumps(response, separators=(",", ":")), flush=True)
