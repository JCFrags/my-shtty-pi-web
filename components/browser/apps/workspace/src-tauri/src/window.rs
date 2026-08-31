use crate::{capture::{EvidenceCapture, EvidenceCaptureService}, client::WorkspaceClientService, error::{PublicError, WorkspaceError}, protocol::valid_id};
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
    pub take_control: bool,
    pub return_control: bool,
    pub browser_session_id: Option<String>,
    pub tab_id: Option<String>,
    pub acceptance_output: Option<PathBuf>,
    pub evidence_capture: Option<EvidenceCapture>,
    pub acceptance_close: bool,
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
        else if arg == "--take-control" { if request.take_control { return Err("duplicate --take-control".into()); } request.take_control = true; }
        else if arg == "--return-control" { if request.return_control { return Err("duplicate --return-control".into()); } request.return_control = true; }
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
        else if cfg!(debug_assertions) && arg == "--acceptance-close" {
            if request.acceptance_close { return Err("duplicate --acceptance-close".into()); }
            request.acceptance_close = true;
        }
        else { return Err("unknown workspace launch argument".into()); }
    }
    if request.acceptance_close && (request.raise || request.hide || request.take_control || request.return_control || request.browser_session_id.is_some() || request.tab_id.is_some() || request.acceptance_output.is_some() || request.evidence_capture.is_some()) { return Err("--acceptance-close must be used alone".into()); }
    if request.raise && request.hide { return Err("--raise and --hide conflict".into()); }
    if request.take_control && request.return_control { return Err("control transfer arguments conflict".into()); }
    if request.hide && (request.browser_session_id.is_some() || request.evidence_capture.is_some() || request.take_control || request.return_control) { return Err("--hide cannot select, capture, or transfer control".into()); }
    if request.take_control && request.browser_session_id.is_none() { return Err("--take-control requires --select-session".into()); }
    if request.return_control && (request.raise || request.browser_session_id.is_some() || request.evidence_capture.is_some()) { return Err("--return-control must be used alone".into()); }
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
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = apply_launch_request_async(&app, request, default_raise).await {
            app.state::<WorkspaceClientService>().notify_error(error);
        }
    });
}

async fn apply_launch_request_async<R: Runtime>(app: &AppHandle<R>, request: LaunchRequest, default_raise: bool) -> Result<(), PublicError> {
    let service = app.state::<WorkspaceClientService>();
    if request.acceptance_close {
        let window = app.get_webview_window("main").ok_or_else(|| WorkspaceError::Unavailable.public())?;
        window.close().map_err(|_| WorkspaceError::Unavailable.public())?;
        return Ok(());
    }
    if request.return_control { service.release_for_hide().await?; }
    if let Some(window) = app.get_webview_window("main") {
        if request.hide {
            if !service.may_hide_without_return() { service.release_for_hide().await?; }
            apply_window_action(&window, WindowAction::Hide).map_err(|_| WorkspaceError::Unavailable.public())?;
            service.record_window_action("hide");
        } else if request.raise || default_raise || request.browser_session_id.is_some() {
            apply_window_action(&window, WindowAction::Raise).map_err(|_| WorkspaceError::Unavailable.public())?;
            service.record_window_action("raise");
        }
        if let Some(name) = request.evidence_capture {
            if let Err(error) = app.state::<EvidenceCaptureService>().capture(&window, name) { eprintln!("rejected Tauri evidence capture: {error}"); }
        }
    }
    if let Some(browser_session_id) = request.browser_session_id {
        let tab_id = request.tab_id;
        if service.stage_launch_selection_if_offline(browser_session_id.clone(), tab_id.clone(), request.take_control) { return Ok(()); }
        service.select_launch(browser_session_id, tab_id, request.take_control).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_bounded_fixed_launch_arguments() {
        assert_eq!(parse_launch_args(["--raise".into(), "--select-session=session:one".into(), "--select-tab=tab:one".into()]).unwrap(), LaunchRequest { raise: true, hide: false, take_control: false, return_control: false, browser_session_id: Some("session:one".into()), tab_id: Some("tab:one".into()), acceptance_output: None, evidence_capture: None, acceptance_close: false });
        assert_eq!(parse_launch_args(["--raise".into(), "--select-session=session:one".into(), "--select-tab=tab:one".into(), "--take-control".into()]).unwrap(), LaunchRequest { raise: true, take_control: true, browser_session_id: Some("session:one".into()), tab_id: Some("tab:one".into()), ..LaunchRequest::default() });
        assert_eq!(parse_launch_args(["--return-control".into()]).unwrap(), LaunchRequest { return_control: true, ..LaunchRequest::default() });
        assert!(parse_launch_args(["--shell=rm".into()]).is_err());
        assert!(parse_launch_args(["--raise".into(), "--hide".into()]).is_err());
        assert!(parse_launch_args(["--hide".into(), "--select-session=session:one".into()]).is_err());
        assert!(parse_launch_args(["--hide".into(), "--take-control".into()]).is_err());
        assert!(parse_launch_args(["--take-control".into()]).is_err());
        assert!(parse_launch_args(["--take-control".into(), "--return-control".into(), "--select-session=session:one".into()]).is_err());
        assert!(parse_launch_args(["--return-control".into(), "--raise".into()]).is_err());
        assert!(parse_launch_args(["--return-control".into(), "--select-session=session:one".into()]).is_err());
        assert!(parse_launch_args(["--select-tab=tab:one".into()]).is_err());
        assert!(parse_launch_args(["--select-session=/tmp/socket".into()]).is_err());
        assert_eq!(parse_launch_args(["--hide".into()]).unwrap(), LaunchRequest { hide: true, ..LaunchRequest::default() });
        assert!(parse_launch_args(["--hide".into(), "--hide".into()]).is_err());
        assert!(parse_launch_args(["--select-session=session:one".into(), "--select-session=session:two".into()]).is_err());
        assert!(parse_launch_args(["--raise".into(), "--select-session=session:one".into(), "--select-tab=tab:one".into(), "--unknown".into(), "--extra".into()]).is_err());
        assert!(parse_launch_args([format!("--select-session={}", "a".repeat(257))]).is_err());
        #[cfg(debug_assertions)] {
            assert_eq!(parse_launch_args(["--capture-evidence=agent-a".into()]).unwrap().evidence_capture, Some(EvidenceCapture::AgentA));
            assert!(parse_launch_args(["--acceptance-close".into()]).unwrap().acceptance_close);
            assert!(parse_launch_args(["--acceptance-close".into(), "--raise".into()]).is_err());
        }
        #[cfg(not(debug_assertions))]
        assert!(parse_launch_args(["--capture-evidence=agent-a".into()]).is_err());
        assert!(parse_launch_args(["--capture-evidence=../secret".into()]).is_err());
        #[cfg(not(debug_assertions))]
        assert!(parse_launch_args(["--acceptance-output=/run/user/1000/output.jsonl".into()]).is_err());
    }
}
