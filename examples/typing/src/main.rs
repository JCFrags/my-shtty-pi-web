use pixel_core::{Canvas, Key, Profiler, Terminal, fontdue, measure_text};

static FONT_BYTES: &[u8] = include_bytes!("../assets/JetBrainsMono-Regular.ttf");

const PAD: u32 = 12;
const BG: [u8; 4] = [24, 24, 32, 255];
const FG: [u8; 4] = [230, 230, 240, 255];
const CARET: [u8; 4] = [120, 220, 160, 255];
const RECORDING_DOT: [u8; 4] = [235, 80, 80, 255];
const FALLBACK_CELL_HEIGHT: f32 = 32.0;

fn px_for_cell_height(font: &fontdue::Font, cell_height: f32) -> f32 {
    let probe = font
        .horizontal_line_metrics(100.0)
        .expect("font has horizontal metrics");
    (cell_height * 100.0 / probe.new_line_size).clamp(6.0, 512.0)
}

fn render(font: &fontdue::Font, text: &str, px: f32, recording: bool) -> Canvas {
    let line_metrics = font
        .horizontal_line_metrics(px)
        .expect("font has horizontal metrics");
    let line_height = line_metrics.new_line_size;
    let caret_width = (px / 8.0).max(2.0) as u32;

    let lines: Vec<&str> = text.split('\n').collect();
    let widest = lines
        .iter()
        .map(|line| measure_text(font, line, px))
        .fold(0.0f32, f32::max);

    let width = widest.ceil() as u32 + caret_width + PAD * 2;
    let height = (line_height * lines.len() as f32).ceil() as u32 + PAD * 2;
    let mut canvas = Canvas::new(width, height);
    canvas.fill(BG);

    for (i, line) in lines.iter().enumerate() {
        let baseline = (PAD as f32 + line_height * i as f32 + line_metrics.ascent) as i32;
        canvas.draw_text(font, line, PAD as i32, baseline, px, FG);
    }

    let last = lines.len() - 1;
    let caret_x = PAD + measure_text(font, lines[last], px).ceil() as u32;
    let caret_y = PAD + (line_height * last as f32) as u32;
    canvas.fill_rect(caret_x, caret_y, caret_width, line_height as u32, CARET);

    if recording {
        canvas.fill_rect(0, 0, 6, 6, RECORDING_DOT);
    }
    canvas
}

fn main() -> std::io::Result<()> {
    let font = fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default())
        .expect("bundled font parses");

    let mut term = Terminal::new()?;
    let cell_height = term
        .cell_size()?
        .map_or(FALLBACK_CELL_HEIGHT, |(_, h)| h as f32);
    let px = px_for_cell_height(&font, cell_height);

    let mut profiler = Profiler::new();
    let mut text = String::new();
    term.draw(&render(&font, &text, px, false))?;
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
        let canvas = profiler.span("render", || render(&font, &text, px, recording));
        let bytes = profiler.span("draw", || term.draw(&canvas))?;
        profiler.count("bytes", bytes as u64);
    }
    Ok(())
}
