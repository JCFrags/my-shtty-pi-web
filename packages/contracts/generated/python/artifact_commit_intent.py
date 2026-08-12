from typing import Literal, Required, TypedDict


class Artifactcommitintent(TypedDict, total=False):
    """
    ArtifactCommitIntent.

    The durable journal record that bridges a verified same-filesystem artifact tree rename and publication of its SQLite facts and outbox rows.

    $comment: Application validation MUST apply semantics/artifact-commit-intent-semantics.json. JSON Schema alone cannot enforce unique expected_files.relative_path values or prior-to-next state transitions.
    allOf:
      - if:
          properties:
            intent_kind:
              const: visit_receipt
          required:
          - intent_kind
        then:
          properties:
            final_relative_path:
              pattern: ^visits/
      - if:
          properties:
            intent_kind:
              const: page_version
          required:
          - intent_kind
        then:
          properties:
            final_relative_path:
              pattern: ^pages/
      - if:
          properties:
            intent_kind:
              const: artifact_set
          required:
          - intent_kind
        then:
          properties:
            final_relative_path:
              pattern: ^artifacts/
      - if:
          properties:
            intent_kind:
              const: wiki_envelope
          required:
          - intent_kind
        then:
          properties:
            final_relative_path:
              pattern: ^wiki/outbox/
      - if:
          properties:
            state:
              enum:
              - renamed
              - published
              - completed
          required:
          - state
        then:
          required:
          - renamed_at
      - if:
          properties:
            state:
              enum:
              - published
              - completed
          required:
          - state
        then:
          required:
          - published_at
          - published_reference_type
          - published_reference_id
          - publication_idempotency_key
      - if:
          properties:
            state:
              const: completed
          required:
          - state
        then:
          required:
          - completed_at
      - if:
          properties:
            state:
              const: quarantined
          required:
          - state
        then:
          required:
          - quarantined_at
          - quarantine_paths
          - quarantine_reason_code
    """

    schema_version: Required[Literal['1.0']]
    """ Required property """

    commit_intent_id: Required["_CommonFullStopJsonNumberSignDefsUlid"]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    job_id: Required["_CommonFullStopJsonNumberSignDefsUlid"]
    """
    pattern: ^[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    attempt_id: "_CommonFullStopJsonNumberSignDefsUlid"
    """ pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """

    intent_kind: Required["_ArtifactcommitintentIntentKind"]
    """ Required property """

    idempotency_key: Required[str]
    """
    minLength: 8
    maxLength: 300

    Required property
    """

    state: Required["_ArtifactcommitintentState"]
    """ Required property """

    staging_relative_path: Required["_StagingPath"]
    """
    maxLength: 2048
    pattern: ^staging/commit-intents/[0-9a-hjkmnp-tv-z]{26}$

    Required property
    """

    final_relative_path: Required["_FinalPath"]
    """
    maxLength: 2048
    pattern: ^(?:visits|pages|artifacts|wiki/outbox)/(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))(?!.*//)[A-Za-z0-9._/-]+$

    Required property
    """

    manifest_sha256: Required["_CommonFullStopJsonNumberSignDefsSha256"]
    """
    pattern: ^[0-9a-f]{64}$

    Required property
    """

    expected_files: Required[list["_ArtifactcommitintentExpectedFilesItem"]]
    """
    $comment: Every relative_path MUST be unique. The mandatory semantic validator rejects duplicates before persistence or recovery.
    uniqueItems: True
    minItems: 1
    maxItems: 100000

    Required property
    """

    published_reference_type: "_ArtifactcommitintentPublishedReferenceType"
    published_reference_id: str
    """
    minLength: 1
    maxLength: 300
    """

    publication_idempotency_key: str
    """ pattern: ^commit-intent:[0-9a-hjkmnp-tv-z]{26}$ """

    recovery_count: Required[int]
    """
    minimum: 0

    Required property
    """

    last_verified_at: "_CommonFullStopJsonNumberSignDefsTimestamp"
    """ format: date-time """

    created_at: Required["_CommonFullStopJsonNumberSignDefsTimestamp"]
    """
    format: date-time

    Required property
    """

    updated_at: Required["_CommonFullStopJsonNumberSignDefsTimestamp"]
    """
    format: date-time

    Required property
    """

    renamed_at: "_CommonFullStopJsonNumberSignDefsTimestamp"
    """ format: date-time """

    published_at: "_CommonFullStopJsonNumberSignDefsTimestamp"
    """ format: date-time """

    completed_at: "_CommonFullStopJsonNumberSignDefsTimestamp"
    """ format: date-time """

    quarantined_at: "_CommonFullStopJsonNumberSignDefsTimestamp"
    """ format: date-time """

    quarantine_paths: list["_QuarantinePath"]
    """
    minItems: 1
    maxItems: 2
    uniqueItems: True
    """

    quarantine_reason_code: "_ArtifactcommitintentQuarantineReasonCode"
    quarantine_safe_detail: str
    """
    minLength: 1
    maxLength: 500
    pattern: ^[^\\r\\n\\u0000-\\u001f\\u007f]+$
    """



class _ArtifactcommitintentExpectedFilesItem(TypedDict, total=False):
    relative_path: Required["_SafeRelativePath"]
    """
    minLength: 1
    maxLength: 2048
    pattern: ^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))(?!.*//)[A-Za-z0-9._/-]+$

    Required property
    """

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



_ArtifactcommitintentIntentKind = Literal['visit_receipt'] | Literal['page_version'] | Literal['artifact_set'] | Literal['wiki_envelope']
_ARTIFACTCOMMITINTENTINTENTKIND_VISIT_RECEIPT: Literal['visit_receipt'] = "visit_receipt"
"""The values for the '_ArtifactcommitintentIntentKind' enum"""
_ARTIFACTCOMMITINTENTINTENTKIND_PAGE_VERSION: Literal['page_version'] = "page_version"
"""The values for the '_ArtifactcommitintentIntentKind' enum"""
_ARTIFACTCOMMITINTENTINTENTKIND_ARTIFACT_SET: Literal['artifact_set'] = "artifact_set"
"""The values for the '_ArtifactcommitintentIntentKind' enum"""
_ARTIFACTCOMMITINTENTINTENTKIND_WIKI_ENVELOPE: Literal['wiki_envelope'] = "wiki_envelope"
"""The values for the '_ArtifactcommitintentIntentKind' enum"""



_ArtifactcommitintentPublishedReferenceType = Literal['visit'] | Literal['page_version'] | Literal['artifact'] | Literal['wiki_delivery']
_ARTIFACTCOMMITINTENTPUBLISHEDREFERENCETYPE_VISIT: Literal['visit'] = "visit"
"""The values for the '_ArtifactcommitintentPublishedReferenceType' enum"""
_ARTIFACTCOMMITINTENTPUBLISHEDREFERENCETYPE_PAGE_VERSION: Literal['page_version'] = "page_version"
"""The values for the '_ArtifactcommitintentPublishedReferenceType' enum"""
_ARTIFACTCOMMITINTENTPUBLISHEDREFERENCETYPE_ARTIFACT: Literal['artifact'] = "artifact"
"""The values for the '_ArtifactcommitintentPublishedReferenceType' enum"""
_ARTIFACTCOMMITINTENTPUBLISHEDREFERENCETYPE_WIKI_DELIVERY: Literal['wiki_delivery'] = "wiki_delivery"
"""The values for the '_ArtifactcommitintentPublishedReferenceType' enum"""



_ArtifactcommitintentQuarantineReasonCode = Literal['STAGING_MISSING'] | Literal['FINAL_MISSING'] | Literal['HASH_MISMATCH'] | Literal['MANIFEST_MISMATCH'] | Literal['PATH_CONFLICT'] | Literal['AMBIGUOUS_CANDIDATES'] | Literal['UNSAFE_PATH'] | Literal['PUBLICATION_CONFLICT'] | Literal['RECOVERY_INVARIANT_VIOLATION']
_ARTIFACTCOMMITINTENTQUARANTINEREASONCODE_STAGING_MISSING: Literal['STAGING_MISSING'] = "STAGING_MISSING"
"""The values for the '_ArtifactcommitintentQuarantineReasonCode' enum"""
_ARTIFACTCOMMITINTENTQUARANTINEREASONCODE_FINAL_MISSING: Literal['FINAL_MISSING'] = "FINAL_MISSING"
"""The values for the '_ArtifactcommitintentQuarantineReasonCode' enum"""
_ARTIFACTCOMMITINTENTQUARANTINEREASONCODE_HASH_MISMATCH: Literal['HASH_MISMATCH'] = "HASH_MISMATCH"
"""The values for the '_ArtifactcommitintentQuarantineReasonCode' enum"""
_ARTIFACTCOMMITINTENTQUARANTINEREASONCODE_MANIFEST_MISMATCH: Literal['MANIFEST_MISMATCH'] = "MANIFEST_MISMATCH"
"""The values for the '_ArtifactcommitintentQuarantineReasonCode' enum"""
_ARTIFACTCOMMITINTENTQUARANTINEREASONCODE_PATH_CONFLICT: Literal['PATH_CONFLICT'] = "PATH_CONFLICT"
"""The values for the '_ArtifactcommitintentQuarantineReasonCode' enum"""
_ARTIFACTCOMMITINTENTQUARANTINEREASONCODE_AMBIGUOUS_CANDIDATES: Literal['AMBIGUOUS_CANDIDATES'] = "AMBIGUOUS_CANDIDATES"
"""The values for the '_ArtifactcommitintentQuarantineReasonCode' enum"""
_ARTIFACTCOMMITINTENTQUARANTINEREASONCODE_UNSAFE_PATH: Literal['UNSAFE_PATH'] = "UNSAFE_PATH"
"""The values for the '_ArtifactcommitintentQuarantineReasonCode' enum"""
_ARTIFACTCOMMITINTENTQUARANTINEREASONCODE_PUBLICATION_CONFLICT: Literal['PUBLICATION_CONFLICT'] = "PUBLICATION_CONFLICT"
"""The values for the '_ArtifactcommitintentQuarantineReasonCode' enum"""
_ARTIFACTCOMMITINTENTQUARANTINEREASONCODE_RECOVERY_INVARIANT_VIOLATION: Literal['RECOVERY_INVARIANT_VIOLATION'] = "RECOVERY_INVARIANT_VIOLATION"
"""The values for the '_ArtifactcommitintentQuarantineReasonCode' enum"""



_ArtifactcommitintentState = Literal['prepared'] | Literal['renamed'] | Literal['published'] | Literal['completed'] | Literal['quarantined']
_ARTIFACTCOMMITINTENTSTATE_PREPARED: Literal['prepared'] = "prepared"
"""The values for the '_ArtifactcommitintentState' enum"""
_ARTIFACTCOMMITINTENTSTATE_RENAMED: Literal['renamed'] = "renamed"
"""The values for the '_ArtifactcommitintentState' enum"""
_ARTIFACTCOMMITINTENTSTATE_PUBLISHED: Literal['published'] = "published"
"""The values for the '_ArtifactcommitintentState' enum"""
_ARTIFACTCOMMITINTENTSTATE_COMPLETED: Literal['completed'] = "completed"
"""The values for the '_ArtifactcommitintentState' enum"""
_ARTIFACTCOMMITINTENTSTATE_QUARANTINED: Literal['quarantined'] = "quarantined"
"""The values for the '_ArtifactcommitintentState' enum"""



_CommonFullStopJsonNumberSignDefsSha256 = str
""" pattern: ^[0-9a-f]{64}$ """



_CommonFullStopJsonNumberSignDefsTimestamp = str
""" format: date-time """



_CommonFullStopJsonNumberSignDefsUlid = str
""" pattern: ^[0-9a-hjkmnp-tv-z]{26}$ """



_FinalPath = str
"""
maxLength: 2048
pattern: ^(?:visits|pages|artifacts|wiki/outbox)/(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))(?!.*//)[A-Za-z0-9._/-]+$
"""



_QuarantinePath = str
"""
maxLength: 2048
pattern: ^quarantine/commit-intents/[0-9a-hjkmnp-tv-z]{26}(?:/[A-Za-z0-9._/-]+)?$
"""



_SafeRelativePath = str
"""
minLength: 1
maxLength: 2048
pattern: ^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))(?!.*//)[A-Za-z0-9._/-]+$
"""



_StagingPath = str
"""
maxLength: 2048
pattern: ^staging/commit-intents/[0-9a-hjkmnp-tv-z]{26}$
"""
