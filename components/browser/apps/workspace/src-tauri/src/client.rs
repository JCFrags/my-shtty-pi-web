use crate::{
    acceptance::{AcceptanceDiagnostics, FrameDisposition},
    descriptor::WorkspaceDescriptor,
    error::{PublicError, WorkspaceError},
    frame::{admit_frame_sequence, encode_frame_delivery},
    protocol::{self, FrameHeader, ResponseResult, ServerRecord, WorkspaceSnapshot},
    state::{FrontendStateRecord, PublicWorkspaceState, SelectedTab, SharedPublicState},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, sync::{Arc, Mutex}, time::Duration};
use tauri::{async_runtime::JoinHandle, ipc::{Channel, Response}};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::UnixStream, sync::{mpsc, oneshot}, time::{Instant, sleep}};
use uuid::Uuid;

const COMMAND_CAPACITY: usize = 8;
const COMMAND_TTL: Duration = Duration::from_secs(12);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult { pub opened: bool }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionResult { pub selection_id: String, pub browser_session_id: String, pub tab_id: String }

enum ClientCommand {
    Select { browser_session_id: String, tab_id: String, expires: Instant, reply: oneshot::Sender<Result<SelectionResult, PublicError>> },
    Clear { expires: Instant, reply: oneshot::Sender<Result<(), PublicError>> },
    FrameAck { delivery_id: u64, disposition: FrameDisposition },
    Stop,
}

pub struct WorkspaceClientService {
    state: SharedPublicState,
    sender: Mutex<Option<mpsc::Sender<ClientCommand>>>,
    task: Mutex<Option<JoinHandle<()>>>,
    pending_launch_selection: Arc<Mutex<Option<(String, Option<String>)>>>,
    acceptance: AcceptanceDiagnostics,
}

impl Default for WorkspaceClientService {
    fn default() -> Self { Self { state: SharedPublicState::default(), sender: Mutex::new(None), task: Mutex::new(None), pending_launch_selection: Arc::new(Mutex::new(None)), acceptance: AcceptanceDiagnostics::default() } }
}

impl WorkspaceClientService {
    pub async fn open(&self, state_channel: Channel<FrontendStateRecord>, frame_channel: Channel<Response>) -> Result<OpenResult, PublicError> {
        self.stop_task();
        let (sender, receiver) = mpsc::channel(COMMAND_CAPACITY);
        *self.sender.lock().expect("workspace sender lock") = Some(sender);
        let shared = self.state.clone();
        let pending_launch_selection = self.pending_launch_selection.clone();
        let acceptance = self.acceptance.clone();
        acceptance.frontend_ready();
        let task = tauri::async_runtime::spawn(async move { Worker::new(shared, state_channel, frame_channel, receiver, pending_launch_selection, acceptance).run().await; });
        *self.task.lock().expect("workspace task lock") = Some(task);
        Ok(OpenResult { opened: true })
    }

    pub async fn select(&self, browser_session_id: String, tab_id: String) -> Result<SelectionResult, PublicError> {
        if !protocol::valid_id(&browser_session_id) || !protocol::valid_id(&tab_id) { return Err(WorkspaceError::InvalidSelection.public()); }
        let (reply, received) = oneshot::channel();
        self.send_control(ClientCommand::Select { browser_session_id, tab_id, expires: Instant::now() + COMMAND_TTL, reply }).await?;
        tokio::time::timeout(COMMAND_TTL, received).await.map_err(|_| WorkspaceError::Unavailable.public())?.map_err(|_| WorkspaceError::Closed.public())?
    }

    pub async fn clear(&self) -> Result<(), PublicError> {
        let (reply, received) = oneshot::channel();
        self.send_control(ClientCommand::Clear { expires: Instant::now() + COMMAND_TTL, reply }).await?;
        tokio::time::timeout(COMMAND_TTL, received).await.map_err(|_| WorkspaceError::Unavailable.public())?.map_err(|_| WorkspaceError::Closed.public())?
    }

    pub async fn frame_ack(&self, delivery_id: u64, disposition: FrameDisposition) -> Result<(), PublicError> {
        if !disposition.validate() { return Err(WorkspaceError::Protocol.public()); }
        self.send(ClientCommand::FrameAck { delivery_id, disposition }).await
    }
    pub fn configure_acceptance(&self, path: &Path) -> Result<(), String> { self.acceptance.configure(path) }
    pub fn record_window_action(&self, action: &str) { self.acceptance.window_action(action); }
    pub fn queue_launch_selection(&self, browser_session_id: String, tab_id: Option<String>) { *self.pending_launch_selection.lock().expect("workspace launch selection lock") = Some((browser_session_id, tab_id)); }
    pub async fn current(&self) -> PublicWorkspaceState { self.state.current().await }

    pub fn stop_task(&self) {
        if let Some(sender) = self.sender.lock().expect("workspace sender lock").take() { let _ = sender.try_send(ClientCommand::Stop); }
        if let Some(task) = self.task.lock().expect("workspace task lock").take() { task.abort(); }
    }

    async fn send_control(&self, command: ClientCommand) -> Result<(), PublicError> {
        let sender = self.sender.lock().expect("workspace sender lock").clone().ok_or_else(|| WorkspaceError::Closed.public())?;
        tokio::time::timeout(COMMAND_TTL, sender.send(command)).await
            .map_err(|_| WorkspaceError::Capacity.public())?
            .map_err(|_| WorkspaceError::Closed.public())
    }

    async fn send(&self, command: ClientCommand) -> Result<(), PublicError> {
        let sender = self.sender.lock().expect("workspace sender lock").clone().ok_or_else(|| WorkspaceError::Closed.public())?;
        sender.try_send(command).map_err(|error| match error { mpsc::error::TrySendError::Full(_) => WorkspaceError::Capacity.public(), mpsc::error::TrySendError::Closed(_) => WorkspaceError::Closed.public() })
    }
}

impl Drop for WorkspaceClientService { fn drop(&mut self) { self.stop_task(); } }

enum PendingSelectionEvidence {
    Selected(SelectedTab),
    Cleared,
}

#[derive(Default)]
struct SelectionEvidenceGate {
    pending: Option<PendingSelectionEvidence>,
}

impl SelectionEvidenceGate {
    fn stage(&mut self, evidence: PendingSelectionEvidence, frame_inflight: bool) -> Option<PendingSelectionEvidence> {
        if frame_inflight {
            self.pending = Some(evidence);
            None
        } else {
            self.pending = None;
            Some(evidence)
        }
    }

    fn settle_frame(&mut self) -> Option<PendingSelectionEvidence> {
        self.pending.take()
    }
}

struct Worker {
    shared: SharedPublicState,
    state_channel: Channel<FrontendStateRecord>,
    frame_channel: Channel<Response>,
    commands: mpsc::Receiver<ClientCommand>,
    selected: Option<SelectedTab>,
    transport: Option<Transport>,
    webxd_runtime_instance_id: Option<String>,
    browserd_runtime_instance_id: Option<String>,
    next_delivery_id: u64,
    inflight_delivery_id: Option<u64>,
    inflight_header: Option<FrameHeader>,
    pending_frame: Option<(FrameHeader, Vec<u8>)>,
    selection_evidence_gate: SelectionEvidenceGate,
    dropped: u64,
    last_frame_sequence: u64,
    pending_launch_selection: Arc<Mutex<Option<(String, Option<String>)>>>,
    acceptance: AcceptanceDiagnostics,
}

impl Worker {
    fn new(shared: SharedPublicState, state_channel: Channel<FrontendStateRecord>, frame_channel: Channel<Response>, commands: mpsc::Receiver<ClientCommand>, pending_launch_selection: Arc<Mutex<Option<(String, Option<String>)>>>, acceptance: AcceptanceDiagnostics) -> Self {
        Self { shared, state_channel, frame_channel, commands, selected: None, transport: None, webxd_runtime_instance_id: None, browserd_runtime_instance_id: None, next_delivery_id: 1, inflight_delivery_id: None, inflight_header: None, pending_frame: None, selection_evidence_gate: SelectionEvidenceGate::default(), dropped: 0, last_frame_sequence: 0, pending_launch_selection, acceptance }
    }

    async fn run(mut self) {
        let mut backoff = Duration::from_millis(100);
        loop {
            self.set_connection("connecting").await;
            match self.connect().await {
                Ok(()) => {
                    backoff = Duration::from_millis(100);
                    self.set_connection("ready").await;
                    if self.connected_loop().await.is_err() { self.transport = None; self.pending_frame = None; }
                }
                Err(error) => { let _ = self.send_state(FrontendStateRecord::Error { error: error.public() }); }
            }
            self.set_connection("reconnecting").await;
            tokio::select! {
                _ = sleep(backoff) => {},
                command = self.commands.recv() => if !self.offline_command(command).await { break; },
            }
            backoff = (backoff * 2).min(Duration::from_secs(5));
        }
        self.set_connection("closed").await;
    }

    async fn connect(&mut self) -> Result<(), WorkspaceError> {
        self.acceptance.milestone("descriptor-discovery-started");
        let descriptor = tokio::task::spawn_blocking(WorkspaceDescriptor::discover).await.map_err(|_| WorkspaceError::Unavailable)??;
        self.acceptance.milestone("descriptor-discovered");
        let mut transport = Transport::connect(&descriptor).await?;
        let bind_request = request_id("bind");
        transport.write(&protocol::bind_header(&bind_request, &descriptor.binding_secret)).await?;
        loop {
            let (record, payload) = transport.read().await?;
            match record {
                ServerRecord::Bound { request_id, webxd_runtime_instance_id } if request_id == bind_request && webxd_runtime_instance_id == descriptor.webxd_runtime_instance_id => { self.webxd_runtime_instance_id = Some(webxd_runtime_instance_id); self.acceptance.milestone("gateway-bound"); break; }
                ServerRecord::Status(status) => { self.send_state(FrontendStateRecord::Status { status })?; }
                _ => return Err(WorkspaceError::Protocol),
            }
            if !payload.is_empty() { return Err(WorkspaceError::Protocol); }
        }
        self.transport = Some(transport);
        let _ = self.request("snapshot.subscribe", BTreeMap::new()).await?;
        match self.request("snapshot.get", BTreeMap::new()).await? {
            ResponseResult::Snapshot(snapshot) => self.apply_snapshot(snapshot).await?,
            _ => return Err(WorkspaceError::Protocol),
        }
        let requested = self.pending_launch_selection.lock().expect("workspace launch selection lock").take();
        let requested_retry = requested.clone();
        let restoring_prior_selection = requested.is_none() && self.selected.is_some();
        if requested.is_some() || self.selected.is_none() {
            let candidate = {
                let state = self.shared.0.read().await;
                match requested {
                    Some((browser_session_id, requested_tab)) => {
                        let tab_id = requested_tab.or_else(|| state.snapshot.as_ref().and_then(|snapshot| snapshot.sessions.iter().find(|session| session.browser_session_id == browser_session_id)).and_then(|session| session.tabs.iter().find(|tab| tab.state == "ready").or_else(|| session.tabs.first())).map(|tab| tab.tab_id.clone()));
                        tab_id.map(|tab_id| (browser_session_id, tab_id))
                    }
                    None => state.snapshot.as_ref().and_then(|snapshot| snapshot.sessions.iter().find_map(|session| session.tabs.iter().find(|tab| tab.state == "ready").map(|tab| (session.browser_session_id.clone(), tab.tab_id.clone())))),
                }
            };
            if let Some((browser_session_id, tab_id)) = candidate {
                self.acceptance.selection_requested(&browser_session_id, &tab_id);
                let selection_id = Uuid::new_v4().simple().to_string();
                let mut fields = BTreeMap::new(); fields.insert("browserSessionId", json!(browser_session_id)); fields.insert("tabId", json!(tab_id)); fields.insert("selectionId", json!(selection_id));
                match self.request("frame.select", fields).await {
                    Ok(ResponseResult::Selection { selection_id, browser_session_id, tab_id }) => {
                        let selected = SelectedTab { selection_id, browser_session_id, tab_id }; self.selected = Some(selected.clone()); self.update_selected(Some(selected.clone())).await; self.send_state(FrontendStateRecord::Selection { selected: selected.clone() })?; self.record_selection_evidence(PendingSelectionEvidence::Selected(selected));
                    }
                    Ok(_) => return Err(WorkspaceError::Protocol),
                    Err(error) => {
                        if let Some(requested) = requested_retry { *self.pending_launch_selection.lock().expect("workspace launch selection lock") = Some(requested); }
                        return Err(error);
                    }
                }
            }
        }
        if restoring_prior_selection && let Some(selected) = self.selected.clone() {
            let exists = self.shared.0.read().await.snapshot.as_ref().is_some_and(|snapshot| snapshot.contains(&selected.browser_session_id, &selected.tab_id));
            if exists {
                let mut fields = BTreeMap::new(); fields.insert("browserSessionId", json!(selected.browser_session_id)); fields.insert("tabId", json!(selected.tab_id)); fields.insert("selectionId", json!(selected.selection_id));
                if let ResponseResult::Selection { selection_id, browser_session_id, tab_id } = self.request("frame.select", fields).await? { self.selected = Some(SelectedTab { selection_id, browser_session_id, tab_id }); }
            } else { self.clear_local_selection().await; }
        }
        Ok(())
    }

    async fn connected_loop(&mut self) -> Result<(), WorkspaceError> {
        loop {
            tokio::select! {
                command = self.commands.recv() => if !self.handle_command(command).await? { return Err(WorkspaceError::Closed); },
                record = async { self.transport.as_mut().ok_or(WorkspaceError::Closed)?.read().await } => {
                    let (record, payload) = record?; self.handle_record(record, payload).await?;
                }
            }
        }
    }

    async fn handle_command(&mut self, command: Option<ClientCommand>) -> Result<bool, WorkspaceError> {
        match command {
            None | Some(ClientCommand::Stop) => Ok(false),
            Some(ClientCommand::FrameAck { delivery_id, disposition }) => { self.ack_frame(delivery_id, disposition)?; Ok(true) }
            Some(ClientCommand::Select { browser_session_id, tab_id, expires, reply }) => {
                if Instant::now() > expires { let _ = reply.send(Err(WorkspaceError::Unavailable.public())); return Ok(true); }
                self.pending_frame = None; self.last_frame_sequence = 0;
                self.acceptance.selection_requested(&browser_session_id, &tab_id);
                let selection_id = Uuid::new_v4().simple().to_string();
                let mut fields = BTreeMap::new(); fields.insert("browserSessionId", json!(browser_session_id)); fields.insert("tabId", json!(tab_id)); fields.insert("selectionId", json!(selection_id));
                let result = match self.request("frame.select", fields).await {
                    Ok(ResponseResult::Selection { selection_id, browser_session_id, tab_id }) => {
                        let selected = SelectedTab { selection_id: selection_id.clone(), browser_session_id: browser_session_id.clone(), tab_id: tab_id.clone() };
                        *self.pending_launch_selection.lock().expect("workspace launch selection lock") = None;
                        self.pending_frame = None; self.selected = Some(selected.clone()); self.update_selected(Some(selected.clone())).await; let _ = self.send_state(FrontendStateRecord::Selection { selected: selected.clone() }); self.record_selection_evidence(PendingSelectionEvidence::Selected(selected));
                        Ok(SelectionResult { selection_id, browser_session_id, tab_id })
                    }
                    Ok(_) => Err(WorkspaceError::Protocol.public()),
                    Err(error) => {
                        if matches!(&error, WorkspaceError::Unavailable | WorkspaceError::Io(_) | WorkspaceError::Closed) { *self.pending_launch_selection.lock().expect("workspace launch selection lock") = Some((browser_session_id, Some(tab_id))); }
                        Err(error.public())
                    },
                };
                let _ = reply.send(result); Ok(true)
            }
            Some(ClientCommand::Clear { expires, reply }) => {
                if Instant::now() > expires { let _ = reply.send(Err(WorkspaceError::Unavailable.public())); return Ok(true); }
                let result = self.request("frame.clear", BTreeMap::new()).await.map(|_| ()).map_err(|error| error.public());
                if result.is_ok() { self.clear_local_selection().await; }
                let _ = reply.send(result); Ok(true)
            }
        }
    }

    async fn offline_command(&mut self, command: Option<ClientCommand>) -> bool {
        match command {
            None | Some(ClientCommand::Stop) => false,
            Some(ClientCommand::FrameAck { delivery_id, disposition }) => { let _ = self.ack_frame(delivery_id, disposition); true }
            Some(ClientCommand::Select { browser_session_id, tab_id, reply, .. }) => { *self.pending_launch_selection.lock().expect("workspace launch selection lock") = Some((browser_session_id, Some(tab_id))); let _ = reply.send(Err(WorkspaceError::Unavailable.public())); true }
            Some(ClientCommand::Clear { reply, .. }) => { self.clear_local_selection().await; let _ = reply.send(Ok(())); true }
        }
    }

    async fn request(&mut self, kind: &str, fields: BTreeMap<&str, Value>) -> Result<ResponseResult, WorkspaceError> {
        let request_id = request_id("request");
        self.transport.as_mut().ok_or(WorkspaceError::Closed)?.write(&protocol::command_header(&request_id, kind, fields)).await?;
        loop {
            let (record, payload) = self.transport.as_mut().ok_or(WorkspaceError::Closed)?.read().await?;
            match record {
                ServerRecord::Response { request_id: response_id, result } if response_id == request_id => return result.map_err(|error| if error.retryable { WorkspaceError::Unavailable } else { WorkspaceError::Protocol }),
                other => self.handle_record(other, payload).await?,
            }
        }
    }

    async fn handle_record(&mut self, record: ServerRecord, payload: Vec<u8>) -> Result<(), WorkspaceError> {
        match record {
            ServerRecord::Snapshot(snapshot) => self.apply_snapshot(snapshot).await?,
            ServerRecord::Status(status) => self.send_state(FrontendStateRecord::Status { status })?,
            ServerRecord::Frame(header) => self.accept_frame(header, payload)?,
            ServerRecord::Response { .. } | ServerRecord::Bound { .. } => return Err(WorkspaceError::Protocol),
        }
        Ok(())
    }

    async fn apply_snapshot(&mut self, snapshot: WorkspaceSnapshot) -> Result<(), WorkspaceError> {
        let runtime_changed = self.browserd_runtime_instance_id.as_ref().is_some_and(|prior| snapshot.browserd_runtime_instance_id.as_ref() != Some(prior));
        self.browserd_runtime_instance_id = snapshot.browserd_runtime_instance_id.clone();
        if runtime_changed { self.clear_local_selection().await; }
        if self.selected.as_ref().is_some_and(|selected| !snapshot.contains(&selected.browser_session_id, &selected.tab_id)) { self.clear_local_selection().await; }
        { let mut state = self.shared.0.write().await; state.snapshot = Some(snapshot.clone()); state.webxd_runtime_instance_id = self.webxd_runtime_instance_id.clone(); }
        self.acceptance.snapshot(&snapshot);
        self.send_state(FrontendStateRecord::Snapshot { snapshot })
    }

    fn accept_frame(&mut self, header: FrameHeader, payload: Vec<u8>) -> Result<(), WorkspaceError> {
        let selected = match &self.selected { Some(selected) if selected.selection_id == header.selection_id && selected.browser_session_id == header.browser_session_id && selected.tab_id == header.tab_id => selected, _ => { self.dropped += 1; return Ok(()); } };
        if self.browserd_runtime_instance_id.as_deref() != Some(&header.browserd_runtime_instance_id) { self.dropped += 1; return Ok(()); }
        let Some(sequence) = admit_frame_sequence(self.last_frame_sequence, &header, &payload)? else { self.dropped += 1; return Ok(()); };
        let _ = selected;
        if self.inflight_delivery_id.is_some() {
            self.last_frame_sequence = sequence;
            if self.pending_frame.replace((header, payload)).is_some() { self.dropped += 1; }
            self.update_frame_metrics();
            return Ok(());
        }
        self.send_frame(header, payload)?;
        self.last_frame_sequence = sequence;
        Ok(())
    }

    fn send_frame(&mut self, header: FrameHeader, payload: Vec<u8>) -> Result<(), WorkspaceError> {
        let delivery_id = self.next_delivery_id; self.next_delivery_id = self.next_delivery_id.saturating_add(1);
        let envelope = encode_frame_delivery(delivery_id, &header, &payload)?;
        self.frame_channel.send(Response::new(envelope)).map_err(|_| WorkspaceError::Closed)?;
        self.acceptance.frame_received(delivery_id, &header);
        self.inflight_header = Some(header);
        self.inflight_delivery_id = Some(delivery_id); self.update_frame_metrics(); Ok(())
    }

    fn ack_frame(&mut self, delivery_id: u64, disposition: FrameDisposition) -> Result<(), WorkspaceError> {
        if self.inflight_delivery_id != Some(delivery_id) { return Ok(()); }
        let rust_retained_frames = 1 + u8::from(self.pending_frame.is_some());
        if let Some(header) = self.inflight_header.take() { self.acceptance.frame_settled(delivery_id, &header, &disposition, rust_retained_frames); }
        self.inflight_delivery_id = None;
        self.flush_selection_evidence();
        if let Some((header, payload)) = self.pending_frame.take() { self.send_frame(header, payload)?; } else { self.update_frame_metrics(); }
        Ok(())
    }

    async fn clear_local_selection(&mut self) {
        self.selected = None; self.pending_frame = None; self.last_frame_sequence = 0; self.update_selected(None).await; let _ = self.send_state(FrontendStateRecord::SelectionCleared); self.record_selection_evidence(PendingSelectionEvidence::Cleared);
    }
    fn record_selection_evidence(&mut self, evidence: PendingSelectionEvidence) {
        if let Some(evidence) = self.selection_evidence_gate.stage(evidence, self.inflight_delivery_id.is_some()) { self.emit_selection_evidence(evidence); }
    }
    fn flush_selection_evidence(&mut self) {
        if let Some(evidence) = self.selection_evidence_gate.settle_frame() { self.emit_selection_evidence(evidence); }
    }
    fn emit_selection_evidence(&self, evidence: PendingSelectionEvidence) {
        match evidence {
            PendingSelectionEvidence::Selected(selected) => self.acceptance.selection(&selected.selection_id, &selected.browser_session_id, &selected.tab_id),
            PendingSelectionEvidence::Cleared => self.acceptance.selection_cleared(),
        }
    }
    async fn update_selected(&self, selected: Option<SelectedTab>) { self.shared.0.write().await.selected = selected; }
    async fn set_connection(&self, connection: &str) { self.acceptance.connection(connection); let mut state = self.shared.0.write().await; state.connection = connection.to_owned(); let _ = self.send_state(FrontendStateRecord::Current { state: state.clone() }); }
    fn update_frame_metrics(&self) { if let Ok(mut state) = self.shared.0.try_write() { state.dropped_before_frontend = self.dropped; state.inflight_frame = self.inflight_delivery_id.is_some(); } }
    fn send_state(&self, record: FrontendStateRecord) -> Result<(), WorkspaceError> { self.state_channel.send(record).map_err(|_| WorkspaceError::Closed) }
}

struct Transport { stream: UnixStream }
impl Transport {
    async fn connect(descriptor: &WorkspaceDescriptor) -> Result<Self, WorkspaceError> { Ok(Self { stream: UnixStream::connect(&descriptor.socket_path).await? }) }
    async fn write(&mut self, header: &Value) -> Result<(), WorkspaceError> { self.stream.write_all(&protocol::encode_record(header)?).await?; Ok(()) }
    async fn read(&mut self) -> Result<(ServerRecord, Vec<u8>), WorkspaceError> {
        let mut prefix = [0_u8; 8]; self.stream.read_exact(&mut prefix).await?;
        let header_len = u32::from_be_bytes(prefix[..4].try_into().map_err(|_| WorkspaceError::Protocol)?) as usize;
        let payload_len = u32::from_be_bytes(prefix[4..].try_into().map_err(|_| WorkspaceError::Protocol)?) as usize;
        if !(2..=protocol::MAX_HEADER_BYTES).contains(&header_len) || payload_len > protocol::MAX_PAYLOAD_BYTES { return Err(WorkspaceError::Protocol); }
        let mut header = vec![0_u8; header_len]; let mut payload = vec![0_u8; payload_len];
        self.stream.read_exact(&mut header).await?; self.stream.read_exact(&mut payload).await?;
        Ok((protocol::parse_server_record(&header, payload_len)?, payload))
    }
}

fn request_id(prefix: &str) -> String { format!("{prefix}:{}", Uuid::new_v4().simple()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_selection_ids_without_paths_or_urls() {
        assert!(protocol::valid_id("session:one")); assert!(protocol::valid_id("tab-one"));
        assert!(!protocol::valid_id("/tmp/socket")); assert!(!protocol::valid_id("https://example.test"));
    }

    #[test]
    fn selection_barrier_waits_for_the_prior_frontend_frame_to_settle() {
        let mut gate = SelectionEvidenceGate::default();
        let selected = SelectedTab { selection_id: "selection-one".into(), browser_session_id: "session-one".into(), tab_id: "tab-one".into() };
        assert!(gate.stage(PendingSelectionEvidence::Selected(selected), true).is_none());
        assert!(matches!(gate.settle_frame(), Some(PendingSelectionEvidence::Selected(selected)) if selected.selection_id == "selection-one"));
        assert!(matches!(gate.stage(PendingSelectionEvidence::Cleared, false), Some(PendingSelectionEvidence::Cleared)));
    }

    #[tokio::test]
    async fn control_commands_wait_for_bounded_queue_capacity() {
        let service = WorkspaceClientService::default();
        let (sender, mut receiver) = mpsc::channel(1);
        *service.sender.lock().expect("workspace sender lock") = Some(sender);
        service.send(ClientCommand::Stop).await.expect("fill command queue");
        let pending = service.send_control(ClientCommand::Stop);
        tokio::pin!(pending);
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut pending).await.is_err());
        assert!(matches!(receiver.recv().await, Some(ClientCommand::Stop)));
        tokio::time::timeout(Duration::from_millis(100), pending).await.expect("control send should resume").expect("control send");
        assert!(matches!(receiver.recv().await, Some(ClientCommand::Stop)));
    }
}
