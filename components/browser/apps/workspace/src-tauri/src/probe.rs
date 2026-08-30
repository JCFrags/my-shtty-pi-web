use crate::error::{PublicError, WorkspaceError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::ipc::{Channel, Response};

const PROBE_PAYLOAD_BYTES: usize = 1024 * 1024;
const PROBE_RECORDS: u32 = 100;

struct ActiveProbe {
    channel: Channel<Response>,
    awaiting_sequence: Option<u32>,
    awaiting_sha256: Option<String>,
    next_sequence: u32,
}

#[derive(Default)]
pub struct BinaryProbeService(Mutex<Option<ActiveProbe>>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeStatus {
    pub total: u32,
    pub sent: u32,
    pub complete: bool,
    pub awaiting_sequence: Option<u32>,
    pub awaiting_sha256: Option<String>,
    pub payload_bytes: usize,
    pub frontend_type: &'static str,
    pub maximum_inflight: u8,
}

impl BinaryProbeService {
    pub fn open(&self, channel: Channel<Response>) -> Result<ProbeStatus, PublicError> {
        if !cfg!(debug_assertions) { return Err(WorkspaceError::Unavailable.public()); }
        let mut guard = self.0.lock().expect("binary probe lock");
        *guard = Some(ActiveProbe { channel, awaiting_sequence: None, awaiting_sha256: None, next_sequence: 0 });
        let active = guard.as_mut().expect("binary probe active");
        send_next(active)?;
        Ok(status(active))
    }

    pub fn acknowledge(&self, sequence: u32, sha256: String) -> Result<ProbeStatus, PublicError> {
        if !cfg!(debug_assertions) { return Err(WorkspaceError::Unavailable.public()); }
        let mut guard = self.0.lock().expect("binary probe lock");
        let active = guard.as_mut().ok_or_else(|| WorkspaceError::Closed.public())?;
        if active.awaiting_sequence != Some(sequence) || active.awaiting_sha256.as_deref() != Some(&sha256) { return Err(WorkspaceError::Protocol.public()); }
        active.awaiting_sequence = None; active.awaiting_sha256 = None;
        send_next(active)?;
        Ok(status(active))
    }
}

fn send_next(active: &mut ActiveProbe) -> Result<(), PublicError> {
    if active.next_sequence >= PROBE_RECORDS { return Ok(()); }
    let sequence = active.next_sequence;
    let payload = probe_payload(sequence);
    let digest = format!("{:x}", Sha256::digest(&payload));
    let mut record = Vec::with_capacity(4 + payload.len());
    record.extend_from_slice(&sequence.to_be_bytes()); record.extend_from_slice(&payload);
    active.channel.send(Response::new(record)).map_err(|_| WorkspaceError::Closed.public())?;
    active.awaiting_sequence = Some(sequence); active.awaiting_sha256 = Some(digest); active.next_sequence += 1;
    Ok(())
}

fn status(active: &ActiveProbe) -> ProbeStatus {
    ProbeStatus { total: PROBE_RECORDS, sent: active.next_sequence, complete: active.next_sequence == PROBE_RECORDS && active.awaiting_sequence.is_none(), awaiting_sequence: active.awaiting_sequence, awaiting_sha256: active.awaiting_sha256.clone(), payload_bytes: PROBE_PAYLOAD_BYTES, frontend_type: "ArrayBuffer", maximum_inflight: 1 }
}

fn probe_payload(sequence: u32) -> Vec<u8> {
    let mut output = vec![0_u8; PROBE_PAYLOAD_BYTES];
    let seed = sequence.wrapping_mul(0x9e37_79b9).wrapping_add(0x7f4a_7c15);
    for (index, byte) in output.iter_mut().enumerate() { *byte = seed.wrapping_add((index as u32).wrapping_mul(31)).rotate_left((index & 7) as u32) as u8; }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn produces_one_hundred_unique_one_megabyte_payload_digests() {
        let mut digests = std::collections::BTreeSet::new();
        for sequence in 0..PROBE_RECORDS { let payload = probe_payload(sequence); assert_eq!(payload.len(), PROBE_PAYLOAD_BYTES); digests.insert(format!("{:x}", Sha256::digest(payload))); }
        assert_eq!(digests.len(), PROBE_RECORDS as usize);
    }
}
