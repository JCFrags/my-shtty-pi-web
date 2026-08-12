from typing import Any, Literal, Required, TypedDict


class Artifactresult(TypedDict, total=False):
    """ ArtifactResult. """

    schema_version: Required[Literal['1.0']]
    """ Required property """

    operation: Required[str]
    """
    minLength: 1

    Required property
    """

    job_id: Required[str]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    state: Required["_ArtifactresultState"]
    """ Required property """

    visit_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    page_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    version_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    crawl_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    source: "_ArtifactresultSource"
    execution: Required["_ArtifactresultExecution"]
    """ Required property """

    response: "_ArtifactresultResponse"
    content: "_ArtifactresultContent"
    artifacts: Required[list["_CommonFullStopJsonNumberSignDefsArtifactref"]]
    """ Required property """

    index_state: "_CommonFullStopJsonNumberSignDefsProjectionstate"
    wiki_state: "_CommonFullStopJsonNumberSignDefsProjectionstate"
    observations: list["Engineobservation"]
    warnings: Required[list["_CommonFullStopJsonNumberSignDefsWarning"]]
    """ Required property """



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


class _ArtifactresultContent(TypedDict, total=False):
    title: str
    """ maxLength: 4000 """

    language: str
    """ maxLength: 35 """

    excerpt: str
    """ maxLength: 50000 """

    content_sha256: str
    """ pattern: ^[0-9a-f]{64}$ """

    word_count: int
    """ minimum: 0 """



class _ArtifactresultExecution(TypedDict, total=False):
    engine: str
    """ maxLength: 100 """

    mode: Required["_ArtifactresultExecutionMode"]
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

    cached: Required[bool]
    """ Required property """

    trace_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    attempt_count: int
    """ minimum: 0 """



_ArtifactresultExecutionMode = Literal['auto'] | Literal['http'] | Literal['browser'] | Literal['adaptive'] | Literal['rag'] | Literal['archive'] | Literal['verify'] | Literal['offline'] | Literal['local']
_ARTIFACTRESULTEXECUTIONMODE_AUTO: Literal['auto'] = "auto"
"""The values for the '_ArtifactresultExecutionMode' enum"""
_ARTIFACTRESULTEXECUTIONMODE_HTTP: Literal['http'] = "http"
"""The values for the '_ArtifactresultExecutionMode' enum"""
_ARTIFACTRESULTEXECUTIONMODE_BROWSER: Literal['browser'] = "browser"
"""The values for the '_ArtifactresultExecutionMode' enum"""
_ARTIFACTRESULTEXECUTIONMODE_ADAPTIVE: Literal['adaptive'] = "adaptive"
"""The values for the '_ArtifactresultExecutionMode' enum"""
_ARTIFACTRESULTEXECUTIONMODE_RAG: Literal['rag'] = "rag"
"""The values for the '_ArtifactresultExecutionMode' enum"""
_ARTIFACTRESULTEXECUTIONMODE_ARCHIVE: Literal['archive'] = "archive"
"""The values for the '_ArtifactresultExecutionMode' enum"""
_ARTIFACTRESULTEXECUTIONMODE_VERIFY: Literal['verify'] = "verify"
"""The values for the '_ArtifactresultExecutionMode' enum"""
_ARTIFACTRESULTEXECUTIONMODE_OFFLINE: Literal['offline'] = "offline"
"""The values for the '_ArtifactresultExecutionMode' enum"""
_ARTIFACTRESULTEXECUTIONMODE_LOCAL: Literal['local'] = "local"
"""The values for the '_ArtifactresultExecutionMode' enum"""



class _ArtifactresultResponse(TypedDict, total=False):
    status: int
    """
    minimum: 100
    maximum: 599
    """

    mime_type: str
    charset: str
    content_length: int
    """ minimum: 0 """

    etag: str
    last_modified: str


class _ArtifactresultSource(TypedDict, total=False):
    requested_url: "_CommonFullStopJsonNumberSignDefsUrl"
    """
    format: uri
    maxLength: 8192
    """

    final_url: "_CommonFullStopJsonNumberSignDefsUrl"
    """
    format: uri
    maxLength: 8192
    """

    local_artifact_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    redirects: list["_CommonFullStopJsonNumberSignDefsUrl"]
    """ maxItems: 20 """



_ArtifactresultState = Literal['queued'] | Literal['leased'] | Literal['running'] | Literal['retry_wait'] | Literal['succeeded'] | Literal['partial'] | Literal['failed'] | Literal['cancelled'] | Literal['dead_letter']
_ARTIFACTRESULTSTATE_QUEUED: Literal['queued'] = "queued"
"""The values for the '_ArtifactresultState' enum"""
_ARTIFACTRESULTSTATE_LEASED: Literal['leased'] = "leased"
"""The values for the '_ArtifactresultState' enum"""
_ARTIFACTRESULTSTATE_RUNNING: Literal['running'] = "running"
"""The values for the '_ArtifactresultState' enum"""
_ARTIFACTRESULTSTATE_RETRY_WAIT: Literal['retry_wait'] = "retry_wait"
"""The values for the '_ArtifactresultState' enum"""
_ARTIFACTRESULTSTATE_SUCCEEDED: Literal['succeeded'] = "succeeded"
"""The values for the '_ArtifactresultState' enum"""
_ARTIFACTRESULTSTATE_PARTIAL: Literal['partial'] = "partial"
"""The values for the '_ArtifactresultState' enum"""
_ARTIFACTRESULTSTATE_FAILED: Literal['failed'] = "failed"
"""The values for the '_ArtifactresultState' enum"""
_ARTIFACTRESULTSTATE_CANCELLED: Literal['cancelled'] = "cancelled"
"""The values for the '_ArtifactresultState' enum"""
_ARTIFACTRESULTSTATE_DEAD_LETTER: Literal['dead_letter'] = "dead_letter"
"""The values for the '_ArtifactresultState' enum"""



class _CommonFullStopJsonNumberSignDefsArtifactref(TypedDict, total=False):
    artifact_id: Required[str]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    kind: Required[str]
    """
    minLength: 1
    maxLength: 80

    Required property
    """

    sha256: Required[str]
    """
    pattern: ^[0-9a-f]{64}$

    Required property
    """

    mime_type: str
    """ maxLength: 255 """

    size_bytes: int
    """ minimum: 0 """

    relative_path: str
    """
    minLength: 1
    maxLength: 2048
    """

    visibility: "_CommonFullStopJsonNumberSignDefsArtifactrefVisibility"


_CommonFullStopJsonNumberSignDefsArtifactrefVisibility = Literal['public'] | Literal['internal'] | Literal['private'] | Literal['secret']
_COMMONFULLSTOPJSONNUMBERSIGNDEFSARTIFACTREFVISIBILITY_PUBLIC: Literal['public'] = "public"
"""The values for the '_CommonFullStopJsonNumberSignDefsArtifactrefVisibility' enum"""
_COMMONFULLSTOPJSONNUMBERSIGNDEFSARTIFACTREFVISIBILITY_INTERNAL: Literal['internal'] = "internal"
"""The values for the '_CommonFullStopJsonNumberSignDefsArtifactrefVisibility' enum"""
_COMMONFULLSTOPJSONNUMBERSIGNDEFSARTIFACTREFVISIBILITY_PRIVATE: Literal['private'] = "private"
"""The values for the '_CommonFullStopJsonNumberSignDefsArtifactrefVisibility' enum"""
_COMMONFULLSTOPJSONNUMBERSIGNDEFSARTIFACTREFVISIBILITY_SECRET: Literal['secret'] = "secret"
"""The values for the '_CommonFullStopJsonNumberSignDefsArtifactrefVisibility' enum"""



_CommonFullStopJsonNumberSignDefsProjectionstate = Literal['excluded'] | Literal['pending'] | Literal['submitted'] | Literal['succeeded'] | Literal['failed'] | Literal['dead_letter']
_COMMONFULLSTOPJSONNUMBERSIGNDEFSPROJECTIONSTATE_EXCLUDED: Literal['excluded'] = "excluded"
"""The values for the '_CommonFullStopJsonNumberSignDefsProjectionstate' enum"""
_COMMONFULLSTOPJSONNUMBERSIGNDEFSPROJECTIONSTATE_PENDING: Literal['pending'] = "pending"
"""The values for the '_CommonFullStopJsonNumberSignDefsProjectionstate' enum"""
_COMMONFULLSTOPJSONNUMBERSIGNDEFSPROJECTIONSTATE_SUBMITTED: Literal['submitted'] = "submitted"
"""The values for the '_CommonFullStopJsonNumberSignDefsProjectionstate' enum"""
_COMMONFULLSTOPJSONNUMBERSIGNDEFSPROJECTIONSTATE_SUCCEEDED: Literal['succeeded'] = "succeeded"
"""The values for the '_CommonFullStopJsonNumberSignDefsProjectionstate' enum"""
_COMMONFULLSTOPJSONNUMBERSIGNDEFSPROJECTIONSTATE_FAILED: Literal['failed'] = "failed"
"""The values for the '_CommonFullStopJsonNumberSignDefsProjectionstate' enum"""
_COMMONFULLSTOPJSONNUMBERSIGNDEFSPROJECTIONSTATE_DEAD_LETTER: Literal['dead_letter'] = "dead_letter"
"""The values for the '_CommonFullStopJsonNumberSignDefsProjectionstate' enum"""



_CommonFullStopJsonNumberSignDefsUrl = str
"""
format: uri
maxLength: 8192
"""



class _CommonFullStopJsonNumberSignDefsWarning(TypedDict, total=False):
    code: Required[str]
    """
    pattern: ^[A-Z0-9_]+$

    Required property
    """

    message: Required[str]
    """
    maxLength: 2000

    Required property
    """

    severity: "_CommonFullStopJsonNumberSignDefsWarningSeverity"
    safe_context: dict[str, Any]


_CommonFullStopJsonNumberSignDefsWarningSeverity = Literal['info'] | Literal['warning'] | Literal['error']
_COMMONFULLSTOPJSONNUMBERSIGNDEFSWARNINGSEVERITY_INFO: Literal['info'] = "info"
"""The values for the '_CommonFullStopJsonNumberSignDefsWarningSeverity' enum"""
_COMMONFULLSTOPJSONNUMBERSIGNDEFSWARNINGSEVERITY_WARNING: Literal['warning'] = "warning"
"""The values for the '_CommonFullStopJsonNumberSignDefsWarningSeverity' enum"""
_COMMONFULLSTOPJSONNUMBERSIGNDEFSWARNINGSEVERITY_ERROR: Literal['error'] = "error"
"""The values for the '_CommonFullStopJsonNumberSignDefsWarningSeverity' enum"""



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
