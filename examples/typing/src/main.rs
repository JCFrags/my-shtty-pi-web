mod transcript;
mod ui;

use std::time::{Duration, Instant};

use pixel_core::profiler as prof;
use pixel_core::{
    CONTEXT_MENU_ID, Canvas, Event, InputReply, Key, MouseButton, MouseKind, NativeScroll,
    Profiler, ScrollState, Terminal, fontdue, render_scene,
};
use ui::{
    App, EDITOR, EDITOR_INPUT, FONT_MONO, FONT_UI, Theme, build_ui, editor_pad,
    px_for_cell_height,
};

static UI_FONT_BYTES: &[u8] = include_bytes!("../assets/InterVariable.ttf");
static MONO_FONT_BYTES: &[u8] = include_bytes!("../assets/JetBrainsMono-Regular.ttf");

const SYSTEM_UI_FONTS: &[&str] = &["/System/Library/Fonts/SFNS.ttf"];
const SYSTEM_MONO_FONTS: &[&str] = &["/System/Library/Fonts/SFNSMono.ttf"];

const FALLBACK_CELL: (u32, u32) = (16, 32);

const FRAME_POLL: Duration = Duration::from_millis(6);

fn load_font(candidates: &[&str], fallback: &'static [u8]) -> fontdue::Font {
    let parse = |bytes: &[u8]| fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default());
    if cfg!(target_os = "macos") {
        for path in candidates {
            if let Ok(bytes) = std::fs::read(path)
                && let Ok(font) = parse(&bytes)
            {
                return font;
            }
        }
    }
    parse(fallback).expect("bundled font parses")
}

const GHOSTTY_KEYBINDS: &[&str] = &[
    "super+z=unbind",
    "super+shift+z=unbind",
    "super+a=unbind",
    "super+up=unbind",
    "super+down=unbind",
    "super+shift+up=unbind",
    "super+shift+down=unbind",
];

fn main() -> std::io::Result<()> {
    if std::env::args().any(|arg| arg == "--keys") {
        return key_dump();
    }
    if std::env::args().any(|arg| arg == "--setup-ghostty") {
        let claim = pixel_core::ghostty::claim_keybinds("typing", GHOSTTY_KEYBINDS)?;
        println!("{claim:?}");
        return Ok(());
    }
    let _ = pixel_core::ghostty::claim_keybinds("typing", GHOSTTY_KEYBINDS);
    let fonts = [
        load_font(SYSTEM_UI_FONTS, UI_FONT_BYTES),
        load_font(SYSTEM_MONO_FONTS, MONO_FONT_BYTES),
    ];

    let mut term = Terminal::new()?;
    let theme = Theme::from_terminal(&term.query_colors()?);
    let ws = term.size()?;
    let cell = term.cell_size()?;
    let (cell_w, cell_h) = cell.unwrap_or(FALLBACK_CELL);
    let cols = if ws.cols > 0 { ws.cols } else { 80 };
    let rows = if ws.rows > 0 { ws.rows } else { 24 };
    let mut window = (
        if ws.width_px > 0 {
            ws.width_px
        } else {
            cols * cell_w
        },
        if ws.height_px > 0 {
            ws.height_px
        } else {
            rows * cell_h
        },
    );
    if cell.is_some() {
        window = (window.0 / cell_w * cell_w, window.1 / cell_h * cell_h);
    }
    let px = px_for_cell_height(&fonts[FONT_MONO], cell_h as f32);

    let mut app = App {
        notes: transcript::demo_notes(),
        active: 0,
        theme,
        editor_scroll: 0.0,
        reveal_caret: true,
        scroll_profile: 0,
        native: false,
        stats: ui::FrameStats::default(),
        context_menu: None,
        pending: None,
    };
    let mut native = NativeScroll::spawn();
    if native.is_some() {
        app.enable_native();
    }
    let mut profiler = Profiler::new();
    let mut cursor: Option<(f32, f32)> = None;
    let mut hover: Option<usize> = None;
    let mut focused = true;

    let render_frame = |app: &App, recording: bool, cursor: Option<(f32, f32)>| {
        let mut canvas = prof::span("canvas.clear", || {
            let mut canvas = Canvas::new(window.0, window.1);
            canvas.fill(app.theme.bg);
            canvas
        });
        let scene = render_scene(
            build_ui(app, window, px, recording, &fonts[FONT_UI]),
            &mut canvas,
            &fonts,
            px,
            cursor,
        );
        (canvas, scene)
    };

    let (canvas, mut scene) = render_frame(&app, false, None);
    term.draw(&canvas)?;

    let mut scroll = ScrollState::default();
    let mut last_frame = Instant::now();
    'session: loop {
        let animating = !scroll.settled();
        let mut event = if animating || (app.native_active() && focused) {
            term.poll_event(Some(FRAME_POLL))?
        } else {
            Some(term.read_event()?)
        };
        let mut dirty = false;
        while let Some(current) = event {
            match current {
                Event::Key(key) => {
                    let menu_was_open = app.context_menu.take().is_some();
                    if menu_was_open {
                        dirty = true;
                        if key.key == Key::Escape {
                            event = term.poll_event(Some(Duration::ZERO))?;
                            continue;
                        }
                    }
                    let mods = key.mods;
                    match key.key {
                        Key::Char('q') if mods.ctrl => break 'session,
                        Key::Char('p') if mods.ctrl => {
                            profiler.toggle()?;
                            dirty = true;
                        }
                        Key::Char('s') if mods.ctrl => {
                            app.cycle_scroll_profile();
                            dirty = true;
                        }
                        Key::Char('c')
                            if mods.ctrl
                                && !mods.sup
                                && app.notes[app.active].input.selection().is_none() =>
                        {
                            break 'session;
                        }
                        _ => {
                            let reply =
                                app.notes[app.active].input.handle_key(key, &fonts[FONT_UI], px);
                            dirty |= apply_reply(&mut app, &mut term, reply)?;
                        }
                    }
                }
                Event::Paste(text) => {
                    app.notes[app.active].input.insert(&text);
                    dirty = true;
                    app.reveal_caret = true;
                }
                Event::Mouse(mouse) => {
                    let point = (mouse.x as f32, mouse.y as f32);
                    match mouse.kind {
                        MouseKind::Down if mouse.button == MouseButton::Left => {
                            if app.context_menu.take().is_some() {
                                dirty = true;
                                let on_menu = scene
                                    .rect(CONTEXT_MENU_ID)
                                    .is_some_and(|r| r.contains(point.0, point.1));
                                if on_menu {
                                    scene.dispatch_click(point.0, point.1, &mut app);
                                }
                                event = term.poll_event(Some(Duration::ZERO))?;
                                continue;
                            }
                            let on_editor = scene
                                .rect(EDITOR)
                                .is_some_and(|r| r.contains(point.0, point.1));
                            match scene.input_geometry(EDITOR_INPUT) {
                                Some(geometry) if on_editor => {
                                    let reply = app.notes[app.active]
                                        .input
                                        .handle_mouse(&mouse, geometry, &fonts);
                                    dirty |= apply_reply(&mut app, &mut term, reply)?;
                                }
                                _ => dirty |= scene.dispatch_click(point.0, point.1, &mut app),
                            }
                        }
                        MouseKind::Down if mouse.button == MouseButton::Right => {
                            let on_editor = scene
                                .rect(EDITOR)
                                .is_some_and(|r| r.contains(point.0, point.1));
                            if on_editor {
                                if let Some(geometry) = scene.input_geometry(EDITOR_INPUT) {
                                    let input = &mut app.notes[app.active].input;
                                    let offset = geometry.offset_at(input.text(), point, &fonts);
                                    if !input.selection().is_some_and(|sel| sel.contains(&offset))
                                    {
                                        input.set_cursor(offset, false);
                                    }
                                }
                                app.context_menu = Some(point);
                                dirty = true;
                            }
                        }
                        MouseKind::Up | MouseKind::Move => {
                            if mouse.kind == MouseKind::Move {
                                cursor = Some(point);
                                let new_hover = scene.hover_target(point.0, point.1);
                                if new_hover != hover {
                                    hover = new_hover;
                                    dirty = true;
                                }
                            }
                            if let Some(geometry) = scene.input_geometry(EDITOR_INPUT) {
                                let reply = app.notes[app.active]
                                    .input
                                    .handle_mouse(&mouse, geometry, &fonts);
                                dirty |= apply_reply(&mut app, &mut term, reply)?;
                            }
                        }
                        MouseKind::ScrollUp | MouseKind::ScrollDown if !app.native_active() => {
                            if app.context_menu.take().is_some() {
                                dirty = true;
                            }
                            if let Some(area) = scene.scroll_area_at(point.0, point.1)
                                && area.id == Some(EDITOR)
                            {
                                let tick = if mouse.kind == MouseKind::ScrollUp {
                                    -(cell_h as f32)
                                } else {
                                    cell_h as f32
                                };
                                scroll.tick(app.profile(), tick, area.max_scroll());
                            }
                        }
                        _ => {}
                    }
                }
                Event::Focus(f) => focused = f,
            }
            event = term.poll_event(Some(Duration::ZERO))?;
        }

        if let Some(native) = &mut native {
            let deltas = native.drain();
            let scale = native.scale;
            let over_editor = cursor
                .and_then(|(x, y)| scene.scroll_area_at(x, y))
                .filter(|area| area.id == Some(EDITOR));
            if app.native_active()
                && focused
                && let Some(area) = over_editor
            {
                for delta in deltas {
                    let px_delta = if delta.precise {
                        delta.delta_y * scale
                    } else {
                        delta.delta_y * cell_h as f32
                    };
                    let next = (scroll.position - px_delta).clamp(0.0, area.max_scroll());
                    if next != scroll.position {
                        scroll.position = next;
                        scroll.set_target(next);
                        dirty = true;
                    }
                }
            }
        }

        if let Some(action) = app.pending.take() {
            let reply = app.notes[app.active].input.apply(action);
            dirty |= apply_reply(&mut app, &mut term, reply)?;
        }

        if app.reveal_caret {
            app.reveal_caret = false;
            let input = &app.notes[app.active].input;
            if let Some(area) = scene.scroll_area(EDITOR)
                && let Some(geometry) = scene.input_geometry(EDITOR_INPUT)
                && let Some(target) = area.target_to_reveal(
                    geometry.caret_rect(input.text(), input.cursor(), &fonts),
                    scroll.target,
                    editor_pad(px),
                )
            {
                scroll.set_target(target);
            }
        }

        let now = Instant::now();
        let gap = now.duration_since(last_frame).as_secs_f32();
        let dt = gap.min(0.05);
        let max = scene
            .scroll_area(EDITOR)
            .map(|area| area.max_scroll())
            .unwrap_or(0.0);
        dirty |= scroll.step(app.profile(), dt, max);
        app.editor_scroll = scroll.position;
        if !dirty {
            continue;
        }
        last_frame = now;

        profiler.begin_frame();
        let recording = profiler.is_recording();
        let (canvas, new_scene) = profiler.span("render", || render_frame(&app, recording, cursor));
        scene = new_scene;
        let bytes = profiler.span("draw", || term.draw(&canvas))?;
        profiler.count("bytes", bytes as u64);

        let ema = |old: f32, new: f32| if old == 0.0 { new } else { old * 0.9 + new * 0.1 };
        app.stats.frame_ms = ema(app.stats.frame_ms, now.elapsed().as_secs_f32() * 1000.0);
        // Gaps across idle stretches aren't a frame rate; only count cadence.
        if gap < 0.25 {
            app.stats.fps = ema(app.stats.fps, 1.0 / gap);
        }
    }
    Ok(())
}

fn apply_reply(app: &mut App, term: &mut Terminal, reply: InputReply) -> std::io::Result<bool> {
    Ok(match reply {
        InputReply::None => false,
        InputReply::Selected => true,
        InputReply::Moved | InputReply::Edited => {
            app.reveal_caret = true;
            true
        }
        InputReply::Copy(text) => {
            term.set_clipboard(&text)?;
            false
        }
        InputReply::Cut(text) => {
            term.set_clipboard(&text)?;
            app.reveal_caret = true;
            true
        }
        InputReply::RequestPaste => {
            term.request_clipboard()?;
            false
        }
    })
}

fn key_dump() -> std::io::Result<()> {
    use std::io::Write as _;
    let mut term = Terminal::new()?;
    let mut out = std::io::stdout();
    write!(out, "key dump — press keys; ctrl-q or ctrl-c quits\r\n")?;
    out.flush()?;
    loop {
        match term.read_event()? {
            Event::Key(k) => {
                write!(out, "{k:?}\r\n")?;
                out.flush()?;
                if k.mods.ctrl && matches!(k.key, Key::Char('q') | Key::Char('c')) {
                    return Ok(());
                }
            }
            Event::Paste(text) => {
                write!(out, "Paste({text:?})\r\n")?;
                out.flush()?;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn system_fonts_parse_when_present() {
        for path in SYSTEM_UI_FONTS.iter().chain(SYSTEM_MONO_FONTS) {
            let Ok(bytes) = std::fs::read(path) else {
                continue;
            };
            fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default())
                .unwrap_or_else(|e| panic!("{path} exists but fontdue rejected it: {e}"));
        }
    }
}
