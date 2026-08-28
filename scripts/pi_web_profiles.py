"""Resolve the reviewed Pi Web installation profile manifests."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

PROFILE_IDS = ("web-core", "documents", "render", "browser", "full")
DEFAULT_PROFILE = "web-core"
LIST_FIELDS = (
    "capabilities", "fedoraPackages", "commands", "nodeFilters", "pythonPackages",
    "playwrightBrowsers", "npmPackages", "cargoPackages", "units",
)


def manifest_root(source: Path) -> Path:
    return source / "install/profiles"


def load_profiles(source: Path) -> dict[str, dict[str, Any]]:
    profiles: dict[str, dict[str, Any]] = {}
    for profile_id in PROFILE_IDS:
        path = manifest_root(source) / f"{profile_id}.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("schemaVersion") != 1 or value.get("id") != profile_id:
            raise ValueError(f"invalid profile manifest: {path}")
        value.setdefault("resourceLimits", {})
        if not isinstance(value["resourceLimits"], dict):
            raise ValueError(f"profile {profile_id} has invalid resource limits")
        for field in ("includes", *LIST_FIELDS):
            if field not in value:
                value[field] = []
            if not isinstance(value[field], list) or not all(isinstance(item, str) and item for item in value[field]):
                raise ValueError(f"profile {profile_id} has an invalid {field} list")
        profiles[profile_id] = value
    return profiles


def resolve_profiles(source: Path, requested: Iterable[str] | None = None) -> dict[str, Any]:
    profiles = load_profiles(source)
    selected = list(requested or [DEFAULT_PROFILE])
    if not selected:
        selected = [DEFAULT_PROFILE]
    unknown = sorted(set(selected) - profiles.keys())
    if unknown:
        raise ValueError(f"unknown profile: {', '.join(unknown)}")
    if "full" in selected and len(set(selected)) != 1:
        raise ValueError("full cannot be combined with another profile")

    ordered: list[str] = []
    visiting: set[str] = set()
    def visit(profile_id: str) -> None:
        if profile_id in ordered:
            return
        if profile_id in visiting:
            raise ValueError(f"profile include cycle at {profile_id}")
        visiting.add(profile_id)
        for included in profiles[profile_id]["includes"]:
            if included not in profiles:
                raise ValueError(f"profile {profile_id} includes unknown profile {included}")
            visit(included)
        visiting.remove(profile_id)
        if profile_id != "full":
            ordered.append(profile_id)
    for profile_id in selected:
        visit(profile_id)

    result: dict[str, Any] = {
        "schemaVersion": 1,
        "requestedProfiles": selected,
        "resolvedProfiles": ordered,
        "defaultProfile": DEFAULT_PROFILE,
    }
    for field in LIST_FIELDS:
        result[field] = []
        for profile_id in ordered:
            for item in profiles[profile_id][field]:
                if item not in result[field]:
                    result[field].append(item)
    result["resourceLimits"] = {}
    for profile_id in ordered:
        for unit, limits in profiles[profile_id]["resourceLimits"].items():
            if unit in result["resourceLimits"] and result["resourceLimits"][unit] != limits:
                raise ValueError(f"profiles specify conflicting resource limits for {unit}")
            result["resourceLimits"][unit] = limits
    return result
