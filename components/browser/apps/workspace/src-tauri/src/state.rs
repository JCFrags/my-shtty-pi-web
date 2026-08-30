use crate::{error::PublicError, protocol::{WorkspaceSnapshot, WorkspaceStatus}};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedTab {
    pub selection_id: String,
    pub browser_session_id: String,
    pub tab_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicWorkspaceState {
    pub connection: String,
    pub webxd_runtime_instance_id: Option<String>,
    pub snapshot: Option<WorkspaceSnapshot>,
    pub selected: Option<SelectedTab>,
    pub dropped_before_frontend: u64,
    pub inflight_frame: bool,
}

impl Default for PublicWorkspaceState {
    fn default() -> Self { Self { connection: "closed".into(), webxd_runtime_instance_id: None, snapshot: None, selected: None, dropped_before_frontend: 0, inflight_frame: false } }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FrontendStateRecord {
    Current { state: PublicWorkspaceState },
    Snapshot { snapshot: WorkspaceSnapshot },
    Status { status: WorkspaceStatus },
    Selection { selected: SelectedTab },
    SelectionCleared,
    Error { error: PublicError },
}

#[derive(Clone, Default)]
pub struct SharedPublicState(pub Arc<RwLock<PublicWorkspaceState>>);

impl SharedPublicState {
    pub async fn current(&self) -> PublicWorkspaceState { self.0.read().await.clone() }
}
