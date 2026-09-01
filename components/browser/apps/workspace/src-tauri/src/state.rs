use crate::{error::PublicError, protocol::{Operation, WorkspaceSession, WorkspaceSnapshot, WorkspaceStatus, WorkspaceTab}};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone, Debug)]
pub struct SelectedTab {
    pub selection_id: String,
    pub browser_session_id: String,
    pub tab_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendSelectedTab {
    pub browser_session_id: String,
    pub tab_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendCursor {
    pub x: f64,
    pub y: f64,
    pub visible: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendOperation {
    pub kind: String,
    pub state: String,
    pub dispatch_state: String,
    pub started_at: Option<String>,
    pub cancellable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendWorkspaceTab {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub state: String,
    pub capture_readiness: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendWorkspaceSession {
    pub browser_session_id: String,
    pub agent_label: String,
    pub actor_display_id: String,
    pub path_id: String,
    pub state: String,
    pub control_state: String,
    pub capture_readiness: String,
    pub persona_display_id: String,
    pub cursor: FrontendCursor,
    pub tabs: Vec<FrontendWorkspaceTab>,
    pub active_operation: Option<FrontendOperation>,
    pub last_activity_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendWorkspaceSnapshot {
    pub generated_at: String,
    pub browserd_state: String,
    pub sessions: Vec<FrontendWorkspaceSession>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicWorkspaceState {
    pub connection: String,
    pub snapshot: Option<FrontendWorkspaceSnapshot>,
    pub selected: Option<FrontendSelectedTab>,
    pub dropped_before_frontend: u64,
    pub inflight_frame: bool,
}

impl Default for PublicWorkspaceState {
    fn default() -> Self { Self { connection: "closed".into(), snapshot: None, selected: None, dropped_before_frontend: 0, inflight_frame: false } }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FrontendStateRecord {
    Current { state: PublicWorkspaceState },
    Snapshot { snapshot: FrontendWorkspaceSnapshot },
    Status { status: WorkspaceStatus },
    Selection { selected: FrontendSelectedTab },
    SelectionCleared,
    Error { error: PublicError },
}

#[derive(Clone, Default)]
pub struct SharedPublicState(pub Arc<RwLock<PublicWorkspaceState>>);

impl SharedPublicState {
    pub async fn current(&self) -> PublicWorkspaceState { self.0.read().await.clone() }
}

pub fn frontend_snapshot(snapshot: &WorkspaceSnapshot, salt: &str) -> FrontendWorkspaceSnapshot {
    FrontendWorkspaceSnapshot {
        generated_at: snapshot.generated_at.clone(),
        browserd_state: snapshot.browserd_state.clone(),
        sessions: snapshot.sessions.iter().map(|session| frontend_session(session, salt)).collect(),
    }
}

pub fn frontend_selected(selected: &SelectedTab, salt: &str) -> FrontendSelectedTab {
    FrontendSelectedTab {
        browser_session_id: display_handle("session", salt, &selected.browser_session_id),
        tab_id: display_handle("tab", salt, &selected.tab_id),
    }
}

pub fn resolve_frontend_selection(snapshot: &WorkspaceSnapshot, salt: &str, browser_session_display_id: &str, tab_display_id: &str) -> Option<(String, String)> {
    snapshot.sessions.iter().find_map(|session| {
        if display_handle("session", salt, &session.browser_session_id) != browser_session_display_id { return None; }
        session.tabs.iter().find(|tab| display_handle("tab", salt, &tab.tab_id) == tab_display_id)
            .map(|tab| (session.browser_session_id.clone(), tab.tab_id.clone()))
    })
}

fn frontend_session(session: &WorkspaceSession, salt: &str) -> FrontendWorkspaceSession {
    FrontendWorkspaceSession {
        browser_session_id: display_handle("session", salt, &session.browser_session_id),
        agent_label: session.agent_label.clone(),
        actor_display_id: session.actor_display_id.clone(),
        path_id: session.path_id.clone(),
        state: session.state.clone(),
        control_state: session.control_state.clone(),
        capture_readiness: session.capture_readiness.clone(),
        persona_display_id: session.persona_display_id.clone(),
        cursor: FrontendCursor { x: session.cursor.x, y: session.cursor.y, visible: session.cursor.visible },
        tabs: session.tabs.iter().map(|tab| frontend_tab(tab, salt)).collect(),
        active_operation: session.active_operation.as_ref().map(frontend_operation),
        last_activity_at: session.last_activity_at.clone(),
    }
}

fn frontend_tab(tab: &WorkspaceTab, salt: &str) -> FrontendWorkspaceTab {
    FrontendWorkspaceTab {
        tab_id: display_handle("tab", salt, &tab.tab_id),
        url: tab.url.clone(),
        title: tab.title.clone(),
        state: tab.state.clone(),
        capture_readiness: tab.capture_readiness.clone(),
    }
}

fn frontend_operation(operation: &Operation) -> FrontendOperation {
    FrontendOperation {
        kind: operation.kind.clone(),
        state: operation.state.clone(),
        dispatch_state: operation.dispatch_state.clone(),
        started_at: operation.started_at.clone(),
        cancellable: operation.cancellable,
    }
}

fn display_handle(prefix: &str, salt: &str, raw: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(salt.as_bytes());
    digest.update([0]);
    digest.update(prefix.as_bytes());
    digest.update([0]);
    digest.update(raw.as_bytes());
    let bytes = digest.finalize();
    let suffix = bytes[..12].iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    format!("{prefix}_{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Cursor, WorkspaceSession, WorkspaceSnapshot, WorkspaceTab};

    #[test]
    fn public_serialization_excludes_runtime_authority_generations_epochs_and_raw_ids() {
        let raw_session = "raw-session-authority";
        let raw_tab = "raw-tab-authority";
        let raw_runtime = "raw-runtime-authority";
        let snapshot = WorkspaceSnapshot {
            workspace_revision: 9,
            browserd_runtime_instance_id: Some(raw_runtime.into()),
            generated_at: "2026-08-31T00:00:00.000Z".into(),
            browserd_state: "ready".into(),
            sessions: vec![WorkspaceSession {
                browser_session_id: raw_session.into(), agent_label: "Agent".into(), actor_display_id: "actor_display".into(), path_id: "agentcursor/chrome".into(), state: "ready".into(), control_state: "human".into(), control_epoch: 7, control_transfer: "none".into(), selected_human_control_tab_id: Some(raw_tab.into()), lease_expiry: "healthy".into(), capture_readiness: "ready".into(), persona_display_id: "persona_display".into(), resource: None, cursor: Cursor { x: 1.0, y: 2.0, visible: true, path_sequence: 3, sample_sequence: 4 }, tabs: vec![WorkspaceTab { tab_id: raw_tab.into(), url: "https://example.test/".into(), title: "Fixture".into(), state: "ready".into(), capture_readiness: "ready".into(), document_generation: 5, viewport_generation: 6, frame_sequence: 8 }], active_operation: None, last_activity_at: None,
            }],
        };
        let public = frontend_snapshot(&snapshot, "private-random-salt");
        let text = serde_json::to_string(&public).expect("serialize public snapshot");
        for forbidden in [raw_session, raw_tab, raw_runtime, "controlEpoch", "controlTransfer", "selectedHumanControlTabId", "leaseExpiry", "documentGeneration", "viewportGeneration", "frameSequence", "workspaceRevision", "pathSequence", "sampleSequence", "operationId"] {
            assert!(!text.contains(forbidden), "public state leaked {forbidden}");
        }
        assert!(text.contains("session_"));
        assert!(text.contains("tab_"));
    }
}
