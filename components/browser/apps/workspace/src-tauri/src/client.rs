use crate::{
    acceptance::{AcceptanceDiagnostics, FrameDisposition, FrameOutcome},
    descriptor::WorkspaceDescriptor,
    error::{PublicError, WorkspaceError},
    frame::{admit_frame_sequence, encode_frame_delivery, painted_binding},
    protocol::{self, FrameHeader, FrontendInputBatch, PaintedFrameBinding, ResponseResult, ServerRecord, WorkspaceSnapshot},
    state::{FrontendStateRecord, PublicWorkspaceState, SelectedTab, SharedPublicState, frontend_selected, frontend_snapshot, resolve_frontend_selection},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{async_runtime::JoinHandle, ipc::{Channel, Response}};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::UnixStream, sync::{mpsc, oneshot, watch}, time::{Instant, sleep, sleep_until}};
use uuid::Uuid;

const COMMAND_CAPACITY: usize = 8;
const COMMAND_TTL: Duration = Duration::from_secs(12);
const STOP_SETTLE_TIMEOUT: Duration = Duration::from_secs(6);
const LIFECYCLE_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult { pub opened: bool }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionResult { pub browser_session_id: String, pub tab_id: String }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlActionResult { pub control_state: String }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendInputAck {
    pub accepted_event_count: u8,
    pub coalesced_pointer_move_count: u8,
    pub awaiting_new_frame: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_after_delivery_id: Option<u64>,
}

#[derive(Clone)]
struct PaintedFrameAuthority { binding: PaintedFrameBinding, delivery_id: u64 }

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingLaunchSelection {
    browser_session_id: String,
    tab_id: Option<String>,
    take_control_after_paint: bool,
    expires: Instant,
}

struct LocalControl {
    browser_session_id: String,
    tab_id: String,
    control_epoch: u64,
    input_target_generation: u64,
    next_input_batch_sequence: u64,
    heartbeat_due: Instant,
}

struct LifecycleRequest {
    exit_after_release: bool,
    reply: oneshot::Sender<Result<(), PublicError>>,
}

#[derive(Default)]
struct FrontendErrorSink {
    channel: Option<Channel<FrontendStateRecord>>,
    pending: Option<PublicError>,
}

enum ClientCommand {
    Select { browser_session_id: String, tab_id: Option<String>, raw_ids: bool, take_control_after_paint: bool, expires: Instant, reply: oneshot::Sender<Result<SelectionResult, PublicError>> },
    Clear { expires: Instant, reply: oneshot::Sender<Result<(), PublicError>> },
    FrameAck { delivery_id: u64, disposition: FrameDisposition },
    TakeControl { expires: Instant, reply: oneshot::Sender<Result<ControlActionResult, PublicError>> },
    Input { batch: FrontendInputBatch, reply: oneshot::Sender<Result<FrontendInputAck, PublicError>> },
    #[cfg(test)]
    Stop,
}

pub struct WorkspaceClientService {
    state: SharedPublicState,
    sender: Mutex<Option<mpsc::Sender<ClientCommand>>>,
    task: Mutex<Option<JoinHandle<()>>>,
    shutdown: Mutex<Option<watch::Sender<bool>>>,
    lifecycle: Mutex<Option<mpsc::Sender<LifecycleRequest>>>,
    display_salt: String,
    pending_launch_selection: Arc<Mutex<Option<PendingLaunchSelection>>>,
    frontend_error: Mutex<FrontendErrorSink>,
    acceptance: AcceptanceDiagnostics,
    close_in_progress: AtomicBool,
    has_opened: AtomicBool,
}

impl Default for WorkspaceClientService {
    fn default() -> Self { Self { state: SharedPublicState::default(), sender: Mutex::new(None), task: Mutex::new(None), shutdown: Mutex::new(None), lifecycle: Mutex::new(None), display_salt: Uuid::new_v4().simple().to_string(), pending_launch_selection: Arc::new(Mutex::new(None)), frontend_error: Mutex::new(FrontendErrorSink::default()), acceptance: AcceptanceDiagnostics::default(), close_in_progress: AtomicBool::new(false), has_opened: AtomicBool::new(false) } }
}

impl WorkspaceClientService {
    pub async fn open(&self, state_channel: Channel<FrontendStateRecord>, frame_channel: Channel<Response>) -> Result<OpenResult, PublicError> {
        self.stop_task().await;
        let (sender, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let (lifecycle_sender, lifecycle_receiver) = mpsc::channel(1);
        *self.sender.lock().expect("workspace sender lock") = Some(sender);
        *self.shutdown.lock().expect("workspace shutdown lock") = Some(shutdown_sender);
        *self.lifecycle.lock().expect("workspace lifecycle lock") = Some(lifecycle_sender);
        {
            let mut sink = self.frontend_error.lock().expect("workspace frontend error lock");
            sink.channel = Some(state_channel.clone());
            let delivered = sink.pending.clone().is_some_and(|error| state_channel.send(FrontendStateRecord::Error { error }).is_ok());
            if delivered { sink.pending = None; }
        }
        let shared = self.state.clone();
        let pending_launch_selection = self.pending_launch_selection.clone();
        let display_salt = self.display_salt.clone();
        let acceptance = self.acceptance.clone();
        acceptance.frontend_ready();
        self.has_opened.store(true, Ordering::Release);
        let task = tauri::async_runtime::spawn(async move { Worker::new(shared, state_channel, frame_channel, receiver, shutdown_receiver, lifecycle_receiver, display_salt, pending_launch_selection, acceptance).run().await; });
        *self.task.lock().expect("workspace task lock") = Some(task);
        Ok(OpenResult { opened: true })
    }

    pub async fn select(&self, browser_session_id: String, tab_id: String) -> Result<SelectionResult, PublicError> {
        self.select_request(browser_session_id, Some(tab_id), false, false).await
    }

    pub async fn select_launch(&self, browser_session_id: String, tab_id: Option<String>, take_control_after_paint: bool) -> Result<SelectionResult, PublicError> {
        self.select_request(browser_session_id, tab_id, true, take_control_after_paint).await
    }

    async fn select_request(&self, browser_session_id: String, tab_id: Option<String>, raw_ids: bool, take_control_after_paint: bool) -> Result<SelectionResult, PublicError> {
        if !protocol::valid_id(&browser_session_id) || tab_id.as_ref().is_some_and(|value| !protocol::valid_id(value)) { return Err(WorkspaceError::InvalidSelection.public()); }
        let (reply, received) = oneshot::channel();
        self.send_control(ClientCommand::Select { browser_session_id, tab_id, raw_ids, take_control_after_paint, expires: Instant::now() + COMMAND_TTL, reply }).await?;
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
    pub async fn take_control(&self) -> Result<ControlActionResult, PublicError> {
        let (reply, received) = oneshot::channel();
        self.send_control(ClientCommand::TakeControl { expires: Instant::now() + COMMAND_TTL, reply }).await?;
        tokio::time::timeout(COMMAND_TTL, received).await.map_err(|_| WorkspaceError::Unavailable.public())?.map_err(|_| WorkspaceError::Closed.public())?
    }
    pub async fn return_control(&self) -> Result<ControlActionResult, PublicError> {
        self.cancel_staged_launch_takeover();
        self.lifecycle_request(false).await?;
        Ok(ControlActionResult { control_state: "agent".into() })
    }
    pub async fn input(&self, batch: FrontendInputBatch) -> Result<FrontendInputAck, PublicError> {
        let (reply, received) = oneshot::channel();
        self.send(ClientCommand::Input { batch, reply }).await?;
        tokio::time::timeout(COMMAND_TTL, received).await.map_err(|_| WorkspaceError::Unavailable.public())?.map_err(|_| WorkspaceError::Closed.public())?
    }
    pub fn configure_acceptance(&self, path: &Path) -> Result<(), String> { self.acceptance.configure(path) }
    pub fn acceptance_enabled(&self) -> bool { self.acceptance.enabled() }
    pub fn record_window_action(&self, action: &str) { self.acceptance.window_action(action); }
    pub fn stage_launch_selection_if_offline(&self, browser_session_id: String, tab_id: Option<String>, take_control_after_paint: bool) -> bool {
        let sender = self.sender.lock().expect("workspace sender lock");
        if sender.as_ref().is_some_and(|value| !value.is_closed()) { return false; }
        *self.pending_launch_selection.lock().expect("workspace launch selection lock") = Some(PendingLaunchSelection { browser_session_id, tab_id, take_control_after_paint, expires: Instant::now() + COMMAND_TTL });
        true
    }
    pub async fn current(&self) -> PublicWorkspaceState { self.state.current().await }
    pub fn begin_close(&self) -> bool { !self.close_in_progress.swap(true, Ordering::AcqRel) }
    pub fn finish_close(&self) { self.close_in_progress.store(false, Ordering::Release); }
    pub fn may_hide_without_return(&self) -> bool { !self.has_opened.load(Ordering::Acquire) }
    pub fn notify_error(&self, error: PublicError) {
        self.acceptance.launcher_error(error.code, error.retryable);
        let mut sink = self.frontend_error.lock().expect("workspace frontend error lock");
        sink.pending = Some(error.clone());
        let delivered = sink.channel.as_ref().is_some_and(|channel| channel.send(FrontendStateRecord::Error { error }).is_ok());
        if delivered { sink.pending = None; }
    }

    fn cancel_staged_launch_takeover(&self) {
        let mut pending = self.pending_launch_selection.lock().expect("workspace launch selection lock");
        if pending.as_ref().is_some_and(|request| request.take_control_after_paint) { *pending = None; }
    }

    pub async fn release_for_hide(&self) -> Result<(), PublicError> {
        self.cancel_staged_launch_takeover();
        self.lifecycle_request(false).await
    }

    pub async fn close_task(&self) -> Result<(), PublicError> {
        self.lifecycle_request(true).await?;
        self.sender.lock().expect("workspace sender lock").take();
        self.shutdown.lock().expect("workspace shutdown lock").take();
        self.lifecycle.lock().expect("workspace lifecycle lock").take();
        let task = self.task.lock().expect("workspace task lock").take();
        if let Some(mut task) = task
            && tokio::time::timeout(STOP_SETTLE_TIMEOUT, &mut task).await.is_err()
        {
            task.abort();
            let _ = task.await;
        }
        Ok(())
    }

    pub async fn stop_task(&self) {
        if let Some(shutdown) = self.shutdown.lock().expect("workspace shutdown lock").take() { let _ = shutdown.send(true); }
        self.lifecycle.lock().expect("workspace lifecycle lock").take();
        self.sender.lock().expect("workspace sender lock").take();
        let task = self.task.lock().expect("workspace task lock").take();
        if let Some(mut task) = task {
            if tokio::time::timeout(STOP_SETTLE_TIMEOUT, &mut task).await.is_err() {
                task.abort();
                let _ = task.await;
            }
        }
    }

    async fn lifecycle_request(&self, exit_after_release: bool) -> Result<(), PublicError> {
        let task_exists = self.task.lock().expect("workspace task lock").is_some();
        let Some(sender) = self.lifecycle.lock().expect("workspace lifecycle lock").clone() else {
            return if task_exists { Err(WorkspaceError::Closed.public()) } else { Ok(()) };
        };
        let (reply, received) = oneshot::channel();
        sender.try_send(LifecycleRequest { exit_after_release, reply }).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => WorkspaceError::Capacity.public(),
            mpsc::error::TrySendError::Closed(_) => WorkspaceError::Closed.public(),
        })?;
        tokio::time::timeout(STOP_SETTLE_TIMEOUT, received).await.map_err(|_| WorkspaceError::Unavailable.public())?.map_err(|_| WorkspaceError::Closed.public())?
    }

    fn abort_task(&self) {
        if let Some(shutdown) = self.shutdown.lock().expect("workspace shutdown lock").take() { let _ = shutdown.send(true); }
        self.lifecycle.lock().expect("workspace lifecycle lock").take();
        self.sender.lock().expect("workspace sender lock").take();
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

impl Drop for WorkspaceClientService { fn drop(&mut self) { self.abort_task(); } }

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
    shutdown: watch::Receiver<bool>,
    lifecycle: mpsc::Receiver<LifecycleRequest>,
    display_salt: String,
    snapshot: Option<WorkspaceSnapshot>,
    selected: Option<SelectedTab>,
    transport: Option<Transport>,
    webxd_runtime_instance_id: Option<String>,
    browserd_runtime_instance_id: Option<String>,
    next_delivery_id: u64,
    inflight_delivery_id: Option<u64>,
    inflight_header: Option<FrameHeader>,
    painted_frame: Option<PaintedFrameAuthority>,
    awaiting_new_frame: bool,
    control: Option<LocalControl>,
    pending_frame: Option<(FrameHeader, Vec<u8>)>,
    selection_evidence_gate: SelectionEvidenceGate,
    dropped: u64,
    last_frame_sequence: u64,
    pending_launch_selection: Arc<Mutex<Option<PendingLaunchSelection>>>,
    pending_takeover: Option<Instant>,
    acceptance: AcceptanceDiagnostics,
}

impl Worker {
    fn new(shared: SharedPublicState, state_channel: Channel<FrontendStateRecord>, frame_channel: Channel<Response>, commands: mpsc::Receiver<ClientCommand>, shutdown: watch::Receiver<bool>, lifecycle: mpsc::Receiver<LifecycleRequest>, display_salt: String, pending_launch_selection: Arc<Mutex<Option<PendingLaunchSelection>>>, acceptance: AcceptanceDiagnostics) -> Self {
        Self { shared, state_channel, frame_channel, commands, shutdown, lifecycle, display_salt, snapshot: None, selected: None, transport: None, webxd_runtime_instance_id: None, browserd_runtime_instance_id: None, next_delivery_id: 1, inflight_delivery_id: None, inflight_header: None, painted_frame: None, awaiting_new_frame: false, control: None, pending_frame: None, selection_evidence_gate: SelectionEvidenceGate::default(), dropped: 0, last_frame_sequence: 0, pending_launch_selection, pending_takeover: None, acceptance }
    }

    async fn run(mut self) {
        let mut backoff = Duration::from_millis(100);
        loop {
            if *self.shutdown.borrow() { break; }
            self.set_connection("connecting").await;
            // Takeover is one attempt only. Consume it before any fallible
            // descriptor, socket, bind, subscription, or snapshot work so an
            // unsuccessful attempt can never acquire after reconnect.
            let attempted_takeover = take_attempt_scoped_takeover(&self.pending_launch_selection);
            let takeover_attempted = attempted_takeover.is_some();
            match self.connect(attempted_takeover).await {
                Ok(()) => {
                    backoff = Duration::from_millis(100);
                    self.set_connection("ready").await;
                    match self.connected_loop().await {
                        Ok(true) => break,
                        Ok(false) => {},
                        Err(_) => { self.transport = None; self.pending_frame = None; self.painted_frame = None; self.control = None; self.pending_takeover = None; }
                    }
                }
                Err(error) => {
                    let public = error.public();
                    if takeover_attempted { self.acceptance.launcher_error(public.code, public.retryable); }
                    let _ = self.send_state(FrontendStateRecord::Error { error: public });
                }
            }
            if *self.shutdown.borrow() { break; }
            self.set_connection("reconnecting").await;
            tokio::select! {
                _ = sleep(backoff) => {},
                changed = self.shutdown.changed() => if changed.is_err() || *self.shutdown.borrow() { break; },
                request = self.lifecycle.recv() => if self.handle_lifecycle(request).await { break; },
                command = self.commands.recv() => if !self.offline_command(command).await { break; },
            }
            backoff = (backoff * 2).min(Duration::from_secs(5));
        }
        self.transport = None;
        self.set_connection("closed").await;
    }

    async fn connect(&mut self, attempted_takeover: Option<PendingLaunchSelection>) -> Result<(), WorkspaceError> {
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
        let requested = attempted_takeover.or_else(|| self.pending_launch_selection.lock().expect("workspace launch selection lock").take());
        let requested_target = requested.is_some();
        let requested_expires = requested.as_ref().map(|value| value.expires);
        let requested_takeover = requested.as_ref().is_some_and(|value| value.take_control_after_paint);
        if requested_expires.is_some_and(|expires| Instant::now() >= expires) {
            let error = WorkspaceError::Unavailable.public();
            if requested_takeover { self.acceptance.launcher_error(error.code, error.retryable); }
            self.send_state(FrontendStateRecord::Error { error })?;
            return Ok(());
        }
        let restoring_prior_selection = requested.is_none() && self.selected.is_some();
        if requested.is_some() || self.selected.is_none() {
            let candidate = match requested {
                Some(request) => resolve_pending_launch_target(self.snapshot.as_ref(), request),
                None => self.snapshot.as_ref().and_then(|snapshot| snapshot.sessions.iter().find_map(|session| session.tabs.iter().find(|tab| tab.state == "ready").map(|tab| (session.browser_session_id.clone(), tab.tab_id.clone())))),
            };
            if let Some((browser_session_id, tab_id)) = candidate {
                self.acceptance.selection_requested(&browser_session_id, &tab_id);
                let selection_id = Uuid::new_v4().simple().to_string();
                let mut fields = BTreeMap::new(); fields.insert("browserSessionId", json!(browser_session_id)); fields.insert("tabId", json!(tab_id)); fields.insert("selectionId", json!(selection_id));
                let response = match requested_expires {
                    Some(expires) => self.request_until("frame.select", fields, expires).await,
                    None => self.request("frame.select", fields).await,
                };
                match response {
                    Ok(ResponseResult::Selection { selection_id, browser_session_id, tab_id }) => {
                        let selected = SelectedTab { selection_id, browser_session_id, tab_id }; self.selected = Some(selected.clone()); self.pending_takeover = requested_takeover.then_some(requested_expires.expect("takeover launch deadline")); self.update_selected(Some(selected.clone())).await; self.send_state(FrontendStateRecord::Selection { selected: frontend_selected(&selected, &self.display_salt) })?; self.record_selection_evidence(PendingSelectionEvidence::Selected(selected));
                    }
                    Ok(_) => return Err(WorkspaceError::Protocol),
                    Err(error) => return Err(error),
                }
            } else if requested_target {
                self.send_state(FrontendStateRecord::Error { error: WorkspaceError::InvalidSelection.public() })?;
            }
        }
        if restoring_prior_selection && let Some(selected) = self.selected.clone() {
            let exists = self.snapshot.as_ref().is_some_and(|snapshot| snapshot.contains(&selected.browser_session_id, &selected.tab_id));
            if exists {
                let mut fields = BTreeMap::new(); fields.insert("browserSessionId", json!(selected.browser_session_id)); fields.insert("tabId", json!(selected.tab_id)); fields.insert("selectionId", json!(selected.selection_id));
                if let ResponseResult::Selection { selection_id, browser_session_id, tab_id } = self.request("frame.select", fields).await? { self.selected = Some(SelectedTab { selection_id, browser_session_id, tab_id }); }
            } else { self.clear_local_selection().await; }
        }
        Ok(())
    }

    async fn connected_loop(&mut self) -> Result<bool, WorkspaceError> {
        loop {
            let heartbeat_due = self.control.as_ref().map(|control| control.heartbeat_due).unwrap_or_else(|| Instant::now() + Duration::from_secs(86_400));
            tokio::select! {
                biased;
                changed = self.shutdown.changed() => {
                    if changed.is_err() || *self.shutdown.borrow() { let _ = self.release_control_for_shutdown().await; return Ok(true); }
                }
                request = self.lifecycle.recv() => if self.handle_lifecycle(request).await { return Ok(true); },
                command = self.commands.recv() => if !self.handle_command(command).await? { return Ok(true); },
                record = async { self.transport.as_mut().ok_or(WorkspaceError::Closed)?.read().await } => {
                    let (record, payload) = record?; self.handle_record(record, payload).await?;
                }
                _ = sleep_until(heartbeat_due) => self.heartbeat_control().await?,
            }
        }
    }

    async fn handle_lifecycle(&mut self, request: Option<LifecycleRequest>) -> bool {
        let Some(request) = request else { return false; };
        let result = match tokio::time::timeout(LIFECYCLE_RELEASE_TIMEOUT, self.release_control_for_shutdown()).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(error.public()),
            Err(_) => {
                // The release outcome is ambiguous. Stop this connection and
                // its heartbeats so browserd's disconnect grace can settle it.
                self.transport = None;
                self.control = None;
                self.painted_frame = None;
                self.awaiting_new_frame = false;
                Err(WorkspaceError::Unavailable.public())
            }
        };
        let should_exit = request.exit_after_release && result.is_ok();
        let _ = request.reply.send(result);
        should_exit
    }

    async fn handle_command(&mut self, command: Option<ClientCommand>) -> Result<bool, WorkspaceError> {
        match command {
            None => { let _ = self.release_control_for_shutdown().await; Ok(false) }
            #[cfg(test)]
            Some(ClientCommand::Stop) => { let _ = self.release_control_for_shutdown().await; Ok(false) }
            Some(ClientCommand::FrameAck { delivery_id, disposition }) => {
                self.ack_frame(delivery_id, disposition)?;
                if let Some(expires) = self.pending_takeover.take().filter(|_| self.painted_frame.is_some()) {
                    if let Err(error) = self.acquire_control_until(expires, || true).await { let _ = self.send_state(FrontendStateRecord::Error { error: error.public() }); }
                }
                Ok(true)
            }
            Some(ClientCommand::TakeControl { expires, reply }) => {
                let result = self.acquire_control_until(expires, || !reply.is_closed()).await.map_err(|error| error.public());
                let acquired = result.is_ok();
                if reply.send(result).is_err() && acquired { self.abandon_takeover(); }
                Ok(true)
            }
            Some(ClientCommand::Input { batch, reply }) => { let result = self.dispatch_input(batch).await.map_err(|error| error.public()); let _ = reply.send(result); Ok(true) }
            Some(ClientCommand::Select { browser_session_id, tab_id, raw_ids, take_control_after_paint, expires, reply }) => {
                if self.control.is_some() { let _ = reply.send(Err(WorkspaceError::Remote { code: "CONTROL_HELD_BY_HUMAN".into(), retryable: true }.public())); return Ok(true); }
                if Instant::now() > expires { let _ = reply.send(Err(WorkspaceError::Unavailable.public())); return Ok(true); }
                let resolved = self.snapshot.as_ref().and_then(|snapshot| {
                    if raw_ids {
                        let session = snapshot.sessions.iter().find(|session| session.browser_session_id == browser_session_id)?;
                        let tab = match tab_id.as_ref() {
                            Some(requested) => session.tabs.iter().find(|tab| tab.tab_id == *requested),
                            None => session.tabs.iter().find(|tab| tab.state == "ready").or_else(|| session.tabs.first()),
                        }?;
                        Some((session.browser_session_id.clone(), tab.tab_id.clone()))
                    } else {
                        let tab_id = tab_id.as_ref()?;
                        resolve_frontend_selection(snapshot, &self.display_salt, &browser_session_id, tab_id)
                    }
                });
                let Some((raw_browser_session_id, raw_tab_id)) = resolved else {
                    let _ = reply.send(Err(WorkspaceError::InvalidSelection.public())); return Ok(true);
                };
                self.acceptance.selection_requested(&raw_browser_session_id, &raw_tab_id);
                if take_control_after_paint && selected_target_matches(self.selected.as_ref(), &raw_browser_session_id, &raw_tab_id) {
                    let public_selected = frontend_selected(self.selected.as_ref().expect("matched selected target"), &self.display_salt);
                    let result = self.acquire_control_until(expires, || !reply.is_closed()).await.map(|_| SelectionResult { browser_session_id: public_selected.browser_session_id, tab_id: public_selected.tab_id }).map_err(|error| error.public());
                    let acquired = result.is_ok();
                    if reply.send(result).is_err() && acquired { self.abandon_takeover(); }
                    return Ok(true);
                }
                self.pending_takeover = None; self.pending_frame = None; self.painted_frame = None; self.last_frame_sequence = 0;
                let selection_id = Uuid::new_v4().simple().to_string();
                let mut fields = BTreeMap::new(); fields.insert("browserSessionId", json!(raw_browser_session_id)); fields.insert("tabId", json!(raw_tab_id)); fields.insert("selectionId", json!(selection_id));
                let response = self.request_until("frame.select", fields, expires).await;
                if !live_selection_attempt_active(expires, &reply) {
                    // The caller has already observed failure or its absolute
                    // deadline passed. Discard this transport so any late
                    // response is orphaned with the connection, never applied.
                    self.transport = None;
                    self.pending_takeover = None;
                    let _ = reply.send(Err(WorkspaceError::Unavailable.public()));
                    return Ok(true);
                }
                let result = match response {
                    Ok(ResponseResult::Selection { selection_id, browser_session_id, tab_id }) => {
                        let selected = SelectedTab { selection_id: selection_id.clone(), browser_session_id: browser_session_id.clone(), tab_id: tab_id.clone() };
                        *self.pending_launch_selection.lock().expect("workspace launch selection lock") = None;
                        // A former-selection frame can arrive while request() is waiting for
                        // the authoritative replacement response and raise the sequence
                        // watermark. Reset it only after that response so a newly selected
                        // tab whose sequence is lower remains admissible.
                        self.pending_frame = None; self.painted_frame = None; self.last_frame_sequence = 0; self.selected = Some(selected.clone()); self.pending_takeover = take_control_after_paint.then_some(expires); self.update_selected(Some(selected.clone())).await; let public_selected = frontend_selected(&selected, &self.display_salt); let _ = self.send_state(FrontendStateRecord::Selection { selected: public_selected.clone() }); self.record_selection_evidence(PendingSelectionEvidence::Selected(selected));
                        Ok(SelectionResult { browser_session_id: public_selected.browser_session_id, tab_id: public_selected.tab_id })
                    }
                    Ok(_) => Err(WorkspaceError::Protocol.public()),
                    Err(error) => Err(error.public()),
                };
                let takeover_armed = take_control_after_paint && result.is_ok();
                if reply.send(result).is_err() && takeover_armed { self.abandon_takeover(); }
                Ok(true)
            }
            Some(ClientCommand::Clear { expires, reply }) => {
                if self.control.is_some() { let _ = reply.send(Err(WorkspaceError::Remote { code: "CONTROL_HELD_BY_HUMAN".into(), retryable: true }.public())); return Ok(true); }
                if Instant::now() > expires { let _ = reply.send(Err(WorkspaceError::Unavailable.public())); return Ok(true); }
                let result = self.request("frame.clear", BTreeMap::new()).await.map(|_| ()).map_err(|error| error.public());
                if result.is_ok() { self.clear_local_selection().await; }
                let _ = reply.send(result); Ok(true)
            }
        }
    }

    async fn offline_command(&mut self, command: Option<ClientCommand>) -> bool {
        match command {
            None => false,
            #[cfg(test)]
            Some(ClientCommand::Stop) => false,
            Some(ClientCommand::FrameAck { delivery_id, disposition }) => { let _ = self.ack_frame(delivery_id, disposition); true }
            Some(ClientCommand::TakeControl { reply, .. }) => { let _ = reply.send(Err(WorkspaceError::Unavailable.public())); true }
            Some(ClientCommand::Input { reply, .. }) => { let _ = reply.send(Err(WorkspaceError::Unavailable.public())); true }
            Some(ClientCommand::Select { reply, .. }) => {
                // A live single-instance request that receives an unavailable result
                // must not fire later after reconnect. Only the initial pre-worker
                // launch path may stage a selection or takeover.
                let _ = reply.send(Err(WorkspaceError::Unavailable.public())); true
            }
            Some(ClientCommand::Clear { reply, .. }) => { self.clear_local_selection().await; let _ = reply.send(Ok(())); true }
        }
    }

    async fn request(&mut self, kind: &str, fields: BTreeMap<&str, Value>) -> Result<ResponseResult, WorkspaceError> {
        let request_id = request_id("request");
        self.request_value(request_id.clone(), protocol::command_header(&request_id, kind, fields)).await
    }

    async fn request_until(&mut self, kind: &str, fields: BTreeMap<&str, Value>, deadline: Instant) -> Result<ResponseResult, WorkspaceError> {
        match tokio::time::timeout_at(deadline, self.request(kind, fields)).await {
            Ok(result) => result,
            Err(_) => {
                // Dropping an in-flight request leaves its eventual response
                // unreadable on this serial transport. Close it so the response
                // cannot be mistaken for a later operation.
                self.transport = None;
                Err(WorkspaceError::Unavailable)
            }
        }
    }

    async fn request_value(&mut self, request_id: String, header: Value) -> Result<ResponseResult, WorkspaceError> {
        self.request_value_mode(request_id, header, true).await
    }

    async fn request_value_until(&mut self, request_id: String, header: Value, deadline: Instant) -> Result<ResponseResult, WorkspaceError> {
        match tokio::time::timeout_at(deadline, self.request_value(request_id, header)).await {
            Ok(result) => result,
            Err(_) => {
                self.transport = None;
                Err(WorkspaceError::Unavailable)
            }
        }
    }

    async fn request_value_mode(&mut self, request_id: String, header: Value, interruptible: bool) -> Result<ResponseResult, WorkspaceError> {
        self.transport.as_mut().ok_or(WorkspaceError::Closed)?.write(&header).await?;
        loop {
            let read = if interruptible {
                let transport = self.transport.as_mut().ok_or(WorkspaceError::Closed)?;
                tokio::select! {
                    biased;
                    changed = self.shutdown.changed() => {
                        if changed.is_err() || *self.shutdown.borrow() { None } else { continue; }
                    }
                    record = transport.read() => Some(record),
                }
            } else { Some(self.transport.as_mut().ok_or(WorkspaceError::Closed)?.read().await) };
            let Some(read) = read else { self.transport = None; return Err(WorkspaceError::Closed); };
            let (record, payload) = read?;
            match record {
                ServerRecord::Response { request_id: response_id, result } if response_id == request_id => return result.map_err(|error| WorkspaceError::Remote { code: error.code, retryable: error.retryable }),
                other => self.handle_record(other, payload).await?,
            }
        }
    }

    async fn acquire_control_until<F>(&mut self, deadline: Instant, caller_active: F) -> Result<ControlActionResult, WorkspaceError>
    where F: Fn() -> bool {
        if !takeover_attempt_active(deadline, &caller_active) { return Err(WorkspaceError::Unavailable); }
        if self.control.is_some() { return Err(WorkspaceError::Remote { code: "CONTROL_LEASE_CONFLICT".into(), retryable: true }); }
        let selected = self.selected.clone().ok_or(WorkspaceError::InvalidSelection)?;
        let painted = self.painted_frame.clone().ok_or_else(|| WorkspaceError::Remote { code: "CONTROL_NOT_READY".into(), retryable: true })?;
        if painted.binding.browser_session_id != selected.browser_session_id || painted.binding.tab_id != selected.tab_id || painted.binding.selection_id != selected.selection_id {
            return Err(WorkspaceError::Remote { code: "INPUT_FRAME_STALE".into(), retryable: true });
        }
        let ready = self.snapshot.as_ref().and_then(|snapshot| snapshot.sessions.iter().find(|session| session.browser_session_id == selected.browser_session_id)).is_some_and(|session| {
            session.state == "ready" && session.control_state == "agent" && session.capture_readiness == "ready" && session.control_epoch == painted.binding.control_epoch
                && session.tabs.iter().find(|tab| tab.tab_id == selected.tab_id).is_some_and(|tab| tab.state == "ready" && tab.capture_readiness == "ready" && tab.document_generation == painted.binding.document_generation && tab.viewport_generation == painted.binding.viewport_generation)
        });
        if !ready { return Err(WorkspaceError::Remote { code: "CONTROL_NOT_READY".into(), retryable: true }); }
        let request_id = request_id("control-acquire");
        let header = protocol::control_acquire_header(&request_id, &selected.browser_session_id, &selected.tab_id, painted.binding.control_epoch, &painted.binding);
        let result = self.request_value_until(request_id, header, deadline).await?;
        let ResponseResult::ControlAcquired(acquired) = result else { return Err(WorkspaceError::Protocol); };
        if !takeover_attempt_active(deadline, &caller_active) {
            // The acquire may have committed remotely just as its caller expired.
            // Drop the authority connection before retaining local human control;
            // browserd's disconnect grace then releases the unusable lease.
            self.transport = None;
            return Err(WorkspaceError::Unavailable);
        }
        if acquired.browser_session_id != selected.browser_session_id || acquired.selected_human_control_tab_id != selected.tab_id || acquired.control_epoch <= painted.binding.control_epoch {
            return Err(WorkspaceError::Protocol);
        }
        self.control = Some(LocalControl { browser_session_id: selected.browser_session_id, tab_id: selected.tab_id, control_epoch: acquired.control_epoch, input_target_generation: acquired.input_target_generation, next_input_batch_sequence: 1, heartbeat_due: heartbeat_due(acquired.lease_expires_in_ms) });
        self.painted_frame = None;
        Ok(ControlActionResult { control_state: "human".into() })
    }

    fn abandon_takeover(&mut self) {
        // A takeover whose selection or acquire result has no usable caller
        // must not fire on a later paint or retain human authority. Drop the
        // connection so any remote acquire is revoked by disconnect cleanup.
        self.pending_takeover = None;
        self.control = None;
        self.pending_frame = None;
        self.painted_frame = None;
        self.awaiting_new_frame = false;
        self.transport = None;
    }

    async fn heartbeat_control(&mut self) -> Result<(), WorkspaceError> {
        let Some(control) = self.control.as_ref() else { return Ok(()); };
        let browser_session_id = control.browser_session_id.clone();
        let control_epoch = control.control_epoch;
        let request_id = request_id("control-heartbeat");
        let header = protocol::control_heartbeat_header(&request_id, &browser_session_id, control_epoch);
        let result = self.request_value(request_id, header).await;
        let heartbeat = match result {
            Ok(ResponseResult::ControlHeartbeat(value)) => value,
            Ok(_) => { self.control = None; self.painted_frame = None; return Err(WorkspaceError::Protocol); }
            Err(error) => { self.control = None; self.painted_frame = None; return Err(error); }
        };
        if heartbeat.browser_session_id != browser_session_id || heartbeat.control_epoch != control_epoch { self.control = None; self.painted_frame = None; return Err(WorkspaceError::Protocol); }
        if let Some(control) = self.control.as_mut() { control.heartbeat_due = heartbeat_due(heartbeat.lease_expires_in_ms); }
        Ok(())
    }

    async fn release_control_for_shutdown(&mut self) -> Result<ControlActionResult, WorkspaceError> {
        self.release_control_mode(false).await
    }

    async fn release_control_mode(&mut self, interruptible: bool) -> Result<ControlActionResult, WorkspaceError> {
        self.pending_takeover = None;
        {
            let mut pending = self.pending_launch_selection.lock().expect("workspace launch selection lock");
            if pending.as_ref().is_some_and(|request| request.take_control_after_paint) { *pending = None; }
        }
        let Some(control) = self.control.as_ref() else { self.painted_frame = None; return Ok(ControlActionResult { control_state: "agent".into() }); };
        let browser_session_id = control.browser_session_id.clone();
        let control_epoch = control.control_epoch;
        let request_id = request_id("control-release");
        let header = protocol::control_release_header(&request_id, &browser_session_id, control_epoch);
        let result = self.request_value_mode(request_id, header, interruptible).await?;
        let ResponseResult::ControlReleased(released) = result else { return Err(WorkspaceError::Protocol); };
        if released.browser_session_id != browser_session_id || released.control_epoch <= control_epoch { return Err(WorkspaceError::Protocol); }
        self.control = None; self.painted_frame = None;
        Ok(ControlActionResult { control_state: "agent".into() })
    }

    async fn dispatch_input(&mut self, batch: FrontendInputBatch) -> Result<FrontendInputAck, WorkspaceError> {
        let release_only = batch.events.iter().all(protocol::HumanInputEvent::is_release);
        if self.awaiting_new_frame && !release_only { return Err(WorkspaceError::Remote { code: "INPUT_FRAME_STALE".into(), retryable: true }); }
        let control = self.control.as_ref().ok_or_else(|| WorkspaceError::Remote { code: "CONTROL_LEASE_REQUIRED".into(), retryable: false })?;
        let painted = self.painted_frame.clone().ok_or_else(|| WorkspaceError::Remote { code: "INPUT_FRAME_STALE".into(), retryable: true })?;
        if painted.binding.browser_session_id != control.browser_session_id || painted.binding.tab_id != control.tab_id || painted.binding.control_epoch != control.control_epoch {
            return Err(WorkspaceError::Remote { code: "INPUT_FRAME_STALE".into(), retryable: true });
        }
        let browser_session_id = control.browser_session_id.clone(); let tab_id = control.tab_id.clone(); let control_epoch = control.control_epoch;
        let input_target_generation = control.input_target_generation; let sequence = control.next_input_batch_sequence;
        let event_count = batch.events.len();
        let request_id = request_id("input-batch");
        let header = protocol::input_batch_header(&request_id, &browser_session_id, &tab_id, control_epoch, sequence, input_target_generation, &painted.binding, &batch.events)?;
        let result = self.request_value(request_id, header).await?;
        let ResponseResult::InputAck(ack) = result else { return Err(WorkspaceError::Protocol); };
        if ack.input_batch_sequence != sequence || usize::from(ack.accepted_event_count) != event_count { return Err(WorkspaceError::Protocol); }
        if let Some(control) = self.control.as_mut() { control.next_input_batch_sequence = control.next_input_batch_sequence.checked_add(1).ok_or(WorkspaceError::Protocol)?; }
        self.awaiting_new_frame = ack.awaiting_new_frame;
        // Fence the frontend after the exact painted delivery that authorized
        // this batch. A newer frame can paint while the input response is in
        // flight; fencing after next_delivery_id would then wait for a frame
        // newer than one already painted and can deadlock admission.
        let resume_after_delivery_id = ack.awaiting_new_frame.then_some(painted.delivery_id);
        Ok(FrontendInputAck {
            accepted_event_count: ack.accepted_event_count,
            coalesced_pointer_move_count: ack.coalesced_pointer_move_count,
            awaiting_new_frame: ack.awaiting_new_frame,
            resume_after_delivery_id,
        })
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
        if let Some(control) = self.control.as_ref()
            && snapshot_precedes_control(&snapshot, &control.browser_session_id, control.control_epoch)
        {
            // A pre-acquire snapshot may arrive after the lease response. It
            // cannot invalidate or publicly overwrite the newer local mirror.
            return Ok(());
        }
        let runtime_changed = self.browserd_runtime_instance_id.as_ref().is_some_and(|prior| snapshot.browserd_runtime_instance_id.as_ref() != Some(prior));
        self.browserd_runtime_instance_id = snapshot.browserd_runtime_instance_id.clone();
        if runtime_changed { self.control = None; self.painted_frame = None; self.clear_local_selection().await; }
        if self.selected.as_ref().is_some_and(|selected| !snapshot.contains(&selected.browser_session_id, &selected.tab_id)) { self.control = None; self.painted_frame = None; self.clear_local_selection().await; }
        if let Some(control) = self.control.as_ref() {
            let still_authoritative = snapshot.sessions.iter().find(|session| session.browser_session_id == control.browser_session_id).is_some_and(|session| session.control_state == "human" && session.control_epoch == control.control_epoch && session.selected_human_control_tab_id.as_deref() == Some(&control.tab_id));
            if !still_authoritative { self.control = None; self.painted_frame = None; }
        }
        self.snapshot = Some(snapshot.clone());
        let public_snapshot = frontend_snapshot(&snapshot, &self.display_salt);
        self.shared.0.write().await.snapshot = Some(public_snapshot.clone());
        self.acceptance.snapshot(&snapshot);
        self.send_state(FrontendStateRecord::Snapshot { snapshot: public_snapshot })
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
        if let Some(header) = self.inflight_header.take() {
            self.acceptance.frame_settled(delivery_id, &header, &disposition, rust_retained_frames);
            if disposition.outcome == FrameOutcome::Painted && disposition.decoded_width == Some(header.image_pixel_width) && disposition.decoded_height == Some(header.image_pixel_height) {
                let selected = self.selected.as_ref().is_some_and(|selected| selected.selection_id == header.selection_id && selected.browser_session_id == header.browser_session_id && selected.tab_id == header.tab_id);
                let epoch_current = self.control.as_ref().map_or(true, |control| control.control_epoch == header.control_epoch && control.browser_session_id == header.browser_session_id && control.tab_id == header.tab_id);
                if selected && epoch_current {
                    let painted_at = disposition.painted_at.clone().ok_or(WorkspaceError::Protocol)?;
                    let painted_time = chrono::DateTime::parse_from_rfc3339(&painted_at).map_err(|_| WorkspaceError::Protocol)?;
                    let published_time = chrono::DateTime::parse_from_rfc3339(&header.published_at).map_err(|_| WorkspaceError::Protocol)?;
                    if painted_time < published_time || painted_time > chrono::Utc::now() + chrono::Duration::seconds(1) { return Err(WorkspaceError::Protocol); }
                    self.painted_frame = Some(PaintedFrameAuthority { binding: painted_binding(&header, painted_time.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)), delivery_id });
                    self.awaiting_new_frame = false;
                }
            }
        }
        self.inflight_delivery_id = None;
        self.flush_selection_evidence();
        if let Some((header, payload)) = self.pending_frame.take() { self.send_frame(header, payload)?; } else { self.update_frame_metrics(); }
        Ok(())
    }

    async fn clear_local_selection(&mut self) {
        self.selected = None; self.pending_takeover = None; self.pending_frame = None; self.painted_frame = None; self.last_frame_sequence = 0; self.update_selected(None).await; let _ = self.send_state(FrontendStateRecord::SelectionCleared); self.record_selection_evidence(PendingSelectionEvidence::Cleared);
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
    async fn update_selected(&self, selected: Option<SelectedTab>) { self.shared.0.write().await.selected = selected.as_ref().map(|value| frontend_selected(value, &self.display_salt)); }
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
fn heartbeat_due(lease_expires_in_ms: u64) -> Instant {
    let delay_ms = (lease_expires_in_ms / 3).clamp(250, 2_000);
    Instant::now() + Duration::from_millis(delay_ms)
}

fn snapshot_precedes_control(snapshot: &WorkspaceSnapshot, browser_session_id: &str, control_epoch: u64) -> bool {
    snapshot.sessions.iter().find(|session| session.browser_session_id == browser_session_id).is_some_and(|session| session.control_epoch < control_epoch)
}

fn take_attempt_scoped_takeover(pending: &Arc<Mutex<Option<PendingLaunchSelection>>>) -> Option<PendingLaunchSelection> {
    let mut pending = pending.lock().expect("workspace launch selection lock");
    if pending.as_ref().is_some_and(|request| request.take_control_after_paint) { pending.take() } else { None }
}

fn live_selection_attempt_active(expires: Instant, reply: &oneshot::Sender<Result<SelectionResult, PublicError>>) -> bool {
    takeover_attempt_active(expires, &|| !reply.is_closed())
}

fn takeover_attempt_active<F>(expires: Instant, caller_active: &F) -> bool
where F: Fn() -> bool {
    Instant::now() < expires && caller_active()
}

fn selected_target_matches(selected: Option<&SelectedTab>, browser_session_id: &str, tab_id: &str) -> bool {
    selected.is_some_and(|value| value.browser_session_id == browser_session_id && value.tab_id == tab_id)
}

fn resolve_pending_launch_target(snapshot: Option<&WorkspaceSnapshot>, request: PendingLaunchSelection) -> Option<(String, String)> {
    let browser_session_id = request.browser_session_id;
    let tab_id = request.tab_id.or_else(|| snapshot
        .and_then(|snapshot| snapshot.sessions.iter().find(|session| session.browser_session_id == browser_session_id))
        .and_then(|session| session.tabs.iter().find(|tab| tab.state == "ready").or_else(|| session.tabs.first()))
        .map(|tab| tab.tab_id.clone()));
    tab_id.map(|tab_id| (browser_session_id, tab_id))
}

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

    #[test]
    fn launch_selection_uses_exactly_one_offline_or_live_route() {
        let service = WorkspaceClientService::default();
        assert!(service.stage_launch_selection_if_offline("session-one".into(), Some("tab-one".into()), true));
        {
            let pending = service.pending_launch_selection.lock().expect("workspace launch selection lock");
            let pending = pending.as_ref().expect("pending launch selection");
            assert_eq!(pending.browser_session_id, "session-one"); assert_eq!(pending.tab_id.as_deref(), Some("tab-one")); assert!(pending.take_control_after_paint); assert!(pending.expires > Instant::now());
        }

        *service.pending_launch_selection.lock().expect("workspace launch selection lock") = None;
        let (sender, receiver) = mpsc::channel(1);
        *service.sender.lock().expect("workspace sender lock") = Some(sender);
        assert!(!service.stage_launch_selection_if_offline("session-two".into(), Some("tab-two".into()), false));
        assert!(service.pending_launch_selection.lock().expect("workspace launch selection lock").is_none());

        drop(receiver);
        assert!(service.stage_launch_selection_if_offline("session-three".into(), None, false));
        {
            let pending = service.pending_launch_selection.lock().expect("workspace launch selection lock");
            let pending = pending.as_ref().expect("pending launch selection");
            assert_eq!(pending.browser_session_id, "session-three"); assert!(pending.tab_id.is_none()); assert!(!pending.take_control_after_paint); assert!(pending.expires > Instant::now());
        }
    }

    #[test]
    fn initial_takeover_is_consumed_before_fallible_connection_setup() {
        let takeover = Arc::new(Mutex::new(Some(PendingLaunchSelection {
            browser_session_id: "session:one".into(),
            tab_id: Some("tab:one".into()),
            take_control_after_paint: true,
            expires: Instant::now() + COMMAND_TTL,
        })));
        let attempted = take_attempt_scoped_takeover(&takeover).expect("first takeover attempt");
        assert!(attempted.take_control_after_paint);
        assert!(takeover.lock().expect("workspace launch selection lock").is_none());
        drop(attempted); // Simulate any descriptor/socket/bind/snapshot failure.
        assert!(take_attempt_scoped_takeover(&takeover).is_none());

        let attach = Arc::new(Mutex::new(Some(PendingLaunchSelection {
            browser_session_id: "session:two".into(),
            tab_id: None,
            take_control_after_paint: false,
            expires: Instant::now() + COMMAND_TTL,
        })));
        assert!(take_attempt_scoped_takeover(&attach).is_none());
        assert!(attach.lock().expect("workspace launch selection lock").is_some());
    }

    #[test]
    fn same_target_takeover_can_reuse_only_the_exact_selected_target() {
        let selected = SelectedTab { selection_id: "selection-one".into(), browser_session_id: "session-one".into(), tab_id: "tab-one".into() };
        assert!(selected_target_matches(Some(&selected), "session-one", "tab-one"));
        assert!(!selected_target_matches(Some(&selected), "session-two", "tab-one"));
        assert!(!selected_target_matches(Some(&selected), "session-one", "tab-two"));
        assert!(!selected_target_matches(None, "session-one", "tab-one"));
    }

    #[test]
    fn expired_or_abandoned_live_selection_or_takeover_cannot_commit() {
        let (open_reply, _open_receiver) = oneshot::channel();
        assert!(live_selection_attempt_active(Instant::now() + Duration::from_secs(1), &open_reply));

        let (abandoned_reply, abandoned_receiver) = oneshot::channel();
        drop(abandoned_receiver);
        assert!(!live_selection_attempt_active(Instant::now() + Duration::from_secs(1), &abandoned_reply));

        let (expired_reply, _expired_receiver) = oneshot::channel();
        let expired = Instant::now().checked_sub(Duration::from_millis(1)).expect("past instant");
        assert!(!live_selection_attempt_active(expired, &expired_reply));
        assert!(!takeover_attempt_active(expired, &|| true));
        assert!(!takeover_attempt_active(Instant::now() + Duration::from_secs(1), &|| false));
        assert!(takeover_attempt_active(Instant::now() + Duration::from_secs(1), &|| true));
    }

    #[test]
    fn failed_takeover_reply_delivery_revokes_local_authority() {
        let (_sender, receiver) = mpsc::channel(1);
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);
        let (_lifecycle_sender, lifecycle_receiver) = mpsc::channel(1);
        let mut worker = Worker::new(
            SharedPublicState::default(), Channel::new(|_| Ok(())), Channel::new(|_| Ok(())), receiver,
            shutdown_receiver, lifecycle_receiver, "test-display-salt".into(), Arc::new(Mutex::new(None)), AcceptanceDiagnostics::default(),
        );
        worker.control = Some(LocalControl { browser_session_id: "session:one".into(), tab_id: "tab:one".into(), control_epoch: 2, input_target_generation: 1, next_input_batch_sequence: 1, heartbeat_due: Instant::now() + Duration::from_secs(1) });
        let (reply, received) = oneshot::channel::<Result<ControlActionResult, PublicError>>();
        drop(received);
        let result = Ok(ControlActionResult { control_state: "human".into() });
        let acquired = result.is_ok();
        if reply.send(result).is_err() && acquired { worker.abandon_takeover(); }
        assert!(worker.control.is_none());
        assert!(worker.transport.is_none());

        worker.pending_takeover = Some(Instant::now() + COMMAND_TTL);
        let (reply, received) = oneshot::channel::<Result<SelectionResult, PublicError>>();
        drop(received);
        let result = Ok(SelectionResult { browser_session_id: "agent-display".into(), tab_id: "tab-display".into() });
        let takeover_armed = result.is_ok();
        if reply.send(result).is_err() && takeover_armed { worker.abandon_takeover(); }
        assert!(worker.pending_takeover.is_none());
        assert!(worker.transport.is_none());
    }

    #[tokio::test]
    async fn rejected_live_launch_selection_does_not_fire_after_reconnect() {
        let (_sender, receiver) = mpsc::channel(1);
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);
        let (_lifecycle_sender, lifecycle_receiver) = mpsc::channel(1);
        let pending = Arc::new(Mutex::new(None));
        let mut worker = Worker::new(
            SharedPublicState::default(),
            Channel::new(|_| Ok(())),
            Channel::new(|_| Ok(())),
            receiver,
            shutdown_receiver,
            lifecycle_receiver,
            "test-display-salt".into(),
            pending.clone(),
            AcceptanceDiagnostics::default(),
        );
        let (reply, received) = oneshot::channel();
        assert!(worker.offline_command(Some(ClientCommand::Select {
            browser_session_id: "session:one".into(),
            tab_id: Some("tab:one".into()),
            raw_ids: true,
            take_control_after_paint: true,
            expires: Instant::now() + COMMAND_TTL,
            reply,
        })).await);
        assert!(received.await.expect("selection result").is_err());
        assert!(pending.lock().expect("workspace launch selection lock").is_none());
        assert!(worker.pending_takeover.is_none());
    }

    #[test]
    fn missing_initial_launch_target_is_not_silently_retargeted() {
        let snapshot: WorkspaceSnapshot = serde_json::from_value(json!({
            "workspaceRevision": 1,
            "browserdRuntimeInstanceId": "runtime:one",
            "generatedAt": "2026-08-31T00:00:00.000Z",
            "browserdState": "ready",
            "sessions": []
        })).expect("workspace snapshot");
        assert!(resolve_pending_launch_target(Some(&snapshot), PendingLaunchSelection {
            browser_session_id: "session:missing".into(),
            tab_id: None,
            take_control_after_paint: true,
            expires: Instant::now() + COMMAND_TTL,
        }).is_none());
    }

    #[tokio::test]
    async fn explicit_return_cancels_staged_and_paint_pending_takeover() {
        let service = WorkspaceClientService::default();
        assert!(service.stage_launch_selection_if_offline("session:one".into(), Some("tab:one".into()), true));
        service.release_for_hide().await.expect("pre-open return");
        assert!(service.pending_launch_selection.lock().expect("workspace launch selection lock").is_none());

        let (_sender, receiver) = mpsc::channel(1);
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);
        let (_lifecycle_sender, lifecycle_receiver) = mpsc::channel(1);
        let pending = Arc::new(Mutex::new(Some(PendingLaunchSelection {
            browser_session_id: "session:one".into(),
            tab_id: Some("tab:one".into()),
            take_control_after_paint: true,
            expires: Instant::now() + COMMAND_TTL,
        })));
        let mut worker = Worker::new(
            SharedPublicState::default(),
            Channel::new(|_| Ok(())),
            Channel::new(|_| Ok(())),
            receiver,
            shutdown_receiver,
            lifecycle_receiver,
            "test-display-salt".into(),
            pending.clone(),
            AcceptanceDiagnostics::default(),
        );
        worker.pending_takeover = Some(Instant::now() + COMMAND_TTL);
        worker.release_control_for_shutdown().await.expect("return before paint");
        assert!(worker.pending_takeover.is_none());
        assert!(pending.lock().expect("workspace launch selection lock").is_none());
    }

    #[test]
    fn launcher_error_bypasses_a_full_ordinary_command_queue() {
        let service = WorkspaceClientService::default();
        let (sender, _receiver) = mpsc::channel(1);
        sender.try_send(ClientCommand::Stop).expect("fill ordinary command queue");
        *service.sender.lock().expect("workspace sender lock") = Some(sender);
        let observed = Arc::new(AtomicBool::new(false));
        let observed_for_channel = observed.clone();
        service.frontend_error.lock().expect("workspace frontend error lock").channel = Some(Channel::new(move |_| {
            observed_for_channel.store(true, Ordering::Release);
            Ok(())
        }));
        service.notify_error(WorkspaceError::Unavailable.public());
        assert!(observed.load(Ordering::Acquire));
        assert!(service.frontend_error.lock().expect("workspace frontend error lock").pending.is_none());
    }

    #[test]
    fn painted_ack_retains_exact_rust_only_frame_authority() {
        let (_sender, receiver) = mpsc::channel(1);
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);
        let (_lifecycle_sender, lifecycle_receiver) = mpsc::channel(1);
        let mut worker = Worker::new(
            SharedPublicState::default(),
            Channel::new(|_| Ok(())),
            Channel::new(|_| Ok(())),
            receiver,
            shutdown_receiver,
            lifecycle_receiver,
            "test-display-salt".into(),
            Arc::new(Mutex::new(None)),
            AcceptanceDiagnostics::default(),
        );
        worker.selected = Some(SelectedTab { selection_id: "selection_123456".into(), browser_session_id: "session:one".into(), tab_id: "tab:one".into() });
        worker.browserd_runtime_instance_id = Some("runtime_123456789".into());
        let published_at = (chrono::Utc::now() - chrono::Duration::milliseconds(10)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let header = FrameHeader {
            protocol_version: "workspace.v2".into(), kind: "frame".into(), selection_id: "selection_123456".into(), subscription_id: "subscription_1234".into(), browserd_runtime_instance_id: "runtime_123456789".into(), browser_session_id: "session:one".into(), tab_id: "tab:one".into(), control_epoch: 7, frame_sequence: 11, document_generation: 3, viewport_generation: 4, captured_at: published_at.clone(), published_at, media_type: "image/png".into(), byte_length: 3, sha256: "a".repeat(64), image_pixel_width: 1000, image_pixel_height: 750, css_viewport_width: 800.5, css_viewport_height: 600.25, device_pixel_ratio: 1.25,
        };
        worker.inflight_delivery_id = Some(9);
        worker.inflight_header = Some(header);
        let painted_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        worker.ack_frame(9, FrameDisposition { outcome: FrameOutcome::Painted, frontend_type: crate::acceptance::FrontendBinaryType::ArrayBuffer, reason: None, decode_ms: Some(1.0), paint_ms: Some(1.0), total_ms: Some(2.0), decoded_at: Some(painted_at.clone()), painted_at: Some(painted_at), decoded_width: Some(1000), decoded_height: Some(750), frontend_retained_frames: 1, frontend_image_bitmaps: 0, maximum_frontend_image_bitmaps: 1 }).expect("paint acknowledgement");
        let binding = &worker.painted_frame.as_ref().expect("painted authority").binding;
        assert_eq!(binding.selection_id, "selection_123456");
        assert_eq!(binding.browserd_runtime_instance_id, "runtime_123456789");
        assert_eq!(binding.subscription_id, "subscription_1234");
        assert_eq!((binding.control_epoch, binding.frame_sequence, binding.document_generation, binding.viewport_generation), (7, 11, 3, 4));
        assert_eq!((binding.image_pixel_width, binding.image_pixel_height), (1000, 750));
        assert_eq!((binding.css_viewport_width, binding.css_viewport_height, binding.device_pixel_ratio), (800.5, 600.25, 1.25));
    }

    #[test]
    fn close_latch_and_initial_hide_bypass_are_one_way_after_open() {
        let service = WorkspaceClientService::default();
        assert!(service.may_hide_without_return());
        assert!(service.begin_close());
        assert!(!service.begin_close());
        service.finish_close();
        assert!(service.begin_close());
        service.finish_close();
        service.has_opened.store(true, Ordering::Release);
        assert!(!service.may_hide_without_return());
    }

    #[tokio::test]
    async fn graceful_stop_bypasses_a_full_command_queue_before_joining_the_worker() {
        let service = WorkspaceClientService::default();
        let (sender, _receiver) = mpsc::channel(1);
        sender.try_send(ClientCommand::Stop).expect("fill command queue");
        let (shutdown_sender, mut shutdown_receiver) = watch::channel(false);
        let (settled, observed) = oneshot::channel();
        *service.sender.lock().expect("workspace sender lock") = Some(sender);
        *service.shutdown.lock().expect("workspace shutdown lock") = Some(shutdown_sender);
        *service.task.lock().expect("workspace task lock") = Some(tauri::async_runtime::spawn(async move {
            shutdown_receiver.changed().await.expect("shutdown signal");
            assert!(*shutdown_receiver.borrow());
            let _ = settled.send(());
        }));
        service.stop_task().await;
        observed.await.expect("worker observed graceful stop");
        assert!(service.sender.lock().expect("workspace sender lock").is_none());
        assert!(service.shutdown.lock().expect("workspace shutdown lock").is_none());
        assert!(service.task.lock().expect("workspace task lock").is_none());
    }

    #[test]
    fn pre_acquire_snapshot_cannot_invalidate_a_newer_local_control_epoch() {
        let snapshot: WorkspaceSnapshot = serde_json::from_value(json!({
            "workspaceRevision": 8,
            "browserdRuntimeInstanceId": "runtime:one",
            "generatedAt": "2026-08-31T00:00:00.000Z",
            "browserdState": "ready",
            "sessions": [{
                "browserSessionId": "session:one", "agentLabel": "Agent", "actorDisplayId": "actor:one", "pathId": "path:one",
                "state": "ready", "controlState": "agent", "controlEpoch": 4, "controlTransfer": "none",
                "selectedHumanControlTabId": null, "leaseExpiry": "none", "captureReadiness": "ready", "personaDisplayId": "persona:one",
                "cursor": { "x": 0.0, "y": 0.0, "visible": true, "pathSequence": 0, "sampleSequence": 0 },
                "tabs": [], "activeOperation": null, "lastActivityAt": null
            }]
        })).expect("workspace snapshot");
        assert!(snapshot_precedes_control(&snapshot, "session:one", 5));
        assert!(!snapshot_precedes_control(&snapshot, "session:one", 4));
        assert!(!snapshot_precedes_control(&snapshot, "session:other", 5));
    }

    #[tokio::test]
    async fn close_release_bypasses_a_full_ordinary_command_queue() {
        let service = WorkspaceClientService::default();
        let (sender, _receiver) = mpsc::channel(1);
        sender.try_send(ClientCommand::Stop).expect("fill ordinary command queue");
        *service.sender.lock().expect("workspace sender lock") = Some(sender);
        let (lifecycle_sender, mut lifecycle_receiver) = mpsc::channel(1);
        *service.lifecycle.lock().expect("workspace lifecycle lock") = Some(lifecycle_sender);
        *service.task.lock().expect("workspace task lock") = Some(tauri::async_runtime::spawn(async move {
            let request = lifecycle_receiver.recv().await.expect("independent lifecycle request");
            assert!(request.exit_after_release);
            let _ = request.reply.send(Ok(()));
        }));
        service.close_task().await.expect("close release");
        assert!(service.sender.lock().expect("workspace sender lock").is_none());
        assert!(service.lifecycle.lock().expect("workspace lifecycle lock").is_none());
        assert!(service.task.lock().expect("workspace task lock").is_none());
    }

    #[tokio::test]
    async fn hide_release_bypasses_a_full_ordinary_command_queue() {
        let service = WorkspaceClientService::default();
        let (sender, _ordinary_receiver) = mpsc::channel(1);
        sender.try_send(ClientCommand::Stop).expect("fill ordinary command queue");
        *service.sender.lock().expect("workspace sender lock") = Some(sender);
        let (lifecycle_sender, mut lifecycle_receiver) = mpsc::channel(1);
        *service.lifecycle.lock().expect("workspace lifecycle lock") = Some(lifecycle_sender);
        *service.task.lock().expect("workspace task lock") = Some(tauri::async_runtime::spawn(async move {
            let request = lifecycle_receiver.recv().await.expect("independent lifecycle request");
            assert!(!request.exit_after_release);
            let _ = request.reply.send(Ok(()));
        }));
        service.release_for_hide().await.expect("hide release");
        service.stop_task().await;
    }

    #[test]
    fn frontend_input_ack_exposes_only_sanitized_counts_and_display_delivery_fence() {
        let value = serde_json::to_value(FrontendInputAck { accepted_event_count: 2, coalesced_pointer_move_count: 1, awaiting_new_frame: true, resume_after_delivery_id: Some(17) }).expect("serialize frontend input acknowledgement");
        assert_eq!(value, json!({ "acceptedEventCount": 2, "coalescedPointerMoveCount": 1, "awaitingNewFrame": true, "resumeAfterDeliveryId": 17 }));
        let text = value.to_string();
        for forbidden in ["inputBatchSequence", "controlEpoch", "lease", "generation", "frameSequence"] { assert!(!text.contains(forbidden)); }
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
