use crate::error::WorkspaceError;
use serde::Deserialize;
use std::{env, fs, os::unix::fs::{FileTypeExt, PermissionsExt}, path::{Path, PathBuf}};

const MAX_DESCRIPTOR_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDescriptor {
    pub protocol_version: String,
    pub webxd_runtime_instance_id: String,
    pub pid: u32,
    pub process_start_ticks: String,
    pub socket_path: PathBuf,
    pub binding_secret: String,
    pub started_at: String,
}

impl WorkspaceDescriptor {
    pub fn discover() -> Result<Self, WorkspaceError> {
        let xdg = env::var_os("XDG_RUNTIME_DIR").ok_or(WorkspaceError::Unavailable)?;
        let runtime = PathBuf::from(xdg).join("pi-web").join("workspace");
        Self::read_from(&runtime.join("workspace.json"), &runtime)
    }

    pub(crate) fn read_from(path: &Path, expected_runtime: &Path) -> Result<Self, WorkspaceError> {
        let expected = expected_runtime.canonicalize().map_err(|_| WorkspaceError::Descriptor)?;
        if expected != expected_runtime || path.parent() != Some(expected_runtime) { return Err(WorkspaceError::Descriptor); }
        let runtime_meta = fs::symlink_metadata(expected_runtime).map_err(|_| WorkspaceError::Descriptor)?;
        if !runtime_meta.file_type().is_dir() || runtime_meta.file_type().is_symlink() || runtime_meta.permissions().mode() & 0o777 != 0o700 { return Err(WorkspaceError::Descriptor); }
        let meta = fs::symlink_metadata(path).map_err(|_| WorkspaceError::Descriptor)?;
        if !meta.file_type().is_file() || meta.file_type().is_symlink() || meta.permissions().mode() & 0o777 != 0o600 || meta.len() > MAX_DESCRIPTOR_BYTES { return Err(WorkspaceError::Descriptor); }
        let bytes = fs::read(path).map_err(|_| WorkspaceError::Descriptor)?;
        let descriptor: Self = serde_json::from_slice(&bytes).map_err(|_| WorkspaceError::Descriptor)?;
        descriptor.validate(&expected)?;
        Ok(descriptor)
    }

    fn validate(&self, runtime: &Path) -> Result<(), WorkspaceError> {
        if self.protocol_version != "workspace.v2"
            || !opaque_id(&self.webxd_runtime_instance_id)
            || self.pid == 0
            || self.process_start_ticks.is_empty()
            || !self.process_start_ticks.bytes().all(|byte| byte.is_ascii_digit())
            || !secret(&self.binding_secret)
            || self.started_at.len() < 20
            || self.started_at.len() > 32
            || !self.started_at.ends_with('Z')
        { return Err(WorkspaceError::Descriptor); }
        if self.socket_path.parent() != Some(runtime) || self.socket_path.file_name().and_then(|name| name.to_str()).is_none_or(|name| !name.starts_with("workspace-") || !name.ends_with(".sock")) { return Err(WorkspaceError::Descriptor); }
        let socket_parent = self.socket_path.parent().ok_or(WorkspaceError::Descriptor)?.canonicalize().map_err(|_| WorkspaceError::Descriptor)?;
        if socket_parent != runtime { return Err(WorkspaceError::Descriptor); }
        let socket = fs::symlink_metadata(&self.socket_path).map_err(|_| WorkspaceError::Descriptor)?;
        if !socket.file_type().is_socket() || socket.file_type().is_symlink() || socket.permissions().mode() & 0o777 != 0o600 { return Err(WorkspaceError::Descriptor); }
        if process_start_ticks(self.pid)? != self.process_start_ticks { return Err(WorkspaceError::Descriptor); }
        Ok(())
    }
}

fn process_start_ticks(pid: u32) -> Result<String, WorkspaceError> {
    let text = fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|_| WorkspaceError::Descriptor)?;
    let end = text.rfind(')').ok_or(WorkspaceError::Descriptor)?;
    let ticks = text.get(end + 2..).and_then(|tail| tail.split(' ').nth(19)).ok_or(WorkspaceError::Descriptor)?;
    if ticks.is_empty() || !ticks.bytes().all(|byte| byte.is_ascii_digit()) { return Err(WorkspaceError::Descriptor); }
    Ok(ticks.to_owned())
}

fn secret(value: &str) -> bool { value.len() == 43 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) }
fn opaque_id(value: &str) -> bool { (16..=128).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, os::unix::net::UnixListener};
    use tempfile::TempDir;

    fn ticks() -> String { process_start_ticks(std::process::id()).unwrap() }
    fn fixture() -> (TempDir, PathBuf, PathBuf, UnixListener) {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("workspace");
        fs::create_dir(&runtime).unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = runtime.join("workspace-abcdefghijklmnop.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        let descriptor = runtime.join("workspace.json");
        let mut file = fs::File::create(&descriptor).unwrap();
        write!(file, "{{\"protocolVersion\":\"workspace.v2\",\"webxdRuntimeInstanceId\":\"abcdefghijklmnop\",\"pid\":{},\"processStartTicks\":\"{}\",\"socketPath\":\"{}\",\"bindingSecret\":\"{}\",\"startedAt\":\"2026-08-30T00:00:00.000Z\"}}", std::process::id(), ticks(), socket.display(), "s".repeat(43)).unwrap();
        fs::set_permissions(&descriptor, fs::Permissions::from_mode(0o600)).unwrap();
        (root, runtime, descriptor, listener)
    }

    #[test]
    fn accepts_only_private_live_descriptor_and_socket() {
        let (_root, runtime, path, _listener) = fixture();
        let descriptor = WorkspaceDescriptor::read_from(&path, &runtime).unwrap();
        assert_eq!(descriptor.protocol_version, "workspace.v2");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(WorkspaceDescriptor::read_from(&path, &runtime).is_err());
    }

    #[test]
    fn rejects_unknown_fields_and_stale_process_identity() {
        let (_root, runtime, path, _listener) = fixture();
        let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["unexpected"] = serde_json::json!(true);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(WorkspaceDescriptor::read_from(&path, &runtime).is_err());
        value.as_object_mut().unwrap().remove("unexpected");
        value["processStartTicks"] = serde_json::json!("0");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(WorkspaceDescriptor::read_from(&path, &runtime).is_err());
    }
}
