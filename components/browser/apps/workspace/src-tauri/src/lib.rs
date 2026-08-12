use serde::{Deserialize, Serialize};
use std::{env, fs, path::PathBuf};
use tauri::{Manager, WebviewWindow};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserdDescriptor {
    protocol_version: String,
    workspace_endpoint: String,
    workspace_websocket_endpoint: String,
    workspace_token: String,
    unix_socket: String,
}

#[tauri::command]
fn browserd_descriptor() -> Result<BrowserdDescriptor, String> {
    let path = runtime_root().join("browserd.json");
    let content = fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    serde_json::from_str(&content).map_err(|error| format!("parse {}: {error}", path.display()))
}

fn runtime_root() -> PathBuf {
    env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
        .join("pi-web")
}

fn raise(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") { raise(&window); }
        }))
        .invoke_handler(tauri::generate_handler![browserd_descriptor])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if std::env::args().any(|arg| arg == "--raise") { raise(&window); }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run Pi Browser Workspace");
}
