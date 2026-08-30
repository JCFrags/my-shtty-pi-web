use crate::error::WorkspaceError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: &str = "workspace.v1";
pub const MAX_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;

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
    pub frame_sequence: u64,
    pub document_generation: u64,
    pub viewport_generation: u64,
    pub captured_at: String,
    pub published_at: String,
    pub media_type: String,
    pub byte_length: usize,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
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
        _ => Err(WorkspaceError::Protocol),
    }
}

fn validate_snapshot(snapshot: &WorkspaceSnapshot) -> Result<(), WorkspaceError> {
    if snapshot.sessions.len() > 256 || !matches!(snapshot.browserd_state.as_str(), "ready" | "unavailable" | "replaced") { return Err(WorkspaceError::Protocol); }
    if snapshot.browserd_runtime_instance_id.as_deref().is_some_and(|value| !opaque_id(value)) { return Err(WorkspaceError::Protocol); }
    for session in &snapshot.sessions {
        if !id(&session.browser_session_id) || !opaque_id(&session.actor_display_id) || session.path_id != "agentcursor/chrome" || session.control_state != "agent" || session.tabs.len() > 16 { return Err(WorkspaceError::Protocol); }
        for tab in &session.tabs { if !id(&tab.tab_id) || tab.url.len() > 8192 || tab.title.len() > 512 { return Err(WorkspaceError::Protocol); } }
    }
    Ok(())
}

fn validate_frame(frame: &FrameHeader, payload_len: usize) -> Result<(), WorkspaceError> {
    if frame.byte_length != payload_len || payload_len == 0 || !opaque_id(&frame.selection_id) || !opaque_id(&frame.subscription_id) || !opaque_id(&frame.browserd_runtime_instance_id) || !id(&frame.browser_session_id) || !id(&frame.tab_id) || !matches!(frame.media_type.as_str(), "image/png" | "image/jpeg") || frame.sha256.len() != 64 || !frame.sha256.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) || frame.width == 0 || frame.height == 0 || frame.width > 32_768 || frame.height > 32_768 { return Err(WorkspaceError::Protocol); }
    Ok(())
}

pub fn bind_header(request_id: &str, binding_secret: &str) -> Value { serde_json::json!({ "protocolVersion": PROTOCOL_VERSION, "kind": "bind", "requestId": request_id, "bindingSecret": binding_secret }) }
pub fn command_header(request_id: &str, kind: &str, fields: BTreeMap<&str, Value>) -> Value { let mut value = serde_json::json!({ "protocolVersion": PROTOCOL_VERSION, "kind": kind, "requestId": request_id }); if let Some(object) = value.as_object_mut() { for (key, field) in fields { object.insert(key.to_owned(), field); } } value }

pub fn encode_record(header: &Value) -> Result<Vec<u8>, WorkspaceError> {
    let header = serde_json::to_vec(header)?;
    if header.len() < 2 || header.len() > MAX_HEADER_BYTES { return Err(WorkspaceError::Protocol); }
    let mut record = Vec::with_capacity(8 + header.len());
    record.extend_from_slice(&(header.len() as u32).to_be_bytes()); record.extend_from_slice(&0_u32.to_be_bytes()); record.extend_from_slice(&header); Ok(record)
}

pub fn valid_id(value: &str) -> bool { id(value) }
fn validate_common(version: &str, kind: &str) -> Result<(), WorkspaceError> { if version != PROTOCOL_VERSION || kind.is_empty() { Err(WorkspaceError::Protocol) } else { Ok(()) } }
fn require_no_payload(payload_len: usize) -> Result<(), WorkspaceError> { if payload_len == 0 { Ok(()) } else { Err(WorkspaceError::Protocol) } }
fn string(object: &serde_json::Map<String, Value>, key: &str) -> Result<String, WorkspaceError> { object.get(key).and_then(Value::as_str).map(str::to_owned).ok_or(WorkspaceError::Protocol) }
fn exact_keys(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Result<(), WorkspaceError> { if object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)) { Ok(()) } else { Err(WorkspaceError::Protocol) } }
fn id(value: &str) -> bool { let mut bytes = value.bytes(); bytes.next().is_some_and(|first| first.is_ascii_alphabetic()) && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')) }
fn opaque_id(value: &str) -> bool { (16..=128).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_extra_fields_and_payload_mismatches() {
        let extra = br#"{\"protocolVersion\":\"workspace.v1\",\"kind\":\"status\",\"status\":{\"connection\":\"ready\",\"browserd\":\"ready\"},\"extra\":true}"#;
        assert!(parse_server_record(extra, 0).is_err());
        let frame = serde_json::json!({"protocolVersion":"workspace.v1","kind":"frame","selectionId":"selection_123456","subscriptionId":"subscription_1234","browserdRuntimeInstanceId":"runtime_123456789","browserSessionId":"session:one","tabId":"tab:one","frameSequence":1,"documentGeneration":1,"viewportGeneration":1,"capturedAt":"2026-08-30T00:00:00.000Z","publishedAt":"2026-08-30T00:00:00.000Z","mediaType":"image/png","byteLength":3,"sha256":"a".repeat(64),"width":1,"height":1});
        assert!(matches!(parse_server_record(&serde_json::to_vec(&frame).unwrap(), 3), Ok(ServerRecord::Frame(_))));
        assert!(parse_server_record(&serde_json::to_vec(&frame).unwrap(), 2).is_err());
    }
}
