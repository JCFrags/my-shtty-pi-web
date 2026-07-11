mod compositor;

use std::io;
use std::time::{Duration, Instant};

use compositor::Compositor;

use crate::canvas::{Canvas, measure_text};
use crate::logging;
use crate::menu::{MenuClick, MenuController};
use crate::native::NativeScroll;
use crate::paint::paint;
use crate::profiler::{ProfileData, Profiler};
use crate::scroll::ScrollProfile;
use crate::scroll::profiles::Smooth;
use crate::style::Color;
use crate::terminal::{
    Event, KeyEvent, Mouse, MouseButton, MouseKind, Terminal, TerminalColors, Waker,
};
use crate::text_input::{Granularity, InputAction, InputReply};
use crate::throttle::CpuThrottle;
use crate::tree::{HitTarget, NodeId, Tree};

const FALLBACK_CELL: (u32, u32) = (16, 32);
const FRAME_POLL: Duration = Duration::from_millis(6);

const HIGHLIGHT_FILL: Color = [64, 140, 255, 60];
const HIGHLIGHT_BORDER: Color = [82, 148, 255, 230];

fn key_label(key: &KeyEvent) -> String {
    let mut label = String::from("key ");
    if key.mods.ctrl {
        label.push_str("ctrl+");
    }
    if key.mods.alt {
        label.push_str("alt+");
    }
    if key.mods.sup {
        label.push_str("cmd+");
    }
    let name = match key.key {
        crate::terminal::Key::Char(c) => {
            if key.mods.shift {
                label.push_str("shift+");
            }
            label.push(c);
            return label;
        }
        crate::terminal::Key::Up => "up",
        crate::terminal::Key::Down => "down",
        crate::terminal::Key::Left => "left",
        crate::terminal::Key::Right => "right",
        crate::terminal::Key::Home => "home",
        crate::terminal::Key::End => "end",
        crate::terminal::Key::Enter => "enter",
        crate::terminal::Key::Backspace => "backspace",
        crate::terminal::Key::Delete => "delete",
        crate::terminal::Key::Escape => "escape",
        crate::terminal::Key::Tab => "tab",
        crate::terminal::Key::Unknown => "unknown",
    };
    if key.mods.shift {
        label.push_str("shift+");
    }
    label.push_str(name);
    label
}

fn is_plain_enter(key: &KeyEvent) -> bool {
    key.key == crate::terminal::Key::Enter
        && !key.mods.shift
        && !key.mods.ctrl
        && !key.mods.alt
        && !key.mods.sup
}

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
    pub cell_metrics_font: usize,
    pub watch_resize: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    Click {
        view: usize,
        node: NodeId,
        key: Option<String>,
        x: f32,
        y: f32,
    },
    RightClick {
        view: usize,
        x: f32,
        y: f32,
    },
    Change {
        view: usize,
        node: NodeId,
        key: Option<String>,
        text: String,
    },
    Submit {
        view: usize,
        node: NodeId,
        key: Option<String>,
        text: String,
    },
    Scroll {
        view: usize,
        node: NodeId,
        key: Option<String>,
        offset: f32,
        max: f32,
    },
    Resize {
        view: usize,
        width: u32,
        height: u32,
        base_px: f32,
    },
    Inspect {
        view: usize,
        node: NodeId,
        key: Option<String>,
        x: f32,
        y: f32,
    },
    Key {
        view: usize,
        event: KeyEvent,
    },
    Paste {
        view: usize,
        text: String,
    },
    Wheel {
        view: usize,
        node: NodeId,
        key: Option<String>,
        x: f32,
        y: f32,
        delta_x: f32,
        delta_y: f32,
        precise: bool,
    },
    Log(logging::LogEntry),
    Profile(ProfileData),
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FrameStats {
    pub frame_ms: f32,
    pub fps: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DragTarget {
    Input(NodeId),
    Text,
}

pub struct Engine {
    term: Terminal,
    comp: Compositor,
    fonts: Vec<fontdue::Font>,
    cell_metrics_font: usize,
    profiler: Profiler,
    cell: (u32, u32),
    grid: (u32, u32),
    base_px: f32,
    colors: TerminalColors,
    cursor: Option<(f32, f32)>,
    hover: Option<(usize, NodeId)>,
    focus_view: usize,
    active_view: usize,
    term_focused: bool,
    native: Option<NativeScroll>,
    use_native: bool,
    profile: &'static dyn ScrollProfile,
    default_menu: bool,
    menu: MenuController,
    inspect_mode: bool,
    inspect_view: usize,
    inspect_hover: Option<NodeId>,
    highlight: Option<(usize, NodeId)>,
    emit_logs: bool,
    log_cursor: u64,
    drag: Option<(usize, DragTarget)>,
    bar_hover: Option<(usize, NodeId)>,
    bar_drag: Option<(usize, NodeId, f32)>,
    reveal: bool,
    cpu_throttle: CpuThrottle,
    throttle_registered: bool,
    scroll_burst: u32,
    last_scroll_mark: Option<Instant>,
    pending: Vec<EngineEvent>,
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
        let cell = ws
            .cell_size()
            .or(term.cell_size()?)
            .unwrap_or(FALLBACK_CELL);
        let window = window_from(&ws, cell);
        let base_px = px_for_cell_height(&config.fonts[config.cell_metrics_font], cell.1 as f32);
        let native = NativeScroll::spawn(term.waker().ok());
        let use_native = native.is_some();
        logging::info(
            "engine",
            format!(
                "started {}x{}px, cell {}x{}, base {base_px:.1}px, native scroll {}",
                window.0, window.1, cell.0, cell.1, use_native
            ),
        );
        Ok(Self {
            term,
            comp: Compositor::new(window),
            fonts: config.fonts,
            cell_metrics_font: config.cell_metrics_font,
            profiler: Profiler::new(),
            cell,
            grid: (0, 0),
            base_px,
            colors,
            cursor: None,
            hover: None,
            focus_view: 0,
            active_view: 0,
            term_focused: true,
            native,
            use_native,
            profile: &DEFAULT_PROFILE,
            default_menu: false,
            menu: MenuController::default(),
            inspect_mode: false,
            inspect_view: 0,
            inspect_hover: None,
            highlight: None,
            emit_logs: false,
            log_cursor: 0,
            drag: None,
            bar_hover: None,
            bar_drag: None,
            reveal: false,
            cpu_throttle: CpuThrottle::new(),
            throttle_registered: false,
            scroll_burst: 0,
            last_scroll_mark: None,
            pending: Vec::new(),
            last_step: Instant::now(),
            last_frame: Instant::now(),
            stats: FrameStats::default(),
        })
    }

    pub fn tree(&self) -> &Tree {
        &self.comp.views[0].tree
    }

    pub fn tree_mut(&mut self) -> &mut Tree {
        &mut self.comp.views[0].tree
    }

    pub fn view_tree(&self, view: usize) -> Option<&Tree> {
        self.comp.views.get(view).map(|v| &v.tree)
    }

    pub fn view_tree_mut(&mut self, view: usize) -> Option<&mut Tree> {
        self.comp.views.get_mut(view).map(|v| &mut v.tree)
    }

    pub fn view_count(&self) -> usize {
        self.comp.views.len()
    }

    pub fn view_size(&self, view: usize) -> (u32, u32) {
        self.comp.views.get(view).map_or((0, 0), |v| v.size)
    }

    pub fn window_px(&self) -> (u32, u32) {
        self.comp.window
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

    pub fn split(&self) -> Option<f32> {
        self.comp.split()
    }

    pub fn add_view(&mut self) -> usize {
        let view = self.comp.add_view();
        logging::info("engine", format!("view {view} created"));
        view
    }

    pub fn set_pane(&mut self, slot: usize, view: usize) {
        if self.comp.set_pane(slot, view) {
            logging::info("engine", format!("pane {slot} shows view {view}"));
            let resized = self.comp.apply_layout(true);
            self.push_resizes(resized);
        }
    }

    pub fn set_inspect_view(&mut self, view: usize) {
        if view < self.comp.views.len() {
            self.inspect_view = view;
        }
    }

    pub fn set_clear_color(&mut self, view: usize, color: Color) {
        let Some(v) = self.comp.views.get_mut(view) else {
            return;
        };
        if v.clear_color != color {
            v.clear_color = color;
            v.tree.mark_paint();
        }
    }

    pub fn set_default_menu(&mut self, enabled: bool) {
        self.default_menu = enabled;
        if !enabled {
            self.close_menu();
        }
    }

    pub fn set_emit_logs(&mut self, enabled: bool) {
        self.emit_logs = enabled;
    }

    pub fn set_inspect_mode(&mut self, enabled: bool) {
        if self.inspect_mode != enabled {
            self.inspect_mode = enabled;
            self.inspect_hover = None;
            self.comp.dirty = true;
        }
    }

    pub fn inspect_mode(&self) -> bool {
        self.inspect_mode
    }

    pub fn set_highlight(&mut self, target: Option<(usize, NodeId)>) {
        if self.highlight != target {
            self.highlight = target;
            self.comp.dirty = true;
        }
    }

    pub fn set_split(&mut self, split: Option<f32>) {
        if !self.comp.set_split(split) {
            return;
        }
        logging::info(
            "engine",
            match self.comp.split() {
                Some(f) => format!("split screen at {:.0}%", f * 100.0),
                None => "split screen closed".into(),
            },
        );
        let resized = self.comp.apply_layout(false);
        self.push_resizes(resized);
    }

    fn push_resizes(&mut self, resized: Vec<(usize, (u32, u32))>) {
        for (view, size) in resized {
            self.pending.push(EngineEvent::Resize {
                view,
                width: size.0,
                height: size.1,
                base_px: self.base_px,
            });
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

    pub fn profile_start(&mut self) {
        if !crate::profiler::is_recording() {
            logging::info("profiler", "recording started");
            crate::profiler::start();
        }
    }

    pub fn profile_stop(&mut self) {
        if let Some(data) = crate::profiler::stop() {
            logging::info(
                "profiler",
                format!("recording stopped, {} spans", data.spans.len()),
            );
            self.pending.push(EngineEvent::Profile(data));
        }
    }

    pub fn cpu_throttle(&self) -> &CpuThrottle {
        &self.cpu_throttle
    }

    pub fn set_cpu_throttle(&mut self, rate: f32) {
        if !CpuThrottle::supported() && rate > 1.0 {
            logging::warn("engine", "cpu throttle is only supported on macOS");
            return;
        }
        self.cpu_throttle.set_rate(rate);
        let applied = self.cpu_throttle.rate();
        logging::info("engine", format!("cpu throttle {applied}x"));
        if crate::profiler::is_recording() {
            crate::profiler::mark("throttle", 0, format!("cpu throttle {applied}x"));
        }
    }

    pub fn set_clipboard(&mut self, text: &str) -> io::Result<()> {
        self.term.set_clipboard(text)
    }

    pub fn flush_view_layout(&mut self, view: usize) {
        let base_px = self.base_px;
        let fonts = &self.fonts;
        if let Some(v) = self.comp.views.get_mut(view) {
            v.tree.flush_layout(fonts, base_px);
        }
    }

    pub fn set_focus(&mut self, view: usize, id: Option<NodeId>) {
        if view >= self.comp.views.len() {
            return;
        }
        for (i, v) in self.comp.views.iter_mut().enumerate() {
            if i != view {
                v.tree.set_focus(None);
            }
        }
        self.comp.views[view].tree.set_focus(id);
        self.focus_view = view;
    }

    fn focused(&self) -> Option<(usize, NodeId)> {
        self.comp.views[self.focus_view]
            .tree
            .focus()
            .map(|id| (self.focus_view, id))
    }

    pub fn apply_input_action(
        &mut self,
        action: InputAction,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let Some((view, focus)) = self.focused() else {
            return self.apply_doc_action(action);
        };
        let Some(input) = self.comp.views[view].tree.input_mut(focus) else {
            return Ok(());
        };
        let reply = input.apply(action);
        if reply == InputReply::None {
            return self.apply_doc_action(action);
        }
        self.finish_reply(view, focus, reply, out)
    }

    fn apply_doc_action(&mut self, action: InputAction) -> io::Result<()> {
        let view = self.active_view;
        match action {
            InputAction::Copy => {
                if let Some(text) = self.comp.views[view].tree.doc_selected_text() {
                    self.term.set_clipboard(&text)?;
                }
            }
            InputAction::SelectAll => {
                self.comp.views[view].tree.doc_select_all();
            }
            _ => {}
        }
        Ok(())
    }

    pub fn pump(&mut self, wait: Option<Duration>) -> io::Result<Vec<EngineEvent>> {
        if !self.throttle_registered {
            self.throttle_registered = true;
            self.cpu_throttle.register_current_thread();
        }
        let mut out = Vec::new();
        out.append(&mut self.pending);
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
        self.drain_native(&mut out);
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
        out.append(&mut self.pending);
        self.frame()?;
        self.drain_logs(&mut out);
        Ok(out)
    }

    fn drain_logs(&mut self, out: &mut Vec<EngineEvent>) {
        if !self.emit_logs {
            return;
        }
        let entries = logging::entries_after(self.log_cursor);
        if let Some(last) = entries.last() {
            self.log_cursor = last.seq + 1;
        }
        out.extend(entries.into_iter().map(EngineEvent::Log));
    }

    fn check_resize(&mut self, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        let ws = self.term.size()?;
        if ws.cols == 0 && ws.width_px == 0 {
            return Ok(());
        }
        self.apply_window(&ws)?;
        out.append(&mut self.pending);
        Ok(())
    }

    fn apply_window(&mut self, ws: &crate::terminal::WindowSize) -> io::Result<()> {
        let grid = (ws.cols, ws.rows);
        let cell = match ws.cell_size() {
            Some(cell) => cell,
            None => {
                if grid != self.grid && self.grid != (0, 0) {
                    self.term.forget_cell_size();
                }
                self.term.cell_size()?.unwrap_or(self.cell)
            }
        };
        self.grid = grid;
        let window = window_from(ws, cell);
        if window == self.comp.window && cell == self.cell {
            return Ok(());
        }
        let base_px = px_for_cell_height(
            &self.fonts[self.cell_metrics_font.min(self.fonts.len() - 1)],
            cell.1 as f32,
        );
        logging::info(
            "engine",
            format!(
                "resize {}x{} cell {}x{} base {:.1}px -> {}x{} cell {}x{} base {base_px:.1}px",
                self.comp.window.0,
                self.comp.window.1,
                self.cell.0,
                self.cell.1,
                self.base_px,
                window.0,
                window.1,
                cell.0,
                cell.1,
            ),
        );
        if crate::profiler::is_recording() {
            crate::profiler::mark(
                "resize",
                0,
                format!(
                    "resize {}x{} cell {}x{}",
                    window.0, window.1, cell.0, cell.1
                ),
            );
        }
        let base_changed = (base_px - self.base_px).abs() > 0.01;
        self.comp.window = window;
        self.cell = cell;
        self.base_px = base_px;
        let resized = self.comp.apply_layout(base_changed);
        self.push_resizes(resized);
        Ok(())
    }

    fn animating(&self) -> bool {
        let scrolling = self.comp.active_views().into_iter().any(|view| {
            let tree = &self.comp.views[view].tree;
            tree.scroll_nodes()
                .iter()
                .any(|&id| tree.scroll_state(id).is_some_and(|s| !s.settled()))
        });
        scrolling || self.bars_animating()
    }

    fn handle_event(&mut self, event: Event, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        match event {
            Event::Key(key) => self.handle_key(key, out)?,
            Event::Paste(text) => {
                if crate::profiler::is_recording() {
                    crate::profiler::mark(
                        "paste",
                        self.active_view as u32,
                        format!("paste ({} chars)", text.chars().count()),
                    );
                }
                if let Some((view, focus)) = self.focused() {
                    if let Some(input) = self.comp.views[view].tree.input_mut(focus) {
                        input.insert(&text);
                        self.finish_reply(view, focus, InputReply::Edited, out)?;
                    }
                } else {
                    out.push(EngineEvent::Paste {
                        view: self.active_view,
                        text,
                    });
                }
            }
            Event::Focus(focused) => self.term_focused = focused,
            Event::WindowSize(ws) => self.apply_window(&ws)?,
            Event::Mouse(mouse) => self.handle_mouse(mouse, out)?,
        }
        Ok(())
    }

    fn handle_key(&mut self, key: KeyEvent, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        if crate::profiler::is_recording() {
            crate::profiler::mark("key", self.active_view as u32, key_label(&key));
        }
        if key.key == crate::terminal::Key::Escape {
            if self.menu.is_open() {
                self.close_menu();
                return Ok(());
            }
            if self.inspect_mode {
                self.set_inspect_mode(false);
                return Ok(());
            }
        }
        let focused = self.focused().and_then(|(view, id)| {
            self.comp.views[view]
                .tree
                .input_meta(id)
                .map(|(resolved, submit)| (view, id, resolved, submit))
        });
        match focused {
            Some((view, focus, _, true)) if is_plain_enter(&key) => {
                self.submit_input(view, focus, out)?;
            }
            Some((view, focus, resolved, _)) => {
                let wrap = self.comp.views[view]
                    .tree
                    .input_geometry(focus)
                    .and_then(|g| g.max_width);
                let font = &self.fonts[resolved.font.min(self.fonts.len() - 1)];
                let input = self.comp.views[view]
                    .tree
                    .input_mut(focus)
                    .expect("checked above");
                let reply = input.handle_key(key, font, resolved.px, wrap);
                if reply == InputReply::None {
                    if !self.handle_doc_key(&key)? {
                        out.push(EngineEvent::Key {
                            view: self.active_view,
                            event: key,
                        });
                    }
                } else {
                    self.finish_reply(view, focus, reply, out)?;
                }
            }
            None => {
                if !self.handle_doc_key(&key)? {
                    out.push(EngineEvent::Key {
                        view: self.active_view,
                        event: key,
                    });
                }
            }
        }
        Ok(())
    }

    fn handle_doc_key(&mut self, key: &KeyEvent) -> io::Result<bool> {
        use Granularity::{Char, Line, Word};
        let view = self.active_view;
        let m = key.mods;
        let combo = m.ctrl || m.sup;
        let horizontal = if m.alt {
            Word
        } else if m.sup {
            Line
        } else {
            Char
        };
        let handled = match key.key {
            crate::terminal::Key::Char('c') if combo => {
                match self.comp.views[view].tree.doc_selected_text() {
                    Some(text) => {
                        self.term.set_clipboard(&text)?;
                        true
                    }
                    None => false,
                }
            }
            crate::terminal::Key::Char('a') if m.sup => self.comp.views[view].tree.doc_select_all(),
            crate::terminal::Key::Escape => self.comp.views[view].tree.doc_collapse(),
            crate::terminal::Key::Left if m.shift => {
                self.comp.views[view].tree.doc_extend(true, horizontal)
            }
            crate::terminal::Key::Right if m.shift => {
                self.comp.views[view].tree.doc_extend(false, horizontal)
            }
            crate::terminal::Key::Home if m.shift => self.comp.views[view].tree.doc_extend(true, Line),
            crate::terminal::Key::End if m.shift => self.comp.views[view].tree.doc_extend(false, Line),
            crate::terminal::Key::Up if m.shift && m.sup => {
                self.comp.views[view].tree.doc_extend_edge(true)
            }
            crate::terminal::Key::Down if m.shift && m.sup => {
                self.comp.views[view].tree.doc_extend_edge(false)
            }
            crate::terminal::Key::Up if m.shift => {
                let fonts = &self.fonts;
                self.comp.views[view].tree.doc_extend_vertical(true, fonts)
            }
            crate::terminal::Key::Down if m.shift => {
                let fonts = &self.fonts;
                self.comp.views[view].tree.doc_extend_vertical(false, fonts)
            }
            _ => false,
        };
        Ok(handled)
    }

    fn clear_doc_selections(&mut self, except: Option<usize>) {
        for (i, v) in self.comp.views.iter_mut().enumerate() {
            if except != Some(i) {
                v.tree.doc_collapse();
            }
        }
    }

    fn begin_text_selection(&mut self, view: usize, local: (f32, f32)) {
        self.clear_doc_selections(Some(view));
        let fonts = &self.fonts;
        if self.comp.views[view].tree.doc_select_down(local, fonts) {
            if let Some((focus_view, _)) = self.focused() {
                self.comp.views[focus_view].tree.set_focus(None);
            }
            self.drag = Some((view, DragTarget::Text));
        } else if self.comp.views[view].tree.doc_select_down_near(local, fonts) {
            self.drag = Some((view, DragTarget::Text));
        } else {
            self.comp.views[view].tree.doc_collapse();
        }
    }

    fn handle_mouse(&mut self, mouse: Mouse, out: &mut Vec<EngineEvent>) -> io::Result<()> {
        let point = (mouse.x as f32, mouse.y as f32);
        match mouse.kind {
            MouseKind::Down if mouse.button == MouseButton::Left => {
                self.mark_pointer("click", point);
                if self.handle_menu_click(point, out)? {
                    return Ok(());
                }
                if self.comp.on_divider(point.0) {
                    if crate::profiler::is_recording() {
                        crate::profiler::mark("drag", 0, "divider drag".into());
                    }
                    self.comp.divider_drag = true;
                    self.comp.dirty = true;
                    return Ok(());
                }
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                self.active_view = view;
                if let Some((focus_view, _)) = self.focused()
                    && focus_view != view
                {
                    self.comp.views[focus_view].tree.set_focus(None);
                }
                if self.inspect_mode && view == self.inspect_view {
                    self.finish_inspect(local, out);
                    return Ok(());
                }
                if self.begin_bar_drag(view, local) {
                    return Ok(());
                }
                let node = match self.comp.views[view].tree.hit_target(local.0, local.1) {
                    Some(HitTarget::Input(id)) => {
                        self.clear_doc_selections(None);
                        self.set_focus(view, Some(id));
                        self.drag = Some((view, DragTarget::Input(id)));
                        self.forward_mouse(view, id, &mouse, out)?;
                        Some(id)
                    }
                    Some(HitTarget::Click(id)) => {
                        self.begin_text_selection(view, local);
                        Some(id)
                    }
                    Some(HitTarget::Text(_)) => {
                        self.begin_text_selection(view, local);
                        None
                    }
                    None => {
                        self.begin_text_selection(view, local);
                        None
                    }
                };
                if let Some(node) = node {
                    out.push(EngineEvent::Click {
                        view,
                        node,
                        key: self.comp.views[view].tree.key_of(node).map(str::to_string),
                        x: local.0,
                        y: local.1,
                    });
                }
            }
            MouseKind::Down if mouse.button == MouseButton::Right => {
                self.mark_pointer("right-click", point);
                self.close_menu();
                if self.comp.on_divider(point.0) {
                    return Ok(());
                }
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                self.active_view = view;
                if self.default_menu {
                    self.open_menu(view, local);
                }
                out.push(EngineEvent::RightClick {
                    view,
                    x: local.0,
                    y: local.1,
                });
            }
            MouseKind::Move => {
                self.cursor = Some(point);
                if self.comp.divider_drag {
                    let resized = self.comp.drag_divider(point.0);
                    self.push_resizes(resized);
                    return Ok(());
                }
                let divider_hover = self.comp.on_divider(point.0);
                self.comp.set_divider_hover(divider_hover);
                if let Some((view, id, grab)) = self.bar_drag {
                    let local = self.comp.to_local(view, point);
                    self.drag_bar_to(view, id, local.1 - grab);
                    return Ok(());
                }
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                if self.inspect_mode {
                    let over = (view == self.inspect_view)
                        .then(|| self.comp.views[view].tree.hit_any(local.0, local.1))
                        .flatten();
                    if over != self.inspect_hover {
                        self.inspect_hover = over;
                        self.comp.dirty = true;
                    }
                }
                let bar_hover = self.bar_at(view, local).map(|id| (view, id));
                if bar_hover != self.bar_hover {
                    self.bar_hover = bar_hover;
                    self.comp.views[view].tree.mark_paint();
                }
                let hover = self.comp.views[view]
                    .tree
                    .hover_at(local.0, local.1)
                    .map(|id| (view, id));
                if hover != self.hover {
                    if let Some((old, _)) = self.hover {
                        self.comp.views[old].tree.mark_paint();
                    }
                    if let Some((new, _)) = hover {
                        self.comp.views[new].tree.mark_paint();
                    }
                    self.hover = hover;
                }
                if let Some((view, target)) = self.drag {
                    let local = self.comp.to_local(view, point);
                    match target {
                        DragTarget::Input(id) => {
                            let translated = Mouse {
                                x: local.0.max(0.0) as u32,
                                y: local.1.max(0.0) as u32,
                                ..mouse
                            };
                            self.forward_mouse(view, id, &translated, out)?;
                        }
                        DragTarget::Text => {
                            let fonts = &self.fonts;
                            self.comp.views[view]
                                .tree
                                .doc_select_drag((local.0, local.1), fonts);
                            if let Some((focus_view, _)) = self.focused()
                                && self.comp.views[view]
                                    .tree
                                    .doc_selection()
                                    .is_some_and(|sel| !sel.is_collapsed())
                            {
                                self.comp.views[focus_view].tree.set_focus(None);
                            }
                        }
                    }
                }
            }
            MouseKind::Up => {
                self.comp.divider_drag = false;
                self.bar_drag = None;
                if let Some((view, target)) = self.drag.take() {
                    match target {
                        DragTarget::Input(id) => {
                            let local = self.comp.to_local(view, point);
                            let translated = Mouse {
                                x: local.0.max(0.0) as u32,
                                y: local.1.max(0.0) as u32,
                                ..mouse
                            };
                            self.forward_mouse(view, id, &translated, out)?;
                        }
                        DragTarget::Text => self.comp.views[view].tree.doc_select_up(),
                    }
                }
            }
            MouseKind::ScrollLeft | MouseKind::ScrollRight => {
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                let delta = if mouse.kind == MouseKind::ScrollLeft {
                    -(self.cell.0 as f32)
                } else {
                    self.cell.0 as f32
                };
                self.emit_wheel(view, local, delta, 0.0, false, out);
            }
            MouseKind::ScrollUp | MouseKind::ScrollDown if !self.native_scroll_active() => {
                let view = self.comp.view_at(point.0);
                self.mark_scroll(view);
                let local = self.comp.to_local(view, point);
                let delta = if mouse.kind == MouseKind::ScrollUp {
                    -(self.cell.1 as f32)
                } else {
                    self.cell.1 as f32
                };
                if self.emit_wheel(view, local, 0.0, delta, false, out) {
                    return Ok(());
                }
                if let Some(area) = self.comp.views[view].tree.scroll_area_at(local.0, local.1) {
                    let max = area.max_scroll();
                    let node = area.node;
                    let profile = self.profile;
                    if let Some(state) = self.comp.views[view].tree.scroll_state_mut(node) {
                        state.tick(profile, delta, max);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn emit_wheel(
        &mut self,
        view: usize,
        local: (f32, f32),
        delta_x: f32,
        delta_y: f32,
        precise: bool,
        out: &mut Vec<EngineEvent>,
    ) -> bool {
        let tree = &self.comp.views[view].tree;
        let Some(node) = tree.hit_wheel(local.0, local.1) else {
            return false;
        };
        let rect = tree.rect(node).unwrap_or(crate::tree::PxRect::ZERO);
        out.push(EngineEvent::Wheel {
            view,
            node,
            key: tree.key_of(node).map(str::to_string),
            x: local.0 - rect.x,
            y: local.1 - rect.y,
            delta_x,
            delta_y,
            precise,
        });
        true
    }

    fn mark_pointer(&mut self, name: &'static str, point: (f32, f32)) {
        if !crate::profiler::is_recording() {
            return;
        }
        let view = self.comp.view_at(point.0);
        let local = self.comp.to_local(view, point);
        let target = self.comp.views[view]
            .tree
            .hit_click(local.0, local.1)
            .and_then(|id| self.comp.views[view].tree.key_of(id))
            .map(str::to_string);
        let label = match target {
            Some(key) => format!("{name} #{key}"),
            None => format!("{name} {},{}", local.0 as i32, local.1 as i32),
        };
        crate::profiler::mark(name, view as u32, label);
    }

    fn mark_scroll(&mut self, view: usize) {
        if !crate::profiler::is_recording() {
            return;
        }
        let now = Instant::now();
        let burst = self
            .last_scroll_mark
            .is_some_and(|at| now.duration_since(at).as_millis() < 350);
        self.scroll_burst = if burst { self.scroll_burst + 1 } else { 1 };
        self.last_scroll_mark = Some(now);
        crate::profiler::mark_or_extend(
            "scroll",
            view as u32,
            format!("scroll x{}", self.scroll_burst),
            350.0,
        );
    }

    fn finish_inspect(&mut self, local: (f32, f32), out: &mut Vec<EngineEvent>) {
        self.inspect_mode = false;
        let view = self.inspect_view;
        let node = self
            .inspect_hover
            .take()
            .or_else(|| self.comp.views[view].tree.hit_any(local.0, local.1));
        self.comp.dirty = true;
        let Some(node) = node else {
            return;
        };
        out.push(EngineEvent::Inspect {
            view,
            node,
            key: self.comp.views[view].tree.key_of(node).map(str::to_string),
            x: local.0,
            y: local.1,
        });
    }

    fn open_menu(&mut self, view: usize, at: (f32, f32)) {
        let size = self.comp.views[view].size;
        let focus = self.menu.open(
            &mut self.comp.views[view].tree,
            view,
            at,
            (size.0 as f32, size.1 as f32),
            self.base_px,
            &self.fonts[0],
            view == self.inspect_view,
        );
        if let Some(id) = focus {
            self.set_focus(view, Some(id));
        }
    }

    fn close_menu(&mut self) {
        if let Some(view) = self.menu.view() {
            self.menu.close(&mut self.comp.views[view].tree);
        }
    }

    fn handle_menu_click(
        &mut self,
        point: (f32, f32),
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<bool> {
        let Some(view) = self.menu.view() else {
            return Ok(false);
        };
        if self.comp.view_at(point.0) != view {
            self.close_menu();
            return Ok(true);
        }
        let local = self.comp.to_local(view, point);
        match self.menu.click(&mut self.comp.views[view].tree, local) {
            MenuClick::KeepOpen | MenuClick::Dismissed => {}
            MenuClick::Action(action) => self.apply_input_action(action, out)?,
            MenuClick::Devtools { target, at } => {
                if let Some(node) = target {
                    out.push(EngineEvent::Inspect {
                        view,
                        node,
                        key: self.comp.views[view].tree.key_of(node).map(str::to_string),
                        x: at.0,
                        y: at.1,
                    });
                }
            }
        }
        Ok(true)
    }

    fn forward_mouse(
        &mut self,
        view: usize,
        id: NodeId,
        mouse: &Mouse,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let Some(geometry) = self.comp.views[view].tree.input_geometry(id) else {
            return Ok(());
        };
        let fonts = &self.fonts;
        let Some(input) = self.comp.views[view].tree.input_mut(id) else {
            return Ok(());
        };
        let reply = input.handle_mouse(mouse, geometry, fonts);
        if reply != InputReply::None {
            self.finish_reply(view, id, reply, out)?;
        }
        Ok(())
    }

    fn finish_reply(
        &mut self,
        view: usize,
        id: NodeId,
        reply: InputReply,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        match reply {
            InputReply::None => {}
            InputReply::Selected => self.comp.views[view].tree.mark_paint(),
            InputReply::Moved => {
                self.reveal = true;
                self.comp.views[view].tree.mark_paint();
            }
            InputReply::Edited => {
                self.comp.views[view].tree.sync_input_text(id);
                self.reveal = true;
                self.push_change(view, id, out);
            }
            InputReply::Copy(text) => self.term.set_clipboard(&text)?,
            InputReply::Cut(text) => {
                self.term.set_clipboard(&text)?;
                self.comp.views[view].tree.sync_input_text(id);
                self.reveal = true;
                self.push_change(view, id, out);
            }
            InputReply::RequestPaste => self.term.request_clipboard()?,
        }
        Ok(())
    }

    fn submit_input(
        &mut self,
        view: usize,
        id: NodeId,
        out: &mut Vec<EngineEvent>,
    ) -> io::Result<()> {
        let text = self.comp.views[view]
            .tree
            .input_text(id)
            .unwrap_or_default()
            .to_string();
        out.push(EngineEvent::Submit {
            view,
            node: id,
            key: self.comp.views[view].tree.key_of(id).map(str::to_string),
            text,
        });
        self.comp.views[view]
            .tree
            .edit_input(id, |input| input.replace_all(""));
        self.finish_reply(view, id, InputReply::Edited, out)
    }

    fn push_change(&mut self, view: usize, id: NodeId, out: &mut Vec<EngineEvent>) {
        let Some(text) = self.comp.views[view].tree.input_text(id) else {
            return;
        };
        out.push(EngineEvent::Change {
            view,
            node: id,
            key: self.comp.views[view].tree.key_of(id).map(str::to_string),
            text: text.to_string(),
        });
    }

    fn bar_at(&self, view: usize, point: (f32, f32)) -> Option<NodeId> {
        let tree = &self.comp.views[view].tree;
        tree.scroll_nodes().into_iter().rev().find(|&id| {
            tree.bar_opacity(id) > 0.1
                && tree
                    .scrollbar_rects(id)
                    .is_some_and(|r| r.zone.contains(point.0, point.1))
        })
    }

    fn begin_bar_drag(&mut self, view: usize, point: (f32, f32)) -> bool {
        let Some(id) = self.bar_at(view, point) else {
            return false;
        };
        let Some(rects) = self.comp.views[view].tree.scrollbar_rects(id) else {
            return false;
        };
        let grab = if rects.thumb.contains(rects.thumb.x + 1.0, point.1) {
            point.1 - rects.thumb.y
        } else {
            let center_grab = rects.thumb.h / 2.0;
            self.drag_bar_to(view, id, point.1 - center_grab);
            center_grab
        };
        self.bar_drag = Some((view, id, grab));
        self.touch_bar(view, id);
        true
    }

    fn drag_bar_to(&mut self, view: usize, id: NodeId, thumb_y: f32) {
        let Some(position) = self.comp.views[view].tree.scroll_pos_for_thumb(id, thumb_y) else {
            return;
        };
        let tree = &mut self.comp.views[view].tree;
        if let Some(state) = tree.scroll_state_mut(id)
            && state.position != position
        {
            state.position = position;
            state.set_target(position);
            tree.mark_place();
            tree.touch_bar(id);
        }
    }

    fn touch_bar(&mut self, view: usize, id: NodeId) {
        self.comp.views[view].tree.touch_bar(id);
    }

    fn step_bars(&mut self, dt: f32) {
        let now = Instant::now();
        for view in self.comp.active_views() {
            for id in self.comp.views[view].tree.scroll_nodes() {
                let engaged = self.bar_hover == Some((view, id))
                    || self.bar_drag.map(|(v, d, _)| (v, d)) == Some((view, id));
                let tree = &mut self.comp.views[view].tree;
                if tree.step_bar(id, engaged, dt, now) {
                    tree.mark_paint();
                }
            }
        }
    }

    fn bars_animating(&self) -> bool {
        let now = Instant::now();
        self.comp.active_views().into_iter().any(|view| {
            let tree = &self.comp.views[view].tree;
            tree.scroll_nodes()
                .iter()
                .any(|&id| tree.bar_animating(id, now))
        })
    }

    fn emit_scroll_events(&mut self, out: &mut Vec<EngineEvent>) {
        for view in self.comp.active_views() {
            for id in self.comp.views[view].tree.scroll_nodes() {
                let tree = &mut self.comp.views[view].tree;
                let Some((key, offset, max)) = tree.take_scroll_emit(id) else {
                    continue;
                };
                out.push(EngineEvent::Scroll {
                    view,
                    node: id,
                    key,
                    offset,
                    max,
                });
            }
        }
    }

    pub fn scroll_to(&mut self, view: usize, id: NodeId, offset: f32, smooth: bool) {
        if view >= self.comp.views.len() {
            return;
        }
        let fonts = &self.fonts;
        let base_px = self.base_px;
        let tree = &mut self.comp.views[view].tree;
        tree.flush_layout(fonts, base_px);
        let max = tree.scroll_max(id);
        let offset = offset.clamp(0.0, max);
        if let Some(state) = tree.scroll_state_mut(id) {
            if smooth {
                state.set_target(offset);
            } else {
                state.position = offset;
                state.set_target(offset);
                tree.mark_place();
            }
            tree.touch_bar(id);
        }
    }

    fn drain_native(&mut self, out: &mut Vec<EngineEvent>) {
        let Some(native) = &mut self.native else {
            return;
        };
        let deltas = native.drain();
        let scale = native.scale;
        if !self.use_native || !self.term_focused || deltas.is_empty() {
            return;
        }
        let Some(cursor) = self.cursor else {
            return;
        };
        let view = self.comp.view_at(cursor.0);
        self.mark_scroll(view);
        let local = self.comp.to_local(view, cursor);
        if self.comp.views[view].tree.hit_wheel(local.0, local.1).is_some() {
            let cell_h = self.cell.1 as f32;
            let mut delta_y = 0.0;
            let mut precise = false;
            for delta in &deltas {
                if delta.precise {
                    delta_y -= delta.delta_y * scale;
                    precise = true;
                } else {
                    delta_y -= delta.delta_y * cell_h;
                }
            }
            self.emit_wheel(view, local, 0.0, delta_y, precise, out);
            return;
        }
        let Some(area) = self.comp.views[view].tree.scroll_area_at(local.0, local.1) else {
            return;
        };
        let (node, max) = (area.node, area.max_scroll());
        let cell_h = self.cell.1 as f32;
        let profile = self.profile;
        let mut moved = false;
        if let Some(state) = self.comp.views[view].tree.scroll_state_mut(node) {
            for delta in deltas {
                if delta.precise {
                    let next = (state.position - delta.delta_y * scale).clamp(0.0, max);
                    if next != state.position {
                        state.position = next;
                        moved = true;
                    }
                    state.set_target(next);
                } else {
                    state.tick(profile, -delta.delta_y * cell_h, max);
                }
            }
        }
        if moved {
            self.comp.views[view].tree.mark_place();
        }
        self.touch_bar(view, node);
    }

    fn step_scrolls(&mut self, dt: f32) {
        let profile = self.profile;
        for view in self.comp.active_views() {
            let tree = &mut self.comp.views[view].tree;
            for id in tree.scroll_nodes() {
                let max = tree.scroll_max(id);
                if let Some(state) = tree.scroll_state_mut(id)
                    && state.step(profile, dt, max)
                {
                    tree.mark_place();
                    tree.touch_bar(id);
                }
            }
        }
    }

    fn reveal_caret(&mut self) {
        let Some((view, focus)) = self.focused() else {
            return;
        };
        let fonts = &self.fonts;
        let base_px = self.base_px;
        self.comp.views[view].tree.flush_layout(fonts, base_px);
        let tree = &self.comp.views[view].tree;
        let Some(scroller) = tree.parent(focus).and_then(|p| tree.scroll_parent(p)) else {
            return;
        };
        let Some(area) = tree.scroll_area(scroller) else {
            return;
        };
        let Some(geometry) = tree.input_geometry(focus) else {
            return;
        };
        let Some(input) = tree.input(focus) else {
            return;
        };
        let text = input.text().to_string();
        let cursor = input.cursor();
        let Some(px) = tree.resolved_px(focus) else {
            return;
        };
        let caret = geometry.caret_rect(&text, cursor, &self.fonts);
        let margin = px * 1.1;
        let current = tree.scroll_state(scroller).map_or(0.0, |s| s.target);
        if let Some(target) = area.target_to_reveal(caret, current, margin)
            && let Some(state) = self.comp.views[view].tree.scroll_state_mut(scroller)
        {
            state.set_target(target);
        }
    }

    fn frame(&mut self) -> io::Result<()> {
        let active = self.comp.active_views();
        let views_dirty = active.iter().any(|&v| self.comp.views[v].tree.dirty());
        if !views_dirty && !self.comp.dirty {
            return Ok(());
        }
        crate::profiler::span("frame", || -> io::Result<()> {
            let start = Instant::now();
            for i in active {
                if !self.comp.views[i].tree.dirty() {
                    continue;
                }
                let size = self.comp.views[i].size;
                if size.0 == 0 || size.1 == 0 {
                    continue;
                }
                crate::profiler::set_view(i as u32);
                let cursor = self
                    .cursor
                    .filter(|&(x, _)| self.comp.view_at(x) == i)
                    .map(|c| self.comp.to_local(i, c));
                let fonts = &self.fonts;
                let base_px = self.base_px;
                let view = &mut self.comp.views[i];
                crate::profiler::span("canvas.clear", || {
                    if (view.canvas.width, view.canvas.height) != size {
                        view.canvas = Canvas::new(size.0, size.1);
                    }
                    view.canvas.fill(view.clear_color);
                });
                view.tree.flush_layout(fonts, base_px);
                paint(&view.tree, &mut view.canvas, fonts, cursor);
                view.tree.clear_paint_flag();
                self.comp.dirty = true;
            }
            crate::profiler::set_view(0);
            if !self.comp.dirty {
                return Ok(());
            }
            self.compose();
            let bytes = crate::profiler::span("draw", || self.term.draw(&self.comp.frame))?;
            crate::profiler::count("bytes", bytes as u64);

            let gap = start.duration_since(self.last_frame).as_secs_f32();
            self.last_frame = start;
            let ema = |old: f32, new: f32| {
                if old == 0.0 {
                    new
                } else {
                    old * 0.9 + new * 0.1
                }
            };
            self.stats.frame_ms = ema(self.stats.frame_ms, start.elapsed().as_secs_f32() * 1000.0);
            if gap < 0.25 {
                self.stats.fps = ema(self.stats.fps, 1.0 / gap);
            }
            Ok(())
        })
    }

    fn compose(&mut self) {
        crate::profiler::span("compose", || {
            self.comp.compose();
            if let Some((view, id)) = self.highlight {
                self.draw_node_overlay(view, id, false);
            }
            if self.inspect_mode
                && let Some(id) = self.inspect_hover
            {
                self.draw_node_overlay(self.inspect_view, id, true);
            }
        });
        self.comp.dirty = false;
    }

    fn draw_node_overlay(&mut self, view: usize, id: NodeId, with_label: bool) {
        if !self.comp.is_active(view) {
            return;
        }
        let Some(v) = self.comp.views.get(view) else {
            return;
        };
        let Some(rect) = v.tree.visible_rect(id) else {
            return;
        };
        if rect.w <= 0.0 || rect.h <= 0.0 {
            return;
        }
        let x = rect.x + v.origin_x as f32;
        let key = v.tree.key_of(id).map(str::to_string);
        self.comp.frame
            .fill_rounded_rect(x, rect.y, rect.w, rect.h, 0.0, HIGHLIGHT_FILL);
        self.comp.frame.stroke_rounded_rect(
            x,
            rect.y,
            rect.w,
            rect.h,
            0.0,
            1.0,
            HIGHLIGHT_BORDER,
        );
        if !with_label {
            return;
        }
        let px = self.base_px * 0.85;
        let label = match key {
            Some(key) => format!("{key}  {:.0} × {:.0}", rect.w, rect.h),
            None => format!("{:.0} × {:.0}", rect.w, rect.h),
        };
        let font = &self.fonts[0];
        let text_w = measure_text(font, &label, px);
        let line_h = crate::text_input::line_height(font, px);
        let pad = px * 0.4;
        let (w, h) = (text_w + pad * 2.0, line_h + pad);
        let lx = (x).min(self.comp.window.0 as f32 - w).max(0.0);
        let mut ly = rect.y + rect.h + 4.0;
        if ly + h > self.comp.window.1 as f32 {
            ly = (rect.y - h - 4.0).max(0.0);
        }
        self.comp.frame
            .fill_rounded_rect(lx, ly, w, h, 4.0, [24, 26, 32, 245]);
        self.comp.frame
            .stroke_rounded_rect(lx, ly, w, h, 4.0, 1.0, [72, 75, 86, 255]);
        if let Some(metrics) = font.horizontal_line_metrics(px) {
            self.comp.frame.draw_text(
                font,
                &label,
                (lx + pad) as i32,
                (ly + pad / 2.0 + metrics.ascent) as i32,
                px,
                [186, 210, 255, 255],
            );
        }
    }
}

pub fn px_for_cell_height(font: &fontdue::Font, cell_height: f32) -> f32 {
    let probe = font
        .horizontal_line_metrics(100.0)
        .expect("font has horizontal metrics");
    (cell_height * 100.0 / probe.new_line_size).clamp(6.0, 512.0)
}
