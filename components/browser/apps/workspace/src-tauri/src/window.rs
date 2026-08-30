use crate::{client::WorkspaceClientService, protocol::valid_id};
use serde::Deserialize;
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
}

pub fn parse_launch_args<I>(args: I) -> Result<LaunchRequest, String>
where I: IntoIterator<Item = String> {
    let values: Vec<String> = args.into_iter().collect();
    if values.len() > 4 || values.iter().any(|value| value.len() > 256) { return Err("workspace launch arguments exceed their bound".into()); }
    let mut request = LaunchRequest::default();
    for arg in values {
        if arg == "--raise" { if request.raise { return Err("duplicate --raise".into()); } request.raise = true; }
        else if arg == "--hide" { if request.hide { return Err("duplicate --hide".into()); } request.hide = true; }
        else if let Some(value) = arg.strip_prefix("--select-session=") { if request.browser_session_id.is_some() || !valid_id(value) { return Err("invalid --select-session".into()); } request.browser_session_id = Some(value.to_owned()); }
        else if let Some(value) = arg.strip_prefix("--select-tab=") { if request.tab_id.is_some() || !valid_id(value) { return Err("invalid --select-tab".into()); } request.tab_id = Some(value.to_owned()); }
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
        if request.hide { let _ = apply_window_action(&window, WindowAction::Hide); }
        else if request.raise || default_raise || request.browser_session_id.is_some() { let _ = apply_window_action(&window, WindowAction::Raise); }
    }
    if let Some(browser_session_id) = request.browser_session_id {
        let tab_id = request.tab_id;
        app.state::<WorkspaceClientService>().queue_launch_selection(browser_session_id.clone(), tab_id.clone());
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
        assert_eq!(parse_launch_args(["--raise".into(), "--select-session=session:one".into(), "--select-tab=tab:one".into()]).unwrap(), LaunchRequest { raise: true, hide: false, browser_session_id: Some("session:one".into()), tab_id: Some("tab:one".into()) });
        assert!(parse_launch_args(["--shell=rm".into()]).is_err());
        assert!(parse_launch_args(["--raise".into(), "--hide".into()]).is_err());
        assert!(parse_launch_args(["--select-tab=tab:one".into()]).is_err());
        assert!(parse_launch_args(["--select-session=/tmp/socket".into()]).is_err());
    }
}
