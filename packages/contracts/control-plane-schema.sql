-- WebX reference control-plane schema, schema version 1.
-- Implementation must split this into ordered, reversible migration files.
-- All timestamps are RFC 3339 UTC text. ULIDs are lowercase 26-character text.
-- Content bytes are never stored in SQLite except small safe JSON metadata/events.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_migrations (
    version             INTEGER PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    applied_at          TEXT NOT NULL,
    checksum_sha256     TEXT NOT NULL CHECK(length(checksum_sha256) = 64),
    execution_ms        INTEGER NOT NULL CHECK(execution_ms >= 0)
) STRICT;

CREATE TABLE actors (
    actor_id            TEXT PRIMARY KEY,
    actor_type          TEXT NOT NULL CHECK(actor_type IN ('local_user','service','pi_agent','wiki_consumer','api_key')),
    display_name        TEXT NOT NULL,
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    role                TEXT NOT NULL,
    max_visibility      TEXT NOT NULL CHECK(max_visibility IN ('public','internal','private','secret')),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    disabled_at         TEXT,
    metadata_json       TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE api_keys (
    key_id              TEXT PRIMARY KEY,
    actor_id            TEXT NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
    key_prefix          TEXT NOT NULL UNIQUE,
    secret_hash         TEXT NOT NULL,
    scopes_json         TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    expires_at          TEXT,
    last_used_at        TEXT,
    revoked_at          TEXT,
    description         TEXT
) STRICT;
CREATE INDEX api_keys_actor_idx ON api_keys(actor_id, revoked_at);

CREATE TABLE credential_references (
    credential_ref      TEXT PRIMARY KEY,
    owner_actor_id      TEXT REFERENCES actors(actor_id),
    provider            TEXT NOT NULL,
    secret_backend      TEXT NOT NULL CHECK(secret_backend IN ('file','system_keyring','environment','external_command')),
    secret_locator      TEXT NOT NULL,
    allowed_domains_json TEXT NOT NULL,
    allowed_operations_json TEXT NOT NULL,
    max_visibility      TEXT NOT NULL CHECK(max_visibility IN ('public','internal','private','secret')),
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    last_used_at        TEXT,
    metadata_json       TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE idempotency_records (
    actor_id            TEXT NOT NULL REFERENCES actors(actor_id),
    operation           TEXT NOT NULL,
    idempotency_key     TEXT NOT NULL,
    request_sha256      TEXT NOT NULL CHECK(length(request_sha256) = 64),
    job_id              TEXT,
    response_artifact_id TEXT,
    created_at          TEXT NOT NULL,
    expires_at          TEXT NOT NULL,
    PRIMARY KEY(actor_id, operation, idempotency_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE jobs (
    job_id              TEXT PRIMARY KEY CHECK(length(job_id) = 26),
    parent_job_id       TEXT REFERENCES jobs(job_id),
    actor_id            TEXT NOT NULL REFERENCES actors(actor_id),
    operation           TEXT NOT NULL,
    capability          TEXT NOT NULL,
    resource_class      TEXT NOT NULL CHECK(resource_class IN ('tiny','cpu','browser','gpu','io','archive')),
    state               TEXT NOT NULL CHECK(state IN ('queued','leased','running','retry_wait','succeeded','partial','failed','cancelled','dead_letter')),
    phase               TEXT,
    priority            INTEGER NOT NULL DEFAULT 0,
    idempotency_key     TEXT,
    request_sha256      TEXT CHECK(request_sha256 IS NULL OR length(request_sha256) = 64),
    request_json        TEXT NOT NULL,
    result_json         TEXT,
    result_artifact_id  TEXT,
    error_code          TEXT,
    error_json          TEXT,
    attempt             INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    max_attempts        INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts >= 1),
    progress            REAL CHECK(progress IS NULL OR (progress >= 0.0 AND progress <= 1.0)),
    not_before          TEXT NOT NULL,
    deadline_at         TEXT,
    lease_owner         TEXT,
    lease_token_hash    TEXT,
    lease_expires_at    TEXT,
    heartbeat_at        TEXT,
    cancel_requested    INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
    index_state         TEXT NOT NULL DEFAULT 'excluded' CHECK(index_state IN ('excluded','pending','submitted','succeeded','failed','dead_letter')),
    wiki_state          TEXT NOT NULL DEFAULT 'excluded' CHECK(wiki_state IN ('excluded','pending','submitted','succeeded','failed','dead_letter')),
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    started_at          TEXT,
    completed_at        TEXT
) STRICT;
CREATE INDEX jobs_claim_idx ON jobs(state, not_before, priority DESC, created_at);
CREATE INDEX jobs_actor_idx ON jobs(actor_id, created_at DESC);
CREATE INDEX jobs_parent_idx ON jobs(parent_job_id);
CREATE INDEX jobs_operation_idx ON jobs(operation, state, created_at DESC);

CREATE TABLE job_attempts (
    attempt_id          TEXT PRIMARY KEY CHECK(length(attempt_id) = 26),
    job_id              TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    attempt_number      INTEGER NOT NULL CHECK(attempt_number >= 1),
    worker_id           TEXT REFERENCES worker_instances(worker_id),
    engine_id           TEXT REFERENCES engines(engine_id),
    capability_id       TEXT NOT NULL,
    state               TEXT NOT NULL CHECK(state IN ('leased','running','succeeded','partial','failed','cancelled','stale')),
    policy_snapshot_hash TEXT NOT NULL CHECK(length(policy_snapshot_hash) = 64),
    completion_hash     TEXT CHECK(completion_hash IS NULL OR length(completion_hash) = 64),
    started_at          TEXT,
    completed_at        TEXT,
    resource_usage_json TEXT NOT NULL DEFAULT '{}',
    safe_diagnostics_json TEXT NOT NULL DEFAULT '{}',
    error_code          TEXT,
    error_json          TEXT,
    UNIQUE(job_id, attempt_number)
) STRICT;
CREATE INDEX job_attempts_job_idx ON job_attempts(job_id, attempt_number);
CREATE INDEX job_attempts_worker_idx ON job_attempts(worker_id, state, started_at);

CREATE TABLE job_leases (
    attempt_id          TEXT PRIMARY KEY REFERENCES job_attempts(attempt_id) ON DELETE CASCADE,
    job_id              TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    worker_id           TEXT NOT NULL REFERENCES worker_instances(worker_id),
    lease_token_hash    TEXT NOT NULL CHECK(length(lease_token_hash) = 64),
    state               TEXT NOT NULL CHECK(state IN ('active','released','expired','revoked')),
    acquired_at         TEXT NOT NULL,
    heartbeat_at        TEXT NOT NULL,
    expires_at          TEXT NOT NULL,
    released_at         TEXT,
    revoke_reason       TEXT
) STRICT;
CREATE INDEX job_leases_claim_idx ON job_leases(state, expires_at);
CREATE INDEX job_leases_worker_idx ON job_leases(worker_id, state, expires_at);

CREATE TABLE job_dependencies (
    job_id              TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    depends_on_job_id   TEXT NOT NULL REFERENCES jobs(job_id),
    dependency_type     TEXT NOT NULL CHECK(dependency_type IN ('success','terminal','artifact')),
    PRIMARY KEY(job_id, depends_on_job_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE job_events (
    event_id            TEXT PRIMARY KEY CHECK(length(event_id) = 26),
    job_id              TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    sequence            INTEGER NOT NULL CHECK(sequence >= 1),
    event_type          TEXT NOT NULL,
    occurred_at         TEXT NOT NULL,
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    payload_json        TEXT NOT NULL,
    UNIQUE(job_id, sequence)
) STRICT;
CREATE INDEX job_events_job_idx ON job_events(job_id, sequence);

CREATE TABLE worker_instances (
    worker_id           TEXT PRIMARY KEY,
    worker_kind         TEXT NOT NULL,
    version             TEXT NOT NULL,
    hostname            TEXT NOT NULL,
    process_id          INTEGER,
    capabilities_json   TEXT NOT NULL,
    capacities_json     TEXT NOT NULL,
    state               TEXT NOT NULL CHECK(state IN ('starting','ready','draining','unhealthy','stopped')),
    started_at          TEXT NOT NULL,
    last_heartbeat_at   TEXT NOT NULL,
    stopped_at          TEXT,
    diagnostics_json    TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE engines (
    engine_id           TEXT PRIMARY KEY,
    engine_kind         TEXT NOT NULL,
    worker_kind         TEXT NOT NULL,
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    stability           TEXT NOT NULL CHECK(stability IN ('stable','beta','experimental')),
    version             TEXT,
    capabilities_json   TEXT NOT NULL,
    health_state        TEXT NOT NULL CHECK(health_state IN ('healthy','degraded','unhealthy','unknown','disabled')),
    failure_count       INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
    circuit_state       TEXT NOT NULL DEFAULT 'closed' CHECK(circuit_state IN ('closed','open','half_open')),
    circuit_open_until  TEXT,
    last_probe_at       TEXT,
    last_success_at     TEXT,
    last_failure_at     TEXT,
    diagnostics_json    TEXT NOT NULL DEFAULT '{}',
    updated_at          TEXT NOT NULL
) STRICT;

CREATE TABLE egress_sessions (
    egress_session_id   TEXT PRIMARY KEY CHECK(length(egress_session_id) = 26),
    attempt_id          TEXT NOT NULL UNIQUE REFERENCES job_attempts(attempt_id) ON DELETE CASCADE,
    job_id              TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    actor_id            TEXT NOT NULL REFERENCES actors(actor_id),
    worker_id           TEXT REFERENCES worker_instances(worker_id),
    token_hash          TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
    state               TEXT NOT NULL CHECK(state IN ('active','revoked','expired','closed')),
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    network_profile     TEXT NOT NULL,
    method_classes_json TEXT NOT NULL,
    target_policy_json  TEXT NOT NULL,
    budgets_json        TEXT NOT NULL,
    counters_json       TEXT NOT NULL DEFAULT '{}',
    policy_snapshot_hash TEXT NOT NULL CHECK(length(policy_snapshot_hash) = 64),
    created_at          TEXT NOT NULL,
    expires_at          TEXT NOT NULL,
    revoked_at          TEXT,
    revoke_reason       TEXT,
    closed_at           TEXT
) STRICT;
CREATE INDEX egress_sessions_active_idx ON egress_sessions(state, expires_at);
CREATE INDEX egress_sessions_job_idx ON egress_sessions(job_id, created_at);

CREATE TABLE egress_authorizations (
    authorization_id    TEXT PRIMARY KEY CHECK(length(authorization_id) = 26),
    egress_session_id   TEXT NOT NULL REFERENCES egress_sessions(egress_session_id) ON DELETE CASCADE,
    sequence            INTEGER NOT NULL CHECK(sequence >= 1),
    scheme              TEXT NOT NULL CHECK(scheme IN ('http','https','ws','wss','tcp')),
    host_ascii          TEXT NOT NULL,
    port                INTEGER NOT NULL CHECK(port >= 1 AND port <= 65535),
    protocol            TEXT NOT NULL CHECK(protocol IN ('http_proxy','connect','socks5h')),
    method_class        TEXT,
    resolved_addresses_json TEXT NOT NULL,
    approved_addresses_json TEXT NOT NULL DEFAULT '[]',
    decision            TEXT NOT NULL CHECK(decision IN ('allow','deny')),
    reason_code         TEXT NOT NULL,
    request_bytes_planned INTEGER CHECK(request_bytes_planned IS NULL OR request_bytes_planned >= 0),
    max_connection_bytes INTEGER CHECK(max_connection_bytes IS NULL OR max_connection_bytes >= 0),
    max_duration_ms     INTEGER CHECK(max_duration_ms IS NULL OR max_duration_ms >= 0),
    requested_at        TEXT NOT NULL,
    decided_at          TEXT NOT NULL,
    expires_at          TEXT NOT NULL,
    UNIQUE(egress_session_id, sequence)
) STRICT;
CREATE INDEX egress_authorizations_session_idx ON egress_authorizations(egress_session_id, sequence);
CREATE INDEX egress_authorizations_target_idx ON egress_authorizations(host_ascii, port, requested_at DESC);

CREATE TABLE domain_profiles (
    domain              TEXT PRIMARY KEY,
    preferred_route     TEXT CHECK(preferred_route IN ('http','browser','adaptive','archive')),
    preferred_engine    TEXT REFERENCES engines(engine_id),
    requires_javascript INTEGER NOT NULL DEFAULT 0 CHECK(requires_javascript IN (0,1)),
    requires_session    INTEGER NOT NULL DEFAULT 0 CHECK(requires_session IN (0,1)),
    observed_robots_url TEXT,
    cooldown_until      TEXT,
    rate_limit_json     TEXT NOT NULL DEFAULT '{}',
    success_json        TEXT NOT NULL DEFAULT '{}',
    failure_json        TEXT NOT NULL DEFAULT '{}',
    updated_at          TEXT NOT NULL
) STRICT;

CREATE TABLE crawls (
    crawl_id            TEXT PRIMARY KEY CHECK(length(crawl_id) = 26),
    job_id              TEXT NOT NULL UNIQUE REFERENCES jobs(job_id),
    seed_url            TEXT NOT NULL,
    engine_id           TEXT REFERENCES engines(engine_id),
    mode                TEXT NOT NULL,
    state               TEXT NOT NULL CHECK(state IN ('queued','running','paused','succeeded','partial','failed','cancelled')),
    scope_json          TEXT NOT NULL,
    budgets_json        TEXT NOT NULL,
    counters_json       TEXT NOT NULL DEFAULT '{}',
    collection          TEXT NOT NULL,
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    pause_requested     INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0,1)),
    cancel_requested    INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
    created_at          TEXT NOT NULL,
    started_at          TEXT,
    checkpoint_at       TEXT,
    completed_at        TEXT
) STRICT;

CREATE TABLE crawl_frontier (
    frontier_id         TEXT PRIMARY KEY CHECK(length(frontier_id) = 26),
    crawl_id            TEXT NOT NULL REFERENCES crawls(crawl_id) ON DELETE CASCADE,
    normalized_url      TEXT NOT NULL,
    discovered_url      TEXT NOT NULL,
    parent_visit_id     TEXT,
    depth               INTEGER NOT NULL CHECK(depth >= 0),
    priority            INTEGER NOT NULL DEFAULT 0,
    state               TEXT NOT NULL CHECK(state IN ('queued','leased','completed','failed','skipped','cancelled')),
    lease_owner         TEXT,
    lease_expires_at    TEXT,
    not_before          TEXT NOT NULL,
    discovered_at       TEXT NOT NULL,
    completed_at        TEXT,
    skip_reason         TEXT,
    UNIQUE(crawl_id, normalized_url)
) STRICT;
CREATE INDEX crawl_frontier_claim_idx ON crawl_frontier(crawl_id, state, not_before, priority DESC, discovered_at);

CREATE TABLE browser_sessions (
    browser_session_id  TEXT PRIMARY KEY CHECK(length(browser_session_id) = 26),
    actor_id            TEXT NOT NULL REFERENCES actors(actor_id),
    owner_job_id        TEXT REFERENCES jobs(job_id),
    session_name        TEXT NOT NULL,
    profile_kind        TEXT NOT NULL CHECK(profile_kind IN ('ephemeral','persistent')),
    state               TEXT NOT NULL CHECK(state IN ('starting','active','idle','closing','closed','expired','failed')),
    worker_id           TEXT REFERENCES worker_instances(worker_id),
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    credential_ref      TEXT REFERENCES credential_references(credential_ref),
    idle_timeout_seconds INTEGER NOT NULL CHECK(idle_timeout_seconds >= 30),
    absolute_timeout_seconds INTEGER NOT NULL CHECK(absolute_timeout_seconds >= idle_timeout_seconds),
    created_at          TEXT NOT NULL,
    last_active_at      TEXT NOT NULL,
    idle_expires_at     TEXT NOT NULL,
    absolute_expires_at TEXT NOT NULL,
    closed_at           TEXT,
    close_reason        TEXT,
    metadata_json       TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE UNIQUE INDEX browser_sessions_active_name_idx
    ON browser_sessions(actor_id, session_name)
    WHERE state IN ('starting','active','idle','closing');
CREATE INDEX browser_sessions_state_idx ON browser_sessions(state, idle_expires_at, absolute_expires_at);
CREATE INDEX browser_sessions_worker_idx ON browser_sessions(worker_id, state);

CREATE TABLE visits (
    visit_id            TEXT PRIMARY KEY CHECK(length(visit_id) = 26),
    job_id              TEXT NOT NULL REFERENCES jobs(job_id),
    crawl_id            TEXT REFERENCES crawls(crawl_id),
    frontier_id         TEXT REFERENCES crawl_frontier(frontier_id),
    parent_visit_id     TEXT REFERENCES visits(visit_id),
    operation           TEXT NOT NULL,
    mode                TEXT NOT NULL,
    requested_url       TEXT NOT NULL,
    normalized_requested_url TEXT NOT NULL,
    final_url           TEXT,
    url_key             TEXT,
    state               TEXT NOT NULL CHECK(state IN ('running','succeeded','partial','failed','cancelled','policy_denied')),
    network_attempted   INTEGER NOT NULL DEFAULT 0 CHECK(network_attempted IN (0,1)),
    selected_engine_id  TEXT REFERENCES engines(engine_id),
    http_status         INTEGER CHECK(http_status IS NULL OR (http_status >= 100 AND http_status <= 599)),
    mime_type           TEXT,
    charset             TEXT,
    content_length      INTEGER CHECK(content_length IS NULL OR content_length >= 0),
    page_id             TEXT,
    version_id          TEXT,
    receipt_artifact_id TEXT,
    raw_artifact_id     TEXT,
    error_code          TEXT,
    error_json          TEXT,
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    started_at          TEXT NOT NULL,
    completed_at        TEXT,
    duration_ms         INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
    warnings_json       TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE INDEX visits_job_idx ON visits(job_id, started_at);
CREATE INDEX visits_crawl_idx ON visits(crawl_id, started_at);
CREATE INDEX visits_url_idx ON visits(url_key, started_at DESC);
CREATE INDEX visits_page_idx ON visits(page_id, started_at DESC);

CREATE TABLE redirect_hops (
    visit_id            TEXT NOT NULL REFERENCES visits(visit_id) ON DELETE CASCADE,
    hop_number          INTEGER NOT NULL CHECK(hop_number >= 0),
    request_url         TEXT NOT NULL,
    status              INTEGER CHECK(status IS NULL OR (status >= 100 AND status <= 599)),
    location_url        TEXT,
    normalized_location_url TEXT,
    resolved_addresses_json TEXT NOT NULL DEFAULT '[]',
    address_class       TEXT,
    policy_decision     TEXT NOT NULL CHECK(policy_decision IN ('allowed','denied','not_applicable')),
    observed_at         TEXT NOT NULL,
    PRIMARY KEY(visit_id, hop_number)
) STRICT, WITHOUT ROWID;

CREATE TABLE engine_observations (
    observation_id      TEXT PRIMARY KEY CHECK(length(observation_id) = 26),
    visit_id            TEXT NOT NULL REFERENCES visits(visit_id) ON DELETE CASCADE,
    engine_id           TEXT NOT NULL REFERENCES engines(engine_id),
    engine_version      TEXT,
    route_kind          TEXT NOT NULL CHECK(route_kind IN ('http','browser','adaptive','archive','local')),
    state               TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','cancelled')),
    attempt_number      INTEGER NOT NULL CHECK(attempt_number >= 1),
    started_at          TEXT NOT NULL,
    completed_at        TEXT,
    final_url           TEXT,
    http_status         INTEGER,
    -- Daemon-owned post-admission state. Never copy a worker observation field.
    accepted            INTEGER CHECK(accepted IS NULL OR accepted IN (0,1)),
    quality_score       REAL CHECK(quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
    quality_json        TEXT NOT NULL DEFAULT '{}',
    rejection_reasons_json TEXT NOT NULL DEFAULT '[]',
    source_artifact_id  TEXT,
    screenshot_artifact_id TEXT,
    network_artifact_id TEXT,
    error_code          TEXT,
    safe_diagnostics_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX engine_observations_visit_idx ON engine_observations(visit_id, attempt_number);

CREATE TABLE canonical_pages (
    page_id             TEXT PRIMARY KEY CHECK(length(page_id) = 26),
    canonical_url       TEXT NOT NULL,
    url_key             TEXT NOT NULL,
    domain              TEXT NOT NULL,
    collection          TEXT NOT NULL,
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    first_visit_id      TEXT REFERENCES visits(visit_id),
    last_visit_id       TEXT REFERENCES visits(visit_id),
    current_version_id  TEXT,
    version_count       INTEGER NOT NULL DEFAULT 0 CHECK(version_count >= 0),
    tombstoned          INTEGER NOT NULL DEFAULT 0 CHECK(tombstoned IN (0,1)),
    tombstoned_at       TEXT,
    tombstone_reason    TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE(collection, url_key)
) STRICT;
CREATE INDEX canonical_pages_domain_idx ON canonical_pages(domain, updated_at DESC);
CREATE INDEX canonical_pages_current_idx ON canonical_pages(current_version_id);

CREATE TABLE page_aliases (
    alias_url_key       TEXT NOT NULL,
    collection          TEXT NOT NULL,
    page_id             TEXT NOT NULL REFERENCES canonical_pages(page_id) ON DELETE CASCADE,
    reason              TEXT NOT NULL CHECK(reason IN ('redirect','canonical_link','manual','normalization')),
    first_seen_at       TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,
    PRIMARY KEY(collection, alias_url_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE page_versions (
    version_id          TEXT PRIMARY KEY CHECK(length(version_id) = 26),
    page_id             TEXT NOT NULL REFERENCES canonical_pages(page_id) ON DELETE CASCADE,
    visit_id            TEXT NOT NULL REFERENCES visits(visit_id),
    ordinal             INTEGER NOT NULL CHECK(ordinal >= 1),
    source_kind         TEXT NOT NULL CHECK(source_kind IN ('live_web','archive','local_import','document','media_transcript')),
    content_sha256      TEXT NOT NULL CHECK(length(content_sha256) = 64),
    semantic_sha256     TEXT NOT NULL CHECK(length(semantic_sha256) = 64),
    source_artifact_id  TEXT NOT NULL,
    markdown_artifact_id TEXT NOT NULL,
    metadata_artifact_id TEXT,
    title               TEXT,
    language            TEXT,
    mime_type           TEXT NOT NULL,
    charset             TEXT,
    word_count          INTEGER NOT NULL DEFAULT 0 CHECK(word_count >= 0),
    text_chars          INTEGER NOT NULL DEFAULT 0 CHECK(text_chars >= 0),
    published_at        TEXT,
    modified_at         TEXT,
    retrieved_at        TEXT NOT NULL,
    sanitizer_version   TEXT NOT NULL,
    normalizer_version  TEXT NOT NULL,
    extractor_chain_json TEXT NOT NULL,
    quality_json        TEXT NOT NULL DEFAULT '{}',
    warnings_json       TEXT NOT NULL DEFAULT '[]',
    accepted            INTEGER NOT NULL DEFAULT 1 CHECK(accepted IN (0,1)),
    tombstoned          INTEGER NOT NULL DEFAULT 0 CHECK(tombstoned IN (0,1)),
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    created_at          TEXT NOT NULL,
    UNIQUE(page_id, ordinal),
    UNIQUE(page_id, content_sha256, sanitizer_version, normalizer_version)
) STRICT;
CREATE INDEX page_versions_page_idx ON page_versions(page_id, ordinal DESC);
CREATE INDEX page_versions_hash_idx ON page_versions(content_sha256);
CREATE INDEX page_versions_retrieved_idx ON page_versions(retrieved_at DESC);

-- Add cyclic foreign keys after both tables exist through validation triggers in implementation.
-- canonical_pages.current_version_id -> page_versions.version_id
-- visits.page_id/version_id -> canonical_pages/page_versions

CREATE TABLE page_tags (
    page_id             TEXT NOT NULL REFERENCES canonical_pages(page_id) ON DELETE CASCADE,
    tag                 TEXT NOT NULL,
    source              TEXT NOT NULL CHECK(source IN ('operator','rule','import','model_derived')),
    derived_artifact_id TEXT,
    created_at          TEXT NOT NULL,
    PRIMARY KEY(page_id, tag, source)
) STRICT, WITHOUT ROWID;

CREATE TABLE page_links (
    source_version_id   TEXT NOT NULL REFERENCES page_versions(version_id) ON DELETE CASCADE,
    ordinal             INTEGER NOT NULL CHECK(ordinal >= 0),
    target_url          TEXT NOT NULL,
    normalized_target_url TEXT,
    target_page_id      TEXT REFERENCES canonical_pages(page_id),
    link_text           TEXT,
    rel                 TEXT,
    nofollow            INTEGER NOT NULL DEFAULT 0 CHECK(nofollow IN (0,1)),
    same_origin         INTEGER NOT NULL CHECK(same_origin IN (0,1)),
    PRIMARY KEY(source_version_id, ordinal)
) STRICT, WITHOUT ROWID;
CREATE INDEX page_links_target_idx ON page_links(target_page_id);

-- Durable bridge between a verified filesystem tree and its published SQLite facts.
-- Persist an intent before rename. Recovery verifies exactly one staging/final tree,
-- then adopts and publishes it or quarantines it idempotently.
CREATE TABLE artifact_commit_intents (
    commit_intent_id    TEXT PRIMARY KEY CHECK(length(commit_intent_id) = 26),
    job_id              TEXT NOT NULL REFERENCES jobs(job_id),
    attempt_id          TEXT REFERENCES job_attempts(attempt_id),
    intent_kind         TEXT NOT NULL CHECK(intent_kind IN ('visit_receipt','page_version','artifact_set','wiki_envelope')),
    idempotency_key     TEXT NOT NULL UNIQUE,
    state               TEXT NOT NULL CHECK(state IN ('prepared','renamed','published','completed','quarantined')),
    staging_relative_path TEXT NOT NULL UNIQUE,
    final_relative_path TEXT NOT NULL UNIQUE,
    manifest_sha256     TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
    expected_files_json TEXT NOT NULL,
    published_reference_type TEXT CHECK(published_reference_type IS NULL OR published_reference_type IN ('visit','page_version','artifact','wiki_delivery')),
    published_reference_id TEXT,
    publication_idempotency_key TEXT UNIQUE,
    recovery_count      INTEGER NOT NULL DEFAULT 0 CHECK(recovery_count >= 0),
    last_verified_at    TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    renamed_at          TEXT,
    published_at        TEXT,
    completed_at        TEXT,
    quarantined_at      TEXT,
    quarantine_paths_json TEXT,
    quarantine_reason_code TEXT CHECK(quarantine_reason_code IS NULL OR quarantine_reason_code IN (
        'STAGING_MISSING','FINAL_MISSING','HASH_MISMATCH','MANIFEST_MISMATCH',
        'PATH_CONFLICT','AMBIGUOUS_CANDIDATES','UNSAFE_PATH','PUBLICATION_CONFLICT',
        'RECOVERY_INVARIANT_VIOLATION'
    )),
    quarantine_safe_detail TEXT CHECK(
        quarantine_safe_detail IS NULL OR (
            length(quarantine_safe_detail) BETWEEN 1 AND 500
            AND instr(quarantine_safe_detail, char(10)) = 0
            AND instr(quarantine_safe_detail, char(13)) = 0
        )
    ),
    CHECK((published_reference_type IS NULL) = (published_reference_id IS NULL)),
    CHECK(length(staging_relative_path) = length('staging/commit-intents/') + 26),
    CHECK(staging_relative_path GLOB 'staging/commit-intents/[0-9a-hjkmnp-tv-z]*'),
    CHECK(substr(staging_relative_path, length('staging/commit-intents/') + 1) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'),
    CHECK(final_relative_path NOT GLOB '*[^A-Za-z0-9._/-]*'),
    CHECK(final_relative_path NOT LIKE '%/../%' AND final_relative_path NOT LIKE '%/./%'),
    CHECK(
        (intent_kind = 'visit_receipt' AND final_relative_path GLOB 'visits/*') OR
        (intent_kind = 'page_version' AND final_relative_path GLOB 'pages/*') OR
        (intent_kind = 'artifact_set' AND final_relative_path GLOB 'artifacts/*') OR
        (intent_kind = 'wiki_envelope' AND final_relative_path GLOB 'wiki/outbox/*')
    ),
    CHECK(state NOT IN ('renamed','published','completed') OR renamed_at IS NOT NULL),
    CHECK(state NOT IN ('published','completed') OR (
        published_at IS NOT NULL
        AND published_reference_type IS NOT NULL
        AND publication_idempotency_key = 'commit-intent:' || commit_intent_id
    )),
    CHECK(state <> 'completed' OR completed_at IS NOT NULL),
    CHECK(state <> 'quarantined' OR (
        quarantined_at IS NOT NULL
        AND quarantine_paths_json IS NOT NULL
        AND quarantine_reason_code IS NOT NULL
    )),
    UNIQUE(published_reference_type, published_reference_id)
) STRICT;
CREATE INDEX artifact_commit_intents_recovery_idx
    ON artifact_commit_intents(state, updated_at);
CREATE INDEX artifact_commit_intents_job_idx
    ON artifact_commit_intents(job_id, created_at);

-- The application applies the same transition table from
-- semantics/artifact-commit-intent-semantics.json before it writes. These
-- triggers are defense in depth and reject skipped, reverse, or terminal writes.
CREATE TRIGGER artifact_commit_intents_initial_state
BEFORE INSERT ON artifact_commit_intents
WHEN NEW.state <> 'prepared'
BEGIN
    SELECT RAISE(ABORT, 'WEBX_COMMIT_INTENT_INITIAL_STATE_INVALID');
END;

CREATE TRIGGER artifact_commit_intents_state_transition
BEFORE UPDATE OF state ON artifact_commit_intents
WHEN NEW.state <> OLD.state AND NOT (
    (OLD.state = 'prepared' AND NEW.state IN ('renamed','quarantined')) OR
    (OLD.state = 'renamed' AND NEW.state IN ('published','quarantined')) OR
    (OLD.state = 'published' AND NEW.state IN ('completed','quarantined'))
)
BEGIN
    SELECT RAISE(ABORT, 'WEBX_COMMIT_INTENT_TRANSITION_INVALID');
END;

CREATE TRIGGER artifact_commit_intents_terminal_update
BEFORE UPDATE ON artifact_commit_intents
WHEN OLD.state IN ('completed','quarantined')
BEGIN
    SELECT RAISE(ABORT, 'WEBX_COMMIT_INTENT_TERMINAL_IMMUTABLE');
END;

CREATE TRIGGER artifact_commit_intents_terminal_delete
BEFORE DELETE ON artifact_commit_intents
WHEN OLD.state IN ('completed','quarantined')
BEGIN
    SELECT RAISE(ABORT, 'WEBX_COMMIT_INTENT_TERMINAL_IMMUTABLE');
END;

CREATE TABLE blobs (
    blob_sha256         TEXT PRIMARY KEY CHECK(length(blob_sha256) = 64),
    size_bytes          INTEGER NOT NULL CHECK(size_bytes >= 0),
    storage_relative_path TEXT NOT NULL UNIQUE,
    media_type          TEXT,
    compression         TEXT NOT NULL DEFAULT 'none',
    encryption_json     TEXT,
    quarantine_state    TEXT NOT NULL DEFAULT 'clean' CHECK(quarantine_state IN ('clean','quarantined','rejected')),
    reference_count_cache INTEGER NOT NULL DEFAULT 0 CHECK(reference_count_cache >= 0),
    first_referenced_at TEXT NOT NULL,
    last_referenced_at  TEXT NOT NULL,
    verified_at         TEXT,
    deleted_at          TEXT,
    metadata_json       TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX blobs_gc_idx ON blobs(deleted_at, quarantine_state, last_referenced_at);

CREATE TABLE artifacts (
    artifact_id         TEXT PRIMARY KEY CHECK(length(artifact_id) = 26),
    kind                TEXT NOT NULL,
    sha256              TEXT NOT NULL CHECK(length(sha256) = 64),
    size_bytes          INTEGER NOT NULL CHECK(size_bytes >= 0),
    mime_type           TEXT NOT NULL,
    encoding            TEXT,
    relative_path       TEXT NOT NULL UNIQUE,
    blob_sha256         TEXT NOT NULL REFERENCES blobs(blob_sha256) CHECK(length(blob_sha256) = 64),
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    source_trust        TEXT NOT NULL CHECK(source_trust IN ('untrusted_external_source','trusted_local_input','derived_output','system_metadata')),
    retention_class     TEXT NOT NULL,
    retention_until     TEXT,
    legal_hold          INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN (0,1)),
    committed           INTEGER NOT NULL DEFAULT 0 CHECK(committed IN (0,1)),
    created_by_job_id   TEXT REFERENCES jobs(job_id),
    created_at          TEXT NOT NULL,
    verified_at         TEXT,
    deleted_at          TEXT,
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    UNIQUE(kind, sha256, visibility)
) STRICT;
CREATE INDEX artifacts_blob_idx ON artifacts(blob_sha256);
CREATE INDEX artifacts_retention_idx ON artifacts(deleted_at, legal_hold, retention_until);

CREATE TABLE artifact_edges (
    parent_artifact_id  TEXT NOT NULL REFERENCES artifacts(artifact_id),
    child_artifact_id   TEXT NOT NULL REFERENCES artifacts(artifact_id),
    relationship        TEXT NOT NULL CHECK(relationship IN ('derived_from','contains','thumbnail_of','transcript_of','metadata_for','receipt_for','archive_of','chunk_of')),
    created_at          TEXT NOT NULL,
    PRIMARY KEY(parent_artifact_id, child_artifact_id, relationship)
) STRICT, WITHOUT ROWID;

CREATE TABLE chunks (
    chunk_id            TEXT PRIMARY KEY CHECK(length(chunk_id) = 64),
    page_id             TEXT NOT NULL REFERENCES canonical_pages(page_id) ON DELETE CASCADE,
    version_id          TEXT NOT NULL REFERENCES page_versions(version_id) ON DELETE CASCADE,
    source_artifact_id  TEXT NOT NULL REFERENCES artifacts(artifact_id),
    chunker_version     TEXT NOT NULL,
    ordinal             INTEGER NOT NULL CHECK(ordinal >= 0),
    heading_path_json   TEXT NOT NULL DEFAULT '[]',
    source_locator_json TEXT NOT NULL,
    content_sha256      TEXT NOT NULL CHECK(length(content_sha256) = 64),
    text_content        TEXT NOT NULL,
    token_estimate      INTEGER NOT NULL DEFAULT 0 CHECK(token_estimate >= 0),
    character_count     INTEGER NOT NULL CHECK(character_count >= 0),
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    current             INTEGER NOT NULL DEFAULT 0 CHECK(current IN (0,1)),
    created_at          TEXT NOT NULL,
    UNIQUE(version_id, chunker_version, ordinal),
    UNIQUE(version_id, chunker_version, content_sha256, source_locator_json)
) STRICT;
CREATE INDEX chunks_page_current_idx ON chunks(page_id, current, ordinal);
CREATE INDEX chunks_version_idx ON chunks(version_id, ordinal);
CREATE INDEX chunks_content_hash_idx ON chunks(content_sha256);

CREATE TABLE tombstones (
    tombstone_id        TEXT PRIMARY KEY CHECK(length(tombstone_id) = 26),
    target_type         TEXT NOT NULL CHECK(target_type IN ('page','page_version','artifact','document','media','archive','watch','wiki_delivery')),
    target_id           TEXT NOT NULL,
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    reason_code         TEXT NOT NULL,
    reason_detail       TEXT,
    actor_id            TEXT REFERENCES actors(actor_id),
    job_id              TEXT REFERENCES jobs(job_id),
    source_tombstone_id TEXT REFERENCES tombstones(tombstone_id),
    propagation_state   TEXT NOT NULL DEFAULT 'pending' CHECK(propagation_state IN ('pending','index_queued','wiki_queued','propagated','partial','failed')),
    purge_after         TEXT,
    legal_hold          INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN (0,1)),
    created_at          TEXT NOT NULL,
    propagated_at       TEXT,
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    UNIQUE(target_type, target_id, reason_code, created_at)
) STRICT;
CREATE INDEX tombstones_target_idx ON tombstones(target_type, target_id, created_at DESC);
CREATE INDEX tombstones_gc_idx ON tombstones(legal_hold, purge_after, propagation_state);

CREATE TABLE index_projections (
    projection_id       TEXT PRIMARY KEY CHECK(length(projection_id) = 26),
    projection_kind     TEXT NOT NULL CHECK(projection_kind IN ('page_upsert','page_delete','chunk_upsert','chunk_delete','history_upsert','settings_apply','index_swap')),
    target_index        TEXT NOT NULL,
    document_id         TEXT,
    page_id             TEXT REFERENCES canonical_pages(page_id),
    version_id          TEXT REFERENCES page_versions(version_id),
    source_artifact_id  TEXT REFERENCES artifacts(artifact_id),
    idempotency_key     TEXT NOT NULL UNIQUE,
    document_json       TEXT,
    state               TEXT NOT NULL CHECK(state IN ('pending','leased','submitted','succeeded','failed','dead_letter')),
    attempt             INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    not_before          TEXT NOT NULL,
    lease_owner         TEXT,
    lease_expires_at    TEXT,
    meilisearch_task_uid INTEGER,
    error_code          TEXT,
    error_json          TEXT,
    created_at          TEXT NOT NULL,
    submitted_at        TEXT,
    completed_at        TEXT
) STRICT;
CREATE INDEX index_projections_claim_idx ON index_projections(state, not_before, created_at);
CREATE INDEX index_projections_page_idx ON index_projections(page_id, created_at);

CREATE TABLE wiki_consumers (
    consumer_id         TEXT PRIMARY KEY,
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    max_visibility      TEXT NOT NULL CHECK(max_visibility IN ('public','internal','private','secret')),
    collections_json    TEXT NOT NULL,
    delivery_mode       TEXT NOT NULL CHECK(delivery_mode IN ('filesystem','api','both')),
    outbox_relative_path TEXT,
    lease_seconds       INTEGER NOT NULL DEFAULT 300 CHECK(lease_seconds >= 30),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    metadata_json       TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE wiki_deliveries (
    delivery_id         TEXT PRIMARY KEY CHECK(length(delivery_id) = 26),
    consumer_id         TEXT NOT NULL REFERENCES wiki_consumers(consumer_id) ON DELETE CASCADE,
    sequence            INTEGER NOT NULL CHECK(sequence >= 1),
    operation           TEXT NOT NULL CHECK(operation IN ('source_upsert','source_tombstone')),
    page_id             TEXT NOT NULL REFERENCES canonical_pages(page_id),
    version_id          TEXT REFERENCES page_versions(version_id),
    source_artifact_id  TEXT REFERENCES artifacts(artifact_id),
    idempotency_key     TEXT NOT NULL,
    envelope_relative_path TEXT,
    envelope_sha256     TEXT CHECK(envelope_sha256 IS NULL OR length(envelope_sha256) = 64),
    state               TEXT NOT NULL CHECK(state IN ('pending','exported','leased','accepted','rejected','deferred','dead_letter')),
    attempt             INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    not_before          TEXT NOT NULL,
    lease_token_hash    TEXT,
    lease_expires_at    TEXT,
    supersedes_delivery_id TEXT REFERENCES wiki_deliveries(delivery_id),
    external_document_id TEXT,
    ack_reason_code     TEXT,
    ack_detail          TEXT,
    created_at          TEXT NOT NULL,
    exported_at         TEXT,
    acknowledged_at     TEXT,
    UNIQUE(consumer_id, sequence),
    UNIQUE(consumer_id, idempotency_key)
) STRICT;
CREATE INDEX wiki_deliveries_claim_idx ON wiki_deliveries(consumer_id, state, not_before, sequence);
CREATE INDEX wiki_deliveries_page_idx ON wiki_deliveries(consumer_id, page_id, sequence);

CREATE TABLE model_runtimes (
    runtime_id          TEXT PRIMARY KEY,
    runtime_kind        TEXT NOT NULL CHECK(runtime_kind IN ('llama_cpp','vllm')),
    base_url            TEXT NOT NULL,
    secret_ref          TEXT,
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    health_state        TEXT NOT NULL CHECK(health_state IN ('healthy','degraded','unhealthy','unknown','disabled')),
    capabilities_json   TEXT NOT NULL,
    concurrency_limit   INTEGER NOT NULL DEFAULT 1 CHECK(concurrency_limit >= 1),
    default_models_json TEXT NOT NULL,
    last_probe_at       TEXT,
    diagnostics_json    TEXT NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
) STRICT;

CREATE TABLE model_runs (
    model_run_id        TEXT PRIMARY KEY CHECK(length(model_run_id) = 26),
    job_id              TEXT NOT NULL REFERENCES jobs(job_id),
    runtime_id          TEXT NOT NULL REFERENCES model_runtimes(runtime_id),
    workload            TEXT NOT NULL CHECK(workload IN ('structured_extract','embedding','rerank','summary','classification','vision_extract')),
    model_id            TEXT NOT NULL,
    model_revision      TEXT,
    model_digest        TEXT,
    input_artifact_ids_json TEXT NOT NULL,
    prompt_template_id  TEXT,
    schema_artifact_id  TEXT REFERENCES artifacts(artifact_id),
    parameters_json     TEXT NOT NULL,
    state               TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
    started_at          TEXT,
    completed_at        TEXT,
    usage_json          TEXT NOT NULL DEFAULT '{}',
    output_artifact_id  TEXT REFERENCES artifacts(artifact_id),
    error_code          TEXT,
    error_json          TEXT,
    created_at          TEXT NOT NULL
) STRICT;
CREATE INDEX model_runs_job_idx ON model_runs(job_id, created_at);

CREATE TABLE documents (
    document_id         TEXT PRIMARY KEY CHECK(length(document_id) = 26),
    source_artifact_id  TEXT NOT NULL REFERENCES artifacts(artifact_id),
    detected_mime_type  TEXT NOT NULL,
    route               TEXT NOT NULL,
    page_count          INTEGER CHECK(page_count IS NULL OR page_count >= 0),
    ocr_state           TEXT NOT NULL CHECK(ocr_state IN ('not_needed','pending','succeeded','failed','unknown')),
    scholarly_state     TEXT NOT NULL CHECK(scholarly_state IN ('not_requested','pending','succeeded','failed')),
    docling_artifact_id TEXT REFERENCES artifacts(artifact_id),
    markdown_artifact_id TEXT REFERENCES artifacts(artifact_id),
    metadata_artifact_id TEXT REFERENCES artifacts(artifact_id),
    current_version_id  TEXT REFERENCES page_versions(version_id),
    warnings_json       TEXT NOT NULL DEFAULT '[]',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE(source_artifact_id)
) STRICT;

CREATE TABLE media_items (
    media_item_id       TEXT PRIMARY KEY CHECK(length(media_item_id) = 26),
    source_url          TEXT,
    source_artifact_id  TEXT REFERENCES artifacts(artifact_id),
    extractor           TEXT,
    external_id         TEXT,
    metadata_artifact_id TEXT REFERENCES artifacts(artifact_id),
    duration_seconds    REAL CHECK(duration_seconds IS NULL OR duration_seconds >= 0),
    is_live             INTEGER CHECK(is_live IS NULL OR is_live IN (0,1)),
    acquisition_state   TEXT NOT NULL CHECK(acquisition_state IN ('metadata_only','pending','succeeded','partial','failed')),
    selected_formats_json TEXT NOT NULL DEFAULT '[]',
    media_artifact_id   TEXT REFERENCES artifacts(artifact_id),
    transcript_artifact_id TEXT REFERENCES artifacts(artifact_id),
    warnings_json       TEXT NOT NULL DEFAULT '[]',
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE(extractor, external_id)
) STRICT;

CREATE TABLE archives (
    archive_id          TEXT PRIMARY KEY CHECK(length(archive_id) = 26),
    job_id              TEXT NOT NULL REFERENCES jobs(job_id),
    visit_id            TEXT REFERENCES visits(visit_id),
    crawl_id            TEXT REFERENCES crawls(crawl_id),
    engine              TEXT NOT NULL CHECK(engine IN ('archivebox','browsertrix','import')),
    warc_artifact_id    TEXT REFERENCES artifacts(artifact_id),
    wacz_artifact_id    TEXT REFERENCES artifacts(artifact_id),
    metadata_artifact_id TEXT REFERENCES artifacts(artifact_id),
    replay_locator      TEXT,
    completeness        TEXT NOT NULL CHECK(completeness IN ('complete','partial','unknown')),
    warnings_json       TEXT NOT NULL DEFAULT '[]',
    captured_at         TEXT NOT NULL,
    created_at          TEXT NOT NULL
) STRICT;

CREATE TABLE watches (
    watch_id            TEXT PRIMARY KEY CHECK(length(watch_id) = 26),
    actor_id            TEXT NOT NULL REFERENCES actors(actor_id),
    target_url          TEXT NOT NULL,
    schedule            TEXT NOT NULL,
    selector            TEXT,
    mode                TEXT NOT NULL,
    collection          TEXT NOT NULL,
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    last_job_id         TEXT REFERENCES jobs(job_id),
    last_version_id     TEXT REFERENCES page_versions(version_id),
    last_check_at       TEXT,
    next_run_at         TEXT,
    failure_count       INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
    notification_json   TEXT NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
) STRICT;
CREATE INDEX watches_schedule_idx ON watches(enabled, next_run_at);

CREATE TABLE feeds (
    feed_id             TEXT PRIMARY KEY CHECK(length(feed_id) = 26),
    source_url          TEXT NOT NULL,
    feed_url            TEXT NOT NULL,
    provider            TEXT NOT NULL CHECK(provider IN ('native','rsshub','rssbridge')),
    title               TEXT,
    language            TEXT,
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    last_fetch_at       TEXT,
    etag                TEXT,
    last_modified       TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE(feed_url)
) STRICT;

CREATE TABLE audit_events (
    audit_id            TEXT PRIMARY KEY CHECK(length(audit_id) = 26),
    occurred_at         TEXT NOT NULL,
    actor_id            TEXT REFERENCES actors(actor_id),
    action              TEXT NOT NULL,
    outcome             TEXT NOT NULL CHECK(outcome IN ('allowed','denied','succeeded','failed')),
    target_type         TEXT,
    target_id           TEXT,
    request_id          TEXT,
    job_id              TEXT REFERENCES jobs(job_id),
    visibility          TEXT NOT NULL CHECK(visibility IN ('public','internal','private','secret')),
    safe_context_json   TEXT NOT NULL,
    previous_hash       TEXT,
    record_hash         TEXT NOT NULL CHECK(length(record_hash) = 64)
) STRICT;
CREATE INDEX audit_events_time_idx ON audit_events(occurred_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_id, occurred_at DESC);

CREATE TABLE backups (
    backup_id           TEXT PRIMARY KEY CHECK(length(backup_id) = 26),
    state               TEXT NOT NULL CHECK(state IN ('creating','succeeded','failed','verified','invalid','restored')),
    backup_kind         TEXT NOT NULL CHECK(backup_kind IN ('full','incremental','config','database','artifacts')),
    location            TEXT NOT NULL,
    manifest_artifact_id TEXT REFERENCES artifacts(artifact_id),
    manifest_sha256     TEXT CHECK(manifest_sha256 IS NULL OR length(manifest_sha256) = 64),
    database_schema_version INTEGER NOT NULL,
    webx_version        TEXT NOT NULL,
    includes_json       TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    completed_at        TEXT,
    verified_at         TEXT,
    error_json          TEXT
) STRICT;

CREATE TABLE scheduled_tasks (
    task_id             TEXT PRIMARY KEY,
    task_kind           TEXT NOT NULL,
    schedule            TEXT NOT NULL,
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    parameters_json     TEXT NOT NULL,
    next_run_at         TEXT,
    last_job_id         TEXT REFERENCES jobs(job_id),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
) STRICT;
CREATE INDEX scheduled_tasks_run_idx ON scheduled_tasks(enabled, next_run_at);

-- Required integrity validation in the application/migrations:
-- 1. Validate all JSON text fields against their application schemas before writes.
-- 2. Validate the cyclic current-version/visit references before transaction commit.
-- 3. Enforce visibility non-downgrade across artifact edges and projections.
-- 4. Enforce immutable fields for committed artifacts/page versions/terminal visits.
-- 5. Reject runtime_kind values other than llama_cpp or vllm at config and DB layers.
-- 6. Verify artifacts.blob_sha256, artifacts.sha256, byte size, and committed path before commit.
-- 7. Recompute deterministic chunk IDs from version/chunker/ordinal/content inputs before insert.
-- 8. Propagate tombstones to index/wiki outboxes before any eligible blob garbage collection.
-- 9. Expire browser sessions when either idle or absolute lifetime is reached and revoke credentials/egress grants.
