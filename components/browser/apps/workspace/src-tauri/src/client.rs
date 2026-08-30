use crate::{
    descriptor::WorkspaceDescriptor,
    error::{PublicError, WorkspaceError},
    frame::encode_frame_delivery,
    protocol::{self, FrameHeader, ResponseResult, ServerRecord, WorkspaceSnapshot},
    state::{FrontendStateRecord, PublicWorkspaceState, SelectedTab, SharedPublicState},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Mutex, time::Duration};
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
    FrameAck { delivery_id: u64 },
    Stop,
}

pub struct WorkspaceClientService {
    state: SharedPublicState,
    sender: Mutex<Option<mpsc::Sender<ClientCommand>>>,
    task: Mutex<Option<JoinHandle<()>>>,
    pending_launch_selection: Mutex<Option<(String, Option<String>)>>,
}

impl Default for WorkspaceClientService {
    fn default() -> Self { Self { state: SharedPublicState::default(), sender: Mutex::new(None), task: Mutex::new(None), pending_launch_selection: Mutex::new(None) } }
}

impl WorkspaceClientService {
    pub async fn open(&self, state_channel: Channel<FrontendStateRecord>, frame_channel: Channel<Response>) -> Result<OpenResult, PublicError> {
        self.stop_task();
        let (sender, receiver) = mpsc::channel(COMMAND_CAPACITY);
        *self.sender.lock().expect("workspace sender lock") = Some(sender);
        let shared = self.state.clone();
        let launch_selection = self.pending_launch_selection.lock().expect("workspace launch selection lock").take();
        let task = tauri::async_runtime::spawn(async move { Worker::new(shared, state_channel, frame_channel, receiver, launch_selection).run().await; });
        *self.task.lock().expect("workspace task lock") = Some(task);
        Ok(OpenResult { opened: true })
    }

    pub async fn select(&self, browser_session_id: String, tab_id: String) -> Result<SelectionResult, PublicError> {
        if !protocol::valid_id(&browser_session_id) || !protocol::valid_id(&tab_id) { return Err(WorkspaceError::InvalidSelection.public()); }
        let (reply, received) = oneshot::channel();
        self.send(ClientCommand::Select { browser_session_id, tab_id, expires: Instant::now() + COMMAND_TTL, reply }).await?;
        tokio::time::timeout(COMMAND_TTL, received).await.map_err(|_| WorkspaceError::Unavailable.public())?.map_err(|_| WorkspaceError::Closed.public())?
    }

    pub async fn clear(&self) -> Result<(), PublicError> {
        let (reply, received) = oneshot::channel();
        self.send(ClientCommand::Clear { expires: Instant::now() + COMMAND_TTL, reply }).await?;
        tokio::time::timeout(COMMAND_TTL, received).await.map_err(|_| WorkspaceError::Unavailable.public())?.map_err(|_| WorkspaceError::Closed.public())?
    }

    pub async fn frame_ack(&self, delivery_id: u64) -> Result<(), PublicError> { self.send(ClientCommand::FrameAck { delivery_id }).await }
    pub fn queue_launch_selection(&self, browser_session_id: String, tab_id: Option<String>) { *self.pending_launch_selection.lock().expect("workspace launch selection lock") = Some((browser_session_id, tab_id)); }
    pub async fn current(&self) -> PublicWorkspaceState { self.state.current().await }

    pub fn stop_task(&self) {
        if let Some(sender) = self.sender.lock().expect("workspace sender lock").take() { let _ = sender.try_send(ClientCommand::Stop); }
        if let Some(task) = self.task.lock().expect("workspace task lock").take() { task.abort(); }
    }

    async fn send(&self, command: ClientCommand) -> Result<(), PublicError> {
        let sender = self.sender.lock().expect("workspace sender lock").clone().ok_or_else(|| WorkspaceError::Closed.public())?;
        sender.try_send(command).map_err(|error| match error { mpsc::error::TrySendError::Full(_) => WorkspaceError::Capacity.public(), mpsc::error::TrySendError::Closed(_) => WorkspaceError::Closed.public() })
    }
}

impl Drop for WorkspaceClientService { fn drop(&mut self) { self.stop_task(); } }

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
    pending_frame: Option<(FrameHeader, Vec<u8>)>,
    dropped: u64,
    last_frame_sequence: u64,
    launch_selection: Option<(String, Option<String>)>,
}

impl Worker {
    fn new(shared: SharedPublicState, state_channel: Channel<FrontendStateRecord>, frame_channel: Channel<Response>, commands: mpsc::Receiver<ClientCommand>, launch_selection: Option<(String, Option<String>)>) -> Self {
        Self { shared, state_channel, frame_channel, commands, selected: None, transport: None, webxd_runtime_instance_id: None, browserd_runtime_instance_id: None, next_delivery_id: 1, inflight_delivery_id: None, pending_frame: None, dropped: 0, last_frame_sequence: 0, launch_selection }
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
        let descriptor = tokio::task::spawn_blocking(WorkspaceDescriptor::discover).await.map_err(|_| WorkspaceError::Unavailable)??;
        let mut transport = Transport::connect(&descriptor).await?;
        let bind_request = request_id("bind");
        transport.write(&protocol::bind_header(&bind_request, &descriptor.binding_secret)).await?;
        loop {
            let (record, payload) = transport.read().await?;
            match record {
                ServerRecord::Bound { request_id, webxd_runtime_instance_id } if request_id == bind_request && webxd_runtime_instance_id == descriptor.webxd_runtime_instance_id => { self.webxd_runtime_instance_id = Some(webxd_runtime_instance_id); break; }
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
        let restoring_prior_selection = self.selected.is_some();
        if self.selected.is_none() {
            if let Some((browser_session_id, requested_tab)) = self.launch_selection.take() {
                let tab_id = match requested_tab {
                    Some(value) => Some(value),
                    None => self.shared.0.read().await.snapshot.as_ref().and_then(|snapshot| snapshot.sessions.iter().find(|session| session.browser_session_id == browser_session_id)).and_then(|session| session.tabs.first()).map(|tab| tab.tab_id.clone()),
                };
                if let Some(tab_id) = tab_id {
                    let selection_id = Uuid::new_v4().simple().to_string();
                    let mut fields = BTreeMap::new(); fields.insert("browserSessionId", json!(browser_session_id)); fields.insert("tabId", json!(tab_id)); fields.insert("selectionId", json!(selection_id));
                    if let ResponseResult::Selection { selection_id, browser_session_id, tab_id } = self.request("frame.select", fields).await? {
                        let selected = SelectedTab { selection_id, browser_session_id, tab_id }; self.selected = Some(selected.clone()); self.update_selected(Some(selected.clone())).await; self.send_state(FrontendStateRecord::Selection { selected })?;
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
            Some(ClientCommand::FrameAck { delivery_id }) => { self.ack_frame(delivery_id)?; Ok(true) }
            Some(ClientCommand::Select { browser_session_id, tab_id, expires, reply }) => {
                if Instant::now() > expires { let _ = reply.send(Err(WorkspaceError::Unavailable.public())); return Ok(true); }
                self.pending_frame = None; self.last_frame_sequence = 0;
                let selection_id = Uuid::new_v4().simple().to_string();
                let mut fields = BTreeMap::new(); fields.insert("browserSessionId", json!(browser_session_id)); fields.insert("tabId", json!(tab_id)); fields.insert("selectionId", json!(selection_id));
                let result = match self.request("frame.select", fields).await {
                    Ok(ResponseResult::Selection { selection_id, browser_session_id, tab_id }) => {
                        let selected = SelectedTab { selection_id: selection_id.clone(), browser_session_id: browser_session_id.clone(), tab_id: tab_id.clone() };
                        self.selected = Some(selected.clone()); self.update_selected(Some(selected.clone())).await; let _ = self.send_state(FrontendStateRecord::Selection { selected });
                        Ok(SelectionResult { selection_id, browser_session_id, tab_id })
                    }
                    Ok(_) => Err(WorkspaceError::Protocol.public()), Err(error) => Err(error.public()),
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
            Some(ClientCommand::FrameAck { delivery_id }) => { let _ = self.ack_frame(delivery_id); true }
            Some(ClientCommand::Select { reply, .. }) => { let _ = reply.send(Err(WorkspaceError::Unavailable.public())); true }
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
        self.send_state(FrontendStateRecord::Snapshot { snapshot })
    }

    fn accept_frame(&mut self, header: FrameHeader, payload: Vec<u8>) -> Result<(), WorkspaceError> {
        let selected = match &self.selected { Some(selected) if selected.selection_id == header.selection_id && selected.browser_session_id == header.browser_session_id && selected.tab_id == header.tab_id => selected, _ => { self.dropped += 1; return Ok(()); } };
        if self.browserd_runtime_instance_id.as_deref() != Some(&header.browserd_runtime_instance_id) || header.frame_sequence <= self.last_frame_sequence { self.dropped += 1; return Ok(()); }
        self.last_frame_sequence = header.frame_sequence;
        let _ = selected;
        if self.inflight_delivery_id.is_some() { if self.pending_frame.replace((header, payload)).is_some() { self.dropped += 1; } self.update_frame_metrics(); return Ok(()); }
        self.send_frame(header, payload)
    }

    fn send_frame(&mut self, header: FrameHeader, payload: Vec<u8>) -> Result<(), WorkspaceError> {
        let delivery_id = self.next_delivery_id; self.next_delivery_id = self.next_delivery_id.saturating_add(1);
        let envelope = encode_frame_delivery(delivery_id, &header, &payload)?;
        self.frame_channel.send(Response::new(envelope)).map_err(|_| WorkspaceError::Closed)?;
        self.inflight_delivery_id = Some(delivery_id); self.update_frame_metrics(); Ok(())
    }

    fn ack_frame(&mut self, delivery_id: u64) -> Result<(), WorkspaceError> {
        if self.inflight_delivery_id != Some(delivery_id) { return Ok(()); }
        self.inflight_delivery_id = None;
        if let Some((header, payload)) = self.pending_frame.take() { self.send_frame(header, payload)?; } else { self.update_frame_metrics(); }
        Ok(())
    }

    async fn clear_local_selection(&mut self) {
        self.selected = None; self.pending_frame = None; self.last_frame_sequence = 0; self.update_selected(None).await; let _ = self.send_state(FrontendStateRecord::SelectionCleared);
    }
    async fn update_selected(&self, selected: Option<SelectedTab>) { self.shared.0.write().await.selected = selected; }
    async fn set_connection(&self, connection: &str) { let mut state = self.shared.0.write().await; state.connection = connection.to_owned(); let _ = self.send_state(FrontendStateRecord::Current { state: state.clone() }); }
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
}
