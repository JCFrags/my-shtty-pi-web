use async_trait::async_trait;
use pi_web_protocol::{
    ActionOutcomeV2, ActionResult, BrowserAction, BrowserActionV2, BrowserAddress,
    BrowserCapabilities, BrowserHostHandle, BrowserPathId, BrowserSessionId, CancellationResult,
    DurableOperation, ObservationView, OperationId, OwnerIdentity, PathIdentity,
    ProtocolAddress, ProtocolObservation, StartHostRequest, StreamInfo, StructuredError, TabId,
    TabInfo, TransferHandle, ViewportBinding, DebugRequest, DebugResult, ObserveRequest, Observation,
};

pub type Result<T> = std::result::Result<T, BackendError>;

#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("unsupported capability {capability} on backend {backend}")]
    Unsupported { capability: String, backend: String },
    #[error("browser host is unavailable: {0}")]
    HostUnavailable(String),
    #[error("browser tab is unavailable: {0}")]
    TabUnavailable(String),
    #[error("backend protocol error: {0}")]
    Protocol(String),
    #[error("backend command failed: {message}")]
    Command { message: String, structured: Option<serde_json::Value> },
    #[error("backend version {actual} is outside supported range {range}")]
    IncompatibleVersion { actual: String, range: String },
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

#[async_trait]
/// Source-compatibility interface for the protocol 1 candidate.
/// New backends must implement `BrowserControllerV2` below.
pub trait BrowserController: Send + Sync {
    async fn capabilities(&self) -> Result<BrowserCapabilities>;
    async fn start_host(&self, request: StartHostRequest) -> Result<BrowserHostHandle>;
    async fn stop_host(&self, host: &BrowserHostHandle) -> Result<()>;
    async fn list_tabs(&self, host: &BrowserHostHandle) -> Result<Vec<TabInfo>>;
    async fn open_tab(&self, host: &BrowserHostHandle, url: Option<&str>) -> Result<TabInfo>;
    async fn close_tab(&self, host: &BrowserHostHandle, tab_id: &str) -> Result<()>;
    async fn focus_tab(&self, host: &BrowserHostHandle, tab_id: &str) -> Result<()>;
    async fn navigate(&self, address: &BrowserAddress, url: &str) -> Result<ActionResult>;
    async fn observe(&self, address: &BrowserAddress, request: ObserveRequest) -> Result<Observation>;
    async fn act(&self, address: &BrowserAddress, action: BrowserAction) -> Result<ActionResult>;
    async fn debug(&self, address: &BrowserAddress, request: DebugRequest) -> Result<DebugResult>;
    async fn stream_info(&self, address: &BrowserAddress) -> Result<StreamInfo>;
}

#[derive(Clone, Debug)]
pub struct CreateSessionRequest {
    pub owner: OwnerIdentity,
    pub path_id: BrowserPathId,
    pub profile_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct BackendSessionHandle {
    pub owner: OwnerIdentity,
    pub session_id: BrowserSessionId,
    pub path: PathIdentity,
    /// Opaque backend identity. It must never replace protocol ownership.
    pub backend_session_id: String,
}

impl BackendSessionHandle {
    /// PinchTab can silently select a different provider. Validate every reply.
    pub fn verify_returned_identity(&self, returned: &PathIdentity) -> std::result::Result<(), StructuredError> {
        if self.path.path_id != returned.path_id || self.path.provider != returned.provider
            || self.path.host_id != returned.host_id
            || self.path.host_generation != returned.host_generation
            || self.path.engine_generation != returned.engine_generation
        {
            return Err(StructuredError::new(
                pi_web_protocol::ErrorCode::WrongPath,
                "backend returned a different path or provider identity",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct BackendTabHandle {
    pub owner: OwnerIdentity,
    pub session_id: BrowserSessionId,
    pub tab_id: TabId,
    pub path: PathIdentity,
    pub backend_tab_id: String,
    pub viewport: Option<ViewportBinding>,
    pub control_epoch: u64,
}

#[derive(Clone, Debug)]
pub struct BackendOperationRequest<T> {
    pub operation_id: OperationId,
    pub address: ProtocolAddress,
    pub input: T,
}

/// Strict protocol 2 backend seam.
///
/// The coordinator validates the authenticated principal and ownership before
/// this interface is called. The backend still receives the immutable path and
/// generation values and must verify returned provider identity. Cancellation
/// must reach the backend process. Dropping a future is not cancellation.
#[async_trait]
pub trait BrowserControllerV2: Send + Sync {
    async fn create_session(&self, request: CreateSessionRequest) -> Result<BackendSessionHandle>;
    async fn close_session(&self, session: &BackendSessionHandle) -> Result<()>;
    async fn create_tab(&self, session: &BackendSessionHandle, url: Option<&str>) -> Result<BackendTabHandle>;
    async fn close_tab_v2(&self, tab: &BackendTabHandle) -> Result<()>;
    async fn observe_v2(
        &self,
        tab: &BackendTabHandle,
        request: BackendOperationRequest<ObservationView>,
    ) -> Result<ProtocolObservation>;
    async fn act_v2(
        &self,
        tab: &BackendTabHandle,
        request: BackendOperationRequest<BrowserActionV2>,
    ) -> Result<ActionOutcomeV2>;
    async fn operation(&self, operation_id: &OperationId) -> Result<DurableOperation>;
    async fn cancel_operation(&self, operation_id: &OperationId) -> Result<CancellationResult>;
    async fn stage_upload(&self, handle: TransferHandle) -> Result<TransferHandle>;
    async fn cleanup_session(&self, session: &BackendSessionHandle) -> Result<()>;
}
