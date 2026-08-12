use chrono::{DateTime, Utc};
use dashmap::DashMap;
use pi_web_protocol::{AgentId, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::watch;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Queued,
    Running,
    Committed,
    Succeeded,
    Failed,
    Cancelled,
}

impl OperationState {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    pub operation_id: String,
    pub owner_agent_id: AgentId,
    pub kind: String,
    pub state: OperationState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_failure: Option<String>,
}

struct OperationEntry {
    record: std::sync::RwLock<OperationRecord>,
    cancel: watch::Sender<bool>,
}

#[derive(Clone, Default)]
pub struct OperationRegistry {
    entries: Arc<DashMap<String, Arc<OperationEntry>>>,
}

#[derive(Clone)]
pub struct OperationHandle {
    entry: Arc<OperationEntry>,
}

impl OperationRegistry {
    pub fn begin(&self, operation_id: Option<String>, owner: AgentId, kind: impl Into<String>) -> Result<OperationHandle, RpcError> {
        let operation_id = operation_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        if operation_id.trim().is_empty() {
            return Err(RpcError::invalid_params("operationId is empty"));
        }
        let now = Utc::now();
        let (cancel, _) = watch::channel(false);
        let entry = Arc::new(OperationEntry {
            record: std::sync::RwLock::new(OperationRecord {
                operation_id: operation_id.clone(),
                owner_agent_id: owner,
                kind: kind.into(),
                state: OperationState::Queued,
                created_at: now,
                updated_at: now,
                safe_failure: None,
            }),
            cancel,
        });
        match self.entries.entry(operation_id.clone()) {
            dashmap::mapref::entry::Entry::Vacant(slot) => {
                slot.insert(Arc::clone(&entry));
                Ok(OperationHandle { entry })
            }
            dashmap::mapref::entry::Entry::Occupied(_) => Err(RpcError::conflict(
                "operationId already exists",
                json!({ "operationId": operation_id }),
            )),
        }
    }

    pub fn cancel(&self, owner: &AgentId, operation_id: &str) -> Result<serde_json::Value, RpcError> {
        let entry = self.entries.get(operation_id).ok_or_else(|| RpcError::not_found("operation", operation_id))?;
        let record = entry.record.read().expect("operation record lock poisoned");
        if record.owner_agent_id != *owner {
            return Err(RpcError::not_found("operation", operation_id));
        }
        let state = record.state;
        drop(record);
        if state.terminal() || matches!(state, OperationState::Committed) {
            return Ok(json!({ "operationId": operation_id, "result": "already_committed", "state": state }));
        }
        entry.cancel.send_replace(true);
        Ok(json!({ "operationId": operation_id, "result": "cancelled", "state": state }))
    }

    pub fn get(&self, owner: &AgentId, operation_id: &str) -> Result<OperationRecord, RpcError> {
        let entry = self.entries.get(operation_id).ok_or_else(|| RpcError::not_found("operation", operation_id))?;
        let record = entry.record.read().expect("operation record lock poisoned").clone();
        if record.owner_agent_id != *owner {
            return Err(RpcError::not_found("operation", operation_id));
        }
        Ok(record)
    }

    pub fn latest_for_owner(&self, owner: &AgentId) -> Option<OperationRecord> {
        self.entries.iter()
            .map(|entry| entry.record.read().expect("operation record lock poisoned").clone())
            .filter(|record| record.owner_agent_id == *owner)
            .max_by_key(|record| record.updated_at)
    }

    pub fn snapshot(&self) -> Vec<OperationRecord> {
        self.entries.iter().map(|entry| entry.record.read().expect("operation record lock poisoned").clone()).collect()
    }

    pub fn restore(&self, records: Vec<OperationRecord>) {
        for mut record in records {
            if !record.state.terminal() {
                record.state = OperationState::Failed;
                record.safe_failure = Some("daemon restarted before completion".into());
                record.updated_at = Utc::now();
            }
            let (cancel, _) = watch::channel(false);
            self.entries.insert(record.operation_id.clone(), Arc::new(OperationEntry {
                record: std::sync::RwLock::new(record),
                cancel,
            }));
        }
    }
}

impl OperationHandle {
    pub fn id(&self) -> String { self.entry.record.read().expect("operation record lock poisoned").operation_id.clone() }

    pub fn start(&self) { self.set(OperationState::Running, None); }
    pub fn commit(&self) { self.set(OperationState::Committed, None); }
    pub fn succeed(&self) { self.set(OperationState::Succeeded, None); }
    pub fn fail(&self, safe_failure: impl Into<String>) { self.set(OperationState::Failed, Some(safe_failure.into())); }
    pub fn cancelled(&self) { self.set(OperationState::Cancelled, None); }

    pub fn cancellation(&self) -> watch::Receiver<bool> { self.entry.cancel.subscribe() }
    pub fn is_cancelled(&self) -> bool { *self.entry.cancel.borrow() }
    pub fn record(&self) -> OperationRecord { self.entry.record.read().expect("operation record lock poisoned").clone() }

    fn set(&self, state: OperationState, safe_failure: Option<String>) {
        let mut record = self.entry.record.write().expect("operation record lock poisoned");
        if record.state.terminal() { return; }
        record.state = state;
        record.safe_failure = safe_failure;
        record.updated_at = Utc::now();
    }
}

pub async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    if *receiver.borrow() { return; }
    while receiver.changed().await.is_ok() {
        if *receiver.borrow() { return; }
    }
}

pub fn cancelled_error(operation_id: &str) -> RpcError {
    RpcError {
        code: -32010,
        message: "operation cancelled".into(),
        data: Some(json!({ "operationId": operation_id, "state": "cancelled" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_before_commit_and_after_commit_are_unambiguous() {
        let registry = OperationRegistry::default();
        let owner = AgentId("a".into());
        let queued = registry.begin(Some("queued".into()), owner.clone(), "act").unwrap();
        assert_eq!(registry.cancel(&owner, "queued").unwrap()["result"], "cancelled");
        assert!(queued.is_cancelled());

        let committed = registry.begin(Some("committed".into()), owner.clone(), "act").unwrap();
        committed.start();
        committed.commit();
        assert_eq!(registry.cancel(&owner, "committed").unwrap()["result"], "already_committed");
    }

    #[test]
    fn recovery_marks_nonterminal_operations_failed() {
        let registry = OperationRegistry::default();
        let owner = AgentId("a".into());
        let running = registry.begin(Some("running".into()), owner.clone(), "observe").unwrap();
        running.start();
        let restored = OperationRegistry::default();
        restored.restore(registry.snapshot());
        assert_eq!(restored.get(&owner, "running").unwrap().state, OperationState::Failed);
    }
}
