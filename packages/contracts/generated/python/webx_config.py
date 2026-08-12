from typing import Any, Literal, Required, TypedDict, Union


class WebxPrimaryConfiguration(TypedDict, total=False):
    """
    WebX primary configuration.

    $comment: Normative structural schema generated from the canonical example. The typed loader also enforces documented cross-field semantic rules.
    """

    schema_version: Required[int]
    """ Required property """

    environment: Required["_WebxPrimaryConfigurationEnvironment"]
    """ Required property """

    paths: Required["_WebxPrimaryConfigurationPaths"]
    """ Required property """

    server: Required["_WebxPrimaryConfigurationServer"]
    """ Required property """

    identity: Required["_WebxPrimaryConfigurationIdentity"]
    """ Required property """

    storage: Required["_WebxPrimaryConfigurationStorage"]
    """ Required property """

    sqlite: Required["_WebxPrimaryConfigurationSqlite"]
    """ Required property """

    queue: Required["_WebxPrimaryConfigurationQueue"]
    """ Required property """

    egress_gateway: Required["_WebxPrimaryConfigurationEgressGateway"]
    """ Required property """

    network_policy: Required["_WebxPrimaryConfigurationNetworkPolicy"]
    """ Required property """

    budgets: Required["_WebxPrimaryConfigurationBudgets"]
    """ Required property """

    routing: Required["_WebxPrimaryConfigurationRouting"]
    """ Required property """

    engines: Required[Union[dict[str, dict[str, Any]], "_WebxPrimaryConfigurationEnginesTyped"]]
    """

    WARNING: Normally the types should be a mix of each other instead of Union.
    See: https://github.com/camptocamp/jsonschema-gentypes/issues/7

    Required property
    """

    extraction: Required["_WebxPrimaryConfigurationExtraction"]
    """ Required property """

    search: Required["_WebxPrimaryConfigurationSearch"]
    """ Required property """

    wiki_intake: Required["_WebxPrimaryConfigurationWikiIntake"]
    """ Required property """

    models: Required["_WebxPrimaryConfigurationModels"]
    """ Required property """

    retention: Required["_WebxPrimaryConfigurationRetention"]
    """ Required property """

    permissions: Required["_WebxPrimaryConfigurationPermissions"]
    """ Required property """

    backup: Required["_WebxPrimaryConfigurationBackup"]
    """ Required property """

    observability: Required["_WebxPrimaryConfigurationObservability"]
    """ Required property """



class _WebxPrimaryConfigurationBackup(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    restic_repository_secret_ref: Required[str]
    """ Required property """

    restic_password_file_secret_ref: Required[str]
    """ Required property """

    schedule: Required[str]
    """ Required property """

    sqlite_online_backup: Required[bool]
    """ Required property """

    meilisearch_snapshot: Required[bool]
    """ Required property """

    meilisearch_dump_before_upgrade: Required[bool]
    """ Required property """

    verify_after_backup: Required[bool]
    """ Required property """

    restore_drill_days: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationBudgets(TypedDict, total=False):
    fetch: Required["_WebxPrimaryConfigurationBudgetsFetch"]
    """ Required property """

    crawl: Required["_WebxPrimaryConfigurationBudgetsCrawl"]
    """ Required property """

    media: Required["_WebxPrimaryConfigurationBudgetsMedia"]
    """ Required property """

    document: Required["_WebxPrimaryConfigurationBudgetsDocument"]
    """ Required property """

    model: Required["_WebxPrimaryConfigurationBudgetsModel"]
    """ Required property """



class _WebxPrimaryConfigurationBudgetsCrawl(TypedDict, total=False):
    max_pages: Required[int]
    """ Required property """

    max_depth: Required[int]
    """ Required property """

    max_duration_seconds: Required[int]
    """ Required property """

    max_total_bytes: Required[int]
    """ Required property """

    concurrency: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationBudgetsDocument(TypedDict, total=False):
    max_bytes: Required[int]
    """ Required property """

    max_pages: Required[int]
    """ Required property """

    max_expanded_bytes: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationBudgetsFetch(TypedDict, total=False):
    deadline_ms: Required[int]
    """ Required property """

    browser_deadline_ms: Required[int]
    """ Required property """

    max_wire_bytes: Required[int]
    """ Required property """

    max_decompressed_bytes: Required[int]
    """ Required property """

    max_dom_nodes: Required[int]
    """ Required property """

    max_text_chars: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationBudgetsMedia(TypedDict, total=False):
    max_items: Required[int]
    """ Required property """

    max_bytes: Required[int]
    """ Required property """

    max_live_duration_seconds: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationBudgetsModel(TypedDict, total=False):
    max_input_tokens: Required[int]
    """ Required property """

    max_output_tokens: Required[int]
    """ Required property """

    deadline_seconds: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationEgressGateway(TypedDict, total=False):
    enabled: Required[Literal[True]]
    """ Required property """

    http_proxy_url: Required[str]
    """ Required property """

    socks5h_proxy_url: Required[str]
    """ Required property """

    service_url: Required[str]
    """ Required property """

    service_token_secret_ref: Required[str]
    """ Required property """

    session_ttl_seconds: Required[int]
    """ Required property """

    authorization_cache_seconds: Required[int]
    """ Required property """

    enforce_for_all_origin_traffic: Required[Literal[True]]
    """ Required property """

    deny_direct_worker_wan: Required[Literal[True]]
    """ Required property """

    fail_closed: Required[Literal[True]]
    """ Required property """



class _WebxPrimaryConfigurationEnginesArchivebox(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    worker: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationEnginesBrowsertrix(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    worker: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationEnginesCrawl4Ai(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    worker: Required[str]
    """ Required property """

    purpose: Required[str]
    """ Required property """

    dynamic_hooks_enabled: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationEnginesCrawleeHttp(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    worker: Required[str]
    """ Required property """

    route: Required[str]
    """ Required property """

    concurrency: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationEnginesCrawleePlaywright(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    worker: Required[str]
    """ Required property """

    route: Required[str]
    """ Required property """

    concurrency: Required[int]
    """ Required property """

    browser: Required[str]
    """ Required property """

    block_resource_types: Required[list[str]]
    """ Required property """

    ephemeral_profiles: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationEnginesDocling(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    worker: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationEnginesScrapling(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    worker: Required[str]
    """ Required property """

    route: Required[str]
    """ Required property """

    concurrency: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationEnginesScrapy(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    worker: Required[str]
    """ Required property """

    registered_spiders_only: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationEnginesTyped(TypedDict, total=False):
    crawlee_http: Required["_WebxPrimaryConfigurationEnginesCrawleeHttp"]
    """ Required property """

    crawlee_playwright: Required["_WebxPrimaryConfigurationEnginesCrawleePlaywright"]
    """ Required property """

    scrapling: Required["_WebxPrimaryConfigurationEnginesScrapling"]
    """ Required property """

    crawl4ai: Required["_WebxPrimaryConfigurationEnginesCrawl4Ai"]
    """ Required property """

    scrapy: Required["_WebxPrimaryConfigurationEnginesScrapy"]
    """ Required property """

    docling: Required["_WebxPrimaryConfigurationEnginesDocling"]
    """ Required property """

    yt_dlp: Required["_WebxPrimaryConfigurationEnginesYtDlp"]
    """ Required property """

    archivebox: Required["_WebxPrimaryConfigurationEnginesArchivebox"]
    """ Required property """

    browsertrix: Required["_WebxPrimaryConfigurationEnginesBrowsertrix"]
    """ Required property """



class _WebxPrimaryConfigurationEnginesYtDlp(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    worker: Required[str]
    """ Required property """



_WebxPrimaryConfigurationEnvironment = Literal['development'] | Literal['test'] | Literal['staging'] | Literal['production']
_WEBXPRIMARYCONFIGURATIONENVIRONMENT_DEVELOPMENT: Literal['development'] = "development"
"""The values for the '_WebxPrimaryConfigurationEnvironment' enum"""
_WEBXPRIMARYCONFIGURATIONENVIRONMENT_TEST: Literal['test'] = "test"
"""The values for the '_WebxPrimaryConfigurationEnvironment' enum"""
_WEBXPRIMARYCONFIGURATIONENVIRONMENT_STAGING: Literal['staging'] = "staging"
"""The values for the '_WebxPrimaryConfigurationEnvironment' enum"""
_WEBXPRIMARYCONFIGURATIONENVIRONMENT_PRODUCTION: Literal['production'] = "production"
"""The values for the '_WebxPrimaryConfigurationEnvironment' enum"""



class _WebxPrimaryConfigurationExtraction(TypedDict, total=False):
    deterministic_order: Required[list[str]]
    """ Required property """

    sanitizer: Required["_WebxPrimaryConfigurationExtractionSanitizer"]
    """ Required property """

    markdown: Required["_WebxPrimaryConfigurationExtractionMarkdown"]
    """ Required property """



class _WebxPrimaryConfigurationExtractionMarkdown(TypedDict, total=False):
    version: Required[int]
    """ Required property """

    preserve_tables: Required[bool]
    """ Required property """

    preserve_code_fences: Required[bool]
    """ Required property """

    canonicalize_links: Required[bool]
    """ Required property """

    include_frontmatter: Required[bool]
    """ Required property """

    chunk_target_tokens: Required[int]
    """ Required property """

    chunk_overlap_tokens: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationExtractionSanitizer(TypedDict, total=False):
    implementation: Required[str]
    """ Required property """

    version: Required[int]
    """ Required property """

    remove_elements: Required[list[str]]
    """ Required property """

    remove_event_attributes: Required[bool]
    """ Required property """

    remove_javascript_urls: Required[bool]
    """ Required property """

    preserve_source_links: Required[bool]
    """ Required property """

    max_data_uri_bytes: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationIdentity(TypedDict, total=False):
    local_actor_role: Required[str]
    """ Required property """

    default_collection: Required[str]
    """ Required property """

    default_visibility: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationModels(TypedDict, total=False):
    required_for_core: Required[bool]
    """ Required property """

    gateway_url: Required[str]
    """ Required property """

    runtimes_config: Required[str]
    """ Required property """

    allowed_runtime_kinds: Required[list["_WebxPrimaryConfigurationModelsAllowedRuntimeKindsItem"]]
    """ Required property """

    forbidden_runtime_kinds: Required[list["_WebxPrimaryConfigurationModelsForbiddenRuntimeKindsItem"]]
    """ Required property """

    remote_external_endpoints_allowed: Required[Literal[False]]
    """ Required property """

    workloads: Required["_WebxPrimaryConfigurationModelsWorkloads"]
    """ Required property """



_WebxPrimaryConfigurationModelsAllowedRuntimeKindsItem = Literal['llama_cpp'] | Literal['vllm']
_WEBXPRIMARYCONFIGURATIONMODELSALLOWEDRUNTIMEKINDSITEM_LLAMA_CPP: Literal['llama_cpp'] = "llama_cpp"
"""The values for the '_WebxPrimaryConfigurationModelsAllowedRuntimeKindsItem' enum"""
_WEBXPRIMARYCONFIGURATIONMODELSALLOWEDRUNTIMEKINDSITEM_VLLM: Literal['vllm'] = "vllm"
"""The values for the '_WebxPrimaryConfigurationModelsAllowedRuntimeKindsItem' enum"""



_WebxPrimaryConfigurationModelsForbiddenRuntimeKindsItem = Literal['ollama']
_WEBXPRIMARYCONFIGURATIONMODELSFORBIDDENRUNTIMEKINDSITEM_OLLAMA: Literal['ollama'] = "ollama"
"""The values for the '_WebxPrimaryConfigurationModelsForbiddenRuntimeKindsItem' enum"""



class _WebxPrimaryConfigurationModelsWorkloads(TypedDict, total=False):
    structured_extract: Required["_WebxPrimaryConfigurationModelsWorkloadsStructuredExtract"]
    """ Required property """

    embeddings: Required["_WebxPrimaryConfigurationModelsWorkloadsEmbeddings"]
    """ Required property """

    rerank: Required["_WebxPrimaryConfigurationModelsWorkloadsRerank"]
    """ Required property """

    source_summarization: Required["_WebxPrimaryConfigurationModelsWorkloadsSourceSummarization"]
    """ Required property """



class _WebxPrimaryConfigurationModelsWorkloadsEmbeddings(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    runtime_profile: Required[str]
    """ Required property """

    cache_by_input_model_hash: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationModelsWorkloadsRerank(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    runtime_profile: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationModelsWorkloadsSourceSummarization(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    runtime_profile: Required[str]
    """ Required property """

    output_is_derived: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationModelsWorkloadsStructuredExtract(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    runtime_profile: Required[str]
    """ Required property """

    require_json_schema: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationNetworkPolicy(TypedDict, total=False):
    allowed_schemes: Required[list[str]]
    """ Required property """

    deny_url_userinfo: Required[bool]
    """ Required property """

    deny_private_addresses: Required[bool]
    """ Required property """

    deny_loopback: Required[bool]
    """ Required property """

    deny_link_local: Required[bool]
    """ Required property """

    deny_multicast: Required[bool]
    """ Required property """

    deny_unspecified: Required[bool]
    """ Required property """

    deny_cloud_metadata: Required[bool]
    """ Required property """

    revalidate_every_redirect: Required[bool]
    """ Required property """

    dns_pin_for_connection: Required[bool]
    """ Required property """

    max_redirects: Required[int]
    """ Required property """

    public_suffix_validation: Required[bool]
    """ Required property """

    default_domain_concurrency: Required[int]
    """ Required property """

    default_domain_delay_ms: Required[int]
    """ Required property """

    respect_retry_after: Required[bool]
    """ Required property """

    robots: Required["_WebxPrimaryConfigurationNetworkPolicyRobots"]
    """ Required property """

    allowed_domains: Required[list[str | int | float | dict[str, Any] | None | bool | None]]
    """ Required property """

    denied_domains: Required[list[str | int | float | dict[str, Any] | None | bool | None]]
    """ Required property """

    credentialed_indexing_default: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationNetworkPolicyRobots(TypedDict, total=False):
    crawl_default: Required[str]
    """ Required property """

    single_fetch_default: Required[str]
    """ Required property """

    cache_seconds: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationObservability(TypedDict, total=False):
    log_level: Required[str]
    """ Required property """

    log_format: Required[str]
    """ Required property """

    otel: Required["_WebxPrimaryConfigurationObservabilityOtel"]
    """ Required property """

    metrics: Required["_WebxPrimaryConfigurationObservabilityMetrics"]
    """ Required property """

    audit: Required["_WebxPrimaryConfigurationObservabilityAudit"]
    """ Required property """



class _WebxPrimaryConfigurationObservabilityAudit(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    hash_chain: Required[bool]
    """ Required property """

    body_logging: Required[bool]
    """ Required property """

    header_allowlist: Required[list[str]]
    """ Required property """



class _WebxPrimaryConfigurationObservabilityMetrics(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    bind: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationObservabilityOtel(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    exporter_endpoint: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationPaths(TypedDict, total=False):
    data_dir: Required[str]
    """ Required property """

    database: Required[str]
    """ Required property """

    socket: Required[str]
    """ Required property """

    artifacts: Required[str]
    """ Required property """

    staging: Required[str]
    """ Required property """

    logs: Required[str]
    """ Required property """

    exports: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationPermissions(TypedDict, total=False):
    policy_file: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationQueue(TypedDict, total=False):
    poll_interval_ms: Required[int]
    """ Required property """

    default_lease_seconds: Required[int]
    """ Required property """

    heartbeat_seconds: Required[int]
    """ Required property """

    cancellation_grace_seconds: Required[int]
    """ Required property """

    max_global_running_jobs: Required[int]
    """ Required property """

    resource_capacity: Required["_WebxPrimaryConfigurationQueueResourceCapacity"]
    """ Required property """



class _WebxPrimaryConfigurationQueueResourceCapacity(TypedDict, total=False):
    tiny: Required[int]
    """ Required property """

    cpu: Required[int]
    """ Required property """

    browser: Required[int]
    """ Required property """

    gpu: Required[int]
    """ Required property """

    io: Required[int]
    """ Required property """

    archive: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationRetention(TypedDict, total=False):
    policy_file: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationRouting(TypedDict, total=False):
    auto: Required["_WebxPrimaryConfigurationRoutingAuto"]
    """ Required property """

    verify: Required["_WebxPrimaryConfigurationRoutingVerify"]
    """ Required property """

    offline: Required["_WebxPrimaryConfigurationRoutingOffline"]
    """ Required property """

    quality_gates: Required["_WebxPrimaryConfigurationRoutingQualityGates"]
    """ Required property """



class _WebxPrimaryConfigurationRoutingAuto(TypedDict, total=False):
    steps: Required[list["_WebxPrimaryConfigurationRoutingAutoStepsItem"]]
    """ Required property """

    rag_postprocessor: Required[str]
    """ Required property """



_WebxPrimaryConfigurationRoutingAutoStepsItem = Union["_WebxPrimaryConfigurationRoutingAutoStepsItemAnyof0", "_WebxPrimaryConfigurationRoutingAutoStepsItemAnyof1"]
""" Aggregation type: anyOf """



class _WebxPrimaryConfigurationRoutingAutoStepsItemAnyof0(TypedDict, total=False):
    engine: Required[str]
    """ Required property """

    accept_gate: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationRoutingAutoStepsItemAnyof1(TypedDict, total=False):
    engine: Required[str]
    """ Required property """

    when: Required[str]
    """ Required property """

    accept_gate: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationRoutingOffline(TypedDict, total=False):
    network_disabled: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationRoutingQualityGates(TypedDict, total=False):
    html_fast: Required["_WebxPrimaryConfigurationRoutingQualityGatesHtmlFast"]
    """ Required property """

    browser_page: Required["_WebxPrimaryConfigurationRoutingQualityGatesBrowserPage"]
    """ Required property """

    adaptive_page: Required["_WebxPrimaryConfigurationRoutingQualityGatesAdaptivePage"]
    """ Required property """



class _WebxPrimaryConfigurationRoutingQualityGatesAdaptivePage(TypedDict, total=False):
    allowed_status: Required[list[int]]
    """ Required property """

    min_main_text_chars: Required[int]
    """ Required property """

    min_quality_score: Required[int | float]
    """ Required property """

    reject_challenge_pages: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationRoutingQualityGatesBrowserPage(TypedDict, total=False):
    allowed_status: Required[list[int]]
    """ Required property """

    min_main_text_chars: Required[int]
    """ Required property """

    min_quality_score: Required[int | float]
    """ Required property """

    reject_challenge_pages: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationRoutingQualityGatesHtmlFast(TypedDict, total=False):
    allowed_status: Required[list[int]]
    """ Required property """

    min_main_text_chars: Required[int]
    """ Required property """

    min_quality_score: Required[int | float]
    """ Required property """

    reject_challenge_pages: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationRoutingVerify(TypedDict, total=False):
    minimum_independent_observations: Required[int]
    """ Required property """

    engines: Required[list[str]]
    """ Required property """

    degraded_single_observation_allowed: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationSearch(TypedDict, total=False):
    searxng: Required["_WebxPrimaryConfigurationSearchSearxng"]
    """ Required property """

    meilisearch: Required["_WebxPrimaryConfigurationSearchMeilisearch"]
    """ Required property """

    yacy: Required["_WebxPrimaryConfigurationSearchYacy"]
    """ Required property """

    fusion: Required["_WebxPrimaryConfigurationSearchFusion"]
    """ Required property """

    semantic: Required["_WebxPrimaryConfigurationSearchSemantic"]
    """ Required property """



class _WebxPrimaryConfigurationSearchFusion(TypedDict, total=False):
    method: Required[str]
    """ Required property """

    rrf_k: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationSearchMeilisearch(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    base_url: Required[str]
    """ Required property """

    admin_key_secret_ref: Required[str]
    """ Required property """

    search_key_secret_ref: Required[str]
    """ Required property """

    indexes: Required["_WebxPrimaryConfigurationSearchMeilisearchIndexes"]
    """ Required property """

    task_poll_ms: Required[int]
    """ Required property """

    task_deadline_ms: Required[int]
    """ Required property """

    projection_batch_size: Required[int]
    """ Required property """

    settings_dir: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationSearchMeilisearchIndexes(TypedDict, total=False):
    pages: Required[str]
    """ Required property """

    chunks: Required[str]
    """ Required property """

    history: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationSearchSearxng(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    base_url: Required[str]
    """ Required property """

    timeout_ms: Required[int]
    """ Required property """

    max_results: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationSearchSemantic(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    embedding_profile: Required[str]
    """ Required property """

    dimensions: Required[None | str | int | int | float | bool | dict[str, Any] | None]
    """ Required property """

    index_source: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationSearchYacy(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    base_url: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationServer(TypedDict, total=False):
    unix_socket: Required["_WebxPrimaryConfigurationServerUnixSocket"]
    """ Required property """

    loopback: Required["_WebxPrimaryConfigurationServerLoopback"]
    """ Required property """

    network: Required["_WebxPrimaryConfigurationServerNetwork"]
    """ Required property """

    request_limits: Required["_WebxPrimaryConfigurationServerRequestLimits"]
    """ Required property """



class _WebxPrimaryConfigurationServerLoopback(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    host: Required[str]
    """ Required property """

    port: Required[int]
    """ Required property """

    token_secret_ref: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationServerNetwork(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    trusted_proxy_cidrs: Required[list[str | int | float | dict[str, Any] | None | bool | None]]
    """ Required property """



class _WebxPrimaryConfigurationServerRequestLimits(TypedDict, total=False):
    json_bytes: Required[int]
    """ Required property """

    upload_bytes: Required[int]
    """ Required property """

    request_timeout_ms: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationServerUnixSocket(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    path: Required[str]
    """ Required property """

    mode: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationSqlite(TypedDict, total=False):
    journal_mode: Required[str]
    """ Required property """

    synchronous: Required[str]
    """ Required property """

    busy_timeout_ms: Required[int]
    """ Required property """

    checkpoint_interval_seconds: Required[int]
    """ Required property """

    checkpoint_wal_bytes: Required[int]
    """ Required property """

    online_backup_before_migration: Required[bool]
    """ Required property """



class _WebxPrimaryConfigurationStorage(TypedDict, total=False):
    hash_algorithm: Required[str]
    """ Required property """

    id_format: Required[str]
    """ Required property """

    fsync_artifact_commits: Required[bool]
    """ Required property """

    compress_raw_html: Required[str]
    """ Required property """

    low_space: Required["_WebxPrimaryConfigurationStorageLowSpace"]
    """ Required property """

    markdown: Required["_WebxPrimaryConfigurationStorageMarkdown"]
    """ Required property """



class _WebxPrimaryConfigurationStorageLowSpace(TypedDict, total=False):
    warning_percent: Required[int]
    """ Required property """

    stop_optional_percent: Required[int]
    """ Required property """

    reject_writes_percent: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationStorageMarkdown(TypedDict, total=False):
    save_visit_receipt_for_terminal_visit: Required[bool]
    """ Required property """

    save_unique_page_versions: Required[bool]
    """ Required property """

    normalize_line_endings: Required[str]
    """ Required property """

    final_newline: Required[bool]
    """ Required property """

    source_trust: Required[str]
    """ Required property """



class _WebxPrimaryConfigurationWikiIntake(TypedDict, total=False):
    enabled: Required[bool]
    """ Required property """

    consumers: Required[list["_WebxPrimaryConfigurationWikiIntakeConsumersItem"]]
    """ Required property """

    include_source_markdown: Required[str]
    """ Required property """

    include_raw_html: Required[bool]
    """ Required property """

    emit_tombstones: Required[bool]
    """ Required property """

    default_backfill_batch: Required[int]
    """ Required property """



class _WebxPrimaryConfigurationWikiIntakeConsumersItem(TypedDict, total=False):
    consumer_id: Required[str]
    """ Required property """

    enabled: Required[bool]
    """ Required property """

    delivery_mode: Required[str]
    """ Required property """

    filesystem_outbox: Required[str]
    """ Required property """

    max_visibility: Required[str]
    """ Required property """

    collections: Required[list[str]]
    """ Required property """

    lease_seconds: Required[int]
    """ Required property """

    secret_ref: Required[str]
    """ Required property """
