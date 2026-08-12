use pi_web_protocol::{HostId, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendTransferHandle {
    pub host_id: HostId,
    pub relative_path: String,
    pub media_type: String,
    pub kind: TransferKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferKind {
    Download,
    Screenshot,
    DebugOutput,
}

pub fn resolve_transfer(root: &Path, expected_host: &HostId, handle: &BackendTransferHandle) -> Result<PathBuf, RpcError> {
    if handle.host_id != *expected_host || handle.relative_path.is_empty() {
        return Err(invalid_transfer());
    }
    let relative = Path::new(&handle.relative_path);
    if relative.is_absolute() || relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err(invalid_transfer());
    }
    let canonical_root = root.canonicalize().map_err(|_| invalid_transfer())?;
    let candidate = canonical_root.join(relative);
    let metadata = std::fs::symlink_metadata(&candidate).map_err(|_| invalid_transfer())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(invalid_transfer());
    }
    let canonical = candidate.canonicalize().map_err(|_| invalid_transfer())?;
    if !canonical.starts_with(&canonical_root) {
        return Err(invalid_transfer());
    }
    Ok(canonical)
}

pub fn parse_transfer(value: serde_json::Value) -> Result<BackendTransferHandle, RpcError> {
    serde_json::from_value(value).map_err(|_| invalid_transfer())
}

fn invalid_transfer() -> RpcError {
    RpcError {
        code: -32043,
        message: "invalid backend transfer handle".into(),
        data: Some(json!({ "reason": "transfer handle refused" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_must_be_regular_descendant_for_expected_host() {
        let root = std::env::temp_dir().join(format!("pi-web-transfer-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("safe.bin"), b"safe").unwrap();
        let host = HostId("host".into());
        let safe = BackendTransferHandle { host_id: host.clone(), relative_path: "safe.bin".into(), media_type: "application/octet-stream".into(), kind: TransferKind::Download };
        assert_eq!(resolve_transfer(&root, &host, &safe).unwrap(), root.canonicalize().unwrap().join("safe.bin"));
        for path in ["../outside", "/etc/passwd", "nested/../safe.bin"] {
            let bad = BackendTransferHandle { relative_path: path.into(), ..safe.clone() };
            assert_eq!(resolve_transfer(&root, &host, &bad).unwrap_err().code, -32043);
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
