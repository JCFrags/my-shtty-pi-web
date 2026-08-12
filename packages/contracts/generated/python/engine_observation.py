from typing import Any, Literal, Required, TypedDict


class Engineobservation(TypedDict, total=False):
    """
    EngineObservation.

    $comment: Worker-produced evidence only. Compatibility traceability: ../compatibility/engine-observation-authority.md. Final acceptance is daemon-owned and is not present in this schema.
    """

    observation_id: Required[str]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    engine: Required[str]
    """
    maxLength: 100

    Required property
    """

    engine_version: str
    """ maxLength: 200 """

    route_kind: "_EngineobservationRouteKind"
    state: Required["_EngineobservationState"]
    """ Required property """

    started_at: Required[str]
    """
    format: date-time

    Required property
    """

    completed_at: Required[str]
    """
    format: date-time

    Required property
    """

    http_status: int
    """
    minimum: 100
    maximum: 599
    """

    final_url: "_CommonFullStopJsonNumberSignDefsUrl"
    """
    format: uri
    maxLength: 8192
    """

    quality: Required["_EngineobservationQuality"]
    """ Required property """

    source_artifact_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    screenshot_artifact_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    error_code: str
    safe_diagnostics: dict[str, Any]


_CommonFullStopJsonNumberSignDefsUrl = str
"""
format: uri
maxLength: 8192
"""



class _EngineobservationQuality(TypedDict, total=False):
    score: Required[int | float]
    """
    minimum: 0
    maximum: 1

    Required property
    """

    text_chars: int
    """ minimum: 0 """

    word_count: int
    """ minimum: 0 """

    requested_selectors_present: bool
    challenge_detected: bool
    schema_valid: bool
    main_content_ratio: int | float
    """
    minimum: 0
    maximum: 1
    """



_EngineobservationRouteKind = Literal['http'] | Literal['browser'] | Literal['adaptive'] | Literal['archive'] | Literal['local']
_ENGINEOBSERVATIONROUTEKIND_HTTP: Literal['http'] = "http"
"""The values for the '_EngineobservationRouteKind' enum"""
_ENGINEOBSERVATIONROUTEKIND_BROWSER: Literal['browser'] = "browser"
"""The values for the '_EngineobservationRouteKind' enum"""
_ENGINEOBSERVATIONROUTEKIND_ADAPTIVE: Literal['adaptive'] = "adaptive"
"""The values for the '_EngineobservationRouteKind' enum"""
_ENGINEOBSERVATIONROUTEKIND_ARCHIVE: Literal['archive'] = "archive"
"""The values for the '_EngineobservationRouteKind' enum"""
_ENGINEOBSERVATIONROUTEKIND_LOCAL: Literal['local'] = "local"
"""The values for the '_EngineobservationRouteKind' enum"""



_EngineobservationState = Literal['succeeded'] | Literal['failed'] | Literal['cancelled']
_ENGINEOBSERVATIONSTATE_SUCCEEDED: Literal['succeeded'] = "succeeded"
"""The values for the '_EngineobservationState' enum"""
_ENGINEOBSERVATIONSTATE_FAILED: Literal['failed'] = "failed"
"""The values for the '_EngineobservationState' enum"""
_ENGINEOBSERVATIONSTATE_CANCELLED: Literal['cancelled'] = "cancelled"
"""The values for the '_EngineobservationState' enum"""
