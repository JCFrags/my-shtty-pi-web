use pixel_core::{EngineEvent, Key, KeyEvent};
use serde_json::json;

use crate::ops::IdMap;

pub fn event_json(event: &EngineEvent, ids: &IdMap) -> Option<String> {
    let value = match event {
        EngineEvent::Click { node, key, x, y } => json!({
            "type": "click",
            "node": ids.ext(*node)?,
            "key": key,
            "x": x,
            "y": y,
        }),
        EngineEvent::RightClick { x, y } => json!({
            "type": "rightClick",
            "x": x,
            "y": y,
        }),
        EngineEvent::Change { node, key, text } => json!({
            "type": "change",
            "node": ids.ext(*node)?,
            "key": key,
            "text": text,
        }),
        EngineEvent::Submit { node, key, text } => json!({
            "type": "submit",
            "node": ids.ext(*node)?,
            "key": key,
            "text": text,
        }),
        EngineEvent::Scroll {
            node,
            key,
            offset,
            max,
        } => json!({
            "type": "scroll",
            "node": ids.ext(*node)?,
            "key": key,
            "offset": offset,
            "max": max,
        }),
        EngineEvent::Resize {
            width,
            height,
            base_px,
        } => json!({
            "type": "resize",
            "width": width,
            "height": height,
            "basePx": base_px,
        }),
        EngineEvent::Key(key) => key_json(key),
        EngineEvent::Paste(text) => json!({
            "type": "paste",
            "text": text,
        }),
    };
    Some(value.to_string())
}

fn key_json(event: &KeyEvent) -> serde_json::Value {
    let key = match event.key {
        Key::Char(c) => c.to_string(),
        Key::Up => "up".into(),
        Key::Down => "down".into(),
        Key::Left => "left".into(),
        Key::Right => "right".into(),
        Key::Home => "home".into(),
        Key::End => "end".into(),
        Key::Enter => "enter".into(),
        Key::Backspace => "backspace".into(),
        Key::Delete => "delete".into(),
        Key::Escape => "escape".into(),
        Key::Tab => "tab".into(),
        Key::Unknown => "unknown".into(),
    };
    json!({
        "type": "key",
        "key": key,
        "mods": {
            "shift": event.mods.shift,
            "alt": event.mods.alt,
            "ctrl": event.mods.ctrl,
            "super": event.mods.sup,
        },
    })
}
