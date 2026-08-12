use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use pi_web_protocol::{AgentId, BrowserSessionId, RpcError, TransferId};
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone)]
pub struct UploadRegistry {
    root: Arc<PathBuf>,
    handles: Arc<DashMap<TransferId, StagedUpload>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpload {
    pub transfer_id: TransferId,
    pub owner_agent_id: AgentId,
    pub browser_session_id: BrowserSessionId,
    pub media_type: String,
    pub size: u64,
    pub expires_at: DateTime<Utc>,
    pub consumed: bool,
    #[serde(skip)]
    path: PathBuf,
}

impl UploadRegistry {
    pub fn new(data_root: &Path) -> anyhow::Result<Self> {
        let root = data_root.join("uploads");
        std::fs::create_dir_all(&root)?;
        #[cfg(unix)]
        std::fs::set_permissions(&root, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
        Ok(Self { root: Arc::new(root), handles: Arc::new(DashMap::new()) })
    }

    pub fn stage(
        &self,
        owner_agent_id: AgentId,
        browser_session_id: BrowserSessionId,
        media_type: String,
        bytes: &[u8],
    ) -> Result<StagedUpload, RpcError> {
        if media_type.trim().is_empty() || bytes.is_empty() {
            return Err(RpcError::invalid_params("upload mediaType and bytes are required"));
        }
        let transfer_id = TransferId::new();
        let directory = self.root.join(owner_agent_id.as_ref());
        std::fs::create_dir_all(&directory).map_err(upload_internal)?;
        #[cfg(unix)]
        std::fs::set_permissions(&directory, std::os::unix::fs::PermissionsExt::from_mode(0o700)).map_err(upload_internal)?;
        let path = directory.join(transfer_id.as_ref());
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        use std::io::Write as _;
        let mut file = options.open(&path).map_err(upload_internal)?;
        file.write_all(bytes).map_err(upload_internal)?;
        file.sync_all().map_err(upload_internal)?;
        let upload = StagedUpload {
            transfer_id: transfer_id.clone(), owner_agent_id, browser_session_id, media_type,
            size: bytes.len() as u64, expires_at: Utc::now() + Duration::minutes(15),
            consumed: false, path,
        };
        self.handles.insert(transfer_id, upload.clone());
        Ok(upload)
    }

    pub fn resolve(
        &self,
        owner: &AgentId,
        session: &BrowserSessionId,
        ids: &[String],
    ) -> Result<Vec<PathBuf>, RpcError> {
        if ids.is_empty() { return Err(RpcError::invalid_params("upload handle list is empty")); }
        let mut paths = Vec::with_capacity(ids.len());
        for raw in ids {
            let id = TransferId::parse(raw.clone()).map_err(|_| RpcError::invalid_params("invalid upload handle"))?;
            let upload = self.handles.get(&id).ok_or_else(|| RpcError::not_found("upload handle", id.as_ref()))?;
            if upload.owner_agent_id != *owner || upload.browser_session_id != *session {
                return Err(RpcError::not_found("upload handle", id.as_ref()));
            }
            if upload.consumed || upload.expires_at <= Utc::now() {
                return Err(RpcError::conflict("upload handle is not staged", json!({ "transferId": id })));
            }
            let metadata = std::fs::symlink_metadata(&upload.path).map_err(upload_internal)?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(RpcError::invalid_params("invalid staged upload"));
            }
            paths.push(upload.path.clone());
        }
        Ok(paths)
    }

    pub fn consume(&self, owner: &AgentId, session: &BrowserSessionId, ids: &[String]) -> Result<(), RpcError> {
        for raw in ids {
            let id = TransferId::parse(raw.clone()).map_err(|_| RpcError::invalid_params("invalid upload handle"))?;
            let mut upload = self.handles.get_mut(&id).ok_or_else(|| RpcError::not_found("upload handle", id.as_ref()))?;
            if upload.owner_agent_id != *owner || upload.browser_session_id != *session {
                return Err(RpcError::not_found("upload handle", id.as_ref()));
            }
            upload.consumed = true;
            let _ = std::fs::remove_file(&upload.path);
        }
        Ok(())
    }
}

fn upload_internal(_error: impl std::fmt::Display) -> RpcError {
    RpcError { code: -32603, message: "upload staging failed".into(), data: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_handles_are_owned_and_single_use() {
        let root = std::env::temp_dir().join(format!("pi-web-upload-test-{}", uuid::Uuid::new_v4()));
        let registry = UploadRegistry::new(&root).unwrap();
        let owner = AgentId("a".into());
        let session = BrowserSessionId("s".into());
        let upload = registry.stage(owner.clone(), session.clone(), "text/plain".into(), b"data").unwrap();
        let ids = vec![upload.transfer_id.to_string()];
        assert!(registry.resolve(&AgentId("b".into()), &session, &ids).is_err());
        assert_eq!(registry.resolve(&owner, &session, &ids).unwrap().len(), 1);
        registry.consume(&owner, &session, &ids).unwrap();
        assert!(registry.resolve(&owner, &session, &ids).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
