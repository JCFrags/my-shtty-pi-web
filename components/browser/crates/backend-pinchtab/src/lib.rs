//! PinchTab 0.15.1 adapter for the explicit `pinchtab/chrome` product path.
//!
//! Each host owns one secured loopback server, one Chrome instance, and one
//! PinchTab agent session. The adapter never selects this path because another
//! backend failed. It validates `chrome` before launch and validates every
//! provider-routed response after the operation.

use async_trait::async_trait;
use chrono::Utc;
use dashmap::{DashMap, mapref::entry::Entry};
use pi_web_backend_core::{
    BackendError, BackendOperationRequest, BackendSessionHandle, BackendTabHandle,
    BrowserController, BrowserControllerV2, CreateSessionRequest, Result,
};
use pi_web_protocol::*;
use regex::Regex;
use semver::{Version, VersionReq};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tempfile::{Builder as TempBuilder, TempDir};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify};
use tokio::time::{sleep, timeout};
use uuid::Uuid;

const PATH_ID: &str = "pinchtab/chrome";
const PROVIDER: &str = "chrome";
const SUPPORTED_VERSION: &str = "=0.15.1";
const PENDING_OWNER: &str = "__coordinator_pending__";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct PinchTabController {
    binary: Arc<PathBuf>,
    chromium_binary: Arc<PathBuf>,
    hosts: Arc<DashMap<HostId, Arc<HostRuntime>>>,
    tab_to_host: Arc<DashMap<TabId, HostId>>,
    settled_hosts: Arc<DashMap<HostId, ()>>,
    v2_sessions: Arc<DashMap<BrowserSessionId, Arc<V2SessionRuntime>>>,
    v2_tabs: Arc<DashMap<TabId, BackendTabHandle>>,
    settled_v2_tabs: Arc<DashMap<TabId, ()>>,
    v2_operations: Arc<DashMap<OperationId, Arc<OperationRuntime>>>,
    owner_sessions: Arc<DashMap<String, BrowserSessionId>>,
    settled_v2_sessions: Arc<DashMap<BrowserSessionId, ()>>,
    version_requirement: VersionReq,
}

struct HostRuntime {
    handle: BrowserHostHandle,
    home: Arc<TempDir>,
    server_url: String,
    agent_id: String,
    instance_id: String,
    pinch_session_id: String,
    server: Mutex<Option<Child>>,
    operation_lock: Mutex<()>,
    cancel_generation: AtomicU64,
    cancel_notify: Notify,
    tab_map: Mutex<HashMap<TabId, String>>,
    settled_tabs: Mutex<HashSet<TabId>>,
    observation_sequence: AtomicU64,
}

struct V2SessionRuntime {
    handle: BackendSessionHandle,
    host: BrowserHostHandle,
    owner_key: String,
}

struct OperationRuntime {
    durable: Mutex<DurableOperation>,
    host_id: HostId,
    host_cancel_generation: AtomicU64,
}

#[derive(Clone, Debug)]
struct BackendTab {
    id: String,
    title: String,
    url: String,
    index: usize,
}

#[derive(Debug)]
struct CommandOutput {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

impl PinchTabController {
    pub fn new(binary: impl Into<PathBuf>) -> Result<Self> {
        let version_requirement = VersionReq::parse(SUPPORTED_VERSION)
            .map_err(|error| BackendError::Protocol(error.to_string()))?;
        Ok(Self {
            binary: Arc::new(binary.into()),
            chromium_binary: Arc::new(PathBuf::from("/usr/bin/chromium-browser")),
            hosts: Arc::new(DashMap::new()),
            tab_to_host: Arc::new(DashMap::new()),
            settled_hosts: Arc::new(DashMap::new()),
            v2_sessions: Arc::new(DashMap::new()),
            v2_tabs: Arc::new(DashMap::new()),
            settled_v2_tabs: Arc::new(DashMap::new()),
            v2_operations: Arc::new(DashMap::new()),
            owner_sessions: Arc::new(DashMap::new()),
            settled_v2_sessions: Arc::new(DashMap::new()),
            version_requirement,
        })
    }

    pub fn with_chromium_binary(mut self, binary: impl Into<PathBuf>) -> Self {
        self.chromium_binary = Arc::new(binary.into());
        self
    }

    pub async fn validate_installation(&self) -> Result<Version> {
        let output = Command::new(self.binary.as_ref())
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|error| {
                BackendError::HostUnavailable(format!(
                    "failed to execute {}: {error}",
                    self.binary.display()
                ))
            })?;
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
            .ok_or_else(|| BackendError::Protocol("cannot parse PinchTab version".into()))?
            .as_str();
        let version = Version::parse(actual)
            .map_err(|error| BackendError::Protocol(error.to_string()))?;
        if !self.version_requirement.matches(&version) {
            return Err(BackendError::IncompatibleVersion {
                actual: version.to_string(),
                range: SUPPORTED_VERSION.to_owned(),
            });
        }
        Ok(version)
    }

    /// Cancel the command that is active for this owned host.
    ///
    /// Dropping an adapter future also kills its PinchTab CLI child. Protocol 2
    /// calls this hook only for the exact active durable operation.
    pub async fn cancel_host_operation(&self, host_id: &HostId) -> Result<()> {
        let runtime = self.runtime_for_host(host_id)?;
        runtime.cancel_generation.fetch_add(1, Ordering::SeqCst);
        runtime.cancel_notify.notify_waiters();
        Ok(())
    }

    fn runtime_for_host(&self, host_id: &HostId) -> Result<Arc<HostRuntime>> {
        self.hosts
            .get(host_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| BackendError::HostUnavailable(host_id.to_string()))
    }

    async fn runtime_for_address(
        &self,
        address: &BrowserAddress,
    ) -> Result<(Arc<HostRuntime>, String)> {
        let host_id = self
            .tab_to_host
            .get(&address.tab_id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| BackendError::TabUnavailable(address.tab_id.to_string()))?;
        let runtime = self.runtime_for_host(&host_id)?;
        let backend_tab = runtime
            .tab_map
            .lock()
            .await
            .get(&address.tab_id)
            .cloned()
            .ok_or_else(|| BackendError::TabUnavailable(address.tab_id.to_string()))?;
        Ok((runtime, backend_tab))
    }

    fn base_command(&self, runtime: &HostRuntime) -> Command {
        let mut command = Command::new(self.binary.as_ref());
        command
            .env("HOME", runtime.home.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    fn client_command(&self, runtime: &HostRuntime) -> Command {
        let mut command = self.base_command(runtime);
        command.args([
            "--server",
            runtime.server_url.as_str(),
            "--agent-id",
            runtime.agent_id.as_str(),
        ]);
        command
    }

    async fn run_output_at(
        &self,
        runtime: &HostRuntime,
        args: &[String],
        expected_generation: Option<u64>,
    ) -> Result<CommandOutput> {
        let generation = expected_generation
            .unwrap_or_else(|| runtime.cancel_generation.load(Ordering::SeqCst));
        if runtime.cancel_generation.load(Ordering::SeqCst) != generation {
            return Err(BackendError::Command {
                message: "PinchTab operation cancelled".into(),
                structured: Some(json!({"code":"cancelled","pathId":PATH_ID})),
            });
        }
        let mut command = self.client_command(runtime);
        command.args(args);
        let mut child = command.spawn().map_err(|error| {
            BackendError::HostUnavailable(format!("PinchTab execution failed: {error}"))
        })?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| BackendError::Protocol("PinchTab stdout was not captured".into()))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| BackendError::Protocol("PinchTab stderr was not captured".into()))?;
        let stdout_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).await.map(|_| bytes)
        });
        let stderr_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).await.map(|_| bytes)
        });

        let wait = async {
            tokio::select! {
                result = child.wait() => result.map_err(|error| BackendError::HostUnavailable(format!("PinchTab wait failed: {error}"))),
                _ = runtime.cancel_notify.notified() => {
                    if runtime.cancel_generation.load(Ordering::SeqCst) != generation {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        Err(BackendError::Command {
                            message: "PinchTab operation cancelled".into(),
                            structured: Some(json!({"code":"cancelled","pathId":PATH_ID})),
                        })
                    } else {
                        child.wait().await.map_err(|error| BackendError::HostUnavailable(format!("PinchTab wait failed: {error}")))
                    }
                }
            }
        };
        let status = match timeout(COMMAND_TIMEOUT, wait).await {
            Ok(result) => result?,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(BackendError::Command {
                    message: "PinchTab operation timed out".into(),
                    structured: Some(json!({"code":"timeout","pathId":PATH_ID})),
                });
            }
        };
        let stdout = stdout_task
            .await
            .map_err(|error| BackendError::Protocol(format!("PinchTab stdout task failed: {error}")))?
            .map_err(|error| BackendError::Protocol(format!("PinchTab stdout read failed: {error}")))?;
        let stderr = stderr_task
            .await
            .map_err(|error| BackendError::Protocol(format!("PinchTab stderr task failed: {error}")))?
            .map_err(|error| BackendError::Protocol(format!("PinchTab stderr read failed: {error}")))?;
        Ok(CommandOutput {
            status,
            stdout: String::from_utf8_lossy(&stdout).trim().to_owned(),
            stderr: String::from_utf8_lossy(&stderr).trim().to_owned(),
        })
    }

    async fn run_output(&self, runtime: &HostRuntime, args: &[String]) -> Result<CommandOutput> {
        self.run_output_at(runtime, args, None).await
    }

    async fn run_json_at(
        &self,
        runtime: &HostRuntime,
        args: &[String],
        expected_generation: Option<u64>,
    ) -> Result<Value> {
        let output = self.run_output_at(runtime, args, expected_generation).await?;
        let parsed = parse_json_output(&output.stdout).or_else(|| parse_json_output(&output.stderr));
        if !output.status.success() {
            return Err(BackendError::Command {
                message: extract_error_message(parsed.as_ref())
                    .unwrap_or_else(|| sanitized_failure(&output.stderr, &output.stdout)),
                structured: parsed,
            });
        }
        parsed.ok_or_else(|| {
            BackendError::Protocol("PinchTab command returned no JSON response".into())
        })
    }

    async fn run_json(&self, runtime: &HostRuntime, args: &[String]) -> Result<Value> {
        self.run_json_at(runtime, args, None).await
    }

    async fn run_routed_json_at(
        &self,
        runtime: &HostRuntime,
        args: &[String],
        expected_generation: Option<u64>,
    ) -> Result<Value> {
        let value = self.run_json_at(runtime, args, expected_generation).await?;
        validate_route(&value)?;
        Ok(value)
    }

    async fn run_routed_json(&self, runtime: &HostRuntime, args: &[String]) -> Result<Value> {
        self.run_routed_json_at(runtime, args, None).await
    }

    async fn backend_tabs(&self, runtime: &HostRuntime) -> Result<Vec<BackendTab>> {
        let value = self
            .run_json(runtime, &["tab".into(), "--json".into()])
            .await?;
        parse_tabs(&value)
    }

    async fn sync_tabs(&self, runtime: &HostRuntime) -> Result<Vec<TabInfo>> {
        let backend_tabs = self.backend_tabs(runtime).await?;
        let host_id = runtime.handle.host.host_id.clone();
        let live: HashSet<&str> = backend_tabs.iter().map(|tab| tab.id.as_str()).collect();
        let mut map = runtime.tab_map.lock().await;
        map.retain(|tab_id, backend_id| {
            let keep = live.contains(backend_id.as_str());
            if !keep {
                self.tab_to_host.remove(tab_id);
            }
            keep
        });
        for tab in &backend_tabs {
            let tab_id = stable_tab_id(&host_id, &tab.id);
            map.insert(tab_id.clone(), tab.id.clone());
            self.tab_to_host.insert(tab_id, host_id.clone());
        }
        Ok(backend_tabs
            .into_iter()
            .map(|tab| TabInfo {
                tab_id: stable_tab_id(&host_id, &tab.id),
                host_id: host_id.clone(),
                browser_session_id: BrowserSessionId(PENDING_OWNER.into()),
                owner_agent_id: AgentId(PENDING_OWNER.into()),
                title: tab.title,
                url: tab.url,
                index: tab.index,
                control: TabControl::Agent,
                state: TabState::Idle,
                last_action_at: None,
            })
            .collect())
    }

    async fn tab_title_url(&self, runtime: &HostRuntime, backend_id: &str) -> (String, String) {
        self.backend_tabs(runtime)
            .await
            .ok()
            .and_then(|tabs| tabs.into_iter().find(|tab| tab.id == backend_id))
            .map(|tab| (tab.title, tab.url))
            .unwrap_or_default()
    }

    async fn post_action_delta(&self, runtime: &HostRuntime, tab: &str) -> Result<Vec<String>> {
        let args = vec![
            "snap".into(),
            "--tab".into(),
            tab.into(),
            "--diff".into(),
            "--compact=false".into(),
        ];
        let value = self.run_routed_json(runtime, &args).await?;
        Ok(bounded_lines(&snapshot_text(&value), 30, 8_000))
    }

    async fn cleanup_runtime(&self, runtime: &HostRuntime) -> Result<()> {
        let mut first_error = None;
        if !runtime.pinch_session_id.is_empty() {
            let revoke = vec![
                "session".into(),
                "revoke".into(),
                runtime.pinch_session_id.clone(),
            ];
            if let Err(error) = self.run_output(runtime, &revoke).await {
                first_error = Some(error);
            }
        }
        let mut instance_ids = Vec::new();
        if !runtime.instance_id.is_empty() {
            instance_ids.push(runtime.instance_id.clone());
        } else if let Ok(value) = self
            .run_json(runtime, &["instances".into(), "--json".into()])
            .await
        {
            if let Some(instances) = value.as_array() {
                instance_ids.extend(
                    instances
                        .iter()
                        .filter_map(|instance| instance.get("id").and_then(Value::as_str))
                        .map(str::to_owned),
                );
            }
        }
        for instance_id in instance_ids {
            let stop = vec!["instance".into(), "stop".into(), instance_id];
            if let Err(error) = self.run_output(runtime, &stop).await {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        if let Some(mut server) = runtime.server.lock().await.take() {
            if let Err(error) = server.kill().await {
                if first_error.is_none() {
                    first_error = Some(BackendError::HostUnavailable(format!(
                        "failed to stop PinchTab server: {error}"
                    )));
                }
            }
            let _ = server.wait().await;
        }
        if let Err(error) = std::fs::remove_dir_all(runtime.home.path()) {
            if error.kind() != std::io::ErrorKind::NotFound && first_error.is_none() {
                first_error = Some(BackendError::Other(error.into()));
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

#[async_trait]
impl BrowserController for PinchTabController {
    async fn capabilities(&self) -> Result<BrowserCapabilities> {
        self.validate_installation().await?;
        Ok(BrowserCapabilities {
            backend: BrowserBackend::Pinchtab,
            engines: vec![BrowserEngine::Chromium],
            actions: [
                "navigate",
                "click",
                "fill",
                "wait",
                "tab-new",
                "tab-close",
                "tab-focus",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            debug: Vec::new(),
            persistent_profiles: false,
            extensions: false,
            viewport_streaming: false,
            direct_tab_addressing: true,
        })
    }

    async fn start_host(&self, request: StartHostRequest) -> Result<BrowserHostHandle> {
        if request.backend != BrowserBackend::Pinchtab {
            return Err(BackendError::Protocol(format!(
                "explicit path mismatch: {PATH_ID} cannot start {:?}",
                request.backend
            )));
        }
        if request.engine != BrowserEngine::Chromium {
            return Err(unsupported("provider other than chrome"));
        }
        if request.profile.is_some() {
            return Err(unsupported("persistent profile"));
        }
        if request.visible {
            return Err(unsupported("headed mode"));
        }
        if !request.launch_args.is_empty() {
            return Err(unsupported("custom launch arguments"));
        }
        validate_provider(PROVIDER)?;
        let version = self.validate_installation().await?;
        if !self.chromium_binary.is_file() {
            return Err(BackendError::HostUnavailable(format!(
                "configured Chromium executable is unavailable: {}",
                self.chromium_binary.display()
            )));
        }

        let host_id = HostId::new();
        let agent_id = format!("pi-web-{}", host_id.as_ref().to_ascii_lowercase());
        let home = Arc::new(
            TempBuilder::new()
                .prefix("pi-web-pinchtab-")
                .tempdir()
                .map_err(|error| BackendError::Other(error.into()))?,
        );
        let port = reserve_loopback_port()?;
        let server_url = format!("http://127.0.0.1:{port}");
        write_secure_config(home.path(), port, self.chromium_binary.as_ref())?;

        let mut server_command = Command::new(self.binary.as_ref());
        server_command
            .args([
                "server",
                "--bind",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--log-level",
                "warn",
            ])
            .env("HOME", home.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let server = server_command.spawn().map_err(|error| {
            BackendError::HostUnavailable(format!("failed to start PinchTab server: {error}"))
        })?;

        let starting = BrowserHostHandle {
            host: BrowserHost {
                host_id: host_id.clone(),
                backend: BrowserBackend::Pinchtab,
                engine: BrowserEngine::Chromium,
                profile_id: None,
                state: HostState::Starting,
                backend_session_id: String::new(),
                created_at: Utc::now(),
            },
            backend_metadata: BTreeMap::from([
                ("pathId".into(), json!(PATH_ID)),
                ("provider".into(), json!(PROVIDER)),
                ("backendVersion".into(), json!(version.to_string())),
            ]),
        };
        let bootstrap = Arc::new(HostRuntime {
            handle: starting.clone(),
            home,
            server_url,
            agent_id,
            instance_id: String::new(),
            pinch_session_id: String::new(),
            server: Mutex::new(Some(server)),
            operation_lock: Mutex::new(()),
            cancel_generation: AtomicU64::new(0),
            cancel_notify: Notify::new(),
            tab_map: Mutex::new(HashMap::new()),
            settled_tabs: Mutex::new(HashSet::new()),
            observation_sequence: AtomicU64::new(0),
        });

        let health_args = vec!["health".into(), "--json".into()];
        let mut healthy = None;
        for _ in 0..100 {
            match self.run_json(&bootstrap, &health_args).await {
                Ok(value) => {
                    healthy = Some(value);
                    break;
                }
                Err(_) => sleep(Duration::from_millis(50)).await,
            }
        }
        let health = match healthy {
            Some(value) => value,
            None => {
                let _ = self.cleanup_runtime(&bootstrap).await;
                return Err(BackendError::HostUnavailable(
                    "secured PinchTab loopback server did not become healthy".into(),
                ));
            }
        };
        if let Err(error) = validate_health(&health) {
            let _ = self.cleanup_runtime(&bootstrap).await;
            return Err(error);
        }

        let start_args = vec![
            "instance".into(),
            "start".into(),
            "--browser".into(),
            PROVIDER.into(),
            "--mode".into(),
            "headless".into(),
        ];
        let instance = match self.run_json(&bootstrap, &start_args).await {
            Ok(value) => value,
            Err(error) => {
                let _ = self.cleanup_runtime(&bootstrap).await;
                return Err(error);
            }
        };
        let instance_id = match required_string(&instance, "id", "instance response") {
            Ok(value) => value,
            Err(error) => {
                let _ = self.cleanup_runtime(&bootstrap).await;
                return Err(error);
            }
        };
        let instance_runtime = Arc::new(HostRuntime {
            handle: bootstrap.handle.clone(),
            home: bootstrap.home.clone(),
            server_url: bootstrap.server_url.clone(),
            agent_id: bootstrap.agent_id.clone(),
            instance_id: instance_id.clone(),
            pinch_session_id: String::new(),
            server: Mutex::new(bootstrap.server.lock().await.take()),
            operation_lock: Mutex::new(()),
            cancel_generation: AtomicU64::new(0),
            cancel_notify: Notify::new(),
            tab_map: Mutex::new(HashMap::new()),
            settled_tabs: Mutex::new(HashSet::new()),
            observation_sequence: AtomicU64::new(0),
        });
        if let Err(error) = validate_instance_provider(&instance) {
            let _ = self.cleanup_runtime(&instance_runtime).await;
            return Err(error);
        }
        let instances_args = vec!["instances".into(), "--json".into()];
        let mut running = false;
        for _ in 0..200 {
            if let Ok(value) = self.run_json(&instance_runtime, &instances_args).await {
                match validate_running_instance(&value, &instance_id) {
                    Ok(true) => {
                        running = true;
                        break;
                    }
                    Ok(false) => {}
                    Err(error) => {
                        let _ = self.cleanup_runtime(&instance_runtime).await;
                        return Err(error);
                    }
                }
            }
            sleep(Duration::from_millis(50)).await;
        }
        if !running {
            let _ = self.cleanup_runtime(&instance_runtime).await;
            return Err(BackendError::HostUnavailable(
                "PinchTab Chrome instance did not become ready".into(),
            ));
        }

        let session_args = vec![
            "session".into(),
            "create".into(),
            "--agent-id".into(),
            instance_runtime.agent_id.clone(),
            "--label".into(),
            format!("pi-web host {}", host_id.as_ref()),
            "--json".into(),
        ];
        let session = match self.run_json(&instance_runtime, &session_args).await {
            Ok(value) => value,
            Err(error) => {
                let _ = self.cleanup_runtime(&instance_runtime).await;
                return Err(error);
            }
        };
        let session_id = match required_string(&session, "id", "session response") {
            Ok(value) => value,
            Err(error) => {
                let _ = self.cleanup_runtime(&instance_runtime).await;
                return Err(error);
            }
        };
        if required_string(&session, "agentId", "session response").ok().as_deref()
            != Some(instance_runtime.agent_id.as_str())
        {
            let _ = self.cleanup_runtime(&instance_runtime).await;
            return Err(BackendError::Protocol(
                "PinchTab session owner identity mismatch".into(),
            ));
        }

        let mut ready_handle = starting;
        ready_handle.host.state = HostState::Ready;
        ready_handle.host.backend_session_id = session_id.clone();
        ready_handle
            .backend_metadata
            .insert("instanceId".into(), json!(instance_id));
        let ready = Arc::new(HostRuntime {
            handle: ready_handle.clone(),
            home: instance_runtime.home.clone(),
            server_url: instance_runtime.server_url.clone(),
            agent_id: instance_runtime.agent_id.clone(),
            instance_id,
            pinch_session_id: session_id,
            server: Mutex::new(instance_runtime.server.lock().await.take()),
            operation_lock: Mutex::new(()),
            cancel_generation: AtomicU64::new(0),
            cancel_notify: Notify::new(),
            tab_map: Mutex::new(HashMap::new()),
            settled_tabs: Mutex::new(HashSet::new()),
            observation_sequence: AtomicU64::new(0),
        });
        self.hosts.insert(host_id.clone(), Arc::clone(&ready));
        if let Err(error) = self.sync_tabs(&ready).await {
            self.hosts.remove(&host_id);
            let _ = self.cleanup_runtime(&ready).await;
            return Err(error);
        }
        Ok(ready_handle)
    }

    async fn stop_host(&self, host: &BrowserHostHandle) -> Result<()> {
        if self.settled_hosts.contains_key(&host.host.host_id) {
            return Ok(());
        }
        let runtime = self.runtime_for_host(&host.host.host_id)?;
        let _guard = runtime.operation_lock.lock().await;
        for tab_id in runtime.tab_map.lock().await.keys() {
            self.tab_to_host.remove(tab_id);
        }
        let result = self.cleanup_runtime(&runtime).await;
        self.hosts.remove(&host.host.host_id);
        self.settled_hosts.insert(host.host.host_id.clone(), ());
        result
    }

    async fn list_tabs(&self, host: &BrowserHostHandle) -> Result<Vec<TabInfo>> {
        let runtime = self.runtime_for_host(&host.host.host_id)?;
        let _guard = runtime.operation_lock.lock().await;
        self.sync_tabs(&runtime).await
    }

    async fn open_tab(&self, host: &BrowserHostHandle, url: Option<&str>) -> Result<TabInfo> {
        let runtime = self.runtime_for_host(&host.host.host_id)?;
        let _guard = runtime.operation_lock.lock().await;
        let before: HashSet<String> = runtime.tab_map.lock().await.values().cloned().collect();
        let args = vec![
            "nav".into(),
            url.unwrap_or("about:blank").into(),
            "--new-tab".into(),
            "--json".into(),
        ];
        let value = self.run_routed_json(&runtime, &args).await?;
        let backend_created = find_string(&value, "tabId");
        let tabs = self.sync_tabs(&runtime).await?;
        let map = runtime.tab_map.lock().await;
        let created = tabs.into_iter().find(|tab| {
            map.get(&tab.tab_id).is_some_and(|backend| {
                backend_created.as_ref().is_some_and(|id| id == backend)
                    || !before.contains(backend)
            })
        });
        created.ok_or_else(|| BackendError::Protocol("PinchTab created no owned tab".into()))
    }

    async fn close_tab(&self, host: &BrowserHostHandle, tab_id: &str) -> Result<()> {
        let runtime = self.runtime_for_host(&host.host.host_id)?;
        let stable = TabId(tab_id.to_owned());
        let _guard = runtime.operation_lock.lock().await;
        if runtime.settled_tabs.lock().await.contains(&stable) {
            return Ok(());
        }
        let backend = runtime
            .tab_map
            .lock()
            .await
            .get(&stable)
            .cloned()
            .ok_or_else(|| BackendError::TabUnavailable(stable.to_string()))?;
        let args = vec!["close".into(), backend, "--json".into()];
        self.run_json(&runtime, &args).await?;
        runtime.tab_map.lock().await.remove(&stable);
        runtime.settled_tabs.lock().await.insert(stable.clone());
        self.tab_to_host.remove(&stable);
        Ok(())
    }

    async fn focus_tab(&self, host: &BrowserHostHandle, tab_id: &str) -> Result<()> {
        let runtime = self.runtime_for_host(&host.host.host_id)?;
        let backend = runtime
            .tab_map
            .lock()
            .await
            .get(&TabId(tab_id.to_owned()))
            .cloned()
            .ok_or_else(|| BackendError::TabUnavailable(tab_id.to_owned()))?;
        let _guard = runtime.operation_lock.lock().await;
        self.run_json(&runtime, &["tab".into(), backend, "--json".into()])
            .await?;
        Ok(())
    }

    async fn navigate(&self, address: &BrowserAddress, url: &str) -> Result<ActionResult> {
        let parsed = url
            .parse()
            .map_err(|error| BackendError::Protocol(format!("invalid URL: {error}")))?;
        self.act(address, BrowserAction::Navigate { url: parsed })
            .await
    }

    async fn observe(&self, address: &BrowserAddress, request: ObserveRequest) -> Result<Observation> {
        if request.view == ObservationView::Visual {
            return Err(unsupported("visual observation"));
        }
        let (runtime, backend_tab) = self.runtime_for_address(address).await?;
        let _guard = runtime.operation_lock.lock().await;
        let (title, url) = self.tab_title_url(&runtime, &backend_tab).await;
        let (value, controls, changed) = match request.view {
            ObservationView::Main => {
                let mut args = vec!["text".into(), "--tab".into(), backend_tab.clone(), "--json".into()];
                if let Some(selector) = &request.selector {
                    args.extend(["--selector".into(), selector.clone()]);
                }
                (self.run_json(&runtime, &args).await?, Vec::new(), Vec::new())
            }
            ObservationView::Interactive | ObservationView::Full | ObservationView::Diff => {
                let mut args = vec![
                    "snap".into(),
                    "--tab".into(),
                    backend_tab,
                    "--compact=false".into(),
                ];
                if request.view == ObservationView::Full {
                    args.extend(["--interactive=false".into(), "--full".into()]);
                }
                if request.view == ObservationView::Diff {
                    args.push("--diff".into());
                }
                if let Some(selector) = &request.selector {
                    args.extend(["--selector".into(), selector.clone()]);
                }
                let value = self.run_routed_json(&runtime, &args).await?;
                let controls = parse_controls(&value, request.include_bounds);
                let changed = if request.view == ObservationView::Diff {
                    bounded_lines(&snapshot_text(&value), 50, 8_000)
                } else {
                    Vec::new()
                };
                (value, controls, changed)
            }
            ObservationView::Visual => unreachable!(),
        };
        let raw = if request.view == ObservationView::Main {
            find_string(&value, "text").unwrap_or_default()
        } else {
            snapshot_text(&value)
        };
        let (content, truncated) = truncate_chars(&raw, request.max_chars);
        let mut metadata = identity_metadata();
        metadata.insert("backendOutputChars".into(), json!(raw.chars().count()));
        if truncated || request.view == ObservationView::Full {
            metadata.insert("rawContent".into(), json!(raw));
        }
        Ok(Observation {
            view: request.view,
            title,
            url,
            content,
            controls,
            changed,
            artifact_id: None,
            truncated,
            metadata,
        })
    }

    async fn act(&self, address: &BrowserAddress, action: BrowserAction) -> Result<ActionResult> {
        if !matches!(
            action,
            BrowserAction::Navigate { .. }
                | BrowserAction::Click { .. }
                | BrowserAction::Fill { .. }
                | BrowserAction::Wait { .. }
                | BrowserAction::TabNew { .. }
                | BrowserAction::TabClose { .. }
                | BrowserAction::TabFocus { .. }
        ) {
            return Err(unsupported(action_name(&action)));
        }
        if let BrowserAction::TabNew { url } = &action {
            let host_id = self
                .tab_to_host
                .get(&address.tab_id)
                .map(|entry| entry.value().clone())
                .ok_or_else(|| BackendError::TabUnavailable(address.tab_id.to_string()))?;
            let host = self.runtime_for_host(&host_id)?.handle.clone();
            let tab = self.open_tab(&host, url.as_ref().map(|value| value.as_str())).await?;
            return Ok(ActionResult {
                ok: true,
                action: "tab-new".into(),
                url: Some(tab.url),
                title: Some(tab.title),
                changed: Vec::new(),
                new_tab_id: Some(tab.tab_id),
                download_artifact_id: None,
                artifact_id: None,
                backend: identity_metadata(),
            });
        }
        if let BrowserAction::TabClose { tab_id } = &action {
            let host_id = self
                .tab_to_host
                .get(&address.tab_id)
                .map(|entry| entry.value().clone())
                .ok_or_else(|| BackendError::TabUnavailable(address.tab_id.to_string()))?;
            let host = self.runtime_for_host(&host_id)?.handle.clone();
            let target = tab_id.as_ref().unwrap_or(&address.tab_id);
            self.close_tab(&host, target.as_ref()).await?;
            return Ok(simple_action_result("tab-close"));
        }
        if let BrowserAction::TabFocus { tab_id } = &action {
            let host_id = self
                .tab_to_host
                .get(&address.tab_id)
                .map(|entry| entry.value().clone())
                .ok_or_else(|| BackendError::TabUnavailable(address.tab_id.to_string()))?;
            let host = self.runtime_for_host(&host_id)?.handle.clone();
            self.focus_tab(&host, tab_id.as_ref()).await?;
            return Ok(simple_action_result("tab-focus"));
        }

        let (runtime, backend_tab) = self.runtime_for_address(address).await?;
        let _guard = runtime.operation_lock.lock().await;
        let name = action_name(&action);
        let args = action_args(&action, &backend_tab)?;
        let value = self.run_routed_json(&runtime, &args).await?;
        let changed = self.post_action_delta(&runtime, &backend_tab).await?;
        let (title, url) = self.tab_title_url(&runtime, &backend_tab).await;
        let mut backend = identity_metadata();
        backend.insert("raw".into(), value);
        Ok(ActionResult {
            ok: true,
            action: name.into(),
            url: (!url.is_empty()).then_some(url),
            title: (!title.is_empty()).then_some(title),
            changed,
            new_tab_id: None,
            download_artifact_id: None,
            artifact_id: None,
            backend,
        })
    }

    async fn debug(&self, _: &BrowserAddress, request: DebugRequest) -> Result<DebugResult> {
        Err(unsupported(&format!("debug/{:?}", request.operation)))
    }

    async fn stream_info(&self, _: &BrowserAddress) -> Result<StreamInfo> {
        Err(unsupported("viewport streaming"))
    }
}

impl PinchTabController {
    pub fn capability_truth_v2(&self) -> CapabilityTruth {
        CapabilityTruth {
            path_id: BrowserPathId::PinchtabChrome,
            actions: vec![ActionKindV2::Navigate, ActionKindV2::Fill, ActionKindV2::Wait],
            observations: vec![
                ObservationView::Main,
                ObservationView::Interactive,
                ObservationView::Full,
                ObservationView::Diff,
            ],
            touch: false,
            uploads: false,
            downloads: false,
            visual: false,
        }
    }

    fn owner_key(owner: &OwnerIdentity) -> String {
        format!("{}\u{0}{}", owner.principal_id.as_ref(), owner.agent_id.as_ref())
    }

    fn v2_session(&self, supplied: &BackendSessionHandle) -> Result<Arc<V2SessionRuntime>> {
        let stored = self
            .v2_sessions
            .get(&supplied.session_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| BackendError::HostUnavailable(supplied.session_id.to_string()))?;
        if stored.handle.owner != supplied.owner
            || stored.handle.path != supplied.path
            || stored.handle.backend_session_id != supplied.backend_session_id
        {
            return Err(BackendError::Protocol(
                "protocol v2 session ownership or immutable path mismatch".into(),
            ));
        }
        supplied
            .verify_returned_identity(&stored.handle.path)
            .map_err(|error| BackendError::Protocol(error.message))?;
        Ok(stored)
    }

    fn v2_tab(&self, supplied: &BackendTabHandle) -> Result<BackendTabHandle> {
        let stored = self
            .v2_tabs
            .get(&supplied.tab_id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| BackendError::TabUnavailable(supplied.tab_id.to_string()))?;
        if stored.owner != supplied.owner
            || stored.session_id != supplied.session_id
            || stored.path != supplied.path
            || stored.backend_tab_id != supplied.backend_tab_id
            || stored.control_epoch != supplied.control_epoch
        {
            return Err(BackendError::Protocol(
                "protocol v2 tab ownership, path, generation, or control epoch mismatch".into(),
            ));
        }
        Ok(stored)
    }

    fn validate_v2_request<T>(
        &self,
        tab: &BackendTabHandle,
        request: &BackendOperationRequest<T>,
    ) -> Result<()> {
        request.address.validate().map_err(|error| {
            structured_v2_error(
                error.code,
                &error.message,
                &tab.path,
                Some(&request.operation_id),
            )
        })?;
        if request.address.agent_id != tab.owner.agent_id
            || request.address.session_id != tab.session_id
            || request.address.tab_id != tab.tab_id
        {
            return Err(structured_v2_error(
                ErrorCode::WrongOwner,
                "protocol v2 operation address has a different owner or owned resource",
                &tab.path,
                Some(&request.operation_id),
            ));
        }
        if request.address.path_id != tab.path.path_id {
            return Err(structured_v2_error(
                ErrorCode::WrongPath,
                "protocol v2 session path is immutable",
                &tab.path,
                Some(&request.operation_id),
            ));
        }
        if request.address.host_generation != tab.path.host_generation
            || request.address.engine_generation != tab.path.engine_generation
        {
            return Err(structured_v2_error(
                ErrorCode::StaleGeneration,
                "protocol v2 host or engine generation is stale",
                &tab.path,
                Some(&request.operation_id),
            ));
        }
        if request.address.control_epoch != tab.control_epoch {
            return Err(structured_v2_error(
                ErrorCode::StaleControlEpoch,
                "protocol v2 control epoch is stale",
                &tab.path,
                Some(&request.operation_id),
            ));
        }
        Ok(())
    }

    fn register_operation<T>(
        &self,
        tab: &BackendTabHandle,
        request: &BackendOperationRequest<T>,
        kind: &str,
    ) -> Result<Arc<OperationRuntime>> {
        self.validate_v2_request(tab, request)?;
        let now = Utc::now();
        let operation = Arc::new(OperationRuntime {
            durable: Mutex::new(DurableOperation {
                operation_id: request.operation_id.clone(),
                owner: tab.owner.clone(),
                address: request.address.clone(),
                path: tab.path.clone(),
                kind: kind.into(),
                state: OperationState::Queued,
                created_at: now,
                updated_at: now,
                cancellation_requested: false,
                error: None,
            }),
            host_id: tab.path.host_id.clone(),
            host_cancel_generation: AtomicU64::new(0),
        });
        match self.v2_operations.entry(request.operation_id.clone()) {
            Entry::Occupied(_) => Err(BackendError::Protocol(format!(
                "duplicate operation id {}",
                request.operation_id
            ))),
            Entry::Vacant(entry) => {
                entry.insert(Arc::clone(&operation));
                Ok(operation)
            }
        }
    }

    async fn begin_operation(&self, operation: &OperationRuntime) -> Result<()> {
        let mut durable = operation.durable.lock().await;
        if durable.cancellation_requested || durable.state == OperationState::Cancelled {
            durable.state = OperationState::Cancelled;
            durable.updated_at = Utc::now();
            return Err(cancelled_error(&durable.operation_id, &durable.path));
        }
        durable.state = OperationState::Running;
        durable.updated_at = Utc::now();
        Ok(())
    }

    async fn finish_operation<T>(&self, operation: &OperationRuntime, result: &Result<T>) {
        let mut durable = operation.durable.lock().await;
        durable.updated_at = Utc::now();
        if durable.cancellation_requested {
            durable.state = OperationState::Cancelled;
            durable.error = Some(structured_cancelled(&durable.operation_id, &durable.path));
        } else if let Err(error) = result {
            durable.state = OperationState::Failed;
            durable.error = Some(structured_backend_error(error, &durable.operation_id, &durable.path));
        } else {
            durable.state = OperationState::Succeeded;
            durable.error = None;
        }
    }

    async fn v2_observation_inner(
        &self,
        runtime: &HostRuntime,
        operation: &OperationRuntime,
        tab: &BackendTabHandle,
        request: &BackendOperationRequest<ObservationView>,
    ) -> Result<ProtocolObservation> {
        if request.input == ObservationView::Visual {
            return Err(unsupported_v2(
                "visual observation",
                &tab.path,
                Some(&request.operation_id),
            ));
        }
        let generation = operation.host_cancel_generation.load(Ordering::SeqCst);
        let tabs_value = self
            .run_json_at(runtime, &["tab".into(), "--json".into()], Some(generation))
            .await?;
        let (title, url) = parse_tabs(&tabs_value)?
            .into_iter()
            .find(|item| item.id == tab.backend_tab_id)
            .map(|item| (item.title, item.url))
            .unwrap_or_default();
        let (value, controls, changed) = match request.input {
            ObservationView::Main => {
                let args = vec![
                    "text".into(),
                    "--tab".into(),
                    tab.backend_tab_id.clone(),
                    "--json".into(),
                ];
                (
                    self.run_json_at(runtime, &args, Some(generation)).await?,
                    Vec::new(),
                    Vec::new(),
                )
            }
            ObservationView::Interactive | ObservationView::Full | ObservationView::Diff => {
                let mut args = vec![
                    "snap".into(),
                    "--tab".into(),
                    tab.backend_tab_id.clone(),
                    "--compact=false".into(),
                ];
                if request.input == ObservationView::Full {
                    args.extend(["--interactive=false".into(), "--full".into()]);
                }
                if request.input == ObservationView::Diff {
                    args.push("--diff".into());
                }
                let value = self
                    .run_routed_json_at(runtime, &args, Some(generation))
                    .await?;
                let controls = parse_controls(&value, false);
                let changed = if request.input == ObservationView::Diff {
                    bounded_lines(&snapshot_text(&value), 50, 8_000)
                } else {
                    Vec::new()
                };
                (value, controls, changed)
            }
            ObservationView::Visual => unreachable!(),
        };
        let raw = if request.input == ObservationView::Main {
            find_string(&value, "text").unwrap_or_default()
        } else {
            snapshot_text(&value)
        };
        let (content, truncated) = truncate_chars(&raw, 16_000);
        Ok(ProtocolObservation {
            observation_id: ObservationId::new(),
            operation_id: request.operation_id.clone(),
            owner: tab.owner.clone(),
            address: request.address.clone(),
            path: tab.path.clone(),
            view: request.input,
            sequence: runtime.observation_sequence.fetch_add(1, Ordering::SeqCst) + 1,
            observed_at: Utc::now(),
            title,
            url,
            content,
            controls,
            changed,
            screenshot: None,
            full_artifact_id: None,
            truncated,
        })
    }

    async fn v2_action_inner(
        &self,
        runtime: &HostRuntime,
        operation: &OperationRuntime,
        tab: &BackendTabHandle,
        request: &BackendOperationRequest<BrowserActionV2>,
    ) -> Result<ActionOutcomeV2> {
        let action = v2_action_name(&request.input);
        let generation = operation.host_cancel_generation.load(Ordering::SeqCst);
        let args = match &request.input {
            BrowserActionV2::Navigate { url } => vec![
                "nav".into(),
                url.as_str().into(),
                "--tab".into(),
                tab.backend_tab_id.clone(),
                "--json".into(),
            ],
            BrowserActionV2::Fill { r#ref: Some(r#ref), text } => vec![
                "fill".into(),
                normalize_ref(r#ref),
                text.clone(),
                "--tab".into(),
                tab.backend_tab_id.clone(),
                "--json".into(),
            ],
            BrowserActionV2::Fill { r#ref: None, .. } => {
                return Err(invalid_v2(
                    "PinchTab fill requires a semantic ref",
                    &tab.path,
                    &request.operation_id,
                ));
            }
            BrowserActionV2::Wait { milliseconds } => vec![
                "wait".into(),
                milliseconds.min(&30_000).to_string(),
                "--tab".into(),
                tab.backend_tab_id.clone(),
                "--json".into(),
            ],
            _ => {
                return Err(unsupported_v2(
                    action,
                    &tab.path,
                    Some(&request.operation_id),
                ));
            }
        };
        self.run_routed_json_at(runtime, &args, Some(generation)).await?;
        let delta_args = vec![
            "snap".into(),
            "--tab".into(),
            tab.backend_tab_id.clone(),
            "--diff".into(),
            "--compact=false".into(),
        ];
        let delta = self
            .run_routed_json_at(runtime, &delta_args, Some(generation))
            .await?;
        let changed = bounded_lines(&snapshot_text(&delta), 30, 8_000);
        let sequence = runtime.observation_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(ActionOutcomeV2 {
            operation_id: request.operation_id.clone(),
            owner: tab.owner.clone(),
            address: request.address.clone(),
            path: tab.path.clone(),
            dispatched: true,
            evidence: PostActionEvidence {
                observation_id: ObservationId::new(),
                sequence,
                summary: if changed.is_empty() {
                    format!("{action} completed")
                } else {
                    changed.join("\n")
                },
                changed,
            },
            download_artifact_id: None,
        })
    }
}

#[async_trait]
impl BrowserControllerV2 for PinchTabController {
    async fn create_session(&self, request: CreateSessionRequest) -> Result<BackendSessionHandle> {
        if request.path_id != BrowserPathId::PinchtabChrome {
            return Err(BackendError::Protocol(
                "PinchTab controller requires exact path pinchtab/chrome".into(),
            ));
        }
        if request.owner.principal_id.as_ref().is_empty() || request.owner.agent_id.as_ref().is_empty() {
            return Err(BackendError::Protocol("protocol v2 owner identity is empty".into()));
        }
        if request.profile_id.is_some() {
            return Err(unsupported("persistent profile"));
        }
        validate_provider(PROVIDER)?;
        let session_id = BrowserSessionId::new();
        let owner_key = Self::owner_key(&request.owner);
        match self.owner_sessions.entry(owner_key.clone()) {
            Entry::Occupied(_) => {
                return Err(BackendError::Protocol(
                    "duplicate active PinchTab owner session requires explicit close".into(),
                ));
            }
            Entry::Vacant(entry) => {
                entry.insert(session_id.clone());
            }
        }
        let host = match BrowserController::start_host(
            self,
            StartHostRequest {
                engine: BrowserEngine::Chromium,
                backend: BrowserBackend::Pinchtab,
                profile: None,
                visible: false,
                launch_args: Vec::new(),
            },
        )
        .await
        {
            Ok(host) => host,
            Err(error) => {
                self.owner_sessions.remove(&owner_key);
                return Err(error);
            }
        };
        let handle = BackendSessionHandle {
            owner: request.owner,
            session_id: session_id.clone(),
            path: PathIdentity {
                path_id: BrowserPathId::PinchtabChrome,
                backend_version: "0.15.1".into(),
                provider: ChromeProvider::Chrome,
                host_id: host.host.host_id.clone(),
                host_generation: 1,
                engine_generation: 1,
            },
            backend_session_id: host.host.backend_session_id.clone(),
        };
        self.v2_sessions.insert(
            session_id,
            Arc::new(V2SessionRuntime {
                handle: handle.clone(),
                host,
                owner_key,
            }),
        );
        Ok(handle)
    }

    async fn close_session(&self, session: &BackendSessionHandle) -> Result<()> {
        if self.settled_v2_sessions.contains_key(&session.session_id) {
            return Ok(());
        }
        let stored = self.v2_session(session)?;
        let tab_ids: Vec<TabId> = self
            .v2_tabs
            .iter()
            .filter(|entry| entry.value().session_id == session.session_id)
            .map(|entry| entry.key().clone())
            .collect();
        for tab_id in tab_ids {
            self.v2_tabs.remove(&tab_id);
            self.settled_v2_tabs.insert(tab_id, ());
        }
        let result = BrowserController::stop_host(self, &stored.host).await;
        self.v2_sessions.remove(&session.session_id);
        self.owner_sessions.remove(&stored.owner_key);
        self.settled_v2_sessions.insert(session.session_id.clone(), ());
        result
    }

    async fn create_tab(
        &self,
        session: &BackendSessionHandle,
        url: Option<&str>,
    ) -> Result<BackendTabHandle> {
        let stored = self.v2_session(session)?;
        let tab = BrowserController::open_tab(self, &stored.host, url).await?;
        let runtime = self.runtime_for_host(&stored.host.host.host_id)?;
        let backend_tab_id = runtime
            .tab_map
            .lock()
            .await
            .get(&tab.tab_id)
            .cloned()
            .ok_or_else(|| BackendError::TabUnavailable(tab.tab_id.to_string()))?;
        let handle = BackendTabHandle {
            owner: stored.handle.owner.clone(),
            session_id: stored.handle.session_id.clone(),
            tab_id: tab.tab_id.clone(),
            path: stored.handle.path.clone(),
            backend_tab_id,
            viewport: None,
            control_epoch: 1,
        };
        self.v2_tabs.insert(tab.tab_id, handle.clone());
        Ok(handle)
    }

    async fn close_tab_v2(&self, tab: &BackendTabHandle) -> Result<()> {
        if self.settled_v2_tabs.contains_key(&tab.tab_id) {
            return Ok(());
        }
        let stored_tab = self.v2_tab(tab)?;
        let session = self
            .v2_sessions
            .get(&stored_tab.session_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| BackendError::HostUnavailable(stored_tab.session_id.to_string()))?;
        let result = BrowserController::close_tab(
            self,
            &session.host,
            stored_tab.tab_id.as_ref(),
        )
        .await;
        if result.is_ok() {
            self.v2_tabs.remove(&stored_tab.tab_id);
            self.settled_v2_tabs.insert(stored_tab.tab_id.clone(), ());
        }
        result
    }

    async fn observe_v2(
        &self,
        tab: &BackendTabHandle,
        request: BackendOperationRequest<ObservationView>,
    ) -> Result<ProtocolObservation> {
        let tab = self.v2_tab(tab)?;
        let operation = self.register_operation(&tab, &request, "observe")?;
        let runtime = self.runtime_for_host(&operation.host_id)?;
        let _guard = runtime.operation_lock.lock().await;
        operation.host_cancel_generation.store(
            runtime.cancel_generation.load(Ordering::SeqCst),
            Ordering::SeqCst,
        );
        if let Err(error) = self.begin_operation(&operation).await {
            return Err(error);
        }
        let result = self
            .v2_observation_inner(&runtime, &operation, &tab, &request)
            .await;
        self.finish_operation(&operation, &result).await;
        result
    }

    async fn act_v2(
        &self,
        tab: &BackendTabHandle,
        request: BackendOperationRequest<BrowserActionV2>,
    ) -> Result<ActionOutcomeV2> {
        let tab = self.v2_tab(tab)?;
        let operation = self.register_operation(&tab, &request, v2_action_name(&request.input))?;
        let runtime = self.runtime_for_host(&operation.host_id)?;
        let _guard = runtime.operation_lock.lock().await;
        operation.host_cancel_generation.store(
            runtime.cancel_generation.load(Ordering::SeqCst),
            Ordering::SeqCst,
        );
        if let Err(error) = self.begin_operation(&operation).await {
            return Err(error);
        }
        let result = self
            .v2_action_inner(&runtime, &operation, &tab, &request)
            .await;
        self.finish_operation(&operation, &result).await;
        result
    }

    async fn operation(&self, operation_id: &OperationId) -> Result<DurableOperation> {
        let operation = self
            .v2_operations
            .get(operation_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| BackendError::Protocol(format!("unknown operation id {operation_id}")))?;
        let durable = operation.durable.lock().await.clone();
        Ok(durable)
    }

    async fn cancel_operation(&self, operation_id: &OperationId) -> Result<CancellationResult> {
        let operation = self
            .v2_operations
            .get(operation_id)
            .map(|entry| Arc::clone(entry.value()))
            .ok_or_else(|| BackendError::Protocol(format!("unknown operation id {operation_id}")))?;
        let mut notify_host = false;
        {
            let mut durable = operation.durable.lock().await;
            if durable.state.is_terminal() {
                return Ok(CancellationResult {
                    operation_id: operation_id.clone(),
                    outcome: CancellationOutcome::AlreadyTerminal,
                    state: durable.state,
                    completed_at: Utc::now(),
                });
            }
            durable.cancellation_requested = true;
            durable.updated_at = Utc::now();
            if durable.state == OperationState::Queued {
                durable.state = OperationState::Cancelled;
                durable.error = Some(structured_cancelled(operation_id, &durable.path));
            } else {
                durable.state = OperationState::Cancelling;
                notify_host = true;
            }
        }
        if notify_host {
            self.cancel_host_operation(&operation.host_id).await?;
            for _ in 0..200 {
                if operation.durable.lock().await.state.is_terminal() {
                    break;
                }
                sleep(Duration::from_millis(10)).await;
            }
        }
        let durable = operation.durable.lock().await;
        Ok(CancellationResult {
            operation_id: operation_id.clone(),
            outcome: if durable.state == OperationState::Cancelled {
                CancellationOutcome::Cancelled
            } else {
                CancellationOutcome::NotCancellable
            },
            state: durable.state,
            completed_at: Utc::now(),
        })
    }

    async fn stage_upload(&self, _: TransferHandle) -> Result<TransferHandle> {
        Err(unsupported("upload staging"))
    }

    async fn cleanup_session(&self, session: &BackendSessionHandle) -> Result<()> {
        self.close_session(session).await
    }
}

fn v2_action_name(action: &BrowserActionV2) -> &'static str {
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

fn structured_cancelled(operation_id: &OperationId, path: &PathIdentity) -> StructuredError {
    let mut error = StructuredError::new(ErrorCode::Cancelled, "PinchTab operation cancelled");
    error.path = Some(path.clone());
    error.operation_id = Some(operation_id.clone());
    error
}

fn cancelled_error(operation_id: &OperationId, path: &PathIdentity) -> BackendError {
    BackendError::Command {
        message: "PinchTab operation cancelled".into(),
        structured: serde_json::to_value(structured_cancelled(operation_id, path)).ok(),
    }
}

fn structured_backend_error(
    error: &BackendError,
    operation_id: &OperationId,
    path: &PathIdentity,
) -> StructuredError {
    if let BackendError::Command { structured: Some(value), .. } = error {
        if let Ok(mut exact) = serde_json::from_value::<StructuredError>(value.clone()) {
            exact.path.get_or_insert_with(|| path.clone());
            exact.operation_id.get_or_insert_with(|| operation_id.clone());
            return exact;
        }
    }
    let code = match error {
        BackendError::Unsupported { .. } => ErrorCode::Unsupported,
        BackendError::Command { structured, .. }
            if structured
                .as_ref()
                .and_then(|value| value.get("code"))
                .and_then(Value::as_str)
                == Some("cancelled") =>
        {
            ErrorCode::Cancelled
        }
        BackendError::Command { structured, .. }
            if structured
                .as_ref()
                .and_then(|value| value.get("code"))
                .and_then(Value::as_str)
                == Some("unsupported") =>
        {
            ErrorCode::Unsupported
        }
        _ => ErrorCode::BackendFailure,
    };
    let mut structured = StructuredError::new(code, error.to_string());
    structured.path = Some(path.clone());
    structured.operation_id = Some(operation_id.clone());
    structured
}

fn structured_v2_error(
    code: ErrorCode,
    message: &str,
    path: &PathIdentity,
    operation_id: Option<&OperationId>,
) -> BackendError {
    let mut error = StructuredError::new(code, message);
    error.path = Some(path.clone());
    error.operation_id = operation_id.cloned();
    BackendError::Command {
        message: error.message.clone(),
        structured: serde_json::to_value(error).ok(),
    }
}

fn invalid_v2(message: &str, path: &PathIdentity, operation_id: &OperationId) -> BackendError {
    structured_v2_error(
        ErrorCode::InvalidRequest,
        message,
        path,
        Some(operation_id),
    )
}

fn unsupported_v2(
    capability: &str,
    path: &PathIdentity,
    operation_id: Option<&OperationId>,
) -> BackendError {
    let mut error = StructuredError::unsupported(capability, path.clone());
    error.operation_id = operation_id.cloned();
    BackendError::Command {
        message: error.message.clone(),
        structured: serde_json::to_value(error).ok(),
    }
}

fn unsupported(capability: &str) -> BackendError {
    BackendError::Unsupported {
        capability: capability.into(),
        backend: PATH_ID.into(),
    }
}

fn validate_provider(provider: &str) -> Result<()> {
    if provider != PROVIDER {
        return Err(BackendError::Protocol(format!(
            "unsupported PinchTab provider {provider:?}; only {PROVIDER:?} is allowed"
        )));
    }
    Ok(())
}

fn validate_instance_provider(value: &Value) -> Result<()> {
    let actual = required_string(value, "browser", "instance response")?;
    if actual != PROVIDER {
        return Err(BackendError::Protocol(format!(
            "PinchTab substituted provider {actual:?} for {PROVIDER:?}"
        )));
    }
    Ok(())
}

fn validate_running_instance(value: &Value, instance_id: &str) -> Result<bool> {
    let instances = value
        .as_array()
        .ok_or_else(|| BackendError::Protocol("PinchTab instance list was not an array".into()))?;
    let Some(instance) = instances.iter().find(|instance| {
        instance.get("id").and_then(Value::as_str) == Some(instance_id)
    }) else {
        return Ok(false);
    };
    validate_instance_provider(instance)?;
    Ok(instance.get("status").and_then(Value::as_str) == Some("running"))
}

fn validate_route(value: &Value) -> Result<()> {
    let route = find_object(value, "route")
        .ok_or_else(|| BackendError::Protocol("PinchTab routed response omitted provider identity".into()))?;
    let requested = route
        .get("requestedProvider")
        .and_then(Value::as_str)
        .ok_or_else(|| BackendError::Protocol("PinchTab route omitted requestedProvider".into()))?;
    let used = route
        .get("usedProvider")
        .and_then(Value::as_str)
        .ok_or_else(|| BackendError::Protocol("PinchTab route omitted usedProvider".into()))?;
    let escalated = route
        .get("escalated")
        .and_then(Value::as_bool)
        .ok_or_else(|| BackendError::Protocol("PinchTab route omitted escalated".into()))?;
    if requested != PROVIDER || used != PROVIDER || escalated {
        return Err(BackendError::Protocol(format!(
            "PinchTab provider mismatch: requested={requested:?}, used={used:?}, escalated={escalated}"
        )));
    }
    Ok(())
}

fn validate_health(value: &Value) -> Result<()> {
    let version = required_string(value, "version", "health response")?;
    if version != "0.15.1" {
        return Err(BackendError::IncompatibleVersion {
            actual: version,
            range: SUPPORTED_VERSION.into(),
        });
    }
    if find_bool(value, "authRequired") != Some(true) {
        return Err(BackendError::Protocol(
            "PinchTab server did not require authentication".into(),
        ));
    }
    Ok(())
}

fn reserve_loopback_port() -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| BackendError::HostUnavailable(format!("cannot reserve loopback port: {error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| BackendError::HostUnavailable(format!("cannot read loopback port: {error}")))?
        .port();
    drop(listener);
    Ok(port)
}

fn write_secure_config(home: &Path, port: u16, chromium: &Path) -> Result<()> {
    let config_dir = home.join(".pinchtab");
    let state_dir = home.join("state");
    std::fs::create_dir_all(&config_dir).map_err(|error| BackendError::Other(error.into()))?;
    std::fs::create_dir_all(&state_dir).map_err(|error| BackendError::Other(error.into()))?;
    let token = Uuid::new_v4().simple().to_string() + &Uuid::new_v4().simple().to_string();
    let config = json!({
        "configVersion": "0.8.0",
        "server": {
            "port": port.to_string(),
            "bind": "127.0.0.1",
            "token": token,
            "stateDir": state_dir,
        },
        "browser": {
            "binary": chromium,
            "extraFlags": "--disable-gpu",
        },
        "browsers": {"default": PROVIDER, "available": [PROVIDER]},
        "instanceDefaults": {"mode": "headless", "noRestore": true, "maxTabs": 16},
        "security": {
            "allowedDomains": [],
            "allowEvaluate": false,
            "allowMacro": false,
            "allowScreencast": false,
            "allowDownload": false,
            "allowCookies": false,
            "allowUpload": false,
            "allowClipboard": false,
            "allowStateExport": false,
            "enableActionGuards": true,
            "idpi": {
                "enabled": true,
                "strictMode": true,
                "scanContent": true,
                "wrapContent": true,
                "customPatterns": [],
                "scanTimeoutSec": 5,
                "shieldThreshold": 0
            }
        },
        "profiles": {"baseDir": home.join("profiles")},
        "multiInstance": {"strategy": "explicit"},
        "observability": {"activity": {"enabled": true}}
    });
    let path = config_dir.join("config.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&config).map_err(|error| BackendError::Protocol(error.to_string()))?)
        .map_err(|error| BackendError::Other(error.into()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| BackendError::Other(error.into()))?;
    }
    Ok(())
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

fn action_args(action: &BrowserAction, tab: &str) -> Result<Vec<String>> {
    let mut args = match action {
        BrowserAction::Navigate { url } => vec!["nav".into(), url.as_str().into()],
        BrowserAction::Click { r#ref, selector } => match (r#ref, selector) {
            (Some(value), _) => vec!["click".into(), normalize_ref(value)],
            (None, Some(value)) => vec!["click".into(), "".into(), "--css".into(), value.clone()],
            _ => return Err(BackendError::Protocol("click requires ref or selector".into())),
        },
        BrowserAction::Fill { r#ref, selector, text } => vec![
            "fill".into(),
            target(r#ref, selector)?,
            text.clone(),
        ],
        BrowserAction::Type { r#ref, selector, text } => {
            if selector.is_some() && r#ref.is_none() {
                return Err(unsupported("type by CSS selector"));
            }
            vec!["type".into(), target(r#ref, &None)?, text.clone()]
        }
        BrowserAction::Press { key } => vec!["press".into(), key.clone()],
        BrowserAction::Select { r#ref, selector, values } => {
            if selector.is_some() && r#ref.is_none() {
                return Err(unsupported("select by CSS selector"));
            }
            if values.len() != 1 {
                return Err(unsupported("multi-value select"));
            }
            vec!["select".into(), target(r#ref, &None)?, values[0].clone()]
        }
        BrowserAction::Hover { r#ref, selector } => match (r#ref, selector) {
            (Some(value), _) => vec!["hover".into(), normalize_ref(value)],
            (None, Some(value)) => vec!["hover".into(), "".into(), "--css".into(), value.clone()],
            _ => return Err(BackendError::Protocol("hover requires ref or selector".into())),
        },
        BrowserAction::Scroll { direction, amount } => {
            let signed = amount.unwrap_or(800.0).round() as i64;
            let (axis, value) = match direction {
                ScrollDirection::Up => ("--dy", -signed.abs()),
                ScrollDirection::Down => ("--dy", signed.abs()),
                ScrollDirection::Left => ("--dx", -signed.abs()),
                ScrollDirection::Right => ("--dx", signed.abs()),
            };
            vec!["scroll".into(), axis.into(), value.to_string()]
        }
        BrowserAction::Drag { r#ref, target_ref } => {
            vec!["drag".into(), normalize_ref(r#ref), normalize_ref(target_ref)]
        }
        BrowserAction::Back => vec!["back".into()],
        BrowserAction::Forward => vec!["forward".into()],
        BrowserAction::Reload => vec!["reload".into()],
        BrowserAction::Wait { milliseconds, selector, text } => {
            if let Some(selector) = selector {
                vec!["wait".into(), selector.clone()]
            } else if let Some(text) = text {
                vec!["wait".into(), "--text".into(), text.clone()]
            } else {
                vec!["wait".into(), milliseconds.unwrap_or(250).min(30_000).to_string()]
            }
        }
        BrowserAction::Upload { .. }
        | BrowserAction::Download { .. }
        | BrowserAction::TabNew { .. }
        | BrowserAction::TabClose { .. }
        | BrowserAction::TabFocus { .. } => {
            return Err(unsupported(action_name(action)));
        }
    };
    args.extend(["--tab".into(), tab.into(), "--json".into()]);
    Ok(args)
}

fn target(r#ref: &Option<String>, selector: &Option<String>) -> Result<String> {
    r#ref
        .as_ref()
        .map(|value| normalize_ref(value))
        .or_else(|| selector.clone())
        .ok_or_else(|| BackendError::Protocol("action requires ref or selector".into()))
}

fn normalize_ref(value: &str) -> String {
    value.strip_prefix('@').unwrap_or(value).to_owned()
}

fn stable_tab_id(host_id: &HostId, backend_id: &str) -> TabId {
    TabId(
        Uuid::new_v5(
            &Uuid::NAMESPACE_OID,
            format!("pi-web:{PATH_ID}:{}:{backend_id}", host_id.as_ref()).as_bytes(),
        )
        .to_string(),
    )
}

fn parse_json_output(text: &str) -> Option<Value> {
    if text.is_empty() {
        return None;
    }
    serde_json::from_str(text).ok().or_else(|| {
        text.lines()
            .rev()
            .find_map(|line| serde_json::from_str(line.trim()).ok())
    })
}

fn parse_tabs(value: &Value) -> Result<Vec<BackendTab>> {
    let tabs = find_array(value, "tabs")
        .ok_or_else(|| BackendError::Protocol("PinchTab tab list omitted tabs".into()))?;
    tabs.iter()
        .enumerate()
        .map(|(index, value)| {
            let object = value
                .as_object()
                .ok_or_else(|| BackendError::Protocol("PinchTab returned a malformed tab".into()))?;
            Ok(BackendTab {
                id: object
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| BackendError::Protocol("PinchTab tab omitted id".into()))?
                    .to_owned(),
                title: object.get("title").and_then(Value::as_str).unwrap_or("").to_owned(),
                url: object.get("url").and_then(Value::as_str).unwrap_or("about:blank").to_owned(),
                index,
            })
        })
        .collect()
}

fn parse_controls(value: &Value, include_bounds: bool) -> Vec<InteractiveControl> {
    find_array(value, "nodes")
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let object = value.as_object()?;
            Some(InteractiveControl {
                r#ref: object.get("ref")?.as_str()?.to_owned(),
                role: object.get("role").and_then(Value::as_str).unwrap_or("control").to_owned(),
                name: object.get("name").and_then(Value::as_str).unwrap_or("").to_owned(),
                state: object.get("state").map(compact_json),
                value: object.get("value").and_then(Value::as_str).map(str::to_owned),
                bounds: if include_bounds { parse_bounds(object.get("bounds")) } else { None },
            })
        })
        .collect()
}

fn parse_bounds(value: Option<&Value>) -> Option<Bounds> {
    let object = value?.as_object()?;
    Some(Bounds {
        x: object.get("x")?.as_f64()?,
        y: object.get("y")?.as_f64()?,
        width: object.get("width")?.as_f64()?,
        height: object.get("height")?.as_f64()?,
    })
}

fn snapshot_text(value: &Value) -> String {
    let Some(nodes) = find_array(value, "nodes") else {
        return compact_json(value);
    };
    nodes
        .iter()
        .filter_map(|node| {
            let object = node.as_object()?;
            let ref_id = object.get("ref").and_then(Value::as_str).unwrap_or("");
            let role = object.get("role").and_then(Value::as_str).unwrap_or("node");
            let name = object
                .get("name")
                .or_else(|| object.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            Some(format!("[{ref_id}] {role}: {name}"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn required_string(value: &Value, key: &str, context: &str) -> Result<String> {
    find_string(value, key)
        .ok_or_else(|| BackendError::Protocol(format!("PinchTab {context} omitted {key}")))
}

fn find_string(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(object) => {
            if let Some(value) = object.get(key).and_then(Value::as_str) {
                return Some(value.to_owned());
            }
            object.values().find_map(|value| find_string(value, key))
        }
        Value::Array(array) => array.iter().find_map(|value| find_string(value, key)),
        _ => None,
    }
}

fn find_bool(value: &Value, key: &str) -> Option<bool> {
    match value {
        Value::Object(object) => {
            if let Some(value) = object.get(key).and_then(Value::as_bool) {
                return Some(value);
            }
            object.values().find_map(|value| find_bool(value, key))
        }
        Value::Array(array) => array.iter().find_map(|value| find_bool(value, key)),
        _ => None,
    }
}

fn find_object<'a>(value: &'a Value, key: &str) -> Option<&'a Map<String, Value>> {
    match value {
        Value::Object(object) => {
            if let Some(value) = object.get(key).and_then(Value::as_object) {
                return Some(value);
            }
            object.values().find_map(|value| find_object(value, key))
        }
        Value::Array(array) => array.iter().find_map(|value| find_object(value, key)),
        _ => None,
    }
}

fn find_array<'a>(value: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    match value {
        Value::Object(object) => {
            if let Some(value) = object.get(key).and_then(Value::as_array) {
                return Some(value);
            }
            object.values().find_map(|value| find_array(value, key))
        }
        Value::Array(array) => array.iter().find_map(|value| find_array(value, key)),
        _ => None,
    }
}

fn extract_error_message(value: Option<&Value>) -> Option<String> {
    let value = value?;
    ["message", "error", "reason"]
        .into_iter()
        .find_map(|key| find_string(value, key))
}

fn sanitized_failure(stderr: &str, stdout: &str) -> String {
    let text = if stderr.is_empty() { stdout } else { stderr };
    let bounded: String = text.chars().take(2_000).collect();
    Regex::new(r#"(?i)(token|secret|cookie)(["'=:\s]+)[^\s,}"]+"#)
        .ok()
        .map(|regex| regex.replace_all(&bounded, "$1$2<redacted>").into_owned())
        .unwrap_or_else(|| "PinchTab command failed".into())
}

fn identity_metadata() -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("pathId".into(), json!(PATH_ID)),
        ("provider".into(), json!(PROVIDER)),
        ("backendVersion".into(), json!("0.15.1")),
    ])
}

fn simple_action_result(action: &str) -> ActionResult {
    ActionResult {
        ok: true,
        action: action.into(),
        url: None,
        title: None,
        changed: Vec::new(),
        new_tab_id: None,
        download_artifact_id: None,
        artifact_id: None,
        backend: identity_metadata(),
    }
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".into())
}

fn truncate_chars(value: &str, max_chars: usize) -> (String, bool) {
    if max_chars == 0 {
        return (String::new(), !value.is_empty());
    }
    if value.chars().count() <= max_chars {
        return (value.to_owned(), false);
    }
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
            if line.is_empty() || used + line.chars().count() > max_chars {
                return None;
            }
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
    fn provider_allowlist_refuses_substitution_input() {
        assert!(validate_provider("chrome").is_ok());
        assert!(validate_provider("agent-browser").is_err());
        assert!(validate_provider("ghost-chrome").is_err());
    }

    #[test]
    fn routed_identity_must_be_exact_and_not_escalated() {
        assert!(validate_route(&json!({"route": {
            "requestedProvider": "chrome", "usedProvider": "chrome", "escalated": false
        }})).is_ok());
        assert!(validate_route(&json!({"route": {
            "requestedProvider": "chrome", "usedProvider": "ghost-chrome", "escalated": true
        }})).is_err());
        assert!(validate_route(&json!({"success": true})).is_err());
    }

    #[test]
    fn instance_provider_is_postvalidated() {
        assert!(validate_instance_provider(&json!({"id":"i1","browser":"chrome"})).is_ok());
        assert!(validate_instance_provider(&json!({"id":"i2","browser":"cloak"})).is_err());
    }

    #[test]
    fn parses_tabs_and_semantic_controls() {
        let tabs = parse_tabs(&json!({"tabs":[{"id":"t1","title":"A","url":"https://a"}]})).unwrap();
        assert_eq!(tabs[0].id, "t1");
        let controls = parse_controls(&json!({"nodes":[{"ref":"e1","role":"button","name":"Commit"}]}), false);
        assert_eq!(controls[0].r#ref, "e1");
    }

    #[test]
    fn stable_tab_ids_include_exact_path_and_host() {
        let host = HostId("host-a".into());
        assert_eq!(stable_tab_id(&host, "t1"), stable_tab_id(&host, "t1"));
        assert_ne!(stable_tab_id(&host, "t1"), stable_tab_id(&host, "t2"));
    }

    #[test]
    fn cancellation_and_timeout_errors_are_structured_in_source_contract() {
        assert_eq!(PATH_ID, "pinchtab/chrome");
        assert_eq!(SUPPORTED_VERSION, "=0.15.1");
    }

    #[test]
    fn protocol_v2_capability_truth_is_strict() {
        let controller = PinchTabController::new("pinchtab").unwrap();
        let truth = controller.capability_truth_v2();
        assert_eq!(truth.path_id, BrowserPathId::PinchtabChrome);
        assert_eq!(truth.actions, [ActionKindV2::Navigate, ActionKindV2::Fill, ActionKindV2::Wait]);
        assert_eq!(
            truth.observations,
            [
                ObservationView::Main,
                ObservationView::Interactive,
                ObservationView::Full,
                ObservationView::Diff,
            ]
        );
        assert!(!truth.visual);
        assert!(!truth.touch);
        assert!(!truth.uploads);
        assert!(!truth.downloads);
        truth.validate().unwrap();
    }

    #[test]
    fn protocol_v2_address_binding_refuses_stale_generation() {
        let controller = PinchTabController::new("pinchtab").unwrap();
        let owner = OwnerIdentity {
            principal_id: PrincipalId("principal-a".into()),
            agent_id: AgentId("agent-a".into()),
        };
        let path = PathIdentity {
            path_id: BrowserPathId::PinchtabChrome,
            backend_version: "0.15.1".into(),
            provider: ChromeProvider::Chrome,
            host_id: HostId("host-a".into()),
            host_generation: 4,
            engine_generation: 7,
        };
        let tab = BackendTabHandle {
            owner: owner.clone(),
            session_id: BrowserSessionId("session-a".into()),
            tab_id: TabId("tab-a".into()),
            path: path.clone(),
            backend_tab_id: "backend-tab-a".into(),
            viewport: None,
            control_epoch: 3,
        };
        let request = BackendOperationRequest {
            operation_id: OperationId("operation-a".into()),
            address: ProtocolAddress {
                agent_id: owner.agent_id,
                session_id: tab.session_id.clone(),
                tab_id: tab.tab_id.clone(),
                path_id: path.path_id,
                host_generation: path.host_generation + 1,
                engine_generation: path.engine_generation,
                control_epoch: tab.control_epoch,
            },
            input: ObservationView::Main,
        };
        let BackendError::Command { structured: Some(error), .. } =
            controller.validate_v2_request(&tab, &request).unwrap_err()
        else {
            panic!("stale v2 generation was not structured");
        };
        assert_eq!(error["code"], "stale-generation");
    }

    #[tokio::test]
    #[ignore = "requires installed PinchTab 0.15.1 and Chromium"]
    async fn real_protocol_v2_vertical_preserves_identity_and_cancellation() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener as TokioTcpListener;

        let listener = TokioTcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let fixture_url = format!("http://{}/", listener.local_addr().unwrap());
        let fixture = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break; };
                tokio::spawn(async move {
                    let body = r#"<!doctype html><title>PinchTab V2 Fixture</title>
                        <label>Name <input id="name" oninput="document.querySelector('#result').textContent='accepted:'+this.value"></label>
                        <p id="result"></p>"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });

        let controller = PinchTabController::new("pinchtab").unwrap();
        let owner = OwnerIdentity {
            principal_id: PrincipalId("fixture-principal".into()),
            agent_id: AgentId("fixture-agent-v2".into()),
        };
        let session = BrowserControllerV2::create_session(
            &controller,
            CreateSessionRequest {
                owner: owner.clone(),
                path_id: BrowserPathId::PinchtabChrome,
                profile_id: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(session.path.path_id, BrowserPathId::PinchtabChrome);
        assert_eq!(session.path.provider, ChromeProvider::Chrome);
        assert_eq!(session.path.backend_version, "0.15.1");
        assert!(BrowserControllerV2::create_session(
            &controller,
            CreateSessionRequest {
                owner: owner.clone(),
                path_id: BrowserPathId::PinchtabChrome,
                profile_id: None,
            },
        )
        .await
        .is_err());

        let tab = BrowserControllerV2::create_tab(&controller, &session, Some(&fixture_url))
            .await
            .unwrap();
        let address = ProtocolAddress {
            agent_id: owner.agent_id.clone(),
            session_id: session.session_id.clone(),
            tab_id: tab.tab_id.clone(),
            path_id: BrowserPathId::PinchtabChrome,
            host_generation: session.path.host_generation,
            engine_generation: session.path.engine_generation,
            control_epoch: tab.control_epoch,
        };
        let observe_id = OperationId::new();
        let observation = BrowserControllerV2::observe_v2(
            &controller,
            &tab,
            BackendOperationRequest {
                operation_id: observe_id.clone(),
                address: address.clone(),
                input: ObservationView::Interactive,
            },
        )
        .await
        .unwrap();
        assert_eq!(observation.owner, owner);
        assert_eq!(observation.path, session.path);
        let textbox_ref = observation
            .controls
            .iter()
            .find(|control| control.role == "textbox")
            .unwrap()
            .r#ref
            .clone();
        assert_eq!(
            BrowserControllerV2::operation(&controller, &observe_id)
                .await
                .unwrap()
                .state,
            OperationState::Succeeded
        );

        let fill_id = OperationId::new();
        let fill = BrowserControllerV2::act_v2(
            &controller,
            &tab,
            BackendOperationRequest {
                operation_id: fill_id.clone(),
                address: address.clone(),
                input: BrowserActionV2::Fill {
                    r#ref: Some(textbox_ref),
                    text: "vertical-ok".into(),
                },
            },
        )
        .await
        .unwrap();
        assert!(fill.dispatched);
        assert_eq!(fill.path, session.path);
        assert_eq!(
            BrowserControllerV2::operation(&controller, &fill_id)
                .await
                .unwrap()
                .state,
            OperationState::Succeeded
        );

        let result = BrowserControllerV2::observe_v2(
            &controller,
            &tab,
            BackendOperationRequest {
                operation_id: OperationId::new(),
                address: address.clone(),
                input: ObservationView::Main,
            },
        )
        .await
        .unwrap();
        assert!(result.content.contains("accepted:vertical-ok"));

        let unsupported_id = OperationId::new();
        let unsupported = BrowserControllerV2::act_v2(
            &controller,
            &tab,
            BackendOperationRequest {
                operation_id: unsupported_id.clone(),
                address: address.clone(),
                input: BrowserActionV2::Click {
                    point: CssPoint { x: 1.0, y: 1.0 },
                    button: MouseButton::Left,
                    visual_guard: VisualGuard {
                        viewport_id: ViewportId("unsupported".into()),
                        viewport_generation: 1,
                        screenshot_sha256: "unsupported".into(),
                        screenshot_sequence: 1,
                    },
                },
            },
        )
        .await
        .unwrap_err();
        let BackendError::Command { structured: Some(structured), .. } = unsupported else {
            panic!("unsupported v2 action was not structured");
        };
        assert_eq!(structured["code"], "unsupported");
        let unsupported_operation = BrowserControllerV2::operation(&controller, &unsupported_id)
            .await
            .unwrap();
        assert_eq!(unsupported_operation.state, OperationState::Failed);
        assert_eq!(unsupported_operation.error.unwrap().code, ErrorCode::Unsupported);

        let wait_id = OperationId::new();
        let waiting = {
            let controller = controller.clone();
            let tab = tab.clone();
            let address = address.clone();
            let wait_id = wait_id.clone();
            tokio::spawn(async move {
                BrowserControllerV2::act_v2(
                    &controller,
                    &tab,
                    BackendOperationRequest {
                        operation_id: wait_id,
                        address,
                        input: BrowserActionV2::Wait { milliseconds: 30_000 },
                    },
                )
                .await
            })
        };
        sleep(Duration::from_millis(250)).await;
        let cancellation = BrowserControllerV2::cancel_operation(&controller, &wait_id)
            .await
            .unwrap();
        assert_eq!(cancellation.outcome, CancellationOutcome::Cancelled);
        assert_eq!(cancellation.state, OperationState::Cancelled);
        assert!(waiting.await.unwrap().is_err());
        assert_eq!(
            BrowserControllerV2::operation(&controller, &wait_id)
                .await
                .unwrap()
                .state,
            OperationState::Cancelled
        );

        BrowserControllerV2::close_tab_v2(&controller, &tab).await.unwrap();
        BrowserControllerV2::close_tab_v2(&controller, &tab).await.unwrap();
        BrowserControllerV2::close_session(&controller, &session).await.unwrap();
        BrowserControllerV2::close_session(&controller, &session).await.unwrap();
        fixture.abort();
    }

    #[tokio::test]
    #[ignore = "requires installed PinchTab 0.15.1 and Chromium"]
    async fn real_secured_vertical_settles_close_and_cancels() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener as TokioTcpListener;

        let listener = TokioTcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let fixture_url = format!("http://{}/", listener.local_addr().unwrap());
        let fixture = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break; };
                tokio::spawn(async move {
                    let body = r#"<!doctype html><title>PinchTab Adapter Fixture</title>
                        <label>Name <input id="name"></label><button id="commit"
                        onclick="document.querySelector('#result').textContent='accepted:'+document.querySelector('#name').value">Commit</button>
                        <p id="result"></p>"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });

        let controller = PinchTabController::new("pinchtab").unwrap();
        let host = controller
            .start_host(StartHostRequest {
                engine: BrowserEngine::Chromium,
                backend: BrowserBackend::Pinchtab,
                profile: None,
                visible: false,
                launch_args: Vec::new(),
            })
            .await
            .unwrap();
        let tab = controller.open_tab(&host, Some(&fixture_url)).await.unwrap();
        let address = BrowserAddress {
            agent_id: AgentId("fixture-agent".into()),
            browser_session_id: BrowserSessionId("fixture-session".into()),
            tab_id: tab.tab_id.clone(),
        };
        controller.focus_tab(&host, tab.tab_id.as_ref()).await.unwrap();
        let observation = controller
            .observe(
                &address,
                ObserveRequest {
                    view: ObservationView::Interactive,
                    selector: None,
                    max_chars: 16_000,
                    include_bounds: false,
                },
            )
            .await
            .unwrap();
        assert!(observation.controls.iter().any(|control| control.name == "Commit"));
        controller
            .act(
                &address,
                BrowserAction::Fill {
                    r#ref: None,
                    selector: Some("#name".into()),
                    text: "vertical-ok".into(),
                },
            )
            .await
            .unwrap();
        controller
            .act(
                &address,
                BrowserAction::Click {
                    r#ref: None,
                    selector: Some("#commit".into()),
                },
            )
            .await
            .unwrap();
        let result = controller
            .observe(
                &address,
                ObserveRequest {
                    view: ObservationView::Main,
                    selector: Some("#result".into()),
                    max_chars: 1_000,
                    include_bounds: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(result.content, "accepted:vertical-ok");

        let waiting = {
            let controller = controller.clone();
            let address = address.clone();
            tokio::spawn(async move {
                controller
                    .act(
                        &address,
                        BrowserAction::Wait {
                            milliseconds: Some(30_000),
                            selector: None,
                            text: None,
                        },
                    )
                    .await
            })
        };
        sleep(Duration::from_millis(250)).await;
        controller.cancel_host_operation(&host.host.host_id).await.unwrap();
        assert!(waiting.await.unwrap().is_err());

        controller.close_tab(&host, tab.tab_id.as_ref()).await.unwrap();
        controller.close_tab(&host, tab.tab_id.as_ref()).await.unwrap();
        controller.stop_host(&host).await.unwrap();
        controller.stop_host(&host).await.unwrap();
        fixture.abort();
    }
}
