use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("AgentCursor browser workspace is unavailable.")]
    Unavailable,
    #[error("Workspace descriptor validation failed.")]
    Descriptor,
    #[error("Workspace protocol validation failed.")]
    Protocol,
    #[error("Workspace selection is invalid.")]
    InvalidSelection,
    #[error("Workspace request capacity is full.")]
    Capacity,
    #[error("Workspace I/O failed.")]
    Io(#[from] std::io::Error),
    #[error("Workspace JSON validation failed.")]
    Json(#[from] serde_json::Error),
    #[error("Workspace client is closed.")]
    Closed,
    #[error("Workspace operation was rejected.")]
    Remote { code: String, retryable: bool },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicError {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
}

impl WorkspaceError {
    pub fn public(&self) -> PublicError {
        match self {
            Self::Unavailable | Self::Io(_) => PublicError { code: "UNAVAILABLE", message: "AgentCursor browser workspace is unavailable.", retryable: true },
            Self::InvalidSelection => PublicError { code: "INVALID_SELECTION", message: "The selected browser tab is unavailable.", retryable: false },
            Self::Capacity => PublicError { code: "LIMIT_EXCEEDED", message: "Workspace request capacity is full.", retryable: true },
            Self::Closed => PublicError { code: "CLOSED", message: "Workspace client is closed.", retryable: true },
            Self::Remote { code, retryable } => remote_public_error(code, *retryable),
            Self::Descriptor | Self::Protocol | Self::Json(_) => PublicError { code: "INVALID_RUNTIME", message: "Workspace runtime validation failed.", retryable: true },
        }
    }
}

fn remote_public_error(code: &str, retryable: bool) -> PublicError {
    match code {
        "CONTROL_NOT_READY" => PublicError { code: "CONTROL_NOT_READY", message: "Browser view is preparing.", retryable },
        "CONTROL_TRANSFER_PENDING" => PublicError { code: "CONTROL_TRANSFER_PENDING", message: "Browser control transfer is pending.", retryable },
        "CONTROL_HELD_BY_HUMAN" => PublicError { code: "CONTROL_HELD_BY_HUMAN", message: "Browser control is held by the local user.", retryable },
        "CONTROL_LEASE_REQUIRED" => PublicError { code: "CONTROL_LEASE_REQUIRED", message: "A current browser control lease is required.", retryable },
        "CONTROL_LEASE_EXPIRED" => PublicError { code: "CONTROL_LEASE_EXPIRED", message: "Browser control lease expired.", retryable },
        "CONTROL_LEASE_CONFLICT" => PublicError { code: "CONTROL_LEASE_CONFLICT", message: "Browser control conflicts with current state.", retryable },
        "INPUT_SEQUENCE_STALE" => PublicError { code: "INPUT_SEQUENCE_STALE", message: "Browser input sequence is stale.", retryable },
        "INPUT_FRAME_STALE" => PublicError { code: "INPUT_FRAME_STALE", message: "Painted browser frame is stale.", retryable },
        "INPUT_RATE_LIMITED" => PublicError { code: "INPUT_RATE_LIMITED", message: "Browser input rate limit was reached.", retryable },
        "INPUT_UNSUPPORTED" => PublicError { code: "INPUT_UNSUPPORTED", message: "Browser input is unsupported.", retryable },
        "LIMIT_EXCEEDED" => PublicError { code: "LIMIT_EXCEEDED", message: "Workspace request capacity is full.", retryable },
        "NOT_FOUND" => PublicError { code: "NOT_FOUND", message: "Browser workspace target is unavailable.", retryable },
        "CONFLICT" => PublicError { code: "CONFLICT", message: "Workspace request conflicts with current state.", retryable },
        _ => PublicError { code: "UNAVAILABLE", message: "AgentCursor browser workspace is unavailable.", retryable: true },
    }
}

impl From<WorkspaceError> for PublicError {
    fn from(value: WorkspaceError) -> Self { value.public() }
}
