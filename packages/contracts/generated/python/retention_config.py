from typing import Any, Required, TypedDict, Union


class WebxRetentionConfiguration(TypedDict, total=False):
    """
    WebX retention configuration.

    $comment: Normative structural schema generated from the canonical example. The typed loader also enforces documented cross-field semantic rules.
    """

    schema_version: Required[int]
    """ Required property """

    defaults: Required["_WebxRetentionConfigurationDefaults"]
    """ Required property """

    collection_overrides: Required[Union[dict[str, dict[str, Any]], "_WebxRetentionConfigurationCollectionOverridesTyped"]]
    """

    WARNING: Normally the types should be a mix of each other instead of Union.
    See: https://github.com/camptocamp/jsonschema-gentypes/issues/7

    Required property
    """

    rules: Required[list[str]]
    """ Required property """



class _WebxRetentionConfigurationCollectionOverridesPrivate(TypedDict, total=False):
    wiki_delivery: Required["_WebxRetentionConfigurationCollectionOverridesPrivateWikiDelivery"]
    """ Required property """

    search_projection: Required["_WebxRetentionConfigurationCollectionOverridesPrivateSearchProjection"]
    """ Required property """



class _WebxRetentionConfigurationCollectionOverridesPrivateSearchProjection(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """



class _WebxRetentionConfigurationCollectionOverridesPrivateWikiDelivery(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """



class _WebxRetentionConfigurationCollectionOverridesTemporaryResearch(TypedDict, total=False):
    raw_html: Required["_WebxRetentionConfigurationCollectionOverridesTemporaryResearchRawHtml"]
    """ Required property """

    screenshot: Required["_WebxRetentionConfigurationCollectionOverridesTemporaryResearchScreenshot"]
    """ Required property """



class _WebxRetentionConfigurationCollectionOverridesTemporaryResearchRawHtml(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationCollectionOverridesTemporaryResearchScreenshot(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



_WebxRetentionConfigurationCollectionOverridesTyped = TypedDict('_WebxRetentionConfigurationCollectionOverridesTyped', {
    # | Required property
    'default': Required[dict[str, Any]],
    # | Required property
    'temporary-research': Required["_WebxRetentionConfigurationCollectionOverridesTemporaryResearch"],
    # | Required property
    'private': Required["_WebxRetentionConfigurationCollectionOverridesPrivate"],
}, total=False)


class _WebxRetentionConfigurationDefaults(TypedDict, total=False):
    visit_markdown: Required["_WebxRetentionConfigurationDefaultsVisitMarkdown"]
    """ Required property """

    page_markdown: Required["_WebxRetentionConfigurationDefaultsPageMarkdown"]
    """ Required property """

    page_metadata_json: Required["_WebxRetentionConfigurationDefaultsPageMetadataJson"]
    """ Required property """

    raw_html: Required["_WebxRetentionConfigurationDefaultsRawHtml"]
    """ Required property """

    raw_http_headers: Required["_WebxRetentionConfigurationDefaultsRawHttpHeaders"]
    """ Required property """

    screenshot: Required["_WebxRetentionConfigurationDefaultsScreenshot"]
    """ Required property """

    browser_trace: Required["_WebxRetentionConfigurationDefaultsBrowserTrace"]
    """ Required property """

    failed_response_body: Required["_WebxRetentionConfigurationDefaultsFailedResponseBody"]
    """ Required property """

    media_metadata: Required["_WebxRetentionConfigurationDefaultsMediaMetadata"]
    """ Required property """

    acquired_media: Required["_WebxRetentionConfigurationDefaultsAcquiredMedia"]
    """ Required property """

    transcript: Required["_WebxRetentionConfigurationDefaultsTranscript"]
    """ Required property """

    document_source: Required["_WebxRetentionConfigurationDefaultsDocumentSource"]
    """ Required property """

    derived_ai_output: Required["_WebxRetentionConfigurationDefaultsDerivedAiOutput"]
    """ Required property """

    job_logs: Required["_WebxRetentionConfigurationDefaultsJobLogs"]
    """ Required property """

    audit_log: Required["_WebxRetentionConfigurationDefaultsAuditLog"]
    """ Required property """

    search_projection: Required["_WebxRetentionConfigurationDefaultsSearchProjection"]
    """ Required property """

    model_prompt_diagnostics: Required["_WebxRetentionConfigurationDefaultsModelPromptDiagnostics"]
    """ Required property """



class _WebxRetentionConfigurationDefaultsAcquiredMedia(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsAuditLog(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsBrowserTrace(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsDerivedAiOutput(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsDocumentSource(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsFailedResponseBody(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsJobLogs(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsMediaMetadata(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsModelPromptDiagnostics(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsPageMarkdown(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsPageMetadataJson(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsRawHtml(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsRawHttpHeaders(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsScreenshot(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsSearchProjection(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsTranscript(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """



class _WebxRetentionConfigurationDefaultsVisitMarkdown(TypedDict, total=False):
    retain_days: Required[int]
    """ Required property """

    action: Required[str]
    """ Required property """
