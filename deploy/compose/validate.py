#!/usr/bin/env python3
"""Validate the reference Compose skeleton without pulling or starting images."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Final

import yaml

ROOT: Final = Path(__file__).resolve().parents[2]
COMPOSE_DIR: Final = Path(__file__).resolve().parent
PROFILES: Final = ("core", "full", "llama-cpu", "vllm-gpu", "offline")
WORKERS: Final = {"archived", "browserd", "docd", "mediad", "monitord", "pyfetchd"}
ORIGIN_SERVICES: Final = WORKERS | {"searxng", "yacy"}
EXPECTED: Final = {
    "core": {"webxd", "egressd", "meilisearch", "searxng", "browserd", "pyfetchd", "docd", "mediad"},
    "full": {
        "webxd", "egressd", "meilisearch", "searxng", "browserd", "pyfetchd", "docd", "mediad",
        "archived", "monitord", "yacy", "otel-collector", "prometheus",
    },
    "llama-cpu": {
        "webxd", "egressd", "meilisearch", "searxng", "browserd", "pyfetchd", "docd", "mediad",
        "model-gateway", "llama-cpp",
    },
    "vllm-gpu": {
        "webxd", "egressd", "meilisearch", "searxng", "browserd", "pyfetchd", "docd", "mediad",
        "model-gateway", "vllm",
    },
    "offline": {"webxd", "meilisearch", "browserd", "pyfetchd", "docd", "mediad", "archived", "monitord"},
}
DIGEST_IMAGE: Final = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")
SECRET_KEY: Final = re.compile(r"(?:TOKEN|PASSWORD|SECRET|API_?KEY)$", re.I)
LOOPBACK: Final = {"127.0.0.1", "::1"}


class ValidationError(Exception):
    """The Compose skeleton violates a required invariant."""


def load_mapping(path: Path) -> dict[str, Any]:
    try:
        if path.suffix == ".json":
            value = json.loads(path.read_text(encoding="utf-8"))
        else:
            value = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, yaml.YAMLError) as error:
        raise ValidationError(f"cannot parse {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValidationError(f"{path}: top level must be a mapping")
    return value


def service_profiles(service: dict[str, Any]) -> set[str]:
    raw = service.get("profiles", [])
    if not isinstance(raw, list) or not raw or not all(isinstance(item, str) for item in raw):
        raise ValidationError("every service must have a non-empty profiles list")
    values = set(raw)
    unknown = values - set(PROFILES)
    if unknown:
        raise ValidationError(f"unknown profiles: {', '.join(sorted(unknown))}")
    return values


def selected_services(compose: dict[str, Any], profile: str) -> set[str]:
    services = compose.get("services")
    if not isinstance(services, dict):
        raise ValidationError("services must be a mapping")
    return {
        name
        for name, service in services.items()
        if isinstance(name, str) and isinstance(service, dict) and profile in service_profiles(service)
    }


def normalized_networks(service: dict[str, Any]) -> set[str]:
    raw = service.get("networks", [])
    if isinstance(raw, list):
        return {str(item) for item in raw}
    if isinstance(raw, dict):
        return {str(item) for item in raw}
    raise ValidationError("service networks must be a list or mapping")


def normalized_environment(service: dict[str, Any]) -> dict[str, str]:
    raw = service.get("environment", {})
    if isinstance(raw, dict):
        return {str(key): str(value) for key, value in raw.items()}
    if isinstance(raw, list):
        result: dict[str, str] = {}
        for item in raw:
            key, separator, value = str(item).partition("=")
            result[key] = value if separator else ""
        return result
    raise ValidationError("service environment must be a mapping or list")


def volume_source(item: object) -> str | None:
    if isinstance(item, str):
        source, separator, _target = item.partition(":")
        return source if separator else None
    if isinstance(item, dict):
        source = item.get("source")
        return str(source) if source is not None else None
    raise ValidationError("service volume must be a string or mapping")


def validate_port(service_name: str, item: object, admin: bool) -> None:
    host_ip: str | None = None
    if isinstance(item, int):
        raise ValidationError(f"{service_name}: published port has no loopback host IP")
    if isinstance(item, str):
        parts = item.rsplit(":", 2)
        host_ip = parts[0].strip("[]") if len(parts) == 3 else None
    elif isinstance(item, dict):
        host_ip = str(item.get("host_ip", "")) or None
    else:
        raise ValidationError(f"{service_name}: invalid port entry")
    if not admin or host_ip not in LOOPBACK:
        raise ValidationError(f"{service_name}: only explicit loopback admin ports may be published")


def validate_image_lock(
    services: dict[str, Any], image_lock: dict[str, Any], component_lock: dict[str, Any]
) -> None:
    raw_images = image_lock.get("images")
    if image_lock.get("schema_version") != 1 or not isinstance(raw_images, list):
        raise ValidationError("images.lock.json has an unsupported structure")
    component_digests = {
        str(component["id"]): {str(item["digest"]) for item in component.get("artifacts", [])}
        for component in component_lock.get("components", [])
        if isinstance(component, dict) and "id" in component
    }
    service_to_reference: dict[str, str] = {}
    for image in raw_images:
        if not isinstance(image, dict):
            raise ValidationError("each image lock entry must be a mapping")
        reference = str(image.get("reference", ""))
        component_id = str(image.get("component_id", ""))
        if not DIGEST_IMAGE.fullmatch(reference):
            raise ValidationError(f"image lock has a non-immutable reference: {reference}")
        digest = "sha256:" + reference.rsplit("@sha256:", 1)[1]
        if digest not in component_digests.get(component_id, set()):
            raise ValidationError(f"image lock digest is absent from component lock: {reference}")
        mapped = image.get("services")
        if not isinstance(mapped, list) or not mapped:
            raise ValidationError(f"image lock entry has no services: {reference}")
        for service_name in mapped:
            name = str(service_name)
            if name in service_to_reference:
                raise ValidationError(f"service has duplicate image lock entries: {name}")
            service_to_reference[name] = reference
    if set(service_to_reference) != set(services):
        missing = sorted(set(services) - set(service_to_reference))
        extra = sorted(set(service_to_reference) - set(services))
        raise ValidationError(f"image service coverage differs; missing={missing}, extra={extra}")
    for name, service in services.items():
        reference = service.get("image")
        if reference != service_to_reference[name]:
            raise ValidationError(f"{name}: image differs from images.lock.json")


def validate_service(name: str, service: dict[str, Any], compose: dict[str, Any]) -> None:
    if service.get("privileged") is True:
        raise ValidationError(f"{name}: privileged containers are forbidden")
    for key in ("network_mode", "pid", "ipc"):
        if str(service.get(key, "")).lower() == "host":
            raise ValidationError(f"{name}: host {key} is forbidden")
    if service.get("read_only") is not True:
        raise ValidationError(f"{name}: read_only must be true")
    if service.get("init") is not True:
        raise ValidationError(f"{name}: init must be true")
    security_opt = {str(item) for item in service.get("security_opt", [])}
    if "no-new-privileges:true" not in security_opt:
        raise ValidationError(f"{name}: no-new-privileges is required")
    if {str(item).upper() for item in service.get("cap_drop", [])} != {"ALL"}:
        raise ValidationError(f"{name}: all Linux capabilities must be dropped")
    if service.get("cap_add") or service.get("devices"):
        raise ValidationError(f"{name}: added capabilities and devices are forbidden")
    user = str(service.get("user", ""))
    if not user or user.split(":", 1)[0] in {"0", "root"}:
        raise ValidationError(f"{name}: a numeric non-root user is required")
    if not isinstance(service.get("pids_limit"), int) or service["pids_limit"] <= 0:
        raise ValidationError(f"{name}: a positive pids_limit is required")

    labels = {str(key): str(value) for key, value in service.get("labels", {}).items()}
    admin = labels.get("org.webx.admin-endpoint") == "true"
    for port in service.get("ports", []):
        validate_port(name, port, admin)

    defined_volumes = set(compose.get("volumes", {}))
    for item in service.get("volumes", []):
        source = volume_source(item)
        if source is None:
            continue
        lowered = source.lower()
        if (
            source.startswith(("/", "~"))
            or "${home" in lowered
            or "docker.sock" in lowered
            or source in {".", ".."}
        ):
            raise ValidationError(f"{name}: host or broad volume source is forbidden: {source}")
        if source not in defined_volumes:
            raise ValidationError(f"{name}: undefined named volume: {source}")

    defined_secrets = set(compose.get("secrets", {}))
    for item in service.get("secrets", []):
        secret_name = str(item) if isinstance(item, str) else str(item.get("source", ""))
        if secret_name not in defined_secrets:
            raise ValidationError(f"{name}: undefined secret: {secret_name}")
    for key, value in normalized_environment(service).items():
        if SECRET_KEY.search(key) and value and not value.startswith("/run/secrets/"):
            raise ValidationError(f"{name}: secret-like environment value is forbidden: {key}")

    networks = normalized_networks(service)
    if not networks or not networks <= set(compose.get("networks", {})):
        raise ValidationError(f"{name}: networks are missing or undefined")
    if "webx_wan" in networks and name != "egressd":
        raise ValidationError(f"{name}: only egressd may join the WAN network")
    service_profiles(service)


def validate(compose: dict[str, Any], image_lock: dict[str, Any], component_lock: dict[str, Any]) -> None:
    if compose.get("name") != "webx":
        raise ValidationError("Compose project name must be webx")
    services = compose.get("services")
    networks = compose.get("networks")
    if not isinstance(services, dict) or not services:
        raise ValidationError("services must be a non-empty mapping")
    if not isinstance(networks, dict) or networks.get("webx_control", {}).get("internal") is not True:
        raise ValidationError("webx_control must be an internal network")
    if "webx_wan" not in networks:
        raise ValidationError("webx_wan must be declared")
    validate_image_lock(services, image_lock, component_lock)
    for name, service in services.items():
        if not isinstance(name, str) or not isinstance(service, dict):
            raise ValidationError("service names and definitions must be mappings")
        validate_service(name, service, compose)

    if normalized_networks(services.get("egressd", {})) != {"webx_control", "webx_wan"}:
        raise ValidationError("egressd must be the sole internal-to-WAN gateway")
    for name in ORIGIN_SERVICES & set(services):
        networks_for_service = normalized_networks(services[name])
        if networks_for_service != {"webx_control"}:
            raise ValidationError(f"{name}: origin-capable service must remain internal")
        environment = normalized_environment(services[name])
        if name != "archived" or "offline" not in service_profiles(services[name]):
            for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
                if "egressd" not in environment.get(key, ""):
                    raise ValidationError(f"{name}: {key} must use egressd")

    for profile in PROFILES:
        selected = selected_services(compose, profile)
        if selected != EXPECTED[profile]:
            raise ValidationError(
                f"{profile}: service set differs; expected={sorted(EXPECTED[profile])}, actual={sorted(selected)}"
            )
    offline = selected_services(compose, "offline")
    if offline & {"egressd", "searxng", "yacy"}:
        raise ValidationError("offline profile includes an origin or gateway service")
    if any("webx_wan" in normalized_networks(services[name]) for name in offline):
        raise ValidationError("offline profile has a WAN-capable service")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compose", type=Path, default=COMPOSE_DIR / "compose.yaml")
    parser.add_argument("--images", type=Path, default=COMPOSE_DIR / "images.lock.json")
    parser.add_argument("--component-lock", type=Path, default=ROOT / "deploy/component-lock.json")
    parser.add_argument("--profile", choices=PROFILES, action="append")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        compose = load_mapping(args.compose)
        image_lock = load_mapping(args.images)
        component_lock = load_mapping(args.component_lock)
        validate(compose, image_lock, component_lock)
        profiles = args.profile or list(PROFILES)
        for profile in profiles:
            print(f"{profile}: {','.join(sorted(selected_services(compose, profile)))}")
    except ValidationError as error:
        print(f"compose-check: ERROR: {error}", file=sys.stderr)
        return 2
    print("compose-check: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
