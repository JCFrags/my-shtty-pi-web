mod acceptance;
mod capture;
mod client;
mod commands;
mod descriptor;
mod error;
mod frame;
mod probe;
mod protocol;
mod state;
mod window;

use capture::EvidenceCaptureService;
use client::WorkspaceClientService;
use tauri::Manager;
use window::{apply_launch_request, parse_launch_args};

pub fn run() {
    let initial = parse_launch_args(std::env::args().skip(1)).unwrap_or_else(|error| panic!("invalid Pi Browser Workspace arguments: {error}"));
    tauri::Builder::default()
        // This plugin must remain first so secondary processes never initialize other plugins.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let request = parse_launch_args(args.into_iter().skip(1));
            match request {
                Ok(request) if request.acceptance_output.is_none() => apply_launch_request(app, request, true),
                Ok(_) => eprintln!("rejected secondary acceptance-output argument"),
                Err(error) => eprintln!("rejected Pi Browser Workspace launch: {error}"),
            }
        }))
        .manage(WorkspaceClientService::default())
        .manage(EvidenceCaptureService::default())
        .manage(probe::BinaryProbeService::default())
        .on_window_event(|window, event| {
            if window.label() != "main" { return; }
            let tauri::WindowEvent::CloseRequested { api, .. } = event else { return; };
            api.prevent_close();
            let app = window.app_handle().clone();
            let window = window.clone();
            let service = app.state::<WorkspaceClientService>();
            if !service.begin_close() { return; }
            tauri::async_runtime::spawn(async move {
                let service = app.state::<WorkspaceClientService>();
                let result = if service.may_hide_without_return() { Ok(()) } else { service.close_task().await };
                match result {
                    Ok(()) => {
                        let _ = window.destroy();
                    }
                    Err(error) => {
                        service.notify_error(error);
                        service.finish_close();
                    }
                }
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace_open,
            commands::workspace_select,
            commands::workspace_clear_selection,
            commands::workspace_frame_ack,
            commands::workspace_take_control,
            commands::workspace_return_control,
            commands::workspace_input_batch,
            commands::workspace_current_state,
            commands::workspace_acceptance_enabled,
            commands::workspace_window_action,
            commands::workspace_binary_probe_open,
            commands::workspace_binary_probe_ack,
        ])
        .setup(move |app| {
            if let Some(path) = initial.acceptance_output.as_deref() {
                app.state::<WorkspaceClientService>().configure_acceptance(path).map_err(std::io::Error::other)?;
                app.state::<EvidenceCaptureService>().configure_from_acceptance_output(path).map_err(std::io::Error::other)?;
            }
            apply_launch_request(app.handle(), initial.clone(), false);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run Pi Browser Workspace");
}
