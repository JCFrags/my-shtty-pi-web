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
            Self::Descriptor | Self::Protocol | Self::Json(_) => PublicError { code: "INVALID_RUNTIME", message: "Workspace runtime validation failed.", retryable: true },
        }
    }
}

impl From<WorkspaceError> for PublicError {
    fn from(value: WorkspaceError) -> Self { value.public() }
}
