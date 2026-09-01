use crate::protocol::{FrameHeader, WorkspaceSnapshot};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs::File,
    io::{BufWriter, Write},
    path::Path,
    sync::{Arc, Mutex},
};
#[cfg(debug_assertions)]
use std::{fs::OpenOptions, path::PathBuf};

const MAX_DIAGNOSTIC_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_RECORDS: u64 = 100_000;
const MAX_METRIC_MS: f64 = 86_400_000.0;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameDisposition {
    pub outcome: FrameOutcome,
    pub frontend_type: FrontendBinaryType,
    pub reason: Option<FrameDropReason>,
    pub decode_ms: Option<f64>,
    pub paint_ms: Option<f64>,
    pub total_ms: Option<f64>,
    pub decoded_at: Option<String>,
    pub painted_at: Option<String>,
    pub decoded_width: Option<u32>,
    pub decoded_height: Option<u32>,
    pub frontend_retained_frames: u8,
    pub frontend_image_bitmaps: u8,
    pub maximum_frontend_image_bitmaps: u8,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FrameOutcome { Painted, Dropped }

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub enum FrontendBinaryType { ArrayBuffer, Uint8Array }

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FrameDropReason {
    Malformed,
    Selection,
    SelectionChanged,
    Digest,
    Decode,
    DecodedDimensions,
    MissingCanvas,
}

impl FrameDisposition {
    pub fn validate(&self) -> bool {
        let metrics = [self.decode_ms, self.paint_ms, self.total_ms];
        if metrics.into_iter().flatten().any(|value| !value.is_finite() || !(0.0..=MAX_METRIC_MS).contains(&value)) { return false; }
        if [self.decoded_at.as_deref(), self.painted_at.as_deref()].into_iter().flatten().any(|value| value.len() > 64) { return false; }
        if self.frontend_retained_frames > 1 || self.frontend_image_bitmaps != 0 || self.maximum_frontend_image_bitmaps > 1 { return false; }
        match self.outcome {
            FrameOutcome::Painted => self.reason.is_none() && metrics.into_iter().all(|value| value.is_some()) && self.decoded_at.is_some() && self.painted_at.is_some() && self.decoded_width.is_some_and(|value| value > 0) && self.decoded_height.is_some_and(|value| value > 0) && self.frontend_retained_frames == 1,
            FrameOutcome::Dropped => self.reason.is_some() && metrics.into_iter().all(|value| value.is_none()) && self.decoded_at.is_none() && self.painted_at.is_none() && self.decoded_width.is_none() && self.decoded_height.is_none(),
        }
    }
}

#[derive(Clone, Default)]
pub struct AcceptanceDiagnostics(Arc<Mutex<Option<AcceptanceWriter>>>);

struct AcceptanceWriter {
    writer: BufWriter<File>,
    bytes: u64,
    records: u64,
}

impl AcceptanceDiagnostics {
    #[cfg(debug_assertions)]
    pub fn configure(&self, path: &Path) -> Result<(), String> {
        let validated = validate_output_path(path)?;
        let file = OpenOptions::new().create_new(true).write(true).open(&validated).map_err(|error| format!("create acceptance diagnostics: {error}"))?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|error| format!("secure acceptance diagnostics: {error}"))?;
        }
        *self.0.lock().map_err(|_| "acceptance diagnostics lock failed".to_owned())? = Some(AcceptanceWriter { writer: BufWriter::new(file), bytes: 0, records: 0 });
        self.record(json!({ "kind": "acceptanceStarted" }));
        Ok(())
    }

    #[cfg(not(debug_assertions))]
    pub fn configure(&self, _path: &Path) -> Result<(), String> { Err("acceptance diagnostics require a development build".into()) }

    pub fn enabled(&self) -> bool { self.0.lock().is_ok_and(|guard| guard.is_some()) }
    pub fn frontend_ready(&self) { self.record(json!({ "kind": "frontendReady" })); }
    pub fn milestone(&self, name: &'static str) { self.record(json!({ "kind": "milestone", "name": name })); }

    pub fn connection(&self, connection: &str) {
        self.record(json!({ "kind": "connection", "connection": bounded_text(connection, 32) }));
    }

    pub fn snapshot(&self, snapshot: &WorkspaceSnapshot) {
        let sessions = snapshot.sessions.iter().take(64).map(|session| json!({
            "browserSessionId": bounded_text(&session.browser_session_id, 128),
            "actorDisplayId": bounded_text(&session.actor_display_id, 128),
            "agentLabel": bounded_text(&session.agent_label, 256),
            "state": bounded_text(&session.state, 32),
            "controlState": bounded_text(&session.control_state, 32),
            "controlEpoch": session.control_epoch,
            "captureReadiness": bounded_text(&session.capture_readiness, 32),
            "resource": session.resource.as_ref().map(|resource| json!({
                "state": bounded_text(&resource.state, 32),
                "reason": bounded_text(&resource.reason, 32),
            })),
            "cursor": {
                "x": session.cursor.x,
                "y": session.cursor.y,
                "visible": session.cursor.visible,
                "pathSequence": session.cursor.path_sequence,
                "sampleSequence": session.cursor.sample_sequence,
            },
            "tabs": session.tabs.iter().take(64).map(|tab| json!({
                "tabId": bounded_text(&tab.tab_id, 128),
                "state": bounded_text(&tab.state, 32),
                "captureReadiness": bounded_text(&tab.capture_readiness, 32),
                "documentGeneration": tab.document_generation,
                "viewportGeneration": tab.viewport_generation,
                "frameSequence": tab.frame_sequence,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>();
        self.record(json!({
            "kind": "snapshot",
            "workspaceRevision": snapshot.workspace_revision,
            "browserdRuntimeInstanceId": snapshot.browserd_runtime_instance_id.as_deref().map(|value| bounded_text(value, 128)),
            "browserdState": bounded_text(&snapshot.browserd_state, 32),
            "sessions": sessions,
        }));
    }

    pub fn selection_requested(&self, browser_session_id: &str, tab_id: &str) {
        self.record(json!({
            "kind": "selectionRequested",
            "browserSessionId": bounded_text(browser_session_id, 128),
            "tabId": bounded_text(tab_id, 128),
        }));
    }

    pub fn selection(&self, selection_id: &str, browser_session_id: &str, tab_id: &str) {
        self.record(json!({
            "kind": "selection",
            "selectionId": bounded_text(selection_id, 128),
            "browserSessionId": bounded_text(browser_session_id, 128),
            "tabId": bounded_text(tab_id, 128),
        }));
    }

    pub fn selection_cleared(&self) { self.record(json!({ "kind": "selectionCleared" })); }

    pub fn window_action(&self, action: &str) { self.record(json!({ "kind": "windowAction", "action": bounded_text(action, 16) })); }

    pub fn launcher_error(&self, code: &str, retryable: bool) {
        self.record(json!({ "kind": "launcherError", "code": bounded_text(code, 32), "retryable": retryable }));
    }

    pub fn frame_received(&self, delivery_id: u64, header: &FrameHeader) {
        self.record(frame_record("frameReceived", delivery_id, header, None));
    }

    pub fn frame_settled(&self, delivery_id: u64, header: &FrameHeader, disposition: &FrameDisposition, rust_retained_frames: u8) {
        let mut record = frame_record("frameSettled", delivery_id, header, Some(disposition));
        if let Some(object) = record.as_object_mut() { object.insert("rustRetainedFrames".to_owned(), json!(rust_retained_frames.min(2))); }
        self.record(record);
    }

    fn record(&self, mut value: serde_json::Value) {
        let Ok(mut guard) = self.0.lock() else { return; };
        let Some(output) = guard.as_mut() else { return; };
        if output.records >= MAX_DIAGNOSTIC_RECORDS || output.bytes >= MAX_DIAGNOSTIC_BYTES { return; }
        if let Some(object) = value.as_object_mut() { object.insert("recordedAt".to_owned(), json!(Utc::now().to_rfc3339())); }
        let Ok(mut encoded) = serde_json::to_vec(&value) else { return; };
        encoded.push(b'\n');
        if encoded.len() > 32 * 1024 || output.bytes.saturating_add(encoded.len() as u64) > MAX_DIAGNOSTIC_BYTES { return; }
        if output.writer.write_all(&encoded).is_ok() && output.writer.flush().is_ok() {
            output.bytes += encoded.len() as u64;
            output.records += 1;
        }
    }
}

fn frame_record(kind: &str, delivery_id: u64, header: &FrameHeader, disposition: Option<&FrameDisposition>) -> serde_json::Value {
    json!({
        "kind": kind,
        "deliveryId": delivery_id,
        "selectionId": bounded_text(&header.selection_id, 128),
        "subscriptionId": bounded_text(&header.subscription_id, 128),
        "browserdRuntimeInstanceId": bounded_text(&header.browserd_runtime_instance_id, 128),
        "browserSessionId": bounded_text(&header.browser_session_id, 128),
        "tabId": bounded_text(&header.tab_id, 128),
        "controlEpoch": header.control_epoch,
        "frameSequence": header.frame_sequence,
        "documentGeneration": header.document_generation,
        "viewportGeneration": header.viewport_generation,
        "capturedAt": bounded_text(&header.captured_at, 64),
        "publishedAt": bounded_text(&header.published_at, 64),
        "sha256": bounded_text(&header.sha256, 64),
        "width": header.image_pixel_width,
        "height": header.image_pixel_height,
        "byteLength": header.byte_length,
        "outcome": disposition.map(|item| match item.outcome { FrameOutcome::Painted => "painted", FrameOutcome::Dropped => "dropped" }),
        "frontendType": disposition.map(|item| item.frontend_type),
        "reason": disposition.and_then(|item| item.reason),
        "decodeMs": disposition.and_then(|item| item.decode_ms),
        "paintMs": disposition.and_then(|item| item.paint_ms),
        "totalMs": disposition.and_then(|item| item.total_ms),
        "decodedAt": disposition.and_then(|item| item.decoded_at.as_deref()),
        "paintedAt": disposition.and_then(|item| item.painted_at.as_deref()),
        "decodedWidth": disposition.and_then(|item| item.decoded_width),
        "decodedHeight": disposition.and_then(|item| item.decoded_height),
        "frontendRetainedFrames": disposition.map(|item| item.frontend_retained_frames),
        "frontendImageBitmaps": disposition.map(|item| item.frontend_image_bitmaps),
        "maximumFrontendImageBitmaps": disposition.map(|item| item.maximum_frontend_image_bitmaps),
    })
}

#[cfg(debug_assertions)]
fn validate_output_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.file_name().is_none() { return Err("acceptance output must be an absolute file path".into()); }
    if path.as_os_str().len() > 1024 || path.exists() { return Err("acceptance output path is invalid or already exists".into()); }
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").ok_or_else(|| "XDG_RUNTIME_DIR is required for acceptance output".to_owned())?;
    let runtime = std::fs::canonicalize(runtime).map_err(|error| format!("validate acceptance runtime directory: {error}"))?;
    let parent = path.parent().ok_or_else(|| "acceptance output parent is missing".to_owned())?;
    let parent = std::fs::canonicalize(parent).map_err(|error| format!("validate acceptance output parent: {error}"))?;
    if !parent.starts_with(&runtime) { return Err("acceptance output must be below XDG_RUNTIME_DIR".into()); }
    Ok(parent.join(path.file_name().expect("validated file name")))
}

fn bounded_text(value: &str, maximum: usize) -> &str { value.get(..value.len().min(maximum)).unwrap_or("") }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_bounded_frame_dispositions() {
        let retained = (1, 0, 1);
        assert!(FrameDisposition { outcome: FrameOutcome::Painted, frontend_type: FrontendBinaryType::ArrayBuffer, reason: None, decode_ms: Some(1.0), paint_ms: Some(0.5), total_ms: Some(4.0), decoded_at: Some("2026-08-30T00:00:00Z".into()), painted_at: Some("2026-08-30T00:00:00Z".into()), decoded_width: Some(800), decoded_height: Some(600), frontend_retained_frames: retained.0, frontend_image_bitmaps: retained.1, maximum_frontend_image_bitmaps: retained.2 }.validate());
        assert!(FrameDisposition { outcome: FrameOutcome::Dropped, frontend_type: FrontendBinaryType::Uint8Array, reason: Some(FrameDropReason::Digest), decode_ms: None, paint_ms: None, total_ms: None, decoded_at: None, painted_at: None, decoded_width: None, decoded_height: None, frontend_retained_frames: 0, frontend_image_bitmaps: 0, maximum_frontend_image_bitmaps: 0 }.validate());
        assert!(!FrameDisposition { outcome: FrameOutcome::Painted, frontend_type: FrontendBinaryType::ArrayBuffer, reason: Some(FrameDropReason::Digest), decode_ms: None, paint_ms: None, total_ms: None, decoded_at: Some("x".into()), painted_at: Some("x".into()), decoded_width: Some(800), decoded_height: Some(600), frontend_retained_frames: retained.0, frontend_image_bitmaps: retained.1, maximum_frontend_image_bitmaps: retained.2 }.validate());
        assert!(!FrameDisposition { outcome: FrameOutcome::Dropped, frontend_type: FrontendBinaryType::ArrayBuffer, reason: None, decode_ms: Some(f64::NAN), paint_ms: None, total_ms: None, decoded_at: None, painted_at: None, decoded_width: None, decoded_height: None, frontend_retained_frames: 0, frontend_image_bitmaps: 0, maximum_frontend_image_bitmaps: 0 }.validate());
        assert!(!FrameDisposition { outcome: FrameOutcome::Painted, frontend_type: FrontendBinaryType::ArrayBuffer, reason: None, decode_ms: Some(1.0), paint_ms: Some(1.0), total_ms: None, decoded_at: Some("x".into()), painted_at: Some("x".into()), decoded_width: Some(800), decoded_height: Some(600), frontend_retained_frames: retained.0, frontend_image_bitmaps: retained.1, maximum_frontend_image_bitmaps: retained.2 }.validate());
        assert!(!FrameDisposition { outcome: FrameOutcome::Dropped, frontend_type: FrontendBinaryType::ArrayBuffer, reason: Some(FrameDropReason::Decode), decode_ms: Some(1.0), paint_ms: None, total_ms: None, decoded_at: None, painted_at: None, decoded_width: None, decoded_height: None, frontend_retained_frames: 0, frontend_image_bitmaps: 0, maximum_frontend_image_bitmaps: 0 }.validate());
        assert!(!FrameDisposition { outcome: FrameOutcome::Painted, frontend_type: FrontendBinaryType::ArrayBuffer, reason: None, decode_ms: Some(1.0), paint_ms: Some(1.0), total_ms: Some(2.0), decoded_at: Some("x".into()), painted_at: Some("x".into()), decoded_width: Some(800), decoded_height: Some(600), frontend_retained_frames: 2, frontend_image_bitmaps: 0, maximum_frontend_image_bitmaps: 1 }.validate());
    }
}
