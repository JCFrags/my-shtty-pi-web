mod ui;

use pixel_core::{Event, Key, MouseKind, Profiler, Terminal, fontdue};
use ui::{Frame, px_for_cell_height, render};

static FONT_BYTES: &[u8] = include_bytes!("../assets/JetBrainsMono-Regular.ttf");

const FALLBACK_CELL: (u32, u32) = (16, 32);

struct Tab {
    title: &'static str,
    text: String,
}

fn frame<'a>(
    font: &'a fontdue::Font,
    px: f32,
    window: (u32, u32),
    tabs: &'a [Tab],
    active: usize,
    recording: bool,
) -> Frame<'a> {
    Frame {
        font,
        px,
        window,
        tab_titles: tabs.iter().map(|t| t.title).collect(),
        active,
        text: &tabs[active].text,
        recording,
    }
}

fn main() -> std::io::Result<()> {
    let font = fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default())
        .expect("bundled font parses");

    let mut term = Terminal::new()?;
    let ws = term.size()?;
    let (cell_w, cell_h) = term.cell_size()?.unwrap_or(FALLBACK_CELL);
    let cols = if ws.cols > 0 { ws.cols } else { 80 };
    let rows = if ws.rows > 0 { ws.rows } else { 24 };
    // One row shorter than the window so the image can't force a scroll.
    let window = (cols * cell_w, (rows.saturating_sub(1)) * cell_h);
    let px = px_for_cell_height(&font, cell_h as f32);

    let mut tabs = vec![
        Tab {
            title: "notes",
            text: String::new(),
        },
        Tab {
            title: "scratch",
            text: String::new(),
        },
        Tab {
            title: "todo",
            text: String::new(),
        },
    ];
    let mut active = 0;
    let mut profiler = Profiler::new();

    let (canvas, mut last_ui) = render(&frame(&font, px, window, &tabs, active, false));
    term.draw(&canvas)?;
    loop {
        match term.read_event()? {
            Event::Key(key) => match key {
                Key::Ctrl('c') => break,
                Key::Ctrl('p') => {
                    profiler.toggle()?;
                }
                Key::Backspace => {
                    tabs[active].text.pop();
                }
                Key::Enter => tabs[active].text.push('\n'),
                Key::Char(c) if !c.is_control() => tabs[active].text.push(c),
                _ => continue,
            },
            Event::Mouse(mouse) if mouse.kind == MouseKind::Down => {
                let hit = last_ui
                    .tabs
                    .iter()
                    .position(|rect| rect.contains(mouse.x as f32, mouse.y as f32));
                match hit {
                    Some(i) if i != active => active = i,
                    _ => continue,
                }
            }
            Event::Mouse(_) => continue,
        }

        profiler.begin_frame();
        let recording = profiler.is_recording();
        let (canvas, new_ui) = profiler.span("render", || {
            render(&frame(&font, px, window, &tabs, active, recording))
        });
        last_ui = new_ui;
        let bytes = profiler.span("draw", || term.draw(&canvas))?;
        profiler.count("bytes", bytes as u64);
    }
    Ok(())
}
