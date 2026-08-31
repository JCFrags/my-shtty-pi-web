use crate::{acceptance::FrameDisposition, client::{ControlActionResult, FrontendInputAck, OpenResult, SelectionResult, WorkspaceClientService}, error::PublicError, probe::{BinaryProbeService, ProbeStatus}, protocol::FrontendInputBatch, state::{FrontendStateRecord, PublicWorkspaceState}, window::{WindowAction, apply_window_action}};
use tauri::{State, WebviewWindow, ipc::{Channel, Response}};

#[tauri::command]
pub async fn workspace_open(service: State<'_, WorkspaceClientService>, state_channel: Channel<FrontendStateRecord>, frame_channel: Channel<Response>) -> Result<OpenResult, PublicError> {
    service.open(state_channel, frame_channel).await
}

#[tauri::command]
pub async fn workspace_select(service: State<'_, WorkspaceClientService>, browser_session_id: String, tab_id: Option<String>) -> Result<SelectionResult, PublicError> {
    let tab = match tab_id {
        Some(value) => value,
        None => {
            let current = service.current().await;
            current.snapshot.and_then(|snapshot| snapshot.sessions.into_iter().find(|session| session.browser_session_id == browser_session_id)).and_then(|session| session.tabs.into_iter().next()).map(|tab| tab.tab_id).ok_or_else(|| crate::error::WorkspaceError::InvalidSelection.public())?
        }
    };
    service.select(browser_session_id, tab).await
}

#[tauri::command]
pub async fn workspace_clear_selection(service: State<'_, WorkspaceClientService>) -> Result<(), PublicError> { service.clear().await }

#[tauri::command]
pub async fn workspace_frame_ack(service: State<'_, WorkspaceClientService>, delivery_id: u64, disposition: FrameDisposition) -> Result<(), PublicError> { service.frame_ack(delivery_id, disposition).await }

#[tauri::command]
pub async fn workspace_take_control(service: State<'_, WorkspaceClientService>) -> Result<ControlActionResult, PublicError> { service.take_control().await }

#[tauri::command]
pub async fn workspace_return_control(service: State<'_, WorkspaceClientService>) -> Result<ControlActionResult, PublicError> { service.return_control().await }

#[tauri::command]
pub async fn workspace_input_batch(service: State<'_, WorkspaceClientService>, batch: FrontendInputBatch) -> Result<FrontendInputAck, PublicError> { service.input(batch).await }

#[tauri::command]
pub async fn workspace_current_state(service: State<'_, WorkspaceClientService>) -> Result<PublicWorkspaceState, PublicError> { Ok(service.current().await) }

#[tauri::command]
pub async fn workspace_window_action(service: State<'_, WorkspaceClientService>, window: WebviewWindow, action: WindowAction) -> Result<(), PublicError> {
    if matches!(action, WindowAction::Hide) { service.release_for_hide().await?; }
    apply_window_action(&window, action).map_err(|_| crate::error::WorkspaceError::Unavailable.public())?;
    service.record_window_action(match action { WindowAction::Raise => "raise", WindowAction::Hide => "hide" });
    Ok(())
}

#[tauri::command]
pub fn workspace_binary_probe_open(service: State<'_, BinaryProbeService>, frame_channel: Channel<Response>) -> Result<ProbeStatus, PublicError> { service.open(frame_channel) }

#[tauri::command]
pub fn workspace_binary_probe_ack(service: State<'_, BinaryProbeService>, sequence: u32, sha256: String) -> Result<ProbeStatus, PublicError> { service.acknowledge(sequence, sha256) }
