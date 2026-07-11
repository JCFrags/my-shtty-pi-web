use std::collections::{HashMap, HashSet};
use std::time::Instant;

use taffy::TaffyTree;
use taffy::prelude::TaffyMaxContent as _;

use crate::canvas::measure_text;
use crate::scroll::ScrollState;
use crate::selection::{
    ClickGesture, ClickTracker, DocPos, DocSelection, line_range_at, line_start, next_char,
    next_word_boundary, prev_char, prev_word_boundary, word_range_at,
};
use crate::style::{
    Align, Color, DEFAULT_SELECTION_COLOR, Dimension, FlexDirection, Justify, Overflow, Position,
    ScrollbarStyle, SelectionMode, Style,
};
use crate::text_input::{
    Granularity, InputGeometry, TextInput, line_height, offset_to_point, point_to_offset,
};
use crate::wrap::{line_of_offset, wrap_lines};

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

#[derive(Default)]
pub(crate) struct BarState {
    pub opacity: f32,
    pub expand: f32,
    pub last_move: Option<Instant>,
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

#[derive(Debug, Clone, Copy)]
pub struct ScrollbarRects {
    pub zone: PxRect,
    pub track: PxRect,
    pub thumb: PxRect,
}

struct Slot {
    generation: u32,
    node: Option<RNode>,
}

pub(crate) struct MeasureCtx {
    pub text: String,
    pub px: f32,
    pub font: usize,
    pub wrap: bool,
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
    doc_selection: Option<DocSelection>,
    doc_clicks: ClickTracker,
    doc_selecting: bool,
    doc_goal_x: Option<f32>,
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
            doc_selection: None,
            doc_clicks: ClickTracker::default(),
            doc_selecting: false,
            doc_goal_x: None,
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
        // Programmatic focus deliberately keeps the document selection, like
        // a browser: only a click into the input clears it (engine-side).
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

    /// Child moves are batched and pushed to taffy once per layout, so
    /// appending n children costs O(n) instead of O(n^2) syncs.
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
            if let Some(sel) = self.doc_selection
                && (sel.anchor.node == id || sel.focus.node == id)
            {
                self.doc_selection = None;
            }
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
            if let Some(sel) = self.doc_selection
                && (sel.anchor.node == id || sel.focus.node == id)
            {
                self.doc_selection = None;
            }
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

    pub(crate) fn bar_state(&self, id: NodeId) -> Option<(f32, f32, Option<Instant>, f32)> {
        let node = self.get(id)?;
        Some((
            node.bar.opacity,
            node.bar.expand,
            node.bar.last_move,
            node.scroll_max,
        ))
    }

    pub(crate) fn set_bar_state(
        &mut self,
        id: NodeId,
        opacity: f32,
        expand: f32,
        last_move: Option<Instant>,
    ) {
        if let Some(node) = self.get_mut(id) {
            node.bar.opacity = opacity;
            node.bar.expand = expand;
            node.bar.last_move = last_move;
        }
    }

    pub(crate) fn touch_bar(&mut self, id: NodeId) {
        if let Some(node) = self.get_mut(id) {
            node.bar.last_move = Some(Instant::now());
        }
    }

    /// Scroll offset ready to emit for a scroll-events node, or None when the
    /// node opted out or has not moved enough since the last emission.
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
                        |known, available, _node, context, _style| match context {
                            Some(ctx) => {
                                let font = &fonts[ctx.font.min(fonts.len() - 1)];
                                let line = font
                                    .horizontal_line_metrics(ctx.px)
                                    .map_or(ctx.px, |m| m.new_line_size);
                                let max_width = if ctx.wrap {
                                    match (known.width, available.width) {
                                        (Some(w), _) => Some(w),
                                        (None, taffy::AvailableSpace::Definite(w)) => Some(w),
                                        (None, taffy::AvailableSpace::MinContent) => Some(0.0),
                                        (None, taffy::AvailableSpace::MaxContent) => None,
                                    }
                                } else {
                                    None
                                };
                                let lines =
                                    crate::wrap::wrap_lines(&ctx.text, font, ctx.px, max_width);
                                let widest = lines
                                    .iter()
                                    .map(|r| {
                                        let visible = ctx.text[r.clone()].trim_end_matches(' ');
                                        measure_text(font, visible, ctx.px)
                                    })
                                    .fold(0.0f32, f32::max);
                                taffy::Size {
                                    // Ceil so taffy's whole-pixel rounding
                                    // never under-allocates the text width.
                                    width: widest.ceil(),
                                    height: line * lines.len() as f32,
                                }
                            }
                            None => taffy::Size::ZERO,
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
        let v = node.visible;
        if v.h <= bar.margin * 2.0 || v.w <= 0.0 {
            return None;
        }
        let width = bar.width + (bar.hover_width - bar.width) * node.bar.expand;
        let track = PxRect {
            x: v.x + v.w - width - bar.margin,
            y: v.y + bar.margin,
            w: width,
            h: v.h - 2.0 * bar.margin,
        };
        let viewport = node.abs.h;
        let content = node.scroll_max + viewport;
        let thumb_h = (track.h * viewport / content)
            .max(bar.min_thumb)
            .min(track.h);
        let range = track.h - thumb_h;
        let frac = (node.scroll.position / node.scroll_max).clamp(0.0, 1.0);
        let thumb = PxRect {
            x: track.x,
            y: track.y + frac * range,
            w: track.w,
            h: thumb_h,
        };
        let zone_w = bar.hover_width + 2.0 * bar.margin;
        let zone = PxRect {
            x: v.x + v.w - zone_w,
            y: v.y,
            w: zone_w,
            h: v.h,
        };
        Some(ScrollbarRects { zone, track, thumb })
    }

    pub fn scroll_pos_for_thumb(&self, id: NodeId, thumb_y: f32) -> Option<f32> {
        let rects = self.scrollbar_rects(id)?;
        let node = self.get(id)?;
        let range = rects.track.h - rects.thumb.h;
        if range <= 0.0 {
            return Some(0.0);
        }
        let frac = ((thumb_y - rects.track.y) / range).clamp(0.0, 1.0);
        Some(frac * node.scroll_max)
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

    fn doc_offset_at(&self, id: NodeId, point: (f32, f32), fonts: &[fontdue::Font]) -> usize {
        match (self.text_geometry(id), self.text_of(id)) {
            (Some(geometry), Some(text)) => geometry.offset_at(text, point, fonts),
            _ => 0,
        }
    }
    pub fn doc_pos_hit(&self, point: (f32, f32), fonts: &[fontdue::Font]) -> Option<DocPos> {
        let id = self.paint_order.iter().rev().copied().find(|&id| {
            self.selectable_text_leaf(id)
                && self
                    .get(id)
                    .is_some_and(|n| n.visible.contains(point.0, point.1))
        })?;
        Some(DocPos {
            node: id,
            offset: self.doc_offset_at(id, point, fonts),
        })
    }

    pub fn doc_pos_near(&self, point: (f32, f32), fonts: &[fontdue::Font]) -> Option<DocPos> {
        self.doc_pos_near_impl(point, fonts, true)
    }

    fn doc_pos_near_impl(
        &self,
        point: (f32, f32),
        fonts: &[fontdue::Font],
        clamp_to_ends: bool,
    ) -> Option<DocPos> {
        if let Some(pos) = self.doc_pos_hit(point, fonts) {
            return Some(pos);
        }
        let mut best: Option<(f32, f32, NodeId)> = None;
        for &id in &self.paint_order {
            if !self.selectable_text_leaf(id) {
                continue;
            }
            let v = self.node(id).visible;
            if v.w <= 0.0 || v.h <= 0.0 {
                continue;
            }
            let dy = (v.y - point.1).max(point.1 - (v.y + v.h)).max(0.0);
            let dx = (v.x - point.0).max(point.0 - (v.x + v.w)).max(0.0);
            let closer = best.is_none_or(|(by, bx, _)| dy < by || (dy == by && dx < bx));
            if closer {
                best = Some((dy, dx, id));
            }
        }
        let (_, _, id) = best?;
        let v = self.node(id).visible;
        let offset = if clamp_to_ends && point.1 >= v.y + v.h {
            self.text_of(id).map_or(0, str::len)
        } else if clamp_to_ends && point.1 < v.y {
            0
        } else {
            self.doc_offset_at(id, point, fonts)
        };
        Some(DocPos { node: id, offset })
    }

    pub fn doc_selection(&self) -> Option<DocSelection> {
        let sel = self.doc_selection?;
        let valid = |pos: DocPos| {
            self.get(pos.node)
                .and_then(|n| n.text.as_deref())
                .is_some_and(|t| pos.offset <= t.len())
        };
        (valid(sel.anchor) && valid(sel.focus)).then_some(sel)
    }

    fn doc_range(&self) -> Option<(DocPos, DocPos)> {
        let sel = self.doc_selection()?;
        if sel.is_collapsed() {
            return None;
        }
        let key = |pos: DocPos| (self.node(pos.node).order, pos.offset);
        Some(if key(sel.anchor) <= key(sel.focus) {
            (sel.anchor, sel.focus)
        } else {
            (sel.focus, sel.anchor)
        })
    }

    pub fn doc_selection_range(&self, id: NodeId) -> Option<std::ops::Range<usize>> {
        let (start, end) = self.doc_range()?;
        let node = self.get(id)?;
        let text = node.text.as_deref()?;
        let start_order = self.node(start.node).order;
        let end_order = self.node(end.node).order;
        if node.order < start_order || node.order > end_order {
            return None;
        }
        if id != start.node && id != end.node && !self.selectable_text_leaf(id) {
            return None;
        }
        let from = if id == start.node { start.offset } else { 0 };
        let to = if id == end.node {
            end.offset
        } else {
            text.len()
        };
        (from < to).then(|| from..to)
    }

    pub fn doc_selected_text(&self) -> Option<String> {
        self.doc_range()?;
        let mut out = String::new();
        let mut prev: Option<PxRect> = None;
        for &id in &self.paint_order {
            let Some(range) = self.doc_selection_range(id) else {
                continue;
            };
            let rect = self.node(id).abs;
            if let Some(prev) = prev {
                let same_row = rect.y < prev.y + prev.h && rect.y + rect.h > prev.y;
                if !same_row {
                    out.push('\n');
                }
            }
            let text = self.node(id).text.as_deref().unwrap_or_default();
            out.push_str(&text[range]);
            prev = Some(rect);
        }
        (!out.is_empty()).then_some(out)
    }

    pub fn doc_select_down(&mut self, point: (f32, f32), fonts: &[fontdue::Font]) -> bool {
        let Some(pos) = self.doc_pos_hit(point, fonts) else {
            return false;
        };
        let gesture = ClickGesture::from_count(self.doc_clicks.register(point, Instant::now()));
        let range = {
            let text = self.text_of(pos.node).unwrap_or_default();
            match gesture {
                ClickGesture::Place => None,
                ClickGesture::Word => word_range_at(text, pos.offset),
                ClickGesture::Line => Some(line_range_at(text, pos.offset)),
            }
        };
        self.doc_selection = Some(match range {
            Some(range) => DocSelection {
                anchor: DocPos {
                    node: pos.node,
                    offset: range.start,
                },
                focus: DocPos {
                    node: pos.node,
                    offset: range.end,
                },
            },
            None => DocSelection::collapsed(pos),
        });
        self.doc_selecting = gesture == ClickGesture::Place;
        self.doc_goal_x = None;
        self.needs_paint = true;
        true
    }

    pub fn doc_select_down_near(&mut self, point: (f32, f32), fonts: &[fontdue::Font]) -> bool {
        let Some(pos) = self.doc_pos_near(point, fonts) else {
            return false;
        };
        self.doc_clicks.register(point, Instant::now());
        self.doc_selection = Some(DocSelection::collapsed(pos));
        self.doc_selecting = true;
        self.doc_goal_x = None;
        self.needs_paint = true;
        true
    }

    pub fn doc_select_drag(&mut self, point: (f32, f32), fonts: &[fontdue::Font]) {
        if !self.doc_selecting {
            return;
        }
        let Some(pos) = self.doc_pos_near(point, fonts) else {
            return;
        };
        if let Some(sel) = &mut self.doc_selection
            && sel.focus != pos
        {
            sel.focus = pos;
            self.needs_paint = true;
        }
    }

    pub fn doc_select_up(&mut self) {
        self.doc_selecting = false;
    }

    pub fn doc_select_all(&mut self) -> bool {
        let leaves: Vec<NodeId> = self
            .paint_order
            .iter()
            .copied()
            .filter(|&id| self.selectable_text_leaf(id))
            .collect();
        let (Some(&first), Some(&last)) = (leaves.first(), leaves.last()) else {
            return false;
        };
        let end = self.text_of(last).map_or(0, str::len);
        self.doc_selection = Some(DocSelection {
            anchor: DocPos {
                node: first,
                offset: 0,
            },
            focus: DocPos {
                node: last,
                offset: end,
            },
        });
        self.doc_goal_x = None;
        self.needs_paint = true;
        true
    }

    pub fn doc_collapse(&mut self) -> bool {
        let had = self.doc_range().is_some();
        if self.doc_selection.take().is_some() {
            self.needs_paint = true;
        }
        self.doc_selecting = false;
        self.doc_goal_x = None;
        had
    }

    fn adjacent_leaf(&self, id: NodeId, forward: bool) -> Option<NodeId> {
        let at = self.paint_order.iter().position(|&n| n == id)?;
        if forward {
            self.paint_order[at + 1..]
                .iter()
                .copied()
                .find(|&n| self.selectable_text_leaf(n))
        } else {
            self.paint_order[..at]
                .iter()
                .rev()
                .copied()
                .find(|&n| self.selectable_text_leaf(n))
        }
    }

    pub fn doc_extend(&mut self, left: bool, granularity: Granularity) -> bool {
        let Some(sel) = self.doc_selection() else {
            return false;
        };
        let focus = sel.focus;
        let text = self.text_of(focus.node).unwrap_or_default();
        let target = if left {
            if focus.offset > 0 {
                let offset = match granularity {
                    Granularity::Char => prev_char(text, focus.offset),
                    Granularity::Word => prev_word_boundary(text, focus.offset),
                    Granularity::Line => line_start(text, focus.offset),
                };
                Some(DocPos {
                    node: focus.node,
                    offset,
                })
            } else if granularity == Granularity::Line {
                None
            } else {
                self.adjacent_leaf(focus.node, false).map(|node| {
                    let text = self.text_of(node).unwrap_or_default();
                    let offset = match granularity {
                        Granularity::Word => prev_word_boundary(text, text.len()),
                        _ => text.len(),
                    };
                    DocPos { node, offset }
                })
            }
        } else if focus.offset < text.len() {
            let offset = match granularity {
                Granularity::Char => next_char(text, focus.offset),
                Granularity::Word => next_word_boundary(text, focus.offset),
                Granularity::Line => crate::selection::line_end(text, focus.offset),
            };
            Some(DocPos {
                node: focus.node,
                offset,
            })
        } else if granularity == Granularity::Line {
            None
        } else {
            self.adjacent_leaf(focus.node, true).map(|node| {
                let text = self.text_of(node).unwrap_or_default();
                let offset = match granularity {
                    Granularity::Word => next_word_boundary(text, 0),
                    _ => 0,
                };
                DocPos { node, offset }
            })
        };
        let Some(target) = target else {
            return false;
        };
        if target == focus {
            return false;
        }
        if let Some(sel) = &mut self.doc_selection {
            sel.focus = target;
        }
        self.doc_goal_x = None;
        self.needs_paint = true;
        true
    }

    pub fn doc_extend_edge(&mut self, up: bool) -> bool {
        let Some(sel) = self.doc_selection() else {
            return false;
        };
        let edge = if up {
            self.paint_order
                .iter()
                .copied()
                .find(|&id| self.selectable_text_leaf(id))
                .map(|node| DocPos { node, offset: 0 })
        } else {
            self.paint_order
                .iter()
                .rev()
                .copied()
                .find(|&id| self.selectable_text_leaf(id))
                .map(|node| DocPos {
                    node,
                    offset: self.text_of(node).map_or(0, str::len),
                })
        };
        let Some(target) = edge else {
            return false;
        };
        if target == sel.focus {
            return false;
        }
        if let Some(sel) = &mut self.doc_selection {
            sel.focus = target;
        }
        self.doc_goal_x = None;
        self.needs_paint = true;
        true
    }

    pub fn doc_extend_vertical(&mut self, up: bool, fonts: &[fontdue::Font]) -> bool {
        let Some(sel) = self.doc_selection() else {
            return false;
        };
        let focus = sel.focus;
        let Some(geometry) = self.text_geometry(focus.node) else {
            return false;
        };
        let Some(text) = self.text_of(focus.node) else {
            return false;
        };
        let font = &fonts[geometry.font.min(fonts.len() - 1)];
        let px = geometry.px;
        let lines = wrap_lines(text, font, px, geometry.max_width);
        let line = line_of_offset(&lines, focus.offset);
        let line_h = line_height(font, px);
        let local_x = measure_text(font, &text[lines[line].start..focus.offset], px);
        let goal_x = self.doc_goal_x.unwrap_or(geometry.origin.0 + local_x);
        let within = if up { line > 0 } else { line + 1 < lines.len() };
        let target = if within {
            let target_line = if up { line - 1 } else { line + 1 };
            let y = (target_line as f32 + 0.5) * line_h;
            Some(DocPos {
                node: focus.node,
                offset: point_to_offset(
                    text,
                    goal_x - geometry.origin.0,
                    y,
                    font,
                    px,
                    geometry.max_width,
                ),
            })
        } else {
            let rect = self.node(focus.node).abs;
            let y = if up {
                rect.y - line_h * 0.5
            } else {
                rect.y + rect.h + line_h * 0.5
            };
            match self.doc_pos_near_impl((goal_x, y), fonts, false) {
                Some(pos) if pos.node != focus.node => Some(pos),
                _ => Some(DocPos {
                    node: focus.node,
                    offset: if up { 0 } else { text.len() },
                }),
            }
        };
        let Some(target) = target else {
            return false;
        };
        if target == focus {
            return false;
        }
        if let Some(sel) = &mut self.doc_selection {
            sel.focus = target;
        }
        self.doc_goal_x = Some(goal_x);
        self.needs_paint = true;
        true
    }

    fn caret_point(&self, pos: DocPos, fonts: &[fontdue::Font]) -> Option<(f32, f32, f32)> {
        let geometry = self.text_geometry(pos.node)?;
        let text = self.text_of(pos.node)?;
        let font = &fonts[geometry.font.min(fonts.len() - 1)];
        let (x, y) = offset_to_point(text, pos.offset, font, geometry.px, geometry.max_width);
        Some((
            geometry.origin.0 + x,
            geometry.origin.1 + y,
            line_height(font, geometry.px),
        ))
    }

    fn nearest_unified_ancestor(&self, id: NodeId) -> Option<NodeId> {
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

    pub fn doc_selection_blocks(
        &self,
        fonts: &[fontdue::Font],
    ) -> Vec<(NodeId, Vec<PxRect>, Color)> {
        let Some((start, end)) = self.doc_range() else {
            return Vec::new();
        };
        let mut groups: Vec<(NodeId, DocPos, DocPos)> = Vec::new();
        for &id in &self.paint_order {
            let Some(range) = self.doc_selection_range(id) else {
                continue;
            };
            let Some(container) = self.nearest_unified_ancestor(id) else {
                continue;
            };
            let last = DocPos {
                node: id,
                offset: range.end,
            };
            match groups.iter_mut().find(|(c, _, _)| *c == container) {
                Some((_, _, group_last)) => *group_last = last,
                None => groups.push((
                    container,
                    DocPos {
                        node: id,
                        offset: range.start,
                    },
                    last,
                )),
            }
        }
        groups
            .into_iter()
            .filter_map(|(container, first, last)| {
                let node = self.get(container)?;
                let rect = node.abs;
                let color = node.resolved.selection_color;
                let (cx1, y1, h1) = self.caret_point(first, fonts)?;
                let (cx2, y2, h2) = self.caret_point(last, fonts)?;
                let x1 = if first == start { cx1 } else { rect.x };
                let x2 = if last == end { cx2 } else { rect.x + rect.w };
                let mut bands = Vec::new();
                if (y1 - y2).abs() < 0.5 {
                    bands.push(PxRect {
                        x: x1,
                        y: y1,
                        w: (x2 - x1).max(1.0),
                        h: h1.max(h2),
                    });
                } else {
                    bands.push(PxRect {
                        x: x1,
                        y: y1,
                        w: (rect.x + rect.w - x1).max(0.0),
                        h: h1,
                    });
                    if y2 > y1 + h1 {
                        bands.push(PxRect {
                            x: rect.x,
                            y: y1 + h1,
                            w: rect.w,
                            h: y2 - (y1 + h1),
                        });
                    }
                    bands.push(PxRect {
                        x: rect.x,
                        y: y2,
                        w: (x2 - rect.x).max(0.0),
                        h: h2,
                    });
                }
                Some((container, bands, color))
            })
            .collect()
    }
}

fn to_taffy(style: &Style, hidden: bool) -> taffy::Style {
    use taffy::prelude::{auto, length, percent};

    fn dimension(d: Dimension) -> taffy::Dimension {
        match d {
            Dimension::Auto => auto(),
            Dimension::Px(v) => length(v),
            Dimension::Percent(f) => percent(f),
        }
    }

    fn inset_edge(v: Option<f32>) -> taffy::LengthPercentageAuto {
        v.map_or(auto(), length)
    }

    let overflow = match style.overflow {
        Overflow::Visible => taffy::Overflow::Visible,
        Overflow::Hidden => taffy::Overflow::Hidden,
        Overflow::Scroll => taffy::Overflow::Scroll,
    };

    taffy::Style {
        display: if hidden {
            taffy::Display::None
        } else {
            taffy::Display::Flex
        },
        position: match style.position {
            Position::Flow => taffy::Position::Relative,
            Position::Absolute => taffy::Position::Absolute,
        },
        inset: taffy::Rect {
            left: inset_edge(style.inset.left),
            right: inset_edge(style.inset.right),
            top: inset_edge(style.inset.top),
            bottom: inset_edge(style.inset.bottom),
        },
        overflow: taffy::Point {
            x: overflow,
            y: overflow,
        },
        flex_direction: match style.flex_direction {
            FlexDirection::Row => taffy::FlexDirection::Row,
            FlexDirection::Column => taffy::FlexDirection::Column,
        },
        flex_grow: style.flex_grow,
        flex_shrink: style.flex_shrink,
        flex_basis: dimension(style.flex_basis),
        size: taffy::Size {
            width: dimension(style.width),
            height: dimension(style.height),
        },
        padding: taffy::Rect {
            left: length(style.padding.left),
            right: length(style.padding.right),
            top: length(style.padding.top),
            bottom: length(style.padding.bottom),
        },
        margin: taffy::Rect {
            left: length(style.margin.left),
            right: length(style.margin.right),
            top: length(style.margin.top),
            bottom: length(style.margin.bottom),
        },
        gap: taffy::Size {
            width: length(style.gap),
            height: length(style.gap),
        },
        justify_content: style.justify_content.map(|j| match j {
            Justify::Start => taffy::JustifyContent::Start,
            Justify::Center => taffy::JustifyContent::Center,
            Justify::End => taffy::JustifyContent::End,
            Justify::SpaceBetween => taffy::JustifyContent::SpaceBetween,
        }),
        align_items: style.align_items.map(|a| match a {
            Align::Start => taffy::AlignItems::Start,
            Align::Center => taffy::AlignItems::Center,
            Align::End => taffy::AlignItems::End,
            Align::Stretch => taffy::AlignItems::Stretch,
        }),
        ..taffy::Style::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas::Canvas;
    use crate::desc::Desc;
    use crate::paint::paint;
    use crate::style::Edges;

    static FONT_BYTES: &[u8] =
        include_bytes!("../../../examples/typing/assets/JetBrainsMono-Regular.ttf");

    fn font() -> fontdue::Font {
        fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default()).unwrap()
    }

    fn tree_of(window: (f32, f32), children: Vec<Desc>) -> Tree {
        let mut tree = Tree::new(window);
        tree.reconcile(Desc {
            children,
            ..Desc::default()
        });
        tree.flush_layout(&[font()], 16.0);
        tree
    }

    fn painted(tree: &mut Tree, window: (u32, u32), cursor: Option<(f32, f32)>) -> Canvas {
        let mut canvas = Canvas::new(window.0, window.1);
        tree.flush_layout(&[font()], 16.0);
        paint(tree, &mut canvas, &[font()], cursor);
        canvas
    }

    fn pixel(canvas: &Canvas, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * canvas.width + x) * 4) as usize;
        canvas.pixels[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn hit_click_prefers_the_topmost_clickable_and_falls_back_to_ancestors() {
        let tree = tree_of(
            (200.0, 100.0),
            vec![Desc {
                style: Style {
                    width: Dimension::Px(200.0),
                    height: Dimension::Px(100.0),
                    padding: Edges::all(10.0),
                    ..Style::default()
                },
                key: Some("outer".into()),
                clickable: true,
                children: vec![Desc {
                    style: Style {
                        width: Dimension::Px(50.0),
                        height: Dimension::Px(50.0),
                        ..Style::default()
                    },
                    key: Some("inner".into()),
                    clickable: true,
                    ..Desc::default()
                }],
                ..Desc::default()
            }],
        );
        let hit = tree.hit_click(15.0, 15.0).unwrap();
        assert_eq!(tree.key_of(hit), Some("inner"));
        let hit = tree.hit_click(150.0, 50.0).unwrap();
        assert_eq!(tree.key_of(hit), Some("outer"));
        assert!(tree.hit_click(500.0, 500.0).is_none());
    }

    #[test]
    fn exposes_rects_by_key_and_paints_background() {
        let mut tree = tree_of(
            (100.0, 40.0),
            vec![Desc {
                style: Style {
                    width: Dimension::Px(100.0),
                    height: Dimension::Px(40.0),
                    background: Some([10, 20, 30, 255]),
                    ..Style::default()
                },
                key: Some("panel".into()),
                ..Desc::default()
            }],
        );
        let rect = tree.rect(tree.find("panel").unwrap()).unwrap();
        assert_eq!((rect.w, rect.h), (100.0, 40.0));
        assert!(tree.find("missing").is_none());
        let canvas = painted(&mut tree, (100, 40), None);
        assert_eq!(pixel(&canvas, 12, 0), [10, 20, 30, 255]);
    }

    #[test]
    fn hover_swaps_background_under_cursor() {
        let block = || Desc {
            style: Style {
                width: Dimension::Px(10.0),
                height: Dimension::Px(10.0),
                background: Some([1, 1, 1, 255]),
                hover_background: Some([9, 9, 9, 255]),
                ..Style::default()
            },
            ..Desc::default()
        };
        let mut tree = tree_of((10.0, 10.0), vec![block()]);
        let canvas = painted(&mut tree, (10, 10), Some((5.0, 5.0)));
        assert_eq!(pixel(&canvas, 0, 0), [9, 9, 9, 255]);
        assert!(tree.hover_at(5.0, 5.0).is_some());
        assert!(tree.hover_at(50.0, 50.0).is_none());

        let canvas = painted(&mut tree, (10, 10), Some((50.0, 50.0)));
        assert_eq!(pixel(&canvas, 0, 0), [1, 1, 1, 255]);
    }

    fn scroller(clickable_second: bool) -> Vec<Desc> {
        let block = |color: Color, clickable: bool, key: &str| Desc {
            style: Style {
                width: Dimension::Px(40.0),
                height: Dimension::Px(40.0),
                flex_shrink: 0.0,
                background: Some(color),
                ..Style::default()
            },
            key: Some(key.into()),
            clickable,
            ..Desc::default()
        };
        vec![Desc {
            style: Style {
                flex_direction: FlexDirection::Column,
                width: Dimension::Px(40.0),
                height: Dimension::Px(40.0),
                overflow: Overflow::Scroll,
                ..Style::default()
            },
            key: Some("scroller".into()),
            children: vec![
                block([10, 0, 0, 255], false, "red"),
                block([0, 20, 0, 255], clickable_second, "green"),
            ],
            ..Desc::default()
        }]
    }

    #[test]
    fn scroll_area_reports_overflowing_content() {
        let tree = tree_of((40.0, 40.0), scroller(false));
        let id = tree.find("scroller").unwrap();
        let area = tree.scroll_area(id).unwrap();
        assert_eq!(area.content_height, 80.0);
        assert_eq!(area.max_scroll(), 40.0);
        assert!(tree.scroll_area_at(5.0, 5.0).is_some());
        assert!(tree.scroll_area_at(100.0, 5.0).is_none());
    }

    #[test]
    fn scroll_offset_shifts_children_and_clips_painting() {
        let mut tree = tree_of((40.0, 60.0), scroller(false));
        let id = tree.find("scroller").unwrap();
        tree.scroll_state_mut(id).unwrap().position = 10.0;
        tree.mark_place();
        let canvas = painted(&mut tree, (40, 60), None);
        // Offset 10 scrolls the red/green boundary from y=40 up to y=30.
        assert_eq!(pixel(&canvas, 0, 29), [10, 0, 0, 255]);
        assert_eq!(pixel(&canvas, 0, 30), [0, 20, 0, 255]);
        // The viewport ends at y=40; the green block must not paint below it.
        assert_eq!(pixel(&canvas, 0, 40), [0, 0, 0, 0]);
    }

    #[test]
    fn scrolled_out_children_do_not_take_clicks() {
        let tree = tree_of((40.0, 40.0), scroller(true));
        assert!(
            tree.hit_click(5.0, 35.0).is_none(),
            "second block starts below the viewport"
        );

        let mut tree = tree_of((40.0, 40.0), scroller(true));
        let id = tree.find("scroller").unwrap();
        tree.scroll_state_mut(id).unwrap().position = 40.0;
        tree.mark_place();
        tree.flush_layout(&[font()], 16.0);
        let hit = tree.hit_click(5.0, 35.0).unwrap();
        assert_eq!(
            tree.key_of(hit),
            Some("green"),
            "fully scrolled, second block fills the viewport"
        );
    }

    #[test]
    fn absolute_nodes_place_by_inset_and_sit_on_top() {
        let mut tree = tree_of(
            (100.0, 100.0),
            vec![
                Desc {
                    style: Style {
                        width: Dimension::Px(100.0),
                        height: Dimension::Px(100.0),
                        ..Style::default()
                    },
                    key: Some("under".into()),
                    clickable: true,
                    ..Desc::default()
                },
                Desc {
                    style: Style {
                        position: Position::Absolute,
                        inset: crate::style::Inset::top_left(30.0, 40.0),
                        width: Dimension::Px(20.0),
                        height: Dimension::Px(10.0),
                        background: Some([9, 9, 9, 255]),
                        ..Style::default()
                    },
                    key: Some("float".into()),
                    clickable: true,
                    ..Desc::default()
                },
            ],
        );
        let rect = tree.rect(tree.find("float").unwrap()).unwrap();
        assert_eq!((rect.x, rect.y, rect.w, rect.h), (30.0, 40.0, 20.0, 10.0));
        let canvas = painted(&mut tree, (100, 100), None);
        assert_eq!(
            pixel(&canvas, 35, 45),
            [9, 9, 9, 255],
            "floating node paints over the sibling that fills the window"
        );
        assert_eq!(
            tree.key_of(tree.hit_click(35.0, 45.0).unwrap()),
            Some("float")
        );
        assert_eq!(
            tree.key_of(tree.hit_click(5.0, 5.0).unwrap()),
            Some("under")
        );
    }

    fn editor(initial: &str) -> Vec<Desc> {
        vec![Desc {
            style: Style {
                width: Dimension::Px(200.0),
                height: Dimension::Px(60.0),
                ..Style::default()
            },
            children: vec![Desc {
                style: Style {
                    padding: Edges::all(4.0),
                    ..Style::default()
                },
                key: Some("in".into()),
                input: Some(InputProps {
                    initial: initial.into(),
                    caret_color: [255, 0, 0, 255],
                    selection_color: [0, 255, 0, 255],
                    ..InputProps::default()
                }),
                ..Desc::default()
            }],
            ..Desc::default()
        }]
    }

    #[test]
    fn input_nodes_paint_caret_and_selection_and_expose_geometry() {
        let mut tree = tree_of((200.0, 60.0), editor("hello"));
        let id = tree.find("in").unwrap();
        tree.set_focus(Some(id));
        tree.input_mut(id).unwrap().set_cursor(2, false);
        tree.mark_paint();

        let geometry = tree.input_geometry(id).unwrap();
        assert_eq!(geometry.origin, (4.0, 4.0), "origin is inside the padding");
        let fonts = [font()];
        let caret = geometry.caret_rect("hello", 2, &fonts);
        let canvas = painted(&mut tree, (200, 60), None);
        let center = (
            (caret.x + caret.w / 2.0) as u32,
            (caret.y + caret.h / 2.0) as u32,
        );
        let [r, g, b, _] = pixel(&canvas, center.0, center.1);
        assert_eq!([r, g, b], [255, 0, 0], "caret painted");
        assert_eq!(
            geometry.offset_at("hello", (caret.x + 0.1, caret.y + 1.0), &fonts),
            2,
            "geometry maps points back to offsets"
        );

        tree.input_mut(id).unwrap().set_cursor(4, true);
        tree.mark_paint();
        let canvas = painted(&mut tree, (200, 60), None);
        let selected = geometry.caret_rect("hello", 3, &fonts);
        let [r, g, b, _] = pixel(&canvas, selected.x as u32 + 1, selected.y as u32 + 1);
        assert_eq!(
            [r, g, b],
            [0, 255, 0],
            "selection painted behind the glyphs"
        );
        let [r, g, b, _] = pixel(&canvas, (caret.x + caret.w / 2.0) as u32, center.1);
        assert_eq!(
            [r, g, b],
            [0, 255, 0],
            "no caret while a selection is active"
        );
    }

    #[test]
    fn input_submit_prop_tracks_updates() {
        let mut tree = tree_of((200.0, 60.0), editor("hello"));
        let id = tree.find("in").unwrap();
        assert!(!tree.get(id).unwrap().input.as_ref().unwrap().submit);

        let mut children = editor("hello");
        children[0].children[0].input.as_mut().unwrap().submit = true;
        tree.reconcile(Desc {
            children,
            ..Desc::default()
        });
        let id = tree.find("in").unwrap();
        assert!(tree.get(id).unwrap().input.as_ref().unwrap().submit);
    }

    #[test]
    fn caret_only_paints_on_the_focused_input() {
        let mut tree = tree_of((200.0, 60.0), editor("hello"));
        let id = tree.find("in").unwrap();
        tree.input_mut(id).unwrap().set_cursor(2, false);
        tree.mark_paint();
        let geometry = tree.input_geometry(id).unwrap();
        let caret = geometry.caret_rect("hello", 2, &[font()]);
        let canvas = painted(&mut tree, (200, 60), None);
        let [r, g, b, _] = pixel(
            &canvas,
            (caret.x + caret.w / 2.0) as u32,
            (caret.y + caret.h / 2.0) as u32,
        );
        assert_ne!([r, g, b], [255, 0, 0], "no caret without focus");
    }

    #[test]
    fn scroll_reveal_targets_the_nearest_edge() {
        let tree = tree_of((40.0, 40.0), scroller(false));
        let area = ScrollArea {
            node: tree.find("scroller").unwrap(),
            rect: PxRect {
                x: 0.0,
                y: 100.0,
                w: 100.0,
                h: 50.0,
            },
            content_height: 500.0,
            offset: 20.0,
        };
        let rect = |y: f32| PxRect {
            x: 0.0,
            y,
            w: 2.0,
            h: 10.0,
        };
        assert_eq!(area.target_to_reveal(rect(90.0), 20.0, 0.0), Some(10.0));
        assert_eq!(area.target_to_reveal(rect(110.0), 20.0, 0.0), None);
        assert_eq!(area.target_to_reveal(rect(160.0), 20.0, 0.0), Some(40.0));
        assert_eq!(area.target_to_reveal(rect(110.0), 20.0, 15.0), Some(15.0));
    }

    #[test]
    fn text_leaves_size_the_layout() {
        let tree = tree_of(
            (400.0, 100.0),
            vec![Desc {
                key: Some("label".into()),
                text: Some("hello".into()),
                ..Desc::default()
            }],
        );
        let label = tree.rect(tree.find("label").unwrap()).unwrap();
        assert!(label.w > 0.0 && label.h > 0.0);
    }

    #[test]
    fn updating_text_relayouts_the_leaf() {
        let mut tree = tree_of(
            (400.0, 100.0),
            vec![Desc {
                key: Some("label".into()),
                text: Some("hi".into()),
                ..Desc::default()
            }],
        );
        let id = tree.find("label").unwrap();
        let before = tree.rect(id).unwrap();
        tree.reconcile(Desc {
            children: vec![Desc {
                key: Some("label".into()),
                text: Some("hello there, much longer".into()),
                ..Desc::default()
            }],
            ..Desc::default()
        });
        tree.flush_layout(&[font()], 16.0);
        let after = tree.rect(id).unwrap();
        assert!(after.w > before.w, "{} > {}", after.w, before.w);
    }

    #[test]
    fn reconcile_reuses_keyed_nodes_and_preserves_input_state() {
        let item = |key: &str| Desc {
            key: Some(key.into()),
            input: Some(InputProps {
                initial: format!("initial-{key}"),
                ..InputProps::default()
            }),
            ..Desc::default()
        };
        let mut tree = tree_of((400.0, 100.0), vec![item("a"), item("b")]);
        let a = tree.find("a").unwrap();
        tree.input_mut(a).unwrap().insert(" typed");
        tree.sync_input_text(a);

        // Reorder: b first. The keyed node must survive with its edits.
        tree.reconcile(Desc {
            children: vec![item("b"), item("a")],
            ..Desc::default()
        });
        assert_eq!(tree.find("a"), Some(a), "node reused, not recreated");
        assert_eq!(tree.input_text(a), Some("initial-a typed"));
        let root = tree.root();
        assert_eq!(tree.children(root).len(), 2);
        assert_eq!(tree.key_of(tree.children(root)[0]), Some("b"));
    }

    #[test]
    fn reconcile_drops_nodes_missing_from_the_description() {
        let label = |key: &str| Desc {
            key: Some(key.into()),
            text: Some(key.into()),
            ..Desc::default()
        };
        let mut tree = tree_of((400.0, 100.0), vec![label("a"), label("b"), label("c")]);
        let b = tree.find("b").unwrap();
        tree.reconcile(Desc {
            children: vec![label("a"), label("c")],
            ..Desc::default()
        });
        assert!(tree.find("b").is_none());
        assert!(!tree.contains(b), "stale ids are dead");
        assert_eq!(tree.children(tree.root()).len(), 2);
    }

    #[test]
    fn removed_ids_stay_dead_after_slot_reuse() {
        let mut tree = Tree::new((100.0, 100.0));
        let a = tree.create(Props::default());
        tree.append(tree.root(), a);
        tree.remove(a);
        let b = tree.create(Props::default());
        tree.append(tree.root(), b);
        assert!(!tree.contains(a), "generation bump kills the old id");
        assert!(tree.contains(b));
    }

    #[test]
    fn queries_between_removal_and_flush_skip_dead_ids() {
        let mut tree = tree_of(
            (100.0, 100.0),
            vec![Desc {
                style: Style {
                    width: Dimension::Px(100.0),
                    height: Dimension::Px(100.0),
                    overflow: Overflow::Scroll,
                    ..Style::default()
                },
                key: Some("gone".into()),
                clickable: true,
                ..Desc::default()
            }],
        );
        tree.reconcile(Desc::default());
        // No flush yet: the paint lists still hold the removed id.
        assert!(tree.hit_click(50.0, 50.0).is_none());
        assert!(tree.hover_at(50.0, 50.0).is_none());
        assert!(tree.hit_target(50.0, 50.0).is_none());
        assert!(tree.scroll_area_at(50.0, 50.0).is_none());
    }

    #[test]
    fn overlays_occlude_inputs_from_clicks() {
        let mut children = editor("hello");
        children[0].style.overflow = Overflow::Scroll;
        children.push(Desc {
            style: Style {
                position: Position::Absolute,
                inset: crate::style::Inset::top_left(10.0, 10.0),
                width: Dimension::Px(40.0),
                height: Dimension::Px(20.0),
                ..Style::default()
            },
            key: Some("overlay".into()),
            clickable: true,
            ..Desc::default()
        });
        let tree = tree_of((200.0, 60.0), children);
        let overlay = tree.find("overlay").unwrap();
        let input = tree.find("in").unwrap();
        assert_eq!(tree.hit_target(15.0, 15.0), Some(HitTarget::Click(overlay)));
        assert_eq!(tree.hit_target(8.0, 8.0), Some(HitTarget::Input(input)));
        // Past the text but inside the scroll viewport: still the input.
        assert_eq!(tree.hit_target(150.0, 50.0), Some(HitTarget::Input(input)));
    }

    #[test]
    fn dropping_input_props_clears_focus() {
        let mut tree = tree_of((200.0, 60.0), editor("hello"));
        let id = tree.find("in").unwrap();
        tree.set_focus(Some(id));
        assert_eq!(tree.focus(), Some(id));
        tree.update(
            id,
            Props {
                key: Some("in".into()),
                text: Some("plain".into()),
                ..Props::default()
            },
        );
        assert_eq!(tree.focus(), None, "focus cannot point at a non-input");
    }

    #[test]
    fn shrinking_content_clamps_the_scroll_position() {
        let mut tree = tree_of((40.0, 40.0), scroller(false));
        let id = tree.find("scroller").unwrap();
        let state = tree.scroll_state_mut(id).unwrap();
        state.position = 40.0;
        state.set_target(40.0);
        tree.mark_place();
        tree.flush_layout(&[font()], 16.0);
        assert_eq!(tree.scroll_state(id).unwrap().position, 40.0);

        // Drop the second block: content now fits, so scroll snaps to 0.
        let mut desc = scroller(false);
        desc[0].children.truncate(1);
        tree.reconcile(Desc {
            children: desc,
            ..Desc::default()
        });
        tree.flush_layout(&[font()], 16.0);
        let state = tree.scroll_state(id).unwrap();
        assert_eq!(state.position, 0.0);
        assert_eq!(state.target, 0.0);
    }

    #[test]
    fn hidden_nodes_zero_their_rects() {
        let mut tree = tree_of(
            (100.0, 100.0),
            vec![Desc {
                style: Style {
                    width: Dimension::Px(50.0),
                    height: Dimension::Px(50.0),
                    ..Style::default()
                },
                key: Some("panel".into()),
                ..Desc::default()
            }],
        );
        let id = tree.find("panel").unwrap();
        assert_eq!(tree.rect(id).unwrap().w, 50.0);
        let mut props = Props {
            key: Some("panel".into()),
            hidden: true,
            ..Props::default()
        };
        props.style.width = Dimension::Px(50.0);
        props.style.height = Dimension::Px(50.0);
        tree.update(id, props);
        tree.flush_layout(&[font()], 16.0);
        assert_eq!(tree.rect(id), Some(PxRect::ZERO));
    }

    #[test]
    fn content_height_overrides_measured_scroll_range() {
        let mut tree = tree_of(
            (100.0, 200.0),
            vec![Desc {
                style: Style {
                    width: Dimension::Px(100.0),
                    height: Dimension::Px(200.0),
                    overflow: Overflow::Scroll,
                    ..Style::default()
                },
                key: Some("virtual".into()),
                content_height: Some(800.0),
                children: vec![Desc {
                    style: Style {
                        height: Dimension::Px(30.0),
                        flex_shrink: 0.0,
                        ..Style::default()
                    },
                    ..Desc::default()
                }],
                ..Desc::default()
            }],
        );
        let id = tree.find("virtual").unwrap();
        assert_eq!(
            tree.scroll_max(id),
            600.0,
            "virtual height wins over measured"
        );

        let rects = tree.scrollbar_rects(id).unwrap();
        let expected_thumb = rects.track.h * 200.0 / 800.0;
        assert!(
            (rects.thumb.h - expected_thumb).abs() < 0.5,
            "thumb is viewport/content of the track: {} vs {expected_thumb}",
            rects.thumb.h
        );
        assert_eq!(
            rects.thumb.y, rects.track.y,
            "unscrolled thumb sits at the top"
        );

        tree.scroll_state_mut(id).unwrap().position = 600.0;
        let rects = tree.scrollbar_rects(id).unwrap();
        assert!(
            (rects.thumb.y + rects.thumb.h - (rects.track.y + rects.track.h)).abs() < 0.5,
            "fully scrolled thumb reaches the bottom"
        );
        assert_eq!(
            tree.scroll_pos_for_thumb(id, rects.track.y).unwrap(),
            0.0,
            "thumb position maps back to scroll offsets"
        );
    }

    #[test]
    fn scrollbar_rects_absent_without_overflow() {
        let tree = tree_of(
            (100.0, 200.0),
            vec![Desc {
                style: Style {
                    width: Dimension::Px(100.0),
                    height: Dimension::Px(200.0),
                    overflow: Overflow::Scroll,
                    ..Style::default()
                },
                key: Some("fits".into()),
                children: vec![Desc {
                    style: Style {
                        height: Dimension::Px(30.0),
                        flex_shrink: 0.0,
                        ..Style::default()
                    },
                    ..Desc::default()
                }],
                ..Desc::default()
            }],
        );
        let id = tree.find("fits").unwrap();
        assert!(tree.scrollbar_rects(id).is_none(), "no overflow, no bar");
    }

    #[test]
    fn wrapped_text_grows_taller_as_width_shrinks() {
        let label = |width: f32| {
            vec![Desc {
                style: Style {
                    width: Dimension::Px(width),
                    align_items: Some(Align::Start),
                    ..Style::default()
                },
                children: vec![Desc {
                    key: Some("p".into()),
                    text: Some("several words that will need to wrap around".into()),
                    ..Desc::default()
                }],
                ..Desc::default()
            }]
        };
        let wide = tree_of((400.0, 400.0), label(380.0));
        let narrow = tree_of((400.0, 400.0), label(120.0));
        let wide_h = wide.rect(wide.find("p").unwrap()).unwrap().h;
        let narrow_h = narrow.rect(narrow.find("p").unwrap()).unwrap().h;
        assert!(
            narrow_h >= wide_h * 2.0 - 0.5,
            "narrow wraps to more lines: {narrow_h} vs {wide_h}"
        );

        let mut nowrap = label(120.0);
        nowrap[0].children[0].style.wrap = false;
        let pre = tree_of((400.0, 400.0), nowrap);
        let pre_h = pre.rect(pre.find("p").unwrap()).unwrap().h;
        assert!(
            pre_h < wide_h,
            "wrap: false keeps one logical line: {pre_h} vs {wide_h}"
        );
    }

    #[test]
    fn soft_wrapped_input_maps_offsets_through_wrap_boundaries() {
        let mut editor = editor("alpha beta gamma delta epsilon zeta");
        editor[0].style.width = Dimension::Px(120.0);
        editor[0].children[0].style.width = Dimension::Px(120.0);
        let tree = tree_of((400.0, 300.0), editor);
        let id = tree.find("in").unwrap();
        let geometry = tree.input_geometry(id).unwrap();
        let width = geometry.max_width.expect("wrapping on by default");
        assert!(width <= 120.0);

        let fonts = [font()];
        let text = "alpha beta gamma delta epsilon zeta";
        let last = geometry.caret_rect(text, text.len(), &fonts);
        let first = geometry.caret_rect(text, 0, &fonts);
        assert!(
            last.y > first.y,
            "caret wraps to later visual lines: {} > {}",
            last.y,
            first.y
        );
        let round_trip = geometry.offset_at(text, (last.x + 0.1, last.y + 1.0), &fonts);
        assert_eq!(round_trip, text.len(), "click maps back through the wrap");
    }

    #[test]
    fn flex_basis_zero_keeps_siblings_stable_as_text_grows() {
        let build = |text: &str, basis: Dimension| {
            vec![
                Desc {
                    style: Style {
                        width: Dimension::Px(200.0),
                        ..Style::default()
                    },
                    key: Some("side".into()),
                    ..Desc::default()
                },
                Desc {
                    style: Style {
                        flex_grow: 1.0,
                        flex_basis: basis,
                        overflow: Overflow::Hidden,
                        ..Style::default()
                    },
                    children: vec![Desc {
                        text: Some(text.into()),
                        ..Desc::default()
                    }],
                    ..Desc::default()
                },
            ]
        };
        let long = "no spaces here just one enormous line of text ".repeat(40);

        let tree = tree_of((800.0, 200.0), build(&long, Dimension::Px(0.0)));
        let side = tree.rect(tree.find("side").unwrap()).unwrap();
        assert_eq!(side.w, 200.0, "flex: 1 sibling never squeezes the sidebar");

        let tree = tree_of((800.0, 200.0), build(&long, Dimension::Auto));
        let side = tree.rect(tree.find("side").unwrap()).unwrap();
        assert!(
            side.w < 200.0,
            "basis auto grows with content and squeezes: {}",
            side.w
        );
    }

    fn label_items(a: &str, b: &str) -> Vec<Desc> {
        vec![
            Desc {
                key: Some("a".into()),
                text: Some(a.into()),
                ..Desc::default()
            },
            Desc {
                key: Some("b".into()),
                text: Some(b.into()),
                ..Desc::default()
            },
        ]
    }

    fn labels(a: &str, b: &str) -> Vec<Desc> {
        vec![Desc {
            style: Style {
                flex_direction: FlexDirection::Column,
                align_items: Some(Align::Start),
                ..Style::default()
            },
            children: label_items(a, b),
            ..Desc::default()
        }]
    }

    fn point_at(tree: &Tree, id: NodeId, offset: usize, fonts: &[fontdue::Font]) -> (f32, f32) {
        let geometry = tree.text_geometry(id).unwrap();
        let text = tree.text_of(id).unwrap();
        let rect = geometry.caret_rect(text, offset, fonts);
        (rect.x + 0.1, rect.y + 1.0)
    }

    #[test]
    fn doc_selection_spans_text_nodes() {
        let fonts = [font()];
        let mut tree = tree_of((400.0, 200.0), labels("first line", "second line"));
        let a = tree.find("a").unwrap();
        let b = tree.find("b").unwrap();
        assert!(tree.doc_select_down(point_at(&tree, a, 6, &fonts), &fonts));
        tree.doc_select_drag(point_at(&tree, b, 6, &fonts), &fonts);
        tree.doc_select_up();
        assert_eq!(tree.doc_selection_range(a), Some(6..10));
        assert_eq!(tree.doc_selection_range(b), Some(0..6));
        assert_eq!(tree.doc_selected_text().as_deref(), Some("line\nsecond"));
    }

    #[test]
    fn backwards_drags_normalize_by_document_order() {
        let fonts = [font()];
        let mut tree = tree_of((400.0, 200.0), labels("first line", "second line"));
        let a = tree.find("a").unwrap();
        let b = tree.find("b").unwrap();
        assert!(tree.doc_select_down(point_at(&tree, b, 6, &fonts), &fonts));
        tree.doc_select_drag(point_at(&tree, a, 6, &fonts), &fonts);
        assert_eq!(tree.doc_selection_range(a), Some(6..10));
        assert_eq!(tree.doc_selection_range(b), Some(0..6));
    }

    #[test]
    fn chained_clicks_on_text_select_word_then_line() {
        let fonts = [font()];
        let mut tree = tree_of((400.0, 200.0), labels("foo bar baz", "x"));
        let a = tree.find("a").unwrap();
        let point = point_at(&tree, a, 5, &fonts);
        assert!(tree.doc_select_down(point, &fonts));
        assert_eq!(tree.doc_selection_range(a), None, "single click places");
        tree.doc_select_down(point, &fonts);
        assert_eq!(tree.doc_selected_text().as_deref(), Some("bar"));
        tree.doc_select_down(point, &fonts);
        assert_eq!(tree.doc_selected_text().as_deref(), Some("foo bar baz"));
    }

    #[test]
    fn clickable_and_optout_subtrees_are_not_selectable() {
        let mut children = label_items("copy me", "label");
        children[1] = Desc {
            key: Some("button".into()),
            clickable: true,
            children: vec![Desc {
                key: Some("b".into()),
                text: Some("label".into()),
                ..Desc::default()
            }],
            ..Desc::default()
        };
        children.push(Desc {
            style: Style {
                selectable: Some(false),
                ..Style::default()
            },
            children: vec![Desc {
                key: Some("c".into()),
                text: Some("locked".into()),
                ..Desc::default()
            }],
            ..Desc::default()
        });
        let mut tree = tree_of((400.0, 200.0), children);
        let fonts = [font()];
        let a = tree.find("a").unwrap();
        let b = tree.find("b").unwrap();
        let c = tree.find("c").unwrap();
        let at = |tree: &Tree, id| point_at(tree, id, 1, &fonts);
        let p = at(&tree, a);
        assert_eq!(tree.hit_target(p.0, p.1), Some(HitTarget::Text(a)));
        let button = tree.find("button").unwrap();
        let p = at(&tree, b);
        assert_eq!(
            tree.hit_target(p.0, p.1),
            Some(HitTarget::Click(button)),
            "the clickable ancestor still owns the click"
        );
        assert!(
            tree.doc_select_down(p, &fonts),
            "but its label still takes a selection gesture"
        );
        let p = at(&tree, c);
        assert_eq!(
            tree.hit_target(p.0, p.1),
            None,
            "selectable: false opts the subtree out"
        );
        assert!(!tree.doc_select_down(p, &fonts));
    }

    #[test]
    fn doc_selection_paints_with_the_inherited_color() {
        let children = vec![Desc {
            style: Style {
                selection_color: Some([0, 255, 0, 255]),
                ..Style::default()
            },
            key: Some("p".into()),
            text: Some("hello".into()),
            ..Desc::default()
        }];
        let mut tree = tree_of((200.0, 60.0), children);
        assert!(tree.doc_select_all());
        let id = tree.find("p").unwrap();
        assert_eq!(tree.doc_selection_range(id), Some(0..5));
        let fonts = [font()];
        let rect = tree
            .text_geometry(id)
            .unwrap()
            .caret_rect("hello", 1, &fonts);
        let canvas = painted(&mut tree, (200, 60), None);
        let [r, g, b, _] = pixel(&canvas, rect.x as u32 + 1, rect.y as u32 + 1);
        assert_eq!([r, g, b], [0, 255, 0], "selection painted behind glyphs");
    }

    #[test]
    fn structural_changes_drop_the_doc_selection() {
        let fonts = [font()];
        let mut tree = tree_of((400.0, 200.0), labels("first", "second"));
        let a = tree.find("a").unwrap();
        let b = tree.find("b").unwrap();
        tree.doc_select_down(point_at(&tree, a, 1, &fonts), &fonts);
        tree.doc_select_drag(point_at(&tree, b, 3, &fonts), &fonts);
        assert!(tree.doc_selected_text().is_some());
        tree.remove(b);
        assert!(tree.doc_selection().is_none(), "endpoint removal clears");

        let mut tree = tree_of((400.0, 200.0), labels("first", "second"));
        let a = tree.find("a").unwrap();
        let b = tree.find("b").unwrap();
        tree.doc_select_down(point_at(&tree, a, 1, &fonts), &fonts);
        tree.doc_select_drag(point_at(&tree, b, 3, &fonts), &fonts);
        tree.update(
            a,
            Props {
                key: Some("a".into()),
                text: Some("rewritten".into()),
                ..Props::default()
            },
        );
        assert!(tree.doc_selection().is_none(), "text change clears");
    }

    #[test]
    fn shift_arrows_extend_the_selection_across_nodes() {
        let fonts = [font()];
        let mut tree = tree_of((400.0, 200.0), labels("ab", "cd"));
        let a = tree.find("a").unwrap();
        tree.doc_select_down(point_at(&tree, a, 2, &fonts), &fonts);
        assert!(tree.doc_extend(false, Granularity::Char), "cross into b");
        assert!(tree.doc_extend(false, Granularity::Char));
        assert_eq!(tree.doc_selected_text().as_deref(), Some("c"));
        assert!(tree.doc_extend(true, Granularity::Char));
        assert!(
            tree.doc_extend(true, Granularity::Char),
            "cross back into a"
        );
        assert_eq!(tree.doc_selected_text(), None, "shrunk to the anchor");
        assert!(tree.doc_extend(true, Granularity::Word));
        assert_eq!(tree.doc_selected_text().as_deref(), Some("ab"));
    }

    #[test]
    fn vertical_extension_crosses_into_the_next_node() {
        let fonts = [font()];
        let mut tree = tree_of((400.0, 200.0), labels("one\ntwo", "three"));
        let a = tree.find("a").unwrap();
        let b = tree.find("b").unwrap();
        tree.doc_select_down(point_at(&tree, a, 1, &fonts), &fonts);
        assert!(
            tree.doc_extend_vertical(false, &fonts),
            "into a's second line"
        );
        assert_eq!(tree.doc_selection_range(b), None);
        assert!(tree.doc_extend_vertical(false, &fonts), "into b");
        assert!(tree.doc_selection_range(b).is_some());
        assert!(tree.doc_extend_edge(true));
        assert_eq!(
            tree.doc_selected_text().as_deref(),
            Some("o"),
            "cmd+shift+up reaches the document start"
        );
    }

    #[test]
    fn select_all_joins_rows_with_newlines_but_not_columns() {
        let mut tree = tree_of((400.0, 200.0), labels("ab", "cd"));
        assert!(tree.doc_select_all());
        assert_eq!(tree.doc_selected_text().as_deref(), Some("ab\ncd"));

        let mut tree = tree_of(
            (400.0, 200.0),
            vec![Desc {
                style: Style {
                    flex_direction: FlexDirection::Row,
                    ..Style::default()
                },
                children: label_items("ab", "cd"),
                ..Desc::default()
            }],
        );
        assert!(tree.doc_select_all());
        assert_eq!(
            tree.doc_selected_text().as_deref(),
            Some("abcd"),
            "same visual row concatenates"
        );
    }

    #[test]
    fn programmatic_focus_keeps_the_doc_selection() {
        let fonts = [font()];
        let mut children = editor("hello");
        children.extend(labels("pick", "me"));
        let mut tree = tree_of((400.0, 200.0), children);
        let a = tree.find("a").unwrap();
        tree.doc_select_down(point_at(&tree, a, 0, &fonts), &fonts);
        tree.doc_select_drag(point_at(&tree, a, 4, &fonts), &fonts);
        assert_eq!(tree.doc_selected_text().as_deref(), Some("pick"));
        // An app refocusing its composer on stray keys must not eat the
        // selection out from under a pending copy.
        tree.set_focus(Some(tree.find("in").unwrap()));
        assert_eq!(tree.doc_selected_text().as_deref(), Some("pick"));
    }

    #[test]
    fn drags_can_start_in_empty_space() {
        let fonts = [font()];
        let mut tree = tree_of((400.0, 200.0), labels("first", "second"));
        let a = tree.find("a").unwrap();
        let b = tree.find("b").unwrap();
        let rect = tree.rect(b).unwrap();
        // The x of an outside press must not pick a column: below means
        // the end of the text, above means the beginning.
        let below = (rect.x + 2.0, rect.y + rect.h + 40.0);
        assert!(!tree.doc_select_down(below, &fonts), "no text under point");
        assert!(tree.doc_select_down_near(below, &fonts));
        assert_eq!(
            tree.doc_selected_text(),
            None,
            "click alone selects nothing"
        );
        tree.doc_select_drag(point_at(&tree, b, 3, &fonts), &fonts);
        assert_eq!(tree.doc_selected_text().as_deref(), Some("ond"));

        let a_rect = tree.rect(a).unwrap();
        let above = (a_rect.x + a_rect.w - 2.0, a_rect.y - 20.0);
        assert!(tree.doc_select_down_near(above, &fonts));
        tree.doc_select_drag(point_at(&tree, a, 2, &fonts), &fonts);
        assert_eq!(tree.doc_selected_text().as_deref(), Some("fi"));
    }

    #[test]
    fn an_outside_click_dismisses_the_selection_and_repaints() {
        let fonts = [font()];
        let mut tree = tree_of((400.0, 200.0), labels("first", "second"));
        let a = tree.find("a").unwrap();
        tree.doc_select_down(point_at(&tree, a, 0, &fonts), &fonts);
        tree.doc_select_drag(point_at(&tree, a, 5, &fonts), &fonts);
        tree.doc_select_up();
        assert_eq!(tree.doc_selected_text().as_deref(), Some("first"));
        tree.flush_layout(&[font()], 16.0);
        tree.clear_paint_flag();

        let rect = tree.rect(a).unwrap();
        assert!(tree.doc_select_down_near((rect.x, rect.y + 150.0), &fonts));
        assert_eq!(tree.doc_selected_text(), None);
        assert!(tree.dirty(), "the stale highlight must repaint away");
    }

    #[test]
    fn unified_selection_bands_cover_the_gap_between_nodes() {
        let fonts = [font()];
        let mut children = labels("first", "second");
        children[0].style.selection_mode = SelectionMode::Unified;
        children[0].style.gap = 10.0;
        children[0].key = Some("wrap".into());
        let mut tree = tree_of((400.0, 200.0), children);
        let a = tree.find("a").unwrap();
        let b = tree.find("b").unwrap();
        tree.doc_select_down(point_at(&tree, a, 1, &fonts), &fonts);
        tree.doc_select_drag(point_at(&tree, b, 3, &fonts), &fonts);
        let blocks = tree.doc_selection_blocks(&fonts);
        let (container, bands, color) = blocks.first().cloned().unwrap();
        assert_eq!(tree.key_of(container), Some("wrap"));
        assert_eq!(bands.len(), 3);
        let wrap_rect = tree.rect(container).unwrap();
        assert_eq!((bands[1].x, bands[1].w), (wrap_rect.x, wrap_rect.w));
        let a_rect = tree.rect(a).unwrap();
        let gap = (a_rect.x + 2.0, a_rect.y + a_rect.h + 5.0);
        assert!(
            bands[1].y <= gap.1 && gap.1 <= bands[1].y + bands[1].h,
            "the gap row sits inside the middle band"
        );
        let canvas = painted(&mut tree, (400, 200), None);
        let [r, g, bl, _] = pixel(&canvas, gap.0 as u32, gap.1 as u32);
        assert_eq!([r, g, bl], [color[0], color[1], color[2]]);
    }

    #[test]
    fn unified_selection_on_one_line_is_a_single_tight_band() {
        let fonts = [font()];
        let mut tree = tree_of(
            (400.0, 200.0),
            vec![Desc {
                style: Style {
                    flex_direction: FlexDirection::Row,
                    gap: 12.0,
                    selection_mode: SelectionMode::Unified,
                    ..Style::default()
                },
                children: label_items("ab", "cd"),
                ..Desc::default()
            }],
        );
        let a = tree.find("a").unwrap();
        let b = tree.find("b").unwrap();
        tree.doc_select_down(point_at(&tree, a, 1, &fonts), &fonts);
        tree.doc_select_drag(point_at(&tree, b, 1, &fonts), &fonts);
        let blocks = tree.doc_selection_blocks(&fonts);
        let (_, bands, _) = blocks.first().cloned().unwrap();
        assert_eq!(bands.len(), 1);
        let a_rect = tree.rect(a).unwrap();
        let b_rect = tree.rect(b).unwrap();
        assert!(bands[0].x > a_rect.x && bands[0].x + bands[0].w < b_rect.x + b_rect.w);
        assert!(
            bands[0].x + bands[0].w > b_rect.x,
            "the inter-node gap is inside the band"
        );
    }

    #[test]
    fn selections_without_a_unified_ancestor_have_no_bands() {
        let fonts = [font()];
        let mut tree = tree_of((400.0, 200.0), labels("first", "second"));
        let a = tree.find("a").unwrap();
        tree.doc_select_down(point_at(&tree, a, 0, &fonts), &fonts);
        tree.doc_select_drag(point_at(&tree, a, 4, &fonts), &fonts);
        assert!(tree.doc_selected_text().is_some());
        assert!(tree.doc_selection_blocks(&fonts).is_empty());
    }

    #[test]
    fn blocks_render_even_when_the_selection_starts_outside() {
        let fonts = [font()];
        let mut wrap = labels("first", "second");
        wrap[0].style.selection_mode = SelectionMode::Unified;
        wrap[0].key = Some("wrap".into());
        let children = vec![Desc {
            style: Style {
                flex_direction: FlexDirection::Column,
                align_items: Some(Align::Start),
                ..Style::default()
            },
            children: {
                let mut kids = vec![Desc {
                    key: Some("head".into()),
                    text: Some("header line".into()),
                    ..Desc::default()
                }];
                kids.append(&mut wrap);
                kids
            },
            ..Desc::default()
        }];
        let mut tree = tree_of((400.0, 200.0), children);
        let head = tree.find("head").unwrap();
        let b = tree.find("b").unwrap();
        tree.doc_select_down(point_at(&tree, head, 1, &fonts), &fonts);
        tree.doc_select_drag(point_at(&tree, b, 3, &fonts), &fonts);

        let blocks = tree.doc_selection_blocks(&fonts);
        assert_eq!(blocks.len(), 1, "one block for the designated area");
        let (container, bands, _) = blocks.first().cloned().unwrap();
        assert_eq!(tree.key_of(container), Some("wrap"));
        let rect = tree.rect(container).unwrap();
        assert_eq!(
            bands[0].x, rect.x,
            "start outside the block clamps its first row to full width"
        );
        assert!(
            tree.doc_selection_range(head).is_some(),
            "text outside the block still selects tightly"
        );
    }

    #[test]
    fn controlled_input_value_updates_are_undoable() {
        let mut tree = tree_of((400.0, 100.0), editor("hello"));
        let id = tree.find("in").unwrap();
        tree.set_input_text(id, "external");
        assert_eq!(tree.input_text(id), Some("external"));
        let input = tree.input_mut(id).unwrap();
        assert!(input.undo());
        assert_eq!(input.text(), "hello");
    }
}
