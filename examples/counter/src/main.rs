use pixel_core::{Canvas, Key, Terminal, fontdue, measure_text};

static FONT_BYTES: &[u8] = include_bytes!("../assets/JetBrainsMono-Regular.ttf");

const PX: f32 = 96.0;
const PAD: u32 = 24;

fn render(font: &fontdue::Font, count: i64) -> Canvas {
    let text = count.to_string();
    let width = measure_text(font, &text, PX).ceil() as u32;
    let line = font
        .horizontal_line_metrics(PX)
        .expect("font has horizontal metrics");
    let height = (line.ascent - line.descent).ceil() as u32;

    let mut canvas = Canvas::new(width + PAD * 2, height + PAD * 2);
    canvas.fill([24, 24, 32, 255]);
    let baseline = (PAD as f32 + line.ascent) as i32;
    canvas.draw_text(font, &text, PAD as i32, baseline, PX, [120, 220, 160, 255]);
    canvas
}

fn main() -> std::io::Result<()> {
    let font = fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default())
        .expect("bundled font parses");

    let mut term = Terminal::new()?;
    let mut count: i64 = 0;
    term.draw(&render(&font, count))?;
    loop {
        match term.read_key()? {
            Key::Char('q') | Key::CtrlC => break,
            Key::Char('+' | '=') | Key::Up | Key::Right => count += 1,
            Key::Char('-' | '_') | Key::Down | Key::Left => count -= 1,
            _ => continue,
        }
        term.draw(&render(&font, count))?;
    }
    Ok(())
}
