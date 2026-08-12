from typing import Any, Literal, Required, TypedDict


class Normalizedcontentresult(TypedDict, total=False):
    """
    NormalizedContentResult.

    A strict inert result from an isolated hostile-content worker. Raw or active source content is referenced only as staged evidence and is never embedded in this result.
    """

    schema_version: Required[Literal['1.0']]
    """ Required property """

    result_kind: Required[Literal['normalized_content']]
    """ Required property """

    attempt_id: Required["_CommonFullStopJsonNumberSignDefsUlid"]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    observation_id: Required["_CommonFullStopJsonNumberSignDefsUlid"]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    state: Required["_NormalizedcontentresultState"]
    """ Required property """

    source: Required["_NormalizedcontentresultSource"]
    """ Required property """

    normalized_markdown: Required["_NormalizedcontentresultNormalizedMarkdown"]
    """
    A daemon-controlled staging handle for UTF-8 LF Markdown. The trusted daemon validates and hashes this inert text but does not parse raw HTML.

    Required property
    """

    metadata: Required["_NormalizedcontentresultMetadata"]
    """ Required property """

    links: Required[list["_NormalizedcontentresultLinksItem"]]
    """
    maxItems: 10000

    Required property
    """

    quality: Required["_NormalizedcontentresultQuality"]
    """ Required property """

    provenance: Required["_NormalizedcontentresultProvenance"]
    """ Required property """

    trust: Required[Literal['untrusted_external_source']]
    """ Required property """

    security_labels: list["_NormalizedcontentresultSecurityLabelsItem"]
    """
    uniqueItems: True
    maxItems: 100
    """

    raw_evidence: Required[list["_NormalizedcontentresultRawEvidenceItem"]]
    """
    Staged raw evidence handles. These bytes can be retained or quarantined but are not trusted-daemon parse input.

    maxItems: 20

    Required property
    """

    warnings: Required[list["_CommonFullStopJsonNumberSignDefsWarning"]]
    """
    maxItems: 100

    Required property
    """



_CommonFullStopJsonNumberSignDefsSha256 = str
""" pattern: ^[0-9a-f]{64}$ """



_CommonFullStopJsonNumberSignDefsUlid = str
""" pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """



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



class _NormalizedcontentresultLinksItem(TypedDict, total=False):
    ordinal: Required[int]
    """
    minimum: 0

    Required property
    """

    url: Required["_CommonFullStopJsonNumberSignDefsUrl"]
    """
    format: uri
    maxLength: 8192

    Required property
    """

    text: str
    """ maxLength: 4000 """

    rel: str
    """ maxLength: 1000 """

    same_origin: Required[bool]
    """ Required property """

    nofollow: Required[bool]
    """ Required property """



class _NormalizedcontentresultMetadata(TypedDict, total=False):
    title: Required[str | None]
    """
    maxLength: 4000

    Required property
    """

    description: str | None
    """ maxLength: 10000 """

    authors: list["_NormalizedcontentresultMetadataAuthorsItem"]
    """ maxItems: 100 """

    language: Required[str | None]
    """
    maxLength: 35

    Required property
    """

    published_at: str | None
    """ format: date-time """

    modified_at: str | None
    """ format: date-time """

    word_count: Required[int]
    """
    minimum: 0

    Required property
    """

    character_count: Required[int]
    """
    minimum: 0

    Required property
    """



_NormalizedcontentresultMetadataAuthorsItem = str
"""
minLength: 1
maxLength: 1000
"""



class _NormalizedcontentresultNormalizedMarkdown(TypedDict, total=False):
    """ A daemon-controlled staging handle for UTF-8 LF Markdown. The trusted daemon validates and hashes this inert text but does not parse raw HTML. """

    handle_id: Required["_CommonFullStopJsonNumberSignDefsUlid"]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    slot: Required[Literal['normalized_markdown']]
    """ Required property """

    sha256: Required["_CommonFullStopJsonNumberSignDefsSha256"]
    """
    pattern: ^[0-9a-f]{64}$

    Required property
    """

    size_bytes: Required[int]
    """
    minimum: 1
    maximum: 16777216

    Required property
    """

    mime_type: Required[Literal['text/markdown']]
    """ Required property """

    encoding: Required[Literal['utf-8']]
    """ Required property """



class _NormalizedcontentresultProvenance(TypedDict, total=False):
    worker_id: Required[str]
    """
    minLength: 1
    maxLength: 255

    Required property
    """

    engine: Required[str]
    """
    minLength: 1
    maxLength: 100

    Required property
    """

    engine_version: Required[str]
    """
    minLength: 1
    maxLength: 200

    Required property
    """

    extractor_chain: Required[list["_NormalizedcontentresultProvenanceExtractorChainItem"]]
    """
    minItems: 1
    maxItems: 20

    Required property
    """

    sanitizer_version: Required[str]
    """
    minLength: 1
    maxLength: 200

    Required property
    """

    normalizer_version: Required[str]
    """
    minLength: 1
    maxLength: 200

    Required property
    """



_NormalizedcontentresultProvenanceExtractorChainItem = str
"""
minLength: 1
maxLength: 200
"""



class _NormalizedcontentresultQuality(TypedDict, total=False):
    score: Required[int | float]
    """
    minimum: 0
    maximum: 1

    Required property
    """

    main_content_ratio: int | float
    """
    minimum: 0
    maximum: 1
    """

    challenge_detected: Required[bool]
    """ Required property """

    schema_valid: Required[Literal[True]]
    """ Required property """



class _NormalizedcontentresultRawEvidenceItem(TypedDict, total=False):
    handle_id: Required["_CommonFullStopJsonNumberSignDefsUlid"]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    slot: Required["_NormalizedcontentresultRawEvidenceItemSlot"]
    """ Required property """

    sha256: Required["_CommonFullStopJsonNumberSignDefsSha256"]
    """
    pattern: ^[0-9a-f]{64}$

    Required property
    """

    size_bytes: Required[int]
    """
    minimum: 0

    Required property
    """

    mime_type: Required[str]
    """
    minLength: 1
    maxLength: 255

    Required property
    """



_NormalizedcontentresultRawEvidenceItemSlot = Literal['raw_response'] | Literal['rendered_html'] | Literal['source_document'] | Literal['screenshot'] | Literal['trace']
_NORMALIZEDCONTENTRESULTRAWEVIDENCEITEMSLOT_RAW_RESPONSE: Literal['raw_response'] = "raw_response"
"""The values for the '_NormalizedcontentresultRawEvidenceItemSlot' enum"""
_NORMALIZEDCONTENTRESULTRAWEVIDENCEITEMSLOT_RENDERED_HTML: Literal['rendered_html'] = "rendered_html"
"""The values for the '_NormalizedcontentresultRawEvidenceItemSlot' enum"""
_NORMALIZEDCONTENTRESULTRAWEVIDENCEITEMSLOT_SOURCE_DOCUMENT: Literal['source_document'] = "source_document"
"""The values for the '_NormalizedcontentresultRawEvidenceItemSlot' enum"""
_NORMALIZEDCONTENTRESULTRAWEVIDENCEITEMSLOT_SCREENSHOT: Literal['screenshot'] = "screenshot"
"""The values for the '_NormalizedcontentresultRawEvidenceItemSlot' enum"""
_NORMALIZEDCONTENTRESULTRAWEVIDENCEITEMSLOT_TRACE: Literal['trace'] = "trace"
"""The values for the '_NormalizedcontentresultRawEvidenceItemSlot' enum"""



_NormalizedcontentresultSecurityLabelsItem = str
""" pattern: ^[a-z][a-z0-9_]{0,79}$ """



class _NormalizedcontentresultSource(TypedDict, total=False):
    requested_url: Required["_CommonFullStopJsonNumberSignDefsUrl"]
    """
    format: uri
    maxLength: 8192

    Required property
    """

    normalized_requested_url: Required["_CommonFullStopJsonNumberSignDefsUrl"]
    """
    format: uri
    maxLength: 8192

    Required property
    """

    final_url: Required["_CommonFullStopJsonNumberSignDefsUrl"]
    """
    format: uri
    maxLength: 8192

    Required property
    """

    http_status: int
    """
    minimum: 100
    maximum: 599
    """

    mime_type: str
    """
    minLength: 1
    maxLength: 255
    """

    charset: str
    """
    minLength: 1
    maxLength: 80
    """



_NormalizedcontentresultState = Literal['succeeded'] | Literal['partial']
_NORMALIZEDCONTENTRESULTSTATE_SUCCEEDED: Literal['succeeded'] = "succeeded"
"""The values for the '_NormalizedcontentresultState' enum"""
_NORMALIZEDCONTENTRESULTSTATE_PARTIAL: Literal['partial'] = "partial"
"""The values for the '_NormalizedcontentresultState' enum"""
