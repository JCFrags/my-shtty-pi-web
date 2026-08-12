from typing import Literal, Required, TypedDict


class Job(TypedDict, total=False):
    """ Job. """

    schema_version: Required[Literal['1.0']]
    """ Required property """

    job_id: Required[str]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    parent_job_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    operation: Required[str]
    """ Required property """

    state: Required["_JobState"]
    """ Required property """

    phase: str
    priority: Required[int]
    """
    minimum: -1000
    maximum: 1000

    Required property
    """

    actor_id: Required[str]
    """
    maxLength: 255

    Required property
    """

    idempotency_key: str
    """
    minLength: 8
    maxLength: 128
    """

    request_hash: str
    """ pattern: ^[0-9a-f]{64}$ """

    capability: str
    resource_class: "_JobResourceClass"
    attempt: Required[int]
    """
    minimum: 0

    Required property
    """

    max_attempts: int
    """ minimum: 1 """

    progress: int | float
    """
    minimum: 0
    maximum: 1
    """

    not_before: str
    """ format: date-time """

    deadline_at: str
    """ format: date-time """

    lease_owner: str
    lease_expires_at: str
    """ format: date-time """

    cancel_requested: bool
    result_artifact_id: str
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    error_code: str
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

    started_at: str
    """ format: date-time """

    completed_at: str
    """ format: date-time """

    index_state: "_CommonFullStopJsonNumberSignDefsProjectionstate"
    wiki_state: "_CommonFullStopJsonNumberSignDefsProjectionstate"


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



_JobResourceClass = Literal['tiny'] | Literal['cpu'] | Literal['browser'] | Literal['gpu'] | Literal['io'] | Literal['archive']
_JOBRESOURCECLASS_TINY: Literal['tiny'] = "tiny"
"""The values for the '_JobResourceClass' enum"""
_JOBRESOURCECLASS_CPU: Literal['cpu'] = "cpu"
"""The values for the '_JobResourceClass' enum"""
_JOBRESOURCECLASS_BROWSER: Literal['browser'] = "browser"
"""The values for the '_JobResourceClass' enum"""
_JOBRESOURCECLASS_GPU: Literal['gpu'] = "gpu"
"""The values for the '_JobResourceClass' enum"""
_JOBRESOURCECLASS_IO: Literal['io'] = "io"
"""The values for the '_JobResourceClass' enum"""
_JOBRESOURCECLASS_ARCHIVE: Literal['archive'] = "archive"
"""The values for the '_JobResourceClass' enum"""



_JobState = Literal['queued'] | Literal['leased'] | Literal['running'] | Literal['retry_wait'] | Literal['succeeded'] | Literal['partial'] | Literal['failed'] | Literal['cancelled'] | Literal['dead_letter']
_JOBSTATE_QUEUED: Literal['queued'] = "queued"
"""The values for the '_JobState' enum"""
_JOBSTATE_LEASED: Literal['leased'] = "leased"
"""The values for the '_JobState' enum"""
_JOBSTATE_RUNNING: Literal['running'] = "running"
"""The values for the '_JobState' enum"""
_JOBSTATE_RETRY_WAIT: Literal['retry_wait'] = "retry_wait"
"""The values for the '_JobState' enum"""
_JOBSTATE_SUCCEEDED: Literal['succeeded'] = "succeeded"
"""The values for the '_JobState' enum"""
_JOBSTATE_PARTIAL: Literal['partial'] = "partial"
"""The values for the '_JobState' enum"""
_JOBSTATE_FAILED: Literal['failed'] = "failed"
"""The values for the '_JobState' enum"""
_JOBSTATE_CANCELLED: Literal['cancelled'] = "cancelled"
"""The values for the '_JobState' enum"""
_JOBSTATE_DEAD_LETTER: Literal['dead_letter'] = "dead_letter"
"""The values for the '_JobState' enum"""
