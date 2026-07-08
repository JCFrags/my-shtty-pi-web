mod transcript;
mod ui;

use std::time::{Duration, Instant};

use pixel_core::profiler as prof;
use pixel_core::{
    Canvas, Event, Key, MouseKind, NativeScroll, Profiler, ScrollState, Terminal, fontdue,
    render_scene,
};
use ui::{
    App, FONT_MONO, FONT_UI, Theme, build_ui, editor_max_scroll, paint_caret, px_for_cell_height,
};

static UI_FONT_BYTES: &[u8] = include_bytes!("../assets/InterVariable.ttf");
static MONO_FONT_BYTES: &[u8] = include_bytes!("../assets/JetBrainsMono-Regular.ttf");

const SYSTEM_UI_FONTS: &[&str] = &["/System/Library/Fonts/SFNS.ttf"];
const SYSTEM_MONO_FONTS: &[&str] = &["/System/Library/Fonts/SFNSMono.ttf"];

const FALLBACK_CELL: (u32, u32) = (16, 32);

const FRAME_POLL: Duration = Duration::from_millis(6);

/// The system fonts can't be bundled (Apple license), but loading the user's
/// own installed copy at runtime is fine; bundled fonts cover every miss.
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

fn main() -> std::io::Result<()> {
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
    // The ioctl reports the exact grid pixel size where supported; derive
    // from cell size only when it doesn't.
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
    // Pane pixels can exceed the cell grid; an image taller than the grid
    // line-feeds past the bottom and scrolls everything.
    if cell.is_some() {
        window = (window.0 / cell_w * cell_w, window.1 / cell_h * cell_h);
    }
    let px = px_for_cell_height(&fonts[FONT_MONO], cell_h as f32);

    let mut app = App {
        notes: transcript::demo_notes(),
        active: 0,
        theme,
        editor_scroll: 0.0,
        follow: true,
        scroll_profile: 0,
        native: false,
        stats: ui::FrameStats::default(),
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
            build_ui(app, window, px, recording),
            &mut canvas,
            &fonts,
            px,
            cursor,
        );
        prof::span("editor.paint", || {
            paint_caret(&mut canvas, &scene, &fonts[FONT_UI], px, app)
        });
        (canvas, scene)
    };

    let (canvas, mut scene) = render_frame(&app, false, None);
    term.draw(&canvas)?;

    let mut scroll = ScrollState::default();
    let mut last_frame = Instant::now();
    'session: loop {
        let animating = !scroll.settled();
        // Native deltas arrive on a channel poll() can't see, so native mode
        // keeps the loop on a frame clock while the terminal is focused.
        let mut event = if animating || (app.native_active() && focused) {
            term.poll_event(Some(FRAME_POLL))?
        } else {
            Some(term.read_event()?)
        };
        let mut dirty = false;
        while let Some(current) = event {
            match current {
                Event::Key(key) => match key {
                    Key::Ctrl('c') => break 'session,
                    Key::Ctrl('p') => {
                        profiler.toggle()?;
                        dirty = true;
                    }
                    Key::Ctrl('s') => {
                        app.cycle_scroll_profile();
                        dirty = true;
                    }
                    Key::Backspace => {
                        app.notes[app.active].text.pop();
                        app.follow = true;
                        dirty = true;
                    }
                    Key::Enter => {
                        app.notes[app.active].text.push('\n');
                        app.follow = true;
                        dirty = true;
                    }
                    Key::Char(c) if !c.is_control() => {
                        app.notes[app.active].text.push(c);
                        app.follow = true;
                        dirty = true;
                    }
                    _ => {}
                },
                Event::Mouse(mouse) => {
                    let point = (mouse.x as f32, mouse.y as f32);
                    match mouse.kind {
                        MouseKind::Down => {
                            dirty |= scene.dispatch_click(point.0, point.1, &mut app);
                        }
                        MouseKind::Move => {
                            cursor = Some(point);
                            let new_hover = scene.hover_target(point.0, point.1);
                            if new_hover != hover {
                                hover = new_hover;
                                dirty = true;
                            }
                        }
                        MouseKind::ScrollUp | MouseKind::ScrollDown if !app.native_active() => {
                            if let Some(area) = scene.scroll_area_at(point.0, point.1)
                                && area.id == Some("editor")
                            {
                                let tick = if mouse.kind == MouseKind::ScrollUp {
                                    -(cell_h as f32)
                                } else {
                                    cell_h as f32
                                };
                                scroll.tick(app.profile(), tick, area.max_scroll());
                                app.follow = false;
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
                .filter(|area| area.id == Some("editor"));
            if app.native_active()
                && focused
                && let Some(area) = over_editor
            {
                for delta in deltas {
                    // Positive delta_y means fingers scrolling toward the top
                    // of the content, i.e. the offset decreases.
                    let px_delta = if delta.precise {
                        delta.delta_y * scale
                    } else {
                        delta.delta_y * cell_h as f32
                    };
                    let next = (scroll.position - px_delta).clamp(0.0, area.max_scroll());
                    if next != scroll.position {
                        scroll.position = next;
                        scroll.set_target(next);
                        app.follow = false;
                        dirty = true;
                    }
                }
            }
        }

        if app.follow
            && let Some(editor) = scene.rect("editor")
        {
            scroll.set_target(editor_max_scroll(&app, &fonts[FONT_UI], px, editor.h));
        }

        let now = Instant::now();
        let gap = now.duration_since(last_frame).as_secs_f32();
        // Cap dt so the first frame after an idle stretch steps, not jumps.
        let dt = gap.min(0.05);
        let max = scene
            .scroll_area("editor")
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
