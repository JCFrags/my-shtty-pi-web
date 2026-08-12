from typing import Any, Literal, Required, TypedDict


class Visitrecord(TypedDict, total=False):
    """ VisitRecord. """

    schema_version: Required[Literal['1.0']]
    """ Required property """

    visit_id: Required[str]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    job_id: Required[str]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    crawl_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    parent_visit_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    requested_url: Required["_CommonFullStopJsonNumberSignDefsUrl"]
    """
    format: uri
    maxLength: 8192

    Required property
    """

    normalized_requested_url: "_CommonFullStopJsonNumberSignDefsUrl"
    """
    format: uri
    maxLength: 8192
    """

    final_url: "_CommonFullStopJsonNumberSignDefsUrl"
    """
    format: uri
    maxLength: 8192
    """

    page_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    version_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    operation: Required["_VisitrecordOperation"]
    """ Required property """

    mode: str
    engine: str
    state: Required["_VisitrecordState"]
    """ Required property """

    network_attempted: Required[bool]
    """ Required property """

    http_status: int
    """
    minimum: 100
    maximum: 599
    """

    redirect_chain: list["_VisitrecordRedirectChainItem"]
    """ maxItems: 20 """

    error_code: str
    """ pattern: ^WEBX_[A-Z0-9_]+$ """

    receipt_artifact_id: Required[str]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    raw_artifact_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    markdown_artifact_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    visibility: Required["_VisitrecordVisibility"]
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

    duration_ms: int
    """ minimum: 0 """

    warnings: list["_CommonFullStopJsonNumberSignDefsWarning"]


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



_VisitrecordOperation = Literal['fetch'] | Literal['verify'] | Literal['browser_navigate'] | Literal['crawl_target'] | Literal['watch_check'] | Literal['archive_capture'] | Literal['media_info'] | Literal['document_url']
_VISITRECORDOPERATION_FETCH: Literal['fetch'] = "fetch"
"""The values for the '_VisitrecordOperation' enum"""
_VISITRECORDOPERATION_VERIFY: Literal['verify'] = "verify"
"""The values for the '_VisitrecordOperation' enum"""
_VISITRECORDOPERATION_BROWSER_NAVIGATE: Literal['browser_navigate'] = "browser_navigate"
"""The values for the '_VisitrecordOperation' enum"""
_VISITRECORDOPERATION_CRAWL_TARGET: Literal['crawl_target'] = "crawl_target"
"""The values for the '_VisitrecordOperation' enum"""
_VISITRECORDOPERATION_WATCH_CHECK: Literal['watch_check'] = "watch_check"
"""The values for the '_VisitrecordOperation' enum"""
_VISITRECORDOPERATION_ARCHIVE_CAPTURE: Literal['archive_capture'] = "archive_capture"
"""The values for the '_VisitrecordOperation' enum"""
_VISITRECORDOPERATION_MEDIA_INFO: Literal['media_info'] = "media_info"
"""The values for the '_VisitrecordOperation' enum"""
_VISITRECORDOPERATION_DOCUMENT_URL: Literal['document_url'] = "document_url"
"""The values for the '_VisitrecordOperation' enum"""



class _VisitrecordRedirectChainItem(TypedDict, total=False):
    url: Required["_CommonFullStopJsonNumberSignDefsUrl"]
    """
    format: uri
    maxLength: 8192

    Required property
    """

    status: int
    """
    minimum: 100
    maximum: 599
    """

    location: "_CommonFullStopJsonNumberSignDefsUrl"
    """
    format: uri
    maxLength: 8192
    """

    resolved_ip_class: str


_VisitrecordState = Literal['succeeded'] | Literal['partial'] | Literal['failed'] | Literal['cancelled'] | Literal['policy_denied']
_VISITRECORDSTATE_SUCCEEDED: Literal['succeeded'] = "succeeded"
"""The values for the '_VisitrecordState' enum"""
_VISITRECORDSTATE_PARTIAL: Literal['partial'] = "partial"
"""The values for the '_VisitrecordState' enum"""
_VISITRECORDSTATE_FAILED: Literal['failed'] = "failed"
"""The values for the '_VisitrecordState' enum"""
_VISITRECORDSTATE_CANCELLED: Literal['cancelled'] = "cancelled"
"""The values for the '_VisitrecordState' enum"""
_VISITRECORDSTATE_POLICY_DENIED: Literal['policy_denied'] = "policy_denied"
"""The values for the '_VisitrecordState' enum"""



_VisitrecordVisibility = Literal['public'] | Literal['internal'] | Literal['private'] | Literal['secret']
_VISITRECORDVISIBILITY_PUBLIC: Literal['public'] = "public"
"""The values for the '_VisitrecordVisibility' enum"""
_VISITRECORDVISIBILITY_INTERNAL: Literal['internal'] = "internal"
"""The values for the '_VisitrecordVisibility' enum"""
_VISITRECORDVISIBILITY_PRIVATE: Literal['private'] = "private"
"""The values for the '_VisitrecordVisibility' enum"""
_VISITRECORDVISIBILITY_SECRET: Literal['secret'] = "secret"
"""The values for the '_VisitrecordVisibility' enum"""
