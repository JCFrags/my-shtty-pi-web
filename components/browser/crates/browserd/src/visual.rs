use chrono::{DateTime, Duration, Utc};
use pi_web_protocol::{AgentId, BrowserSessionId, RpcError, TabId};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualBinding {
    pub evidence_id: String,
    pub owner_agent_id: AgentId,
    pub browser_session_id: BrowserSessionId,
    pub tab_id: TabId,
    pub engine_generation: u64,
    pub navigation_generation: u64,
    pub viewport_id: String,
    pub viewport_generation: u64,
    pub observation_sequence: u64,
    pub width: u32,
    pub height: u32,
    pub device_scale_factor: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub control_epoch: u64,
    pub captured_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct VisualExpectation<'a> {
    pub owner_agent_id: &'a AgentId,
    pub browser_session_id: &'a BrowserSessionId,
    pub tab_id: &'a TabId,
    pub engine_generation: u64,
    pub navigation_generation: u64,
    pub viewport_id: &'a str,
    pub viewport_generation: u64,
    pub width: u32,
    pub height: u32,
    pub device_scale_factor: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub control_epoch: u64,
    pub max_age_ms: i64,
}

#[derive(Default)]
pub struct VisualReplayGuard {
    consumed: HashSet<String>,
}

impl VisualReplayGuard {
    pub fn verify_and_consume(
        &mut self,
        binding: &VisualBinding,
        expected: &VisualExpectation<'_>,
        destructive: bool,
        now: DateTime<Utc>,
    ) -> Result<(), RpcError> {
        let reason = if binding.owner_agent_id != *expected.owner_agent_id { Some("owner") }
        else if binding.browser_session_id != *expected.browser_session_id { Some("session") }
        else if binding.tab_id != *expected.tab_id { Some("tab") }
        else if binding.engine_generation != expected.engine_generation { Some("engine_generation") }
        else if binding.navigation_generation != expected.navigation_generation { Some("navigation_generation") }
        else if binding.viewport_id != expected.viewport_id { Some("viewport") }
        else if binding.viewport_generation != expected.viewport_generation { Some("viewport_generation") }
        else if binding.width != expected.width || binding.height != expected.height { Some("geometry") }
        else if (binding.device_scale_factor - expected.device_scale_factor).abs() > f64::EPSILON { Some("scale") }
        else if (binding.scroll_x - expected.scroll_x).abs() > f64::EPSILON || (binding.scroll_y - expected.scroll_y).abs() > f64::EPSILON { Some("scroll") }
        else if binding.control_epoch != expected.control_epoch { Some("control_epoch") }
        else if now - binding.captured_at > Duration::milliseconds(expected.max_age_ms.max(0)) { Some("expired") }
        else if destructive && self.consumed.contains(&binding.evidence_id) { Some("replay") }
        else { None };
        if let Some(reason) = reason {
            return Err(stale_visual(reason));
        }
        if destructive { self.consumed.insert(binding.evidence_id.clone()); }
        Ok(())
    }

    pub fn invalidate_all(&mut self) { self.consumed.clear(); }
}

pub fn stale_visual(reason: &str) -> RpcError {
    RpcError {
        code: -32011,
        message: "stale visual evidence".into(),
        data: Some(json!({ "reason": reason, "required": "re-observe" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(now: DateTime<Utc>) -> VisualBinding {
        VisualBinding {
            evidence_id: "evidence".into(), owner_agent_id: AgentId("a".into()),
            browser_session_id: BrowserSessionId("s".into()), tab_id: TabId("t".into()),
            engine_generation: 2, navigation_generation: 3, viewport_id: "v".into(),
            viewport_generation: 4, observation_sequence: 5, width: 640, height: 480,
            device_scale_factor: 2.0, scroll_x: 0.0, scroll_y: 20.0, control_epoch: 7,
            captured_at: now,
        }
    }

    #[test]
    fn visual_binding_refuses_epoch_age_and_replay() {
        let now = Utc::now();
        let binding = binding(now);
        let owner = AgentId("a".into());
        let session = BrowserSessionId("s".into());
        let tab = TabId("t".into());
        let expected = VisualExpectation {
            owner_agent_id: &owner, browser_session_id: &session, tab_id: &tab,
            engine_generation: 2, navigation_generation: 3, viewport_id: "v",
            viewport_generation: 4, width: 640, height: 480, device_scale_factor: 2.0,
            scroll_x: 0.0, scroll_y: 20.0, control_epoch: 7, max_age_ms: 1_000,
        };
        let mut guard = VisualReplayGuard::default();
        guard.verify_and_consume(&binding, &expected, true, now).unwrap();
        assert_eq!(guard.verify_and_consume(&binding, &expected, true, now).unwrap_err().code, -32011);

        let mut stale_epoch = binding.clone();
        stale_epoch.control_epoch = 6;
        assert_eq!(VisualReplayGuard::default().verify_and_consume(&stale_epoch, &expected, false, now).unwrap_err().data.unwrap()["reason"], "control_epoch");
        assert_eq!(VisualReplayGuard::default().verify_and_consume(&binding, &expected, false, now + Duration::seconds(2)).unwrap_err().data.unwrap()["reason"], "expired");
    }
}
