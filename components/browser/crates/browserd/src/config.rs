use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct XdgPaths {
    pub runtime: PathBuf,
    pub config: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct DaemonConfig {
    pub workspace_binary: String,
    pub agent_browser_binary: String,
    pub searxng_url: String,
    pub reader_url: String,
    pub visual_chromium: VisualChromiumConfig,
    pub limits: Limits,
    pub human_control: HumanControlConfig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct VisualChromiumConfig {
    pub executable_path: Option<String>,
    pub launch_args: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Limits {
    pub max_chromium_hosts: usize,
    pub max_lightpanda_hosts: usize,
    pub max_tabs_per_host: usize,
    pub background_thumbnail_interval_ms: u64,
    pub max_observation_chars: usize,
    pub max_debug_chars: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct HumanControlConfig {
    pub inactivity_timeout_ms: Option<u64>,
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            workspace_binary: "pi-browser-workspace".into(),
            agent_browser_binary: "agent-browser".into(),
            searxng_url: "http://127.0.0.1:8888/".into(),
            reader_url: "http://127.0.0.1:8787/".into(),
            visual_chromium: VisualChromiumConfig::default(),
            limits: Limits::default(),
            human_control: HumanControlConfig::default(),
        }
    }
}

impl Default for VisualChromiumConfig {
    fn default() -> Self { Self { executable_path: None, launch_args: Vec::new() } }
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_chromium_hosts: 6,
            max_lightpanda_hosts: 24,
            max_tabs_per_host: 30,
            background_thumbnail_interval_ms: 2_000,
            max_observation_chars: 1_000_000,
            max_debug_chars: 4_000_000,
        }
    }
}

impl Default for HumanControlConfig {
    fn default() -> Self { Self { inactivity_timeout_ms: None } }
}

impl XdgPaths {
    pub fn resolve() -> Self {
        let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
        let runtime = env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| env::temp_dir().join(format!("pi-web-{}", std::process::id())))
            .join("pi-web");
        let config = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("pi-web");
        let data = env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("pi-web");
        let cache = env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".cache"))
            .join("pi-web");
        Self { runtime, config, data, cache }
    }

    pub fn ensure(&self) -> Result<()> {
        for path in [&self.runtime, &self.config, &self.data, &self.cache] {
            fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))?;
        }
        for path in [
            self.runtime.join("agents"), self.runtime.join("streams"), self.runtime.join("locks"),
            self.data.join("profiles"), self.data.join("artifacts"), self.data.join("downloads"),
            self.data.join("screenshots"), self.data.join("logs"), self.cache.join("pages"),
            self.cache.join("browser-binaries"), self.cache.join("document-models"),
        ] {
            fs::create_dir_all(&path).with_context(|| format!("create {}", path.display()))?;
        }
        Ok(())
    }

    pub fn socket_path(&self) -> PathBuf { self.runtime.join("browserd.sock") }
    pub fn descriptor_path(&self) -> PathBuf { self.runtime.join("browserd.json") }
    pub fn registry_snapshot_path(&self) -> PathBuf { self.data.join("registry.json") }
}

impl DaemonConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let mut config = if path.exists() {
            let content = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
            toml::from_str(&content).with_context(|| format!("parse {} as TOML", path.display()))?
        } else {
            Self::default()
        };
        if let Some(path) = env::var_os("PI_WEB_VISUAL_CHROMIUM_EXECUTABLE").filter(|value| !value.is_empty()) {
            config.visual_chromium.executable_path = Some(PathBuf::from(path).to_string_lossy().into_owned());
        }
        if let Ok(args) = env::var("PI_WEB_VISUAL_CHROMIUM_ARGS") {
            config.visual_chromium.launch_args = args.split(',').map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned).collect();
        }
        Ok(config)
    }
}
