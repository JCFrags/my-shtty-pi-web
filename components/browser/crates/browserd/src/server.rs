use crate::{ConnectionContext, Coordinator, XdgPaths};
use anyhow::{Context, Result, anyhow};
use axum::{
    Json, Router,
    extract::{State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use futures::{SinkExt, StreamExt};
use pi_web_protocol::{JsonRpcRequest, JsonRpcResponse, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, UnixListener, UnixStream},
    sync::{mpsc, Semaphore},
    task::JoinSet,
};
use uuid::Uuid;
use tower_http::{
    cors::CorsLayer,
    trace::TraceLayer,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserdDescriptor {
    pub pid: u32,
    pub protocol_version: String,
    pub workspace_endpoint: String,
    pub workspace_websocket_endpoint: String,
    pub workspace_token: String,
    pub workspace_token_expires_at: DateTime<Utc>,
    pub unix_socket: String,
    pub started_at: DateTime<Utc>,
}

#[derive(Clone)]
struct AppState {
    coordinator: Arc<Coordinator>,
    descriptor: BrowserdDescriptor,
}

pub async fn run(coordinator: Arc<Coordinator>) -> Result<()> {
    prepare_socket(&coordinator.paths.socket_path()).await?;
    let unix = UnixListener::bind(coordinator.paths.socket_path())
        .with_context(|| format!("bind {}", coordinator.paths.socket_path().display()))?;
    let tcp = TcpListener::bind("127.0.0.1:0").await.context("bind loopback HTTP listener")?;
    let address = tcp.local_addr().context("read HTTP listener address")?;
    let started_at = Utc::now();
    let descriptor = BrowserdDescriptor {
        pid: std::process::id(),
        protocol_version: pi_web_protocol::PROTOCOL_VERSION.into(),
        workspace_endpoint: format!("http://{address}"),
        workspace_websocket_endpoint: format!("ws://{address}/ws"),
        workspace_token: Uuid::new_v4().to_string(),
        workspace_token_expires_at: started_at + chrono::Duration::minutes(5),
        unix_socket: coordinator.paths.socket_path().to_string_lossy().into_owned(),
        started_at,
    };
    write_descriptor(&coordinator.paths, &descriptor).await?;
    coordinator.spawn_heartbeat_sweeper();

    let state = AppState { coordinator: Arc::clone(&coordinator), descriptor };
    let cors = CorsLayer::new()
        .allow_origin([
            HeaderValue::from_static("tauri://localhost"),
            HeaderValue::from_static("http://tauri.localhost"),
        ])
        .allow_headers([axum::http::header::AUTHORIZATION, axum::http::header::CONTENT_TYPE])
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS]);
    let app = Router::new()
        .route("/health", get(health))
        .route("/rpc", post(http_rpc))
        .route("/ws", get(websocket_upgrade))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let mut tasks = JoinSet::new();
    let unix_coordinator = Arc::clone(&coordinator);
    tasks.spawn(async move { serve_unix(unix, unix_coordinator).await });
    let http_coordinator = Arc::clone(&coordinator);
    tasks.spawn(async move {
        axum::serve(tcp, app)
            .with_graceful_shutdown(shutdown_signal(http_coordinator))
            .await
            .context("serve loopback HTTP/WebSocket")
    });

    tokio::select! {
        signal = process_signal() => {
            signal?;
            coordinator.request_shutdown();
        }
        _ = coordinator.shutdown_requested() => {}
        result = tasks.join_next() => {
            match result {
                Some(Ok(Ok(()))) => return Err(anyhow!("browserd transport exited unexpectedly")),
                Some(Ok(Err(error))) => return Err(error),
                Some(Err(error)) => return Err(anyhow!("browserd transport task failed: {error}")),
                None => return Err(anyhow!("all browserd transports exited")),
            }
        }
    }

    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    let _ = tokio::fs::remove_file(coordinator.paths.socket_path()).await;
    let _ = tokio::fs::remove_file(coordinator.paths.descriptor_path()).await;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "pid": state.descriptor.pid,
        "protocolVersion": state.descriptor.protocol_version,
        "startedAt": state.descriptor.started_at,
        "workspaceTokenExpiresAt": state.descriptor.workspace_token_expires_at,
    }))
}

async fn http_rpc(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<JsonRpcRequest>,
) -> Response {
    if !authorized_workspace(&headers, &state.descriptor) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response();
    }
    if !workspace_method_allowed(&request.method) {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "method not authorized" }))).into_response();
    }
    if has_caller_identity(&request) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "caller identity is not accepted" }))).into_response();
    }
    let connection = ConnectionContext::new();
    if state.coordinator.bind_workspace_connection(&connection).await.is_err() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "workspace scope unavailable" }))).into_response();
    }
    Json(state.coordinator.dispatch_connected(&connection, request).await).into_response()
}

async fn websocket_upgrade(
    upgrade: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if !authorized_workspace(&headers, &state.descriptor) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let connection = ConnectionContext::new();
    if state.coordinator.bind_workspace_connection(&connection).await.is_err() {
        return (StatusCode::FORBIDDEN, "workspace scope unavailable").into_response();
    }
    upgrade
        .max_message_size(8 * 1024 * 1024)
        .on_upgrade(move |socket| websocket(socket, state.coordinator, connection))
        .into_response()
}

fn authorized_workspace(headers: &HeaderMap, descriptor: &BrowserdDescriptor) -> bool {
    Utc::now() < descriptor.workspace_token_expires_at
        && authorized_header(headers, &descriptor.workspace_token)
}

fn authorized_header(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|candidate| candidate == token)
}

fn has_caller_identity(request: &JsonRpcRequest) -> bool {
    request.params.as_object().is_some_and(|params| params.contains_key("agentId") || params.contains_key("clientId"))
}

fn workspace_method_allowed(method: &str) -> bool {
    matches!(method,
        "system.ping" | "system.capabilities"
        | "workspace.openScoped" | "workspace.getScoped" | "workspace.selectOwnedTab"
        | "workspace.acquireViewportLease" | "workspace.releaseViewportLease"
        | "workspace.getFrame" | "workspace.compareSetControl" | "workspace.input"
        | "workspace.cancelOperation"
    )
}

async fn websocket(socket: WebSocket, coordinator: Arc<Coordinator>, connection: ConnectionContext) {
    let (mut outgoing, mut incoming) = socket.split();
    let mut events = coordinator.subscribe();
    loop {
        tokio::select! {
            message = incoming.next() => {
                let Some(message) = message else { break; };
                match message {
                    Ok(Message::Text(text)) => {
                        let response = match serde_json::from_str::<JsonRpcRequest>(&text) {
                            Ok(request) if workspace_method_allowed(&request.method) && !has_caller_identity(&request) => coordinator.dispatch_connected(&connection, request).await,
                            Ok(request) => JsonRpcResponse::failure(request.id, RpcError { code: -32003, message: "method not authorized".into(), data: None }),
                            Err(error) => JsonRpcResponse::failure(Value::Null, RpcError {
                                code: -32700,
                                message: "parse error".into(),
                                data: Some(json!({ "detail": error.to_string() })),
                            }),
                        };
                        let Ok(encoded) = serde_json::to_string(&response) else { continue; };
                        if outgoing.send(Message::Text(encoded.into())).await.is_err() { break; }
                    }
                    Ok(Message::Ping(payload)) => {
                        if outgoing.send(Message::Pong(payload)).await.is_err() { break; }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            event = events.recv() => {
                match event {
                    Ok(event) => {
                        let Some(principal) = connection.principal().await else { continue; };
                        if !Coordinator::event_visible_to(&event, &principal) { continue; }
                        let Ok(encoded) = serde_json::to_string(&event.notification) else { continue; };
                        if outgoing.send(Message::Text(encoded.into())).await.is_err() { break; }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        let event = json!({
                            "jsonrpc": "2.0",
                            "method": "system.error",
                            "params": { "kind": "eventLag", "skipped": skipped }
                        });
                        if outgoing.send(Message::Text(event.to_string().into())).await.is_err() { break; }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

async fn serve_unix(listener: UnixListener, coordinator: Arc<Coordinator>) -> Result<()> {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.context("accept Unix client")?;
                let coordinator = Arc::clone(&coordinator);
                tokio::spawn(async move {
                    if let Err(error) = unix_client(stream, coordinator).await {
                        tracing::debug!(%error, "Unix client disconnected with error");
                    }
                });
            }
            _ = coordinator.shutdown_requested() => return Ok(()),
        }
    }
}

async fn unix_client(stream: UnixStream, coordinator: Arc<Coordinator>) -> Result<()> {
    let connection = ConnectionContext::new();
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    let (responses, mut response_receiver) = mpsc::unbounded_channel::<JsonRpcResponse>();
    let writer_task = tokio::spawn(async move {
        while let Some(response) = response_receiver.recv().await {
            let mut encoded = serde_json::to_vec(&response).context("encode Unix response")?;
            encoded.push(b'\n');
            writer.write_all(&encoded).await.context("write Unix response")?;
            writer.flush().await.context("flush Unix response")?;
        }
        Ok::<(), anyhow::Error>(())
    });
    let mut requests = JoinSet::new();
    let request_limit = Arc::new(Semaphore::new(32));
    let control_limit = Arc::new(Semaphore::new(8));
    while let Some(line) = lines.next_line().await.context("read Unix request")? {
        if line.trim().is_empty() { continue; }
        let request = match serde_json::from_str::<JsonRpcRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                let _ = responses.send(JsonRpcResponse::failure(Value::Null, RpcError {
                    code: -32700,
                    message: "parse error".into(),
                    data: Some(json!({ "detail": error.to_string() })),
                }));
                continue;
            }
        };
        let control_lane = matches!(request.method.as_str(), "operation.cancel" | "operation.get" | "agent.heartbeat" | "agent.unregister");
        let lane = if control_lane { &control_limit } else { &request_limit };
        let permit = match Arc::clone(lane).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                let _ = responses.send(JsonRpcResponse::failure(
                    request.id,
                    RpcError { code: -32000, message: "connection request limit reached".into(), data: None },
                ));
                continue;
            }
        };
        let coordinator = Arc::clone(&coordinator);
        let connection = connection.clone();
        let responses = responses.clone();
        requests.spawn(async move {
            let _permit = permit;
            let response = coordinator.dispatch_connected(&connection, request).await;
            let _ = responses.send(response);
        });
    }
    while requests.join_next().await.is_some() {}
    drop(responses);
    writer_task.await.context("join Unix response writer")??;
    Ok(())
}

async fn prepare_socket(path: &Path) -> Result<()> {
    if !path.exists() { return Ok(()); }
    match UnixStream::connect(path).await {
        Ok(_) => Err(anyhow!("pi-browserd is already listening at {}", path.display())),
        Err(_) => {
            tokio::fs::remove_file(path).await
                .with_context(|| format!("remove stale socket {}", path.display()))?;
            Ok(())
        }
    }
}

async fn write_descriptor(paths: &XdgPaths, descriptor: &BrowserdDescriptor) -> Result<()> {
    let temporary = paths.descriptor_path().with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(descriptor).context("serialize browserd descriptor")?;
    tokio::fs::write(&temporary, bytes).await
        .with_context(|| format!("write {}", temporary.display()))?;
    #[cfg(unix)]
    tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).await
        .with_context(|| format!("protect {}", temporary.display()))?;
    tokio::fs::rename(&temporary, paths.descriptor_path()).await
        .with_context(|| format!("replace {}", paths.descriptor_path().display()))?;
    Ok(())
}

async fn shutdown_signal(coordinator: Arc<Coordinator>) {
    coordinator.shutdown_requested().await;
}

async fn process_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .context("install SIGTERM handler")?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.context("wait for Ctrl-C")?,
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await.context("wait for Ctrl-C")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_transport_rejects_caller_identity_and_broad_methods() {
        let clean = JsonRpcRequest { jsonrpc: "2.0".into(), id: json!(1), method: "workspace.openScoped".into(), params: json!({}) };
        let injected = JsonRpcRequest { params: json!({ "agentId": "other" }), ..clean };
        assert!(has_caller_identity(&injected));
        assert!(workspace_method_allowed("workspace.getFrame"));
        assert!(!workspace_method_allowed("browser.list"));
    }
}
