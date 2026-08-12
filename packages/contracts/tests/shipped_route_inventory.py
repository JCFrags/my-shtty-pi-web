#!/usr/bin/env python3
"""Check the exact WebX routes shipped by the daemon and SDK facade."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
document: dict[str, Any] = yaml.safe_load((ROOT / "openapi.yaml").read_text(encoding="utf-8"))

ROUTES = {
    ("get", "/version"): ("getVersion", "public", False),
    ("get", "/capabilities"): ("getCapabilities", "system.read", False),
    ("post", "/search"): ("search", "search.write", True),
    ("post", "/read"): ("read", "retrieval.read", True),
    ("post", "/research"): ("research", "research.write", True),
    ("post", "/pages/search"): ("searchPages", "pages.read", True),
    ("get", "/pages/{page_id}"): ("getPage", "pages.read", False),
    ("delete", "/pages"): ("forgetPage", "pages.write", True),
    ("get", "/artifacts/{artifact_id}/excerpt"): ("getArtifactExcerpt", "artifacts.read", False),
    ("get", "/browser/sessions"): ("listBrowserSessions", "browser.read", False),
    ("post", "/browser/sessions"): ("createBrowserSession", "browser.write", True),
    ("get", "/browser/sessions/{session_id}"): ("getBrowserSession", "browser.read", False),
    ("delete", "/browser/sessions/{session_id}"): ("closeBrowserSession", "browser.write", True),
    ("delete", "/browser/sessions/{session_id}/tabs/{tab_id}"): (
        "closeBrowserTab",
        "browser.write",
        True,
    ),
    ("post", "/browser/sessions/{session_id}/observe"): ("observeBrowser", "browser.read", True),
    ("post", "/browser/sessions/{session_id}/frame"): (
        "getBrowserVisualFrame",
        "browser.read",
        True,
    ),
    ("post", "/browser/sessions/{session_id}/actions"): ("actBrowser", "browser.write", True),
    ("post", "/browser/sessions/{session_id}/debug"): ("debugBrowser", "browser.debug", True),
    ("post", "/browser/workspace"): ("manageBrowserWorkspace", "browser.control", True),
    ("post", "/browser/operations/{operation_id}/cancel"): (
        "cancelBrowserOperation",
        "browser.write",
        True,
    ),
}

for (method, route), (operation_id, scope, idempotent) in ROUTES.items():
    operation = document["paths"].get(route, {}).get(method)
    if operation is None:
        raise AssertionError(f"missing shipped route: {method.upper()} {route}")
    if operation["operationId"] != operation_id:
        raise AssertionError(f"wrong operationId for {method.upper()} {route}")
    if operation["x-webx-scopes"] != [scope]:
        raise AssertionError(f"wrong scope for {method.upper()} {route}")
    limits = operation["x-webx-request-limits"]
    if limits["max_response_bytes"] != 1_048_576:
        raise AssertionError(f"wrong response limit for {method.upper()} {route}")
    parameters = operation.get("parameters", [])
    has_key = any(
        item.get("$ref") == "#/components/parameters/IdempotencyKey" for item in parameters
    )
    if has_key != idempotent:
        raise AssertionError(f"wrong idempotency contract for {method.upper()} {route}")
    expected_body_limit = 1_048_576 if "requestBody" in operation else 0
    if limits["max_body_bytes"] != expected_body_limit:
        raise AssertionError(f"wrong body limit for {method.upper()} {route}")

schemas = document["components"]["schemas"]
if schemas["ShippedVersionInfo"]["properties"]["apiVersion"].get("const") != "1.0.0":
    raise AssertionError("shipped API identity is not 1.0.0")
if schemas["ShippedVersionInfo"]["properties"]["browserProtocolVersion"].get("const") != "2.0.0":
    raise AssertionError("browser protocol identity is not 2.0.0")
if schemas["BrowserPathId"].get("enum") != ["agent-browser/chrome", "pinchtab/chrome"]:
    raise AssertionError("browser path inventory differs from the two shipped paths")
if schemas["BrowserWorkspaceRequest"]["properties"]["action"].get("enum") != [
    "show",
    "hide",
    "list",
    "attach",
    "takeover",
    "return",
]:
    raise AssertionError("workspace action inventory differs")
for name in (
    "ShippedVersionInfo",
    "ShippedCapabilityCatalog",
    "ShippedSearchRequest",
    "ShippedSearchResponse",
    "ShippedReadRequest",
    "BoundedContent",
    "ResearchRequest",
    "ResearchResponse",
    "PageLibrarySearchRequest",
    "PageLibrarySearchResponse",
    "PageForgetRequest",
    "PageForgetResult",
    "ArtifactExcerptShipped",
    "BrowserSessionRequestShipped",
    "BrowserSessionShipped",
    "BrowserSessionList",
    "BrowserObserveRequest",
    "BrowserObservation",
    "BrowserVisualFrame",
    "BrowserActionRequest",
    "BrowserDebugRequest",
    "BrowserDebugResult",
    "BrowserWorkspaceRequest",
    "BrowserWorkspaceResult",
    "BrowserOperationResult",
    "EmptyObject",
):
    if schemas[name].get("additionalProperties") is not False:
        raise AssertionError(f"shipped object is not strict: {name}")
for variant in schemas["BrowserActionShipped"]["oneOf"]:
    if variant.get("additionalProperties") is not False:
        raise AssertionError("browser action variant is not strict")
print(
    f"VALID shipped route inventory: {len(ROUTES)} routes, API 1, "
    "browser protocol 2, two browser paths"
)
