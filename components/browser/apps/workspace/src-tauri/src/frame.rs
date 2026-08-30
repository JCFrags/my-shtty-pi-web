use crate::{error::WorkspaceError, protocol::FrameHeader};
use serde::Serialize;
use chrono::{SecondsFormat, Utc};
use sha2::{Digest, Sha256};

const MAX_FRAME_METADATA_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDeliveryMetadata {
    pub delivery_id: u64,
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
    pub received_at: String,
    pub media_type: String,
    pub byte_length: usize,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
}

pub fn encode_frame_delivery(delivery_id: u64, header: &FrameHeader, payload: &[u8]) -> Result<Vec<u8>, WorkspaceError> {
    if payload.len() != header.byte_length || Sha256::digest(payload).as_slice() != hex_digest(&header.sha256)?.as_slice() { return Err(WorkspaceError::Protocol); }
    let metadata = FrameDeliveryMetadata {
        delivery_id,
        selection_id: header.selection_id.clone(),
        subscription_id: header.subscription_id.clone(),
        browserd_runtime_instance_id: header.browserd_runtime_instance_id.clone(),
        browser_session_id: header.browser_session_id.clone(),
        tab_id: header.tab_id.clone(),
        frame_sequence: header.frame_sequence,
        document_generation: header.document_generation,
        viewport_generation: header.viewport_generation,
        captured_at: header.captured_at.clone(),
        published_at: header.published_at.clone(),
        received_at: now_iso_like(),
        media_type: header.media_type.clone(),
        byte_length: payload.len(),
        sha256: header.sha256.clone(),
        width: header.width,
        height: header.height,
    };
    let metadata = serde_json::to_vec(&metadata)?;
    if metadata.len() > MAX_FRAME_METADATA_BYTES { return Err(WorkspaceError::Protocol); }
    let mut output = Vec::with_capacity(4 + metadata.len() + payload.len());
    output.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    output.extend_from_slice(&metadata);
    output.extend_from_slice(payload);
    Ok(output)
}

fn hex_digest(value: &str) -> Result<Vec<u8>, WorkspaceError> {
    if value.len() != 64 { return Err(WorkspaceError::Protocol); }
    (0..value.len()).step_by(2).map(|index| u8::from_str_radix(&value[index..index + 2], 16).map_err(|_| WorkspaceError::Protocol)).collect()
}

fn now_iso_like() -> String { Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encodes_metadata_prefix_and_exact_raw_bytes() {
        let payload = vec![7_u8; 1024 * 1024];
        let header = FrameHeader { protocol_version: "workspace.v1".into(), kind: "frame".into(), selection_id: "selection_123456".into(), subscription_id: "subscription_1234".into(), browserd_runtime_instance_id: "runtime_123456789".into(), browser_session_id: "session:one".into(), tab_id: "tab:one".into(), frame_sequence: 1, document_generation: 1, viewport_generation: 1, captured_at: "2026-08-30T00:00:00.000Z".into(), published_at: "2026-08-30T00:00:00.000Z".into(), media_type: "image/png".into(), byte_length: payload.len(), sha256: format!("{:x}", Sha256::digest(&payload)), width: 800, height: 600 };
        let encoded = encode_frame_delivery(9, &header, &payload).unwrap();
        let metadata_len = u32::from_be_bytes(encoded[..4].try_into().unwrap()) as usize;
        let metadata: serde_json::Value = serde_json::from_slice(&encoded[4..4 + metadata_len]).unwrap();
        assert_eq!(metadata["deliveryId"], 9);
        assert_eq!(&encoded[4 + metadata_len..], payload);
        assert!(!String::from_utf8_lossy(&encoded[..4 + metadata_len]).contains("base64"));
    }
}
