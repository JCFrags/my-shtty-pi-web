use std::io::{self, Read as _, Write as _};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use rustix::termios::{self, OptionalActions, Termios};

pub use fontdue;

const KITTY_CHUNK_SIZE: usize = 4096;

pub struct Canvas {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Canvas {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0; (width * height * 4) as usize],
        }
    }

    pub fn fill(&mut self, color: [u8; 4]) {
        for px in self.pixels.chunks_exact_mut(4) {
            px.copy_from_slice(&color);
        }
    }

    pub fn fill_rect(&mut self, x: u32, y: u32, w: u32, h: u32, color: [u8; 4]) {
        let x1 = x.min(self.width);
        let y1 = y.min(self.height);
        let x2 = x.saturating_add(w).min(self.width);
        let y2 = y.saturating_add(h).min(self.height);
        for row in y1..y2 {
            for col in x1..x2 {
                let i = ((row * self.width + col) * 4) as usize;
                self.pixels[i..i + 4].copy_from_slice(&color);
            }
        }
    }

    pub fn draw_text(
        &mut self,
        font: &fontdue::Font,
        text: &str,
        x: i32,
        baseline: i32,
        px: f32,
        color: [u8; 4],
    ) {
        let mut pen_x = x as f32;
        for ch in text.chars() {
            let (metrics, coverage) = font.rasterize(ch, px);
            let glyph_x = pen_x.round() as i32 + metrics.xmin;
            // ymin is the bottom edge's offset from the baseline (positive = up),
            // so the bitmap's top row sits at baseline - height - ymin.
            let glyph_y = baseline - metrics.height as i32 - metrics.ymin;
            self.blend_mask(
                glyph_x,
                glyph_y,
                metrics.width,
                metrics.height,
                &coverage,
                color,
            );
            pen_x += metrics.advance_width;
        }
    }

    fn blend_mask(&mut self, x: i32, y: i32, w: usize, h: usize, mask: &[u8], color: [u8; 4]) {
        for row in 0..h {
            let py = y + row as i32;
            if py < 0 || py >= self.height as i32 {
                continue;
            }
            for col in 0..w {
                let px = x + col as i32;
                if px < 0 || px >= self.width as i32 {
                    continue;
                }
                let coverage = u32::from(mask[row * w + col]);
                if coverage == 0 {
                    continue;
                }
                let i = ((py as u32 * self.width + px as u32) * 4) as usize;
                for (dst, &src) in self.pixels[i..i + 4].iter_mut().zip(&color) {
                    *dst = ((u32::from(*dst) * (255 - coverage) + u32::from(src) * coverage) / 255)
                        as u8;
                }
            }
        }
    }
}

pub fn measure_text(font: &fontdue::Font, text: &str, px: f32) -> f32 {
    text.chars()
        .map(|ch| font.metrics(ch, px).advance_width)
        .sum()
}

pub fn kitty_transmit(image_id: u32, width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    assert_eq!(rgba.len(), (width * height * 4) as usize);
    let payload = BASE64.encode(rgba);
    let chunks: Vec<&[u8]> = payload.as_bytes().chunks(KITTY_CHUNK_SIZE).collect();
    let last = chunks.len() - 1;

    let mut out = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let more = u8::from(i != last);
        out.extend_from_slice(b"\x1b_G");
        if i == 0 {
            out.extend_from_slice(
                format!("a=T,f=32,s={width},v={height},t=d,i={image_id},p=1,q=2,m={more}")
                    .as_bytes(),
            );
        } else {
            out.extend_from_slice(format!("m={more}").as_bytes());
        }
        out.push(b';');
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\x1b\\");
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Up,
    Down,
    Left,
    Right,
    CtrlC,
    Unknown,
}

pub struct Terminal {
    stdin: io::Stdin,
    stdout: io::Stdout,
    saved: Termios,
}

impl Terminal {
    pub fn new() -> io::Result<Self> {
        let stdin = io::stdin();
        let saved = termios::tcgetattr(&stdin)?;
        let mut raw = saved.clone();
        raw.make_raw();
        termios::tcsetattr(&stdin, OptionalActions::Drain, &raw)?;

        let mut stdout = io::stdout();
        stdout.write_all(b"\x1b[?1049h\x1b[?25l")?;
        stdout.flush()?;

        Ok(Self {
            stdin,
            stdout,
            saved,
        })
    }

    pub fn draw(&mut self, canvas: &Canvas) -> io::Result<()> {
        let mut frame = Vec::new();
        frame.extend_from_slice(b"\x1b[?2026h"); // mode 2026 atomic updates
        frame.extend_from_slice(b"\x1b[H");
        frame.extend_from_slice(&kitty_transmit(
            1,
            canvas.width,
            canvas.height,
            &canvas.pixels,
        ));
        frame.extend_from_slice(b"\x1b[?2026l");
        self.stdout.write_all(&frame)?;
        self.stdout.flush()
    }

    pub fn read_key(&mut self) -> io::Result<Key> {
        let mut b = [0u8; 1];
        self.stdin.read_exact(&mut b)?;
        match b[0] {
            0x1b => {
                let mut seq = [0u8; 2];
                self.stdin.read_exact(&mut seq)?;
                Ok(match &seq {
                    b"[A" => Key::Up,
                    b"[B" => Key::Down,
                    b"[C" => Key::Right,
                    b"[D" => Key::Left,
                    _ => Key::Unknown,
                })
            }
            0x03 => Ok(Key::CtrlC),
            c if c.is_ascii() => Ok(Key::Char(c as char)),
            _ => Ok(Key::Unknown),
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self
            .stdout
            .write_all(b"\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?25h\x1b[?1049l");
        let _ = self.stdout.flush();
        let _ = termios::tcsetattr(&self.stdin, OptionalActions::Flush, &self.saved);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transmit_emits_single_chunk_for_small_images() {
        let out = kitty_transmit(1, 1, 1, &[0xff, 0x00, 0x00, 0xff]);
        assert_eq!(
            out,
            b"\x1b_Ga=T,f=32,s=1,v=1,t=d,i=1,p=1,q=2,m=0;/wAA/w==\x1b\\"
        );
    }

    #[test]
    fn transmit_chunks_large_payloads() {
        let canvas = Canvas::new(64, 64);
        let out = kitty_transmit(1, canvas.width, canvas.height, &canvas.pixels);
        let text = String::from_utf8_lossy(&out);
        let opens = text.matches("\x1b_G").count();
        // 64*64*4 bytes -> ~21.8 KB of base64 -> 6 chunks of <= 4096.
        assert_eq!(opens, 6);
        assert_eq!(text.matches("m=1").count(), 5);
        assert_eq!(text.matches("m=0").count(), 1);
        assert!(text.ends_with("\x1b\\"));
    }

    #[test]
    fn fill_rect_clamps_to_bounds() {
        let mut canvas = Canvas::new(4, 4);
        canvas.fill_rect(2, 2, 100, 100, [1, 2, 3, 4]);
        assert_eq!(&canvas.pixels[((3 * 4 + 3) * 4) as usize..], &[1, 2, 3, 4]);
        assert_eq!(&canvas.pixels[0..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn blend_mask_full_coverage_replaces_half_blends() {
        let mut canvas = Canvas::new(2, 1);
        canvas.fill([0, 0, 0, 255]);
        canvas.blend_mask(0, 0, 2, 1, &[255, 128], [200, 100, 50, 255]);
        assert_eq!(&canvas.pixels[0..4], &[200, 100, 50, 255]);
        let half = &canvas.pixels[4..8];
        assert_eq!(half[0], (200 * 128 / 255) as u8);
        assert_eq!(half[3], 255);
    }

    #[test]
    fn blend_mask_clips_out_of_bounds_positions() {
        let mut canvas = Canvas::new(2, 2);
        canvas.blend_mask(-1, -1, 3, 3, &[255; 9], [10, 20, 30, 255]);
        assert_eq!(&canvas.pixels[0..4], &[10, 20, 30, 255]);
    }
}
