//! Experimental Rustwright adapter boundary.
//!
//! Deliberately reports unsupported until the common conformance suite is run against
//! a pinned upstream commit. It never silently redirects to another engine.

use async_trait::async_trait;
use pi_web_backend_core::{BackendError, BrowserController, Result};
use pi_web_protocol::*;

#[derive(Default)]
pub struct RustwrightController;

fn unsupported(capability: &str) -> BackendError {
    BackendError::Unsupported { capability: capability.into(), backend: "rustwright".into() }
}

#[async_trait]
impl BrowserController for RustwrightController {
    async fn capabilities(&self) -> Result<BrowserCapabilities> {
        Ok(BrowserCapabilities {
            backend: BrowserBackend::Rustwright,
            engines: vec![BrowserEngine::Chromium],
            actions: Vec::new(), debug: Vec::new(), persistent_profiles: false,
            extensions: false, viewport_streaming: false, direct_tab_addressing: false,
        })
    }
    async fn start_host(&self, _: StartHostRequest) -> Result<BrowserHostHandle> { Err(unsupported("start_host")) }
    async fn stop_host(&self, _: &BrowserHostHandle) -> Result<()> { Err(unsupported("stop_host")) }
    async fn list_tabs(&self, _: &BrowserHostHandle) -> Result<Vec<TabInfo>> { Err(unsupported("list_tabs")) }
    async fn open_tab(&self, _: &BrowserHostHandle, _: Option<&str>) -> Result<TabInfo> { Err(unsupported("open_tab")) }
    async fn close_tab(&self, _: &BrowserHostHandle, _: &str) -> Result<()> { Err(unsupported("close_tab")) }
    async fn focus_tab(&self, _: &BrowserHostHandle, _: &str) -> Result<()> { Err(unsupported("focus_tab")) }
    async fn navigate(&self, _: &BrowserAddress, _: &str) -> Result<ActionResult> { Err(unsupported("navigate")) }
    async fn observe(&self, _: &BrowserAddress, _: ObserveRequest) -> Result<Observation> { Err(unsupported("observe")) }
    async fn act(&self, _: &BrowserAddress, _: BrowserAction) -> Result<ActionResult> { Err(unsupported("act")) }
    async fn debug(&self, _: &BrowserAddress, _: DebugRequest) -> Result<DebugResult> { Err(unsupported("debug")) }
    async fn stream_info(&self, _: &BrowserAddress) -> Result<StreamInfo> { Err(unsupported("stream_info")) }
}
