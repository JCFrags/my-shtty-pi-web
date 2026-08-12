from typing import Literal, Required, TypedDict


class Pagerecord(TypedDict, total=False):
    """ PageRecord. """

    schema_version: Required[Literal['1.0']]
    """ Required property """

    page_id: Required[str]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    canonical_url: Required["_CommonFullStopJsonNumberSignDefsUrl"]
    """
    format: uri
    maxLength: 8192

    Required property
    """

    url_key: Required[str]
    """
    minLength: 1
    maxLength: 8192

    Required property
    """

    domain: str
    """ maxLength: 253 """

    collection: Required[str]
    """
    pattern: ^[a-z0-9][a-z0-9_-]{0,63}$

    Required property
    """

    visibility: Required["_PagerecordVisibility"]
    """ Required property """

    current_version_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    first_visit_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    last_visit_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    version_count: int
    """ minimum: 0 """

    tags: list["_CommonFullStopJsonNumberSignDefsTag"]
    """ uniqueItems: True """

    created_at: Required[str]
    """
    format: date-time

    Required property
    """

    updated_at: Required[str]
    """
    format: date-time

    Required property
    """

    tombstoned: Required[bool]
    """ Required property """

    tombstoned_at: str
    """ format: date-time """

    tombstone_reason: str
    """ maxLength: 2000 """



_CommonFullStopJsonNumberSignDefsTag = str
""" pattern: ^[a-z0-9][a-z0-9._/-]{0,63}$ """



_CommonFullStopJsonNumberSignDefsUrl = str
"""
format: uri
maxLength: 8192
"""



_PagerecordVisibility = Literal['public'] | Literal['internal'] | Literal['private'] | Literal['secret']
_PAGERECORDVISIBILITY_PUBLIC: Literal['public'] = "public"
"""The values for the '_PagerecordVisibility' enum"""
_PAGERECORDVISIBILITY_INTERNAL: Literal['internal'] = "internal"
"""The values for the '_PagerecordVisibility' enum"""
_PAGERECORDVISIBILITY_PRIVATE: Literal['private'] = "private"
"""The values for the '_PagerecordVisibility' enum"""
_PAGERECORDVISIBILITY_SECRET: Literal['secret'] = "secret"
"""The values for the '_PagerecordVisibility' enum"""
