//! Hello world: a counter rendered as pixels via kitty graphics.
//! `+`/`-` (or arrows) change it, `q` or Ctrl-C quits.

use pixel_core::{Canvas, Key, Terminal};

const SCALE: u32 = 16;
const GLYPH_W: u32 = 3;
const GLYPH_H: u32 = 5;

const DIGITS: [[&[u8; 3]; 5]; 10] = [
    [b"###", b"# #", b"# #", b"# #", b"###"],
    [b" # ", b"## ", b" # ", b" # ", b"###"],
    [b"###", b"  #", b"###", b"#  ", b"###"],
    [b"###", b"  #", b"###", b"  #", b"###"],
    [b"# #", b"# #", b"###", b"  #", b"  #"],
    [b"###", b"#  ", b"###", b"  #", b"###"],
    [b"###", b"#  ", b"###", b"# #", b"###"],
    [b"###", b"  #", b"  #", b"  #", b"  #"],
    [b"###", b"# #", b"###", b"# #", b"###"],
    [b"###", b"# #", b"###", b"  #", b"###"],
];

const MINUS: [&[u8; 3]; 5] = [b"   ", b"   ", b"###", b"   ", b"   "];

fn glyph(c: char) -> [&'static [u8; 3]; 5] {
    match c {
        '-' => MINUS,
        d => DIGITS[d.to_digit(10).unwrap() as usize],
    }
}

fn render(count: i64) -> Canvas {
    let text = count.to_string();
    let n = text.chars().count() as u32;
    let advance = (GLYPH_W + 1) * SCALE;
    let pad = SCALE;
    let mut canvas = Canvas::new(pad * 2 + n * advance - SCALE, pad * 2 + GLYPH_H * SCALE);
    canvas.fill([24, 24, 32, 255]);

    for (i, c) in text.chars().enumerate() {
        let origin_x = pad + i as u32 * advance;
        for (row, bits) in glyph(c).iter().enumerate() {
            for (col, &bit) in bits.iter().enumerate() {
                if bit == b'#' {
                    canvas.fill_rect(
                        origin_x + col as u32 * SCALE,
                        pad + row as u32 * SCALE,
                        SCALE,
                        SCALE,
                        [120, 220, 160, 255],
                    );
                }
            }
        }
    }
    canvas
}

fn main() -> std::io::Result<()> {
    let mut term = Terminal::new()?;
    let mut count: i64 = 0;
    term.draw(&render(count))?;
    loop {
        match term.read_key()? {
            Key::Char('q') | Key::CtrlC => break,
            Key::Char('+' | '=') | Key::Up | Key::Right => count += 1,
            Key::Char('-' | '_') | Key::Down | Key::Left => count -= 1,
            _ => continue,
        }
        term.draw(&render(count))?;
    }
    Ok(())
}
