//! `agent-browser` adapter. The upstream binary remains an external dependency.
//!
//! Every operation resolves a stable coordinator tab ID to an agent-browser tab ID,
//! acquires the host operation lock, focuses that tab, performs exactly one operation,
//! and collects the result before releasing the lock.

use async_trait::async_trait;
use chrono::Utc;
use dashmap::DashMap;
use pi_web_backend_core::{
    BackendError, BackendOperationRequest, BackendSessionHandle, BackendTabHandle, BrowserController,
    BrowserControllerV2, CreateSessionRequest, Result,
};
use pi_web_protocol::{
    ActionKindV2, ActionOutcomeV2, ActionResult, AgentId, ArtifactId, BrowserAction,
    BrowserActionV2, BrowserAddress, BrowserBackend, BrowserCapabilities, BrowserEngine,
    BrowserHost, BrowserHostHandle, BrowserPathId, BrowserSessionId, CancellationOutcome,
    CancellationResult, CapabilityTruth, ChromeProvider, CoordinateSpace, DebugOperation,
    DebugRequest, DebugResult, DurableOperation, ErrorCode, HostId, HostState, InteractiveControl,
    MouseButton as ProtocolMouseButton, Observation, ObservationId, ObservationView, ObserveRequest,
    OperationId, OperationState, OwnerIdentity, PathIdentity, PostActionEvidence, ProtocolAddress,
    ProtocolObservation, ScreenshotBinding, ScrollDirection, StartHostRequest, StreamInfo,
    StructuredError, TabControl, TabId, TabInfo, TabState, TransferDirection, TransferHandle,
    TransferState, ViewportBinding, ViewportId, VisualGuard,
};
use regex::Regex;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tempfile::Builder as TempBuilder;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

pub const PRODUCT_PATH_ID: &str = "agent-browser/chrome";
pub const REQUIRED_AGENT_BROWSER_VERSION: &str = "0.33.1";
pub const REQUIRED_AGENT_BROWSER_SHA256: &str = "6e04d06605c4ca62da36e3263086e0f7ceae808b55508de2c3958d4b7fe430aa";
pub const REQUIRED_CHROMIUM_MAJOR: u32 = 151;
const DEFAULT_NAMESPACE: &str = "pi-web-v2";
const PENDING_OWNER: &str = "__coordinator_pending__";

#[derive(Clone)]
pub struct AgentBrowserController {
    binary: Arc<PathBuf>,
    namespace: Arc<String>,
    download_root: Arc<PathBuf>,
    visual_chromium_executable: Option<Arc<PathBuf>>,
    visual_chromium_args: Arc<Vec<String>>,
    hosts: Arc<DashMap<HostId, Arc<HostRuntime>>>,
    tab_to_host: Arc<DashMap<TabId, HostId>>,
    v2_sessions: Arc<DashMap<BrowserSessionId, Arc<V2SessionRuntime>>>,
    v2_tabs: Arc<DashMap<TabId, Arc<V2TabRuntime>>>,
    v2_operations: Arc<DashMap<OperationId, Arc<V2OperationRuntime>>>,
    v2_artifacts: Arc<DashMap<ArtifactId, Arc<V2ArtifactRuntime>>>,
}

struct HostRuntime {
    handle: BrowserHostHandle,
    operation_lock: Mutex<()>,
    tab_map: Mutex<HashMap<TabId, String>>,
    visual_bindings: Mutex<HashMap<TabId, VisualBinding>>,
    visual_sequences: Mutex<HashMap<TabId, u64>>,
    engine_generation: String,
    launch: StartHostRequest,
}

#[derive(Clone, Debug)]
struct BackendTab {
    id: String,
    title: String,
    url: String,
    index: usize,
}

struct V2SessionRuntime {
    handle: BackendSessionHandle,
    host: BrowserHostHandle,
}

struct V2TabRuntime {
    handle: BackendTabHandle,
    observation_sequence: AtomicU64,
    visual: Mutex<Option<V2VisualState>>,
}

#[derive(Clone)]
struct V2VisualState {
    protocol: ScreenshotBinding,
    adapter: VisualBinding,
}

struct V2OperationRuntime {
    record: Mutex<DurableOperation>,
    cancellation: Cancellation,
    cancellable: bool,
    settled: Notify,
}

struct V2ArtifactRuntime {
    owner: OwnerIdentity,
    session_id: BrowserSessionId,
    path: PathBuf,
    sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdentity {
    pub path_id: String,
    pub backend_version: String,
    pub backend_executable_sha256: String,
    pub engine: String,
    pub browser_product: String,
    pub engine_generation: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VisualGeometry {
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub image_width: u32,
    pub image_height: u32,
    pub device_scale_factor: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub coordinate_space: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VisualBinding {
    pub path: RuntimeIdentity,
    pub tab_id: String,
    pub sequence: u64,
    pub captured_at: chrono::DateTime<Utc>,
    pub screenshot_sha256: String,
    pub screenshot_path: PathBuf,
    pub geometry: VisualGeometry,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CuaAction {
    MouseMove { x: f64, y: f64 },
    MouseDown { x: f64, y: f64, button: MouseButton },
    MouseUp { x: f64, y: f64, button: MouseButton },
    Click { x: f64, y: f64, button: MouseButton },
    DoubleClick { x: f64, y: f64, button: MouseButton },
    Wheel { delta_x: f64, delta_y: f64 },
    Drag { from_x: f64, from_y: f64, to_x: f64, to_y: f64, button: MouseButton },
    KeyPress { key: String },
    KeyDown { key: String, code: String, modifiers: u8 },
    KeyUp { key: String, code: String, modifiers: u8 },
    Text { text: String },
    Touch { x: f64, y: f64 },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton { Left, Right, Middle }

impl MouseButton {
    fn as_str(self) -> &'static str {
        match self { Self::Left => "left", Self::Right => "right", Self::Middle => "middle" }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CuaCapabilities {
    pub path_id: String,
    pub coordinate_space: String,
    pub screenshot_bound: bool,
    pub mouse: Vec<String>,
    pub keyboard: Vec<String>,
    pub touch: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CuaSettlement { Succeeded, Cancelled }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CuaResult {
    pub settlement: CuaSettlement,
    pub path: RuntimeIdentity,
    pub binding_sequence: u64,
    pub changed: Vec<String>,
    pub title: String,
    pub url: String,
}

#[derive(Clone, Default)]
pub struct Cancellation {
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    notify: Arc<Notify>,
}

impl Cancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn cancelled(&self) {
        if self.is_cancelled() { return; }
        self.notify.notified().await;
    }
}

impl AgentBrowserController {
    pub fn new(binary: impl Into<PathBuf>) -> Result<Self> {
        Ok(Self {
            binary: Arc::new(binary.into()),
            namespace: Arc::new(DEFAULT_NAMESPACE.to_owned()),
            download_root: Arc::new(std::env::temp_dir().join("pi-web-downloads")),
            visual_chromium_executable: None,
            visual_chromium_args: Arc::new(Vec::new()),
            hosts: Arc::new(DashMap::new()),
            tab_to_host: Arc::new(DashMap::new()),
            v2_sessions: Arc::new(DashMap::new()),
            v2_tabs: Arc::new(DashMap::new()),
            v2_operations: Arc::new(DashMap::new()),
            v2_artifacts: Arc::new(DashMap::new()),
        })
    }

    pub fn with_namespace(mut self, namespace: impl Into<String>) -> Self {
        self.namespace = Arc::new(namespace.into());
        self
    }

    pub fn with_download_root(mut self, download_root: impl Into<PathBuf>) -> Self {
        self.download_root = Arc::new(download_root.into());
        self
    }

    pub fn with_visual_chromium(mut self, executable: Option<impl Into<PathBuf>>, args: Vec<String>) -> Self {
        self.visual_chromium_executable = executable.map(|path| Arc::new(path.into()));
        self.visual_chromium_args = Arc::new(args);
        self
    }

    fn screenshot_transfer(&self, runtime: &HostRuntime) -> Result<(PathBuf, Value)> {
        let host_root = self
            .download_root
            .join("hosts")
            .join(runtime.handle.host.host_id.as_ref());
        std::fs::create_dir_all(&host_root).map_err(|error| BackendError::Other(error.into()))?;
        let relative_path = format!("screenshot-{}.png", Uuid::new_v4());
        let path = host_root.join(&relative_path);
        Ok((path, json!({
            "hostId": runtime.handle.host.host_id,
            "relativePath": relative_path,
            "mediaType": "image/png",
            "kind": "screenshot"
        })))
    }

    pub async fn validate_installation(&self) -> Result<Version> {
        let output = Command::new(self.binary.as_ref())
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|error| BackendError::HostUnavailable(format!(
                "failed to execute {}: {error}",
                self.binary.display()
            )))?;
        let text = format!(
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let matcher = Regex::new(r"(?P<version>\d+\.\d+\.\d+)")
            .map_err(|error| BackendError::Protocol(error.to_string()))?;
        let actual = matcher
            .captures(&text)
            .and_then(|capture| capture.name("version"))
            .ok_or_else(|| BackendError::Protocol(format!("cannot parse agent-browser version from {text:?}")))?
            .as_str();
        let version = Version::parse(actual)
            .map_err(|error| BackendError::Protocol(error.to_string()))?;
        if version != Version::parse(REQUIRED_AGENT_BROWSER_VERSION)
            .map_err(|error| BackendError::Protocol(error.to_string()))?
        {
            return Err(BackendError::IncompatibleVersion {
                actual: version.to_string(),
                range: format!("={REQUIRED_AGENT_BROWSER_VERSION}"),
            });
        }
        let executable = resolve_executable(self.binary.as_ref())?;
        let digest = sha256_file(&executable).await?;
        if digest != REQUIRED_AGENT_BROWSER_SHA256 {
            return Err(BackendError::Protocol(format!(
                "agent-browser executable digest mismatch: expected {REQUIRED_AGENT_BROWSER_SHA256}, got {digest}"
            )));
        }
        Ok(version)
    }

    /// Reattach to an already-running named agent-browser daemon session after a
    /// coordinator or workspace restart. This never starts a replacement browser;
    /// an unavailable upstream session is reported explicitly so authenticated state
    /// is not silently lost or moved to a different engine.
    pub async fn recover_host(
        &self,
        mut handle: BrowserHostHandle,
        launch: StartHostRequest,
    ) -> Result<BrowserHostHandle> {
        self.validate_installation().await?;
        if handle.host.backend != BrowserBackend::AgentBrowser || handle.host.engine != BrowserEngine::Chromium {
            return Err(BackendError::Unsupported {
                capability: PRODUCT_PATH_ID.into(),
                backend: "agent-browser".into(),
            });
        }
        let host_id = handle.host.host_id.clone();
        let engine_generation = handle.backend_metadata.get("engineGeneration").and_then(Value::as_str)
            .map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
        handle.backend_metadata = path_metadata(&engine_generation);
        let runtime = Arc::new(HostRuntime {
            handle: handle.clone(),
            operation_lock: Mutex::new(()),
            tab_map: Mutex::new(HashMap::new()),
            visual_bindings: Mutex::new(HashMap::new()),
            visual_sequences: Mutex::new(HashMap::new()),
            engine_generation,
            launch,
        });

        // `session info` addresses the named daemon without creating a browser. A
        // failed command means the upstream session cannot be recovered.
        self.run_host_locked(&runtime, None, &["session".into(), "info".into()]).await?;
        self.sync_tabs(&runtime).await?;
        handle.host.state = HostState::Ready;
        let ready_runtime = Arc::new(HostRuntime {
            handle: handle.clone(),
            operation_lock: Mutex::new(()),
            tab_map: Mutex::new(runtime.tab_map.lock().await.clone()),
            visual_bindings: Mutex::new(runtime.visual_bindings.lock().await.clone()),
            visual_sequences: Mutex::new(runtime.visual_sequences.lock().await.clone()),
            engine_generation: runtime.engine_generation.clone(),
            launch: runtime.launch.clone(),
        });
        self.hosts.insert(host_id, ready_runtime);
        Ok(handle)
    }

    async fn runtime_for_host(&self, host_id: &HostId) -> Result<Arc<HostRuntime>> {
        self.hosts
            .get(host_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| BackendError::HostUnavailable(host_id.to_string()))
    }

    async fn runtime_for_address(&self, address: &BrowserAddress) -> Result<(Arc<HostRuntime>, String)> {
        let host_id = self
            .tab_to_host
            .get(&address.tab_id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| BackendError::TabUnavailable(address.tab_id.to_string()))?;
        let runtime = self.runtime_for_host(&host_id).await?;
        let backend_tab = runtime
            .tab_map
            .lock()
            .await
            .get(&address.tab_id)
            .cloned()
            .ok_or_else(|| BackendError::TabUnavailable(address.tab_id.to_string()))?;
        Ok((runtime, backend_tab))
    }

    fn command(&self, runtime: &HostRuntime) -> Command {
        let mut command = Command::new(self.binary.as_ref());
        command.kill_on_drop(true);
        let host_download_dir = self.download_root.join("hosts").join(runtime.handle.host.host_id.as_ref());
        let _ = std::fs::create_dir_all(&host_download_dir);
        command
            .env("AGENT_BROWSER_NAMESPACE", self.namespace.as_ref())
            .env("AGENT_BROWSER_SESSION", &runtime.handle.host.backend_session_id)
            // Persistent sessions are owned by the coordinator. Do not let an upstream
            // default idle timeout close them behind the workspace.
            .env("AGENT_BROWSER_IDLE_TIMEOUT_MS", "0")
            .env("AGENT_BROWSER_DOWNLOAD_PATH", &host_download_dir)
            .env(
                "AGENT_BROWSER_ENGINE",
                match runtime.handle.host.engine {
                    BrowserEngine::Chromium => "chrome",
                    BrowserEngine::Lightpanda => "lightpanda",
                },
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // `visible` means that the workspace should expose the live page stream.
        // Do not open an unrelated native Chromium window by default. Headed/full-window
        // mode is an explicit compatibility fallback configured through launch args.
        if let Some(profile) = &runtime.launch.profile {
            command.env("AGENT_BROWSER_PROFILE", &profile.data_dir);
            if !profile.extensions.is_empty() {
                command.env("AGENT_BROWSER_EXTENSIONS", profile.extensions.join(","));
            }
        }
        let use_visual_chromium = runtime.launch.visible && runtime.handle.host.engine == BrowserEngine::Chromium;
        if use_visual_chromium {
            if let Some(executable) = &self.visual_chromium_executable {
                command.env("AGENT_BROWSER_EXECUTABLE_PATH", executable.as_ref());
            }
        }
        let launch_args = if use_visual_chromium {
            merge_launch_args(&self.visual_chromium_args, &runtime.launch.launch_args)
        } else {
            runtime.launch.launch_args.clone()
        };
        if !launch_args.is_empty() {
            command.env("AGENT_BROWSER_ARGS", launch_args.join(","));
        }
        command
    }

    async fn run_json(&self, runtime: &HostRuntime, args: &[String]) -> Result<Value> {
        let mut command = self.command(runtime);
        command.args(args).arg("--json");
        let output = command.output().await.map_err(|error| {
            BackendError::HostUnavailable(format!("agent-browser execution failed: {error}"))
        })?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let parsed = parse_json_output(&stdout).or_else(|| parse_json_output(&stderr));
        if !output.status.success() {
            let message = parsed
                .as_ref()
                .and_then(extract_error_message)
                .unwrap_or_else(|| {
                    if stderr.is_empty() { stdout.clone() } else { stderr.clone() }
                });
            return Err(BackendError::Command { message, structured: parsed });
        }
        let value = parsed.unwrap_or_else(|| json!({ "success": true, "data": { "text": stdout } }));
        if value.get("success") == Some(&Value::Bool(false)) {
            return Err(BackendError::Command {
                message: extract_error_message(&value).unwrap_or_else(|| "agent-browser command failed".to_owned()),
                structured: Some(value),
            });
        }
        Ok(value)
    }

    async fn run_host_locked(&self, runtime: &HostRuntime, backend_tab: Option<&str>, args: &[String]) -> Result<Value> {
        let _guard = runtime.operation_lock.lock().await;
        if let Some(tab) = backend_tab {
            self.run_json(runtime, &["tab".into(), tab.into()]).await?;
        }
        self.run_json(runtime, args).await
    }

    async fn backend_tabs(&self, runtime: &HostRuntime) -> Result<Vec<BackendTab>> {
        let value = self.run_json(runtime, &["tab".into()]).await?;
        Ok(extract_tabs(&value))
    }

    async fn sync_tabs(&self, runtime: &HostRuntime) -> Result<Vec<TabInfo>> {
        let backend_tabs = self.backend_tabs(runtime).await?;
        let host_id = runtime.handle.host.host_id.clone();
        let live_backend_ids: HashSet<_> = backend_tabs.iter().map(|tab| tab.id.as_str()).collect();
        let mut map = runtime.tab_map.lock().await;
        let mut removed = Vec::new();
        map.retain(|tab_id, backend_id| {
            let keep = live_backend_ids.contains(backend_id.as_str());
            if !keep {
                self.tab_to_host.remove(tab_id);
                removed.push(tab_id.clone());
            }
            keep
        });
        for backend in &backend_tabs {
            let tab_id = stable_tab_id(&host_id, &backend.id);
            map.insert(tab_id.clone(), backend.id.clone());
            self.tab_to_host.insert(tab_id, host_id.clone());
        }
        drop(map);
        if !removed.is_empty() {
            let mut bindings = runtime.visual_bindings.lock().await;
            for tab_id in &removed {
                if let Some(binding) = bindings.remove(tab_id) {
                    let _ = std::fs::remove_file(binding.screenshot_path);
                }
            }
            drop(bindings);
            let mut sequences = runtime.visual_sequences.lock().await;
            for tab_id in removed { sequences.remove(&tab_id); }
        }
        Ok(backend_tabs
            .into_iter()
            .map(|backend| TabInfo {
                tab_id: stable_tab_id(&host_id, &backend.id),
                host_id: host_id.clone(),
                browser_session_id: BrowserSessionId(PENDING_OWNER.to_owned()),
                owner_agent_id: AgentId(PENDING_OWNER.to_owned()),
                title: backend.title,
                url: backend.url,
                index: backend.index,
                control: TabControl::Agent,
                state: TabState::Idle,
                last_action_at: None,
            })
            .collect())
    }

    async fn title_and_url(&self, runtime: &HostRuntime) -> (String, String) {
        let title = self
            .run_json(runtime, &["get".into(), "title".into()])
            .await
            .ok()
            .and_then(|value| extract_string(&value, &["title", "value", "text"]))
            .unwrap_or_default();
        let url = self
            .run_json(runtime, &["get".into(), "url".into()])
            .await
            .ok()
            .and_then(|value| extract_string(&value, &["url", "value", "text"]))
            .unwrap_or_default();
        (title, url)
    }

    async fn post_action_delta(&self, runtime: &HostRuntime) -> Vec<String> {
        // agent-browser 0.33.1 does not preserve `diff snapshot` baselines across
        // these isolated CLI calls. Capture a bounded semantic snapshot after the
        // action so success has page evidence and is not only dispatch evidence.
        // `read` includes visible status text that compact snapshots can omit.
        match self.run_json(runtime, &["read".into()]).await {
            Ok(value) => {
                let text = extract_string(&value, &["markdown", "content", "text", "output"])
                    .unwrap_or_else(|| value_to_compact_string(&value));
                bounded_lines(&text, 20, 4_000)
            }
            Err(_) => Vec::new(),
        }
    }

    pub fn cua_capabilities(&self) -> CuaCapabilities {
        CuaCapabilities {
            path_id: PRODUCT_PATH_ID.into(),
            coordinate_space: "css_viewport_top_left".into(),
            screenshot_bound: true,
            mouse: ["move", "down", "up", "click", "double_click", "wheel", "drag"]
                .into_iter().map(str::to_owned).collect(),
            keyboard: ["press", "down", "up", "text"]
                .into_iter().map(str::to_owned).collect(),
            // The M0 live proof did not prove touch for agent-browser/chrome.
            touch: false,
        }
    }

    pub async fn capture_visual_binding(&self, address: &BrowserAddress) -> Result<VisualBinding> {
        self.validate_installation().await?;
        let (runtime, backend_tab) = self.runtime_for_address(address).await?;
        if runtime.handle.host.engine != BrowserEngine::Chromium {
            return Err(BackendError::Unsupported {
                capability: PRODUCT_PATH_ID.into(),
                backend: "agent-browser".into(),
            });
        }
        let _guard = runtime.operation_lock.lock().await;
        self.run_json(&runtime, &["tab".into(), backend_tab]).await?;
        let geometry_value = self.run_json(&runtime, &[
            "eval".into(),
            "({viewportWidth:innerWidth,viewportHeight:innerHeight,deviceScaleFactor:devicePixelRatio,scrollX,scrollY,browserProduct:navigator.userAgent})".into(),
        ]).await?;
        let geometry_object = find_geometry_object(&geometry_value).ok_or_else(|| {
            BackendError::Protocol(format!("agent-browser did not return viewport geometry: {geometry_value}"))
        })?;
        let viewport_width = exact_u32(geometry_object, "viewportWidth")?;
        let viewport_height = exact_u32(geometry_object, "viewportHeight")?;
        let device_scale_factor = finite_number(geometry_object, "deviceScaleFactor")?;
        let scroll_x = finite_number(geometry_object, "scrollX")?;
        let scroll_y = finite_number(geometry_object, "scrollY")?;
        let browser_product = geometry_object.get("browserProduct").and_then(Value::as_str)
            .ok_or_else(|| BackendError::Protocol("missing browser product identity".into()))?
            .to_owned();
        validate_browser_product(&browser_product)?;
        if viewport_width == 0 || viewport_height == 0 || device_scale_factor <= 0.0 {
            return Err(BackendError::Protocol(format!(
                "invalid visual viewport geometry: {viewport_width}x{viewport_height} at DPR {device_scale_factor}"
            )));
        }
        let file = TempBuilder::new().prefix("pi-web-shot-").suffix(".png").tempfile()
            .map_err(|error| BackendError::Other(error.into()))?;
        let (_persisted, screenshot_path) = file.keep()
            .map_err(|error| BackendError::Other(error.error.into()))?;
        if let Err(error) = self.run_json(&runtime, &[
            "screenshot".into(), screenshot_path.to_string_lossy().into_owned(),
            "--screenshot-format".into(), "png".into(),
        ]).await {
            let _ = std::fs::remove_file(&screenshot_path);
            return Err(error);
        }
        let screenshot = match std::fs::read(&screenshot_path) {
            Ok(screenshot) => screenshot,
            Err(error) => {
                let _ = std::fs::remove_file(&screenshot_path);
                return Err(BackendError::Other(error.into()));
            }
        };
        let (image_width, image_height) = match png_dimensions(&screenshot) {
            Ok(geometry) => geometry,
            Err(error) => {
                let _ = std::fs::remove_file(&screenshot_path);
                return Err(error);
            }
        };
        let expected_width = f64::from(viewport_width) * device_scale_factor;
        let expected_height = f64::from(viewport_height) * device_scale_factor;
        if (f64::from(image_width) - expected_width).abs() > 1.0
            || (f64::from(image_height) - expected_height).abs() > 1.0
        {
            let _ = std::fs::remove_file(&screenshot_path);
            return Err(BackendError::Protocol(format!(
                "screenshot geometry mismatch: viewport {viewport_width}x{viewport_height} at DPR {device_scale_factor}, image {image_width}x{image_height}"
            )));
        }
        let screenshot_sha256 = match sha256_file(&screenshot_path).await {
            Ok(digest) => digest,
            Err(error) => {
                let _ = std::fs::remove_file(&screenshot_path);
                return Err(error);
            }
        };
        let previous = runtime.visual_bindings.lock().await.get(&address.tab_id).cloned();
        let sequence = {
            let mut sequences = runtime.visual_sequences.lock().await;
            let sequence = sequences.entry(address.tab_id.clone()).or_insert(0);
            *sequence = sequence.saturating_add(1);
            *sequence
        };
        if let Some(previous) = previous {
            if previous.screenshot_path != screenshot_path {
                let _ = std::fs::remove_file(previous.screenshot_path);
            }
        }
        let binding = VisualBinding {
            path: RuntimeIdentity {
                path_id: PRODUCT_PATH_ID.into(),
                backend_version: REQUIRED_AGENT_BROWSER_VERSION.into(),
                backend_executable_sha256: REQUIRED_AGENT_BROWSER_SHA256.into(),
                engine: "chrome".into(),
                browser_product,
                engine_generation: runtime.engine_generation.clone(),
            },
            tab_id: address.tab_id.to_string(),
            sequence,
            captured_at: Utc::now(),
            screenshot_sha256,
            screenshot_path,
            geometry: VisualGeometry {
                viewport_width,
                viewport_height,
                image_width,
                image_height,
                device_scale_factor,
                scroll_x,
                scroll_y,
                coordinate_space: "css_viewport_top_left".into(),
            },
        };
        runtime.visual_bindings.lock().await.insert(address.tab_id.clone(), binding.clone());
        Ok(binding)
    }

    pub async fn cua_action(
        &self,
        address: &BrowserAddress,
        supplied: &VisualBinding,
        action: CuaAction,
        cancellation: &Cancellation,
    ) -> Result<CuaResult> {
        self.validate_installation().await?;
        let (runtime, backend_tab) = self.runtime_for_address(address).await?;
        let _guard = runtime.operation_lock.lock().await;
        let current = runtime.visual_bindings.lock().await.get(&address.tab_id).cloned()
            .ok_or_else(|| stale_binding("no current screenshot binding"))?;
        validate_visual_binding(address, supplied, &current)?;
        validate_action_coordinates(&action, &current.geometry)?;
        if matches!(action, CuaAction::Touch { .. }) {
            return Err(BackendError::Unsupported {
                capability: "touch on agent-browser/chrome".into(),
                backend: "agent-browser".into(),
            });
        }
        if cancellation.is_cancelled() {
            runtime.visual_bindings.lock().await.remove(&address.tab_id);
            let _ = std::fs::remove_file(&current.screenshot_path);
            return Ok(CuaResult {
                settlement: CuaSettlement::Cancelled,
                path: current.path,
                binding_sequence: current.sequence,
                changed: Vec::new(),
                title: String::new(),
                url: String::new(),
            });
        }
        self.run_json(&runtime, &["tab".into(), backend_tab.clone()]).await?;
        let _ = self.run_json(&runtime, &["diff".into(), "snapshot".into(), "--compact".into()]).await;
        let path = current.path.clone();
        let sequence = current.sequence;
        let dispatch: Result<bool> = async {
            let mut cancelled = false;
            match action {
                CuaAction::KeyDown { key, code, modifiers } => {
                    cancelled = !self.send_cdp_keyboard_input(
                        &runtime, &backend_tab, "keyDown", &key, &code, modifiers, cancellation,
                    ).await?;
                }
                CuaAction::KeyUp { key, code, modifiers } => {
                    cancelled = !self.send_cdp_keyboard_input(
                        &runtime, &backend_tab, "keyUp", &key, &code, modifiers, cancellation,
                    ).await?;
                }
                other => {
                    for args in cua_command_steps(&other) {
                        if self.run_json_cancellable(&runtime, &args, cancellation).await?.is_none() {
                            cancelled = true;
                            break;
                        }
                    }
                }
            }
            Ok(cancelled)
        }.await;
        runtime.visual_bindings.lock().await.remove(&address.tab_id);
        let _ = std::fs::remove_file(&current.screenshot_path);
        let cancelled = dispatch?;
        if cancelled {
            return Ok(CuaResult {
                settlement: CuaSettlement::Cancelled,
                path,
                binding_sequence: sequence,
                changed: Vec::new(),
                title: String::new(),
                url: String::new(),
            });
        }
        let changed = self.post_action_delta(&runtime).await;
        let (title, url) = self.title_and_url(&runtime).await;
        Ok(CuaResult {
            settlement: CuaSettlement::Succeeded,
            path,
            binding_sequence: sequence,
            changed,
            title,
            url,
        })
    }

    async fn run_json_cancellable(
        &self,
        runtime: &HostRuntime,
        args: &[String],
        cancellation: &Cancellation,
    ) -> Result<Option<Value>> {
        if cancellation.is_cancelled() { return Ok(None); }
        let mut command = self.command(runtime);
        command.args(args).arg("--json");
        let mut child = command.spawn().map_err(|error| {
            BackendError::HostUnavailable(format!("agent-browser execution failed: {error}"))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| BackendError::Protocol("missing command stdout".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| BackendError::Protocol("missing command stderr".into()))?;
        let stdout_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stdout.take(32 * 1024 * 1024 + 1).read_to_end(&mut bytes).await.map(|_| bytes)
        });
        let stderr_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr.take(32 * 1024 * 1024 + 1).read_to_end(&mut bytes).await.map(|_| bytes)
        });
        let status = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                child.kill().await.map_err(|error| {
                    BackendError::HostUnavailable(format!("cancelled agent-browser command did not settle: {error}"))
                })?;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                return Ok(None);
            }
            status = child.wait() => status.map_err(|error| {
                BackendError::HostUnavailable(format!("agent-browser wait failed: {error}"))
            })?,
        };
        let stdout = stdout_task.await
            .map_err(|error| BackendError::Protocol(format!("stdout task failed: {error}")))?
            .map_err(|error| BackendError::Protocol(format!("stdout read failed: {error}")))?;
        let stderr = stderr_task.await
            .map_err(|error| BackendError::Protocol(format!("stderr task failed: {error}")))?
            .map_err(|error| BackendError::Protocol(format!("stderr read failed: {error}")))?;
        if stdout.len() > 32 * 1024 * 1024 || stderr.len() > 32 * 1024 * 1024 {
            return Err(BackendError::Protocol("agent-browser command output exceeded 32 MiB".into()));
        }
        let stdout = String::from_utf8_lossy(&stdout).trim().to_owned();
        let stderr = String::from_utf8_lossy(&stderr).trim().to_owned();
        let parsed = parse_json_output(&stdout).or_else(|| parse_json_output(&stderr));
        if !status.success() {
            let message = parsed.as_ref().and_then(extract_error_message).unwrap_or_else(|| {
                if stderr.is_empty() { stdout.clone() } else { stderr.clone() }
            });
            return Err(BackendError::Command { message, structured: parsed });
        }
        let value = parsed.unwrap_or_else(|| json!({ "success": true, "data": { "text": stdout } }));
        if value.get("success") == Some(&Value::Bool(false)) {
            return Err(BackendError::Command {
                message: extract_error_message(&value).unwrap_or_else(|| "agent-browser command failed".to_owned()),
                structured: Some(value),
            });
        }
        Ok(Some(value))
    }

    async fn send_cdp_keyboard_input(
        &self,
        runtime: &HostRuntime,
        backend_tab: &str,
        event_type: &str,
        key: &str,
        code: &str,
        modifiers: u8,
        cancellation: &Cancellation,
    ) -> Result<bool> {
        let page = self.run_json_cancellable(
            runtime,
            &["get".into(), "url".into()],
            cancellation,
        ).await?;
        let Some(page) = page else { return Ok(false); };
        let page_url = extract_string(&page, &["url", "value", "text"])
            .ok_or_else(|| BackendError::Protocol(format!("agent-browser did not return the current URL: {page}")))?;
        let value = self.run_json_cancellable(
            runtime,
            &["get".into(), "cdp-url".into()],
            cancellation,
        ).await?;
        let Some(value) = value else { return Ok(false); };
        let cdp_url = extract_string(&value, &["cdpUrl"])
            .ok_or_else(|| BackendError::Protocol(format!("agent-browser did not return a CDP URL: {value}")))?;
        if cancellation.is_cancelled() { return Ok(false); }
        let mut socket = websocket_connect_loopback(&cdp_url).await?;
        websocket_send_json(&mut socket, &json!({ "id": 1, "method": "Target.getTargets" })).await?;
        let targets = websocket_read_response(&mut socket, 1, cancellation).await?;
        let target_infos = targets.get("result").and_then(|value| value.get("targetInfos"))
            .and_then(Value::as_array)
            .ok_or_else(|| BackendError::Protocol(format!("CDP target list is invalid: {targets}")))?;
        let target_id = target_infos.iter().find(|target| {
            target.get("targetId").and_then(Value::as_str) == Some(backend_tab)
        }).or_else(|| target_infos.iter().find(|target| {
            target.get("type").and_then(Value::as_str) == Some("page")
                && target.get("url").and_then(Value::as_str) == Some(page_url.as_str())
        })).and_then(|target| target.get("targetId")).and_then(Value::as_str)
            .ok_or_else(|| BackendError::Protocol(format!("CDP could not resolve focused tab {backend_tab:?} at {page_url:?}")))?;
        websocket_send_json(&mut socket, &json!({
            "id": 2,
            "method": "Target.attachToTarget",
            "params": { "targetId": target_id, "flatten": true }
        })).await?;
        let attached = websocket_read_response(&mut socket, 2, cancellation).await?;
        let session_id = attached.get("result").and_then(|value| value.get("sessionId"))
            .and_then(Value::as_str)
            .ok_or_else(|| BackendError::Protocol(format!("CDP attach did not return a session: {attached}")))?;
        websocket_send_json(&mut socket, &json!({
            "id": 3,
            "sessionId": session_id,
            "method": "Input.dispatchKeyEvent",
            "params": { "type": event_type, "key": key, "code": code, "modifiers": modifiers }
        })).await?;
        let dispatched = websocket_read_response(&mut socket, 3, cancellation).await?;
        if let Some(error) = dispatched.get("error") {
            return Err(BackendError::Command {
                message: format!("CDP key dispatch failed: {error}"),
                structured: Some(dispatched),
            });
        }
        Ok(!cancellation.is_cancelled())
    }


    pub fn capabilities_v2(&self) -> CapabilityTruth {
        CapabilityTruth {
            path_id: BrowserPathId::AgentBrowserChrome,
            actions: vec![
                ActionKindV2::Navigate, ActionKindV2::MouseMove, ActionKindV2::MouseDown,
                ActionKindV2::MouseUp, ActionKindV2::Click, ActionKindV2::DoubleClick,
                ActionKindV2::Wheel, ActionKindV2::Drag, ActionKindV2::KeyPress,
                ActionKindV2::KeyDown, ActionKindV2::KeyUp, ActionKindV2::TextInput,
                ActionKindV2::Fill, ActionKindV2::Select, ActionKindV2::Back,
                ActionKindV2::Forward, ActionKindV2::Reload, ActionKindV2::Wait,
            ],
            observations: vec![
                ObservationView::Main, ObservationView::Interactive, ObservationView::Visual,
                ObservationView::Full, ObservationView::Diff,
            ],
            touch: false,
            uploads: false,
            downloads: false,
            visual: true,
        }
    }

    pub async fn read_owned_visual_artifact(
        &self,
        owner: &OwnerIdentity,
        artifact_id: &ArtifactId,
    ) -> Result<Vec<u8>> {
        let artifact = self.v2_artifacts.get(artifact_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| v2_backend_error(ErrorCode::NotFound, "visual artifact was not found", None, None))?;
        if artifact.owner != *owner {
            return Err(v2_backend_error(ErrorCode::WrongOwner, "visual artifact has a different owner", None, None));
        }
        let bytes = std::fs::read(&artifact.path).map_err(|error| {
            v2_backend_error(ErrorCode::IntegrityFailure, format!("visual artifact read failed: {error}"), None, None)
        })?;
        let digest = sha256_file(&artifact.path).await?;
        if digest != artifact.sha256 {
            return Err(v2_backend_error(ErrorCode::IntegrityFailure, "visual artifact digest changed", None, None));
        }
        Ok(bytes)
    }

    fn v2_session_runtime(&self, handle: &BackendSessionHandle) -> Result<Arc<V2SessionRuntime>> {
        let runtime = self.v2_sessions.get(&handle.session_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| v2_backend_error(ErrorCode::NotFound, "browser session was not found", Some(handle.path.clone()), None))?;
        if runtime.handle.owner != handle.owner
            || runtime.handle.path != handle.path
            || runtime.handle.backend_session_id != handle.backend_session_id
        {
            return Err(v2_backend_error(ErrorCode::WrongPath, "browser session handle changed", Some(runtime.handle.path.clone()), None));
        }
        Ok(runtime)
    }

    fn v2_tab_runtime(&self, handle: &BackendTabHandle) -> Result<Arc<V2TabRuntime>> {
        let runtime = self.v2_tabs.get(&handle.tab_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| v2_backend_error(ErrorCode::NotFound, "browser tab was not found", Some(handle.path.clone()), None))?;
        if runtime.handle.owner != handle.owner
            || runtime.handle.session_id != handle.session_id
            || runtime.handle.path != handle.path
            || runtime.handle.backend_tab_id != handle.backend_tab_id
            || runtime.handle.control_epoch != handle.control_epoch
        {
            return Err(v2_backend_error(ErrorCode::WrongPath, "browser tab handle changed", Some(runtime.handle.path.clone()), None));
        }
        Ok(runtime)
    }

    fn validate_v2_address(&self, tab: &V2TabRuntime, address: &ProtocolAddress) -> Result<()> {
        address.validate().map_err(structured_backend_error)?;
        if address.agent_id != tab.handle.owner.agent_id {
            return Err(v2_backend_error(ErrorCode::WrongOwner, "operation has a different owner", Some(tab.handle.path.clone()), None));
        }
        if address.session_id != tab.handle.session_id || address.tab_id != tab.handle.tab_id {
            return Err(v2_backend_error(ErrorCode::NotFound, "operation address does not select this tab", Some(tab.handle.path.clone()), None));
        }
        if address.path_id != tab.handle.path.path_id {
            return Err(v2_backend_error(ErrorCode::WrongPath, "session path is immutable", Some(tab.handle.path.clone()), None));
        }
        if address.host_generation != tab.handle.path.host_generation
            || address.engine_generation != tab.handle.path.engine_generation
        {
            return Err(v2_backend_error(ErrorCode::StaleGeneration, "host or engine generation is stale", Some(tab.handle.path.clone()), None));
        }
        if address.control_epoch != tab.handle.control_epoch {
            return Err(v2_backend_error(ErrorCode::StaleControlEpoch, "control epoch is stale", Some(tab.handle.path.clone()), None));
        }
        Ok(())
    }

    async fn begin_v2_operation(
        &self,
        tab: &V2TabRuntime,
        operation_id: OperationId,
        address: ProtocolAddress,
        kind: String,
        cancellable: bool,
    ) -> Result<Arc<V2OperationRuntime>> {
        self.validate_v2_address(tab, &address)?;
        if operation_id.as_ref().trim().is_empty() {
            return Err(v2_backend_error(ErrorCode::InvalidRequest, "operation ID is empty", Some(tab.handle.path.clone()), None));
        }
        let now = Utc::now();
        let runtime = Arc::new(V2OperationRuntime {
            record: Mutex::new(DurableOperation {
                operation_id: operation_id.clone(),
                owner: tab.handle.owner.clone(),
                address,
                path: tab.handle.path.clone(),
                kind,
                state: OperationState::Queued,
                created_at: now,
                updated_at: now,
                cancellation_requested: false,
                error: None,
            }),
            cancellation: Cancellation::default(),
            cancellable,
            settled: Notify::new(),
        });
        match self.v2_operations.entry(operation_id.clone()) {
            dashmap::mapref::entry::Entry::Vacant(entry) => { entry.insert(Arc::clone(&runtime)); }
            dashmap::mapref::entry::Entry::Occupied(_) => {
                return Err(v2_backend_error(ErrorCode::Conflict, "operation ID already exists", Some(tab.handle.path.clone()), Some(operation_id)));
            }
        }
        Ok(runtime)
    }

    async fn nonvisual_v2_action(
        &self,
        address: &BrowserAddress,
        action: &BrowserActionV2,
        cancellation: &Cancellation,
    ) -> Result<Option<(Vec<String>, String, String)>> {
        let (runtime, backend_tab) = self.runtime_for_address(address).await?;
        let _guard = runtime.operation_lock.lock().await;
        if self.run_json_cancellable(&runtime, &["tab".into(), backend_tab.clone()], cancellation).await?.is_none() {
            return Ok(None);
        }
        let dispatched = match action {
            BrowserActionV2::KeyDown { key } => self.send_cdp_keyboard_input(
                &runtime, &backend_tab, "keyDown", key, key, 0, cancellation,
            ).await?,
            BrowserActionV2::KeyUp { key } => self.send_cdp_keyboard_input(
                &runtime, &backend_tab, "keyUp", key, key, 0, cancellation,
            ).await?,
            _ => {
                let args = v2_nonvisual_args(action)?;
                self.run_json_cancellable(&runtime, &args, cancellation).await?.is_some()
            }
        };
        if !dispatched || cancellation.is_cancelled() { return Ok(None); }
        let changed = self.post_action_delta(&runtime).await;
        if cancellation.is_cancelled() { return Ok(None); }
        let (title, url) = self.title_and_url(&runtime).await;
        Ok(Some((changed, title, url)))
    }

    fn remove_v2_artifact(&self, artifact_id: &ArtifactId) {
        if let Some((_, artifact)) = self.v2_artifacts.remove(artifact_id) {
            let _ = std::fs::remove_file(&artifact.path);
        }
    }

    async fn remove_v2_tab_state(&self, tab_id: &TabId) {
        if let Some((_, tab)) = self.v2_tabs.remove(tab_id) {
            if let Some(visual) = tab.visual.lock().await.take() {
                self.remove_v2_artifact(&visual.protocol.artifact_id);
            }
        }
    }
}

#[async_trait]
impl BrowserController for AgentBrowserController {
    async fn capabilities(&self) -> Result<BrowserCapabilities> {
        self.validate_installation().await?;
        Ok(BrowserCapabilities {
            backend: BrowserBackend::AgentBrowser,
            engines: vec![BrowserEngine::Chromium],
            actions: [
                "navigate", "click", "fill", "type", "press", "select", "hover", "scroll",
                "drag", "upload", "download", "back", "forward", "reload", "wait",
                "tab-new", "tab-close", "tab-focus", "mouse-move", "mouse-down", "mouse-up",
                "mouse-click", "mouse-double-click", "mouse-wheel", "mouse-drag", "key-down",
                "key-up", "text-input",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            debug: [
                "evaluate", "console", "network", "html", "cookies", "storage", "pdf",
                "record-start", "record-stop",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            persistent_profiles: true,
            extensions: true,
            viewport_streaming: true,
            direct_tab_addressing: false,
        })
    }

    async fn start_host(&self, request: StartHostRequest) -> Result<BrowserHostHandle> {
        self.validate_installation().await?;
        if request.engine != BrowserEngine::Chromium {
            return Err(BackendError::Unsupported {
                capability: "only agent-browser/chrome is supported".into(),
                backend: "agent-browser".into(),
            });
        }
        let host_id = HostId::new();
        let random = Uuid::new_v4().simple().to_string();
        let backend_session_id = format!("pw-{}", &random[..12]);
        let engine_generation = Uuid::new_v4().to_string();
        let handle = BrowserHostHandle {
            host: BrowserHost {
                host_id: host_id.clone(),
                backend: BrowserBackend::AgentBrowser,
                engine: request.engine,
                profile_id: request.profile.as_ref().map(|profile| profile.profile_id.clone()),
                state: HostState::Starting,
                backend_session_id,
                created_at: Utc::now(),
            },
            backend_metadata: path_metadata(&engine_generation),
        };
        let runtime = Arc::new(HostRuntime {
            handle: handle.clone(),
            operation_lock: Mutex::new(()),
            tab_map: Mutex::new(HashMap::new()),
            visual_bindings: Mutex::new(HashMap::new()),
            visual_sequences: Mutex::new(HashMap::new()),
            engine_generation,
            launch: request.clone(),
        });
        self.hosts.insert(host_id.clone(), Arc::clone(&runtime));

        let args = vec!["open".to_owned(), "about:blank".to_owned()];
        if let Err(error) = self.run_host_locked(&runtime, None, &args).await {
            let _ = self.run_host_locked(&runtime, None, &["close".into()]).await;
            self.hosts.remove(&host_id);
            return Err(error);
        }
        if let Err(error) = self.run_host_locked(
            &runtime,
            None,
            &["set".into(), "viewport".into(), "1280".into(), "720".into()],
        ).await {
            let _ = self.run_host_locked(&runtime, None, &["close".into()]).await;
            self.hosts.remove(&host_id);
            return Err(error);
        }
        let browser_product = match self.run_host_locked(
            &runtime,
            None,
            &["eval".into(), "navigator.userAgent".into()],
        ).await.and_then(|value| {
            let product = extract_string(&value, &["value", "result", "text"])
                .ok_or_else(|| BackendError::Protocol(format!("missing browser product identity: {value}")))?;
            validate_browser_product(&product)?;
            Ok(product)
        }) {
            Ok(product) => product,
            Err(error) => {
                let _ = self.run_host_locked(&runtime, None, &["close".into()]).await;
                self.hosts.remove(&host_id);
                return Err(error);
            }
        };
        if let Err(error) = self.sync_tabs(&runtime).await {
            let _ = self.run_host_locked(&runtime, None, &["close".into()]).await;
            self.hosts.remove(&host_id);
            return Err(error);
        }
        let mut ready = handle;
        ready.host.state = HostState::Ready;
        ready.backend_metadata.insert("browserProduct".into(), json!(browser_product));
        // Replace the immutable runtime handle with the ready state.
        let ready_runtime = Arc::new(HostRuntime {
            handle: ready.clone(),
            operation_lock: Mutex::new(()),
            tab_map: Mutex::new(runtime.tab_map.lock().await.clone()),
            visual_bindings: Mutex::new(runtime.visual_bindings.lock().await.clone()),
            visual_sequences: Mutex::new(runtime.visual_sequences.lock().await.clone()),
            engine_generation: runtime.engine_generation.clone(),
            launch: request,
        });
        self.hosts.insert(host_id, ready_runtime);
        Ok(ready)
    }

    async fn stop_host(&self, host: &BrowserHostHandle) -> Result<()> {
        let runtime = self.runtime_for_host(&host.host.host_id).await?;
        let close_result = self.run_host_locked(&runtime, None, &["close".into()]).await;
        for tab_id in runtime.tab_map.lock().await.keys() {
            self.tab_to_host.remove(tab_id);
        }
        for binding in runtime.visual_bindings.lock().await.values() {
            let _ = std::fs::remove_file(&binding.screenshot_path);
        }
        runtime.visual_bindings.lock().await.clear();
        let _ = std::fs::remove_dir_all(
            self.download_root.join("hosts").join(runtime.handle.host.host_id.as_ref()),
        );
        self.hosts.remove(&host.host.host_id);
        close_result.map(|_| ())
    }

    async fn list_tabs(&self, host: &BrowserHostHandle) -> Result<Vec<TabInfo>> {
        let runtime = self.runtime_for_host(&host.host.host_id).await?;
        let _guard = runtime.operation_lock.lock().await;
        self.sync_tabs(&runtime).await
    }

    async fn open_tab(&self, host: &BrowserHostHandle, url: Option<&str>) -> Result<TabInfo> {
        let runtime = self.runtime_for_host(&host.host.host_id).await?;
        let _guard = runtime.operation_lock.lock().await;
        let before: HashSet<String> = self.backend_tabs(&runtime).await?.into_iter().map(|tab| tab.id).collect();
        let mut args = vec!["tab".into(), "new".into()];
        if let Some(url) = url { args.push(url.to_owned()); }
        self.run_json(&runtime, &args).await?;
        let tabs = self.sync_tabs(&runtime).await?;
        let map = runtime.tab_map.lock().await;
        let created = tabs.iter().find(|tab| {
            map.get(&tab.tab_id).is_some_and(|backend| !before.contains(backend))
        }).cloned();
        created
            .or_else(|| tabs.last().cloned())
            .ok_or_else(|| BackendError::Protocol("agent-browser created no observable tab".into()))
    }

    async fn close_tab(&self, host: &BrowserHostHandle, tab_id: &str) -> Result<()> {
        let runtime = self.runtime_for_host(&host.host.host_id).await?;
        let tab_id = TabId(tab_id.to_owned());
        let backend = runtime
            .tab_map
            .lock()
            .await
            .get(&tab_id)
            .cloned()
            .ok_or_else(|| BackendError::TabUnavailable(tab_id.to_string()))?;
        self.run_host_locked(&runtime, Some(&backend), &["tab".into(), "close".into(), backend.clone()]).await?;
        runtime.tab_map.lock().await.remove(&tab_id);
        self.tab_to_host.remove(&tab_id);
        if let Some(binding) = runtime.visual_bindings.lock().await.remove(&tab_id) {
            let _ = std::fs::remove_file(binding.screenshot_path);
        }
        runtime.visual_sequences.lock().await.remove(&tab_id);
        Ok(())
    }

    async fn focus_tab(&self, host: &BrowserHostHandle, tab_id: &str) -> Result<()> {
        let runtime = self.runtime_for_host(&host.host.host_id).await?;
        let backend = runtime
            .tab_map
            .lock()
            .await
            .get(&TabId(tab_id.to_owned()))
            .cloned()
            .ok_or_else(|| BackendError::TabUnavailable(tab_id.to_owned()))?;
        self.run_host_locked(&runtime, None, &["tab".into(), backend]).await?;
        Ok(())
    }

    async fn navigate(&self, address: &BrowserAddress, url: &str) -> Result<ActionResult> {
        self.act(address, BrowserAction::Navigate { url: url.parse().map_err(|error| BackendError::Protocol(format!("invalid URL: {error}")))? }).await
    }

    async fn observe(&self, address: &BrowserAddress, request: ObserveRequest) -> Result<Observation> {
        let (runtime, backend_tab) = self.runtime_for_address(address).await?;
        let _guard = runtime.operation_lock.lock().await;
        self.run_json(&runtime, &["tab".into(), backend_tab]).await?;
        let (title, url) = self.title_and_url(&runtime).await;
        let mut controls = Vec::new();
        let mut metadata = BTreeMap::new();
        let value = match request.view {
            ObservationView::Main => self.run_json(&runtime, &["read".into()]).await?,
            ObservationView::Interactive => {
                let mut args = vec!["snapshot".into(), "-i".into(), "-c".into(), "--urls".into()];
                if let Some(selector) = &request.selector {
                    args.extend(["-s".into(), selector.clone()]);
                }
                let value = self.run_json(&runtime, &args).await?;
                controls = extract_controls(&value, request.include_bounds);
                value
            }
            ObservationView::Full => {
                let mut args = vec!["snapshot".into()];
                if let Some(selector) = &request.selector {
                    args.extend(["-s".into(), selector.clone()]);
                }
                self.run_json(&runtime, &args).await?
            }
            ObservationView::Diff => {
                let mut args = vec!["diff".into(), "snapshot".into(), "--compact".into()];
                if let Some(selector) = &request.selector {
                    args.extend(["--selector".into(), selector.clone()]);
                }
                self.run_json(&runtime, &args).await?
            }
            ObservationView::Visual => {
                let (path, transfer) = self.screenshot_transfer(&runtime)?;
                let shot = match self
                    .run_json(&runtime, &["screenshot".into(), path.to_string_lossy().into_owned()])
                    .await
                {
                    Ok(shot) => shot,
                    Err(error) => {
                        let _ = std::fs::remove_file(&path);
                        return Err(error);
                    }
                };
                let snapshot = match self
                    .run_json(&runtime, &["snapshot".into(), "-i".into(), "-c".into()])
                    .await
                {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        let _ = std::fs::remove_file(&path);
                        return Err(error);
                    }
                };
                controls = extract_controls(&snapshot, request.include_bounds);
                metadata.insert("transfer".into(), transfer);
                json!({ "screenshot": shot, "snapshot": snapshot })
            }
        };
        let raw = extract_primary_text(&value);
        let (content, truncated) = truncate_chars(&raw, request.max_chars);
        metadata.insert("backendOutputChars".into(), json!(raw.chars().count()));
        if truncated || request.view == ObservationView::Full {
            metadata.insert("rawContent".into(), Value::String(raw.clone()));
        }
        Ok(Observation {
            view: request.view,
            title,
            url,
            content,
            controls,
            changed: if request.view == ObservationView::Diff { bounded_lines(&raw, 50, 8_000) } else { Vec::new() },
            artifact_id: None,
            truncated,
            metadata,
        })
    }

    async fn act(&self, address: &BrowserAddress, action: BrowserAction) -> Result<ActionResult> {
        let (runtime, backend_tab) = self.runtime_for_address(address).await?;
        let _guard = runtime.operation_lock.lock().await;
        self.run_json(&runtime, &["tab".into(), backend_tab]).await?;
        // Prime the upstream diff baseline before action so the result reports the
        // visible consequence instead of successful input dispatch only.
        let _ = self.run_json(&runtime, &["diff".into(), "snapshot".into(), "--compact".into()]).await;
        let action_name = action_name(&action).to_owned();
        let before_backend_tabs: HashSet<String> = runtime.tab_map.lock().await.values().cloned().collect();
        let mut closed_tab = None;
        let value = match &action {
            BrowserAction::Download { r#ref, selector } => {
                let directory = self.download_root.join(address.browser_session_id.as_ref());
                std::fs::create_dir_all(&directory).map_err(|error| BackendError::Other(error.into()))?;
                let path = directory.join(format!("download-{}", Uuid::new_v4()));
                self.run_json(&runtime, &["download".into(), target(r#ref, selector)?, path.to_string_lossy().into_owned()]).await?
            }
            BrowserAction::TabNew { url } => {
                let mut args = vec!["tab".into(), "new".into()];
                if let Some(url) = url { args.push(url.as_str().into()); }
                self.run_json(&runtime, &args).await?
            }
            BrowserAction::TabClose { tab_id } => {
                let stable_tab = tab_id.clone().unwrap_or_else(|| address.tab_id.clone());
                let backend_target = runtime
                    .tab_map
                    .lock()
                    .await
                    .get(&stable_tab)
                    .cloned()
                    .ok_or_else(|| BackendError::TabUnavailable(stable_tab.to_string()))?;
                closed_tab = Some(stable_tab);
                self.run_json(&runtime, &["tab".into(), "close".into(), backend_target]).await?
            }
            BrowserAction::TabFocus { tab_id } => {
                let backend_target = runtime
                    .tab_map
                    .lock()
                    .await
                    .get(tab_id)
                    .cloned()
                    .ok_or_else(|| BackendError::TabUnavailable(tab_id.to_string()))?;
                self.run_json(&runtime, &["tab".into(), backend_target]).await?
            }
            _ => self.run_json(&runtime, &action_args(&action)?).await?,
        };
        if let Some(tab_id) = closed_tab {
            runtime.tab_map.lock().await.remove(&tab_id);
            self.tab_to_host.remove(&tab_id);
            if let Some(binding) = runtime.visual_bindings.lock().await.remove(&tab_id) {
                let _ = std::fs::remove_file(binding.screenshot_path);
            }
            runtime.visual_sequences.lock().await.remove(&tab_id);
        }
        let changed = self.post_action_delta(&runtime).await;
        let (title, url) = self.title_and_url(&runtime).await;
        let tabs = self.sync_tabs(&runtime).await?;
        let map = runtime.tab_map.lock().await;
        let new_tab_id = tabs.iter().find_map(|tab| {
            let backend_id = map.get(&tab.tab_id)?;
            (!before_backend_tabs.contains(backend_id)).then(|| tab.tab_id.clone())
        });
        drop(map);
        let mut backend = BTreeMap::new();
        backend.insert("summary".into(), compact_backend_summary(&value));
        // Keep the complete structured backend result available to the coordinator.
        // It will inline small values and persist larger values as artifacts.
        backend.insert("raw".into(), value);
        Ok(ActionResult {
            ok: true,
            action: action_name,
            url: (!url.is_empty()).then_some(url),
            title: (!title.is_empty()).then_some(title),
            changed,
            new_tab_id,
            download_artifact_id: None,
            artifact_id: None,
            backend,
        })
    }

    async fn debug(&self, address: &BrowserAddress, request: DebugRequest) -> Result<DebugResult> {
        let (runtime, backend_tab) = self.runtime_for_address(address).await?;
        let _guard = runtime.operation_lock.lock().await;
        self.run_json(&runtime, &["tab".into(), backend_tab]).await?;
        let args = debug_args(request.operation, &request.args)?;
        let value = self.run_json(&runtime, &args).await?;
        Ok(DebugResult { ok: true, operation: request.operation, data: value, artifact_id: None })
    }

    async fn stream_info(&self, address: &BrowserAddress) -> Result<StreamInfo> {
        let (runtime, backend_tab) = self.runtime_for_address(address).await?;
        let value = self.run_host_locked(&runtime, Some(&backend_tab), &["stream".into(), "status".into()]).await?;
        let port = find_number(&value, &["port", "streamPort"])
            .ok_or_else(|| BackendError::Protocol(format!("stream status did not include a port: {value}")))?;
        Ok(StreamInfo {
            protocol: "agent-browser-jpeg-v1".into(),
            url: format!("ws://127.0.0.1:{port}"),
            token: None,
            width: find_number(&value, &["deviceWidth", "width"]).map(|value| value as u32),
            height: find_number(&value, &["deviceHeight", "height"]).map(|value| value as u32),
            metadata: BTreeMap::from([("backendStatus".into(), compact_backend_summary(&value))]),
        })
    }
}

#[async_trait]
impl BrowserControllerV2 for AgentBrowserController {
    async fn create_session(&self, request: CreateSessionRequest) -> Result<BackendSessionHandle> {
        if request.path_id != BrowserPathId::AgentBrowserChrome {
            return Err(v2_backend_error(ErrorCode::WrongPath, "agent-browser adapter only supports agent-browser/chrome", None, None));
        }
        if request.profile_id.is_some() {
            return Err(v2_backend_error(ErrorCode::Unsupported, "protocol v2 profile handle resolution is not available at this adapter seam", None, None));
        }
        self.validate_installation().await?;
        let host = BrowserController::start_host(self, StartHostRequest {
            engine: BrowserEngine::Chromium,
            backend: BrowserBackend::AgentBrowser,
            profile: None,
            visible: false,
            launch_args: Vec::new(),
        }).await?;
        let session_id = BrowserSessionId::new();
        let path = PathIdentity {
            path_id: BrowserPathId::AgentBrowserChrome,
            backend_version: REQUIRED_AGENT_BROWSER_VERSION.into(),
            provider: ChromeProvider::Chrome,
            host_id: host.host.host_id.clone(),
            host_generation: 1,
            engine_generation: 1,
        };
        let handle = BackendSessionHandle {
            owner: request.owner,
            session_id: session_id.clone(),
            path,
            backend_session_id: host.host.backend_session_id.clone(),
        };
        self.v2_sessions.insert(session_id, Arc::new(V2SessionRuntime { handle: handle.clone(), host }));
        Ok(handle)
    }

    async fn close_session(&self, session: &BackendSessionHandle) -> Result<()> {
        BrowserControllerV2::cleanup_session(self, session).await
    }

    async fn create_tab(&self, session: &BackendSessionHandle, url: Option<&str>) -> Result<BackendTabHandle> {
        let session_runtime = self.v2_session_runtime(session)?;
        let tab = BrowserController::open_tab(self, &session_runtime.host, url).await?;
        let host_runtime = self.runtime_for_host(&session_runtime.host.host.host_id).await?;
        let backend_tab_id = {
            host_runtime.tab_map.lock().await.get(&tab.tab_id).cloned()
        };
        let Some(backend_tab_id) = backend_tab_id else {
            let _ = BrowserController::close_tab(self, &session_runtime.host, tab.tab_id.as_ref()).await;
            return Err(v2_backend_error(
                ErrorCode::BackendFailure,
                "created tab has no backend identity",
                Some(session.path.clone()),
                None,
            ));
        };
        let handle = BackendTabHandle {
            owner: session.owner.clone(),
            session_id: session.session_id.clone(),
            tab_id: tab.tab_id.clone(),
            path: session.path.clone(),
            backend_tab_id,
            viewport: None,
            control_epoch: 1,
        };
        self.v2_tabs.insert(tab.tab_id, Arc::new(V2TabRuntime {
            handle: handle.clone(),
            observation_sequence: AtomicU64::new(0),
            visual: Mutex::new(None),
        }));
        Ok(handle)
    }

    async fn close_tab_v2(&self, tab: &BackendTabHandle) -> Result<()> {
        let tab_runtime = self.v2_tab_runtime(tab)?;
        let session_runtime = self.v2_sessions.get(&tab.session_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| v2_backend_error(ErrorCode::NotFound, "browser session was not found", Some(tab.path.clone()), None))?;
        BrowserController::close_tab(self, &session_runtime.host, tab_runtime.handle.tab_id.as_ref()).await?;
        self.remove_v2_tab_state(&tab_runtime.handle.tab_id).await;
        Ok(())
    }

    async fn observe_v2(
        &self,
        tab: &BackendTabHandle,
        request: BackendOperationRequest<ObservationView>,
    ) -> Result<ProtocolObservation> {
        let tab_runtime = self.v2_tab_runtime(tab)?;
        let operation = self.begin_v2_operation(
            &tab_runtime,
            request.operation_id.clone(),
            request.address.clone(),
            format!("observe:{}", observation_view_name(request.input)),
            false,
        ).await?;
        set_operation_state(&operation, OperationState::Running, None).await;
        let legacy_address = BrowserAddress {
            agent_id: tab.owner.agent_id.clone(),
            browser_session_id: tab.session_id.clone(),
            tab_id: tab.tab_id.clone(),
        };
        let result: Result<ProtocolObservation> = async {
            let sequence = tab_runtime.observation_sequence.fetch_add(1, Ordering::SeqCst).saturating_add(1);
            let mut screenshot = None;
            let observation = if request.input == ObservationView::Visual {
                let binding = self.capture_visual_binding(&legacy_address).await?;
                let semantic = BrowserController::observe(self, &legacy_address, ObserveRequest {
                    view: ObservationView::Interactive,
                    selector: None,
                    max_chars: 16_000,
                    include_bounds: true,
                }).await?;
                let previous = tab_runtime.visual.lock().await.clone();
                let (viewport_id, generation) = match previous.as_ref() {
                    Some(previous) => {
                        let viewport = &previous.protocol.viewport;
                        let changed = viewport.css_width != binding.geometry.viewport_width
                            || viewport.css_height != binding.geometry.viewport_height
                            || viewport.device_scale_factor != binding.geometry.device_scale_factor;
                        (viewport.viewport_id.clone(), if changed { viewport.generation.saturating_add(1) } else { viewport.generation })
                    }
                    None => (ViewportId::new(), 1),
                };
                let artifact_id = ArtifactId::new();
                let protocol_binding = ScreenshotBinding {
                    artifact_id: artifact_id.clone(),
                    sha256: binding.screenshot_sha256.clone(),
                    sequence: binding.sequence,
                    captured_at: binding.captured_at,
                    pixel_width: binding.geometry.image_width,
                    pixel_height: binding.geometry.image_height,
                    viewport: ViewportBinding {
                        viewport_id,
                        generation,
                        css_width: binding.geometry.viewport_width,
                        css_height: binding.geometry.viewport_height,
                        device_scale_factor: binding.geometry.device_scale_factor,
                        scroll_x: binding.geometry.scroll_x,
                        scroll_y: binding.geometry.scroll_y,
                        coordinate_space: CoordinateSpace::CssViewportTopLeft,
                    },
                };
                if let Some(previous) = previous {
                    self.v2_artifacts.remove(&previous.protocol.artifact_id);
                }
                self.v2_artifacts.insert(artifact_id, Arc::new(V2ArtifactRuntime {
                    owner: tab.owner.clone(),
                    session_id: tab.session_id.clone(),
                    path: binding.screenshot_path.clone(),
                    sha256: binding.screenshot_sha256.clone(),
                }));
                *tab_runtime.visual.lock().await = Some(V2VisualState {
                    protocol: protocol_binding.clone(),
                    adapter: binding,
                });
                screenshot = Some(protocol_binding);
                semantic
            } else {
                BrowserController::observe(self, &legacy_address, ObserveRequest {
                    view: request.input,
                    selector: None,
                    max_chars: 16_000,
                    include_bounds: request.input == ObservationView::Interactive,
                }).await?
            };
            let content = if request.input == ObservationView::Full {
                observation.metadata.get("rawContent").and_then(Value::as_str)
                    .unwrap_or(&observation.content).to_owned()
            } else {
                observation.content
            };
            Ok(ProtocolObservation {
                observation_id: ObservationId::new(),
                operation_id: request.operation_id.clone(),
                owner: tab.owner.clone(),
                address: request.address.clone(),
                path: tab.path.clone(),
                view: request.input,
                sequence,
                observed_at: Utc::now(),
                title: observation.title,
                url: observation.url,
                content,
                controls: observation.controls,
                changed: observation.changed,
                screenshot,
                full_artifact_id: None,
                truncated: observation.truncated && request.input != ObservationView::Full,
            })
        }.await;
        match result {
            Ok(observation) => {
                set_operation_state(&operation, OperationState::Succeeded, None).await;
                Ok(observation)
            }
            Err(error) => {
                let structured = structured_from_backend_error(&error, Some(tab.path.clone()), Some(request.operation_id));
                set_operation_state(&operation, OperationState::Failed, Some(structured)).await;
                Err(error)
            }
        }
    }

    async fn act_v2(
        &self,
        tab: &BackendTabHandle,
        request: BackendOperationRequest<BrowserActionV2>,
    ) -> Result<ActionOutcomeV2> {
        let tab_runtime = self.v2_tab_runtime(tab)?;
        let operation = self.begin_v2_operation(
            &tab_runtime,
            request.operation_id.clone(),
            request.address.clone(),
            action_kind_name(&request.input).into(),
            true,
        ).await?;
        let controller = self.clone();
        let tab = tab.clone();
        let task_path = tab.path.clone();
        let operation_for_task = Arc::clone(&operation);
        let task = tokio::spawn(async move {
            set_operation_state(&operation_for_task, OperationState::Running, None).await;
            let result = controller.execute_v2_action(&tab, request, &operation_for_task).await;
            match &result {
                Ok(_) => set_operation_state(&operation_for_task, OperationState::Succeeded, None).await,
                Err(error) => {
                    let state = if operation_for_task.cancellation.is_cancelled() {
                        OperationState::Cancelled
                    } else {
                        OperationState::Failed
                    };
                    let record = operation_for_task.record.lock().await;
                    let structured = structured_from_backend_error(error, Some(record.path.clone()), Some(record.operation_id.clone()));
                    drop(record);
                    set_operation_state(&operation_for_task, state, Some(structured)).await;
                }
            }
            result
        });
        match task.await {
            Ok(result) => result,
            Err(error) => {
                let structured = StructuredError::new(ErrorCode::BackendFailure, format!("action task failed: {error}"));
                set_operation_state(&operation, OperationState::Failed, Some(structured)).await;
                Err(v2_backend_error(ErrorCode::BackendFailure, format!("action task failed: {error}"), Some(task_path), None))
            }
        }
    }

    async fn operation(&self, operation_id: &OperationId) -> Result<DurableOperation> {
        let operation = self.v2_operations.get(operation_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| v2_backend_error(ErrorCode::NotFound, "operation was not found", None, Some(operation_id.clone())))?;
        let record = operation.record.lock().await.clone();
        Ok(record)
    }

    async fn cancel_operation(&self, operation_id: &OperationId) -> Result<CancellationResult> {
        let operation = self.v2_operations.get(operation_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| v2_backend_error(ErrorCode::NotFound, "operation was not found", None, Some(operation_id.clone())))?;
        {
            let mut record = operation.record.lock().await;
            if record.state.is_terminal() {
                return Ok(CancellationResult {
                    operation_id: operation_id.clone(),
                    outcome: CancellationOutcome::AlreadyTerminal,
                    state: record.state,
                    completed_at: Utc::now(),
                });
            }
            if !operation.cancellable {
                return Ok(CancellationResult {
                    operation_id: operation_id.clone(),
                    outcome: CancellationOutcome::NotCancellable,
                    state: record.state,
                    completed_at: Utc::now(),
                });
            }
            record.cancellation_requested = true;
            record.state = OperationState::Cancelling;
            record.updated_at = Utc::now();
        }
        operation.cancellation.cancel();
        loop {
            let notified = operation.settled.notified();
            let state = operation.record.lock().await.state;
            if state.is_terminal() {
                return Ok(CancellationResult {
                    operation_id: operation_id.clone(),
                    outcome: if state == OperationState::Cancelled {
                        CancellationOutcome::Cancelled
                    } else {
                        CancellationOutcome::AlreadyTerminal
                    },
                    state,
                    completed_at: Utc::now(),
                });
            }
            notified.await;
        }
    }

    async fn stage_upload(&self, handle: TransferHandle) -> Result<TransferHandle> {
        if handle.direction != TransferDirection::Upload || handle.state != TransferState::Staged {
            return Err(v2_backend_error(ErrorCode::InvalidRequest, "transfer is not a staged upload", None, None));
        }
        Err(v2_backend_error(ErrorCode::Unsupported, "agent-browser upload needs a secure typed backend path handle", None, None))
    }

    async fn cleanup_session(&self, session: &BackendSessionHandle) -> Result<()> {
        let Some(runtime) = self.v2_sessions.get(&session.session_id)
            .map(|entry| Arc::clone(entry.value())) else { return Ok(()); };
        if runtime.handle.owner != session.owner || runtime.handle.path != session.path
            || runtime.handle.backend_session_id != session.backend_session_id
        {
            return Err(v2_backend_error(ErrorCode::WrongPath, "browser session handle changed", Some(session.path.clone()), None));
        }
        self.v2_sessions.remove(&session.session_id);
        let tab_ids: Vec<_> = self.v2_tabs.iter()
            .filter(|entry| entry.value().handle.session_id == session.session_id)
            .map(|entry| entry.key().clone()).collect();
        for tab_id in tab_ids { self.remove_v2_tab_state(&tab_id).await; }
        let artifact_ids: Vec<_> = self.v2_artifacts.iter()
            .filter(|entry| entry.value().session_id == session.session_id)
            .map(|entry| entry.key().clone()).collect();
        for artifact_id in artifact_ids { self.remove_v2_artifact(&artifact_id); }
        BrowserController::stop_host(self, &runtime.host).await
    }
}

impl AgentBrowserController {
    async fn execute_v2_action(
        &self,
        tab: &BackendTabHandle,
        request: BackendOperationRequest<BrowserActionV2>,
        operation: &V2OperationRuntime,
    ) -> Result<ActionOutcomeV2> {
        let tab_runtime = self.v2_tab_runtime(tab)?;
        self.validate_v2_address(&tab_runtime, &request.address)?;
        self.validate_installation().await?;
        let legacy_address = BrowserAddress {
            agent_id: tab.owner.agent_id.clone(),
            browser_session_id: tab.session_id.clone(),
            tab_id: tab.tab_id.clone(),
        };
        let (changed, title, url) = if let Some((guard, cua)) = visual_cua_action(&request.input) {
            let visual = tab_runtime.visual.lock().await.clone()
                .ok_or_else(|| v2_backend_error(ErrorCode::StaleVisual, "no current screenshot binding", Some(tab.path.clone()), Some(request.operation_id.clone())))?;
            guard.validate_current(&visual.protocol).map_err(structured_backend_error)?;
            validate_protocol_action_points(&request.input, &visual.protocol.viewport)?;
            let action_result = self.cua_action(&legacy_address, &visual.adapter, cua, &operation.cancellation).await;
            let artifact_id = visual.protocol.artifact_id.clone();
            *tab_runtime.visual.lock().await = None;
            self.v2_artifacts.remove(&artifact_id);
            let result = action_result?;
            if result.settlement == CuaSettlement::Cancelled {
                return Err(v2_backend_error(ErrorCode::Cancelled, "browser action was cancelled", Some(tab.path.clone()), Some(request.operation_id.clone())));
            }
            (result.changed, result.title, result.url)
        } else {
            match request.input {
                BrowserActionV2::Upload { .. } => {
                    return Err(v2_backend_error(ErrorCode::Unsupported, "upload needs a secure typed backend path handle", Some(tab.path.clone()), Some(request.operation_id.clone())));
                }
                BrowserActionV2::Download { .. } => {
                    return Err(v2_backend_error(ErrorCode::Unsupported, "download artifact ingestion is not connected at this adapter seam", Some(tab.path.clone()), Some(request.operation_id.clone())));
                }
                _ => {}
            }
            let Some(result) = self.nonvisual_v2_action(&legacy_address, &request.input, &operation.cancellation).await? else {
                return Err(v2_backend_error(ErrorCode::Cancelled, "browser action was cancelled", Some(tab.path.clone()), Some(request.operation_id.clone())));
            };
            result
        };
        let summary = if changed.is_empty() {
            format!("Action completed at {} ({title})", if url.is_empty() { "the current page" } else { &url })
        } else {
            changed.join("\n")
        };
        Ok(ActionOutcomeV2 {
            operation_id: request.operation_id,
            owner: tab.owner.clone(),
            address: request.address,
            path: tab.path.clone(),
            dispatched: true,
            evidence: PostActionEvidence {
                observation_id: ObservationId::new(),
                sequence: tab_runtime.observation_sequence.fetch_add(1, Ordering::SeqCst).saturating_add(1),
                summary,
                changed,
            },
            download_artifact_id: None,
        })
    }
}

fn structured_backend_error(error: StructuredError) -> BackendError {
    BackendError::Command {
        message: error.message.clone(),
        structured: serde_json::to_value(error).ok(),
    }
}

fn v2_backend_error(
    code: ErrorCode,
    message: impl Into<String>,
    path: Option<PathIdentity>,
    operation_id: Option<OperationId>,
) -> BackendError {
    let mut error = StructuredError::new(code, message);
    error.path = path;
    error.operation_id = operation_id;
    structured_backend_error(error)
}

fn structured_from_backend_error(
    error: &BackendError,
    path: Option<PathIdentity>,
    operation_id: Option<OperationId>,
) -> StructuredError {
    if let BackendError::Command { structured: Some(value), .. } = error {
        if let Ok(mut structured) = serde_json::from_value::<StructuredError>(value.clone()) {
            if structured.path.is_none() { structured.path = path; }
            if structured.operation_id.is_none() { structured.operation_id = operation_id; }
            return structured;
        }
    }
    let mut structured = StructuredError::new(ErrorCode::BackendFailure, error.to_string());
    structured.path = path;
    structured.operation_id = operation_id;
    structured
}

async fn set_operation_state(
    operation: &V2OperationRuntime,
    state: OperationState,
    error: Option<StructuredError>,
) {
    let terminal = state.is_terminal();
    {
        let mut record = operation.record.lock().await;
        record.state = state;
        record.updated_at = Utc::now();
        record.error = error;
    }
    if terminal { operation.settled.notify_waiters(); }
}

fn observation_view_name(view: ObservationView) -> &'static str {
    match view {
        ObservationView::Main => "main",
        ObservationView::Interactive => "interactive",
        ObservationView::Visual => "visual",
        ObservationView::Full => "full",
        ObservationView::Diff => "diff",
    }
}

fn action_kind_name(action: &BrowserActionV2) -> &'static str {
    match action {
        BrowserActionV2::Navigate { .. } => "navigate",
        BrowserActionV2::MouseMove { .. } => "mouse-move",
        BrowserActionV2::MouseDown { .. } => "mouse-down",
        BrowserActionV2::MouseUp { .. } => "mouse-up",
        BrowserActionV2::Click { .. } => "click",
        BrowserActionV2::DoubleClick { .. } => "double-click",
        BrowserActionV2::Wheel { .. } => "wheel",
        BrowserActionV2::Drag { .. } => "drag",
        BrowserActionV2::KeyPress { .. } => "key-press",
        BrowserActionV2::KeyDown { .. } => "key-down",
        BrowserActionV2::KeyUp { .. } => "key-up",
        BrowserActionV2::TextInput { .. } => "text-input",
        BrowserActionV2::Fill { .. } => "fill",
        BrowserActionV2::Select { .. } => "select",
        BrowserActionV2::Upload { .. } => "upload",
        BrowserActionV2::Download { .. } => "download",
        BrowserActionV2::Back => "back",
        BrowserActionV2::Forward => "forward",
        BrowserActionV2::Reload => "reload",
        BrowserActionV2::Wait { .. } => "wait",
    }
}

fn adapter_mouse_button(button: ProtocolMouseButton) -> MouseButton {
    match button {
        ProtocolMouseButton::Left => MouseButton::Left,
        ProtocolMouseButton::Middle => MouseButton::Middle,
        ProtocolMouseButton::Right => MouseButton::Right,
    }
}

fn visual_cua_action(action: &BrowserActionV2) -> Option<(VisualGuard, CuaAction)> {
    match action {
        BrowserActionV2::MouseMove { point, visual_guard } => Some((visual_guard.clone(), CuaAction::MouseMove { x: point.x, y: point.y })),
        BrowserActionV2::MouseDown { point, button, visual_guard } => Some((visual_guard.clone(), CuaAction::MouseDown {
            x: point.x, y: point.y, button: adapter_mouse_button(*button),
        })),
        BrowserActionV2::MouseUp { point, button, visual_guard } => Some((visual_guard.clone(), CuaAction::MouseUp {
            x: point.x, y: point.y, button: adapter_mouse_button(*button),
        })),
        BrowserActionV2::Click { point, button, visual_guard } => Some((visual_guard.clone(), CuaAction::Click {
            x: point.x, y: point.y, button: adapter_mouse_button(*button),
        })),
        BrowserActionV2::DoubleClick { point, button, visual_guard } => Some((visual_guard.clone(), CuaAction::DoubleClick {
            x: point.x, y: point.y, button: adapter_mouse_button(*button),
        })),
        BrowserActionV2::Wheel { delta_x, delta_y, visual_guard } => Some((visual_guard.clone(), CuaAction::Wheel {
            delta_x: *delta_x, delta_y: *delta_y,
        })),
        BrowserActionV2::Drag { from, to, visual_guard } => Some((visual_guard.clone(), CuaAction::Drag {
            from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, button: MouseButton::Left,
        })),
        _ => None,
    }
}

fn validate_protocol_action_points(action: &BrowserActionV2, viewport: &ViewportBinding) -> Result<()> {
    let validate = |point: &pi_web_protocol::CssPoint| point.validate_in(viewport).map_err(structured_backend_error);
    match action {
        BrowserActionV2::MouseMove { point, .. }
        | BrowserActionV2::MouseDown { point, .. }
        | BrowserActionV2::MouseUp { point, .. }
        | BrowserActionV2::Click { point, .. }
        | BrowserActionV2::DoubleClick { point, .. } => validate(point),
        BrowserActionV2::Drag { from, to, .. } => { validate(from)?; validate(to) }
        BrowserActionV2::Wheel { delta_x, delta_y, .. } => {
            if delta_x.is_finite() && delta_y.is_finite() { Ok(()) }
            else { Err(v2_backend_error(ErrorCode::InvalidRequest, "wheel delta must be finite", None, None)) }
        }
        _ => Ok(()),
    }
}

fn v2_nonvisual_args(action: &BrowserActionV2) -> Result<Vec<String>> {
    Ok(match action {
        BrowserActionV2::Navigate { url } => vec!["open".into(), url.as_str().into()],
        BrowserActionV2::KeyPress { key } => vec!["press".into(), key.clone()],
        BrowserActionV2::TextInput { text } => vec!["keyboard".into(), "inserttext".into(), text.clone()],
        BrowserActionV2::Fill { r#ref: Some(r#ref), text } => vec!["fill".into(), normalize_ref(r#ref), text.clone()],
        BrowserActionV2::Fill { r#ref: None, .. } => {
            return Err(v2_backend_error(ErrorCode::InvalidRequest, "fill requires a semantic ref", None, None));
        }
        BrowserActionV2::Select { r#ref, values } => {
            let mut args = vec!["select".into(), normalize_ref(r#ref)];
            args.extend(values.iter().cloned());
            args
        }
        BrowserActionV2::Back => vec!["back".into()],
        BrowserActionV2::Forward => vec!["forward".into()],
        BrowserActionV2::Reload => vec!["reload".into()],
        BrowserActionV2::Wait { milliseconds } => vec!["wait".into(), milliseconds.to_string()],
        BrowserActionV2::KeyDown { .. } | BrowserActionV2::KeyUp { .. } => {
            return Err(v2_backend_error(ErrorCode::BackendFailure, "raw key action bypassed stream dispatch", None, None));
        }
        BrowserActionV2::MouseMove { .. } | BrowserActionV2::MouseDown { .. }
        | BrowserActionV2::MouseUp { .. } | BrowserActionV2::Click { .. }
        | BrowserActionV2::DoubleClick { .. } | BrowserActionV2::Wheel { .. }
        | BrowserActionV2::Drag { .. } | BrowserActionV2::Upload { .. }
        | BrowserActionV2::Download { .. } => {
            return Err(v2_backend_error(ErrorCode::Unsupported, "action requires another strict adapter path", None, None));
        }
    })
}

fn validate_browser_product(product: &str) -> Result<()> {
    let matcher = Regex::new(&format!(r"(?:HeadlessChrome|Chrome|Chromium)/{}\.", REQUIRED_CHROMIUM_MAJOR))
        .map_err(|error| BackendError::Protocol(error.to_string()))?;
    if !matcher.is_match(product) {
        return Err(BackendError::Protocol(format!(
            "Chromium runtime identity mismatch: expected major {REQUIRED_CHROMIUM_MAJOR}, got {product:?}"
        )));
    }
    Ok(())
}

fn path_metadata(engine_generation: &str) -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("pathId".into(), json!(PRODUCT_PATH_ID)),
        ("backendVersion".into(), json!(REQUIRED_AGENT_BROWSER_VERSION)),
        ("backendExecutableSha256".into(), json!(REQUIRED_AGENT_BROWSER_SHA256)),
        ("engine".into(), json!("chrome")),
        ("engineGeneration".into(), json!(engine_generation)),
        ("coordinateSpace".into(), json!("css_viewport_top_left")),
        ("touch".into(), json!(false)),
    ])
}

async fn sha256_file(path: &Path) -> Result<String> {
    let output = Command::new("sha256sum")
        .arg("--")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| BackendError::HostUnavailable(format!("sha256sum failed: {error}")))?;
    if !output.status.success() {
        return Err(BackendError::HostUnavailable(format!(
            "sha256sum failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let digest = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(BackendError::Protocol(format!("invalid sha256sum output for {}", path.display())));
    }
    Ok(digest)
}

fn resolve_executable(binary: &Path) -> Result<PathBuf> {
    if binary.components().count() > 1 || binary.is_absolute() {
        return std::fs::canonicalize(binary).map_err(|error| {
            BackendError::HostUnavailable(format!("cannot resolve {}: {error}", binary.display()))
        });
    }
    let path = std::env::var_os("PATH")
        .ok_or_else(|| BackendError::HostUnavailable("PATH is not set".into()))?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(binary))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| std::fs::canonicalize(candidate).ok())
        .ok_or_else(|| BackendError::HostUnavailable(format!("{} is not on PATH", binary.display())))
}

fn find_geometry_object(value: &Value) -> Option<&Map<String, Value>> {
    match value {
        Value::Object(object) => {
            if object.contains_key("viewportWidth") && object.contains_key("viewportHeight") {
                return Some(object);
            }
            object.values().find_map(find_geometry_object)
        }
        Value::Array(array) => array.iter().find_map(find_geometry_object),
        _ => None,
    }
}

fn exact_u32(object: &Map<String, Value>, key: &str) -> Result<u32> {
    let number = finite_number(object, key)?;
    if number < 0.0 || number > f64::from(u32::MAX) || number.fract() != 0.0 {
        return Err(BackendError::Protocol(format!("invalid {key}: {number}")));
    }
    Ok(number as u32)
}

fn finite_number(object: &Map<String, Value>, key: &str) -> Result<f64> {
    let number = object.get(key).and_then(Value::as_f64)
        .ok_or_else(|| BackendError::Protocol(format!("missing numeric {key}")))?;
    if !number.is_finite() {
        return Err(BackendError::Protocol(format!("non-finite {key}")));
    }
    Ok(number)
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err(BackendError::Protocol("agent-browser screenshot is not a PNG".into()));
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("four PNG width bytes"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("four PNG height bytes"));
    if width == 0 || height == 0 {
        return Err(BackendError::Protocol("agent-browser screenshot has zero geometry".into()));
    }
    Ok((width, height))
}

fn stale_binding(reason: &str) -> BackendError {
    BackendError::Protocol(format!("stale_visual_binding: {reason}"))
}

fn validate_visual_binding(address: &BrowserAddress, supplied: &VisualBinding, current: &VisualBinding) -> Result<()> {
    if supplied.path.path_id != PRODUCT_PATH_ID { return Err(stale_binding("path ID changed")); }
    if supplied.path.backend_version != REQUIRED_AGENT_BROWSER_VERSION
        || supplied.path.backend_executable_sha256 != REQUIRED_AGENT_BROWSER_SHA256
    {
        return Err(stale_binding("backend runtime identity changed"));
    }
    if supplied.path.engine != "chrome" || supplied.path.engine_generation != current.path.engine_generation {
        return Err(stale_binding("engine generation changed"));
    }
    if supplied.tab_id != address.tab_id.to_string() || supplied.tab_id != current.tab_id {
        return Err(stale_binding("tab changed"));
    }
    if supplied.sequence != current.sequence
        || supplied.screenshot_sha256 != current.screenshot_sha256
        || supplied.geometry != current.geometry
        || supplied.captured_at != current.captured_at
    {
        return Err(stale_binding("screenshot sequence, digest, time, or geometry changed"));
    }
    Ok(())
}

fn validate_action_coordinates(action: &CuaAction, geometry: &VisualGeometry) -> Result<()> {
    let points: Vec<(f64, f64)> = match action {
        CuaAction::MouseMove { x, y }
        | CuaAction::MouseDown { x, y, .. }
        | CuaAction::MouseUp { x, y, .. }
        | CuaAction::Click { x, y, .. }
        | CuaAction::DoubleClick { x, y, .. }
        | CuaAction::Touch { x, y } => vec![(*x, *y)],
        CuaAction::Drag { from_x, from_y, to_x, to_y, .. } => vec![(*from_x, *from_y), (*to_x, *to_y)],
        _ => Vec::new(),
    };
    for (x, y) in points {
        if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0
            || x >= f64::from(geometry.viewport_width) || y >= f64::from(geometry.viewport_height)
        {
            return Err(BackendError::Protocol(format!(
                "coordinate_out_of_range: ({x},{y}) is outside 0..{} by 0..{} CSS viewport pixels",
                geometry.viewport_width, geometry.viewport_height
            )));
        }
    }
    if let CuaAction::Wheel { delta_x, delta_y, .. } = action {
        if !delta_x.is_finite() || !delta_y.is_finite() {
            return Err(BackendError::Protocol("wheel delta must be finite".into()));
        }
    }
    Ok(())
}

fn cua_command_steps(action: &CuaAction) -> Vec<Vec<String>> {
    // agent-browser 0.33.1 accepts integer CSS pixels for low-level mouse input.
    // Floor after strict range validation so a valid point cannot round past an edge.
    let point = |x: f64, y: f64| vec!["mouse".into(), "move".into(), x.floor().to_string(), y.floor().to_string()];
    let down = |button: MouseButton| vec!["mouse".into(), "down".into(), button.as_str().into()];
    let up = |button: MouseButton| vec!["mouse".into(), "up".into(), button.as_str().into()];
    match action {
        CuaAction::MouseMove { x, y } => vec![point(*x, *y)],
        CuaAction::MouseDown { x, y, button } => vec![point(*x, *y), down(*button)],
        CuaAction::MouseUp { x, y, button } => vec![point(*x, *y), up(*button)],
        CuaAction::Click { x, y, button } => vec![point(*x, *y), down(*button), up(*button)],
        CuaAction::DoubleClick { x, y, button } => {
            vec![point(*x, *y), down(*button), up(*button), down(*button), up(*button)]
        }
        CuaAction::Wheel { delta_x, delta_y } => vec![
            vec!["mouse".into(), "wheel".into(), delta_y.to_string(), delta_x.to_string()],
        ],
        CuaAction::Drag { from_x, from_y, to_x, to_y, button } => {
            let mut steps = vec![point(*from_x, *from_y), down(*button)];
            for step in 1..=8 {
                let fraction = f64::from(step) / 8.0;
                steps.push(point(
                    from_x + (to_x - from_x) * fraction,
                    from_y + (to_y - from_y) * fraction,
                ));
            }
            steps.push(up(*button));
            steps
        }
        CuaAction::KeyPress { key } => vec![vec!["press".into(), key.clone()]],
        CuaAction::Text { text } => vec![vec!["keyboard".into(), "inserttext".into(), text.clone()]],
        CuaAction::KeyDown { .. } | CuaAction::KeyUp { .. } | CuaAction::Touch { .. } => Vec::new(),
    }
}

async fn websocket_connect_loopback(websocket_url: &str) -> Result<TcpStream> {
    let parsed = url::Url::parse(websocket_url)
        .map_err(|error| BackendError::Protocol(format!("invalid CDP WebSocket URL: {error}")))?;
    if parsed.scheme() != "ws" || parsed.host_str() != Some("127.0.0.1") {
        return Err(BackendError::Protocol("CDP WebSocket must use loopback ws".into()));
    }
    let port = parsed.port().ok_or_else(|| BackendError::Protocol("CDP WebSocket URL has no port".into()))?;
    let mut socket = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        TcpStream::connect(("127.0.0.1", port)),
    ).await.map_err(|_| BackendError::HostUnavailable("CDP WebSocket connect timed out".into()))?
        .map_err(|error| BackendError::HostUnavailable(format!("CDP WebSocket connect failed: {error}")))?;
    let mut target = parsed.path().to_owned();
    if target.is_empty() { target.push('/'); }
    if let Some(query) = parsed.query() {
        target.push('?');
        target.push_str(query);
    }
    let request = format!(
        "GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), socket.write_all(request.as_bytes()))
        .await.map_err(|_| BackendError::HostUnavailable("CDP WebSocket handshake timed out".into()))?
        .map_err(|error| BackendError::HostUnavailable(format!("CDP WebSocket handshake failed: {error}")))?;
    let mut response = Vec::new();
    while !response.ends_with(b"\r\n\r\n") && response.len() < 16 * 1024 {
        let mut byte = [0_u8; 1];
        tokio::time::timeout(std::time::Duration::from_secs(5), socket.read_exact(&mut byte))
            .await.map_err(|_| BackendError::HostUnavailable("CDP WebSocket handshake response timed out".into()))?
            .map_err(|error| BackendError::HostUnavailable(format!("CDP WebSocket handshake response failed: {error}")))?;
        response.push(byte[0]);
    }
    if !response.starts_with(b"HTTP/1.1 101") {
        return Err(BackendError::Protocol("CDP endpoint refused WebSocket upgrade".into()));
    }
    Ok(socket)
}

async fn websocket_send_json(socket: &mut TcpStream, value: &Value) -> Result<()> {
    let payload = serde_json::to_vec(value).map_err(|error| BackendError::Protocol(error.to_string()))?;
    socket.write_all(&masked_websocket_text_frame(&payload)).await
        .map_err(|error| BackendError::HostUnavailable(format!("CDP WebSocket write failed: {error}")))?;
    socket.flush().await
        .map_err(|error| BackendError::HostUnavailable(format!("CDP WebSocket flush failed: {error}")))
}

async fn websocket_read_exact(
    socket: &mut TcpStream,
    bytes: &mut [u8],
    cancellation: &Cancellation,
) -> Result<()> {
    tokio::select! {
        _ = cancellation.cancelled() => {
            Err(v2_backend_error(ErrorCode::Cancelled, "CDP operation was cancelled", None, None))
        }
        read = tokio::time::timeout(std::time::Duration::from_secs(5), socket.read_exact(bytes)) => {
            read.map_err(|_| BackendError::HostUnavailable("CDP WebSocket response timed out".into()))?
                .map(|_| ())
                .map_err(|error| BackendError::HostUnavailable(format!("CDP WebSocket response failed: {error}")))
        }
    }
}

async fn websocket_read_response(
    socket: &mut TcpStream,
    expected_id: u64,
    cancellation: &Cancellation,
) -> Result<Value> {
    loop {
        if cancellation.is_cancelled() {
            return Err(v2_backend_error(ErrorCode::Cancelled, "CDP operation was cancelled", None, None));
        }
        let mut header = [0_u8; 2];
        websocket_read_exact(socket, &mut header, cancellation).await?;
        let opcode = header[0] & 0x0f;
        let masked = header[1] & 0x80 != 0;
        let mut length = u64::from(header[1] & 0x7f);
        if length == 126 {
            let mut extended = [0_u8; 2];
            websocket_read_exact(socket, &mut extended, cancellation).await?;
            length = u64::from(u16::from_be_bytes(extended));
        } else if length == 127 {
            let mut extended = [0_u8; 8];
            websocket_read_exact(socket, &mut extended, cancellation).await?;
            length = u64::from_be_bytes(extended);
        }
        if length > 16 * 1024 * 1024 {
            return Err(BackendError::Protocol("CDP WebSocket frame exceeded 16 MiB".into()));
        }
        let mut mask = [0_u8; 4];
        if masked {
            websocket_read_exact(socket, &mut mask, cancellation).await?;
        }
        let mut payload = vec![0_u8; length as usize];
        websocket_read_exact(socket, &mut payload, cancellation).await?;
        if masked {
            for (index, byte) in payload.iter_mut().enumerate() { *byte ^= mask[index % 4]; }
        }
        if opcode == 8 {
            return Err(BackendError::HostUnavailable("CDP WebSocket closed before response".into()));
        }
        if opcode != 1 { continue; }
        let value: Value = serde_json::from_slice(&payload)
            .map_err(|error| BackendError::Protocol(format!("invalid CDP response JSON: {error}")))?;
        if value.get("id").and_then(Value::as_u64) == Some(expected_id) { return Ok(value); }
    }
}

fn masked_websocket_text_frame(payload: &[u8]) -> Vec<u8> {
    let mask = [0x21_u8, 0x43, 0x65, 0x87];
    let mut frame = vec![0x81];
    match payload.len() {
        length if length <= 125 => frame.push(0x80 | length as u8),
        length if length <= u16::MAX as usize => {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(length as u16).to_be_bytes());
        }
        length => {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(length as u64).to_be_bytes());
        }
    }
    frame.extend_from_slice(&mask);
    frame.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ mask[index % mask.len()]));
    frame
}

fn merge_launch_args(base: &[String], overrides: &[String]) -> Vec<String> {
    let mut merged = base.to_vec();
    for argument in overrides {
        let key = argument.split('=').next().unwrap_or(argument);
        if let Some(index) = merged.iter().position(|existing| existing.split('=').next() == Some(key)) {
            merged[index] = argument.clone();
        } else {
            merged.push(argument.clone());
        }
    }
    merged
}

fn action_name(action: &BrowserAction) -> &'static str {
    match action {
        BrowserAction::Navigate { .. } => "navigate",
        BrowserAction::Click { .. } => "click",
        BrowserAction::Fill { .. } => "fill",
        BrowserAction::Type { .. } => "type",
        BrowserAction::Press { .. } => "press",
        BrowserAction::Select { .. } => "select",
        BrowserAction::Hover { .. } => "hover",
        BrowserAction::Scroll { .. } => "scroll",
        BrowserAction::Drag { .. } => "drag",
        BrowserAction::Upload { .. } => "upload",
        BrowserAction::Download { .. } => "download",
        BrowserAction::Back => "back",
        BrowserAction::Forward => "forward",
        BrowserAction::Reload => "reload",
        BrowserAction::Wait { .. } => "wait",
        BrowserAction::TabNew { .. } => "tab-new",
        BrowserAction::TabClose { .. } => "tab-close",
        BrowserAction::TabFocus { .. } => "tab-focus",
    }
}

fn target(r#ref: &Option<String>, selector: &Option<String>) -> Result<String> {
    match (r#ref, selector) {
        (Some(value), _) => Ok(if value.starts_with('@') { value.clone() } else { format!("@{value}") }),
        (None, Some(value)) => Ok(value.clone()),
        (None, None) => Err(BackendError::Protocol("action requires ref or selector".into())),
    }
}

fn action_args(action: &BrowserAction) -> Result<Vec<String>> {
    Ok(match action {
        BrowserAction::Navigate { url } => vec!["open".into(), url.as_str().into()],
        BrowserAction::Click { r#ref, selector } => vec!["click".into(), target(r#ref, selector)?],
        BrowserAction::Fill { r#ref, selector, text } => vec!["fill".into(), target(r#ref, selector)?, text.clone()],
        BrowserAction::Type { r#ref, selector, text } => vec!["type".into(), target(r#ref, selector)?, text.clone()],
        BrowserAction::Press { key } => vec!["press".into(), key.clone()],
        BrowserAction::Select { r#ref, selector, values } => {
            let mut args = vec!["select".into(), target(r#ref, selector)?];
            args.extend(values.iter().cloned());
            args
        }
        BrowserAction::Hover { r#ref, selector } => vec!["hover".into(), target(r#ref, selector)?],
        BrowserAction::Scroll { direction, amount } => vec![
            "scroll".into(),
            match direction { ScrollDirection::Up => "up", ScrollDirection::Down => "down", ScrollDirection::Left => "left", ScrollDirection::Right => "right" }.into(),
            amount.unwrap_or(500.0).round().to_string(),
        ],
        BrowserAction::Drag { r#ref, target_ref } => vec!["drag".into(), normalize_ref(r#ref), normalize_ref(target_ref)],
        BrowserAction::Upload { r#ref, selector, files } => {
            let mut args = vec!["upload".into(), target(r#ref, selector)?];
            args.extend(files.iter().cloned());
            args
        }
        // Download destinations depend on the browser session, so `act` handles this
        // variant directly instead of using this address-free helper.
        BrowserAction::Download { .. } => return Err(BackendError::Protocol("download action requires an addressed session".into())),
        BrowserAction::Back => vec!["back".into()],
        BrowserAction::Forward => vec!["forward".into()],
        BrowserAction::Reload => vec!["reload".into()],
        BrowserAction::Wait { milliseconds, selector, text } => {
            if let Some(selector) = selector { vec!["wait".into(), selector.clone()] }
            else if let Some(text) = text { vec!["wait".into(), "--text".into(), text.clone()] }
            else { vec!["wait".into(), milliseconds.unwrap_or(250).to_string()] }
        }
        BrowserAction::TabNew { .. } | BrowserAction::TabClose { .. } | BrowserAction::TabFocus { .. } => {
            return Err(BackendError::Protocol("tab actions require stable-to-backend ID resolution".into()));
        }
    })
}

fn debug_args(operation: DebugOperation, args: &BTreeMap<String, Value>) -> Result<Vec<String>> {
    let string_arg = |name: &str| args.get(name).and_then(Value::as_str).map(str::to_owned);
    Ok(match operation {
        DebugOperation::Evaluate => vec![
            "eval".into(),
            string_arg("expression").ok_or_else(|| BackendError::Protocol("evaluate requires expression".into()))?,
        ],
        DebugOperation::Console => vec!["console".into()],
        DebugOperation::Network => {
            let mut command = vec!["network".into(), "requests".into()];
            if let Some(filter) = string_arg("filter") { command.extend(["--filter".into(), filter]); }
            command
        }
        DebugOperation::Html => vec!["get".into(), "html".into(), string_arg("selector").unwrap_or_else(|| "body".into())],
        DebugOperation::Cookies => vec!["cookies".into()],
        DebugOperation::Storage => vec!["storage".into(), string_arg("scope").unwrap_or_else(|| "local".into())],
        DebugOperation::Pdf => {
            let path = string_arg("path").unwrap_or_else(|| std::env::temp_dir().join(format!("pi-web-{}.pdf", Uuid::new_v4())).to_string_lossy().into_owned());
            vec!["pdf".into(), path]
        }
        DebugOperation::RecordStart => {
            let path = string_arg("path").unwrap_or_else(|| std::env::temp_dir().join(format!("pi-web-{}.webm", Uuid::new_v4())).to_string_lossy().into_owned());
            let mut command = vec!["record".into(), "start".into(), path];
            if let Some(url) = string_arg("url") { command.push(url); }
            command
        }
        DebugOperation::RecordStop => vec!["record".into(), "stop".into()],
    })
}

fn normalize_ref(value: &str) -> String {
    if value.starts_with('@') { value.to_owned() } else { format!("@{value}") }
}

fn stable_tab_id(host_id: &HostId, backend_tab_id: &str) -> TabId {
    TabId(Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("pi-web:{}:{backend_tab_id}", host_id.as_ref()).as_bytes(),
    ).to_string())
}

fn parse_json_output(text: &str) -> Option<Value> {
    if text.is_empty() { return None; }
    serde_json::from_str(text).ok().or_else(|| {
        text.lines().rev().find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
    })
}

fn extract_error_message(value: &Value) -> Option<String> {
    for key in ["message", "error", "reason"] {
        if let Some(text) = find_string(value, key) { return Some(text); }
    }
    None
}

fn extract_tabs(value: &Value) -> Vec<BackendTab> {
    let arrays = collect_candidate_arrays(value);
    for array in arrays {
        let mut tabs = Vec::new();
        for (index, item) in array.iter().enumerate() {
            let Some(object) = item.as_object() else { continue; };
            let id = ["tabId", "id", "targetId"]
                .into_iter()
                .find_map(|key| object.get(key).and_then(Value::as_str))
                .map(str::to_owned);
            if let Some(id) = id {
                tabs.push(BackendTab {
                    id,
                    title: ["title", "name"].into_iter().find_map(|key| object.get(key).and_then(Value::as_str)).unwrap_or("").to_owned(),
                    url: object.get("url").and_then(Value::as_str).unwrap_or("about:blank").to_owned(),
                    index: object.get("index").and_then(Value::as_u64).map(|value| value as usize).unwrap_or(index),
                });
            }
        }
        if !tabs.is_empty() { return tabs; }
    }
    Vec::new()
}

fn collect_candidate_arrays(value: &Value) -> Vec<&Vec<Value>> {
    let mut out = Vec::new();
    fn visit<'a>(value: &'a Value, out: &mut Vec<&'a Vec<Value>>) {
        match value {
            Value::Array(array) => { out.push(array); for item in array { visit(item, out); } }
            Value::Object(object) => for child in object.values() { visit(child, out); },
            _ => {}
        }
    }
    visit(value, &mut out);
    out
}

fn extract_controls(value: &Value, include_bounds: bool) -> Vec<InteractiveControl> {
    let refs = find_object(value, "refs").cloned().unwrap_or_default();
    refs.into_iter()
        .filter_map(|(r#ref, value)| {
            let object = value.as_object()?;
            Some(InteractiveControl {
                r#ref,
                role: object.get("role").and_then(Value::as_str).unwrap_or("control").to_owned(),
                name: object.get("name").and_then(Value::as_str).unwrap_or("").to_owned(),
                state: object.get("state").map(value_to_compact_string),
                value: object.get("value").and_then(Value::as_str).map(str::to_owned),
                bounds: if include_bounds { parse_bounds(object.get("bounds")) } else { None },
            })
        })
        .collect()
}

fn parse_bounds(value: Option<&Value>) -> Option<pi_web_protocol::Bounds> {
    let object = value?.as_object()?;
    Some(pi_web_protocol::Bounds {
        x: object.get("x")?.as_f64()?,
        y: object.get("y")?.as_f64()?,
        width: object.get("width")?.as_f64()?,
        height: object.get("height")?.as_f64()?,
    })
}

fn find_object<'a>(value: &'a Value, key: &str) -> Option<&'a Map<String, Value>> {
    match value {
        Value::Object(object) => {
            if let Some(found) = object.get(key).and_then(Value::as_object) { return Some(found); }
            object.values().find_map(|child| find_object(child, key))
        }
        Value::Array(array) => array.iter().find_map(|child| find_object(child, key)),
        _ => None,
    }
}

fn find_string(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(object) => {
            if let Some(found) = object.get(key).and_then(Value::as_str) { return Some(found.to_owned()); }
            object.values().find_map(|child| find_string(child, key))
        }
        Value::Array(array) => array.iter().find_map(|child| find_string(child, key)),
        _ => None,
    }
}

fn extract_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| find_string(value, key))
}

fn find_number(value: &Value, keys: &[&str]) -> Option<u64> {
    match value {
        Value::Object(object) => {
            for key in keys {
                if let Some(number) = object.get(*key).and_then(Value::as_u64) { return Some(number); }
            }
            object.values().find_map(|child| find_number(child, keys))
        }
        Value::Array(array) => array.iter().find_map(|child| find_number(child, keys)),
        _ => None,
    }
}

fn extract_primary_text(value: &Value) -> String {
    extract_string(value, &["snapshot", "markdown", "content", "diff", "text", "output"])
        .unwrap_or_else(|| value_to_compact_string(value))
}

fn compact_backend_summary(value: &Value) -> Value {
    let mut summary = Map::new();
    if let Some(warning) = find_string(value, "warning") { summary.insert("warning".into(), Value::String(warning)); }
    if let Some(path) = find_string(value, "path") { summary.insert("path".into(), Value::String(path)); }
    if let Some(url) = find_string(value, "url") { summary.insert("url".into(), Value::String(url)); }
    if summary.is_empty() { summary.insert("ok".into(), Value::Bool(true)); }
    Value::Object(summary)
}

fn value_to_compact_string(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".into())
}

fn truncate_chars(value: &str, max_chars: usize) -> (String, bool) {
    if max_chars == 0 { return (String::new(), !value.is_empty()); }
    let count = value.chars().count();
    if count <= max_chars { return (value.to_owned(), false); }
    let mut output: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    output.push('…');
    (output, true)
}

fn bounded_lines(value: &str, max_lines: usize, max_chars: usize) -> Vec<String> {
    let mut used = 0;
    value
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || used + line.chars().count() > max_chars { return None; }
            used += line.chars().count();
            Some(line.to_owned())
        })
        .take(max_lines)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_ids_survive_adapter_restart() {
        let host = HostId("host-a".into());
        assert_eq!(stable_tab_id(&host, "t7"), stable_tab_id(&host, "t7"));
        assert_ne!(stable_tab_id(&host, "t7"), stable_tab_id(&host, "t8"));
    }

    #[test]
    fn parses_upstream_snapshot_controls() {
        let value = json!({"success":true,"data":{"snapshot":"- button","refs":{"e1":{"role":"button","name":"Submit"}}}});
        let controls = extract_controls(&value, false);
        assert_eq!(controls.len(), 1);
        assert_eq!(controls[0].r#ref, "e1");
    }

    #[test]
    fn parses_nested_tab_lists() {
        let value = json!({"success":true,"data":{"tabs":[{"tabId":"t1","title":"A","url":"https://a"}]}});
        let tabs = extract_tabs(&value);
        assert_eq!(tabs[0].id, "t1");
    }

    #[test]
    fn profile_args_override_visual_browser_defaults() {
        let merged = merge_launch_args(
            &["--fingerprint-platform=windows".into(), "--fingerprint=12345".into()],
            &["--fingerprint=67890".into(), "--lang=en-US".into()],
        );
        assert_eq!(merged, ["--fingerprint-platform=windows", "--fingerprint=67890", "--lang=en-US"]);
    }

    #[test]
    fn record_debug_operations_use_agent_browser_record_commands() {
        let args = BTreeMap::from([
            ("path".into(), json!("/tmp/capture.webm")),
            ("url".into(), json!("https://example.com")),
        ]);
        assert_eq!(
            debug_args(DebugOperation::RecordStart, &args).unwrap(),
            ["record", "start", "/tmp/capture.webm", "https://example.com"]
        );
        assert_eq!(
            debug_args(DebugOperation::RecordStop, &BTreeMap::new()).unwrap(),
            ["record", "stop"]
        );
    }

    fn test_geometry() -> VisualGeometry {
        VisualGeometry {
            viewport_width: 640,
            viewport_height: 480,
            image_width: 1280,
            image_height: 960,
            device_scale_factor: 2.0,
            scroll_x: 0.0,
            scroll_y: 0.0,
            coordinate_space: "css_viewport_top_left".into(),
        }
    }

    fn test_binding() -> VisualBinding {
        VisualBinding {
            path: RuntimeIdentity {
                path_id: PRODUCT_PATH_ID.into(),
                backend_version: REQUIRED_AGENT_BROWSER_VERSION.into(),
                backend_executable_sha256: REQUIRED_AGENT_BROWSER_SHA256.into(),
                engine: "chrome".into(),
                browser_product: "HeadlessChrome/151".into(),
                engine_generation: "generation-1".into(),
            },
            tab_id: "tab-1".into(),
            sequence: 3,
            captured_at: Utc::now(),
            screenshot_sha256: "a".repeat(64),
            screenshot_path: "/tmp/test.png".into(),
            geometry: test_geometry(),
        }
    }

    #[test]
    fn coordinate_range_is_strict_and_finite() {
        let geometry = test_geometry();
        assert!(validate_action_coordinates(&CuaAction::MouseMove { x: 0.0, y: 0.0 }, &geometry).is_ok());
        assert!(validate_action_coordinates(&CuaAction::MouseMove { x: 639.99, y: 479.99 }, &geometry).is_ok());
        for (x, y) in [(-1.0, 0.0), (0.0, -1.0), (640.0, 0.0), (0.0, 480.0), (f64::NAN, 1.0)] {
            assert!(validate_action_coordinates(&CuaAction::MouseMove { x, y }, &geometry).is_err());
        }
    }

    #[test]
    fn stale_digest_sequence_geometry_and_generation_fail_closed() {
        let address = BrowserAddress {
            agent_id: AgentId("agent-1".into()),
            browser_session_id: BrowserSessionId("session-1".into()),
            tab_id: TabId("tab-1".into()),
        };
        let current = test_binding();
        assert!(validate_visual_binding(&address, &current, &current).is_ok());
        let mut stale = current.clone();
        stale.sequence -= 1;
        assert!(validate_visual_binding(&address, &stale, &current).unwrap_err().to_string().contains("stale_visual_binding"));
        stale = current.clone();
        stale.path.engine_generation = "generation-2".into();
        assert!(validate_visual_binding(&address, &stale, &current).is_err());
        stale = current.clone();
        stale.geometry.viewport_width -= 1;
        assert!(validate_visual_binding(&address, &stale, &current).is_err());
    }

    #[test]
    fn low_level_mouse_composition_is_explicit() {
        let click = cua_command_steps(&CuaAction::Click { x: 180.0, y: 120.0, button: MouseButton::Left });
        assert_eq!(click, vec![
            vec!["mouse", "move", "180", "120"],
            vec!["mouse", "down", "left"],
            vec!["mouse", "up", "left"],
        ]);
        let double = cua_command_steps(&CuaAction::DoubleClick { x: 1.0, y: 2.0, button: MouseButton::Left });
        assert_eq!(double.len(), 5);
        let drag = cua_command_steps(&CuaAction::Drag {
            from_x: 10.0, from_y: 20.0, to_x: 110.0, to_y: 220.0, button: MouseButton::Left,
        });
        assert_eq!(drag.len(), 11);
        assert_eq!(drag.last().unwrap(), &["mouse", "up", "left"]);
        assert_eq!(
            cua_command_steps(&CuaAction::KeyPress { key: "Enter".into() }),
            vec![vec!["press", "Enter"]]
        );
        assert_eq!(
            cua_command_steps(&CuaAction::Text { text: "hello".into() }),
            vec![vec!["keyboard", "inserttext", "hello"]]
        );
    }

    #[test]
    fn png_geometry_and_masked_websocket_frame_are_exact() {
        let mut png = vec![0_u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&1280_u32.to_be_bytes());
        png[20..24].copy_from_slice(&960_u32.to_be_bytes());
        assert_eq!(png_dimensions(&png).unwrap(), (1280, 960));

        let payload = br#"{"type":"input_keyboard"}"#;
        let frame = masked_websocket_text_frame(payload);
        assert_eq!(frame[0], 0x81);
        assert_ne!(frame[1] & 0x80, 0);
        let mask_start = 2;
        let data_start = mask_start + 4;
        let decoded: Vec<u8> = frame[data_start..].iter().enumerate()
            .map(|(index, byte)| byte ^ frame[mask_start + index % 4]).collect();
        assert_eq!(decoded, payload);
    }

    #[tokio::test]
    async fn cancellation_settles_before_dispatch() {
        let cancellation = Cancellation::default();
        cancellation.cancel();
        cancellation.cancelled().await;
        assert!(cancellation.is_cancelled());
    }

    #[test]
    fn capabilities_report_no_unproved_touch_or_engine_fallback() {
        let controller = AgentBrowserController::new("agent-browser").unwrap();
        let capabilities = controller.cua_capabilities();
        assert_eq!(capabilities.path_id, PRODUCT_PATH_ID);
        assert_eq!(path_metadata("generation-1").get("engine"), Some(&json!("chrome")));
        assert_eq!(path_metadata("generation-1").get("backendVersion"), Some(&json!("0.33.1")));
        assert!(!capabilities.touch);
        assert!(capabilities.screenshot_bound);

        let v2 = controller.capabilities_v2();
        assert_eq!(v2.path_id, BrowserPathId::AgentBrowserChrome);
        assert!(!v2.touch);
        assert!(!v2.uploads);
        assert!(!v2.downloads);
        assert!(v2.visual);
        assert!(v2.validate().is_ok());
        assert!(validate_browser_product("HeadlessChrome/151.0.7922.108").is_ok());
        assert!(validate_browser_product("HeadlessChrome/152.0.0.0").is_err());
        assert!(!v2.actions.contains(&ActionKindV2::Upload));
        assert!(!v2.actions.contains(&ActionKindV2::Download));
    }

    #[test]
    fn protocol_v2_visual_actions_keep_guards_and_css_points() {
        let screenshot = ScreenshotBinding {
            artifact_id: ArtifactId::new(),
            sha256: "a".repeat(64),
            sequence: 9,
            captured_at: Utc::now(),
            pixel_width: 1280,
            pixel_height: 960,
            viewport: ViewportBinding {
                viewport_id: ViewportId::new(),
                generation: 3,
                css_width: 640,
                css_height: 480,
                device_scale_factor: 2.0,
                scroll_x: 0.0,
                scroll_y: 0.0,
                coordinate_space: CoordinateSpace::CssViewportTopLeft,
            },
        };
        let guard = VisualGuard {
            viewport_id: screenshot.viewport.viewport_id.clone(),
            viewport_generation: screenshot.viewport.generation,
            screenshot_sha256: screenshot.sha256.clone(),
            screenshot_sequence: screenshot.sequence,
        };
        let action = BrowserActionV2::MouseDown {
            point: pi_web_protocol::CssPoint { x: 180.5, y: 120.5 },
            button: ProtocolMouseButton::Left,
            visual_guard: guard.clone(),
        };
        let (returned_guard, cua) = visual_cua_action(&action).unwrap();
        assert_eq!(returned_guard.screenshot_sequence, guard.screenshot_sequence);
        assert!(validate_protocol_action_points(&action, &screenshot.viewport).is_ok());
        assert_eq!(cua_command_steps(&cua), vec![
            vec!["mouse", "move", "180", "120"],
            vec!["mouse", "down", "left"],
        ]);

        let out_of_range = BrowserActionV2::Click {
            point: pi_web_protocol::CssPoint { x: 640.0, y: 120.0 },
            button: ProtocolMouseButton::Left,
            visual_guard: guard,
        };
        assert!(validate_protocol_action_points(&out_of_range, &screenshot.viewport).is_err());
    }

    #[test]
    fn protocol_v2_rejects_untyped_transfers_and_invalid_refs() {
        assert!(v2_nonvisual_args(&BrowserActionV2::Fill { r#ref: None, text: "x".into() }).is_err());
        assert!(v2_nonvisual_args(&BrowserActionV2::Upload {
            r#ref: "e1".into(), upload_handle_ids: vec![],
        }).is_err());
    }

    #[tokio::test]
    #[ignore = "requires installed agent-browser 0.33.1 and Chromium"]
    async fn protocol_v2_real_visual_action_stale_range_cancel_and_cleanup() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let fixture = tokio::spawn(async move {
            const PAGE: &str = "<!doctype html><html><head><title>V2 fixture</title><style>button{position:fixed;left:100px;top:100px;width:200px;height:100px}input{position:fixed;left:100px;top:250px;width:200px;height:50px}</style></head><body><button onclick=\"document.querySelector('#status').textContent='Clicked';document.title='Clicked'\">Act</button><input aria-label=Editor oninput=\"document.querySelector('#status').textContent=this.value\" onkeydown=\"document.querySelector('#status').textContent='down:'+event.key\" onkeyup=\"document.querySelector('#status').textContent='up:'+event.key\"><div id=status role=status>Ready</div></body></html>";
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break; };
                tokio::spawn(async move {
                    let mut request = [0_u8; 2048];
                    let _ = socket.read(&mut request).await;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        PAGE.len(), PAGE
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        let controller = AgentBrowserController::new("agent-browser").unwrap()
            .with_namespace(format!("piv2-{}", std::process::id()));
        let owner = OwnerIdentity {
            principal_id: pi_web_protocol::PrincipalId::new(),
            agent_id: AgentId::new(),
        };
        let session = BrowserControllerV2::create_session(&controller, CreateSessionRequest {
            owner: owner.clone(),
            path_id: BrowserPathId::AgentBrowserChrome,
            profile_id: None,
        }).await.unwrap();
        let result: Result<()> = async {
            let tab = BrowserControllerV2::create_tab(
                &controller,
                &session,
                Some(&format!("http://127.0.0.1:{port}/")),
            ).await?;
            let address = ProtocolAddress {
                agent_id: owner.agent_id.clone(),
                session_id: session.session_id.clone(),
                tab_id: tab.tab_id.clone(),
                path_id: BrowserPathId::AgentBrowserChrome,
                host_generation: session.path.host_generation,
                engine_generation: session.path.engine_generation,
                control_epoch: tab.control_epoch,
            };
            let visual = BrowserControllerV2::observe_v2(&controller, &tab, BackendOperationRequest {
                operation_id: OperationId::new(),
                address: address.clone(),
                input: ObservationView::Visual,
            }).await?;
            let screenshot = visual.screenshot.ok_or_else(|| BackendError::Protocol("missing v2 screenshot".into()))?;
            let bytes = controller.read_owned_visual_artifact(&owner, &screenshot.artifact_id).await?;
            if png_dimensions(&bytes)? != (screenshot.pixel_width, screenshot.pixel_height) {
                return Err(BackendError::Protocol("v2 screenshot geometry changed".into()));
            }
            let guard = VisualGuard {
                viewport_id: screenshot.viewport.viewport_id.clone(),
                viewport_generation: screenshot.viewport.generation,
                screenshot_sha256: screenshot.sha256.clone(),
                screenshot_sequence: screenshot.sequence,
            };
            let click_operation = OperationId::new();
            let outcome = BrowserControllerV2::act_v2(&controller, &tab, BackendOperationRequest {
                operation_id: click_operation.clone(),
                address: address.clone(),
                input: BrowserActionV2::Click {
                    point: pi_web_protocol::CssPoint { x: 150.0, y: 150.0 },
                    button: ProtocolMouseButton::Left,
                    visual_guard: guard.clone(),
                },
            }).await?;
            if !outcome.dispatched || !outcome.evidence.summary.contains("Clicked") {
                return Err(BackendError::Protocol("v2 action lacks semantic click evidence".into()));
            }
            if BrowserControllerV2::operation(&controller, &click_operation).await?.state != OperationState::Succeeded {
                return Err(BackendError::Protocol("v2 action did not settle succeeded".into()));
            }
            if BrowserControllerV2::act_v2(&controller, &tab, BackendOperationRequest {
                operation_id: OperationId::new(),
                address: address.clone(),
                input: BrowserActionV2::Click {
                    point: pi_web_protocol::CssPoint { x: 150.0, y: 150.0 },
                    button: ProtocolMouseButton::Left,
                    visual_guard: guard,
                },
            }).await.is_ok() {
                return Err(BackendError::Protocol("stale visual action was accepted".into()));
            }

            let second = BrowserControllerV2::observe_v2(&controller, &tab, BackendOperationRequest {
                operation_id: OperationId::new(), address: address.clone(), input: ObservationView::Visual,
            }).await?.screenshot.ok_or_else(|| BackendError::Protocol("missing second screenshot".into()))?;
            let edge_guard = VisualGuard {
                viewport_id: second.viewport.viewport_id.clone(),
                viewport_generation: second.viewport.generation,
                screenshot_sha256: second.sha256,
                screenshot_sequence: second.sequence,
            };
            if BrowserControllerV2::act_v2(&controller, &tab, BackendOperationRequest {
                operation_id: OperationId::new(),
                address: address.clone(),
                input: BrowserActionV2::Click {
                    point: pi_web_protocol::CssPoint { x: f64::from(second.viewport.css_width), y: 120.0 },
                    button: ProtocolMouseButton::Left,
                    visual_guard: edge_guard.clone(),
                },
            }).await.is_ok() {
                return Err(BackendError::Protocol("right-edge coordinate was accepted".into()));
            }
            BrowserControllerV2::act_v2(&controller, &tab, BackendOperationRequest {
                operation_id: OperationId::new(),
                address: address.clone(),
                input: BrowserActionV2::Click {
                    point: pi_web_protocol::CssPoint { x: 150.0, y: 275.0 },
                    button: ProtocolMouseButton::Left,
                    visual_guard: edge_guard,
                },
            }).await?;
            let text = BrowserControllerV2::act_v2(&controller, &tab, BackendOperationRequest {
                operation_id: OperationId::new(), address: address.clone(),
                input: BrowserActionV2::TextInput { text: "typed".into() },
            }).await?;
            if !text.evidence.summary.contains("typed") {
                return Err(BackendError::Protocol("text input lacks semantic evidence".into()));
            }
            let down = BrowserControllerV2::act_v2(&controller, &tab, BackendOperationRequest {
                operation_id: OperationId::new(), address: address.clone(),
                input: BrowserActionV2::KeyDown { key: "Enter".into() },
            }).await?;
            if !down.evidence.summary.contains("down:Enter") {
                return Err(BackendError::Protocol(format!("key down lacks semantic evidence: {}", down.evidence.summary)));
            }
            let up = BrowserControllerV2::act_v2(&controller, &tab, BackendOperationRequest {
                operation_id: OperationId::new(), address: address.clone(),
                input: BrowserActionV2::KeyUp { key: "Enter".into() },
            }).await?;
            if !up.evidence.summary.contains("up:Enter") {
                return Err(BackendError::Protocol("key up lacks semantic evidence".into()));
            }

            let wait_operation = OperationId::new();
            let wait_controller = controller.clone();
            let wait_tab = tab.clone();
            let wait_address = address.clone();
            let wait_id = wait_operation.clone();
            let wait_task = tokio::spawn(async move {
                BrowserControllerV2::act_v2(&wait_controller, &wait_tab, BackendOperationRequest {
                    operation_id: wait_id,
                    address: wait_address,
                    input: BrowserActionV2::Wait { milliseconds: 30_000 },
                }).await
            });
            for _ in 0..100 {
                if controller.v2_operations.contains_key(&wait_operation) { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            let cancellation = BrowserControllerV2::cancel_operation(&controller, &wait_operation).await?;
            if cancellation.outcome != CancellationOutcome::Cancelled || cancellation.state != OperationState::Cancelled {
                return Err(BackendError::Protocol("v2 cancellation did not settle cancelled".into()));
            }
            if wait_task.await.map_err(|error| BackendError::Protocol(error.to_string()))?.is_ok() {
                return Err(BackendError::Protocol("cancelled action returned success".into()));
            }
            Ok(())
        }.await;
        let cleanup = BrowserControllerV2::cleanup_session(&controller, &session).await;
        fixture.abort();
        cleanup.unwrap();
        result.unwrap();
        assert!(controller.v2_sessions.is_empty());
        assert!(controller.v2_tabs.is_empty());
        assert!(controller.v2_artifacts.is_empty());
    }
}
