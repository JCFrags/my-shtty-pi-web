from typing import Any, Literal, Required, TypedDict


class Wikiintakeenvelope(TypedDict, total=False):
    """
    WikiIntakeEnvelope.

    allOf:
      - if:
          properties:
            operation:
              const: source_upsert
        then:
          properties:
            content:
              required:
              - markdown_artifact
              - content_sha256
            source:
              required:
              - version_id
      - if:
          properties:
            operation:
              const: source_tombstone
        then:
          properties:
            content:
              required:
              - tombstone_reason
    """

    schema_version: Required[Literal['1.0']]
    """ Required property """

    delivery_id: Required[str]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    consumer_id: Required[str]
    """
    pattern: ^[a-z0-9][a-z0-9_-]{0,63}$

    Required property
    """

    sequence: Required[int]
    """
    minimum: 1

    Required property
    """

    operation: Required["_WikiintakeenvelopeOperation"]
    """ Required property """

    idempotency_key: Required[str]
    """
    minLength: 8
    maxLength: 300

    Required property
    """

    supersedes_delivery_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    source: Required["_WikiintakeenvelopeSource"]
    """ Required property """

    content: Required["_WikiintakeenvelopeContent"]
    """ Required property """

    provenance: Required["_WikiintakeenvelopeProvenance"]
    """ Required property """

    created_at: Required[str]
    """
    format: date-time

    Required property
    """

    extensions: dict[str, Any]


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



_CommonFullStopJsonNumberSignDefsUrl = str
"""
format: uri
maxLength: 8192
"""



class _WikiintakeenvelopeContent(TypedDict, total=False):
    markdown_artifact: "_CommonFullStopJsonNumberSignDefsArtifactref"
    metadata_artifact: "_CommonFullStopJsonNumberSignDefsArtifactref"
    title: str
    """ maxLength: 4000 """

    language: str
    content_sha256: str
    """ pattern: ^[0-9a-f]{64}$ """

    tombstone_reason: str


_WikiintakeenvelopeOperation = Literal['source_upsert'] | Literal['source_tombstone']
_WIKIINTAKEENVELOPEOPERATION_SOURCE_UPSERT: Literal['source_upsert'] = "source_upsert"
"""The values for the '_WikiintakeenvelopeOperation' enum"""
_WIKIINTAKEENVELOPEOPERATION_SOURCE_TOMBSTONE: Literal['source_tombstone'] = "source_tombstone"
"""The values for the '_WikiintakeenvelopeOperation' enum"""



class _WikiintakeenvelopeProvenance(TypedDict, total=False):
    sanitizer_version: Required[str]
    """ Required property """

    normalizer_version: Required[str]
    """ Required property """

    extractor_chain: list[str]
    source_artifact_ids: list["_WikiintakeenvelopeProvenanceSourceArtifactIdsItem"]
    trust: Required[Literal['untrusted_external_source']]
    """ Required property """



_WikiintakeenvelopeProvenanceSourceArtifactIdsItem = str
""" pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """



class _WikiintakeenvelopeSource(TypedDict, total=False):
    page_id: Required[str]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    version_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    visit_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    canonical_url: Required["_CommonFullStopJsonNumberSignDefsUrl"]
    """
    format: uri
    maxLength: 8192

    Required property
    """

    collection: Required[str]
    """ Required property """

    visibility: Required["_WikiintakeenvelopeSourceVisibility"]
    """ Required property """

    source_kind: "_WikiintakeenvelopeSourceSourceKind"
    retrieved_at: str
    """ format: date-time """

    published_at: str
    """ format: date-time """



_WikiintakeenvelopeSourceSourceKind = Literal['live_web'] | Literal['archive'] | Literal['local_import'] | Literal['document'] | Literal['media_transcript']
_WIKIINTAKEENVELOPESOURCESOURCEKIND_LIVE_WEB: Literal['live_web'] = "live_web"
"""The values for the '_WikiintakeenvelopeSourceSourceKind' enum"""
_WIKIINTAKEENVELOPESOURCESOURCEKIND_ARCHIVE: Literal['archive'] = "archive"
"""The values for the '_WikiintakeenvelopeSourceSourceKind' enum"""
_WIKIINTAKEENVELOPESOURCESOURCEKIND_LOCAL_IMPORT: Literal['local_import'] = "local_import"
"""The values for the '_WikiintakeenvelopeSourceSourceKind' enum"""
_WIKIINTAKEENVELOPESOURCESOURCEKIND_DOCUMENT: Literal['document'] = "document"
"""The values for the '_WikiintakeenvelopeSourceSourceKind' enum"""
_WIKIINTAKEENVELOPESOURCESOURCEKIND_MEDIA_TRANSCRIPT: Literal['media_transcript'] = "media_transcript"
"""The values for the '_WikiintakeenvelopeSourceSourceKind' enum"""



_WikiintakeenvelopeSourceVisibility = Literal['public'] | Literal['internal'] | Literal['private'] | Literal['secret']
_WIKIINTAKEENVELOPESOURCEVISIBILITY_PUBLIC: Literal['public'] = "public"
"""The values for the '_WikiintakeenvelopeSourceVisibility' enum"""
_WIKIINTAKEENVELOPESOURCEVISIBILITY_INTERNAL: Literal['internal'] = "internal"
"""The values for the '_WikiintakeenvelopeSourceVisibility' enum"""
_WIKIINTAKEENVELOPESOURCEVISIBILITY_PRIVATE: Literal['private'] = "private"
"""The values for the '_WikiintakeenvelopeSourceVisibility' enum"""
_WIKIINTAKEENVELOPESOURCEVISIBILITY_SECRET: Literal['secret'] = "secret"
"""The values for the '_WikiintakeenvelopeSourceVisibility' enum"""
