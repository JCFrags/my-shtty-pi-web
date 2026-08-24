use crate::auth::{ConnectionContext, Principal, forbidden};
use crate::config::{DaemonConfig, XdgPaths};
use crate::operation::{OperationHandle, OperationRecord, OperationRegistry, cancelled, cancelled_error};
use crate::transfer::{BackendTransferHandle, TransferKind, parse_transfer, resolve_transfer};
use crate::upload::UploadRegistry;
use anyhow::{Context, Result as AnyResult, anyhow};
use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use dashmap::{DashMap, DashSet};
use pi_web_artifact_store::{ArtifactContext, ArtifactRecord as StoredArtifactRecord, ArtifactStore};
use pi_web_backend_agent_browser::{AgentBrowserController, Cancellation as CuaCancellation, CuaAction, VisualBinding as BackendVisualBinding};
use pi_web_backend_core::{BackendError, BrowserController};
use pi_web_backend_pinchtab::PinchTabController;
use pi_web_protocol::*;
use pi_web_reader_client::{ReadRequest, ReadResponse, ReadSource, ReaderClient, SearchClient, SearchQuery};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
use tokio::process::Command;
use tokio::sync::{Mutex, Notify, broadcast, watch};
use url::Url;
use uuid::Uuid;

const HEARTBEAT_INTERVAL_SECONDS: u64 = 5;
const DISCONNECT_AFTER_SECONDS: i64 = 15;
const MODEL_DEFAULT_MAX_CHARS: usize = 16_000;
const DEBUG_DEFAULT_MAX_CHARS: usize = 32_000;

#[derive(Clone)]
pub struct Coordinator {
    pub config: Arc<DaemonConfig>,
    pub paths: Arc<XdgPaths>,
    pub artifacts: ArtifactStore,
    events: broadcast::Sender<ScopedEvent>,
    agents: Arc<DashMap<AgentId, AgentRegistration>>,
    agent_bindings: Arc<DashMap<AgentId, String>>,
    client_bindings: Arc<DashMap<ClientId, String>>,
    clients: Arc<DashMap<ClientId, ClientState>>,
    disconnected_clients: Arc<DashSet<ClientId>>,
    profiles: Arc<DashMap<ProfileId, BrowserProfile>>,
    profile_owners: Arc<DashMap<ProfileId, AgentId>>,
    hosts: Arc<DashMap<HostId, Arc<HostEntry>>>,
    sessions: Arc<DashMap<BrowserSessionId, BrowserSession>>,
    tabs: Arc<DashMap<TabId, TabInfo>>,
    profile_hosts: Arc<DashMap<ProfileId, HostId>>,
    profile_locks: Arc<DashMap<ProfileId, Arc<Mutex<()>>>>,
    controls: Arc<DashMap<TabId, Arc<ControlGate>>>,
    agent_browser: Arc<AgentBrowserController>,
    pinchtab: Arc<PinchTabController>,
    search: SearchClient,
    reader: ReaderClient,
    workspace: Arc<Mutex<WorkspaceState>>,
    workspace_leases: Arc<DashMap<String, WorkspaceViewportLease>>,
    workspace_events: Arc<DashMap<AgentId, Vec<WorkspaceSafeEvent>>>,
    operations: OperationRegistry,
    uploads: UploadRegistry,
    shutdown: Arc<Notify>,
}

#[derive(Clone)]
struct ClientState {
    registration: AgentRegistration,
}

struct HostEntry {
    handle: BrowserHostHandle,
    controller: Arc<dyn BrowserController>,
    queue: Mutex<()>,
    persistent: bool,
    launch: StartHostRequest,
}

struct ControlGate {
    sender: watch::Sender<TabControl>,
    epoch: AtomicU64,
}

#[derive(Clone, Debug)]
pub(crate) struct ScopedEvent {
    pub notification: RpcNotification,
    pub owner_agent_id: Option<AgentId>,
}

#[derive(Clone, Debug, Default)]
struct WorkspaceState {
    visible: bool,
    focused_principal: Option<Principal>,
    focused_agent_id: Option<AgentId>,
    focused_tab_id: Option<TabId>,
    scope_id: Option<String>,
    viewport_generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSafeEvent {
    id: String,
    at: String,
    message: String,
}

#[derive(Clone, Debug)]
struct WorkspaceViewportLease {
    lease_id: String,
    scope_id: String,
    owner_agent_id: AgentId,
    browser_session_id: BrowserSessionId,
    tab_id: TabId,
    viewport_id: String,
    viewport_generation: u64,
    expires_at: DateTime<Utc>,
    last_input_sequence: u64,
    current_binding: Option<BackendVisualBinding>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistrySnapshot {
    protocol_version: String,
    saved_at: DateTime<Utc>,
    agents: Vec<AgentRegistration>,
    profiles: Vec<BrowserProfile>,
    #[serde(default)]
    profile_owners: BTreeMap<ProfileId, AgentId>,
    hosts: Vec<RecoveredHost>,
    sessions: Vec<BrowserSession>,
    tabs: Vec<TabInfo>,
    #[serde(default)]
    control_epochs: BTreeMap<TabId, u64>,
    #[serde(default)]
    operations: Vec<OperationRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveredHost {
    handle: BrowserHostHandle,
    persistent: bool,
    launch: StartHostRequest,
}

#[derive(Debug, Default, Deserialize)]
struct ProfilesFile {
    #[serde(default)]
    profiles: Vec<ProfileFileEntry>,
}

#[derive(Debug, Deserialize)]
struct ProfileFileEntry {
    profile_id: Option<ProfileId>,
    name: String,
    data_dir: Option<String>,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    launch_args: Vec<String>,
    #[serde(default = "default_true")]
    visible_by_default: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterAgentParams {
    agent_id: AgentId,
    client_id: ClientId,
    pi_session_id: Option<String>,
    pi_session_file: Option<String>,
    pi_session_name: Option<String>,
    cwd: String,
    pid: u32,
    mode: PiMode,
    started_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentAddress {
    agent_id: AgentId,
    client_id: ClientId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentOnly {
    agent_id: AgentId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileCreateParams {
    name: String,
    data_dir: Option<String>,
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    launch_args: Vec<String>,
    #[serde(default = "default_true")]
    visible_by_default: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileUpdateParams {
    profile_id: ProfileId,
    name: Option<String>,
    data_dir: Option<String>,
    extensions: Option<Vec<String>>,
    launch_args: Option<Vec<String>>,
    visible_by_default: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileDeleteParams {
    profile_id: ProfileId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserStartParams {
    agent_id: AgentId,
    #[serde(default)]
    engine: EngineSelection,
    #[serde(default)]
    backend: BackendSelection,
    profile_id: Option<ProfileId>,
    profile: Option<String>,
    visible: Option<bool>,
    url: Option<String>,
    label: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum EngineSelection {
    #[default]
    Auto,
    Lightpanda,
    Chromium,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum BackendSelection {
    #[default]
    AgentBrowser,
    Pinchtab,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionAddress {
    agent_id: AgentId,
    #[serde(alias = "sessionId")]
    browser_session_id: BrowserSessionId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCreateV2Params {
    agent_id: AgentId,
    path_id: BrowserPathId,
    profile_id: Option<ProfileId>,
    visible: Option<bool>,
    url: Option<String>,
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenTabParams {
    agent_id: AgentId,
    #[serde(alias = "sessionId")]
    browser_session_id: BrowserSessionId,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabAddressParams {
    agent_id: AgentId,
    #[serde(alias = "sessionId")]
    browser_session_id: BrowserSessionId,
    tab_id: TabId,
    #[serde(default)]
    source: ActionSource,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NavigateParams {
    agent_id: AgentId,
    browser_session_id: BrowserSessionId,
    tab_id: TabId,
    url: String,
    operation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObserveParams {
    agent_id: AgentId,
    browser_session_id: BrowserSessionId,
    tab_id: TabId,
    #[serde(default = "default_observation_view")]
    view: ObservationView,
    selector: Option<String>,
    max_chars: Option<usize>,
    #[serde(default)]
    include_bounds: bool,
    operation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActParams {
    agent_id: AgentId,
    browser_session_id: BrowserSessionId,
    tab_id: TabId,
    action: BrowserAction,
    #[serde(default)]
    source: ActionSource,
    operation_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ActionSource {
    #[default]
    Agent,
    Human,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DebugParams {
    agent_id: AgentId,
    browser_session_id: BrowserSessionId,
    tab_id: TabId,
    operation: DebugOperation,
    #[serde(default)]
    args: BTreeMap<String, Value>,
    max_chars: Option<usize>,
    operation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlParams {
    agent_id: AgentId,
    browser_session_id: BrowserSessionId,
    tab_id: TabId,
    control: TabControl,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserListParams {
    agent_id: Option<AgentId>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFocusParams {
    agent_id: AgentId,
    browser_session_id: Option<BrowserSessionId>,
    tab_id: Option<TabId>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadUrlParams {
    agent_id: Option<AgentId>,
    #[serde(flatten)]
    request: ReadRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactGetParams {
    artifact_id: ArtifactId,
    #[serde(default)]
    offset: u64,
    #[serde(default = "default_artifact_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactListParams {
    owner_agent_id: Option<AgentId>,
    browser_session_id: Option<BrowserSessionId>,
    #[serde(default = "default_artifact_list_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactDeleteParams {
    artifact_id: ArtifactId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationAddressParams {
    operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StageUploadParams {
    agent_id: AgentId,
    browser_session_id: BrowserSessionId,
    media_type: String,
    data_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitUploadParams {
    agent_id: AgentId,
    browser_session_id: BrowserSessionId,
    upload_handle_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceScopeParams { scope_id: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceTabParams { scope_id: String, tab_id: TabId }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceLeaseParams { scope_id: String, lease_id: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceControlParams {
    scope_id: String,
    lease_id: String,
    viewport_id: String,
    viewport_generation: u64,
    control: TabControl,
    expected_control_epoch: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInputParams {
    scope_id: String,
    lease_id: String,
    viewport_id: String,
    viewport_generation: u64,
    control_epoch: u64,
    screenshot_sha256: String,
    screenshot_sequence: u64,
    input_sequence: u64,
    action: CuaAction,
    operation_id: Option<String>,
}

#[derive(Clone)]
struct ResolvedAddress {
    host: Arc<HostEntry>,
    tab: TabInfo,
    gate: Arc<ControlGate>,
    address: BrowserAddress,
}

fn workspace_lease_error() -> RpcError {
    RpcError { code: -32003, message: "viewport lease unavailable".into(), data: Some(json!({ "code": "lease_expired" })) }
}

fn workspace_backend(backend: BrowserBackend) -> &'static str {
    match backend {
        BrowserBackend::AgentBrowser => "agent-browser",
        BrowserBackend::Pinchtab => "pinchtab",
    }
}

fn safe_workspace_text(value: &str, limit: usize) -> String {
    value.chars().filter(|character| !character.is_control()).take(limit).collect()
}

fn safe_workspace_url(value: &str) -> String {
    Url::parse(value).ok().filter(|url| matches!(url.scheme(), "http" | "https" | "about"))
        .map(|url| url.to_string()).unwrap_or_else(|| "about:blank".into())
}

fn safe_workspace_event_message(method: &str) -> &'static str {
    match method {
        "session.changed" => "Browser session changed.",
        "tab.changed" => "Browser tab changed.",
        "operation.changed" => "Browser operation changed.",
        "control.changed" => "Browser control changed.",
        "artifact.created" => "Browser artifact created.",
        "lifecycle.changed" => "Browser lifecycle changed.",
        _ => "Browser state changed.",
    }
}

fn safe_operation_label(kind: &str) -> &'static str {
    match kind {
        "act" => "Browser action", "observe" => "Browser observation", "navigate" => "Navigation",
        "debug" => "Browser diagnostic", _ => "Browser operation",
    }
}

fn workspace_operation_state(state: crate::operation::OperationState) -> &'static str {
    match state {
        crate::operation::OperationState::Queued => "queued",
        crate::operation::OperationState::Running | crate::operation::OperationState::Committed => "running",
        crate::operation::OperationState::Succeeded => "succeeded",
        crate::operation::OperationState::Failed => "failed",
        crate::operation::OperationState::Cancelled => "cancelled",
    }
}

fn default_true() -> bool { true }
fn default_observation_view() -> ObservationView { ObservationView::Main }
fn default_artifact_limit() -> usize { 64 * 1024 }
fn default_artifact_list_limit() -> usize { 100 }

impl ControlGate {
    fn new(initial: TabControl) -> Self { Self::with_epoch(initial, 1) }

    fn with_epoch(initial: TabControl, epoch: u64) -> Self {
        let (sender, _) = watch::channel(initial);
        Self { sender, epoch: AtomicU64::new(epoch) }
    }

    fn current(&self) -> TabControl { *self.sender.borrow() }
    fn epoch(&self) -> u64 { self.epoch.load(Ordering::Acquire) }

    fn set(&self, control: TabControl) -> u64 {
        if self.current() != control {
            self.epoch.fetch_add(1, Ordering::AcqRel);
            self.sender.send_replace(control);
        }
        self.epoch()
    }

    async fn wait_for_agent(&self) {
        let mut receiver = self.sender.subscribe();
        while *receiver.borrow() == TabControl::Human {
            if receiver.changed().await.is_err() { break; }
        }
    }

    async fn wait_for_agent_or_cancel(&self, operation: &OperationHandle) -> Result<(), RpcError> {
        let mut control = self.sender.subscribe();
        let mut cancellation = operation.cancellation();
        loop {
            if operation.is_cancelled() { return Err(cancelled_error(&operation.id())); }
            if *control.borrow() != TabControl::Human { return Ok(()); }
            tokio::select! {
                changed = control.changed() => {
                    if changed.is_err() { return Ok(()); }
                }
                _ = cancelled(&mut cancellation) => return Err(cancelled_error(&operation.id())),
            }
        }
    }
}

impl Coordinator {
    pub async fn new(config: DaemonConfig, paths: XdgPaths) -> AnyResult<Arc<Self>> {
        paths.ensure()?;
        let artifacts = ArtifactStore::open(&paths.data)?;
        let uploads = UploadRegistry::new(&paths.data)?;
        let (events, _) = broadcast::channel(2_048);
        let agent_browser = Arc::new(
            AgentBrowserController::new(&config.agent_browser_binary)?
                .with_download_root(paths.data.join("downloads"))
                .with_visual_chromium(
                    config.visual_chromium.executable_path.clone(),
                    config.visual_chromium.launch_args.clone(),
                ),
        );
        let search = SearchClient::new(Url::parse(&config.searxng_url).context("invalid searxng_url")?)?;
        let reader = ReaderClient::new(Url::parse(&config.reader_url).context("invalid reader_url")?)?;
        let coordinator = Arc::new(Self {
            config: Arc::new(config),
            paths: Arc::new(paths),
            artifacts,
            events,
            agents: Arc::new(DashMap::new()),
            agent_bindings: Arc::new(DashMap::new()),
            client_bindings: Arc::new(DashMap::new()),
            clients: Arc::new(DashMap::new()),
            disconnected_clients: Arc::new(DashSet::new()),
            profiles: Arc::new(DashMap::new()),
            profile_owners: Arc::new(DashMap::new()),
            hosts: Arc::new(DashMap::new()),
            sessions: Arc::new(DashMap::new()),
            tabs: Arc::new(DashMap::new()),
            profile_hosts: Arc::new(DashMap::new()),
            profile_locks: Arc::new(DashMap::new()),
            controls: Arc::new(DashMap::new()),
            agent_browser,
            pinchtab: Arc::new(PinchTabController::new("pinchtab")?),
            search,
            reader,
            workspace: Arc::new(Mutex::new(WorkspaceState::default())),
            workspace_leases: Arc::new(DashMap::new()),
            workspace_events: Arc::new(DashMap::new()),
            operations: OperationRegistry::default(),
            uploads,
            shutdown: Arc::new(Notify::new()),
        });
        coordinator.restore_snapshot().await?;
        if coordinator.load_profiles_file()? {
            coordinator.save_snapshot().await;
        }
        Ok(coordinator)
    }

    fn load_profiles_file(&self) -> AnyResult<bool> {
        let path = self.paths.config.join("profiles.toml");
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        let configured: ProfilesFile = toml::from_str(&content).with_context(|| format!("parse {}", path.display()))?;
        let mut changed = false;
        for item in configured.profiles {
            if item.name.trim().is_empty() || self.profiles.iter().any(|profile| profile.name == item.name) {
                continue;
            }
            let data_dir = item.data_dir
                .map(expand_home)
                .unwrap_or_else(|| self.paths.data.join("profiles").join(safe_name(&item.name)).to_string_lossy().into_owned());
            let extensions = item.extensions.into_iter().map(expand_home).collect();
            let identity = format!("{}:{data_dir}", item.name);
            let profile = BrowserProfile {
                profile_id: item.profile_id.unwrap_or_else(|| ProfileId(Uuid::new_v5(&Uuid::NAMESPACE_OID, identity.as_bytes()).to_string())),
                name: item.name,
                engine: ChromiumOnly::Chromium,
                data_dir,
                extensions,
                launch_args: item.launch_args,
                visible_by_default: item.visible_by_default,
            };
            self.profiles.insert(profile.profile_id.clone(), profile);
            changed = true;
        }
        Ok(changed)
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ScopedEvent> {
        self.events.subscribe()
    }

    pub(crate) fn event_visible_to(event: &ScopedEvent, principal: &Principal) -> bool {
        RPC_EVENTS.contains(&event.notification.method.as_str())
            && event.owner_agent_id.as_ref().is_some_and(|owner| owner == &principal.agent_id)
    }

    pub fn request_shutdown(&self) { self.shutdown.notify_waiters(); }
    pub async fn shutdown_requested(&self) { self.shutdown.notified().await; }

    pub fn spawn_heartbeat_sweeper(self: &Arc<Self>) {
        let coordinator = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECONDS));
            loop {
                tokio::select! {
                    _ = ticker.tick() => coordinator.sweep_disconnected(),
                    _ = coordinator.shutdown.notified() => break,
                }
            }
        });
    }

    fn sweep_disconnected(&self) {
        let cutoff = Utc::now() - Duration::seconds(DISCONNECT_AFTER_SECONDS);
        for client in self.clients.iter() {
            if client.registration.last_heartbeat_at < cutoff
                && self.disconnected_clients.insert(client.key().clone())
            {
                self.emit(
                    "agent.disconnected",
                    json!({ "agentId": client.registration.agent_id, "clientId": client.registration.client_id }),
                );
            }
        }
    }

    pub async fn dispatch(&self, request: JsonRpcRequest) -> JsonRpcResponse {
        self.dispatch_connected(&ConnectionContext::new(), request).await
    }

    /// Bind the workspace transport to the principal that asked the daemon to
    /// show the workspace. The workspace never supplies an agent identifier.
    pub async fn bind_workspace_connection(&self, connection: &ConnectionContext) -> Result<(), RpcError> {
        let principal = self.workspace.lock().await.focused_principal.clone().ok_or_else(forbidden)?;
        connection.bind(principal).await
    }

    pub async fn dispatch_connected(&self, connection: &ConnectionContext, request: JsonRpcRequest) -> JsonRpcResponse {
        if request.jsonrpc != "2.0" {
            return JsonRpcResponse::failure(request.id, RpcError::invalid_params("jsonrpc must be 2.0"));
        }
        let result = if request.method == "agent.register" {
            match parse::<RegisterAgentParams>(request.params.clone()) {
                Ok(params) => {
                    let principal = Principal {
                        authenticated: connection.authenticated().clone(),
                        agent_id: params.agent_id.clone(),
                        client_id: params.client_id.clone(),
                    };
                    match self.bind_connection_identity(connection, &principal).await {
                        Ok(()) => self.dispatch_inner(&request.method, request.params, Some(&principal)).await,
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        } else if matches!(request.method.as_str(), "system.ping" | "system.capabilities") {
            self.dispatch_inner(&request.method, request.params, None).await
        } else {
            match connection.principal().await {
                Some(principal) => match bind_principal_params(request.params, &principal) {
                    Ok(params) => self.dispatch_inner(&request.method, params, Some(&principal)).await,
                    Err(error) => Err(error),
                },
                None => Err(forbidden()),
            }
        };
        match result {
            Ok(result) => JsonRpcResponse::success(request.id, result),
            Err(error) => JsonRpcResponse::failure(request.id, error),
        }
    }

    async fn bind_connection_identity(&self, connection: &ConnectionContext, principal: &Principal) -> Result<(), RpcError> {
        if connection.principal().await.as_ref().is_some_and(|bound| bound != principal) {
            return Err(forbidden());
        }
        if let Some(existing) = self.agent_bindings.get(&principal.agent_id) {
            if existing.as_str() != connection.id() { return Err(RpcError::conflict("identity already active", json!({ "kind": "agent" }))); }
        }
        if let Some(existing) = self.client_bindings.get(&principal.client_id) {
            if existing.as_str() != connection.id() { return Err(RpcError::conflict("identity already active", json!({ "kind": "client" }))); }
        }
        connection.bind(principal.clone()).await?;
        self.agent_bindings.insert(principal.agent_id.clone(), connection.id().to_owned());
        self.client_bindings.insert(principal.client_id.clone(), connection.id().to_owned());
        Ok(())
    }

    async fn dispatch_inner(&self, method: &str, params: Value, principal: Option<&Principal>) -> Result<Value, RpcError> {
        match method {
            "system.ping" => Ok(json!({ "ok": true, "protocolVersion": PROTOCOL_VERSION, "now": Utc::now() })),
            "system.capabilities" => self.system_capabilities().await,
            "agent.register" => self.agent_register(parse(params)?).await,
            "agent.heartbeat" => self.agent_heartbeat(parse(params)?).await,
            "agent.unregister" => self.agent_unregister(parse(params)?).await,
            "agent.list" => self.agent_list(required_principal(principal)?),
            "workspace.show" => self.workspace_show(required_principal(principal)?, parse(params)?).await,
            "workspace.hide" => self.workspace_hide(required_principal(principal)?).await,
            "workspace.focusAgent" => self.workspace_focus_agent(required_principal(principal)?, parse(params)?).await,
            "workspace.focusTab" => self.workspace_focus_tab(required_principal(principal)?, parse(params)?).await,
            "workspace.requestAttention" => self.workspace_request_attention(parse(params)?),
            "workspace.openScoped" => self.workspace_open_scoped(required_principal(principal)?).await,
            "workspace.getScoped" => self.workspace_get_scoped(required_principal(principal)?, parse(params)?).await,
            "workspace.selectOwnedTab" => self.workspace_select_owned_tab(required_principal(principal)?, parse(params)?).await,
            "workspace.acquireViewportLease" => self.workspace_acquire_viewport_lease(required_principal(principal)?, parse(params)?).await,
            "workspace.releaseViewportLease" => self.workspace_release_viewport_lease(required_principal(principal)?, parse(params)?),
            "workspace.getFrame" => self.workspace_get_frame(required_principal(principal)?, parse(params)?).await,
            "workspace.compareSetControl" => self.workspace_compare_set_control(required_principal(principal)?, parse(params)?).await,
            "workspace.input" => self.workspace_input(required_principal(principal)?, parse(params)?).await,
            "workspace.cancelOperation" => self.workspace_cancel_operation(required_principal(principal)?, parse(params)?),
            "profile.list" => self.profile_list(required_principal(principal)?),
            "profile.create" => self.profile_create(required_principal(principal)?, parse(params)?).await,
            "profile.update" => self.profile_update(required_principal(principal)?, parse(params)?).await,
            "profile.delete" => self.profile_delete(required_principal(principal)?, parse(params)?).await,
            "session.create" => self.session_create_v2(parse(params)?).await,
            "session.list" => self.browser_list(parse(params)?),
            "session.close" => self.browser_stop(parse(params)?).await,
            "tab.create" => self.browser_open_tab(parse(params)?).await,
            "tab.list" => self.browser_list(parse(params)?),
            "tab.close" => self.browser_close_tab(parse(params)?).await,
            "browser.start" => self.browser_start(parse(params)?).await,
            "browser.stop" => self.browser_stop(parse(params)?).await,
            "browser.list" => self.browser_list(parse(params)?),
            "browser.openTab" => self.browser_open_tab(parse(params)?).await,
            "browser.closeTab" => self.browser_close_tab(parse(params)?).await,
            "browser.focusTab" => self.browser_focus_tab(parse(params)?).await,
            "browser.navigate" => self.browser_navigate(parse(params)?).await,
            "browser.observe" => self.browser_observe(parse(params)?).await,
            "browser.act" => self.browser_act(parse(params)?).await,
            "browser.debug" => self.browser_debug(parse(params)?).await,
            "browser.streamInfo" => self.browser_stream_info(parse(params)?).await,
            // Minor protocol extension required for pair-browsing coordination. It changes
            // scheduling only and never acts as an authorization gate.
            "browser.setControl" => self.browser_set_control(parse(params)?).await,
            "control.takeover" => self.browser_set_control(with_control(params, TabControl::Human)?).await,
            "control.return" => self.browser_set_control(with_control(params, TabControl::Agent)?).await,
            "search.query" => self.search_query(parse(params)?).await,
            "read.url" => self.read_url(parse(params)?).await,
            "read.activeTab" => self.read_active_tab(parse(params)?).await,
            "artifact.get" => self.artifact_get(required_principal(principal)?, parse(params)?),
            "artifact.list" => self.artifact_list(required_principal(principal)?, parse(params)?),
            "artifact.delete" => self.artifact_delete(required_principal(principal)?, parse(params)?),
            "operation.cancel" => self.operation_cancel(required_principal(principal)?, parse(params)?),
            "operation.get" => self.operation_get(required_principal(principal)?, parse(params)?),
            "transfer.stageUpload" => self.transfer_stage_upload(required_principal(principal)?, parse(params)?),
            "transfer.commitUpload" => self.transfer_commit_upload(required_principal(principal)?, parse(params)?),
            _ => Err(RpcError { code: -32601, message: format!("method not found: {method}"), data: None }),
        }
    }

    async fn system_capabilities(&self) -> Result<Value, RpcError> {
        self.agent_browser.capabilities().await.map_err(backend_rpc_error)?;
        let mut paths = vec![json!({
            "pathId": BrowserPathId::AgentBrowserChrome,
            "actions": ["navigate", "mouse-move", "mouse-down", "mouse-up", "click", "double-click", "wheel", "drag", "key-press", "key-down", "key-up", "text-input", "fill", "select", "upload", "download", "back", "forward", "reload", "wait"],
            "observations": ["main", "interactive", "visual", "full", "diff"],
            "touch": false, "uploads": true, "downloads": true, "visual": true
        })];
        if self.pinchtab.capabilities().await.is_ok() {
            paths.push(json!({
                "pathId": BrowserPathId::PinchtabChrome,
                "actions": ["navigate", "click", "fill"],
                "observations": ["main", "interactive"],
                "touch": false, "uploads": false, "downloads": false, "visual": false
            }));
        }
        Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "supportedPathIds": SUPPORTED_PATH_IDS,
            "paths": paths,
            "transports": ["unix-ndjson", "loopback-http", "loopback-websocket"],
            "coordination": { "explicitAddressing": true, "humanTakeover": true, "perHostQueues": true },
        }))
    }

    async fn agent_register(&self, params: RegisterAgentParams) -> Result<Value, RpcError> {
        if self.agents.contains_key(&params.agent_id) || self.clients.contains_key(&params.client_id) {
            return Err(RpcError::conflict("identity already active", json!({ "kind": "principal" })));
        }
        if self.sessions.iter().any(|session| session.owner_agent_id == params.agent_id) {
            return Err(RpcError::conflict("recovered identity requires a resume capability", json!({ "kind": "recovered-principal" })));
        }
        let timestamp = Utc::now();
        let registration = AgentRegistration {
            agent_id: params.agent_id.clone(),
            client_id: params.client_id.clone(),
            pi_session_id: params.pi_session_id,
            pi_session_file: params.pi_session_file,
            pi_session_name: params.pi_session_name,
            cwd: params.cwd,
            pid: params.pid,
            mode: params.mode,
            started_at: params.started_at.unwrap_or(timestamp),
            last_heartbeat_at: timestamp,
        };
        self.agents.insert(registration.agent_id.clone(), registration.clone());
        self.clients.insert(registration.client_id.clone(), ClientState { registration: registration.clone() });
        self.disconnected_clients.remove(&registration.client_id);
        self.emit("agent.registered", &registration);
        self.save_snapshot().await;
        value(&registration)
    }

    async fn agent_heartbeat(&self, params: AgentAddress) -> Result<Value, RpcError> {
        let mut client = self.clients.get_mut(&params.client_id).ok_or_else(|| RpcError::not_found("client", params.client_id.as_ref()))?;
        if client.registration.agent_id != params.agent_id {
            return Err(RpcError::conflict("client does not belong to agent", json!({ "agentId": params.agent_id, "clientId": params.client_id })));
        }
        let timestamp = Utc::now();
        client.registration.last_heartbeat_at = timestamp;
        self.disconnected_clients.remove(&params.client_id);
        if let Some(mut agent) = self.agents.get_mut(&params.agent_id) { agent.last_heartbeat_at = timestamp; }
        self.emit("agent.updated", json!({ "agentId": params.agent_id, "clientId": params.client_id, "lastHeartbeatAt": timestamp }));
        Ok(json!({ "ok": true, "lastHeartbeatAt": timestamp }))
    }

    async fn agent_unregister(&self, params: AgentAddress) -> Result<Value, RpcError> {
        let client = self.clients.get(&params.client_id).ok_or_else(|| RpcError::not_found("client", params.client_id.as_ref()))?;
        if client.registration.agent_id != params.agent_id {
            return Err(RpcError::conflict("client does not belong to agent", json!({ "agentId": params.agent_id, "clientId": params.client_id })));
        }
        drop(client);
        self.clients.remove(&params.client_id);
        self.disconnected_clients.remove(&params.client_id);
        let removed = self.prune_agent_record_if_idle(&params.agent_id);
        self.emit("agent.disconnected", json!({
            "agentId": params.agent_id,
            "clientId": params.client_id,
            "removed": removed,
        }));
        if removed { self.save_snapshot().await; }
        Ok(json!({ "ok": true, "browserStatePreserved": !removed, "agentRemoved": removed }))
    }

    fn prune_agent_record_if_idle(&self, agent_id: &AgentId) -> bool {
        if self.sessions.iter().any(|session| session.owner_agent_id == *agent_id) {
            return false;
        }
        if self.clients.iter().any(|client| {
            client.registration.agent_id == *agent_id && !self.disconnected_clients.contains(client.key())
        }) {
            return false;
        }
        let client_ids: Vec<ClientId> = self.clients.iter()
            .filter(|client| client.registration.agent_id == *agent_id)
            .map(|client| client.key().clone())
            .collect();
        for client_id in client_ids {
            self.clients.remove(&client_id);
            self.disconnected_clients.remove(&client_id);
        }
        self.agents.remove(agent_id).is_some()
    }

    fn agent_list(&self, principal: &Principal) -> Result<Value, RpcError> {
        let connected = self.clients.iter().any(|client| {
            client.registration.agent_id == principal.agent_id && !self.disconnected_clients.contains(client.key())
        });
        Ok(json!([{
            "agentId": principal.agent_id,
            "connected": connected,
        }]))
    }

    async fn workspace_open_scoped(&self, principal: &Principal) -> Result<Value, RpcError> {
        let scope_id = {
            let mut workspace = self.workspace.lock().await;
            if workspace.focused_agent_id.as_ref() != Some(&principal.agent_id) { return Err(forbidden()); }
            workspace.scope_id.get_or_insert_with(|| Uuid::new_v4().to_string()).clone()
        };
        self.workspace_snapshot(principal, &scope_id).await
    }

    async fn workspace_get_scoped(&self, principal: &Principal, params: WorkspaceScopeParams) -> Result<Value, RpcError> {
        self.ensure_workspace_scope(principal, &params.scope_id).await?;
        self.workspace_snapshot(principal, &params.scope_id).await
    }

    async fn workspace_select_owned_tab(&self, principal: &Principal, params: WorkspaceTabParams) -> Result<Value, RpcError> {
        self.ensure_workspace_scope(principal, &params.scope_id).await?;
        let tab = self.tabs.get(&params.tab_id).map(|entry| entry.value().clone())
            .filter(|tab| tab.owner_agent_id == principal.agent_id)
            .ok_or_else(|| RpcError::not_found("tab", params.tab_id.as_ref()))?;
        {
            let mut workspace = self.workspace.lock().await;
            workspace.focused_tab_id = Some(tab.tab_id);
            workspace.viewport_generation = workspace.viewport_generation.saturating_add(1).max(1);
        }
        self.workspace_leases.retain(|_, lease| lease.owner_agent_id != principal.agent_id);
        self.workspace_snapshot(principal, &params.scope_id).await
    }

    async fn workspace_acquire_viewport_lease(&self, principal: &Principal, params: WorkspaceTabParams) -> Result<Value, RpcError> {
        self.ensure_workspace_scope(principal, &params.scope_id).await?;
        let tab = self.tabs.get(&params.tab_id).map(|entry| entry.value().clone())
            .filter(|tab| tab.owner_agent_id == principal.agent_id)
            .ok_or_else(|| RpcError::not_found("tab", params.tab_id.as_ref()))?;
        let host = self.hosts.get(&tab.host_id).ok_or_else(|| RpcError::not_found("host", tab.host_id.as_ref()))?;
        let path = path_id(host.handle.host.backend);
        drop(host);
        let viewport_generation = self.workspace.lock().await.viewport_generation.max(1);
        let lease = WorkspaceViewportLease {
            lease_id: Uuid::new_v4().to_string(), scope_id: params.scope_id,
            owner_agent_id: principal.agent_id.clone(), browser_session_id: tab.browser_session_id.clone(),
            tab_id: tab.tab_id.clone(), viewport_id: format!("viewport-{}", tab.tab_id), viewport_generation,
            expires_at: Utc::now() + Duration::seconds(30), last_input_sequence: 0, current_binding: None,
        };
        let control_epoch = self.controls.get(&tab.tab_id).map(|gate| gate.epoch()).unwrap_or(1);
        let response = json!({
            "leaseId": lease.lease_id, "expiresAt": lease.expires_at,
            "transport": if path == BrowserPathId::AgentBrowserChrome.as_str() { "polled-frames" } else { "unsupported" },
            "identity": self.workspace_identity(&tab, viewport_generation, control_epoch)?,
            "geometry": { "imageWidth": 1, "imageHeight": 1, "viewportWidth": 1, "viewportHeight": 1, "deviceScaleFactor": 1.0 },
            "inputSupported": path == BrowserPathId::AgentBrowserChrome.as_str(),
        });
        self.workspace_leases.insert(lease.lease_id.clone(), lease);
        Ok(response)
    }

    fn workspace_release_viewport_lease(&self, principal: &Principal, params: WorkspaceLeaseParams) -> Result<Value, RpcError> {
        let owned = self.workspace_leases.get(&params.lease_id).is_some_and(|lease| {
            lease.owner_agent_id == principal.agent_id && lease.scope_id == params.scope_id
        });
        if !owned { return Err(RpcError::not_found("viewport lease", &params.lease_id)); }
        self.workspace_leases.remove(&params.lease_id);
        Ok(json!({ "released": true }))
    }

    async fn workspace_get_frame(&self, principal: &Principal, params: WorkspaceLeaseParams) -> Result<Value, RpcError> {
        self.ensure_workspace_scope(principal, &params.scope_id).await?;
        let lease = self.workspace_lease(principal, &params.scope_id, &params.lease_id)?;
        let tab = self.tabs.get(&lease.tab_id).map(|entry| entry.value().clone())
            .filter(|tab| tab.owner_agent_id == principal.agent_id)
            .ok_or_else(|| RpcError::not_found("tab", lease.tab_id.as_ref()))?;
        let host = self.hosts.get(&tab.host_id).ok_or_else(|| RpcError::not_found("host", tab.host_id.as_ref()))?;
        if path_id(host.handle.host.backend) != BrowserPathId::AgentBrowserChrome.as_str() {
            return Err(RpcError { code: -32040, message: "unsupported capability".into(), data: Some(json!({ "code": "unsupported" })) });
        }
        drop(host);
        let address = BrowserAddress { agent_id: principal.agent_id.clone(), browser_session_id: tab.browser_session_id, tab_id: tab.tab_id };
        let binding = self.agent_browser.capture_visual_binding(&address).await.map_err(backend_rpc_error)?;
        let bytes = tokio::fs::read(&binding.screenshot_path).await.map_err(internal_rpc_error)?;
        let control_epoch = self.controls.get(&lease.tab_id).map(|gate| gate.epoch()).unwrap_or(1);
        if let Some(mut current) = self.workspace_leases.get_mut(&params.lease_id) {
            if current.viewport_generation != lease.viewport_generation || current.expires_at <= Utc::now() { return Err(workspace_lease_error()); }
            current.expires_at = Utc::now() + Duration::seconds(30);
            current.current_binding = Some(binding.clone());
        }
        Ok(json!({
            "viewportId": lease.viewport_id, "viewportGeneration": lease.viewport_generation,
            "sequence": binding.sequence, "capturedAt": binding.captured_at, "mediaType": "image/png",
            "width": binding.geometry.image_width, "height": binding.geometry.image_height,
            "coordinateSpace": "css-viewport", "payload": base64::engine::general_purpose::STANDARD.encode(bytes),
            "screenshotSha256": binding.screenshot_sha256, "controlEpoch": control_epoch,
            "geometry": {
                "imageWidth": binding.geometry.image_width, "imageHeight": binding.geometry.image_height,
                "viewportWidth": binding.geometry.viewport_width, "viewportHeight": binding.geometry.viewport_height,
                "deviceScaleFactor": binding.geometry.device_scale_factor
            }
        }))
    }

    async fn workspace_compare_set_control(&self, principal: &Principal, params: WorkspaceControlParams) -> Result<Value, RpcError> {
        self.ensure_workspace_scope(principal, &params.scope_id).await?;
        let lease = self.workspace_lease(principal, &params.scope_id, &params.lease_id)?;
        if lease.viewport_id != params.viewport_id || lease.viewport_generation != params.viewport_generation { return Err(workspace_lease_error()); }
        let gate = self.controls.get(&lease.tab_id).map(|entry| Arc::clone(entry.value())).ok_or_else(|| RpcError::not_found("control", lease.tab_id.as_ref()))?;
        if gate.epoch() != params.expected_control_epoch { return Err(RpcError::conflict("control epoch changed", json!({ "code": "control_conflict" }))); }
        let control_epoch = gate.set(params.control);
        if let Some(mut tab) = self.tabs.get_mut(&lease.tab_id) { tab.control = params.control; }
        self.emit("browser.controlChanged", json!({ "agentId": principal.agent_id, "browserSessionId": lease.browser_session_id, "tabId": lease.tab_id, "control": params.control, "controlEpoch": control_epoch }));
        Ok(json!({ "controlEpoch": control_epoch }))
    }

    async fn workspace_input(&self, principal: &Principal, params: WorkspaceInputParams) -> Result<Value, RpcError> {
        self.ensure_workspace_scope(principal, &params.scope_id).await?;
        let lease = self.workspace_lease(principal, &params.scope_id, &params.lease_id)?;
        if lease.viewport_id != params.viewport_id || lease.viewport_generation != params.viewport_generation { return Err(workspace_lease_error()); }
        let gate = self.controls.get(&lease.tab_id).map(|entry| Arc::clone(entry.value())).ok_or_else(|| RpcError::not_found("control", lease.tab_id.as_ref()))?;
        if gate.current() != TabControl::Human || gate.epoch() != params.control_epoch { return Err(RpcError::conflict("control epoch changed", json!({ "code": "control_conflict" }))); }
        let valid_binding = |lease: &WorkspaceViewportLease| lease.current_binding.clone().filter(|binding| {
            binding.sequence == params.screenshot_sequence
                && binding.screenshot_sha256 == params.screenshot_sha256
                && Utc::now() - binding.captured_at <= Duration::seconds(5)
        }).ok_or_else(|| RpcError { code: -32011, message: "stale visual evidence".into(), data: Some(json!({ "code": "geometry_changed" })) });
        valid_binding(&lease)?;
        if params.input_sequence <= lease.last_input_sequence { return Err(RpcError::conflict("input sequence is stale", json!({ "code": "control_conflict" }))); }

        let resolved = self.resolve_address(&principal.agent_id, &lease.browser_session_id, &lease.tab_id)?;
        let operation = self.operations.begin(params.operation_id, principal.agent_id.clone(), "workspace-input")?;
        let operation_id = operation.id();
        let mut cancellation = operation.cancellation();
        let _queue = tokio::select! {
            queue = resolved.host.queue.lock() => queue,
            _ = cancelled(&mut cancellation) => {
                operation.cancelled();
                self.emit_operation(&operation);
                return Err(cancelled_error(&operation_id));
            }
        };

        let current = match self.workspace_lease(principal, &params.scope_id, &params.lease_id) {
            Ok(current) => current,
            Err(error) => { operation.fail("workspace lease changed before input dispatch"); self.emit_operation(&operation); return Err(error); }
        };
        if current.viewport_id != params.viewport_id || current.viewport_generation != params.viewport_generation {
            operation.fail("workspace viewport changed before input dispatch"); self.emit_operation(&operation); return Err(workspace_lease_error());
        }
        if gate.current() != TabControl::Human || gate.epoch() != params.control_epoch {
            operation.fail("workspace control changed before input dispatch"); self.emit_operation(&operation);
            return Err(RpcError::conflict("control epoch changed", json!({ "code": "control_conflict" })));
        }
        let binding = match valid_binding(&current) {
            Ok(binding) => binding,
            Err(error) => { operation.fail("visual binding changed before input dispatch"); self.emit_operation(&operation); return Err(error); }
        };
        let refreshed = match self.agent_browser.capture_visual_binding(&resolved.address).await {
            Ok(refreshed) => refreshed,
            Err(error) => { operation.fail("current visual frame capture failed"); self.emit_operation(&operation); return Err(backend_rpc_error(error)); }
        };
        if operation.is_cancelled() {
            operation.cancelled(); self.emit_operation(&operation);
            return Err(cancelled_error(&operation_id));
        }
        if refreshed.screenshot_sha256 != binding.screenshot_sha256 || refreshed.geometry != binding.geometry {
            operation.fail("visual frame changed before input dispatch"); self.emit_operation(&operation);
            return Err(RpcError { code: -32011, message: "stale visual evidence".into(), data: Some(json!({ "code": "geometry_changed" })) });
        }
        if params.input_sequence <= current.last_input_sequence {
            operation.fail("input sequence changed before input dispatch"); self.emit_operation(&operation);
            return Err(RpcError::conflict("input sequence is stale", json!({ "code": "control_conflict" })));
        }
        if let Some(mut active) = self.workspace_leases.get_mut(&params.lease_id) {
            if active.last_input_sequence != current.last_input_sequence {
                operation.fail("input sequence changed before input commit"); self.emit_operation(&operation);
                return Err(RpcError::conflict("input sequence changed", json!({ "code": "control_conflict" })));
            }
            active.last_input_sequence = params.input_sequence;
            active.current_binding = None;
        } else {
            operation.fail("workspace lease expired before input commit"); self.emit_operation(&operation);
            return Err(workspace_lease_error());
        }

        operation.start();
        self.emit_operation(&operation);
        let cua_cancellation = CuaCancellation::default();
        let backend = self.agent_browser.cua_action(&resolved.address, &refreshed, params.action, &cua_cancellation);
        let result = tokio::select! {
            result = backend => result.map_err(backend_rpc_error),
            _ = cancelled(&mut cancellation) => Err(cancelled_error(&operation_id)),
        };
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if error.code == -32010 { operation.cancelled(); } else { operation.fail("workspace input failed"); }
                self.emit_operation(&operation);
                return Err(error);
            }
        };
        operation.commit();
        if let Some(mut tab) = self.tabs.get_mut(&lease.tab_id) {
            if !result.title.is_empty() { tab.title = result.title; }
            if !result.url.is_empty() { tab.url = result.url; }
            tab.last_action_at = Some(Utc::now());
        }
        operation.succeed();
        self.emit_operation(&operation);
        Ok(json!({ "accepted": true, "bindingSequence": result.binding_sequence, "operationId": operation_id }))
    }

    fn workspace_cancel_operation(&self, principal: &Principal, params: OperationAddressParams) -> Result<Value, RpcError> {
        self.operations.cancel(&principal.agent_id, &params.operation_id)
    }

    async fn workspace_snapshot(&self, principal: &Principal, scope_id: &str) -> Result<Value, RpcError> {
        let sessions: Vec<_> = self.sessions.iter().filter(|session| session.owner_agent_id == principal.agent_id).map(|session| session.value().clone()).collect();
        let session_ids: std::collections::HashSet<_> = sessions.iter().map(|session| session.browser_session_id.clone()).collect();
        let tabs: Vec<_> = self.tabs.iter().filter(|tab| session_ids.contains(&tab.browser_session_id)).map(|tab| tab.value().clone()).collect();
        let mut workspace = self.workspace.lock().await;
        if workspace.focused_tab_id.as_ref().is_none_or(|id| !tabs.iter().any(|tab| &tab.tab_id == id)) {
            workspace.focused_tab_id = tabs.first().map(|tab| tab.tab_id.clone());
            workspace.viewport_generation = workspace.viewport_generation.saturating_add(1).max(1);
        }
        let selected = workspace.focused_tab_id.as_ref().and_then(|id| tabs.iter().find(|tab| &tab.tab_id == id));
        let viewport_generation = workspace.viewport_generation.max(1);
        drop(workspace);
        let session_values: Result<Vec<_>, RpcError> = sessions.iter().map(|session| {
            let host = self.hosts.get(&session.host_id).ok_or_else(|| RpcError::not_found("host", session.host_id.as_ref()))?;
            Ok(json!({ "browserSessionId": session.browser_session_id, "label": safe_workspace_text(&session.label, 80), "pathId": path_id(host.handle.host.backend), "backend": workspace_backend(host.handle.host.backend), "engine": "chrome" }))
        }).collect();
        let tab_values: Vec<_> = tabs.iter().map(|tab| json!({ "tabId": tab.tab_id, "browserSessionId": tab.browser_session_id, "title": safe_workspace_text(&tab.title, 80), "url": safe_workspace_url(&tab.url), "state": tab.state })).collect();
        let selected_value = selected.map(|tab| {
            let epoch = self.controls.get(&tab.tab_id).map(|gate| gate.epoch()).unwrap_or(1);
            self.workspace_identity(tab, viewport_generation, epoch)
        }).transpose()?;
        let control_state = selected.map(|tab| if tab.control == TabControl::Human { "human" } else { "agent" }).unwrap_or("agent");
        let viewport_state = selected.map(|tab| self.hosts.get(&tab.host_id).map(|host| if path_id(host.handle.host.backend) == BrowserPathId::PinchtabChrome.as_str() { "unsupported" } else { "connecting" }).unwrap_or("failed")).unwrap_or("unselected");
        let failure = if viewport_state == "unsupported" {
            Some(json!({ "code": "unsupported", "message": "Live view is not supported by this path.", "recovery": "none" }))
        } else if viewport_state == "failed" {
            Some(json!({ "code": "browser_crashed", "message": "The browser tab is unavailable.", "recovery": "retry" }))
        } else { None };
        let operation = self.operations.latest_for_owner(&principal.agent_id).map(|record| json!({
            "operationId": record.operation_id, "label": safe_operation_label(&record.kind),
            "state": workspace_operation_state(record.state), "cancellable": !record.state.terminal() && !matches!(record.state, crate::operation::OperationState::Committed)
        }));
        Ok(json!({
            "scopeId": scope_id, "agentLabel": "Invoking agent", "sessions": session_values?, "tabs": tab_values,
            "selected": selected_value, "viewportState": viewport_state, "controlState": control_state,
            "operation": operation, "failure": failure,
            "events": self.workspace_events.get(&principal.agent_id).map(|events| events.clone()).unwrap_or_default()
        }))
    }

    fn workspace_identity(&self, tab: &TabInfo, viewport_generation: u64, control_epoch: u64) -> Result<Value, RpcError> {
        let session = self.owned_session(&tab.owner_agent_id, &tab.browser_session_id)?;
        let host = self.hosts.get(&session.host_id).ok_or_else(|| RpcError::not_found("host", session.host_id.as_ref()))?;
        Ok(json!({
            "agentLabel": "Invoking agent", "browserSessionId": session.browser_session_id,
            "sessionLabel": safe_workspace_text(&session.label, 80), "tabId": tab.tab_id,
            "viewportId": format!("viewport-{}", tab.tab_id), "pathId": path_id(host.handle.host.backend),
            "backend": workspace_backend(host.handle.host.backend), "engine": "chrome", "coordinateSpace": "css-viewport",
            "viewportGeneration": viewport_generation, "hostGeneration": 1, "engineGeneration": 1, "controlEpoch": control_epoch
        }))
    }

    async fn ensure_workspace_scope(&self, principal: &Principal, scope_id: &str) -> Result<(), RpcError> {
        let workspace = self.workspace.lock().await;
        if workspace.focused_agent_id.as_ref() != Some(&principal.agent_id) || workspace.scope_id.as_deref() != Some(scope_id) { return Err(forbidden()); }
        Ok(())
    }

    fn workspace_lease(&self, principal: &Principal, scope_id: &str, lease_id: &str) -> Result<WorkspaceViewportLease, RpcError> {
        self.workspace_leases.get(lease_id).map(|entry| entry.value().clone())
            .filter(|lease| lease.owner_agent_id == principal.agent_id && lease.scope_id == scope_id && lease.expires_at > Utc::now())
            .ok_or_else(workspace_lease_error)
    }

    async fn workspace_show(&self, principal: &Principal, params: WorkspaceFocusParams) -> Result<Value, RpcError> {
        self.ensure_agent(&params.agent_id)?;
        self.launch_workspace();
        {
            let mut workspace = self.workspace.lock().await;
            workspace.visible = true;
            workspace.focused_principal = Some(principal.clone());
            workspace.focused_agent_id = Some(params.agent_id.clone());
            workspace.scope_id = Some(Uuid::new_v4().to_string());
            workspace.viewport_generation = workspace.viewport_generation.saturating_add(1).max(1);
            if let Some(tab_id) = &params.tab_id { workspace.focused_tab_id = Some(tab_id.clone()); }
        }
        self.workspace_leases.clear();
        let payload = json!({ "agentId": params.agent_id, "browserSessionId": params.browser_session_id, "tabId": params.tab_id, "visible": true });
        self.emit("workspace.focusRequested", payload.clone());
        Ok(payload)
    }

    async fn workspace_hide(&self, principal: &Principal) -> Result<Value, RpcError> {
        let mut workspace = self.workspace.lock().await;
        if workspace.focused_agent_id.as_ref().is_some_and(|owner| owner != &principal.agent_id)
            || workspace.focused_principal.as_ref().is_some_and(|owner| owner != principal)
        {
            return Err(forbidden());
        }
        if workspace.focused_tab_id.as_ref().is_some_and(|tab_id| {
            self.controls.get(tab_id).is_some_and(|gate| gate.current() == TabControl::Human)
                || self.tabs.get(tab_id).is_some_and(|tab| tab.control == TabControl::Human)
        }) {
            return Err(protected_error("human_control"));
        }
        let previous_agent_id = workspace.focused_agent_id.take();
        let previous_tab_id = workspace.focused_tab_id.take();
        let previous_scope_id = workspace.scope_id.take();
        workspace.visible = false;
        workspace.focused_principal = None;
        workspace.viewport_generation = workspace.viewport_generation.saturating_add(1).max(1);
        let payload = json!({
            "agentId": previous_agent_id,
            "tabId": previous_tab_id,
            "visible": false
        });
        drop(workspace);
        self.workspace_leases.retain(|_, lease| {
            lease.owner_agent_id != principal.agent_id
                && previous_scope_id.as_ref().is_none_or(|scope_id| &lease.scope_id != scope_id)
        });
        self.emit("workspace.focusRequested", payload.clone());
        Ok(payload)
    }

    async fn workspace_focus_agent(&self, principal: &Principal, params: AgentOnly) -> Result<Value, RpcError> {
        self.workspace_show(principal, WorkspaceFocusParams { agent_id: params.agent_id, browser_session_id: None, tab_id: None }).await
    }

    async fn workspace_focus_tab(&self, principal: &Principal, params: WorkspaceFocusParams) -> Result<Value, RpcError> {
        let session_id = params.browser_session_id.clone().ok_or_else(|| RpcError::invalid_params("browserSessionId is required"))?;
        let tab_id = params.tab_id.clone().ok_or_else(|| RpcError::invalid_params("tabId is required"))?;
        self.resolve_address(&params.agent_id, &session_id, &tab_id)?;
        self.workspace_show(principal, params).await
    }

    fn workspace_request_attention(&self, params: WorkspaceFocusParams) -> Result<Value, RpcError> {
        self.ensure_agent(&params.agent_id)?;
        self.emit("browser.attentionRequested", &params);
        Ok(json!({ "requested": true }))
    }

    fn profile_list(&self, principal: &Principal) -> Result<Value, RpcError> {
        let profiles: Vec<Value> = self.profiles.iter()
            .filter(|entry| self.profile_owners.get(entry.key()).is_some_and(|owner| *owner == principal.agent_id))
            .map(|entry| json!({
                "profileId": entry.profile_id,
                "name": entry.name,
                "class": "private",
            }))
            .collect();
        Ok(Value::Array(profiles))
    }

    async fn profile_create(&self, principal: &Principal, params: ProfileCreateParams) -> Result<Value, RpcError> {
        if params.name.trim().is_empty() { return Err(RpcError::invalid_params("profile name is empty")); }
        if self.profiles.iter().any(|profile| {
            profile.name == params.name
                && self.profile_owners.get(profile.key()).is_some_and(|owner| *owner == principal.agent_id)
        }) {
            return Err(RpcError::conflict("profile name already exists", json!({ "name": params.name })));
        }
        let profile = BrowserProfile {
            profile_id: ProfileId::new(),
            name: params.name.clone(),
            engine: ChromiumOnly::Chromium,
            data_dir: params.data_dir.unwrap_or_else(|| self.paths.data.join("profiles").join(safe_name(&params.name)).to_string_lossy().into_owned()),
            extensions: params.extensions,
            launch_args: params.launch_args,
            visible_by_default: params.visible_by_default,
        };
        self.profiles.insert(profile.profile_id.clone(), profile.clone());
        self.profile_owners.insert(profile.profile_id.clone(), principal.agent_id.clone());
        self.save_snapshot().await;
        Ok(json!({ "profileId": profile.profile_id, "name": profile.name, "class": "private" }))
    }

    async fn profile_update(&self, principal: &Principal, params: ProfileUpdateParams) -> Result<Value, RpcError> {
        self.ensure_profile_owner(principal, &params.profile_id)?;
        if self.profile_hosts.contains_key(&params.profile_id)
            && (params.data_dir.is_some() || params.extensions.is_some() || params.launch_args.is_some())
        {
            return Err(RpcError::conflict("cannot change launch settings while profile host is running", json!({ "profileId": params.profile_id })));
        }
        let mut profile = self.profiles.get_mut(&params.profile_id).ok_or_else(|| RpcError::not_found("profile", params.profile_id.as_ref()))?;
        if let Some(name) = params.name { profile.name = name; }
        if let Some(data_dir) = params.data_dir { profile.data_dir = data_dir; }
        if let Some(extensions) = params.extensions { profile.extensions = extensions; }
        if let Some(launch_args) = params.launch_args { profile.launch_args = launch_args; }
        if let Some(visible) = params.visible_by_default { profile.visible_by_default = visible; }
        let result = profile.clone();
        drop(profile);
        self.save_snapshot().await;
        Ok(json!({ "profileId": result.profile_id, "name": result.name, "class": "private" }))
    }

    async fn profile_delete(&self, principal: &Principal, params: ProfileDeleteParams) -> Result<Value, RpcError> {
        self.ensure_profile_owner(principal, &params.profile_id)?;
        if self.profile_hosts.contains_key(&params.profile_id) {
            return Err(RpcError::conflict("profile host is running", json!({ "profileId": params.profile_id })));
        }
        let deleted = self.profiles.remove(&params.profile_id).is_some();
        self.profile_owners.remove(&params.profile_id);
        self.save_snapshot().await;
        Ok(json!({ "deleted": deleted }))
    }

    async fn session_create_v2(&self, params: SessionCreateV2Params) -> Result<Value, RpcError> {
        let backend = match params.path_id {
            BrowserPathId::AgentBrowserChrome => BackendSelection::AgentBrowser,
            BrowserPathId::PinchtabChrome => BackendSelection::Pinchtab,
        };
        self.browser_start(BrowserStartParams {
            agent_id: params.agent_id,
            engine: EngineSelection::Chromium,
            backend,
            profile_id: params.profile_id,
            profile: None,
            visible: params.visible,
            url: params.url,
            label: params.label,
        }).await
    }

    async fn browser_start(&self, params: BrowserStartParams) -> Result<Value, RpcError> {
        self.ensure_agent(&params.agent_id)?;
        let profile = self.resolve_profile(&params.agent_id, params.profile_id.as_ref(), params.profile.as_deref())?;
        if matches!(params.engine, EngineSelection::Lightpanda) {
            return Err(RpcError { code: -32040, message: "unsupported browser path".into(), data: Some(json!({ "requested": "lightpanda", "supportedPathIds": SUPPORTED_PATH_IDS })) });
        }
        let engine = BrowserEngine::Chromium;
        if profile.is_some() && engine != BrowserEngine::Chromium {
            return Err(RpcError::invalid_params("persistent profiles require Chromium"));
        }
        let backend = match params.backend {
            BackendSelection::AgentBrowser => BrowserBackend::AgentBrowser,
            BackendSelection::Pinchtab => BrowserBackend::Pinchtab,
        };
        if backend == BrowserBackend::Pinchtab && (profile.is_some() || params.visible.unwrap_or(false)) {
            return Err(RpcError { code: -32040, message: "unsupported capability on pinchtab/chrome".into(), data: Some(json!({ "pathId": BrowserPathId::PinchtabChrome, "capability": "profile-or-visual" })) });
        }
        if let Some(profile) = profile {
            let lock = self.profile_locks.entry(profile.profile_id.clone()).or_insert_with(|| Arc::new(Mutex::new(()))).clone();
            let _guard = lock.lock().await;
            self.browser_start_inner(params, engine, backend, Some(profile)).await
        } else {
            self.browser_start_inner(params, engine, backend, None).await
        }
    }

    async fn browser_start_inner(
        &self,
        params: BrowserStartParams,
        engine: BrowserEngine,
        backend: BrowserBackend,
        profile: Option<BrowserProfile>,
    ) -> Result<Value, RpcError> {
        let controller = self.controller(backend);
        let existing_host = if let Some(profile) = profile.as_ref() {
            let host_id = self.profile_hosts.get(&profile.profile_id).map(|entry| entry.value().clone());
            host_id.and_then(|host_id| self.hosts.get(&host_id).map(|entry| Arc::clone(entry.value())))
        } else {
            None
        };
        let (host, new_host) = if let Some(host) = existing_host {
            if host.handle.host.backend != backend || host.handle.host.engine != engine {
                return Err(RpcError::conflict(
                    "persistent profile already has a host with a different backend or engine",
                    json!({
                        "profileId": profile.as_ref().map(|value| &value.profile_id),
                        "requestedBackend": backend,
                        "requestedEngine": engine,
                        "activeBackend": host.handle.host.backend,
                        "activeEngine": host.handle.host.engine,
                    }),
                ));
            }
            (host, false)
        } else {
            self.enforce_host_limit(engine)?;
            let visible = params.visible.or_else(|| profile.as_ref().map(|value| value.visible_by_default)).unwrap_or(false);
            let launch = StartHostRequest {
                engine,
                backend,
                profile: profile.clone(),
                visible,
                launch_args: profile.as_ref().map(|value| value.launch_args.clone()).unwrap_or_default(),
            };
            let handle = controller.start_host(launch.clone()).await.map_err(backend_rpc_error)?;
            let entry = Arc::new(HostEntry {
                persistent: profile.is_some(),
                handle: handle.clone(),
                controller,
                queue: Mutex::new(()),
                launch,
            });
            self.hosts.insert(handle.host.host_id.clone(), Arc::clone(&entry));
            if let Some(profile) = &profile { self.profile_hosts.insert(profile.profile_id.clone(), handle.host.host_id.clone()); }
            self.emit("browser.hostUpdated", &handle.host);
            (entry, true)
        };

        let session = BrowserSession {
            browser_session_id: BrowserSessionId::new(),
            owner_agent_id: params.agent_id.clone(),
            host_id: host.handle.host.host_id.clone(),
            label: params.label.unwrap_or_else(|| profile.as_ref().map(|value| value.name.clone()).unwrap_or_else(|| format!("{} session", engine_name(engine)))),
            created_at: Utc::now(),
            last_activity_at: Utc::now(),
        };
        let queue = host.queue.lock().await;
        let mut opened_with_requested_url = false;
        let backend_tab_result = if new_host {
            match host.controller.list_tabs(&host.handle).await {
                Ok(tabs) => if let Some(tab) = tabs.into_iter().next() {
                    Ok(tab)
                } else {
                    opened_with_requested_url = params.url.is_some();
                    host.controller.open_tab(&host.handle, params.url.as_deref()).await
                },
                Err(error) => Err(error),
            }
        } else {
            host.controller.open_tab(&host.handle, params.url.as_deref()).await
        };
        let backend_tab = match backend_tab_result {
            Ok(tab) => tab,
            Err(error) => {
                drop(queue);
                let cleanup_required = self.rollback_failed_start(&host, new_host, profile.as_ref()).await;
                return Err(lifecycle_error(error, cleanup_required));
            }
        };
        let mut tab = backend_tab;
        tab.owner_agent_id = params.agent_id.clone();
        tab.browser_session_id = session.browser_session_id.clone();
        tab.control = TabControl::Agent;
        tab.state = TabState::Idle;
        let address = BrowserAddress { agent_id: params.agent_id, browser_session_id: session.browser_session_id.clone(), tab_id: tab.tab_id.clone() };
        if new_host && !opened_with_requested_url {
            if let Some(url) = params.url.as_deref() {
                let result = match host.controller.navigate(&address, url).await {
                    Ok(result) => result,
                    Err(error) => {
                        let _ = host.controller.close_tab(&host.handle, tab.tab_id.as_ref()).await;
                        drop(queue);
                        let cleanup_required = self.rollback_failed_start(&host, new_host, profile.as_ref()).await;
                        return Err(lifecycle_error(error, cleanup_required));
                    }
                };
                if let Some(url) = result.url { tab.url = url; }
                if let Some(title) = result.title { tab.title = title; }
                tab.last_action_at = Some(Utc::now());
                self.tabs.insert(tab.tab_id.clone(), tab.clone());
            }
        }
        drop(queue);
        self.sessions.insert(session.browser_session_id.clone(), session.clone());
        self.tabs.insert(tab.tab_id.clone(), tab.clone());
        self.controls.insert(tab.tab_id.clone(), Arc::new(ControlGate::new(TabControl::Agent)));
        self.emit("browser.sessionUpdated", &session);
        self.emit("browser.tabUpdated", &tab);
        self.save_snapshot().await;
        Ok(json!({ "pathId": path_id(backend), "host": host.handle.host, "browserSession": session, "tab": tab, "controlEpoch": 1 }))
    }

    async fn browser_stop(&self, params: SessionAddress) -> Result<Value, RpcError> {
        let session = self.owned_session(&params.agent_id, &params.browser_session_id)?;
        let host = self.hosts.get(&session.host_id).map(|entry| Arc::clone(entry.value())).ok_or_else(|| RpcError::not_found("host", session.host_id.as_ref()))?;
        let tabs: Vec<TabInfo> = self.tabs.iter().filter(|tab| tab.browser_session_id == session.browser_session_id).map(|tab| tab.value().clone()).collect();
        if tabs.iter().any(|tab| tab.control == TabControl::Human) {
            return Err(protected_error("human_control"));
        }
        let selected_tab = self.workspace.lock().await.focused_tab_id.clone();
        if selected_tab.as_ref().is_some_and(|selected| tabs.iter().any(|tab| tab.tab_id == *selected)) {
            return Err(protected_error("selected_viewport"));
        }
        let host_used_by_other_session = self.sessions.iter().any(|other| {
            other.host_id == session.host_id && other.browser_session_id != session.browser_session_id
        });
        let _queue = host.queue.lock().await;
        if !host_used_by_other_session && !host.persistent {
            // agent-browser refuses to close the final tab. For an ephemeral host,
            // stop the host directly and then discard its coordinator tab records.
            host.controller.stop_host(&host.handle).await.map_err(backend_rpc_error)?;
            for tab in &tabs {
                self.tabs.remove(&tab.tab_id);
                self.controls.remove(&tab.tab_id);
            }
        } else {
            if !host_used_by_other_session && host.persistent {
                // Persistent hosts survive their final owned session. Keep one unowned
                // about:blank backend tab so the owned tabs can be closed cleanly.
                host.controller.open_tab(&host.handle, Some("about:blank")).await.map_err(backend_rpc_error)?;
            }
            for tab in &tabs {
                match host.controller.close_tab(&host.handle, tab.tab_id.as_ref()).await {
                    Ok(()) | Err(BackendError::TabUnavailable(_)) => {}
                    Err(error) => return Err(lifecycle_error(error, true)),
                }
                self.tabs.remove(&tab.tab_id);
                self.controls.remove(&tab.tab_id);
            }
        }
        drop(_queue);
        self.sessions.remove(&session.browser_session_id);
        if !host_used_by_other_session && !host.persistent {
            self.hosts.remove(&session.host_id);
            self.emit("browser.hostUpdated", json!({ "hostId": session.host_id, "state": "stopped" }));
        }
        let agent_removed = self.prune_agent_record_if_idle(&params.agent_id);
        if agent_removed {
            self.emit("agent.disconnected", json!({ "agentId": params.agent_id, "removed": true }));
        }
        self.save_snapshot().await;
        Ok(json!({ "stopped": true, "hostPreserved": host.persistent, "agentRemoved": agent_removed }))
    }

    fn browser_list(&self, params: BrowserListParams) -> Result<Value, RpcError> {
        let sessions: Vec<BrowserSession> = self.sessions.iter()
            .filter(|session| params.agent_id.as_ref().is_none_or(|agent| session.owner_agent_id == *agent))
            .map(|entry| entry.value().clone()).collect();
        let session_ids: std::collections::HashSet<_> = sessions.iter().map(|session| session.browser_session_id.clone()).collect();
        let tabs: Vec<Value> = self.tabs.iter().filter(|tab| session_ids.contains(&tab.browser_session_id)).map(|entry| {
            let mut tab = serde_json::to_value(entry.value()).unwrap_or(Value::Null);
            if let Some(object) = tab.as_object_mut() {
                if let Some(host) = self.hosts.get(&entry.host_id) { object.insert("pathId".into(), json!(path_id(host.handle.host.backend))); }
                if let Some(gate) = self.controls.get(entry.key()) { object.insert("controlEpoch".into(), json!(gate.epoch())); }
            }
            tab
        }).collect();
        let host_ids: std::collections::HashSet<_> = sessions.iter().map(|session| session.host_id.clone()).collect();
        let hosts: Vec<Value> = self.hosts.iter().filter(|host| host_ids.contains(host.key())).map(|entry| {
            let mut host = serde_json::to_value(&entry.handle.host).unwrap_or(Value::Null);
            if let Some(object) = host.as_object_mut() { object.insert("pathId".into(), json!(path_id(entry.handle.host.backend))); }
            host
        }).collect();
        let sessions: Vec<Value> = sessions.into_iter().map(|session| {
            let mut value = serde_json::to_value(&session).unwrap_or(Value::Null);
            if let Some(object) = value.as_object_mut() {
                if let Some(host) = self.hosts.get(&session.host_id) { object.insert("pathId".into(), json!(path_id(host.handle.host.backend))); }
            }
            value
        }).collect();
        Ok(json!({ "hosts": hosts, "sessions": sessions, "tabs": tabs }))
    }

    async fn browser_open_tab(&self, params: OpenTabParams) -> Result<Value, RpcError> {
        let session = self.owned_session(&params.agent_id, &params.browser_session_id)?;
        let host = self.hosts.get(&session.host_id).map(|entry| Arc::clone(entry.value())).ok_or_else(|| RpcError::not_found("host", session.host_id.as_ref()))?;
        self.enforce_tab_limit(&session.host_id)?;
        let _queue = host.queue.lock().await;
        let mut tab = host.controller.open_tab(&host.handle, params.url.as_deref()).await.map_err(backend_rpc_error)?;
        tab.owner_agent_id = params.agent_id;
        tab.browser_session_id = session.browser_session_id.clone();
        self.tabs.insert(tab.tab_id.clone(), tab.clone());
        self.controls.insert(tab.tab_id.clone(), Arc::new(ControlGate::new(TabControl::Agent)));
        drop(_queue);
        self.emit("browser.tabUpdated", &tab);
        self.save_snapshot().await;
        value(tab)
    }

    async fn browser_close_tab(&self, params: TabAddressParams) -> Result<Value, RpcError> {
        let initial = self.resolve_address(&params.agent_id, &params.browser_session_id, &params.tab_id)?;
        if matches!(params.source, ActionSource::Agent) {
            initial.gate.wait_for_agent().await;
        }
        let resolved = self.resolve_address(&params.agent_id, &params.browser_session_id, &params.tab_id)?;
        let session_tab_count = self.tabs.iter()
            .filter(|tab| tab.browser_session_id == params.browser_session_id)
            .count();
        if session_tab_count <= 1 {
            let tab_id = resolved.tab.tab_id.clone();
            drop(resolved);
            let stop = self.browser_stop(SessionAddress {
                agent_id: params.agent_id,
                browser_session_id: params.browser_session_id,
            }).await?;
            return Ok(json!({ "closed": true, "tabId": tab_id, "sessionStopped": true, "stop": stop }));
        }
        let _queue = resolved.host.queue.lock().await;
        resolved.host.controller.close_tab(&resolved.host.handle, resolved.tab.tab_id.as_ref()).await.map_err(backend_rpc_error)?;
        self.tabs.remove(&resolved.tab.tab_id);
        self.controls.remove(&resolved.tab.tab_id);
        drop(_queue);
        self.emit("browser.tabUpdated", json!({ "tabId": resolved.tab.tab_id, "state": "closed" }));
        self.save_snapshot().await;
        Ok(json!({ "closed": true, "tabId": resolved.tab.tab_id }))
    }

    async fn browser_focus_tab(&self, params: TabAddressParams) -> Result<Value, RpcError> {
        let initial = self.resolve_address(&params.agent_id, &params.browser_session_id, &params.tab_id)?;
        if matches!(params.source, ActionSource::Agent) {
            initial.gate.wait_for_agent().await;
        }
        let resolved = self.resolve_address(&params.agent_id, &params.browser_session_id, &params.tab_id)?;
        let _queue = resolved.host.queue.lock().await;
        resolved.host.controller.focus_tab(&resolved.host.handle, resolved.tab.tab_id.as_ref()).await.map_err(backend_rpc_error)?;
        drop(_queue);
        let mut workspace = self.workspace.lock().await;
        workspace.focused_agent_id = Some(params.agent_id.clone());
        workspace.focused_tab_id = Some(params.tab_id.clone());
        drop(workspace);
        self.emit("workspace.focusRequested", json!({ "agentId": params.agent_id, "browserSessionId": params.browser_session_id, "tabId": params.tab_id }));
        Ok(json!({ "focused": true, "tab": resolved.tab }))
    }

    async fn browser_navigate(&self, params: NavigateParams) -> Result<Value, RpcError> {
        self.browser_act(ActParams {
            agent_id: params.agent_id,
            browser_session_id: params.browser_session_id,
            tab_id: params.tab_id,
            action: BrowserAction::Navigate { url: Url::parse(&params.url).map_err(|error| RpcError::invalid_params(format!("invalid URL: {error}")))? },
            source: ActionSource::Agent,
            operation_id: params.operation_id,
        }).await
    }

    async fn browser_act(&self, params: ActParams) -> Result<Value, RpcError> {
        let initial = self.resolve_address(&params.agent_id, &params.browser_session_id, &params.tab_id)?;
        let operation = self.operations.begin(params.operation_id, params.agent_id.clone(), action_kind(&params.action))?;
        let operation_id = operation.id();
        if matches!(params.source, ActionSource::Agent) {
            if let Err(error) = initial.gate.wait_for_agent_or_cancel(&operation).await {
                operation.cancelled();
                self.emit_operation(&operation);
                return Err(error);
            }
        }
        // Human takeover may outlive the tab. Re-resolve after the wait rather than
        // executing against stale ownership or a tab that was closed/reassigned.
        let resolved = match self.resolve_address(&params.agent_id, &params.browser_session_id, &params.tab_id) {
            Ok(resolved) => resolved,
            Err(error) => { operation.fail("address changed before execution"); self.emit_operation(&operation); return Err(error); }
        };
        if !action_supported(resolved.host.handle.host.backend, &params.action) {
            operation.fail("unsupported action");
            self.emit_operation(&operation);
            return Err(RpcError {
                code: -32040,
                message: "unsupported capability".into(),
                data: Some(json!({ "action": action_kind(&params.action), "pathId": path_id(resolved.host.handle.host.backend) })),
            });
        }
        match &params.action {
            BrowserAction::TabNew { url } => {
                operation.start();
                let outcome = self.browser_open_tab(OpenTabParams {
                    agent_id: params.agent_id,
                    browser_session_id: params.browser_session_id,
                    url: url.as_ref().map(|url| url.to_string()),
                }).await;
                let tab = match outcome {
                    Ok(tab) => tab,
                    Err(error) => { operation.fail("tab creation failed"); self.emit_operation(&operation); return Err(error); }
                };
                operation.commit(); operation.succeed(); self.emit_operation(&operation);
                let tab_id = tab.get("tabId").cloned();
                return Ok(json!({ "ok": true, "operationId": operation_id, "action": "tab-new", "changed": ["new tab opened"], "newTabId": tab_id, "tab": tab }));
            }
            BrowserAction::TabClose { tab_id } => {
                operation.start();
                let tab_id = tab_id.clone().unwrap_or(params.tab_id);
                if let Err(error) = self.browser_close_tab(TabAddressParams {
                    agent_id: params.agent_id,
                    browser_session_id: params.browser_session_id,
                    tab_id: tab_id.clone(),
                    source: params.source,
                }).await {
                    operation.fail("tab close failed"); self.emit_operation(&operation); return Err(error);
                }
                operation.commit(); operation.succeed(); self.emit_operation(&operation);
                return Ok(json!({ "ok": true, "operationId": operation_id, "action": "tab-close", "changed": ["tab closed"], "tabId": tab_id }));
            }
            BrowserAction::TabFocus { tab_id } => {
                operation.start();
                if let Err(error) = self.browser_focus_tab(TabAddressParams {
                    agent_id: params.agent_id,
                    browser_session_id: params.browser_session_id,
                    tab_id: tab_id.clone(),
                    source: params.source,
                }).await {
                    operation.fail("tab focus failed"); self.emit_operation(&operation); return Err(error);
                }
                operation.commit(); operation.succeed(); self.emit_operation(&operation);
                return Ok(json!({ "ok": true, "operationId": operation_id, "action": "tab-focus", "changed": ["tab focused"], "tabId": tab_id }));
            }
            _ => {}
        }
        let action_name = action_kind(&params.action);
        let (backend_action, upload_handle_ids) = match params.action {
            BrowserAction::Upload { r#ref, selector, files } => {
                let paths = match self.uploads.resolve(&params.agent_id, &params.browser_session_id, &files) {
                    Ok(paths) => paths,
                    Err(error) => { operation.fail("upload handle validation failed"); self.emit_operation(&operation); return Err(error); }
                };
                let backend_files = paths.into_iter().map(|path| path.to_string_lossy().into_owned()).collect();
                (BrowserAction::Upload { r#ref, selector, files: backend_files }, Some(files))
            }
            action => (action, None),
        };
        let mut cancellation = operation.cancellation();
        let queue = tokio::select! {
            queue = resolved.host.queue.lock() => queue,
            _ = cancelled(&mut cancellation) => {
                operation.cancelled();
                self.emit_operation(&operation);
                return Err(cancelled_error(&operation_id));
            }
        };
        operation.start();
        self.emit("browser.activity", json!({ "agentId": params.agent_id, "browserSessionId": params.browser_session_id, "tabId": params.tab_id, "operationId": operation_id, "action": action_name, "state": "running" }));
        self.update_tab_state(&resolved.tab.tab_id, TabState::Running);
        let backend = resolved.host.controller.act(&resolved.address, backend_action);
        let backend_result = tokio::select! {
            result = backend => result.map_err(backend_rpc_error),
            _ = cancelled(&mut cancellation) => Err(cancelled_error(&operation_id)),
        };
        drop(queue);
        let mut result = match backend_result {
            Ok(result) => result,
            Err(error) => {
                self.update_tab_state(&resolved.tab.tab_id, TabState::Idle);
                if error.code == -32010 { operation.cancelled(); } else { operation.fail("backend action failed"); }
                self.emit("browser.activity", json!({ "agentId": params.agent_id, "browserSessionId": params.browser_session_id, "tabId": params.tab_id, "operationId": operation_id, "action": action_name, "state": operation.record().state }));
                self.emit_operation(&operation);
                self.save_snapshot().await;
                return Err(error);
            }
        };
        operation.commit();
        if let Some(ids) = upload_handle_ids.as_ref() {
            if let Err(error) = self.uploads.consume(&params.agent_id, &params.browser_session_id, ids) {
                operation.fail("upload handle commit failed"); self.emit_operation(&operation); return Err(error);
            }
        }
        let mut tab = resolved.tab;
        if let Some(url) = &result.url { tab.url = url.clone(); }
        if let Some(title) = &result.title { tab.title = title.clone(); }
        tab.state = TabState::Idle;
        tab.last_action_at = Some(Utc::now());
        self.tabs.insert(tab.tab_id.clone(), tab.clone());
        if let Some(mut session) = self.sessions.get_mut(&tab.browser_session_id) { session.last_activity_at = Utc::now(); }
        if let Err(error) = self.ingest_action_artifacts(&tab, &mut result) {
            operation.fail("action result ingestion failed");
            self.emit_operation(&operation);
            self.save_snapshot().await;
            return Err(error);
        }
        operation.succeed();
        self.emit("browser.tabUpdated", &tab);
        self.emit("browser.activity", json!({ "agentId": tab.owner_agent_id, "browserSessionId": tab.browser_session_id, "tabId": tab.tab_id, "operationId": operation_id, "action": result.action, "state": "succeeded", "changed": result.changed }));
        self.emit_operation(&operation);
        self.save_snapshot().await;
        let mut output = serde_json::to_value(result).map_err(internal_rpc_error)?;
        if let Some(object) = output.as_object_mut() { object.insert("operationId".into(), json!(operation_id)); }
        Ok(output)
    }

    async fn browser_observe(&self, params: ObserveParams) -> Result<Value, RpcError> {
        let resolved = self.resolve_address(&params.agent_id, &params.browser_session_id, &params.tab_id)?;
        let operation = self.operations.begin(params.operation_id, params.agent_id.clone(), "observe")?;
        let operation_id = operation.id();
        let requested_max = params.max_chars.unwrap_or(MODEL_DEFAULT_MAX_CHARS).clamp(1, self.config.limits.max_observation_chars);
        let backend_request = ObserveRequest { view: params.view, selector: params.selector, max_chars: self.config.limits.max_observation_chars, include_bounds: params.include_bounds };
        let mut cancellation = operation.cancellation();
        let queue = tokio::select! {
            queue = resolved.host.queue.lock() => queue,
            _ = cancelled(&mut cancellation) => { operation.cancelled(); self.emit_operation(&operation); return Err(cancelled_error(&operation_id)); }
        };
        operation.start();
        let backend = resolved.host.controller.observe(&resolved.address, backend_request);
        let result = tokio::select! {
            result = backend => result.map_err(backend_rpc_error),
            _ = cancelled(&mut cancellation) => Err(cancelled_error(&operation_id)),
        };
        drop(queue);
        let mut observation = match result {
            Ok(observation) => observation,
            Err(error) => { if error.code == -32010 { operation.cancelled(); } else { operation.fail("backend observation failed"); } self.emit_operation(&operation); return Err(error); }
        };
        operation.commit();
        if let Err(error) = self.ingest_observation_artifacts(&resolved.tab, &mut observation, requested_max) {
            operation.fail("observation ingestion failed"); self.emit_operation(&operation); return Err(error);
        }
        operation.succeed();
        self.emit_operation(&operation);
        let mut output = serde_json::to_value(observation).map_err(internal_rpc_error)?;
        if let Some(object) = output.as_object_mut() { object.insert("operationId".into(), json!(operation_id)); }
        Ok(output)
    }

    async fn browser_debug(&self, params: DebugParams) -> Result<Value, RpcError> {
        if matches!(params.operation, DebugOperation::Cookies | DebugOperation::Storage | DebugOperation::Evaluate) {
            return Err(RpcError { code: -32030, message: "secret data access refused".into(), data: None });
        }
        let resolved = self.resolve_address(&params.agent_id, &params.browser_session_id, &params.tab_id)?;
        let operation = self.operations.begin(params.operation_id, params.agent_id.clone(), "debug")?;
        let operation_id = operation.id();
        let mut cancellation = operation.cancellation();
        let queue = tokio::select! {
            queue = resolved.host.queue.lock() => queue,
            _ = cancelled(&mut cancellation) => { operation.cancelled(); self.emit_operation(&operation); return Err(cancelled_error(&operation_id)); }
        };
        operation.start();
        let backend = resolved.host.controller.debug(&resolved.address, DebugRequest { operation: params.operation, args: params.args });
        let backend_result = tokio::select! {
            result = backend => result.map_err(backend_rpc_error),
            _ = cancelled(&mut cancellation) => Err(cancelled_error(&operation_id)),
        };
        drop(queue);
        let mut result = match backend_result {
            Ok(result) => result,
            Err(error) => { if error.code == -32010 { operation.cancelled(); } else { operation.fail("backend debug failed"); } self.emit_operation(&operation); return Err(error); }
        };
        operation.commit();
        let output_file_artifact = match self.ingest_typed_debug_transfer(&resolved, params.operation, &mut result) {
            Ok(artifact) => artifact,
            Err(error) => { operation.fail("debug transfer ingestion failed"); self.emit_operation(&operation); return Err(error); }
        };

        let max_chars = params.max_chars.unwrap_or(DEBUG_DEFAULT_MAX_CHARS).clamp(1, self.config.limits.max_debug_chars);
        let encoded = match serde_json::to_vec(&result.data) {
            Ok(encoded) => encoded,
            Err(error) => { operation.fail("debug result encoding failed"); self.emit_operation(&operation); return Err(internal_rpc_error(error)); }
        };
        if encoded.len() > max_chars || matches!(params.operation, DebugOperation::Html | DebugOperation::Network | DebugOperation::Console) {
            let artifact = match self.artifacts.put_bytes("application/json", &encoded, artifact_context(&resolved.tab, Some(resolved.tab.url.clone()), BTreeMap::from([("operation".into(), json!(params.operation)), ("kind".into(), json!("backend-debug-result"))]))) {
                Ok(artifact) => artifact,
                Err(error) => { operation.fail("debug artifact write failed"); self.emit_operation(&operation); return Err(internal_rpc_error(error)); }
            };
            if result.artifact_id.is_none() { result.artifact_id = Some(artifact.artifact_id.clone()); }
            self.emit("artifact.created", &artifact);
            if encoded.len() > max_chars {
                result.data = json!({
                    "truncated": true,
                    "backendResultArtifactId": artifact.artifact_id,
                    "outputArtifactId": output_file_artifact,
                    "bytes": encoded.len()
                });
            } else if let Some(output_artifact_id) = output_file_artifact {
                if let Some(object) = result.data.as_object_mut() {
                    object.insert("outputArtifactId".into(), json!(output_artifact_id));
                }
            }
        }
        operation.succeed();
        self.emit_operation(&operation);
        let mut output = serde_json::to_value(result).map_err(internal_rpc_error)?;
        if let Some(object) = output.as_object_mut() { object.insert("operationId".into(), json!(operation_id)); }
        Ok(output)
    }

    async fn browser_stream_info(&self, params: TabAddressParams) -> Result<Value, RpcError> {
        let resolved = self.resolve_address(&params.agent_id, &params.browser_session_id, &params.tab_id)?;
        let info = resolved.host.controller.stream_info(&resolved.address).await.map_err(backend_rpc_error)?;
        value(info)
    }

    async fn browser_set_control(&self, params: ControlParams) -> Result<Value, RpcError> {
        let resolved = self.resolve_address(&params.agent_id, &params.browser_session_id, &params.tab_id)?;
        let control_epoch = resolved.gate.set(params.control);
        let mut tab = resolved.tab;
        tab.control = params.control;
        self.tabs.insert(tab.tab_id.clone(), tab.clone());
        self.emit("browser.controlChanged", json!({ "agentId": tab.owner_agent_id, "browserSessionId": tab.browser_session_id, "tabId": tab.tab_id, "control": tab.control, "controlEpoch": control_epoch }));
        if params.control == TabControl::Human {
            if let Some(timeout) = self.config.human_control.inactivity_timeout_ms {
                let coordinator = self.clone();
                let tab_id = tab.tab_id.clone();
                let owner_agent_id = tab.owner_agent_id.clone();
                let browser_session_id = tab.browser_session_id.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(timeout)).await;
                    if let Some(gate) = coordinator.controls.get(&tab_id) {
                        if gate.current() == TabControl::Human && gate.epoch() == control_epoch {
                            let next_epoch = gate.set(TabControl::Agent);
                            if let Some(mut tab) = coordinator.tabs.get_mut(&tab_id) { tab.control = TabControl::Agent; }
                            coordinator.emit("browser.controlChanged", json!({ "agentId": owner_agent_id, "browserSessionId": browser_session_id, "tabId": tab_id, "control": "agent", "controlEpoch": next_epoch, "reason": "inactivity-timeout" }));
                        }
                    }
                });
            }
        }
        value(tab)
    }

    async fn search_query(&self, request: SearchQuery) -> Result<Value, RpcError> {
        value(self.search.query(request).await.map_err(external_rpc_error)?)
    }

    async fn read_url(&self, params: ReadUrlParams) -> Result<Value, RpcError> {
        if let Some(agent_id) = params.agent_id.as_ref() { self.ensure_agent(agent_id)?; }
        let requested_max = params.request.max_chars.clamp(1, self.config.limits.max_observation_chars);
        let mut backend_request = params.request.clone();
        backend_request.max_chars = self.config.limits.max_observation_chars;
        let mut result = self.reader.read(backend_request).await.map_err(external_rpc_error)?;

        // Documents carry their original bytes once across the private loopback service
        // boundary. Move those bytes immediately into the content-addressed artifact store
        // and never include them in the model-facing response.
        if let Some(encoded) = result.metadata.remove("originalDataBase64").and_then(|value| value.as_str().map(str::to_owned)) {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|error| internal_rpc_error(anyhow!("decode original document bytes: {error}")))?;
            let media_type = result.metadata.get("documentMediaType").and_then(Value::as_str).unwrap_or("application/octet-stream");
            let artifact = self.artifacts.put_bytes(
                media_type,
                &bytes,
                ArtifactContext {
                    owner_agent_id: params.agent_id.clone(),
                    source_url: Some(result.url.clone()),
                    metadata: BTreeMap::from([("kind".into(), json!("original-document"))]),
                    ..Default::default()
                },
            ).map_err(internal_rpc_error)?;
            result.metadata.insert("originalArtifactId".into(), json!(artifact.artifact_id));
            self.emit("artifact.created", &artifact);
        }

        let render_required = result.metadata.get("renderRequired").and_then(Value::as_bool).unwrap_or(false);
        if render_required {
            if let Some(agent_id) = params.agent_id.as_ref() {
                match self.read_via_browser(agent_id, &params.request).await {
                    Ok(mut rendered) => {
                        rendered.metadata.insert("staticReadSource".into(), json!(result.source));
                        rendered.metadata.insert("staticReadMetadata".into(), json!(result.metadata));
                        result = rendered;
                    }
                    Err(error) => {
                        result.metadata.insert("renderFailed".into(), json!(true));
                        result.metadata.insert("renderError".into(), json!({ "code": error.code, "message": error.message, "data": error.data }));
                    }
                }
            } else {
                result.metadata.insert("renderDeferred".into(), json!("agentId was not supplied"));
            }
        }

        if result.content.chars().count() > requested_max || result.truncated {
            let artifact = self.artifacts.put_bytes(
                "text/markdown",
                result.content.as_bytes(),
                ArtifactContext {
                    owner_agent_id: params.agent_id.clone(),
                    source_url: Some(result.url.clone()),
                    metadata: BTreeMap::from([("readSource".into(), json!(result.source))]),
                    ..Default::default()
                },
            ).map_err(internal_rpc_error)?;
            if result.content.chars().count() > requested_max {
                result.content = truncate_chars(&result.content, requested_max);
            }
            result.truncated = true;
            result.metadata.insert("artifactId".into(), json!(artifact.artifact_id));
            self.emit("artifact.created", &artifact);
        }
        value(result)
    }

    async fn read_via_browser(&self, agent_id: &AgentId, request: &ReadRequest) -> Result<ReadResponse, RpcError> {
        let mut attempts = Vec::new();
        for (engine_selection, source) in [(EngineSelection::Chromium, ReadSource::Chromium)] {
            let started = match self.browser_start(BrowserStartParams {
                agent_id: agent_id.clone(),
                engine: engine_selection,
                backend: BackendSelection::AgentBrowser,
                profile_id: None,
                profile: None,
                visible: Some(false),
                url: Some(request.url.clone()),
                label: Some("background reader".into()),
            }).await {
                Ok(value) => value,
                Err(error) => {
                    attempts.push(json!({ "engine": engine_name(match engine_selection { EngineSelection::Lightpanda => BrowserEngine::Lightpanda, _ => BrowserEngine::Chromium }), "stage": "start", "error": error.message }));
                    continue;
                }
            };
            let session: BrowserSession = serde_json::from_value(started.get("browserSession").cloned().unwrap_or(Value::Null)).map_err(internal_rpc_error)?;
            let tab: TabInfo = serde_json::from_value(started.get("tab").cloned().unwrap_or(Value::Null)).map_err(internal_rpc_error)?;
            let observed = self.browser_observe(ObserveParams {
                agent_id: agent_id.clone(),
                browser_session_id: session.browser_session_id.clone(),
                tab_id: tab.tab_id.clone(),
                view: ObservationView::Main,
                selector: None,
                max_chars: Some(self.config.limits.max_observation_chars),
                include_bounds: false,
                operation_id: None,
            }).await;
            let stop_result = self.browser_stop(SessionAddress {
                agent_id: agent_id.clone(),
                browser_session_id: session.browser_session_id,
            }).await;
            if let Err(error) = stop_result {
                self.emit("system.error", json!({ "message": "background reader cleanup failed", "error": error.message, "tabId": tab.tab_id }));
            }
            match observed {
                Ok(value) => {
                    let observation: Observation = serde_json::from_value(value).map_err(internal_rpc_error)?;
                    let mut metadata = observation.metadata;
                    metadata.insert("rendered".into(), json!(true));
                    metadata.insert("renderEngine".into(), json!(source));
                    metadata.insert("renderAttempts".into(), json!(attempts));
                    if let Some(artifact_id) = observation.artifact_id {
                        metadata.insert("browserObservationArtifactId".into(), json!(artifact_id));
                    }
                    return Ok(ReadResponse {
                        url: observation.url,
                        title: observation.title,
                        media_type: "text/markdown".into(),
                        content: observation.content,
                        source,
                        truncated: observation.truncated,
                        metadata,
                    });
                }
                Err(error) => attempts.push(json!({
                    "engine": engine_name(match engine_selection { EngineSelection::Lightpanda => BrowserEngine::Lightpanda, _ => BrowserEngine::Chromium }),
                    "stage": "observe",
                    "error": error.message,
                })),
            }
        }
        Err(RpcError {
            code: -32020,
            message: "static extraction required rendering, but the explicit Chromium path failed".into(),
            data: Some(json!({ "url": request.url, "attempts": attempts })),
        })
    }

    async fn read_active_tab(&self, params: ObserveParams) -> Result<Value, RpcError> {
        self.browser_observe(ObserveParams { view: ObservationView::Main, ..params }).await
    }

    fn artifact_get(&self, principal: &Principal, params: ArtifactGetParams) -> Result<Value, RpcError> {
        let record = self.artifacts.get(&principal.agent_id, &params.artifact_id).map_err(artifact_rpc_error)?
            .ok_or_else(|| RpcError::not_found("artifact", params.artifact_id.as_ref()))?;
        let page = self.artifacts.page(&principal.agent_id, &params.artifact_id, params.offset, params.limit.clamp(1, 4 * 1024 * 1024), None).map_err(artifact_rpc_error)?;
        if page.record.sha256 != record.sha256 || page.record.size != record.size {
            return Err(RpcError { code: -32012, message: "artifact integrity failure".into(), data: None });
        }
        let text_like = page.record.media_type.starts_with("text/") || page.record.media_type.contains("json") || page.record.media_type.contains("markdown");
        let mut output = Map::new();
        output.insert("record".into(), safe_artifact_record(&page.record));
        output.insert("offset".into(), json!(page.offset));
        output.insert("nextOffset".into(), json!(page.next_offset));
        output.insert("eof".into(), json!(page.eof));
        if text_like {
            output.insert("text".into(), Value::String(String::from_utf8_lossy(&page.bytes).into_owned()));
        } else {
            output.insert("dataBase64".into(), Value::String(base64::engine::general_purpose::STANDARD.encode(&page.bytes)));
        }
        Ok(Value::Object(output))
    }

    fn artifact_list(&self, principal: &Principal, params: ArtifactListParams) -> Result<Value, RpcError> {
        if params.owner_agent_id.as_ref().is_some_and(|owner| owner != &principal.agent_id) {
            return Err(forbidden());
        }
        if let Some(session_id) = params.browser_session_id.as_ref() {
            self.owned_session(&principal.agent_id, session_id)?;
        }
        let records = self.artifacts.list(&principal.agent_id, params.browser_session_id.as_ref(), params.limit).map_err(artifact_rpc_error)?;
        Ok(Value::Array(records.iter().map(safe_artifact_record).collect()))
    }

    fn artifact_delete(&self, principal: &Principal, params: ArtifactDeleteParams) -> Result<Value, RpcError> {
        let owned = self.artifacts.get(&principal.agent_id, &params.artifact_id).map_err(artifact_rpc_error)?.is_some();
        if !owned { return Err(RpcError::not_found("artifact", params.artifact_id.as_ref())); }
        Ok(json!({ "deleted": self.artifacts.delete(&principal.agent_id, &params.artifact_id).map_err(internal_rpc_error)? }))
    }

    fn operation_cancel(&self, principal: &Principal, params: OperationAddressParams) -> Result<Value, RpcError> {
        self.operations.cancel(&principal.agent_id, &params.operation_id)
    }

    fn operation_get(&self, principal: &Principal, params: OperationAddressParams) -> Result<Value, RpcError> {
        value(self.operations.get(&principal.agent_id, &params.operation_id)?)
    }

    fn transfer_stage_upload(&self, principal: &Principal, params: StageUploadParams) -> Result<Value, RpcError> {
        if params.agent_id != principal.agent_id { return Err(forbidden()); }
        self.owned_session(&principal.agent_id, &params.browser_session_id)?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(&params.data_base64)
            .map_err(|_| RpcError::invalid_params("dataBase64 is invalid"))?;
        if bytes.len() > 32 * 1024 * 1024 { return Err(RpcError::invalid_params("upload exceeds 32 MiB")); }
        let upload = self.uploads.stage(principal.agent_id.clone(), params.browser_session_id, params.media_type, &bytes)?;
        value(upload)
    }

    fn transfer_commit_upload(&self, principal: &Principal, params: CommitUploadParams) -> Result<Value, RpcError> {
        if params.agent_id != principal.agent_id { return Err(forbidden()); }
        self.owned_session(&principal.agent_id, &params.browser_session_id)?;
        self.uploads.resolve(&principal.agent_id, &params.browser_session_id, &params.upload_handle_ids)?;
        Ok(json!({ "committed": true, "uploadHandleIds": params.upload_handle_ids }))
    }

    fn ensure_agent(&self, agent_id: &AgentId) -> Result<(), RpcError> {
        self.agents.contains_key(agent_id).then_some(()).ok_or_else(|| RpcError::not_found("agent", agent_id.as_ref()))
    }

    fn owned_session(&self, agent_id: &AgentId, session_id: &BrowserSessionId) -> Result<BrowserSession, RpcError> {
        let session = self.sessions.get(session_id).ok_or_else(|| RpcError::not_found("browser session", session_id.as_ref()))?;
        if session.owner_agent_id != *agent_id {
            return Err(RpcError::not_found("browser session", session_id.as_ref()));
        }
        Ok(session.clone())
    }

    fn resolve_address(&self, agent_id: &AgentId, session_id: &BrowserSessionId, tab_id: &TabId) -> Result<ResolvedAddress, RpcError> {
        let session = self.owned_session(agent_id, session_id)?;
        let tab = self.tabs.get(tab_id).ok_or_else(|| RpcError::not_found("tab", tab_id.as_ref()))?;
        if tab.owner_agent_id != *agent_id || tab.browser_session_id != *session_id || tab.host_id != session.host_id {
            return Err(RpcError::not_found("tab", tab_id.as_ref()));
        }
        let tab = tab.clone();
        let host = self.hosts.get(&tab.host_id).map(|entry| Arc::clone(entry.value())).ok_or_else(|| RpcError::not_found("host", tab.host_id.as_ref()))?;
        let gate = self.controls.get(tab_id).map(|entry| Arc::clone(entry.value())).ok_or_else(|| RpcError::not_found("control gate", tab_id.as_ref()))?;
        Ok(ResolvedAddress {
            host,
            tab,
            gate,
            address: BrowserAddress { agent_id: agent_id.clone(), browser_session_id: session_id.clone(), tab_id: tab_id.clone() },
        })
    }

    fn ensure_profile_owner(&self, principal: &Principal, profile_id: &ProfileId) -> Result<(), RpcError> {
        if self.profile_owners.get(profile_id).is_some_and(|owner| *owner == principal.agent_id) {
            Ok(())
        } else {
            Err(RpcError::not_found("profile", profile_id.as_ref()))
        }
    }

    fn resolve_profile(&self, agent_id: &AgentId, profile_id: Option<&ProfileId>, name: Option<&str>) -> Result<Option<BrowserProfile>, RpcError> {
        if let Some(profile_id) = profile_id {
            if !self.profile_owners.get(profile_id).is_some_and(|owner| *owner == *agent_id) {
                return Err(RpcError::not_found("profile", profile_id.as_ref()));
            }
            return self.profiles.get(profile_id).map(|entry| Some(entry.clone())).ok_or_else(|| RpcError::not_found("profile", profile_id.as_ref()));
        }
        if let Some(name) = name {
            return self.profiles.iter()
                .find(|profile| profile.name == name && self.profile_owners.get(profile.key()).is_some_and(|owner| *owner == *agent_id))
                .map(|entry| Some(entry.clone()))
                .ok_or_else(|| RpcError::not_found("profile", name));
        }
        Ok(None)
    }

    async fn rollback_failed_start(&self, host: &Arc<HostEntry>, new_host: bool, profile: Option<&BrowserProfile>) -> bool {
        if !new_host { return false; }
        match host.controller.stop_host(&host.handle).await {
            Ok(()) => {
                self.hosts.remove(&host.handle.host.host_id);
                if let Some(profile) = profile { self.profile_hosts.remove(&profile.profile_id); }
                false
            }
            Err(error) => {
                tracing::warn!(%error, host_id=%host.handle.host.host_id, "failed start needs protected cleanup retry");
                true
            }
        }
    }

    fn controller(&self, backend: BrowserBackend) -> Arc<dyn BrowserController> {
        match backend {
            BrowserBackend::AgentBrowser => self.agent_browser.clone(),
            BrowserBackend::Pinchtab => self.pinchtab.clone(),
        }
    }

    fn enforce_host_limit(&self, engine: BrowserEngine) -> Result<(), RpcError> {
        let count = self.hosts.iter().filter(|host| host.handle.host.engine == engine).count();
        let limit = match engine {
            BrowserEngine::Chromium => self.config.limits.max_chromium_hosts,
            BrowserEngine::Lightpanda => self.config.limits.max_lightpanda_hosts,
        };
        if count >= limit { Err(RpcError::conflict("browser host limit reached", json!({ "engine": engine, "limit": limit }))) } else { Ok(()) }
    }

    fn enforce_tab_limit(&self, host_id: &HostId) -> Result<(), RpcError> {
        let count = self.tabs.iter().filter(|tab| tab.host_id == *host_id).count();
        if count >= self.config.limits.max_tabs_per_host {
            Err(RpcError::conflict("tab limit reached", json!({ "hostId": host_id, "limit": self.config.limits.max_tabs_per_host })))
        } else { Ok(()) }
    }

    fn update_tab_state(&self, tab_id: &TabId, state: TabState) {
        if let Some(mut tab) = self.tabs.get_mut(tab_id) { tab.state = state; }
    }

    fn ingest_action_artifacts(&self, tab: &TabInfo, result: &mut ActionResult) -> Result<(), RpcError> {
        if let Some(raw) = result.backend.remove("raw") {
            let bytes = serde_json::to_vec(&raw).map_err(internal_rpc_error)?;
            if bytes.len() > 4_096 {
                let artifact = self.artifacts.put_bytes("application/json", &bytes, artifact_context(tab, Some(tab.url.clone()), BTreeMap::from([("kind".into(), json!("backend-action-result"))]))).map_err(internal_rpc_error)?;
                result.artifact_id = Some(artifact.artifact_id.clone());
                self.emit("artifact.created", &artifact);
            } else {
                result.backend.insert("raw".into(), raw);
            }
        }
        if let Some(value) = result.backend.remove("transfer") {
            let handle = parse_transfer(value)?;
            if handle.kind != TransferKind::Download { return Err(invalid_backend_transfer()); }
            let artifact = self.ingest_transfer(tab, &handle, "download")?;
            result.download_artifact_id = Some(artifact.artifact_id.clone());
            self.emit("browser.downloadUpdated", &artifact);
            self.emit("artifact.created", &artifact);
        }
        Ok(())
    }

    fn ingest_transfer(&self, tab: &TabInfo, handle: &BackendTransferHandle, kind: &str) -> Result<StoredArtifactRecord, RpcError> {
        let root = self.paths.data.join("downloads").join("hosts").join(tab.host_id.as_ref());
        let path = resolve_transfer(&root, &tab.host_id, handle)?;
        self.artifacts.put_file(
            &handle.media_type,
            &path,
            artifact_context(tab, Some(tab.url.clone()), BTreeMap::from([("kind".into(), json!(kind))])),
        ).map_err(internal_rpc_error)
    }

    fn ingest_typed_debug_transfer(&self, resolved: &ResolvedAddress, operation: DebugOperation, result: &mut DebugResult) -> Result<Option<ArtifactId>, RpcError> {
        let transfer = result.data.as_object_mut().and_then(|object| object.remove("transfer"));
        let Some(transfer) = transfer else { return Ok(None); };
        let handle = parse_transfer(transfer)?;
        if handle.kind != TransferKind::DebugOutput { return Err(invalid_backend_transfer()); }
        let artifact = self.ingest_transfer(&resolved.tab, &handle, "debug-output")?;
        result.artifact_id = Some(artifact.artifact_id.clone());
        if let Some(object) = result.data.as_object_mut() { object.insert("outputArtifactId".into(), json!(artifact.artifact_id)); }
        self.emit("artifact.created", &artifact);
        let _ = operation;
        Ok(Some(artifact.artifact_id))
    }

    fn ingest_observation_artifacts(&self, tab: &TabInfo, observation: &mut Observation, requested_max: usize) -> Result<(), RpcError> {
        if observation.metadata.contains_key("screenshotPath") {
            observation.metadata.remove("screenshotPath");
            return Err(invalid_backend_transfer());
        }
        if let Some(value) = observation.metadata.remove("transfer") {
            let handle = parse_transfer(value)?;
            if handle.kind != TransferKind::Screenshot { return Err(invalid_backend_transfer()); }
            let artifact = self.ingest_transfer(tab, &handle, "screenshot")?;
            observation.artifact_id = Some(artifact.artifact_id.clone());
            self.emit("artifact.created", &artifact);
        }

        let raw_content = observation.metadata.remove("rawContent").and_then(|value| value.as_str().map(str::to_owned));
        let complete = raw_content.as_deref().unwrap_or(&observation.content);
        let complete_chars = complete.chars().count();
        let needs_text_artifact = raw_content.is_some() || complete_chars > requested_max || observation.view == ObservationView::Full;
        if needs_text_artifact {
            let artifact = self.artifacts.put_bytes(
                "text/plain; charset=utf-8",
                complete.as_bytes(),
                artifact_context(tab, Some(tab.url.clone()), BTreeMap::from([("view".into(), json!(observation.view)), ("characters".into(), json!(complete_chars)), ("kind".into(), json!("complete-observation"))])),
            ).map_err(internal_rpc_error)?;
            if observation.artifact_id.is_some() {
                observation.metadata.insert("contentArtifactId".into(), json!(artifact.artifact_id.clone()));
            } else {
                observation.artifact_id = Some(artifact.artifact_id.clone());
            }
            self.emit("artifact.created", &artifact);
        }

        if observation.content.chars().count() > requested_max {
            observation.content = truncate_chars(&observation.content, requested_max);
            observation.truncated = true;
        }
        Ok(())
    }

    fn launch_workspace(&self) {
        let binary = self.config.workspace_binary.clone();
        tokio::spawn(async move {
            let gdk_backend = std::env::var("PI_WEB_GDK_BACKEND").unwrap_or_else(|_| "x11".into());
            if let Err(error) = Command::new(&binary)
                .env("GDK_BACKEND", gdk_backend)
                .env("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
                .arg("--raise")
                .spawn()
            {
                tracing::warn!(%error, %binary, "failed to launch workspace");
            }
        });
    }

    fn emit_operation(&self, operation: &OperationHandle) {
        self.emit("operation.changed", operation.record());
    }

    fn emit(&self, method: &str, params: impl Serialize) {
        let params = serde_json::to_value(params).unwrap_or_else(|_| json!({ "failure": "event serialization failed" }));
        let owner_agent_id = find_agent_id(&params);
        let method = match method {
            "browser.sessionUpdated" => "session.changed",
            "browser.tabUpdated" => "tab.changed",
            "browser.controlChanged" => "control.changed",
            "browser.hostUpdated" => "lifecycle.changed",
            other => other,
        };
        let notification = RpcNotification { jsonrpc: "2.0".into(), method: method.into(), params };
        if let Some(owner) = owner_agent_id.as_ref() {
            let mut events = self.workspace_events.entry(owner.clone()).or_default();
            events.insert(0, WorkspaceSafeEvent {
                id: Uuid::new_v4().to_string(),
                at: Utc::now().format("%H:%M:%S").to_string(),
                message: safe_workspace_event_message(method).into(),
            });
            events.truncate(20);
        }
        let _ = self.events.send(ScopedEvent { notification, owner_agent_id });
    }

    async fn save_snapshot(&self) {
        let snapshot = RegistrySnapshot {
            protocol_version: PROTOCOL_VERSION.into(),
            saved_at: Utc::now(),
            agents: Vec::new(),
            profiles: self.profiles.iter().map(|entry| entry.value().clone()).collect(),
            profile_owners: self.profile_owners.iter().map(|entry| (entry.key().clone(), entry.value().clone())).collect(),
            hosts: self.hosts.iter().map(|entry| RecoveredHost { handle: entry.handle.clone(), persistent: entry.persistent, launch: entry.launch.clone() }).collect(),
            sessions: self.sessions.iter().map(|entry| entry.value().clone()).collect(),
            tabs: self.tabs.iter().map(|entry| entry.value().clone()).collect(),
            control_epochs: self.controls.iter().map(|entry| (entry.key().clone(), entry.epoch())).collect(),
            operations: self.operations.snapshot(),
        };
        let path = self.paths.registry_snapshot_path();
        let temporary = path.with_extension("json.tmp");
        match serde_json::to_vec_pretty(&snapshot) {
            Ok(bytes) => {
                let persisted = async {
                    tokio::fs::write(&temporary, bytes).await?;
                    #[cfg(unix)]
                    tokio::fs::set_permissions(&temporary, std::os::unix::fs::PermissionsExt::from_mode(0o600)).await?;
                    tokio::fs::File::open(&temporary).await?.sync_all().await?;
                    tokio::fs::rename(&temporary, &path).await?;
                    if let Some(parent) = path.parent() { tokio::fs::File::open(parent).await?.sync_all().await?; }
                    Ok::<(), std::io::Error>(())
                }.await;
                if let Err(error) = persisted {
                    tracing::warn!(%error, path=%path.display(), "failed to persist registry snapshot");
                }
            }
            Err(error) => tracing::warn!(%error, "failed to serialize registry snapshot"),
        }
    }

    async fn restore_snapshot(&self) -> AnyResult<()> {
        let path = self.paths.registry_snapshot_path();
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        let snapshot: RegistrySnapshot = match serde_json::from_slice(&bytes) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let quarantine = path.with_extension(format!("corrupt-{}", Uuid::new_v4()));
                let _ = tokio::fs::rename(&path, &quarantine).await;
                tracing::warn!(%error, path=%path.display(), "quarantined invalid registry snapshot");
                return Ok(());
            }
        };
        if let Err(error) = ensure_compatible_version(&snapshot.protocol_version) {
            tracing::warn!(%error, "ignored incompatible registry snapshot");
            return Ok(());
        }
        for profile in snapshot.profiles { self.profiles.insert(profile.profile_id.clone(), profile); }
        for (profile_id, owner) in snapshot.profile_owners { self.profile_owners.insert(profile_id, owner); }
        // Recovery is capability-aware. Agent-browser hosts are attached to their existing
        // named daemon sessions. Unsupported backends remain visible as failed instead of
        // being silently replaced.
        for recovered in snapshot.hosts {
            if !recovered.persistent {
                tracing::info!(host_id=%recovered.handle.host.host_id, "discarded ephemeral browser host during recovery");
                continue;
            }
            if recovered.handle.host.engine != BrowserEngine::Chromium {
                tracing::warn!(host_id=%recovered.handle.host.host_id, "refused recovery of unsupported browser path");
                continue;
            }
            let controller = self.controller(recovered.handle.host.backend);
            let attached = match recovered.handle.host.backend {
                BrowserBackend::AgentBrowser => self.agent_browser.recover_host(recovered.handle.clone(), recovered.launch.clone()).await,
                _ => Err(BackendError::Unsupported { capability: "host recovery".into(), backend: format!("{:?}", recovered.handle.host.backend) }),
            };
            match attached {
                Ok(handle) => {
                    let host_id = handle.host.host_id.clone();
                    let entry = Arc::new(HostEntry { handle: handle.clone(), controller, queue: Mutex::new(()), persistent: recovered.persistent, launch: recovered.launch });
                    if let Some(profile_id) = &handle.host.profile_id { self.profile_hosts.insert(profile_id.clone(), host_id.clone()); }
                    self.hosts.insert(host_id, entry);
                }
                Err(error) => tracing::warn!(%error, host_id=%recovered.handle.host.host_id, "browser host recovery failed"),
            }
        }
        for session in snapshot.sessions {
            if self.hosts.contains_key(&session.host_id) { self.sessions.insert(session.browser_session_id.clone(), session); }
        }
        let control_epochs = snapshot.control_epochs;
        for mut tab in snapshot.tabs {
            let valid = self.hosts.contains_key(&tab.host_id)
                && self.sessions.get(&tab.browser_session_id).is_some_and(|session| {
                    session.host_id == tab.host_id && session.owner_agent_id == tab.owner_agent_id
                });
            if valid {
                tab.state = TabState::Idle;
                let epoch = control_epochs.get(&tab.tab_id).copied().unwrap_or(0).saturating_add(1);
                self.controls.insert(tab.tab_id.clone(), Arc::new(ControlGate::with_epoch(tab.control, epoch)));
                self.tabs.insert(tab.tab_id.clone(), tab);
            }
        }
        self.operations.restore(snapshot.operations);
        Ok(())
    }
}

fn with_control(params: Value, control: TabControl) -> Result<ControlParams, RpcError> {
    let mut params = params;
    let object = params.as_object_mut().ok_or_else(|| RpcError::invalid_params("params must be an object"))?;
    if let Some(session_id) = object.remove("sessionId") { object.insert("browserSessionId".into(), session_id); }
    object.insert("control".into(), json!(control));
    parse(params)
}

fn required_principal(principal: Option<&Principal>) -> Result<&Principal, RpcError> {
    principal.ok_or_else(forbidden)
}

fn bind_principal_params(mut params: Value, principal: &Principal) -> Result<Value, RpcError> {
    if params.is_null() { params = json!({}); }
    let object = params.as_object_mut().ok_or_else(|| RpcError::invalid_params("params must be an object"))?;
    if object.get("agentId").is_some_and(|value| value != principal.agent_id.as_ref()) {
        return Err(forbidden());
    }
    if object.get("clientId").is_some_and(|value| value != principal.client_id.as_ref()) {
        return Err(forbidden());
    }
    object.insert("agentId".into(), json!(principal.agent_id));
    if object.contains_key("clientId") { object.insert("clientId".into(), json!(principal.client_id)); }
    Ok(params)
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(|error| RpcError::invalid_params(error.to_string()))
}

fn value(value: impl Serialize) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(internal_rpc_error)
}

fn internal_rpc_error(error: impl std::fmt::Display) -> RpcError {
    RpcError { code: -32603, message: "internal error".into(), data: Some(json!({ "detail": error.to_string() })) }
}

fn artifact_rpc_error(_error: impl std::fmt::Display) -> RpcError {
    RpcError { code: -32012, message: "artifact integrity failure".into(), data: None }
}

fn external_rpc_error(error: impl std::fmt::Display) -> RpcError {
    RpcError { code: -32050, message: "local service error".into(), data: Some(json!({ "detail": error.to_string() })) }
}

fn lifecycle_error(error: BackendError, cleanup_required: bool) -> RpcError {
    let mut error = backend_rpc_error(error);
    let mut data = error.data.take().and_then(|value| value.as_object().cloned()).unwrap_or_default();
    data.insert("cleanupRequired".into(), json!(cleanup_required));
    error.data = Some(Value::Object(data));
    error
}

fn protected_error(reason: &str) -> RpcError {
    RpcError::conflict("protected browser state", json!({ "reason": reason }))
}

fn invalid_backend_transfer() -> RpcError {
    RpcError { code: -32043, message: "invalid backend transfer handle".into(), data: None }
}

fn backend_rpc_error(error: BackendError) -> RpcError {
    match error {
        BackendError::Unsupported { capability, backend } => RpcError { code: -32040, message: format!("unsupported capability: {capability}"), data: Some(json!({ "capability": capability, "backend": backend })) },
        BackendError::HostUnavailable(id) => RpcError::not_found("browser host", &id),
        BackendError::TabUnavailable(id) => RpcError::not_found("tab", &id),
        BackendError::IncompatibleVersion { actual, range } => RpcError { code: -32041, message: "incompatible backend version".into(), data: Some(json!({ "actual": actual, "supported": range })) },
        BackendError::Command { message, structured } => RpcError { code: -32042, message, data: structured },
        other => RpcError { code: -32043, message: "browser backend error".into(), data: Some(json!({ "detail": other.to_string() })) },
    }
}

fn safe_artifact_record(record: &StoredArtifactRecord) -> Value {
    json!({
        "artifactId": record.artifact_id,
        "sha256": record.sha256,
        "ownerAgentId": record.owner_agent_id,
        "browserSessionId": record.browser_session_id,
        "tabId": record.tab_id,
        "mediaType": record.media_type,
        "size": record.size,
        "sourceUrl": record.source_url,
        "createdAt": record.created_at,
        "metadata": record.metadata,
    })
}

fn find_agent_id(value: &Value) -> Option<AgentId> {
    match value {
        Value::Object(object) => {
            for key in ["ownerAgentId", "agentId"] {
                if let Some(id) = object.get(key).and_then(Value::as_str) { return Some(AgentId(id.to_owned())); }
            }
            object.values().find_map(find_agent_id)
        }
        Value::Array(values) => values.iter().find_map(find_agent_id),
        _ => None,
    }
}

fn artifact_context(tab: &TabInfo, source_url: Option<String>, metadata: BTreeMap<String, Value>) -> ArtifactContext {
    ArtifactContext {
        owner_agent_id: Some(tab.owner_agent_id.clone()),
        browser_session_id: Some(tab.browser_session_id.clone()),
        tab_id: Some(tab.tab_id.clone()),
        source_url,
        metadata,
    }
}

fn action_supported(backend: BrowserBackend, action: &BrowserAction) -> bool {
    match backend {
        BrowserBackend::AgentBrowser => true,
        BrowserBackend::Pinchtab => matches!(action,
            BrowserAction::Navigate { .. } | BrowserAction::Click { .. } | BrowserAction::Fill { .. }
        ),
    }
}

fn action_kind(action: &BrowserAction) -> &'static str {
    match action {
        BrowserAction::Navigate { .. } => "navigate", BrowserAction::Click { .. } => "click",
        BrowserAction::Fill { .. } => "fill", BrowserAction::Type { .. } => "type",
        BrowserAction::Press { .. } => "press", BrowserAction::Select { .. } => "select",
        BrowserAction::Hover { .. } => "hover", BrowserAction::Scroll { .. } => "scroll",
        BrowserAction::Drag { .. } => "drag", BrowserAction::Upload { .. } => "upload",
        BrowserAction::Download { .. } => "download", BrowserAction::Back => "back",
        BrowserAction::Forward => "forward", BrowserAction::Reload => "reload",
        BrowserAction::Wait { .. } => "wait", BrowserAction::TabNew { .. } => "tab-new",
        BrowserAction::TabClose { .. } => "tab-close", BrowserAction::TabFocus { .. } => "tab-focus",
    }
}

fn path_id(backend: BrowserBackend) -> &'static str {
    match backend {
        BrowserBackend::AgentBrowser => BrowserPathId::AgentBrowserChrome.as_str(),
        BrowserBackend::Pinchtab => BrowserPathId::PinchtabChrome.as_str(),
    }
}

fn engine_name(engine: BrowserEngine) -> &'static str {
    match engine { BrowserEngine::Chromium => "chromium", BrowserEngine::Lightpanda => "lightpanda" }
}

fn expand_home(value: String) -> String {
    if value == "~" || value.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            let suffix = value.strip_prefix("~/").unwrap_or("");
            return PathBuf::from(home).join(suffix).to_string_lossy().into_owned();
        }
    }
    value
}

fn safe_name(name: &str) -> String {
    let value: String = name.chars().map(|character| if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') { character } else { '-' }).collect();
    let value = value.trim_matches('-').to_ascii_lowercase();
    if value.is_empty() { "profile".into() } else { value }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars { return value.to_owned(); }
    let mut output: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    output.push('…');
    output
}

#[cfg(test)]
fn guess_media_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp",
        "pdf" => "application/pdf", "json" => "application/json", "har" => "application/json",
        "webm" => "video/webm", "mp4" => "video/mp4",
        "md" => "text/markdown", "txt" | "log" => "text/plain", "html" => "text/html",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_coordinator() -> (Arc<Coordinator>, PathBuf) {
        let root = std::env::temp_dir().join(format!("pi-browserd-coordinator-test-{}", Uuid::new_v4()));
        let paths = XdgPaths {
            runtime: root.join("runtime"), config: root.join("config"),
            data: root.join("data"), cache: root.join("cache"),
        };
        (Coordinator::new(DaemonConfig::default(), paths).await.unwrap(), root)
    }

    fn request(id: u64, method: &str, params: Value) -> JsonRpcRequest {
        JsonRpcRequest { jsonrpc: "2.0".into(), id: json!(id), method: method.into(), params }
    }

    async fn register(coordinator: &Coordinator, connection: &ConnectionContext, agent: &str, client: &str) -> JsonRpcResponse {
        coordinator.dispatch_connected(connection, request(1, "agent.register", json!({
            "agentId": agent, "clientId": client, "cwd": "/private/cwd", "pid": 1,
            "mode": "rpc"
        }))).await
    }

    #[tokio::test]
    async fn three_principals_cannot_rebind_or_select_another_identity() {
        let (coordinator, root) = test_coordinator().await;
        let a = ConnectionContext::with_id("a-connection");
        let b = ConnectionContext::with_id("b-connection");
        let c = ConnectionContext::with_id("c-connection");
        assert!(register(&coordinator, &a, "a", "ca").await.error.is_none());
        assert!(register(&coordinator, &b, "b", "cb").await.error.is_none());
        assert!(register(&coordinator, &c, "c", "cc").await.error.is_none());

        let rebind = register(&coordinator, &a, "b", "cb").await.error.unwrap();
        assert_eq!(rebind.code, -32003);
        let duplicate = register(&coordinator, &ConnectionContext::with_id("other"), "a", "new-client").await.error.unwrap();
        assert_eq!(duplicate.code, -32009);
        let impersonation = coordinator.dispatch_connected(&a, request(2, "browser.list", json!({ "agentId": "b" }))).await.error.unwrap();
        assert_eq!(impersonation.code, -32003);

        let listed = coordinator.dispatch_connected(&a, request(3, "agent.list", json!({}))).await.result.unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["agentId"], "a");
        assert!(listed.to_string().find("private/cwd").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn profiles_and_artifacts_are_owner_scoped() {
        let (coordinator, root) = test_coordinator().await;
        let a = ConnectionContext::with_id("a-connection");
        let b = ConnectionContext::with_id("b-connection");
        register(&coordinator, &a, "a", "ca").await;
        register(&coordinator, &b, "b", "cb").await;
        let created = coordinator.dispatch_connected(&a, request(2, "profile.create", json!({ "name": "private" }))).await.result.unwrap();
        let profile_id = created["profileId"].clone();
        let b_list = coordinator.dispatch_connected(&b, request(3, "profile.list", json!({}))).await.result.unwrap();
        assert_eq!(b_list, json!([]));
        let b_update = coordinator.dispatch_connected(&b, request(4, "profile.update", json!({ "profileId": profile_id, "name": "stolen" }))).await.error.unwrap();
        assert_eq!(b_update.code, -32004);

        let artifact = coordinator.artifacts.put_bytes("text/plain", b"owned", ArtifactContext {
            owner_agent_id: Some(AgentId("a".into())), ..Default::default()
        }).unwrap();
        let b_get = coordinator.dispatch_connected(&b, request(5, "artifact.get", json!({ "artifactId": artifact.artifact_id }))).await.error.unwrap();
        assert_eq!(b_get.code, -32004);
        let a_get = coordinator.dispatch_connected(&a, request(6, "artifact.get", json!({ "artifactId": artifact.artifact_id }))).await.result.unwrap();
        assert_eq!(a_get["text"], "owned");
        assert!(a_get.to_string().find("/artifacts/").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancelled_human_control_waiter_does_not_resume() {
        let gate = Arc::new(ControlGate::new(TabControl::Human));
        let registry = OperationRegistry::default();
        let owner = AgentId("a".into());
        let operation = registry.begin(Some("waiter".into()), owner.clone(), "act").unwrap();
        let waiting_gate = Arc::clone(&gate);
        let waiting_operation = operation.clone();
        let waiter = tokio::spawn(async move { waiting_gate.wait_for_agent_or_cancel(&waiting_operation).await });
        tokio::task::yield_now().await;
        registry.cancel(&owner, "waiter").unwrap();
        let error = waiter.await.unwrap().unwrap_err();
        operation.cancelled();
        assert_eq!(error.code, -32010);
        gate.set(TabControl::Agent);
        assert_eq!(operation.record().state, crate::operation::OperationState::Cancelled);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn snapshot_is_private_and_corruption_is_quarantined() {
        use std::os::unix::fs::PermissionsExt as _;
        let (coordinator, root) = test_coordinator().await;
        coordinator.save_snapshot().await;
        let path = coordinator.paths.registry_snapshot_path();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::write(&path, b"{truncated").unwrap();
        coordinator.restore_snapshot().await.unwrap();
        assert!(!path.exists());
        assert!(std::fs::read_dir(path.parent().unwrap()).unwrap().flatten().any(|entry| {
            entry.file_name().to_string_lossy().starts_with("registry.corrupt-")
        }));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn scoped_events_do_not_cross_principals() {
        let principal_a = Principal { authenticated: AuthenticatedPrincipal { principal_id: PrincipalId("pa".into()), authentication_id: "test-a".into() }, agent_id: AgentId("a".into()), client_id: ClientId("ca".into()) };
        let principal_b = Principal { authenticated: AuthenticatedPrincipal { principal_id: PrincipalId("pb".into()), authentication_id: "test-b".into() }, agent_id: AgentId("b".into()), client_id: ClientId("cb".into()) };
        let event = ScopedEvent {
            owner_agent_id: Some(AgentId("a".into())),
            notification: RpcNotification { jsonrpc: "2.0".into(), method: "tab.changed".into(), params: json!({ "agentId": "a", "url": "private" }) },
        };
        assert!(Coordinator::event_visible_to(&event, &principal_a));
        assert!(!Coordinator::event_visible_to(&event, &principal_b));
    }

    #[tokio::test]
    async fn workspace_transport_uses_daemon_selected_principal_and_scoped_control_cas() {
        let (coordinator, root) = test_coordinator().await;
        let agent = ConnectionContext::with_id("agent-connection");
        register(&coordinator, &agent, "agent-a", "client-a").await;
        let principal = agent.principal().await.unwrap();
        {
            let mut workspace = coordinator.workspace.lock().await;
            workspace.visible = true;
            workspace.focused_principal = Some(principal.clone());
            workspace.focused_agent_id = Some(principal.agent_id.clone());
            workspace.scope_id = Some("scope-a".into());
            workspace.viewport_generation = 4;
        }

        let workspace_connection = ConnectionContext::with_id("workspace-transport");
        coordinator.bind_workspace_connection(&workspace_connection).await.unwrap();
        assert_eq!(workspace_connection.principal().await.unwrap().agent_id, principal.agent_id);
        let opened = coordinator.dispatch_connected(&workspace_connection, request(2, "workspace.openScoped", json!({}))).await.result.unwrap();
        assert_eq!(opened["scopeId"], "scope-a");
        assert!(opened.to_string().find("client-a").is_none());

        let tab_id = TabId("tab-a".into());
        coordinator.controls.insert(tab_id.clone(), Arc::new(ControlGate::with_epoch(TabControl::Agent, 7)));
        coordinator.workspace_leases.insert("lease-a".into(), WorkspaceViewportLease {
            lease_id: "lease-a".into(), scope_id: "scope-a".into(), owner_agent_id: principal.agent_id.clone(),
            browser_session_id: BrowserSessionId("session-a".into()), tab_id: tab_id.clone(),
            viewport_id: "viewport-a".into(), viewport_generation: 4,
            expires_at: Utc::now() + Duration::seconds(30), last_input_sequence: 0, current_binding: None,
        });
        let stale = coordinator.workspace_compare_set_control(&principal, WorkspaceControlParams {
            scope_id: "scope-a".into(), lease_id: "lease-a".into(), viewport_id: "viewport-a".into(),
            viewport_generation: 4, control: TabControl::Human, expected_control_epoch: 6,
        }).await.unwrap_err();
        assert_eq!(stale.code, -32009);
        let changed = coordinator.workspace_compare_set_control(&principal, WorkspaceControlParams {
            scope_id: "scope-a".into(), lease_id: "lease-a".into(), viewport_id: "viewport-a".into(),
            viewport_generation: 4, control: TabControl::Human, expected_control_epoch: 7,
        }).await.unwrap();
        assert_eq!(changed["controlEpoch"], 8);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn visual_observation_accepts_only_owned_typed_screenshot_transfer() {
        let (coordinator, root) = test_coordinator().await;
        let host_id = HostId("visual-host".into());
        let owner = AgentId("visual-owner".into());
        let session_id = BrowserSessionId("visual-session".into());
        let tab = TabInfo {
            tab_id: TabId("visual-tab".into()),
            host_id: host_id.clone(),
            browser_session_id: session_id,
            owner_agent_id: owner.clone(),
            title: "public fixture".into(),
            url: "http://127.0.0.1/public".into(),
            index: 0,
            control: TabControl::Agent,
            state: TabState::Idle,
            last_action_at: None,
        };
        let transfer_root = coordinator.paths.data.join("downloads").join("hosts").join(host_id.as_ref());
        std::fs::create_dir_all(&transfer_root).unwrap();
        std::fs::write(transfer_root.join("shot.png"), b"typed-owned-screenshot").unwrap();
        let observation = || Observation {
            view: ObservationView::Visual,
            title: "public fixture".into(),
            url: tab.url.clone(),
            content: String::new(),
            controls: Vec::new(),
            changed: Vec::new(),
            artifact_id: None,
            truncated: false,
            metadata: BTreeMap::new(),
        };

        let mut safe = observation();
        safe.metadata.insert("transfer".into(), json!({
            "hostId": host_id, "relativePath": "shot.png", "mediaType": "image/png", "kind": "screenshot"
        }));
        coordinator.ingest_observation_artifacts(&tab, &mut safe, 4096).unwrap();
        let artifact_id = safe.artifact_id.unwrap();
        assert_eq!(coordinator.artifacts.get(&owner, &artifact_id).unwrap().unwrap().media_type, "image/png");

        let mut raw_path = observation();
        raw_path.metadata.insert("screenshotPath".into(), json!("/etc/passwd"));
        assert_eq!(coordinator.ingest_observation_artifacts(&tab, &mut raw_path, 4096).unwrap_err().code, -32043);
        for (wrong_host, path) in [("other-host", "shot.png"), ("visual-host", "../shot.png"), ("visual-host", "/etc/passwd")] {
            let mut bad = observation();
            bad.metadata.insert("transfer".into(), json!({
                "hostId": wrong_host, "relativePath": path, "mediaType": "image/png", "kind": "screenshot"
            }));
            assert_eq!(coordinator.ingest_observation_artifacts(&tab, &mut bad, 4096).unwrap_err().code, -32043);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[ignore = "requires installed PinchTab 0.15.1 and Chromium"]
    async fn real_pinchtab_session_create_navigate_observe_and_close() {
        use tokio::io::AsyncWriteExt as _;
        use tokio::net::TcpListener as TokioTcpListener;

        let listener = TokioTcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let fixture_url = format!("http://{}/start", listener.local_addr().unwrap());
        let fixture = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break; };
                tokio::spawn(async move {
                    let body = "<!doctype html><title>Browserd PinchTab Fixture</title><main>public deterministic pinchtab fixture</main>";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });

        let (coordinator, root) = test_coordinator().await;
        let connection = ConnectionContext::with_id("pinchtab-real-connection");
        assert!(register(&coordinator, &connection, "pinchtab-real", "pinchtab-real-client").await.error.is_none());
        let created = coordinator.dispatch_connected(&connection, request(2, "session.create", json!({
            "agentId": "pinchtab-real", "pathId": "pinchtab/chrome", "url": fixture_url,
            "visible": false, "label": "public fixture"
        }))).await.result.unwrap();
        assert_eq!(created["pathId"], "pinchtab/chrome");
        let session_id = created["browserSession"]["browserSessionId"].as_str().unwrap().to_owned();
        let tab_id = created["tab"]["tabId"].as_str().unwrap().to_owned();

        let navigated = coordinator.dispatch_connected(&connection, request(3, "browser.navigate", json!({
            "agentId": "pinchtab-real", "browserSessionId": session_id, "tabId": tab_id,
            "url": fixture_url, "operationId": "pinchtab-real-navigate"
        }))).await;
        assert!(navigated.error.is_none(), "navigate failed: {:?}", navigated.error);
        let observed = coordinator.dispatch_connected(&connection, request(4, "browser.observe", json!({
            "agentId": "pinchtab-real", "browserSessionId": session_id, "tabId": tab_id,
            "view": "main", "maxChars": 4096, "operationId": "pinchtab-real-observe"
        }))).await.result.unwrap();
        assert!(observed["content"].as_str().unwrap().contains("public deterministic pinchtab fixture"));
        let closed = coordinator.dispatch_connected(&connection, request(5, "session.close", json!({
            "agentId": "pinchtab-real", "browserSessionId": session_id
        }))).await;
        assert!(closed.error.is_none(), "close failed: {:?}", closed.error);

        fixture.abort();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn workspace_show_focus_hide_releases_selected_viewport_for_close() {
        let (coordinator, root) = test_coordinator().await;
        let connection = ConnectionContext::with_id("workspace-hide-owner");
        assert!(register(&coordinator, &connection, "workspace-hide-owner", "workspace-hide-client").await.error.is_none());
        let principal = connection.principal().await.unwrap();
        let session_id = BrowserSessionId("workspace-hide-session".into());
        let tab_id = TabId("workspace-hide-tab".into());
        coordinator.tabs.insert(tab_id.clone(), TabInfo {
            tab_id: tab_id.clone(), host_id: HostId("workspace-hide-host".into()),
            browser_session_id: session_id.clone(), owner_agent_id: principal.agent_id.clone(),
            title: "public fixture".into(), url: "http://127.0.0.1/public".into(), index: 0,
            control: TabControl::Agent, state: TabState::Idle, last_action_at: None,
        });
        coordinator.controls.insert(tab_id.clone(), Arc::new(ControlGate::new(TabControl::Agent)));
        coordinator.workspace_show(&principal, WorkspaceFocusParams {
            agent_id: principal.agent_id.clone(), browser_session_id: Some(session_id.clone()), tab_id: Some(tab_id.clone()),
        }).await.unwrap();
        let scope_id = coordinator.workspace.lock().await.scope_id.clone().unwrap();
        coordinator.workspace_leases.insert("workspace-hide-lease".into(), WorkspaceViewportLease {
            lease_id: "workspace-hide-lease".into(), scope_id: scope_id.clone(), owner_agent_id: principal.agent_id.clone(),
            browser_session_id: session_id, tab_id: tab_id.clone(), viewport_id: "workspace-hide-viewport".into(),
            viewport_generation: 1, expires_at: Utc::now() + Duration::seconds(30), last_input_sequence: 0,
            current_binding: None,
        });

        coordinator.tabs.get_mut(&tab_id).unwrap().control = TabControl::Human;
        let protected = coordinator.workspace_hide(&principal).await.unwrap_err();
        assert_eq!(protected.code, -32009);
        assert_eq!(protected.data.unwrap()["reason"], "human_control");
        assert_eq!(coordinator.workspace.lock().await.focused_tab_id.as_ref(), Some(&tab_id));

        coordinator.tabs.get_mut(&tab_id).unwrap().control = TabControl::Agent;
        coordinator.controls.get(&tab_id).unwrap().set(TabControl::Agent);
        let hidden = coordinator.workspace_hide(&principal).await.unwrap();
        assert_eq!(hidden["visible"], false);
        let workspace = coordinator.workspace.lock().await;
        assert!(!workspace.visible);
        assert!(workspace.focused_principal.is_none());
        assert!(workspace.focused_agent_id.is_none());
        assert!(workspace.focused_tab_id.is_none());
        assert!(workspace.scope_id.is_none());
        drop(workspace);
        assert!(coordinator.workspace_leases.is_empty());
        assert!(coordinator.workspace_lease(&principal, &scope_id, "workspace-hide-lease").is_err());
        let selected_viewport_blocks_close = coordinator.workspace.lock().await.focused_tab_id.as_ref() == Some(&tab_id);
        assert!(!selected_viewport_blocks_close);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn workspace_hide_refuses_cross_owner_without_changing_focus() {
        let (coordinator, root) = test_coordinator().await;
        let owner_connection = ConnectionContext::with_id("workspace-owner");
        let other_connection = ConnectionContext::with_id("workspace-other");
        register(&coordinator, &owner_connection, "workspace-owner", "workspace-owner-client").await;
        register(&coordinator, &other_connection, "workspace-other", "workspace-other-client").await;
        let owner = owner_connection.principal().await.unwrap();
        let other = other_connection.principal().await.unwrap();
        let tab_id = TabId("workspace-owner-tab".into());
        {
            let mut workspace = coordinator.workspace.lock().await;
            workspace.visible = true;
            workspace.focused_principal = Some(owner.clone());
            workspace.focused_agent_id = Some(owner.agent_id.clone());
            workspace.focused_tab_id = Some(tab_id.clone());
            workspace.scope_id = Some("workspace-owner-scope".into());
            workspace.viewport_generation = 4;
        }
        let refused = coordinator.workspace_hide(&other).await.unwrap_err();
        assert_eq!(refused.code, -32003);
        let workspace = coordinator.workspace.lock().await;
        assert!(workspace.visible);
        assert_eq!(workspace.focused_agent_id.as_ref(), Some(&owner.agent_id));
        assert_eq!(workspace.focused_tab_id.as_ref(), Some(&tab_id));
        assert_eq!(workspace.scope_id.as_deref(), Some("workspace-owner-scope"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn debug_output_media_types_include_video_recordings() {
        assert_eq!(guess_media_type(std::path::Path::new("capture.webm")), "video/webm");
        assert_eq!(guess_media_type(std::path::Path::new("page.pdf")), "application/pdf");
    }
}
