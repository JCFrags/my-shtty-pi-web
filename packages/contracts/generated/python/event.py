from typing import Any, Literal, Required, TypedDict


class Eventenvelope(TypedDict, total=False):
    """ EventEnvelope. """

    schema_version: Required[Literal['1.0']]
    """ Required property """

    event_id: Required[str]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    event_type: Required[str]
    """
    pattern: ^[a-z][a-z0-9_.]+$

    Required property
    """

    occurred_at: Required[str]
    """
    format: date-time

    Required property
    """

    recorded_at: Required[str]
    """
    format: date-time

    Required property
    """

    producer: Required[str]
    """ Required property """

    trace_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    actor_id: str
    aggregate_type: Required[str]
    """ Required property """

    aggregate_id: Required[str]
    """ Required property """

    sequence: Required[int]
    """
    minimum: 1

    Required property
    """

    visibility: Required["_EventenvelopeVisibility"]
    """ Required property """

    payload: Required[dict[str, Any]]
    """ Required property """

    extensions: dict[str, Any]


_EventenvelopeVisibility = Literal['public'] | Literal['internal'] | Literal['private'] | Literal['secret']
_EVENTENVELOPEVISIBILITY_PUBLIC: Literal['public'] = "public"
"""The values for the '_EventenvelopeVisibility' enum"""
_EVENTENVELOPEVISIBILITY_INTERNAL: Literal['internal'] = "internal"
"""The values for the '_EventenvelopeVisibility' enum"""
_EVENTENVELOPEVISIBILITY_PRIVATE: Literal['private'] = "private"
"""The values for the '_EventenvelopeVisibility' enum"""
_EVENTENVELOPEVISIBILITY_SECRET: Literal['secret'] = "secret"
"""The values for the '_EventenvelopeVisibility' enum"""
