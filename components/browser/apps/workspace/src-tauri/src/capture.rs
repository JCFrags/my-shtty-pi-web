use serde::Deserialize;
use std::{path::{Path, PathBuf}, sync::{Arc, Mutex}};
use tauri::{Runtime, WebviewWindow};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceCapture { AgentA, AgentB, Empty, Reconnecting, HumanA, HumanB, Returned }

impl EvidenceCapture {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "agent-a" => Some(Self::AgentA),
            "agent-b" => Some(Self::AgentB),
            "empty" => Some(Self::Empty),
            "reconnecting" => Some(Self::Reconnecting),
            "human-a" => Some(Self::HumanA),
            "human-b" => Some(Self::HumanB),
            "returned" => Some(Self::Returned),
            _ => None,
        }
    }

    #[cfg(all(debug_assertions, target_os = "linux"))]
    fn file_name(self) -> &'static str {
        match self {
            Self::AgentA => "phase3a-workspace-agent-a.png",
            Self::AgentB => "phase3a-workspace-agent-b.png",
            Self::Empty => "phase3a-workspace-empty.png",
            Self::Reconnecting => "phase3a-workspace-reconnecting.png",
            Self::HumanA => "phase3b-workspace-human-a.png",
            Self::HumanB => "phase3b-workspace-human-b.png",
            Self::Returned => "phase3b-workspace-returned.png",
        }
    }
}

#[derive(Clone, Default)]
#[cfg_attr(not(all(debug_assertions, target_os = "linux")), allow(dead_code))]
pub struct EvidenceCaptureService(Arc<Mutex<Option<PathBuf>>>);

impl EvidenceCaptureService {
    #[cfg(debug_assertions)]
    pub fn configure_from_acceptance_output(&self, output: &Path) -> Result<(), String> {
        let parent = output.parent().ok_or_else(|| "acceptance output parent is missing".to_owned())?;
        let parent = std::fs::canonicalize(parent).map_err(|error| format!("validate evidence output directory: {error}"))?;
        *self.0.lock().map_err(|_| "evidence capture lock failed".to_owned())? = Some(parent);
        Ok(())
    }

    #[cfg(not(debug_assertions))]
    pub fn configure_from_acceptance_output(&self, _output: &Path) -> Result<(), String> { Err("evidence capture requires a development build".into()) }

    pub fn capture<R: Runtime>(&self, window: &WebviewWindow<R>, name: EvidenceCapture) -> Result<(), String> {
        #[cfg(all(debug_assertions, target_os = "linux"))]
        {
            use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
            let directory = self.0.lock().map_err(|_| "evidence capture lock failed".to_owned())?.clone().ok_or_else(|| "evidence capture is not configured".to_owned())?;
            let path = directory.join(name.file_name());
            if path.exists() { return Err("evidence capture already exists".into()); }
            window.with_webview(move |platform| {
                platform.inner().snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&webkit2gtk::gio::Cancellable>, move |result| {
                    let write_result = result.map_err(|error| error.to_string()).and_then(|surface| {
                        let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(&path).map_err(|error| error.to_string())?;
                        #[cfg(unix)] {
                            use std::os::unix::fs::PermissionsExt;
                            file.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
                        }
                        surface.write_to_png(&mut file).map_err(|error| error.to_string())
                    });
                    if let Err(error) = write_result { eprintln!("Tauri evidence capture failed: {error}"); }
                });
            }).map_err(|error| error.to_string())?;
            Ok(())
        }
        #[cfg(not(all(debug_assertions, target_os = "linux")))]
        {
            let _ = (window, name);
            Err("evidence capture requires a Linux development build".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_fixed_evidence_names() {
        assert_eq!(EvidenceCapture::parse("agent-a"), Some(EvidenceCapture::AgentA));
        assert_eq!(EvidenceCapture::parse("reconnecting"), Some(EvidenceCapture::Reconnecting));
        assert_eq!(EvidenceCapture::parse("human-a"), Some(EvidenceCapture::HumanA));
        assert_eq!(EvidenceCapture::parse("returned"), Some(EvidenceCapture::Returned));
        assert_eq!(EvidenceCapture::parse("../secret"), None);
        assert_eq!(EvidenceCapture::parse("anything"), None);
    }
}
