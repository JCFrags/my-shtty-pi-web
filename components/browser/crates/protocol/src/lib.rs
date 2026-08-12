//! Versioned, backend-neutral protocol types for Pi Web Workspace.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use ulid::Ulid;
use url::Url;

pub const PROTOCOL_VERSION: &str = "2.0.0";
pub const PROTOCOL_MAJOR: u64 = 2;
pub const SUPPORTED_PATH_IDS: &[&str] = &["agent-browser/chrome", "pinchtab/chrome"];

/// Canonical method/event names mirrored from `schema/protocol.schema.json`.
/// Conformance tests compare these with the TypeScript representation so the
/// daemon and extension cannot drift while retaining JSON as the wire format.
pub const RPC_METHODS: &[&str] = &[
    "system.capabilities",
    "session.create", "session.list", "session.close",
    "tab.create", "tab.list", "tab.close",
    "browser.observe", "browser.act",
    "operation.get", "operation.cancel",
    "artifact.list", "artifact.get", "artifact.delete",
    "transfer.stageUpload", "transfer.commitUpload",
    "control.takeover", "control.return",
    "lifecycle.cleanup", "lifecycle.recover",
];

pub const RPC_EVENTS: &[&str] = &[
    "session.changed", "tab.changed", "operation.changed", "artifact.created",
    "control.changed", "lifecycle.changed",
];

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize, JsonSchema)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn new() -> Self {
                Self(Ulid::new().to_string())
            }

            pub fn parse(value: impl Into<String>) -> Result<Self, ProtocolError> {
                let value = value.into();
                if value.trim().is_empty() {
                    Err(ProtocolError::InvalidId(stringify!($name)))
                } else {
                    Ok(Self(value))
                }
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
    };
}

id_type!(AgentId);
id_type!(ClientId);
id_type!(ProfileId);
id_type!(HostId);
id_type!(BrowserSessionId);
id_type!(TabId);
id_type!(ArtifactId);

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("invalid empty {0}")]
    InvalidId(&'static str),
    #[error("protocol version {actual} is incompatible with major version {expected_major}")]
    IncompatibleVersion { actual: String, expected_major: u64 },
}

pub fn ensure_compatible_version(version: &str) -> Result<(), ProtocolError> {
    let major = version.split('.').next().and_then(|part| part.parse::<u64>().ok());
    if major == Some(PROTOCOL_MAJOR) {
        Ok(())
    } else {
        Err(ProtocolError::IncompatibleVersion {
            actual: version.to_owned(),
            expected_major: PROTOCOL_MAJOR,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PiMode {
    Tui,
    Rpc,
    Json,
    Print,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentRegistration {
    pub agent_id: AgentId,
    pub client_id: ClientId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pi_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pi_session_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pi_session_name: Option<String>,
    pub cwd: String,
    pub pid: u32,
    pub mode: PiMode,
    pub started_at: DateTime<Utc>,
    pub last_heartbeat_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserBackend {
    AgentBrowser,
    Rustwright,
    Pinchtab,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BrowserEngine {
    Lightpanda,
    Chromium,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    pub profile_id: ProfileId,
    pub name: String,
    pub engine: ChromiumOnly,
    pub data_dir: String,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub launch_args: Vec<String>,
    #[serde(default)]
    pub visible_by_default: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ChromiumOnly {
    #[default]
    Chromium,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum HostState {
    Starting,
    Ready,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHost {
    pub host_id: HostId,
    pub backend: BrowserBackend,
    pub engine: BrowserEngine,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<ProfileId>,
    pub state: HostState,
    pub backend_session_id: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSession {
    pub browser_session_id: BrowserSessionId,
    pub owner_agent_id: AgentId,
    pub host_id: HostId,
    pub label: String,
    pub created_at: DateTime<Utc>,
    pub last_activity_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TabControl {
    Agent,
    Human,
    Shared,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TabState {
    Idle,
    Running,
    Waiting,
    Crashed,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub tab_id: TabId,
    pub host_id: HostId,
    pub browser_session_id: BrowserSessionId,
    pub owner_agent_id: AgentId,
    pub title: String,
    pub url: String,
    pub index: usize,
    pub control: TabControl,
    pub state: TabState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_action_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub artifact_id: ArtifactId,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_agent_id: Option<AgentId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_session_id: Option<BrowserSessionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<TabId>,
    pub media_type: String,
    pub size: u64,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAddress {
    pub agent_id: AgentId,
    pub browser_session_id: BrowserSessionId,
    pub tab_id: TabId,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartHostRequest {
    pub engine: BrowserEngine,
    #[serde(default = "default_backend")]
    pub backend: BrowserBackend,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<BrowserProfile>,
    #[serde(default)]
    pub visible: bool,
    #[serde(default)]
    pub launch_args: Vec<String>,
}

fn default_backend() -> BrowserBackend {
    BrowserBackend::AgentBrowser
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHostHandle {
    pub host: BrowserHost,
    #[serde(default)]
    pub backend_metadata: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ObservationView {
    Main,
    Interactive,
    Visual,
    Full,
    Diff,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ObserveRequest {
    #[serde(default = "default_observation_view")]
    pub view: ObservationView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default = "default_max_chars")]
    pub max_chars: usize,
    #[serde(default)]
    pub include_bounds: bool,
}

fn default_observation_view() -> ObservationView {
    ObservationView::Main
}

fn default_max_chars() -> usize {
    16_000
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveControl {
    pub r#ref: String,
    pub role: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub view: ObservationView,
    pub title: String,
    pub url: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub controls: Vec<InteractiveControl>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<ArtifactId>,
    pub truncated: bool,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum BrowserAction {
    Navigate { url: Url },
    Click { r#ref: Option<String>, selector: Option<String> },
    Fill { r#ref: Option<String>, selector: Option<String>, text: String },
    Type { r#ref: Option<String>, selector: Option<String>, text: String },
    Press { key: String },
    Select { r#ref: Option<String>, selector: Option<String>, values: Vec<String> },
    Hover { r#ref: Option<String>, selector: Option<String> },
    Scroll { direction: ScrollDirection, amount: Option<f64> },
    Drag { r#ref: String, target_ref: String },
    Upload { r#ref: Option<String>, selector: Option<String>, files: Vec<String> },
    Download { r#ref: Option<String>, selector: Option<String> },
    Back,
    Forward,
    Reload,
    Wait { milliseconds: Option<u64>, selector: Option<String>, text: Option<String> },
    TabNew { url: Option<Url> },
    TabClose { tab_id: Option<TabId> },
    TabFocus { tab_id: TabId },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub changed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_tab_id: Option<TabId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_artifact_id: Option<ArtifactId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<ArtifactId>,
    #[serde(default)]
    pub backend: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapabilities {
    pub backend: BrowserBackend,
    pub engines: Vec<BrowserEngine>,
    pub actions: Vec<String>,
    pub debug: Vec<String>,
    pub persistent_profiles: bool,
    pub extensions: bool,
    pub viewport_streaming: bool,
    pub direct_tab_addressing: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DebugRequest {
    pub operation: DebugOperation,
    #[serde(default)]
    pub args: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DebugOperation {
    Evaluate,
    Console,
    Network,
    Html,
    Cookies,
    Storage,
    Pdf,
    RecordStart,
    RecordStop,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DebugResult {
    pub ok: bool,
    pub operation: DebugOperation,
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<ArtifactId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub protocol: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl JsonRpcResponse {
    pub fn success(id: Value, result: impl Serialize) -> Self {
        Self {
            jsonrpc: "2.0".to_owned(),
            id,
            result: serde_json::to_value(result).ok(),
            error: None,
        }
    }

    pub fn failure(id: Value, error: RpcError) -> Self {
        Self { jsonrpc: "2.0".to_owned(), id, result: None, error: Some(error) }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self { code: -32602, message: message.into(), data: None }
    }

    pub fn not_found(kind: &str, id: &str) -> Self {
        Self {
            code: -32004,
            message: format!("{kind} not found"),
            data: Some(serde_json::json!({ "kind": kind, "id": id })),
        }
    }

    pub fn unsupported(capability: &str, backend: BrowserBackend) -> Self {
        Self {
            code: -32040,
            message: format!("unsupported capability: {capability}"),
            data: Some(serde_json::json!({ "capability": capability, "backend": backend })),
        }
    }

    pub fn conflict(message: impl Into<String>, data: Value) -> Self {
        Self { code: -32009, message: message.into(), data: Some(data) }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

// Protocol 2 browser types. Older coordinator types above remain as a temporary
// source-compatibility seam. New browser code must use these strict types.
id_type!(PrincipalId);
id_type!(OperationId);
id_type!(ObservationId);
id_type!(ViewportId);
id_type!(TransferId);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
pub enum BrowserPathId {
    #[serde(rename = "agent-browser/chrome")]
    AgentBrowserChrome,
    #[serde(rename = "pinchtab/chrome")]
    PinchtabChrome,
}

impl BrowserPathId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AgentBrowserChrome => "agent-browser/chrome",
            Self::PinchtabChrome => "pinchtab/chrome",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedPrincipal {
    pub principal_id: PrincipalId,
    pub authentication_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OwnerIdentity {
    pub principal_id: PrincipalId,
    pub agent_id: AgentId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PathIdentity {
    pub path_id: BrowserPathId,
    pub backend_version: String,
    pub provider: ChromeProvider,
    pub host_id: HostId,
    pub host_generation: u64,
    pub engine_generation: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ChromeProvider {
    #[default]
    Chrome,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolAddress {
    pub agent_id: AgentId,
    pub session_id: BrowserSessionId,
    pub tab_id: TabId,
    pub path_id: BrowserPathId,
    pub host_generation: u64,
    pub engine_generation: u64,
    pub control_epoch: u64,
}

impl ProtocolAddress {
    pub fn validate(&self) -> Result<(), StructuredError> {
        if self.agent_id.as_ref().is_empty()
            || self.session_id.as_ref().is_empty()
            || self.tab_id.as_ref().is_empty()
            || self.host_generation == 0
            || self.engine_generation == 0
            || self.control_epoch == 0
        {
            return Err(StructuredError::new(ErrorCode::InvalidRequest, "invalid browser address"));
        }
        Ok(())
    }

    pub fn validate_binding(
        &self,
        principal: &AuthenticatedPrincipal,
        owner: &OwnerIdentity,
        path: &PathIdentity,
        current_control_epoch: u64,
    ) -> Result<(), StructuredError> {
        self.validate()?;
        if principal.principal_id != owner.principal_id || self.agent_id != owner.agent_id {
            return Err(StructuredError::new(ErrorCode::WrongOwner, "browser state has a different owner"));
        }
        if self.path_id != path.path_id {
            return Err(StructuredError::new(ErrorCode::WrongPath, "session path is immutable"));
        }
        if self.host_generation != path.host_generation || self.engine_generation != path.engine_generation {
            return Err(StructuredError::new(ErrorCode::StaleGeneration, "host or engine generation is stale"));
        }
        if self.control_epoch != current_control_epoch {
            return Err(StructuredError::new(ErrorCode::StaleControlEpoch, "control epoch is stale"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ActionKindV2 {
    Navigate, MouseMove, MouseDown, MouseUp, Click, DoubleClick, Wheel, Drag,
    KeyPress, KeyDown, KeyUp, TextInput, Fill, Select, Upload, Download,
    Back, Forward, Reload, Wait,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityTruth {
    pub path_id: BrowserPathId,
    pub actions: Vec<ActionKindV2>,
    pub observations: Vec<ObservationView>,
    pub touch: bool,
    pub uploads: bool,
    pub downloads: bool,
    pub visual: bool,
}

impl CapabilityTruth {
    pub fn validate(&self) -> Result<(), StructuredError> {
        if self.touch {
            return Err(StructuredError::new(ErrorCode::Unsupported, "touch is not proven on a supported path"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ViewportBinding {
    pub viewport_id: ViewportId,
    pub generation: u64,
    pub css_width: u32,
    pub css_height: u32,
    pub device_scale_factor: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub coordinate_space: CoordinateSpace,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CoordinateSpace {
    #[default]
    CssViewportTopLeft,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotBinding {
    pub artifact_id: ArtifactId,
    pub sha256: String,
    pub sequence: u64,
    pub captured_at: DateTime<Utc>,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub viewport: ViewportBinding,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VisualGuard {
    pub viewport_id: ViewportId,
    pub viewport_generation: u64,
    pub screenshot_sha256: String,
    pub screenshot_sequence: u64,
}

impl VisualGuard {
    pub fn validate_current(&self, screenshot: &ScreenshotBinding) -> Result<(), StructuredError> {
        if self.viewport_id != screenshot.viewport.viewport_id
            || self.viewport_generation != screenshot.viewport.generation
            || self.screenshot_sha256 != screenshot.sha256
            || self.screenshot_sequence != screenshot.sequence
        {
            return Err(StructuredError::new(ErrorCode::StaleVisual, "visual input is not bound to the current screenshot"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CssPoint {
    pub x: f64,
    pub y: f64,
}

impl CssPoint {
    pub fn validate_in(&self, viewport: &ViewportBinding) -> Result<(), StructuredError> {
        if !self.x.is_finite() || !self.y.is_finite() || self.x < 0.0 || self.y < 0.0
            || self.x >= f64::from(viewport.css_width) || self.y >= f64::from(viewport.css_height)
        {
            return Err(StructuredError::new(ErrorCode::InvalidRequest, "CSS point is outside the viewport"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    #[default]
    Left,
    Middle,
    Right,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum BrowserActionV2 {
    Navigate { url: Url },
    MouseMove { point: CssPoint, visual_guard: VisualGuard },
    MouseDown { point: CssPoint, button: MouseButton, visual_guard: VisualGuard },
    MouseUp { point: CssPoint, button: MouseButton, visual_guard: VisualGuard },
    Click { point: CssPoint, button: MouseButton, visual_guard: VisualGuard },
    DoubleClick { point: CssPoint, button: MouseButton, visual_guard: VisualGuard },
    Wheel { delta_x: f64, delta_y: f64, visual_guard: VisualGuard },
    Drag { from: CssPoint, to: CssPoint, visual_guard: VisualGuard },
    KeyPress { key: String },
    KeyDown { key: String },
    KeyUp { key: String },
    TextInput { text: String },
    Fill { r#ref: Option<String>, text: String },
    Select { r#ref: String, values: Vec<String> },
    Upload { r#ref: String, upload_handle_ids: Vec<TransferId> },
    Download { r#ref: String },
    Back,
    Forward,
    Reload,
    Wait { milliseconds: u64 },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolObservation {
    pub observation_id: ObservationId,
    pub operation_id: OperationId,
    pub owner: OwnerIdentity,
    pub address: ProtocolAddress,
    pub path: PathIdentity,
    pub view: ObservationView,
    pub sequence: u64,
    pub observed_at: DateTime<Utc>,
    pub title: String,
    pub url: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub controls: Vec<InteractiveControl>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<ScreenshotBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_artifact_id: Option<ArtifactId>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PostActionEvidence {
    pub observation_id: ObservationId,
    pub sequence: u64,
    pub summary: String,
    pub changed: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActionOutcomeV2 {
    pub operation_id: OperationId,
    pub owner: OwnerIdentity,
    pub address: ProtocolAddress,
    pub path: PathIdentity,
    pub dispatched: bool,
    pub evidence: PostActionEvidence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_artifact_id: Option<ArtifactId>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum OperationState {
    Queued, Running, Cancelling, Succeeded, Failed, Cancelled,
}

impl OperationState {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DurableOperation {
    pub operation_id: OperationId,
    pub owner: OwnerIdentity,
    pub address: ProtocolAddress,
    pub path: PathIdentity,
    pub kind: String,
    pub state: OperationState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub cancellation_requested: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<StructuredError>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CancellationOutcome {
    Cancelled, AlreadyTerminal, NotCancellable,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CancellationResult {
    pub operation_id: OperationId,
    pub outcome: CancellationOutcome,
    pub state: OperationState,
    pub completed_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactKindV2 {
    Screenshot, FullObservation, Download, Upload, Pdf, Diagnostic,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OwnedArtifact {
    pub artifact_id: ArtifactId,
    pub owner: OwnerIdentity,
    pub session_id: Option<BrowserSessionId>,
    pub tab_id: Option<TabId>,
    pub kind: ArtifactKindV2,
    pub sha256: String,
    pub media_type: String,
    pub size: u64,
    pub created_at: DateTime<Utc>,
    pub integrity_verified: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection { Upload, Download }

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TransferState { Staged, Committed, Consumed, Failed, Expired }

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferHandle {
    pub transfer_id: TransferId,
    pub owner: OwnerIdentity,
    pub direction: TransferDirection,
    pub state: TransferState,
    pub sha256: String,
    pub size: u64,
    pub expires_at: DateTime<Utc>,
    pub artifact_id: Option<ArtifactId>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Controller { Agent, Human }

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ControlLease {
    pub owner: OwnerIdentity,
    pub session_id: BrowserSessionId,
    pub tab_id: TabId,
    pub controller: Controller,
    pub control_epoch: u64,
    pub viewport_generation: u64,
    pub changed_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    InvalidRequest, Unauthenticated, WrongOwner, NotFound, WrongPath,
    StaleGeneration, StaleVisual, StaleControlEpoch, Unsupported, Conflict,
    Cancelled, BackendFailure, IntegrityFailure, CleanupFailure,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StructuredError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<OperationId>,
}

impl StructuredError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), retryable: false, details: BTreeMap::new(), path: None, operation_id: None }
    }

    pub fn unsupported(capability: impl Into<String>, path: PathIdentity) -> Self {
        let capability = capability.into();
        let mut error = Self::new(ErrorCode::Unsupported, format!("unsupported capability: {capability}"));
        error.details.insert("capability".into(), Value::String(capability));
        error.path = Some(path);
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_major_is_enforced() {
        assert!(ensure_compatible_version("2.9.7").is_ok());
        assert!(ensure_compatible_version("1.0.0").is_err());
    }

    #[test]
    fn browser_action_has_discriminator() {
        let action = BrowserAction::Click { r#ref: Some("e42".into()), selector: None };
        let value = serde_json::to_value(action).unwrap();
        assert_eq!(value["kind"], "click");
        assert_eq!(value["ref"], "e42");
    }

    fn strict_binding() -> (AuthenticatedPrincipal, OwnerIdentity, PathIdentity, ProtocolAddress) {
        let principal = AuthenticatedPrincipal {
            principal_id: PrincipalId("principal-a".into()),
            authentication_id: "unix-peer-1000".into(),
        };
        let owner = OwnerIdentity {
            principal_id: principal.principal_id.clone(),
            agent_id: AgentId("agent-a".into()),
        };
        let path = PathIdentity {
            path_id: BrowserPathId::AgentBrowserChrome,
            backend_version: "0.33.1".into(),
            provider: ChromeProvider::Chrome,
            host_id: HostId("host-a".into()),
            host_generation: 4,
            engine_generation: 7,
        };
        let address = ProtocolAddress {
            agent_id: owner.agent_id.clone(),
            session_id: BrowserSessionId("session-a".into()),
            tab_id: TabId("tab-a".into()),
            path_id: path.path_id,
            host_generation: 4,
            engine_generation: 7,
            control_epoch: 3,
        };
        (principal, owner, path, address)
    }

    #[test]
    fn wrong_owner_path_and_generation_fail_closed() {
        let (principal, owner, path, address) = strict_binding();
        assert!(address.validate_binding(&principal, &owner, &path, 3).is_ok());

        let mut wrong_owner = owner.clone();
        wrong_owner.principal_id = PrincipalId("principal-b".into());
        assert_eq!(address.validate_binding(&principal, &wrong_owner, &path, 3).unwrap_err().code, ErrorCode::WrongOwner);

        let mut wrong_path = path.clone();
        wrong_path.path_id = BrowserPathId::PinchtabChrome;
        assert_eq!(address.validate_binding(&principal, &owner, &wrong_path, 3).unwrap_err().code, ErrorCode::WrongPath);

        let mut stale = path.clone();
        stale.host_generation += 1;
        assert_eq!(address.validate_binding(&principal, &owner, &stale, 3).unwrap_err().code, ErrorCode::StaleGeneration);
        assert_eq!(address.validate_binding(&principal, &owner, &path, 4).unwrap_err().code, ErrorCode::StaleControlEpoch);
    }

    #[test]
    fn stale_visual_and_out_of_range_coordinates_fail_closed() {
        let screenshot = ScreenshotBinding {
            artifact_id: ArtifactId("artifact-a".into()),
            sha256: "0".repeat(64),
            sequence: 8,
            captured_at: Utc::now(),
            pixel_width: 1280,
            pixel_height: 960,
            viewport: ViewportBinding {
                viewport_id: ViewportId("viewport-a".into()),
                generation: 2,
                css_width: 640,
                css_height: 480,
                device_scale_factor: 2.0,
                scroll_x: 0.0,
                scroll_y: 0.0,
                coordinate_space: CoordinateSpace::CssViewportTopLeft,
            },
        };
        let stale = VisualGuard {
            viewport_id: screenshot.viewport.viewport_id.clone(),
            viewport_generation: 1,
            screenshot_sha256: screenshot.sha256.clone(),
            screenshot_sequence: screenshot.sequence,
        };
        assert_eq!(stale.validate_current(&screenshot).unwrap_err().code, ErrorCode::StaleVisual);
        assert_eq!(CssPoint { x: 640.0, y: 120.0 }.validate_in(&screenshot.viewport).unwrap_err().code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn schema_catalog_matches_rust_constants() {
        let schema: Value = serde_json::from_str(include_str!("../../../schema/protocol.schema.json")).unwrap();
        assert_eq!(schema["version"], PROTOCOL_VERSION);
        let methods: Vec<&str> = schema["methods"].as_array().unwrap().iter().map(|value| value.as_str().unwrap()).collect();
        let events: Vec<&str> = schema["events"].as_array().unwrap().iter().map(|value| value.as_str().unwrap()).collect();
        assert_eq!(methods, RPC_METHODS);
        assert_eq!(events, RPC_EVENTS);
        assert_eq!(schema["supportedPaths"], serde_json::json!(SUPPORTED_PATH_IDS));
    }

    #[test]
    fn conformance_fixture_has_required_negative_cases() {
        let fixture: Value = serde_json::from_str(include_str!("../../../schema/conformance-fixtures.json")).unwrap();
        assert_eq!(fixture["version"], PROTOCOL_VERSION);
        let names: Vec<&str> = fixture["invalid"].as_array().unwrap().iter()
            .filter_map(|item| item["name"].as_str()).collect();
        for required in ["malformed-empty-session", "wrong-owner", "wrong-path", "unsupported-path", "stale-host-generation", "stale-visual", "stale-control-epoch"] {
            assert!(names.contains(&required), "missing {required}");
        }
    }
}
