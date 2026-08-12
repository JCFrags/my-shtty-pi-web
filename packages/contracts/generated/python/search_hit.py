from typing import Literal, Required, TypedDict


class Searchhit(TypedDict, total=False):
    """ SearchHit. """

    hit_id: Required[str]
    """
    minLength: 1
    maxLength: 300

    Required property
    """

    source: Required["_SearchhitSource"]
    """ Required property """

    provider: str
    """ maxLength: 100 """

    title: Required[str]
    """
    maxLength: 4000

    Required property
    """

    url: Required["_CommonFullStopJsonNumberSignDefsUrl"]
    """
    format: uri
    maxLength: 8192

    Required property
    """

    canonical_url: "_CommonFullStopJsonNumberSignDefsUrl"
    """
    format: uri
    maxLength: 8192
    """

    snippet: str
    """ maxLength: 10000 """

    rank: Required[int]
    """
    minimum: 1

    Required property
    """

    source_score: int | float
    fusion_score: int | float
    published_at: str
    """ format: date-time """

    visited_at: str
    """ format: date-time """

    changed_at: str
    """ format: date-time """

    page_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    version_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    artifact_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    collection: str
    visibility: "_SearchhitVisibility"
    language: str
    mime_type: str
    domain: str
    tags: list["_CommonFullStopJsonNumberSignDefsTag"]
    evidence_kind: Required["_SearchhitEvidenceKind"]
    """ Required property """

    retrieved_at: Required[str]
    """
    format: date-time

    Required property
    """



_CommonFullStopJsonNumberSignDefsTag = str
""" pattern: ^[a-z0-9][a-z0-9._/-]{0,63}$ """



_CommonFullStopJsonNumberSignDefsUrl = str
"""
format: uri
maxLength: 8192
"""



_SearchhitEvidenceKind = Literal['discovery_snippet'] | Literal['live_page'] | Literal['archived_page'] | Literal['local_document'] | Literal['derived_chunk']
_SEARCHHITEVIDENCEKIND_DISCOVERY_SNIPPET: Literal['discovery_snippet'] = "discovery_snippet"
"""The values for the '_SearchhitEvidenceKind' enum"""
_SEARCHHITEVIDENCEKIND_LIVE_PAGE: Literal['live_page'] = "live_page"
"""The values for the '_SearchhitEvidenceKind' enum"""
_SEARCHHITEVIDENCEKIND_ARCHIVED_PAGE: Literal['archived_page'] = "archived_page"
"""The values for the '_SearchhitEvidenceKind' enum"""
_SEARCHHITEVIDENCEKIND_LOCAL_DOCUMENT: Literal['local_document'] = "local_document"
"""The values for the '_SearchhitEvidenceKind' enum"""
_SEARCHHITEVIDENCEKIND_DERIVED_CHUNK: Literal['derived_chunk'] = "derived_chunk"
"""The values for the '_SearchhitEvidenceKind' enum"""



_SearchhitSource = Literal['searxng'] | Literal['meilisearch'] | Literal['yacy'] | Literal['crossref'] | Literal['arxiv'] | Literal['pubmed'] | Literal['commoncrawl']
_SEARCHHITSOURCE_SEARXNG: Literal['searxng'] = "searxng"
"""The values for the '_SearchhitSource' enum"""
_SEARCHHITSOURCE_MEILISEARCH: Literal['meilisearch'] = "meilisearch"
"""The values for the '_SearchhitSource' enum"""
_SEARCHHITSOURCE_YACY: Literal['yacy'] = "yacy"
"""The values for the '_SearchhitSource' enum"""
_SEARCHHITSOURCE_CROSSREF: Literal['crossref'] = "crossref"
"""The values for the '_SearchhitSource' enum"""
_SEARCHHITSOURCE_ARXIV: Literal['arxiv'] = "arxiv"
"""The values for the '_SearchhitSource' enum"""
_SEARCHHITSOURCE_PUBMED: Literal['pubmed'] = "pubmed"
"""The values for the '_SearchhitSource' enum"""
_SEARCHHITSOURCE_COMMONCRAWL: Literal['commoncrawl'] = "commoncrawl"
"""The values for the '_SearchhitSource' enum"""



_SearchhitVisibility = Literal['public'] | Literal['internal'] | Literal['private'] | Literal['secret']
_SEARCHHITVISIBILITY_PUBLIC: Literal['public'] = "public"
"""The values for the '_SearchhitVisibility' enum"""
_SEARCHHITVISIBILITY_INTERNAL: Literal['internal'] = "internal"
"""The values for the '_SearchhitVisibility' enum"""
_SEARCHHITVISIBILITY_PRIVATE: Literal['private'] = "private"
"""The values for the '_SearchhitVisibility' enum"""
_SEARCHHITVISIBILITY_SECRET: Literal['secret'] = "secret"
"""The values for the '_SearchhitVisibility' enum"""
