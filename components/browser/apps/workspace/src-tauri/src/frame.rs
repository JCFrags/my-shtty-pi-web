use crate::{error::WorkspaceError, protocol::{FrameHeader, PaintedFrameBinding}};
use serde::Serialize;
use chrono::{SecondsFormat, Utc};
use sha2::{Digest, Sha256};

const MAX_FRAME_METADATA_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDeliveryMetadata {
    pub delivery_id: u64,
    pub captured_at: String,
    pub published_at: String,
    pub received_at: String,
    pub media_type: String,
    pub byte_length: usize,
    pub sha256: String,
    pub image_pixel_width: u32,
    pub image_pixel_height: u32,
}

pub fn admit_frame_sequence(last_sequence: u64, header: &FrameHeader, payload: &[u8]) -> Result<Option<u64>, WorkspaceError> {
    if header.frame_sequence <= last_sequence { return Ok(None); }
    validate_frame_payload(header, payload)?;
    Ok(Some(header.frame_sequence))
}

pub fn encode_frame_delivery(delivery_id: u64, header: &FrameHeader, payload: &[u8]) -> Result<Vec<u8>, WorkspaceError> {
    validate_frame_payload(header, payload)?;
    let metadata = FrameDeliveryMetadata {
        delivery_id,
        captured_at: header.captured_at.clone(),
        published_at: header.published_at.clone(),
        received_at: now_iso_like(),
        media_type: header.media_type.clone(),
        byte_length: payload.len(),
        sha256: header.sha256.clone(),
        image_pixel_width: header.image_pixel_width,
        image_pixel_height: header.image_pixel_height,
    };
    let metadata = serde_json::to_vec(&metadata)?;
    if metadata.len() > MAX_FRAME_METADATA_BYTES { return Err(WorkspaceError::Protocol); }
    let mut output = Vec::with_capacity(4 + metadata.len() + payload.len());
    output.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    output.extend_from_slice(&metadata);
    output.extend_from_slice(payload);
    Ok(output)
}

pub fn painted_binding(header: &FrameHeader, painted_at: String) -> PaintedFrameBinding {
    PaintedFrameBinding {
        selection_id: header.selection_id.clone(), browserd_runtime_instance_id: header.browserd_runtime_instance_id.clone(),
        browser_session_id: header.browser_session_id.clone(), tab_id: header.tab_id.clone(), subscription_id: header.subscription_id.clone(),
        control_epoch: header.control_epoch, frame_sequence: header.frame_sequence, document_generation: header.document_generation,
        viewport_generation: header.viewport_generation, image_pixel_width: header.image_pixel_width, image_pixel_height: header.image_pixel_height,
        css_viewport_width: header.css_viewport_width, css_viewport_height: header.css_viewport_height,
        device_pixel_ratio: header.device_pixel_ratio, painted_at,
    }
}

fn validate_frame_payload(header: &FrameHeader, payload: &[u8]) -> Result<(), WorkspaceError> {
    if payload.len() != header.byte_length || Sha256::digest(payload).as_slice() != hex_digest(&header.sha256)?.as_slice() { return Err(WorkspaceError::Protocol); }
    Ok(())
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
        let header = FrameHeader { protocol_version: "workspace.v2".into(), kind: "frame".into(), selection_id: "selection_123456".into(), subscription_id: "subscription_1234".into(), browserd_runtime_instance_id: "runtime_123456789".into(), browser_session_id: "session:one".into(), tab_id: "tab:one".into(), control_epoch: 1, frame_sequence: 1, document_generation: 1, viewport_generation: 1, captured_at: "2026-08-30T00:00:00.000Z".into(), published_at: "2026-08-30T00:00:00.000Z".into(), media_type: "image/png".into(), byte_length: payload.len(), sha256: format!("{:x}", Sha256::digest(&payload)), image_pixel_width: 800, image_pixel_height: 600, css_viewport_width: 800.0, css_viewport_height: 600.0, device_pixel_ratio: 1.0 };
        let encoded = encode_frame_delivery(9, &header, &payload).unwrap();
        let metadata_len = u32::from_be_bytes(encoded[..4].try_into().unwrap()) as usize;
        let metadata: serde_json::Value = serde_json::from_slice(&encoded[4..4 + metadata_len]).unwrap();
        assert_eq!(metadata["deliveryId"], 9);
        assert_eq!(metadata["imagePixelWidth"], 800);
        assert!(metadata.get("controlEpoch").is_none());
        assert!(metadata.get("subscriptionId").is_none());
        assert_eq!(&encoded[4 + metadata_len..], payload);
        assert!(!String::from_utf8_lossy(&encoded[..4 + metadata_len]).contains("base64"));

        let mut last_sequence = 0;
        let corrupt = vec![8_u8; payload.len()];
        assert!(admit_frame_sequence(last_sequence, &header, &corrupt).is_err());
        assert_eq!(last_sequence, 0, "digest rejection must not advance the watermark");
        last_sequence = admit_frame_sequence(last_sequence, &header, &payload).unwrap().unwrap();
        assert_eq!(last_sequence, header.frame_sequence);
        assert_eq!(admit_frame_sequence(last_sequence, &header, &payload).unwrap(), None);
    }
}
