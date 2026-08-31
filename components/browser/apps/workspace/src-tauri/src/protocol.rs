use crate::error::WorkspaceError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: &str = "workspace.v2";
pub const MAX_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_FRAME_PIXELS: u64 = 33_554_432;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cursor {
    pub x: f64,
    pub y: f64,
    pub visible: bool,
    pub path_sequence: u64,
    pub sample_sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    pub operation_id: String,
    pub kind: String,
    pub state: String,
    pub dispatch_state: String,
    pub started_at: Option<String>,
    pub cancellable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceTab {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub state: String,
    pub capture_readiness: String,
    pub document_generation: u64,
    pub viewport_generation: u64,
    pub frame_sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSession {
    pub browser_session_id: String,
    pub agent_label: String,
    pub actor_display_id: String,
    pub path_id: String,
    pub state: String,
    pub control_state: String,
    pub control_epoch: u64,
    pub control_transfer: String,
    pub selected_human_control_tab_id: Option<String>,
    pub lease_expiry: String,
    pub capture_readiness: String,
    pub persona_display_id: String,
    pub cursor: Cursor,
    pub tabs: Vec<WorkspaceTab>,
    pub active_operation: Option<Operation>,
    pub last_activity_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSnapshot {
    pub workspace_revision: u64,
    pub browserd_runtime_instance_id: Option<String>,
    pub generated_at: String,
    pub browserd_state: String,
    pub sessions: Vec<WorkspaceSession>,
}

impl WorkspaceSnapshot {
    pub fn contains(&self, browser_session_id: &str, tab_id: &str) -> bool {
        self.sessions.iter().any(|session| session.browser_session_id == browser_session_id && session.tabs.iter().any(|tab| tab.tab_id == tab_id))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStatus {
    pub connection: String,
    pub browserd: String,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameHeader {
    pub protocol_version: String,
    pub kind: String,
    pub selection_id: String,
    pub subscription_id: String,
    pub browserd_runtime_instance_id: String,
    pub browser_session_id: String,
    pub tab_id: String,
    pub control_epoch: u64,
    pub frame_sequence: u64,
    pub document_generation: u64,
    pub viewport_generation: u64,
    pub captured_at: String,
    pub published_at: String,
    pub media_type: String,
    pub byte_length: usize,
    pub sha256: String,
    pub image_pixel_width: u32,
    pub image_pixel_height: u32,
    pub css_viewport_width: f64,
    pub css_viewport_height: f64,
    pub device_pixel_ratio: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaintedFrameBinding {
    pub selection_id: String,
    pub browserd_runtime_instance_id: String,
    pub browser_session_id: String,
    pub tab_id: String,
    pub subscription_id: String,
    pub control_epoch: u64,
    pub frame_sequence: u64,
    pub document_generation: u64,
    pub viewport_generation: u64,
    pub image_pixel_width: u32,
    pub image_pixel_height: u32,
    pub css_viewport_width: f64,
    pub css_viewport_height: f64,
    pub device_pixel_ratio: f64,
    pub painted_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum HumanInputEvent {
    PointerMove { point: HumanPoint },
    PointerDown { point: HumanPoint, button: HumanButton, click_count: Option<u8> },
    PointerUp { point: HumanPoint, button: HumanButton, click_count: Option<u8> },
    Wheel { point: HumanPoint, delta_x: f64, delta_y: f64 },
    KeyDown { key: String, code: Option<String>, repeat: Option<bool> },
    KeyUp { key: String, code: Option<String> },
    Text { text: String },
}

impl HumanInputEvent {
    pub fn is_release(&self) -> bool { matches!(self, Self::PointerUp { .. } | Self::KeyUp { .. }) }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanPoint { pub image_x: f64, pub image_y: f64 }

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HumanButton { Left, Middle, Right }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendInputBatch { pub events: Vec<HumanInputEvent> }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlStatusResult {
    pub kind: String, pub browser_session_id: String, pub control_state: String, pub control_epoch: u64,
    pub control_transfer: String, pub selected_human_control_tab_id: Option<String>, pub capture_readiness: String, pub lease_expiry: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlAcquiredResult {
    pub kind: String, pub browser_session_id: String, pub selected_human_control_tab_id: String, pub control_state: String,
    pub control_epoch: u64, pub control_transfer: String, pub capture_readiness: String, pub lease_expiry: String,
    pub lease_expires_in_ms: u64, pub input_target_generation: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlHeartbeatResult {
    pub kind: String, pub browser_session_id: String, pub selected_human_control_tab_id: String, pub control_state: String,
    pub control_epoch: u64, pub lease_expiry: String, pub lease_expires_in_ms: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlReleasedResult {
    pub kind: String, pub browser_session_id: String, pub control_state: String, pub control_epoch: u64, pub control_transfer: String, pub lease_expiry: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputAck {
    pub kind: String, pub input_batch_sequence: u64, pub accepted_event_count: u8, pub coalesced_pointer_move_count: u8, pub awaiting_new_frame: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoundHeader {
    protocol_version: String,
    kind: String,
    request_id: String,
    webxd_runtime_instance_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotHeader {
    protocol_version: String,
    kind: String,
    snapshot: WorkspaceSnapshot,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusHeader {
    protocol_version: String,
    kind: String,
    status: WorkspaceStatus,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResponseHeader {
    protocol_version: String,
    kind: String,
    request_id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<ProtocolError>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug)]
pub enum ServerRecord {
    Bound { request_id: String, webxd_runtime_instance_id: String },
    Response { request_id: String, result: Result<ResponseResult, ProtocolError> },
    Snapshot(WorkspaceSnapshot),
    Status(WorkspaceStatus),
    Frame(FrameHeader),
}

#[derive(Clone, Debug)]
pub enum ResponseResult {
    Ack,
    Pong,
    Selection { selection_id: String, browser_session_id: String, tab_id: String },
    Snapshot(WorkspaceSnapshot),
    ControlStatus,
    ControlAcquired(ControlAcquiredResult),
    ControlHeartbeat(ControlHeartbeatResult),
    ControlReleased(ControlReleasedResult),
    InputAck(InputAck),
}

pub fn parse_server_record(header: &[u8], payload_len: usize) -> Result<ServerRecord, WorkspaceError> {
    if header.len() < 2 || header.len() > MAX_HEADER_BYTES || payload_len > MAX_PAYLOAD_BYTES { return Err(WorkspaceError::Protocol); }
    let value: Value = serde_json::from_slice(header).map_err(|_| WorkspaceError::Protocol)?;
    let object = value.as_object().ok_or(WorkspaceError::Protocol)?;
    if object.get("protocolVersion").and_then(Value::as_str) != Some(PROTOCOL_VERSION) { return Err(WorkspaceError::Protocol); }
    let kind = object.get("kind").and_then(Value::as_str).ok_or(WorkspaceError::Protocol)?;
    let record = match kind {
        "bound" => {
            require_no_payload(payload_len)?;
            let item: BoundHeader = serde_json::from_value(value).map_err(|_| WorkspaceError::Protocol)?;
            validate_common(&item.protocol_version, &item.kind)?;
            if !id(&item.request_id) || !opaque_id(&item.webxd_runtime_instance_id) { return Err(WorkspaceError::Protocol); }
            ServerRecord::Bound { request_id: item.request_id, webxd_runtime_instance_id: item.webxd_runtime_instance_id }
        }
        "response" => {
            require_no_payload(payload_len)?;
            let item: ResponseHeader = serde_json::from_value(value).map_err(|_| WorkspaceError::Protocol)?;
            validate_common(&item.protocol_version, &item.kind)?;
            if !id(&item.request_id) || item.ok == item.error.is_some() || item.ok != item.result.is_some() { return Err(WorkspaceError::Protocol); }
            let result = if item.ok { Ok(parse_result(item.result.ok_or(WorkspaceError::Protocol)?)?) } else { Err(item.error.ok_or(WorkspaceError::Protocol)?) };
            ServerRecord::Response { request_id: item.request_id, result }
        }
        "snapshot" => {
            require_no_payload(payload_len)?;
            let item: SnapshotHeader = serde_json::from_value(value).map_err(|_| WorkspaceError::Protocol)?;
            validate_common(&item.protocol_version, &item.kind)?; validate_snapshot(&item.snapshot)?;
            ServerRecord::Snapshot(item.snapshot)
        }
        "status" => {
            require_no_payload(payload_len)?;
            let item: StatusHeader = serde_json::from_value(value).map_err(|_| WorkspaceError::Protocol)?;
            validate_common(&item.protocol_version, &item.kind)?;
            ServerRecord::Status(item.status)
        }
        "frame" => {
            let item: FrameHeader = serde_json::from_value(value).map_err(|_| WorkspaceError::Protocol)?;
            validate_common(&item.protocol_version, &item.kind)?; validate_frame(&item, payload_len)?;
            ServerRecord::Frame(item)
        }
        _ => return Err(WorkspaceError::Protocol),
    };
    Ok(record)
}

fn parse_result(value: Value) -> Result<ResponseResult, WorkspaceError> {
    let object = value.as_object().ok_or(WorkspaceError::Protocol)?;
    let kind = object.get("kind").and_then(Value::as_str).ok_or(WorkspaceError::Protocol)?;
    match kind {
        "ack" => { exact_keys(object, &["kind"])?; Ok(ResponseResult::Ack) }
        "pong" => { exact_keys(object, &["kind", "generatedAt"])?; Ok(ResponseResult::Pong) }
        "selection" => {
            exact_keys(object, &["kind", "selectionId", "browserSessionId", "tabId"])?;
            let selection_id = string(object, "selectionId")?; let browser_session_id = string(object, "browserSessionId")?; let tab_id = string(object, "tabId")?;
            if !opaque_id(&selection_id) || !id(&browser_session_id) || !id(&tab_id) { return Err(WorkspaceError::Protocol); }
            Ok(ResponseResult::Selection { selection_id, browser_session_id, tab_id })
        }
        "snapshot" => {
            exact_keys(object, &["kind", "snapshot"])?;
            let snapshot: WorkspaceSnapshot = serde_json::from_value(object.get("snapshot").cloned().ok_or(WorkspaceError::Protocol)?).map_err(|_| WorkspaceError::Protocol)?;
            validate_snapshot(&snapshot)?; Ok(ResponseResult::Snapshot(snapshot))
        }
        "controlStatus" => { let item: ControlStatusResult = serde_json::from_value(value).map_err(|_| WorkspaceError::Protocol)?; validate_control_status(&item)?; Ok(ResponseResult::ControlStatus) }
        "controlAcquired" => { let item: ControlAcquiredResult = serde_json::from_value(value).map_err(|_| WorkspaceError::Protocol)?; validate_control_acquired(&item)?; Ok(ResponseResult::ControlAcquired(item)) }
        "controlHeartbeat" => { let item: ControlHeartbeatResult = serde_json::from_value(value).map_err(|_| WorkspaceError::Protocol)?; validate_control_heartbeat(&item)?; Ok(ResponseResult::ControlHeartbeat(item)) }
        "controlReleased" => { let item: ControlReleasedResult = serde_json::from_value(value).map_err(|_| WorkspaceError::Protocol)?; validate_control_released(&item)?; Ok(ResponseResult::ControlReleased(item)) }
        "inputAck" => { let item: InputAck = serde_json::from_value(value).map_err(|_| WorkspaceError::Protocol)?; if item.kind != "inputAck" || item.input_batch_sequence == 0 || item.accepted_event_count > 32 || item.coalesced_pointer_move_count > 32 { return Err(WorkspaceError::Protocol); } Ok(ResponseResult::InputAck(item)) }
        _ => Err(WorkspaceError::Protocol),
    }
}

fn validate_snapshot(snapshot: &WorkspaceSnapshot) -> Result<(), WorkspaceError> {
    if snapshot.sessions.len() > 256 || !matches!(snapshot.browserd_state.as_str(), "ready" | "unavailable" | "replaced") { return Err(WorkspaceError::Protocol); }
    if snapshot.browserd_runtime_instance_id.as_deref().is_some_and(|value| !opaque_id(value)) { return Err(WorkspaceError::Protocol); }
    for session in &snapshot.sessions {
        if !id(&session.browser_session_id) || !opaque_id(&session.actor_display_id) || session.path_id != "agentcursor/chrome" || !control_state(&session.control_state) || session.control_epoch == 0 || !control_transfer(&session.control_transfer) || !lease_expiry(&session.lease_expiry) || !capture_readiness(&session.capture_readiness) || session.tabs.len() > 16 { return Err(WorkspaceError::Protocol); }
        if session.selected_human_control_tab_id.as_deref().is_some_and(|value| !id(value)) { return Err(WorkspaceError::Protocol); }
        for tab in &session.tabs { if !id(&tab.tab_id) || tab.url.len() > 8192 || tab.title.len() > 512 || !capture_readiness(&tab.capture_readiness) { return Err(WorkspaceError::Protocol); } }
    }
    Ok(())
}

fn validate_frame(frame: &FrameHeader, payload_len: usize) -> Result<(), WorkspaceError> {
    let pixels = u64::from(frame.image_pixel_width) * u64::from(frame.image_pixel_height);
    if frame.byte_length != payload_len || payload_len == 0 || !opaque_id(&frame.selection_id) || !opaque_id(&frame.subscription_id) || !opaque_id(&frame.browserd_runtime_instance_id) || !id(&frame.browser_session_id) || !id(&frame.tab_id) || frame.control_epoch == 0 || !matches!(frame.media_type.as_str(), "image/png" | "image/jpeg") || frame.sha256.len() != 64 || !frame.sha256.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) || frame.image_pixel_width == 0 || frame.image_pixel_height == 0 || frame.image_pixel_width > 32_768 || frame.image_pixel_height > 32_768 || pixels > MAX_FRAME_PIXELS || !finite_in(frame.css_viewport_width, 0.0, 32_768.0) || !finite_in(frame.css_viewport_height, 0.0, 32_768.0) || !finite_in(frame.device_pixel_ratio, 0.0, 16.0) { return Err(WorkspaceError::Protocol); }
    Ok(())
}

pub fn bind_header(request_id: &str, binding_secret: &str) -> Value { serde_json::json!({ "protocolVersion": PROTOCOL_VERSION, "kind": "bind", "requestId": request_id, "bindingSecret": binding_secret }) }
pub fn command_header(request_id: &str, kind: &str, fields: BTreeMap<&str, Value>) -> Value { let mut value = serde_json::json!({ "protocolVersion": PROTOCOL_VERSION, "kind": kind, "requestId": request_id }); if let Some(object) = value.as_object_mut() { for (key, field) in fields { object.insert(key.to_owned(), field); } } value }
pub fn control_acquire_header(request_id: &str, browser_session_id: &str, tab_id: &str, expected_control_epoch: u64, frame: &PaintedFrameBinding) -> Value { serde_json::json!({ "protocolVersion": PROTOCOL_VERSION, "kind": "control.acquire", "requestId": request_id, "browserSessionId": browser_session_id, "tabId": tab_id, "expectedControlEpoch": expected_control_epoch, "frame": frame }) }
pub fn control_heartbeat_header(request_id: &str, browser_session_id: &str, control_epoch: u64) -> Value { serde_json::json!({ "protocolVersion": PROTOCOL_VERSION, "kind": "control.heartbeat", "requestId": request_id, "browserSessionId": browser_session_id, "controlEpoch": control_epoch }) }
pub fn control_release_header(request_id: &str, browser_session_id: &str, control_epoch: u64) -> Value { serde_json::json!({ "protocolVersion": PROTOCOL_VERSION, "kind": "control.release", "requestId": request_id, "browserSessionId": browser_session_id, "controlEpoch": control_epoch }) }
pub fn input_batch_header(request_id: &str, browser_session_id: &str, tab_id: &str, control_epoch: u64, input_batch_sequence: u64, input_target_generation: u64, frame: &PaintedFrameBinding, events: &[HumanInputEvent]) -> Result<Value, WorkspaceError> {
    validate_input_events(events)?;
    let value = serde_json::json!({ "protocolVersion": PROTOCOL_VERSION, "kind": "input.batch", "requestId": request_id, "browserSessionId": browser_session_id, "tabId": tab_id, "controlEpoch": control_epoch, "inputBatchSequence": input_batch_sequence, "inputTargetGeneration": input_target_generation, "frame": frame, "events": events });
    if serde_json::to_vec(&value)?.len() > 64 * 1024 { return Err(WorkspaceError::Protocol); }
    Ok(value)
}

pub fn encode_record(header: &Value) -> Result<Vec<u8>, WorkspaceError> {
    let header = serde_json::to_vec(header)?;
    if header.len() < 2 || header.len() > MAX_HEADER_BYTES { return Err(WorkspaceError::Protocol); }
    let mut record = Vec::with_capacity(8 + header.len());
    record.extend_from_slice(&(header.len() as u32).to_be_bytes()); record.extend_from_slice(&0_u32.to_be_bytes()); record.extend_from_slice(&header); Ok(record)
}

pub fn valid_id(value: &str) -> bool { id(value) }
fn validate_control_status(item: &ControlStatusResult) -> Result<(), WorkspaceError> {
    if item.kind != "controlStatus" || !id(&item.browser_session_id) || !control_state(&item.control_state) || item.control_epoch == 0 || !control_transfer(&item.control_transfer) || !capture_readiness(&item.capture_readiness) || !lease_expiry(&item.lease_expiry) || item.selected_human_control_tab_id.as_deref().is_some_and(|value| !id(value)) { return Err(WorkspaceError::Protocol); }
    Ok(())
}
fn validate_control_acquired(item: &ControlAcquiredResult) -> Result<(), WorkspaceError> {
    if item.kind != "controlAcquired" || !id(&item.browser_session_id) || !id(&item.selected_human_control_tab_id) || item.control_state != "human" || item.control_epoch == 0 || item.control_transfer != "none" || item.capture_readiness != "ready" || item.lease_expiry != "healthy" || item.lease_expires_in_ms > 60_000 || item.input_target_generation == 0 { return Err(WorkspaceError::Protocol); }
    Ok(())
}
fn validate_control_heartbeat(item: &ControlHeartbeatResult) -> Result<(), WorkspaceError> {
    if item.kind != "controlHeartbeat" || !id(&item.browser_session_id) || !id(&item.selected_human_control_tab_id) || item.control_state != "human" || item.control_epoch == 0 || !matches!(item.lease_expiry.as_str(), "healthy" | "expiring") || item.lease_expires_in_ms > 60_000 { return Err(WorkspaceError::Protocol); }
    Ok(())
}
fn validate_control_released(item: &ControlReleasedResult) -> Result<(), WorkspaceError> {
    if item.kind != "controlReleased" || !id(&item.browser_session_id) || item.control_state != "agent" || item.control_epoch == 0 || item.control_transfer != "none" || item.lease_expiry != "none" { return Err(WorkspaceError::Protocol); }
    Ok(())
}
fn validate_input_events(events: &[HumanInputEvent]) -> Result<(), WorkspaceError> {
    if events.is_empty() || events.len() > 32 { return Err(WorkspaceError::Protocol); }
    let mut text_bytes = 0_usize;
    for event in events {
        match event {
            HumanInputEvent::PointerMove { point } => validate_point(point)?,
            HumanInputEvent::PointerDown { point, click_count, .. } | HumanInputEvent::PointerUp { point, click_count, .. } => { validate_point(point)?; if click_count.is_some_and(|count| !(1..=2).contains(&count)) { return Err(WorkspaceError::Protocol); } }
            HumanInputEvent::Wheel { point, delta_x, delta_y } => { validate_point(point)?; if !finite_inclusive(*delta_x, -100_000.0, 100_000.0) || !finite_inclusive(*delta_y, -100_000.0, 100_000.0) { return Err(WorkspaceError::Protocol); } }
            HumanInputEvent::KeyDown { key, code, .. } | HumanInputEvent::KeyUp { key, code } => { if !bounded_input_string(key, 64) || code.as_deref().is_some_and(|value| !bounded_input_string(value, 64)) { return Err(WorkspaceError::Protocol); } }
            HumanInputEvent::Text { text } => { if text.is_empty() { return Err(WorkspaceError::Protocol); } text_bytes = text_bytes.saturating_add(text.as_bytes().len()); }
        }
    }
    if text_bytes > 4 * 1024 { return Err(WorkspaceError::Protocol); }
    Ok(())
}
fn validate_point(point: &HumanPoint) -> Result<(), WorkspaceError> { if !finite_inclusive(point.image_x, 0.0, 32_768.0) || !finite_inclusive(point.image_y, 0.0, 32_768.0) { Err(WorkspaceError::Protocol) } else { Ok(()) } }
fn bounded_input_string(value: &str, max: usize) -> bool { !value.is_empty() && value.chars().count() <= max }
fn finite_in(value: f64, minimum_exclusive: f64, maximum: f64) -> bool { value.is_finite() && value > minimum_exclusive && value <= maximum }
fn finite_inclusive(value: f64, minimum: f64, maximum: f64) -> bool { value.is_finite() && value >= minimum && value <= maximum }
fn control_state(value: &str) -> bool { matches!(value, "agent" | "takeover-pending" | "human" | "human-disconnected" | "return-pending") }
fn control_transfer(value: &str) -> bool { matches!(value, "none" | "taking-control" | "returning-control") }
fn lease_expiry(value: &str) -> bool { matches!(value, "none" | "healthy" | "expiring" | "grace") }
fn validate_common(version: &str, kind: &str) -> Result<(), WorkspaceError> { if version != PROTOCOL_VERSION || kind.is_empty() { Err(WorkspaceError::Protocol) } else { Ok(()) } }
fn require_no_payload(payload_len: usize) -> Result<(), WorkspaceError> { if payload_len == 0 { Ok(()) } else { Err(WorkspaceError::Protocol) } }
fn string(object: &serde_json::Map<String, Value>, key: &str) -> Result<String, WorkspaceError> { object.get(key).and_then(Value::as_str).map(str::to_owned).ok_or(WorkspaceError::Protocol) }
fn exact_keys(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Result<(), WorkspaceError> { if object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)) { Ok(()) } else { Err(WorkspaceError::Protocol) } }
fn id(value: &str) -> bool { let mut bytes = value.bytes(); bytes.next().is_some_and(|first| first.is_ascii_alphabetic()) && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')) }
fn opaque_id(value: &str) -> bool { (16..=128).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) }
fn capture_readiness(value: &str) -> bool { matches!(value, "starting" | "warming" | "ready" | "degraded" | "unavailable") }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_typed_human_input_records() {
        let frame = PaintedFrameBinding { selection_id: "selection_123456".into(), browserd_runtime_instance_id: "runtime_123456789".into(), browser_session_id: "session:one".into(), tab_id: "tab:one".into(), subscription_id: "subscription_1234".into(), control_epoch: 2, frame_sequence: 2, document_generation: 1, viewport_generation: 1, image_pixel_width: 800, image_pixel_height: 600, css_viewport_width: 800.0, css_viewport_height: 600.0, device_pixel_ratio: 1.0, painted_at: "2026-08-30T00:00:00.000Z".into() };
        let moves = (0..32).map(|index| HumanInputEvent::PointerMove { point: HumanPoint { image_x: index as f64, image_y: index as f64 } }).collect::<Vec<_>>();
        let value = input_batch_header("request:input", "session:one", "tab:one", 2, 1, 1, &frame, &moves).unwrap();
        assert!(encode_record(&value).unwrap().len() < 64 * 1024);
        let too_many = (0..33).map(|index| HumanInputEvent::PointerMove { point: HumanPoint { image_x: index as f64, image_y: index as f64 } }).collect::<Vec<_>>();
        assert!(input_batch_header("request:input", "session:one", "tab:one", 2, 1, 1, &frame, &too_many).is_err());
        assert!(input_batch_header("request:input", "session:one", "tab:one", 2, 1, 1, &frame, &[HumanInputEvent::Text { text: "x".repeat(4 * 1024 + 1) }]).is_err());
    }

    #[test]
    fn rejects_extra_fields_and_payload_mismatches() {
        let extra = br#"{\"protocolVersion\":\"workspace.v2\",\"kind\":\"status\",\"status\":{\"connection\":\"ready\",\"browserd\":\"ready\"},\"extra\":true}"#;
        assert!(parse_server_record(extra, 0).is_err());
        let frame = serde_json::json!({"protocolVersion":"workspace.v2","kind":"frame","selectionId":"selection_123456","subscriptionId":"subscription_1234","browserdRuntimeInstanceId":"runtime_123456789","browserSessionId":"session:one","tabId":"tab:one","controlEpoch":1,"frameSequence":1,"documentGeneration":1,"viewportGeneration":1,"capturedAt":"2026-08-30T00:00:00.000Z","publishedAt":"2026-08-30T00:00:00.000Z","mediaType":"image/png","byteLength":3,"sha256":"a".repeat(64),"imagePixelWidth":1,"imagePixelHeight":1,"cssViewportWidth":1,"cssViewportHeight":1,"devicePixelRatio":1});
        assert!(matches!(parse_server_record(&serde_json::to_vec(&frame).unwrap(), 3), Ok(ServerRecord::Frame(_))));
        assert!(parse_server_record(&serde_json::to_vec(&frame).unwrap(), 2).is_err());
        let oversized = serde_json::json!({"protocolVersion":"workspace.v2","kind":"frame","selectionId":"selection_123456","subscriptionId":"subscription_1234","browserdRuntimeInstanceId":"runtime_123456789","browserSessionId":"session:one","tabId":"tab:one","controlEpoch":1,"frameSequence":1,"documentGeneration":1,"viewportGeneration":1,"capturedAt":"2026-08-30T00:00:00.000Z","publishedAt":"2026-08-30T00:00:00.000Z","mediaType":"image/png","byteLength":3,"sha256":"a".repeat(64),"imagePixelWidth":32768,"imagePixelHeight":32768,"cssViewportWidth":32768,"cssViewportHeight":32768,"devicePixelRatio":1});
        assert!(parse_server_record(&serde_json::to_vec(&oversized).unwrap(), 3).is_err());
    }
}
