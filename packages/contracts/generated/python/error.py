from typing import Any, Literal, Required, TypedDict


class Problemdetails(TypedDict, total=False):
    """ ProblemDetails. """

    type: Required[str]
    """
    format: uri

    Required property
    """

    title: Required[str]
    """
    maxLength: 500

    Required property
    """

    status: Required[int]
    """
    minimum: 400
    maximum: 599

    Required property
    """

    code: Required[str]
    """
    pattern: ^WEBX_[A-Z0-9_]+$

    Required property
    """

    detail: Required[str]
    """
    maxLength: 4000

    Required property
    """

    instance: str
    request_id: Required[str]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    job_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    retryable: Required[bool]
    """ Required property """

    retry_after_seconds: int
    """ minimum: 0 """

    phase: str
    engine: str
    durable_outputs: list["_CommonFullStopJsonNumberSignDefsArtifactref"]
    violations: list["_ProblemdetailsViolationsItem"]
    causes: list["_ProblemdetailsCausesItem"]
    safe_context: dict[str, Any]


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



class _ProblemdetailsCausesItem(TypedDict, total=False):
    code: Required[str]
    """ Required property """

    engine: str
    retryable: bool


class _ProblemdetailsViolationsItem(TypedDict, total=False):
    field: Required[str]
    """ Required property """

    rule: Required[str]
    """ Required property """

    message: str
