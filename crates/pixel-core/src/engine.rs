use std::io;
use std::time::{Duration, Instant};

use crate::canvas::Canvas;
use crate::native::NativeScroll;
use crate::paint::paint;
use crate::profiler::Profiler;
use crate::scroll::ScrollProfile;
use crate::scroll::profiles::Smooth;
use crate::style::Color;
use crate::terminal::{
    Event, KeyEvent, Mouse, MouseButton, MouseKind, Terminal, TerminalColors, Waker,
};
use crate::text_input::{InputAction, InputReply};
use crate::tree::{HitTarget, NodeId, Tree};

const FALLBACK_CELL: (u32, u32) = (16, 32);
const FRAME_POLL: Duration = Duration::from_millis(6);
const BAR_HIDE_DELAY: Duration = Duration::from_millis(1000);

fn is_plain_enter(key: &KeyEvent) -> bool {
    key.key == crate::terminal::Key::Enter
        && !key.mods.shift
        && !key.mods.ctrl
        && !key.mods.alt
        && !key.mods.sup
}

fn step_toward(value: f32, up: bool, up_rate: f32, down_rate: f32) -> f32 {
    if up {
        (value + up_rate).min(1.0)
    } else {
        (value - down_rate).max(0.0)
    }
}

/// Pixel window size, snapped to the cell grid so frames align with cells.
fn window_from(ws: &crate::terminal::WindowSize, cell: (u32, u32)) -> (u32, u32) {
    let cols = if ws.cols > 0 { ws.cols } else { 80 };
    let rows = if ws.rows > 0 { ws.rows } else { 24 };
    let width = if ws.width_px > 0 {
        ws.width_px
    } else {
        cols * cell.0
    };
    let height = if ws.height_px > 0 {
        ws.height_px
    } else {
        rows * cell.1
    };
    (width / cell.0 * cell.0, height / cell.1 * cell.1)
}

static DEFAULT_PROFILE: Smooth = Smooth {
    tau: 0.08,
    brake: 0.025,
};

pub struct EngineConfig {
    pub fonts: Vec<fontdue::Font>,
    /// Index into `fonts` used to derive the base font size from the cell height.
    pub cell_metrics_font: usize,
    /// Install a SIGWINCH handler so resizes repaint immediately. Turn off
    /// in processes with their own runtime (Node owns SIGWINCH) and wake
    /// the engine yourself instead; pump re-checks the size on every wake.
    pub watch_resize: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    Click {
        node: NodeId,
        key: Option<String>,
        x: f32,
        y: f32,
    },
    RightClick {
        x: f32,
        y: f32,
    },
    Change {
        node: NodeId,
        key: Option<String>,
        text: String,
    },
    /// Enter on an input with `submit`; the input is already cleared.
    Submit {
        node: NodeId,
        key: Option<String>,
        text: String,
    },
    /// Coalesced to one per frame, only for nodes with `scroll_events`.
    Scroll {
        node: NodeId,
        key: Option<String>,
        offset: f32,
        max: f32,
    },
    /// The terminal window changed; the tree is already re-sized.
    Resize {
        width: u32,
        height: u32,
        base_px: f32,
    },
    /// A key press no focused input consumed.
    Key(KeyEvent),
    /// Pasted text arriving while no input is focused.
    Paste(String),
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FrameStats {
    pub frame_ms: f32,
    pub fps: f32,
}

pub struct Engine {
    term: Terminal,
    pub tree: Tree,
    fonts: Vec<fontdue::Font>,
    cell_metrics_font: usize,
    profiler: Profiler,
    window: (u32, u32),
    cell: (u32, u32),
    base_px: f32,
    colors: TerminalColors,
    clear_color: Color,
    cursor: Option<(f32, f32)>,
    hover: Option<NodeId>,
    term_focused: bool,
    native: Option<NativeScroll>,
    use_native: bool,
    profile: &'static dyn ScrollProfile,
    drag: Option<NodeId>,
    bar_hover: Option<NodeId>,
    bar_drag: Option<(NodeId, f32)>,
    reveal: bool,
    last_step: Instant,
    last_frame: Instant,
    stats: FrameStats,
}

impl Engine {
    pub fn new(config: EngineConfig) -> io::Result<Self> {
        assert!(!config.fonts.is_empty());
        let mut term = Terminal::new()?;
        if config.watch_resize {
            term.watch_resize()?;
        }
        let colors = term.query_colors()?;
        let ws = term.size()?;
        let cell = ws.cell_size().or(term.cell_size()?).unwrap_or(FALLBACK_CELL);
        let window = window_from(&ws, cell);
        let base_px = px_for_cell_height(&config.fonts[config.cell_metrics_font], cell.1 as f32);
        let tree = Tree::new((window.0 as f32, window.1 as f32));
        let native = NativeScroll::spawn();
        let use_native = native.is_some();
        Ok(Self {
            term,
            tree,
            fonts: config.fonts,
            cell_metrics_font: config.cell_metrics_font,
            profiler: Profiler::new(),
            window,
            cell,
            base_px,
            colors,
            clear_color: [0, 0, 0, 255],
            cursor: None,
            hover: None,
            term_focused: true,
            native,
            use_native,
            profile: &DEFAULT_PROFILE,
            drag: None,
            bar_hover: None,
            bar_drag: None,
            reveal: false,
            last_step: Instant::now(),
            last_frame: Instant::now(),
            stats: FrameStats::default(),
        })
    }

    pub fn window_px(&self) -> (u32, u32) {
        self.window
    }

    pub fn cell_px(&self) -> (u32, u32) {
        self.cell
    }

    pub fn base_px(&self) -> f32 {
        self.base_px
    }

    pub fn colors(&self) -> &TerminalColors {
        &self.colors
    }

    pub fn stats(&self) -> FrameStats {
        self.stats
    }

    pub fn fonts(&self) -> &[fontdue::Font] {
        &self.fonts
    }

    pub fn cursor(&self) -> Option<(f32, f32)> {
        self.cursor
    }

    pub fn set_clear_color(&mut self, color: Color) {
        if self.clear_color != color {
            self.clear_color = color;
            self.tree.mark_paint();
        }
    }

    pub fn set_scroll_profile(&mut self, profile: &'static dyn ScrollProfile) {
        self.profile = profile;
    }

    pub fn native_scroll_available(&self) -> bool {
        self.native.is_some()
    }

    pub fn native_scroll_active(&self) -> bool {
        self.use_native && self.native.is_some()
    }

    pub fn set_native_scroll(&mut self, enabled: bool) {
        self.use_native = enabled;
    }

    pub fn waker(&mut self) -> io::Result<Waker> {
        self.term.waker()
    }

    pub fn profiler_toggle(&mut self) -> io::Result<Option<std::path::PathBuf>> {
        self.profiler.toggle()
    }

    pub fn profiler_recording(&self) -> bool {
        self.profiler.is_recording()
    }

    pub fn set_clipboard(&mut self, text: &str) -> io::Result<()> {
        self.term.set_clipboard(text)
    }

    pub fn apply_input_action(
        &mut self,
        action: InputAction,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let Some(focus) = self.tree.focus() else {
            return Ok(());
        };
        let Some(input) = self.tree.input_mut(focus) else {
            return Ok(());
        };
        let reply = input.apply(action);
        self.finish_reply(focus, reply, out)
    }

    /// `wait: None` blocks; an in-flight animation shortens any wait.
    pub fn pump(&mut self, wait: Option<Duration>) -> io::Result<Vec<EngineEvent>> {
        let mut out = Vec::new();
        self.check_resize(&mut out)?;
        self.frame()?;
        let first_wait = if self.animating() {
            Some(FRAME_POLL)
        } else {
            wait
        };
        let mut event = self.term.poll_event(first_wait)?;
        while let Some(current) = event {
            self.handle_event(current, &mut out)?;
            event = self.term.poll_event(Some(Duration::ZERO))?;
        }
        self.check_resize(&mut out)?;
        self.drain_native();
        let now = Instant::now();
        let dt = now.duration_since(self.last_step).as_secs_f32().min(0.05);
        self.last_step = now;
        self.step_scrolls(dt);
        self.step_bars(dt);
        if self.reveal {
            self.reveal = false;
            self.reveal_caret();
        }
        self.emit_scroll_events(&mut out);
        self.frame()?;
        Ok(out)
    }

    fn check_resize(&mut self, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        let ws = self.term.size()?;
        if ws.cols == 0 && ws.width_px == 0 {
            return Ok(());
        }
        let cell = ws.cell_size().unwrap_or(self.cell);
        let window = window_from(&ws, cell);
        if window == self.window {
            return Ok(());
        }
        self.window = window;
        self.cell = cell;
        self.base_px = px_for_cell_height(
            &self.fonts[self.cell_metrics_font.min(self.fonts.len() - 1)],
            cell.1 as f32,
        );
        self.tree.set_window((window.0 as f32, window.1 as f32));
        out.push(EngineEvent::Resize {
            width: window.0,
            height: window.1,
            base_px: self.base_px,
        });
        Ok(())
    }

    fn animating(&self) -> bool {
        let scrolling = self
            .tree
            .scroll_nodes()
            .iter()
            .any(|&id| self.tree.scroll_state(id).is_some_and(|s| !s.settled()));
        scrolling
            || self.bars_animating()
            || (self.native_scroll_active() && self.term_focused)
    }

    fn handle_event(&mut self, event: Event, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        match event {
            Event::Key(key) => {
                let focused = self.tree.focus().and_then(|id| {
                    self.tree
                        .get(id)
                        .filter(|node| node.input.is_some())
                        .map(|node| {
                            let submit = node.input.as_ref().is_some_and(|s| s.submit);
                            (id, node.resolved, submit)
                        })
                });
                match focused {
                    Some((focus, _, true)) if is_plain_enter(&key) => {
                        self.submit_input(focus, out)?;
                    }
                    Some((focus, resolved, _)) => {
                        let wrap = self.tree.input_geometry(focus).and_then(|g| g.max_width);
                        let font = &self.fonts[resolved.font.min(self.fonts.len() - 1)];
                        let input = self.tree.input_mut(focus).expect("checked above");
                        let reply = input.handle_key(key, font, resolved.px, wrap);
                        if reply == InputReply::None {
                            out.push(EngineEvent::Key(key));
                        } else {
                            self.finish_reply(focus, reply, out)?;
                        }
                    }
                    None => out.push(EngineEvent::Key(key)),
                }
            }
            Event::Paste(text) => {
                if let Some(focus) = self.tree.focus()
                    && let Some(input) = self.tree.input_mut(focus)
                {
                    input.insert(&text);
                    self.finish_reply(focus, InputReply::Edited, out)?;
                } else {
                    out.push(EngineEvent::Paste(text));
                }
            }
            Event::Focus(focused) => self.term_focused = focused,
            Event::Mouse(mouse) => self.handle_mouse(mouse, out)?,
        }
        Ok(())
    }

    fn handle_mouse(&mut self, mouse: Mouse, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        let point = (mouse.x as f32, mouse.y as f32);
        match mouse.kind {
            MouseKind::Down if mouse.button == MouseButton::Left => {
                if self.begin_bar_drag(point) {
                    return Ok(());
                }
                let node = match self.tree.hit_target(point.0, point.1) {
                    Some(HitTarget::Input(id)) => {
                        self.tree.set_focus(Some(id));
                        self.drag = Some(id);
                        self.forward_mouse(id, &mouse, out)?;
                        Some(id)
                    }
                    Some(HitTarget::Click(id)) => Some(id),
                    None => None,
                };
                if let Some(node) = node {
                    out.push(EngineEvent::Click {
                        node,
                        key: self.tree.key_of(node).map(str::to_string),
                        x: point.0,
                        y: point.1,
                    });
                }
            }
            MouseKind::Down if mouse.button == MouseButton::Right => {
                out.push(EngineEvent::RightClick {
                    x: point.0,
                    y: point.1,
                });
            }
            MouseKind::Move => {
                self.cursor = Some(point);
                if let Some((id, grab)) = self.bar_drag {
                    self.drag_bar_to(id, point.1 - grab);
                    return Ok(());
                }
                let bar_hover = self.bar_at(point);
                if bar_hover != self.bar_hover {
                    self.bar_hover = bar_hover;
                    self.tree.mark_paint();
                }
                let hover = self.tree.hover_at(point.0, point.1);
                if hover != self.hover {
                    self.hover = hover;
                    self.tree.mark_paint();
                }
                if let Some(id) = self.drag {
                    self.forward_mouse(id, &mouse, out)?;
                }
            }
            MouseKind::Up => {
                self.bar_drag = None;
                if let Some(id) = self.drag.take() {
                    self.forward_mouse(id, &mouse, out)?;
                }
            }
            MouseKind::ScrollUp | MouseKind::ScrollDown if !self.native_scroll_active() => {
                if let Some(area) = self.tree.scroll_area_at(point.0, point.1) {
                    let tick = if mouse.kind == MouseKind::ScrollUp {
                        -(self.cell.1 as f32)
                    } else {
                        self.cell.1 as f32
                    };
                    let max = area.max_scroll();
                    let node = area.node;
                    let profile = self.profile;
                    if let Some(state) = self.tree.scroll_state_mut(node) {
                        state.tick(profile, tick, max);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn forward_mouse(
        &mut self,
        id: NodeId,
        mouse: &Mouse,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let Some(geometry) = self.tree.input_geometry(id) else {
            return Ok(());
        };
        let fonts = &self.fonts;
        let Some(input) = self.tree.input_mut(id) else {
            return Ok(());
        };
        let reply = input.handle_mouse(mouse, geometry, fonts);
        if reply != InputReply::None {
            self.finish_reply(id, reply, out)?;
        }
        Ok(())
    }

    fn finish_reply(
        &mut self,
        id: NodeId,
        reply: InputReply,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        match reply {
            InputReply::None => {}
            InputReply::Selected => self.tree.mark_paint(),
            InputReply::Moved => {
                self.reveal = true;
                self.tree.mark_paint();
            }
            InputReply::Edited => {
                self.tree.sync_input_text(id);
                self.reveal = true;
                self.push_change(id, out);
            }
            InputReply::Copy(text) => self.term.set_clipboard(&text)?,
            InputReply::Cut(text) => {
                self.term.set_clipboard(&text)?;
                self.tree.sync_input_text(id);
                self.reveal = true;
                self.push_change(id, out);
            }
            InputReply::RequestPaste => self.term.request_clipboard()?,
        }
        Ok(())
    }

    fn submit_input(&mut self, id: NodeId, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        let text = self.tree.input_text(id).unwrap_or_default().to_string();
        out.push(EngineEvent::Submit {
            node: id,
            key: self.tree.key_of(id).map(str::to_string),
            text,
        });
        self.tree.edit_input(id, |input| input.replace_all(""));
        self.finish_reply(id, InputReply::Edited, out)
    }

    fn push_change(&mut self, id: NodeId, out: &mut Vec<EngineEvent>) {
        let Some(text) = self.tree.input_text(id) else {
            return;
        };
        out.push(EngineEvent::Change {
            node: id,
            key: self.tree.key_of(id).map(str::to_string),
            text: text.to_string(),
        });
    }

    /// Topmost scroller whose visible bar zone contains the point. Hidden
    /// bars don't take hits, matching overlay-scrollbar behavior.
    fn bar_at(&self, point: (f32, f32)) -> Option<NodeId> {
        self.tree
            .scroll_nodes()
            .into_iter()
            .rev()
            .find(|&id| {
                self.tree
                    .get(id)
                    .is_some_and(|node| node.bar.opacity > 0.1)
                    && self
                        .tree
                        .scrollbar_rects(id)
                        .is_some_and(|r| r.zone.contains(point.0, point.1))
            })
    }

    fn begin_bar_drag(&mut self, point: (f32, f32)) -> bool {
        let Some(id) = self.bar_at(point) else {
            return false;
        };
        let Some(rects) = self.tree.scrollbar_rects(id) else {
            return false;
        };
        let grab = if rects.thumb.contains(rects.thumb.x + 1.0, point.1) {
            point.1 - rects.thumb.y
        } else {
            // Track click: jump the thumb's center to the click, then drag.
            let center_grab = rects.thumb.h / 2.0;
            self.drag_bar_to(id, point.1 - center_grab);
            center_grab
        };
        self.bar_drag = Some((id, grab));
        self.touch_bar(id);
        true
    }

    fn drag_bar_to(&mut self, id: NodeId, thumb_y: f32) {
        let Some(position) = self.tree.scroll_pos_for_thumb(id, thumb_y) else {
            return;
        };
        if let Some(state) = self.tree.scroll_state_mut(id)
            && state.position != position
        {
            state.position = position;
            state.set_target(position);
            self.tree.mark_place();
            self.touch_bar(id);
        }
    }

    fn touch_bar(&mut self, id: NodeId) {
        if let Some(node) = self.tree.get_mut(id) {
            node.bar.last_move = Some(Instant::now());
        }
    }

    fn step_bars(&mut self, dt: f32) {
        let now = Instant::now();
        for id in self.tree.scroll_nodes() {
            let engaged =
                self.bar_hover == Some(id) || self.bar_drag.map(|(d, _)| d) == Some(id);
            let Some(node) = self.tree.get_mut(id) else {
                continue;
            };
            if engaged {
                // Hovering counts as activity, so leaving the bar restarts
                // the full linger instead of fading almost immediately.
                node.bar.last_move = Some(now);
            }
            let recent = node
                .bar
                .last_move
                .is_some_and(|at| now.duration_since(at) < BAR_HIDE_DELAY);
            let show = node.scroll_max > 0.0 && (recent || engaged);
            let opacity = step_toward(node.bar.opacity, show, dt / 0.10, dt / 0.30);
            let expand = step_toward(node.bar.expand, engaged, dt / 0.10, dt / 0.10);
            if opacity != node.bar.opacity || expand != node.bar.expand {
                node.bar.opacity = opacity;
                node.bar.expand = expand;
                self.tree.mark_paint();
            }
        }
    }

    fn bars_animating(&self) -> bool {
        let now = Instant::now();
        self.tree.scroll_nodes().iter().any(|&id| {
            self.tree.get(id).is_some_and(|node| {
                node.bar.opacity > 0.0
                    || node
                        .bar
                        .last_move
                        .is_some_and(|at| now.duration_since(at) < BAR_HIDE_DELAY)
            })
        })
    }

    fn emit_scroll_events(&mut self, out: &mut Vec<EngineEvent>) {
        for id in self.tree.scroll_nodes() {
            let Some(node) = self.tree.get(id) else {
                continue;
            };
            if !node.scroll_events {
                continue;
            }
            let (offset, max) = (node.scroll.position, node.scroll_max);
            if (offset - node.last_scroll_emit).abs() < 0.5 {
                continue;
            }
            let key = node.key.clone();
            if let Some(node) = self.tree.get_mut(id) {
                node.last_scroll_emit = offset;
            }
            out.push(EngineEvent::Scroll {
                node: id,
                key,
                offset,
                max,
            });
        }
    }

    pub fn scroll_to(&mut self, id: NodeId, offset: f32, smooth: bool) {
        self.tree.flush_layout(&self.fonts, self.base_px);
        let max = self.tree.scroll_max(id);
        let offset = offset.clamp(0.0, max);
        if let Some(state) = self.tree.scroll_state_mut(id) {
            if smooth {
                state.set_target(offset);
            } else {
                state.position = offset;
                state.set_target(offset);
                self.tree.mark_place();
            }
            self.touch_bar(id);
        }
    }

    fn drain_native(&mut self) {
        let Some(native) = &mut self.native else {
            return;
        };
        let deltas = native.drain();
        let scale = native.scale;
        if !self.use_native || !self.term_focused || deltas.is_empty() {
            return;
        }
        let Some((x, y)) = self.cursor else {
            return;
        };
        let Some(area) = self.tree.scroll_area_at(x, y) else {
            return;
        };
        let (node, max) = (area.node, area.max_scroll());
        let cell_h = self.cell.1 as f32;
        let mut moved = false;
        if let Some(state) = self.tree.scroll_state_mut(node) {
            for delta in deltas {
                let px_delta = if delta.precise {
                    delta.delta_y * scale
                } else {
                    delta.delta_y * cell_h
                };
                let next = (state.position - px_delta).clamp(0.0, max);
                if next != state.position {
                    state.position = next;
                    state.set_target(next);
                    moved = true;
                }
            }
        }
        if moved {
            self.tree.mark_place();
            self.touch_bar(node);
        }
    }

    fn step_scrolls(&mut self, dt: f32) {
        let profile = self.profile;
        for id in self.tree.scroll_nodes() {
            let max = self.tree.scroll_max(id);
            if let Some(state) = self.tree.scroll_state_mut(id)
                && state.step(profile, dt, max)
            {
                self.tree.mark_place();
                self.touch_bar(id);
            }
        }
    }

    fn reveal_caret(&mut self) {
        let Some(focus) = self.tree.focus() else {
            return;
        };
        self.tree.flush_layout(&self.fonts, self.base_px);
        let Some(scroller) = self
            .tree
            .parent(focus)
            .and_then(|p| self.tree.scroll_parent(p))
        else {
            return;
        };
        let Some(area) = self.tree.scroll_area(scroller) else {
            return;
        };
        let Some(geometry) = self.tree.input_geometry(focus) else {
            return;
        };
        let Some(node) = self.tree.get(focus) else {
            return;
        };
        let text = node.input.as_ref().map(|s| s.input.text()).unwrap_or("");
        let cursor = node.input.as_ref().map_or(0, |s| s.input.cursor());
        let caret = geometry.caret_rect(text, cursor, &self.fonts);
        let margin = node.resolved.px * 1.1;
        let current = self
            .tree
            .scroll_state(scroller)
            .map_or(0.0, |s| s.target);
        if let Some(target) = area.target_to_reveal(caret, current, margin)
            && let Some(state) = self.tree.scroll_state_mut(scroller)
        {
            state.set_target(target);
        }
    }

    fn frame(&mut self) -> io::Result<()> {
        if !self.tree.dirty() {
            return Ok(());
        }
        self.profiler.begin_frame();
        let start = Instant::now();
        let mut canvas = crate::profiler::span("canvas.clear", || {
            let mut canvas = Canvas::new(self.window.0, self.window.1);
            canvas.fill(self.clear_color);
            canvas
        });
        self.tree.flush_layout(&self.fonts, self.base_px);
        paint(&self.tree, &mut canvas, &self.fonts, self.cursor);
        self.tree.clear_paint_flag();
        let bytes = crate::profiler::span("draw", || self.term.draw(&canvas))?;
        crate::profiler::count("bytes", bytes as u64);

        let gap = start.duration_since(self.last_frame).as_secs_f32();
        self.last_frame = start;
        let ema = |old: f32, new: f32| if old == 0.0 { new } else { old * 0.9 + new * 0.1 };
        self.stats.frame_ms = ema(self.stats.frame_ms, start.elapsed().as_secs_f32() * 1000.0);
        // Gaps across idle stretches aren't a frame rate; only count cadence.
        if gap < 0.25 {
            self.stats.fps = ema(self.stats.fps, 1.0 / gap);
        }
        Ok(())
    }
}

pub fn px_for_cell_height(font: &fontdue::Font, cell_height: f32) -> f32 {
    let probe = font
        .horizontal_line_metrics(100.0)
        .expect("font has horizontal metrics");
    (cell_height * 100.0 / probe.new_line_size).clamp(6.0, 512.0)
}
