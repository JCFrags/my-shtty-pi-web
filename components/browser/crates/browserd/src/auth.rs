use pi_web_protocol::{AgentId, AuthenticatedPrincipal, ClientId, PrincipalId, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub authenticated: AuthenticatedPrincipal,
    pub agent_id: AgentId,
    pub client_id: ClientId,
}

#[derive(Clone)]
pub struct ConnectionContext {
    id: Arc<str>,
    authenticated: AuthenticatedPrincipal,
    principal: Arc<Mutex<Option<Principal>>>,
}

impl Default for ConnectionContext {
    fn default() -> Self { Self::new() }
}

impl ConnectionContext {
    pub fn new() -> Self {
        let id = Uuid::new_v4().to_string();
        Self {
            id: id.clone().into(),
            authenticated: AuthenticatedPrincipal {
                principal_id: PrincipalId::new(),
                authentication_id: format!("local-user-connection:{id}"),
            },
            principal: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(test)]
    pub fn with_id(id: &str) -> Self {
        Self {
            id: id.to_owned().into(),
            authenticated: AuthenticatedPrincipal {
                principal_id: PrincipalId(id.to_owned()),
                authentication_id: format!("test-connection:{id}"),
            },
            principal: Arc::new(Mutex::new(None)),
        }
    }

    pub fn id(&self) -> &str { &self.id }
    pub fn authenticated(&self) -> &AuthenticatedPrincipal { &self.authenticated }

    pub async fn principal(&self) -> Option<Principal> { self.principal.lock().await.clone() }

    pub async fn bind(&self, principal: Principal) -> Result<(), RpcError> {
        let mut current = self.principal.lock().await;
        match current.as_ref() {
            None => {
                *current = Some(principal);
                Ok(())
            }
            Some(bound) if bound == &principal => Ok(()),
            Some(_) => Err(forbidden()),
        }
    }
}

pub fn forbidden() -> RpcError {
    RpcError {
        code: -32003,
        message: "forbidden".into(),
        data: Some(json!({ "reason": "principal mismatch" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(agent: &str, client: &str) -> Principal {
        Principal {
            authenticated: AuthenticatedPrincipal { principal_id: PrincipalId("p".into()), authentication_id: "test".into() },
            agent_id: AgentId(agent.into()), client_id: ClientId(client.into()),
        }
    }

    #[tokio::test]
    async fn connection_refuses_identity_rebind() {
        let connection = ConnectionContext::with_id("connection");
        connection.bind(principal("a", "ca")).await.unwrap();
        connection.bind(principal("a", "ca")).await.unwrap();
        let error = connection.bind(principal("b", "cb")).await.unwrap_err();
        assert_eq!(error.code, -32003);
        assert_eq!(connection.principal().await.unwrap(), principal("a", "ca"));
    }
}
