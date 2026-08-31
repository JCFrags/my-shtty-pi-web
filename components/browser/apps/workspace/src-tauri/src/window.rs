use crate::{capture::{EvidenceCapture, EvidenceCaptureService}, client::WorkspaceClientService, protocol::valid_id};
use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowAction { Raise, Hide }

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchRequest {
    pub raise: bool,
    pub hide: bool,
    pub browser_session_id: Option<String>,
    pub tab_id: Option<String>,
    pub acceptance_output: Option<PathBuf>,
    pub evidence_capture: Option<EvidenceCapture>,
}

pub fn parse_launch_args<I>(args: I) -> Result<LaunchRequest, String>
where I: IntoIterator<Item = String> {
    let values: Vec<String> = args.into_iter().collect();
    let maximum_arguments = if cfg!(debug_assertions) { 6 } else { 4 };
    if values.len() > maximum_arguments || values.iter().any(|value| value.len() > 1_024) { return Err("workspace launch arguments exceed their bound".into()); }
    let mut request = LaunchRequest::default();
    for arg in values {
        if arg == "--raise" { if request.raise { return Err("duplicate --raise".into()); } request.raise = true; }
        else if arg == "--hide" { if request.hide { return Err("duplicate --hide".into()); } request.hide = true; }
        else if let Some(value) = arg.strip_prefix("--select-session=") { if request.browser_session_id.is_some() || !valid_id(value) { return Err("invalid --select-session".into()); } request.browser_session_id = Some(value.to_owned()); }
        else if let Some(value) = arg.strip_prefix("--select-tab=") { if request.tab_id.is_some() || !valid_id(value) { return Err("invalid --select-tab".into()); } request.tab_id = Some(value.to_owned()); }
        else if cfg!(debug_assertions) && arg.starts_with("--acceptance-output=") {
            let value = arg.strip_prefix("--acceptance-output=").expect("checked prefix");
            if request.acceptance_output.is_some() || value.is_empty() { return Err("invalid --acceptance-output".into()); }
            request.acceptance_output = Some(PathBuf::from(value));
        }
        else if cfg!(debug_assertions) && arg.starts_with("--capture-evidence=") {
            let value = arg.strip_prefix("--capture-evidence=").expect("checked prefix");
            if request.evidence_capture.is_some() { return Err("duplicate --capture-evidence".into()); }
            request.evidence_capture = EvidenceCapture::parse(value);
            if request.evidence_capture.is_none() { return Err("invalid --capture-evidence".into()); }
        }
        else { return Err("unknown workspace launch argument".into()); }
    }
    if request.raise && request.hide { return Err("--raise and --hide conflict".into()); }
    if request.tab_id.is_some() && request.browser_session_id.is_none() { return Err("--select-tab requires --select-session".into()); }
    Ok(request)
}

pub fn apply_window_action<R: Runtime>(window: &WebviewWindow<R>, action: WindowAction) -> tauri::Result<()> {
    match action {
        WindowAction::Raise => { window.show()?; window.unminimize()?; window.set_focus()?; }
        WindowAction::Hide => window.hide()?,
    }
    Ok(())
}

pub fn apply_launch_request<R: Runtime>(app: &AppHandle<R>, request: LaunchRequest, default_raise: bool) {
    if let Some(window) = app.get_webview_window("main") {
        if request.hide { app.state::<WorkspaceClientService>().record_window_action("hide"); let _ = apply_window_action(&window, WindowAction::Hide); }
        else if request.raise || default_raise || request.browser_session_id.is_some() { app.state::<WorkspaceClientService>().record_window_action("raise"); let _ = apply_window_action(&window, WindowAction::Raise); }
        if let Some(name) = request.evidence_capture { if let Err(error) = app.state::<EvidenceCaptureService>().capture(&window, name) { eprintln!("rejected Tauri evidence capture: {error}"); } }
    }
    if let Some(browser_session_id) = request.browser_session_id {
        let tab_id = request.tab_id;
        let service = app.state::<WorkspaceClientService>();
        if service.stage_launch_selection_if_offline(browser_session_id.clone(), tab_id.clone()) { return; }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let service = app.state::<WorkspaceClientService>();
            let resolved = match tab_id {
                Some(value) => Some(value),
                None => service.current().await.snapshot.and_then(|snapshot| snapshot.sessions.into_iter().find(|session| session.browser_session_id == browser_session_id)).and_then(|session| session.tabs.into_iter().next()).map(|tab| tab.tab_id),
            };
            if let Some(tab_id) = resolved { let _ = service.select(browser_session_id, tab_id).await; }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_bounded_fixed_launch_arguments() {
        assert_eq!(parse_launch_args(["--raise".into(), "--select-session=session:one".into(), "--select-tab=tab:one".into()]).unwrap(), LaunchRequest { raise: true, hide: false, browser_session_id: Some("session:one".into()), tab_id: Some("tab:one".into()), acceptance_output: None, evidence_capture: None });
        assert!(parse_launch_args(["--shell=rm".into()]).is_err());
        assert!(parse_launch_args(["--raise".into(), "--hide".into()]).is_err());
        assert!(parse_launch_args(["--select-tab=tab:one".into()]).is_err());
        assert!(parse_launch_args(["--select-session=/tmp/socket".into()]).is_err());
        assert_eq!(parse_launch_args(["--hide".into()]).unwrap(), LaunchRequest { hide: true, ..LaunchRequest::default() });
        assert!(parse_launch_args(["--hide".into(), "--hide".into()]).is_err());
        assert!(parse_launch_args(["--select-session=session:one".into(), "--select-session=session:two".into()]).is_err());
        assert!(parse_launch_args(["--raise".into(), "--select-session=session:one".into(), "--select-tab=tab:one".into(), "--unknown".into(), "--extra".into()]).is_err());
        assert!(parse_launch_args([format!("--select-session={}", "a".repeat(257))]).is_err());
        #[cfg(debug_assertions)]
        assert_eq!(parse_launch_args(["--capture-evidence=agent-a".into()]).unwrap().evidence_capture, Some(EvidenceCapture::AgentA));
        #[cfg(not(debug_assertions))]
        assert!(parse_launch_args(["--capture-evidence=agent-a".into()]).is_err());
        assert!(parse_launch_args(["--capture-evidence=../secret".into()]).is_err());
        #[cfg(not(debug_assertions))]
        assert!(parse_launch_args(["--acceptance-output=/run/user/1000/output.jsonl".into()]).is_err());
    }
}
