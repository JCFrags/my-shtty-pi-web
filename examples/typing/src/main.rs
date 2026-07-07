mod ui;

use pixel_core::profiler as prof;
use pixel_core::{Canvas, Event, Key, MouseKind, Profiler, Terminal, fontdue, render_scene};
use ui::{App, FONT_MONO, FONT_UI, Note, Theme, build_ui, paint_editor, px_for_cell_height};

static UI_FONT_BYTES: &[u8] = include_bytes!("../assets/InterVariable.ttf");
static MONO_FONT_BYTES: &[u8] = include_bytes!("../assets/JetBrainsMono-Regular.ttf");

const SYSTEM_UI_FONTS: &[&str] = &["/System/Library/Fonts/SFNS.ttf"];
const SYSTEM_MONO_FONTS: &[&str] = &["/System/Library/Fonts/SFNSMono.ttf"];

const FALLBACK_CELL: (u32, u32) = (16, 32);

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
    let (cell_w, cell_h) = term.cell_size()?.unwrap_or(FALLBACK_CELL);
    let cols = if ws.cols > 0 { ws.cols } else { 80 };
    let rows = if ws.rows > 0 { ws.rows } else { 24 };
    // The ioctl reports the exact grid pixel size where supported; derive
    // from cell size only when it doesn't.
    let window = (
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
    let px = px_for_cell_height(&fonts[FONT_MONO], cell_h as f32);

    let mut app = App {
        notes: vec![
            Note {
                title: "welcome".into(),
                text: "click notes on the left,\nor start typing here".into(),
            },
            Note {
                title: "scratch".into(),
                text: String::new(),
            },
            Note {
                title: "ideas".into(),
                text: String::new(),
            },
        ],
        active: 0,
        theme,
    };
    let mut profiler = Profiler::new();
    let mut cursor: Option<(f32, f32)> = None;
    let mut hover: Option<usize> = None;

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
            paint_editor(&mut canvas, &scene, &fonts[FONT_UI], px, app)
        });
        (canvas, scene)
    };

    let (canvas, mut scene) = render_frame(&app, false, None);
    term.draw(&canvas)?;
    loop {
        match term.read_event()? {
            Event::Key(key) => match key {
                Key::Ctrl('c') => break,
                Key::Ctrl('p') => {
                    profiler.toggle()?;
                }
                Key::Backspace => {
                    app.notes[app.active].text.pop();
                }
                Key::Enter => app.notes[app.active].text.push('\n'),
                Key::Char(c) if !c.is_control() => app.notes[app.active].text.push(c),
                _ => continue,
            },
            Event::Mouse(mouse) => {
                let point = (mouse.x as f32, mouse.y as f32);
                match mouse.kind {
                    MouseKind::Down => {
                        if !scene.dispatch_click(point.0, point.1, &mut app) {
                            continue;
                        }
                    }
                    MouseKind::Move => {
                        cursor = Some(point);
                        let new_hover = scene.hover_target(point.0, point.1);
                        if new_hover == hover {
                            continue;
                        }
                        hover = new_hover;
                    }
                    _ => continue,
                }
            }
        }

        profiler.begin_frame();
        let recording = profiler.is_recording();
        let (canvas, new_scene) = profiler.span("render", || render_frame(&app, recording, cursor));
        scene = new_scene;
        let bytes = profiler.span("draw", || term.draw(&canvas))?;
        profiler.count("bytes", bytes as u64);
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
