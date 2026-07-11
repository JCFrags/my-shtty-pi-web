mod layout;

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use taffy::TaffyTree;
use taffy::prelude::TaffyMaxContent as _;

use layout::{MeasureCtx, to_taffy};

use crate::scroll::ScrollState;
use crate::scrollbar::{self, BarState, ScrollbarRects};
use crate::selection::{DocLayout, DocSelection, DocSelectionState};
use crate::style::{
    Color, DEFAULT_SELECTION_COLOR, Dimension, FlexDirection, Overflow, ScrollbarStyle,
    SelectionMode, Style,
};
use crate::text_input::{Granularity, InputGeometry, TextInput};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId {
    index: u32,
    generation: u32,
}

impl NodeId {
    pub fn to_bits(self) -> u64 {
        (u64::from(self.generation) << 32) | u64::from(self.index)
    }

    pub fn from_bits(bits: u64) -> Self {
        Self {
            index: (bits & 0xffff_ffff) as u32,
            generation: (bits >> 32) as u32,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PxRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl PxRect {
    pub const ZERO: PxRect = PxRect {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
    };

    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }

    pub fn intersect(&self, other: PxRect) -> PxRect {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        PxRect {
            x,
            y,
            w: ((self.x + self.w).min(other.x + other.w) - x).max(0.0),
            h: ((self.y + self.h).min(other.y + other.h) - y).max(0.0),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitTarget {
    Input(NodeId),
    Click(NodeId),
    Text(NodeId),
}

#[derive(Debug, Clone, Copy)]
pub struct ScrollArea {
    pub node: NodeId,
    pub rect: PxRect,
    pub content_height: f32,
    pub offset: f32,
}

impl ScrollArea {
    pub fn max_scroll(&self) -> f32 {
        (self.content_height - self.rect.h).max(0.0)
    }

    pub fn target_to_reveal(&self, rect: PxRect, current: f32, margin: f32) -> Option<f32> {
        let top = rect.y - self.rect.y + self.offset - margin;
        let bottom = top + rect.h + 2.0 * margin;
        if top < current {
            Some(top.max(0.0))
        } else if bottom > current + self.rect.h {
            Some(bottom - self.rect.h)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct InputProps {
    pub initial: String,
    pub value: Option<String>,
    pub caret_color: Color,
    pub selection_color: Color,
    pub auto_focus: bool,
    pub submit: bool,
}

impl Default for InputProps {
    fn default() -> Self {
        Self {
            initial: String::new(),
            value: None,
            caret_color: [255, 255, 255, 255],
            selection_color: [90, 90, 140, 255],
            auto_focus: false,
            submit: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Props {
    pub style: Style,
    pub text: Option<String>,
    pub key: Option<String>,
    pub clickable: bool,
    pub hidden: bool,
    pub input: Option<InputProps>,
    pub content_height: Option<f32>,
    pub scroll_events: bool,
    pub wheel_events: bool,
}

pub(crate) struct InputState {
    pub input: TextInput,
    pub caret_color: Color,
    pub selection_color: Color,
    pub submit: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Resolved {
    pub color: Color,
    pub px: f32,
    pub font: usize,
    pub selectable: bool,
    pub selection_color: Color,
}

pub(crate) struct RNode {
    pub style: Style,
    pub text: Option<String>,
    pub key: Option<String>,
    pub clickable: bool,
    pub hidden: bool,
    pub input: Option<InputState>,
    pub parent: Option<NodeId>,
    pub children: Vec<NodeId>,
    pub taffy: taffy::NodeId,
    pub scroll: ScrollState,
    pub scroll_max: f32,
    pub content_height: Option<f32>,
    pub scroll_events: bool,
    pub wheel_events: bool,
    pub last_scroll_emit: f32,
    pub bar: BarState,
    pub resolved: Resolved,
    pub abs: PxRect,
    pub visible: PxRect,
    pub order: u32,
}

struct Slot {
    generation: u32,
    node: Option<RNode>,
}

pub struct Tree {
    slots: Vec<Slot>,
    free: Vec<u32>,
    root: NodeId,
    pub(crate) taffy: TaffyTree<MeasureCtx>,
    keys: HashMap<String, NodeId>,
    children_dirty: HashSet<NodeId>,
    paint_order: Vec<NodeId>,
    scrollables: Vec<NodeId>,
    focus: Option<NodeId>,
    doc: DocSelectionState,
    base_px: f32,
    needs_layout: bool,
    needs_place: bool,
    needs_paint: bool,
}

pub(crate) const DEFAULT_RESOLVED: Resolved = Resolved {
    color: [255, 255, 255, 255],
    px: 16.0,
    font: 0,
    selectable: true,
    selection_color: DEFAULT_SELECTION_COLOR,
};

impl Tree {
    pub fn new(window: (f32, f32)) -> Self {
        let mut tree = Self {
            slots: Vec::new(),
            free: Vec::new(),
            root: NodeId {
                index: 0,
                generation: 0,
            },
            taffy: TaffyTree::new(),
            keys: HashMap::new(),
            children_dirty: HashSet::new(),
            paint_order: Vec::new(),
            scrollables: Vec::new(),
            focus: None,
            doc: DocSelectionState::default(),
            base_px: 16.0,
            needs_layout: true,
            needs_place: true,
            needs_paint: true,
        };
        let root = tree.create(Props {
            style: Style {
                width: Dimension::Px(window.0),
                height: Dimension::Px(window.1),
                flex_direction: FlexDirection::Column,
                ..Style::default()
            },
            ..Props::default()
        });
        tree.root = root;
        tree
    }

    pub fn root(&self) -> NodeId {
        self.root
    }

    pub fn focus(&self) -> Option<NodeId> {
        self.focus
    }

    pub fn set_focus(&mut self, id: Option<NodeId>) {
        if let Some(id) = id
            && self.get(id).is_none_or(|n| n.input.is_none())
        {
            return;
        }
        if self.focus != id {
            self.focus = id;
            self.needs_paint = true;
        }
    }

    pub fn contains(&self, id: NodeId) -> bool {
        self.get(id).is_some()
    }

    pub(crate) fn get(&self, id: NodeId) -> Option<&RNode> {
        let slot = self.slots.get(id.index as usize)?;
        if slot.generation != id.generation {
            return None;
        }
        slot.node.as_ref()
    }

    pub(crate) fn get_mut(&mut self, id: NodeId) -> Option<&mut RNode> {
        let slot = self.slots.get_mut(id.index as usize)?;
        if slot.generation != id.generation {
            return None;
        }
        slot.node.as_mut()
    }

    fn node(&self, id: NodeId) -> &RNode {
        self.get(id).expect("node id is live")
    }

    fn node_mut(&mut self, id: NodeId) -> &mut RNode {
        self.get_mut(id).expect("node id is live")
    }

    pub fn create(&mut self, props: Props) -> NodeId {
        let taffy = self
            .taffy
            .new_leaf(to_taffy(&props.style, props.hidden))
            .expect("taffy leaf");
        let text = match (&props.input, props.text) {
            (Some(input), _) => Some(input.initial.clone()),
            (None, text) => text,
        };
        let node = RNode {
            style: props.style,
            text,
            key: props.key.clone(),
            clickable: props.clickable,
            hidden: props.hidden,
            input: props.input.as_ref().map(|p| InputState {
                input: TextInput::new(p.initial.clone()),
                caret_color: p.caret_color,
                selection_color: p.selection_color,
                submit: p.submit,
            }),
            parent: None,
            children: Vec::new(),
            taffy,
            scroll: ScrollState::default(),
            scroll_max: 0.0,
            content_height: props.content_height,
            scroll_events: props.scroll_events,
            wheel_events: props.wheel_events,
            last_scroll_emit: 0.0,
            bar: BarState::default(),
            resolved: DEFAULT_RESOLVED,
            abs: PxRect::ZERO,
            visible: PxRect::ZERO,
            order: 0,
        };
        let id = match self.free.pop() {
            Some(index) => {
                let slot = &mut self.slots[index as usize];
                slot.node = Some(node);
                NodeId {
                    index,
                    generation: slot.generation,
                }
            }
            None => {
                self.slots.push(Slot {
                    generation: 0,
                    node: Some(node),
                });
                NodeId {
                    index: (self.slots.len() - 1) as u32,
                    generation: 0,
                }
            }
        };
        if let Some(key) = props.key {
            self.keys.insert(key, id);
        }
        if props.input.as_ref().is_some_and(|p| p.auto_focus) {
            self.focus = Some(id);
        }
        self.needs_layout = true;
        id
    }

    pub fn insert_before(&mut self, parent: NodeId, child: NodeId, before: Option<NodeId>) {
        assert!(child != self.root, "the root cannot be re-parented");
        self.detach(child);
        let index = match before {
            Some(before) => self
                .node(parent)
                .children
                .iter()
                .position(|&c| c == before)
                .unwrap_or(self.node(parent).children.len()),
            None => self.node(parent).children.len(),
        };
        self.node_mut(parent).children.insert(index, child);
        self.node_mut(child).parent = Some(parent);
        self.children_dirty.insert(parent);
        self.needs_layout = true;
    }

    pub fn append(&mut self, parent: NodeId, child: NodeId) {
        self.insert_before(parent, child, None);
    }

    fn detach(&mut self, child: NodeId) {
        let Some(parent) = self.node(child).parent else {
            return;
        };
        self.node_mut(parent).children.retain(|&c| c != child);
        self.node_mut(child).parent = None;
        self.children_dirty.insert(parent);
    }
    fn sync_dirty_children(&mut self) {
        let dirty: Vec<NodeId> = self.children_dirty.drain().collect();
        for parent in dirty {
            if self.get(parent).is_none() {
                continue;
            }
            let ids: Vec<taffy::NodeId> = self
                .node(parent)
                .children
                .iter()
                .map(|&c| self.node(c).taffy)
                .collect();
            self.taffy
                .set_children(self.node(parent).taffy, &ids)
                .expect("taffy children");
        }
    }

    pub fn remove(&mut self, id: NodeId) {
        assert!(id != self.root, "the root cannot be removed");
        if self.get(id).is_none() {
            return;
        }
        self.detach(id);
        let mut stack = vec![id];
        while let Some(id) = stack.pop() {
            let node = self.node_mut(id);
            stack.append(&mut node.children);
            let taffy = node.taffy;
            let key = node.key.take();
            let slot = &mut self.slots[id.index as usize];
            slot.node = None;
            slot.generation = slot.generation.wrapping_add(1);
            self.free.push(id.index);
            let _ = self.taffy.remove(taffy);
            if let Some(key) = key
                && self.keys.get(&key) == Some(&id)
            {
                self.keys.remove(&key);
            }
            if self.focus == Some(id) {
                self.focus = None;
            }
            self.doc.invalidate(id);
        }
        self.needs_layout = true;
    }

    pub fn remove_children(&mut self, id: NodeId) {
        let children = self.node(id).children.clone();
        for child in children {
            self.remove(child);
        }
    }

    pub fn update(&mut self, id: NodeId, props: Props) {
        let controlled_text = props.input.as_ref().and_then(|p| p.value.clone());
        let node = self.node_mut(id);
        let style_changed = node.style != props.style || node.hidden != props.hidden;
        let mut changed = style_changed || node.clickable != props.clickable;
        node.style = props.style;
        node.hidden = props.hidden;
        node.clickable = props.clickable;
        node.scroll_events = props.scroll_events;
        node.wheel_events = props.wheel_events;
        if node.content_height != props.content_height {
            node.content_height = props.content_height;
            changed = true;
            self.needs_place = true;
        }
        let node = self.node_mut(id);
        let mut input_removed = false;
        match (&mut node.input, props.input) {
            (Some(state), Some(p)) => {
                changed |= state.caret_color != p.caret_color
                    || state.selection_color != p.selection_color;
                state.caret_color = p.caret_color;
                state.selection_color = p.selection_color;
                state.submit = p.submit;
            }
            (state @ Some(_), None) => {
                *state = None;
                input_removed = true;
                changed = true;
            }
            (state @ None, Some(p)) => {
                *state = Some(InputState {
                    input: TextInput::new(p.initial.clone()),
                    caret_color: p.caret_color,
                    selection_color: p.selection_color,
                    submit: p.submit,
                });
                node.text = Some(p.initial);
                changed = true;
                self.needs_layout = true;
            }
            (None, None) => {}
        }
        if input_removed && self.focus == Some(id) {
            self.focus = None;
        }
        let node = self.node_mut(id);
        let mut text_changed = false;
        if node.input.is_none() && node.text != props.text {
            node.text = props.text;
            text_changed = true;
        }
        let old_key = node.key.clone();
        if text_changed {
            changed = true;
            self.needs_layout = true;
            self.doc.invalidate(id);
        }
        if old_key != props.key {
            self.node_mut(id).key = props.key.clone();
            if let Some(old) = old_key
                && self.keys.get(&old) == Some(&id)
            {
                self.keys.remove(&old);
            }
            if let Some(key) = props.key {
                self.keys.insert(key, id);
            }
        }
        if style_changed {
            let (taffy, style, hidden) = {
                let node = self.node(id);
                (node.taffy, node.style.clone(), node.hidden)
            };
            self.taffy
                .set_style(taffy, to_taffy(&style, hidden))
                .expect("taffy style");
            self.needs_layout = true;
        }
        if let Some(value) = controlled_text {
            self.set_input_text(id, &value);
        }
        if changed {
            self.needs_paint = true;
        }
    }

    pub fn set_input_text(&mut self, id: NodeId, text: &str) {
        let node = self.node_mut(id);
        let Some(state) = &mut node.input else {
            return;
        };
        if state.input.text() == text {
            return;
        }
        state.input.replace_all(text);
        node.text = Some(text.to_string());
        self.needs_layout = true;
    }

    pub(crate) fn input_mut(&mut self, id: NodeId) -> Option<&mut TextInput> {
        self.get_mut(id)
            .and_then(|n| n.input.as_mut())
            .map(|s| &mut s.input)
    }

    pub fn input(&self, id: NodeId) -> Option<&TextInput> {
        self.get(id)?.input.as_ref().map(|s| &s.input)
    }

    pub fn edit_input(&mut self, id: NodeId, edit: impl FnOnce(&mut TextInput)) {
        if let Some(input) = self.input_mut(id) {
            edit(input);
            self.sync_input_text(id);
        }
    }

    pub fn input_text(&self, id: NodeId) -> Option<&str> {
        self.get(id)?.input.as_ref().map(|s| s.input.text())
    }

    pub(crate) fn sync_input_text(&mut self, id: NodeId) {
        let node = self.node_mut(id);
        if let Some(state) = &node.input {
            let text = state.input.text().to_string();
            if node.text.as_deref() != Some(text.as_str()) {
                node.text = Some(text);
                self.needs_layout = true;
            }
        }
        self.needs_paint = true;
    }

    pub fn text_of(&self, id: NodeId) -> Option<&str> {
        self.get(id)?.text.as_deref()
    }

    pub(crate) fn input_meta(&self, id: NodeId) -> Option<(Resolved, bool)> {
        let node = self.get(id)?;
        let submit = node.input.as_ref()?.submit;
        Some((node.resolved, submit))
    }

    pub(crate) fn resolved_px(&self, id: NodeId) -> Option<f32> {
        Some(self.get(id)?.resolved.px)
    }

    pub(crate) fn bar_opacity(&self, id: NodeId) -> f32 {
        self.get(id).map_or(0.0, |n| n.bar.opacity)
    }

    pub(crate) fn step_bar(&mut self, id: NodeId, engaged: bool, dt: f32, now: Instant) -> bool {
        let Some(node) = self.get_mut(id) else {
            return false;
        };
        let scroll_max = node.scroll_max;
        scrollbar::step(&mut node.bar, engaged, scroll_max, dt, now)
    }

    pub(crate) fn bar_animating(&self, id: NodeId, now: Instant) -> bool {
        self.get(id)
            .is_some_and(|node| scrollbar::animating(&node.bar, now))
    }

    pub(crate) fn touch_bar(&mut self, id: NodeId) {
        if let Some(node) = self.get_mut(id) {
            node.bar.last_move = Some(Instant::now());
        }
    }

    pub(crate) fn take_scroll_emit(&mut self, id: NodeId) -> Option<(Option<String>, f32, f32)> {
        let node = self.get(id)?;
        if !node.scroll_events {
            return None;
        }
        let (offset, max) = (node.scroll.position, node.scroll_max);
        if (offset - node.last_scroll_emit).abs() < 0.5 {
            return None;
        }
        let key = node.key.clone();
        self.get_mut(id)?.last_scroll_emit = offset;
        Some((key, offset, max))
    }

    pub fn find(&self, key: &str) -> Option<NodeId> {
        self.keys.get(key).copied()
    }

    pub fn key_of(&self, id: NodeId) -> Option<&str> {
        self.get(id)?.key.as_deref()
    }

    pub fn parent(&self, id: NodeId) -> Option<NodeId> {
        self.get(id)?.parent
    }

    pub fn children(&self, id: NodeId) -> &[NodeId] {
        self.get(id).map_or(&[], |n| &n.children)
    }

    pub fn set_window(&mut self, window: (f32, f32)) {
        let root = self.root;
        let node = self.node_mut(root);
        node.style.width = Dimension::Px(window.0);
        node.style.height = Dimension::Px(window.1);
        let (taffy, style, hidden) = (node.taffy, node.style.clone(), node.hidden);
        self.taffy
            .set_style(taffy, to_taffy(&style, hidden))
            .expect("taffy style");
        self.needs_layout = true;
    }

    pub fn dirty(&self) -> bool {
        self.needs_layout || self.needs_place || self.needs_paint
    }

    pub(crate) fn mark_paint(&mut self) {
        self.needs_paint = true;
    }

    pub(crate) fn clear_paint_flag(&mut self) {
        self.needs_paint = false;
    }

    pub(crate) fn mark_place(&mut self) {
        self.needs_place = true;
    }

    pub fn flush_layout(&mut self, fonts: &[fontdue::Font], base_px: f32) {
        assert!(!fonts.is_empty());
        self.base_px = base_px;
        if self.needs_layout {
            crate::profiler::span("tree.sync", || self.sync_dirty_children());
            crate::profiler::span("tree.resolve", || {
                self.resolve(
                    self.root,
                    Resolved {
                        px: base_px,
                        ..DEFAULT_RESOLVED
                    },
                )
            });
            let root_taffy = self.node(self.root).taffy;
            crate::profiler::span("tree.layout", || {
                self.taffy
                    .compute_layout_with_measure(
                        root_taffy,
                        taffy::Size::MAX_CONTENT,
                        |known, available, _node, context, _style| {
                            layout::measure(known, available, context.as_deref(), fonts)
                        },
                    )
                    .expect("layout")
            });
            self.needs_layout = false;
            self.needs_place = true;
        }
        if self.needs_place {
            crate::profiler::span("tree.place", || self.place());
            self.needs_place = false;
            self.needs_paint = true;
        }
    }

    fn resolve(&mut self, id: NodeId, inherited: Resolved) {
        let node = self.node_mut(id);
        let resolved = Resolved {
            color: node.style.color.unwrap_or(inherited.color),
            px: node.style.font_size.unwrap_or(inherited.px),
            font: node.style.font.unwrap_or(inherited.font),
            selectable: node.style.selectable.unwrap_or(inherited.selectable),
            selection_color: node
                .style
                .selection_color
                .unwrap_or(inherited.selection_color),
        };
        node.resolved = resolved;
        let taffy = node.taffy;
        let children = node.children.clone();
        if node.text.is_some() && children.is_empty() {
            let text = node.text.clone().unwrap_or_default();
            let wrap = node.style.wrap;
            let stale = match self.taffy.get_node_context(taffy) {
                Some(ctx) => {
                    ctx.text != text
                        || ctx.px != resolved.px
                        || ctx.font != resolved.font
                        || ctx.wrap != wrap
                }
                None => true,
            };
            if stale {
                self.taffy
                    .set_node_context(
                        taffy,
                        Some(MeasureCtx {
                            text,
                            px: resolved.px,
                            font: resolved.font,
                            wrap,
                        }),
                    )
                    .expect("taffy context");
                let _ = self.taffy.mark_dirty(taffy);
            }
        } else if self.taffy.get_node_context(taffy).is_some() {
            self.taffy
                .set_node_context(taffy, None)
                .expect("taffy context");
            let _ = self.taffy.mark_dirty(taffy);
        }
        for child in children {
            self.resolve(child, resolved);
        }
    }

    fn place(&mut self) {
        self.paint_order.clear();
        self.scrollables.clear();
        let layout = self
            .taffy
            .layout(self.node(self.root).taffy)
            .expect("layout");
        let window = PxRect {
            x: 0.0,
            y: 0.0,
            w: layout.size.width,
            h: layout.size.height,
        };
        self.place_node(self.root, (0.0, 0.0), Some(window));
    }

    fn place_node(&mut self, id: NodeId, origin: (f32, f32), clip: Option<PxRect>) {
        if self.node(id).hidden {
            self.zero_rects(id);
            return;
        }
        let layout = *self.taffy.layout(self.node(id).taffy).expect("layout");
        let rect = PxRect {
            x: origin.0 + layout.location.x,
            y: origin.1 + layout.location.y,
            w: layout.size.width,
            h: layout.size.height,
        };
        let visible = clip.map_or(rect, |c| rect.intersect(c));
        let node = self.node_mut(id);
        node.abs = rect;
        node.visible = visible;
        let scrolls = node.style.overflow == Overflow::Scroll;
        if scrolls {
            let content = node.content_height.unwrap_or(layout.content_size.height);
            node.scroll_max = (content - rect.h).max(0.0);
            let max = node.scroll_max;
            if node.scroll.position > max {
                node.scroll.position = max;
            }
            if node.scroll.target > max {
                node.scroll.target = max;
            }
            self.scrollables.push(id);
        }
        self.node_mut(id).order = self.paint_order.len() as u32;
        self.paint_order.push(id);

        let node = self.node(id);
        let child_origin = if scrolls {
            (rect.x, rect.y - node.scroll.position)
        } else {
            (rect.x, rect.y)
        };
        let child_clip = if node.style.overflow != Overflow::Visible {
            Some(visible)
        } else {
            clip
        };
        for child in node.children.clone() {
            self.place_node(child, child_origin, child_clip);
        }
    }

    fn zero_rects(&mut self, id: NodeId) {
        let node = self.node_mut(id);
        node.abs = PxRect::ZERO;
        node.visible = PxRect::ZERO;
        for child in node.children.clone() {
            self.zero_rects(child);
        }
    }

    pub fn rect(&self, id: NodeId) -> Option<PxRect> {
        Some(self.get(id)?.abs)
    }

    pub fn visible_rect(&self, id: NodeId) -> Option<PxRect> {
        Some(self.get(id)?.visible)
    }

    pub fn hit_wheel(&self, x: f32, y: f32) -> Option<NodeId> {
        self.paint_order.iter().rev().copied().find(|&id| {
            self.get(id)
                .is_some_and(|node| node.wheel_events && node.visible.contains(x, y))
        })
    }

    pub fn hit_any(&self, x: f32, y: f32) -> Option<NodeId> {
        self.paint_order.iter().rev().copied().find(|&id| {
            self.get(id)
                .is_some_and(|node| node.visible.w > 0.0 && node.visible.contains(x, y))
        })
    }

    pub fn hit_click(&self, x: f32, y: f32) -> Option<NodeId> {
        self.paint_order.iter().rev().copied().find(|&id| {
            self.get(id)
                .is_some_and(|node| node.clickable && node.visible.contains(x, y))
        })
    }

    pub fn hover_at(&self, x: f32, y: f32) -> Option<NodeId> {
        self.paint_order.iter().rev().copied().find(|&id| {
            self.get(id).is_some_and(|node| {
                (node.style.hover_background.is_some() || node.style.hover_color.is_some())
                    && node.visible.contains(x, y)
            })
        })
    }

    pub fn hit_target(&self, x: f32, y: f32) -> Option<HitTarget> {
        for &id in self.paint_order.iter().rev() {
            let Some(node) = self.get(id) else {
                continue;
            };
            if !node.visible.contains(x, y) {
                continue;
            }
            if node.input.is_some() {
                return Some(HitTarget::Input(id));
            }
            if node.clickable {
                return Some(HitTarget::Click(id));
            }
            if self.selectable_text_leaf(id) {
                return Some(self.interactive_ancestor(id).unwrap_or(HitTarget::Text(id)));
            }
            if node.style.overflow == Overflow::Scroll
                && let Some(input) = self.descendant_input(id)
            {
                return Some(HitTarget::Input(input));
            }
        }
        None
    }

    pub(crate) fn selectable_text_leaf(&self, id: NodeId) -> bool {
        let Some(node) = self.get(id) else {
            return false;
        };
        node.text.is_some()
            && node.children.is_empty()
            && node.input.is_none()
            && !node.hidden
            && node.resolved.selectable
    }

    fn interactive_ancestor(&self, id: NodeId) -> Option<HitTarget> {
        let mut current = self.get(id)?.parent;
        while let Some(cur) = current {
            let node = self.get(cur)?;
            if node.input.is_some() {
                return Some(HitTarget::Input(cur));
            }
            if node.clickable {
                return Some(HitTarget::Click(cur));
            }
            current = node.parent;
        }
        None
    }

    fn descendant_input(&self, id: NodeId) -> Option<NodeId> {
        let node = self.get(id)?;
        for &child in &node.children {
            let Some(node) = self.get(child) else {
                continue;
            };
            if node.hidden {
                continue;
            }
            if node.input.is_some() {
                return Some(child);
            }
            if let Some(found) = self.descendant_input(child) {
                return Some(found);
            }
        }
        None
    }

    pub fn scroll_area_at(&self, x: f32, y: f32) -> Option<ScrollArea> {
        self.scrollables
            .iter()
            .rev()
            .copied()
            .find(|&id| self.get(id).is_some_and(|node| node.visible.contains(x, y)))
            .and_then(|id| self.scroll_area(id))
    }

    pub fn scroll_area(&self, id: NodeId) -> Option<ScrollArea> {
        let node = self.get(id)?;
        if node.style.overflow != Overflow::Scroll {
            return None;
        }
        Some(ScrollArea {
            node: id,
            rect: node.visible,
            content_height: node.scroll_max + node.visible.h,
            offset: node.scroll.position,
        })
    }

    pub(crate) fn scroll_nodes(&self) -> Vec<NodeId> {
        self.scrollables.clone()
    }

    pub fn scroll_state(&self, id: NodeId) -> Option<&ScrollState> {
        self.get(id).map(|n| &n.scroll)
    }

    pub(crate) fn scroll_state_mut(&mut self, id: NodeId) -> Option<&mut ScrollState> {
        self.get_mut(id).map(|n| &mut n.scroll)
    }

    pub fn scroll_max(&self, id: NodeId) -> f32 {
        self.get(id).map_or(0.0, |n| n.scroll_max)
    }

    pub(crate) fn scrollbar_style(&self, id: NodeId) -> Option<ScrollbarStyle> {
        let node = self.get(id)?;
        Some(
            node.style
                .scrollbar
                .unwrap_or_else(|| ScrollbarStyle::for_rem(self.base_px)),
        )
    }

    pub fn scrollbar_rects(&self, id: NodeId) -> Option<ScrollbarRects> {
        let node = self.get(id)?;
        if node.style.overflow != Overflow::Scroll || node.scroll_max <= 0.0 {
            return None;
        }
        let bar = self.scrollbar_style(id)?;
        scrollbar::rects(
            &bar,
            node.visible,
            node.abs.h,
            node.scroll_max,
            node.scroll.position,
            node.bar.expand,
        )
    }

    pub fn scroll_pos_for_thumb(&self, id: NodeId, thumb_y: f32) -> Option<f32> {
        let rects = self.scrollbar_rects(id)?;
        let node = self.get(id)?;
        Some(scrollbar::pos_for_thumb(&rects, node.scroll_max, thumb_y))
    }

    pub fn scroll_parent(&self, id: NodeId) -> Option<NodeId> {
        let mut current = Some(id);
        while let Some(id) = current {
            let node = self.get(id)?;
            if node.style.overflow == Overflow::Scroll {
                return Some(id);
            }
            current = node.parent;
        }
        None
    }

    pub fn input_geometry(&self, id: NodeId) -> Option<InputGeometry> {
        self.get(id)?.input.as_ref()?;
        self.text_geometry(id)
    }

    pub fn text_geometry(&self, id: NodeId) -> Option<InputGeometry> {
        let node = self.get(id)?;
        let layout = self.taffy.layout(node.taffy).ok()?;
        Some(InputGeometry {
            origin: (
                node.abs.x + layout.padding.left,
                node.abs.y + layout.padding.top,
            ),
            font: node.resolved.font,
            px: node.resolved.px,
            max_width: node.style.wrap.then(|| {
                (layout.size.width - layout.padding.left - layout.padding.right).max(0.0)
                    + crate::wrap::WRAP_SLACK
            }),
        })
    }

    pub fn doc_selection(&self) -> Option<DocSelection> {
        self.doc.selection(self)
    }

    pub fn doc_selection_range(&self, id: NodeId) -> Option<std::ops::Range<usize>> {
        self.doc.selection_range(self, id)
    }

    pub fn doc_selected_text(&self) -> Option<String> {
        self.doc.selected_text(self)
    }

    pub fn doc_selection_blocks(
        &self,
        fonts: &[fontdue::Font],
    ) -> Vec<(NodeId, Vec<PxRect>, Color)> {
        self.doc.blocks(self, fonts)
    }

    fn with_doc<R>(&mut self, f: impl FnOnce(&mut DocSelectionState, &Self) -> R) -> R {
        let mut doc = std::mem::take(&mut self.doc);
        let out = f(&mut doc, self);
        self.doc = doc;
        out
    }

    pub fn doc_select_down(&mut self, point: (f32, f32), fonts: &[fontdue::Font]) -> bool {
        let selected = self.with_doc(|doc, tree| doc.select_down(tree, point, fonts));
        if selected {
            self.needs_paint = true;
        }
        selected
    }

    pub fn doc_select_down_near(&mut self, point: (f32, f32), fonts: &[fontdue::Font]) -> bool {
        let selected = self.with_doc(|doc, tree| doc.select_down_near(tree, point, fonts));
        if selected {
            self.needs_paint = true;
        }
        selected
    }

    pub fn doc_select_drag(&mut self, point: (f32, f32), fonts: &[fontdue::Font]) {
        if self.with_doc(|doc, tree| doc.select_drag(tree, point, fonts)) {
            self.needs_paint = true;
        }
    }

    pub fn doc_select_up(&mut self) {
        self.doc.select_up();
    }

    pub fn doc_select_all(&mut self) -> bool {
        let selected = self.with_doc(|doc, tree| doc.select_all(tree));
        if selected {
            self.needs_paint = true;
        }
        selected
    }

    pub fn doc_collapse(&mut self) -> bool {
        let (had, changed) = self.with_doc(|doc, tree| doc.collapse(tree));
        if changed {
            self.needs_paint = true;
        }
        had
    }

    pub fn doc_extend(&mut self, left: bool, granularity: Granularity) -> bool {
        let moved = self.with_doc(|doc, tree| doc.extend(tree, left, granularity));
        if moved {
            self.needs_paint = true;
        }
        moved
    }

    pub fn doc_extend_edge(&mut self, up: bool) -> bool {
        let moved = self.with_doc(|doc, tree| doc.extend_edge(tree, up));
        if moved {
            self.needs_paint = true;
        }
        moved
    }

    pub fn doc_extend_vertical(&mut self, up: bool, fonts: &[fontdue::Font]) -> bool {
        let moved = self.with_doc(|doc, tree| doc.extend_vertical(tree, up, fonts));
        if moved {
            self.needs_paint = true;
        }
        moved
    }
}

impl DocLayout for Tree {
    fn paint_order(&self) -> &[NodeId] {
        &self.paint_order
    }

    fn is_text_leaf(&self, id: NodeId) -> bool {
        self.selectable_text_leaf(id)
    }

    fn text_of(&self, id: NodeId) -> Option<&str> {
        Tree::text_of(self, id)
    }

    fn text_geometry(&self, id: NodeId) -> Option<InputGeometry> {
        Tree::text_geometry(self, id)
    }

    fn abs_rect(&self, id: NodeId) -> Option<PxRect> {
        self.rect(id)
    }

    fn visible_rect(&self, id: NodeId) -> Option<PxRect> {
        Tree::visible_rect(self, id)
    }

    fn order_of(&self, id: NodeId) -> Option<u32> {
        Some(self.get(id)?.order)
    }

    fn unified_ancestor(&self, id: NodeId) -> Option<NodeId> {
        let mut current = Some(id);
        while let Some(cur) = current {
            let node = self.get(cur)?;
            if node.style.selection_mode == SelectionMode::Unified {
                return Some(cur);
            }
            current = node.parent;
        }
        None
    }

    fn selection_color_of(&self, id: NodeId) -> Option<Color> {
        Some(self.get(id)?.resolved.selection_color)
    }
}
#[cfg(test)]
mod tests;
