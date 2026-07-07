use pixel_core::taffy::prelude::*;
use pixel_core::taffy::{Size as TSize, TaffyTree};
use pixel_core::{Canvas, Key, Profiler, Terminal, fontdue, measure_text};

static FONT_BYTES: &[u8] = include_bytes!("../assets/JetBrainsMono-Regular.ttf");

const PAD: f32 = 12.0;
const BG: [u8; 4] = [24, 24, 32, 255];
const FG: [u8; 4] = [230, 230, 240, 255];
const CARET: [u8; 4] = [120, 220, 160, 255];
const STATUS_BG: [u8; 4] = [40, 40, 54, 255];
const STATUS_FG: [u8; 4] = [150, 150, 168, 255];
const RECORDING_DOT: [u8; 4] = [235, 80, 80, 255];
const FALLBACK_CELL: (u32, u32) = (16, 32);

fn px_for_cell_height(font: &fontdue::Font, cell_height: f32) -> f32 {
    let probe = font
        .horizontal_line_metrics(100.0)
        .expect("font has horizontal metrics");
    (cell_height * 100.0 / probe.new_line_size).clamp(6.0, 512.0)
}

struct PxRect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

struct Ui {
    editor: PxRect,
    status_bar: PxRect,
    status_left: PxRect,
    status_right: PxRect,
}

fn layout_ui(
    font: &fontdue::Font,
    px: f32,
    line_height: f32,
    window: (f32, f32),
    left_label: &str,
    right_label: &str,
) -> Ui {
    let mut tree: TaffyTree<String> = TaffyTree::new();

    let status_left = tree
        .new_leaf_with_context(Style::default(), left_label.to_string())
        .expect("leaf");
    let status_right = tree
        .new_leaf_with_context(Style::default(), right_label.to_string())
        .expect("leaf");
    let status_bar = tree
        .new_with_children(
            Style {
                flex_direction: FlexDirection::Row,
                justify_content: Some(JustifyContent::SpaceBetween),
                align_items: Some(AlignItems::Center),
                size: TSize {
                    width: percent(1.0),
                    height: length(line_height + PAD),
                },
                padding: Rect {
                    left: length(PAD),
                    right: length(PAD),
                    top: zero(),
                    bottom: zero(),
                },
                ..Default::default()
            },
            &[status_left, status_right],
        )
        .expect("status bar");
    let editor = tree
        .new_leaf(Style {
            flex_grow: 1.0,
            ..Default::default()
        })
        .expect("editor");
    let root = tree
        .new_with_children(
            Style {
                flex_direction: FlexDirection::Column,
                size: TSize {
                    width: length(window.0),
                    height: length(window.1),
                },
                ..Default::default()
            },
            &[editor, status_bar],
        )
        .expect("root");

    tree.compute_layout_with_measure(
        root,
        TSize::MAX_CONTENT,
        |_known, _available, _node, context, _style| match context {
            Some(text) => TSize {
                width: measure_text(font, text, px),
                height: line_height,
            },
            None => TSize::ZERO,
        },
    )
    .expect("layout");

    let abs = |layout: &pixel_core::taffy::Layout, dx: f32, dy: f32| PxRect {
        x: layout.location.x + dx,
        y: layout.location.y + dy,
        w: layout.size.width,
        h: layout.size.height,
    };
    let bar = tree.layout(status_bar).expect("layout").to_owned();
    Ui {
        editor: abs(tree.layout(editor).expect("layout"), 0.0, 0.0),
        status_left: abs(
            tree.layout(status_left).expect("layout"),
            bar.location.x,
            bar.location.y,
        ),
        status_right: abs(
            tree.layout(status_right).expect("layout"),
            bar.location.x,
            bar.location.y,
        ),
        status_bar: abs(&bar, 0.0, 0.0),
    }
}

fn render(
    font: &fontdue::Font,
    text: &str,
    px: f32,
    window: (u32, u32),
    recording: bool,
) -> Canvas {
    let line_metrics = font
        .horizontal_line_metrics(px)
        .expect("font has horizontal metrics");
    let line_height = line_metrics.new_line_size;
    let ascent = line_metrics.ascent;

    let char_count = format!("{} chars", text.chars().count());
    let ui = layout_ui(
        font,
        px,
        line_height,
        (window.0 as f32, window.1 as f32),
        "ctrl-p: profile | ctrl-c: quit",
        &char_count,
    );

    let mut canvas = Canvas::new(window.0, window.1);
    canvas.fill(BG);
    canvas.fill_rect(
        ui.status_bar.x as u32,
        ui.status_bar.y as u32,
        ui.status_bar.w as u32,
        ui.status_bar.h as u32,
        STATUS_BG,
    );

    let lines: Vec<&str> = text.split('\n').collect();
    let editor_bottom = ui.editor.y + ui.editor.h - PAD;
    let mut caret_line: Option<(usize, f32)> = None;
    for (i, line) in lines.iter().enumerate() {
        let top = ui.editor.y + PAD + line_height * i as f32;
        if top + line_height > editor_bottom {
            break;
        }
        canvas.draw_text(
            font,
            line,
            (ui.editor.x + PAD) as i32,
            (top + ascent) as i32,
            px,
            FG,
        );
        caret_line = Some((i, top));
    }
    if let Some((i, top)) = caret_line
        && i == lines.len() - 1
    {
        let caret_x = ui.editor.x + PAD + measure_text(font, lines[i], px);
        let caret_w = (px / 8.0).max(2.0) as u32;
        canvas.fill_rect(
            caret_x as u32,
            top as u32,
            caret_w,
            line_height as u32,
            CARET,
        );
    }

    let status_baseline_offset = (line_height - (ascent - line_metrics.descent)) / 2.0 + ascent;
    canvas.draw_text(
        font,
        "ctrl-p: profile | ctrl-c: quit",
        ui.status_left.x as i32,
        (ui.status_left.y + status_baseline_offset) as i32,
        px,
        STATUS_FG,
    );
    canvas.draw_text(
        font,
        &char_count,
        ui.status_right.x as i32,
        (ui.status_right.y + status_baseline_offset) as i32,
        px,
        STATUS_FG,
    );
    if recording {
        let dot = (px / 3.0).max(6.0);
        canvas.fill_rect(
            (ui.status_right.x - dot * 2.0) as u32,
            (ui.status_bar.y + (ui.status_bar.h - dot) / 2.0) as u32,
            dot as u32,
            dot as u32,
            RECORDING_DOT,
        );
    }
    canvas
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

    let mut profiler = Profiler::new();
    let mut text = String::new();
    term.draw(&render(&font, &text, px, window, false))?;
    loop {
        match term.read_key()? {
            Key::Ctrl('c') => break,
            Key::Ctrl('p') => {
                profiler.toggle()?;
            }
            Key::Backspace => {
                text.pop();
            }
            Key::Enter => text.push('\n'),
            Key::Char(c) if !c.is_control() => text.push(c),
            _ => continue,
        }
        profiler.begin_frame();
        let recording = profiler.is_recording();
        let canvas = profiler.span("render", || render(&font, &text, px, window, recording));
        let bytes = profiler.span("draw", || term.draw(&canvas))?;
        profiler.count("bytes", bytes as u64);
    }
    Ok(())
}
