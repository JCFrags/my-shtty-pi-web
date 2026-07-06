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

/// Pixels are zlib-compressed (`o=z`): UI canvases are mostly flat color, so
/// this cuts the escape stream by orders of magnitude.
pub fn kitty_transmit(image_id: u32, width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    assert_eq!(rgba.len(), (width * height * 4) as usize);
    let compressed = miniz_oxide::deflate::compress_to_vec_zlib(rgba, 1);
    let payload = BASE64.encode(&compressed);
    let chunks: Vec<&[u8]> = payload.as_bytes().chunks(KITTY_CHUNK_SIZE).collect();
    let last = chunks.len() - 1;

    let mut out = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let more = u8::from(i != last);
        out.extend_from_slice(b"\x1b_G");
        if i == 0 {
            out.extend_from_slice(
                format!("a=T,f=32,o=z,s={width},v={height},t=d,i={image_id},p=1,q=2,m={more}")
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
    Ctrl(char),
    Up,
    Down,
    Left,
    Right,
    Enter,
    Backspace,
    Unknown,
}

#[derive(Debug, Clone, Copy)]
pub struct WindowSize {
    pub cols: u32,
    pub rows: u32,
    pub width_px: u32,
    pub height_px: u32,
}

impl WindowSize {
    /// Pixel size of one terminal cell, if the terminal reports pixel sizes
    /// (kitty, Ghostty, and most modern terminals do; some leave them 0).
    pub fn cell_size(&self) -> Option<(u32, u32)> {
        if self.cols > 0 && self.rows > 0 && self.width_px > 0 && self.height_px > 0 {
            Some((self.width_px / self.cols, self.height_px / self.rows))
        } else {
            None
        }
    }
}

pub struct Terminal {
    stdin: io::Stdin,
    stdout: io::Stdout,
    saved: Termios,
    /**
     * because in vscode replacing an image of a given id keeps an artifact around,
     * so atm we're using this field to determine if we need to clear instead of replace.
     * very unelegant solution
     */
    last_frame_size: Option<(u32, u32)>,
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
            last_frame_size: None,
        })
    }

    pub fn draw(&mut self, canvas: &Canvas) -> io::Result<usize> {
        let shrank = self
            .last_frame_size
            .is_some_and(|(w, h)| canvas.width < w || canvas.height < h);
        self.last_frame_size = Some((canvas.width, canvas.height));

        let mut frame = Vec::new();
        frame.extend_from_slice(b"\x1b[?2026h"); // mode 2026 atomic updates
        if shrank {
            frame.extend_from_slice(b"\x1b_Ga=d,d=A,q=2\x1b\\\x1b[2J");
            if let Ok(ws) = self.size() {
                let blank_row = " ".repeat(ws.cols as usize);
                for row in 1..=ws.rows {
                    frame.extend_from_slice(format!("\x1b[{row};1H{blank_row}").as_bytes());
                }
            }
        }
        frame.extend_from_slice(b"\x1b[H");
        frame.extend_from_slice(&kitty_transmit(
            1,
            canvas.width,
            canvas.height,
            &canvas.pixels,
        ));
        frame.extend_from_slice(b"\x1b[?2026l");
        self.stdout.write_all(&frame)?;
        self.stdout.flush()?;
        Ok(frame.len())
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
            0x0d => Ok(Key::Enter),
            0x7f | 0x08 => Ok(Key::Backspace),
            c @ 0x01..=0x1a => Ok(Key::Ctrl((b'a' + c - 1) as char)),
            c if c.is_ascii() => Ok(Key::Char(c as char)),
            _ => Ok(Key::Unknown),
        }
    }

    pub fn size(&self) -> io::Result<WindowSize> {
        let ws = termios::tcgetwinsize(&self.stdin)?;
        Ok(WindowSize {
            cols: u32::from(ws.ws_col),
            rows: u32::from(ws.ws_row),
            width_px: u32::from(ws.ws_xpixel),
            height_px: u32::from(ws.ws_ypixel),
        })
    }

    pub fn cell_size(&mut self) -> io::Result<Option<(u32, u32)>> {
        if let Some(cell) = self.size()?.cell_size() {
            return Ok(Some(cell));
        }
        self.stdout.write_all(b"\x1b[16t")?;
        self.stdout.flush()?;

        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
        let mut buf = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() || buf.len() > 256 {
                return Ok(None);
            }
            let mut fds = [rustix::event::PollFd::new(
                &self.stdin,
                rustix::event::PollFlags::IN,
            )];
            let timeout = rustix::event::Timespec::try_from(remaining)
                .map_err(|_| io::Error::other("timeout out of range"))?;
            if rustix::event::poll(&mut fds, Some(&timeout))? == 0 {
                return Ok(None);
            }
            let mut chunk = [0u8; 64];
            let n = self.stdin.read(&mut chunk)?;
            if n == 0 {
                return Ok(None);
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(cell) = parse_cell_size_report(&buf) {
                return Ok(Some(cell));
            }
        }
    }
}

fn parse_cell_size_report(buf: &[u8]) -> Option<(u32, u32)> {
    let start = buf.windows(4).position(|w| w == b"\x1b[6;")? + 4;
    let end = start + buf[start..].iter().position(|&b| b == b't')?;
    let mut parts = buf[start..end].split(|&b| b == b';');
    let height: u32 = std::str::from_utf8(parts.next()?).ok()?.parse().ok()?;
    let width: u32 = std::str::from_utf8(parts.next()?).ok()?.parse().ok()?;
    if width > 0 && height > 0 {
        Some((width, height))
    } else {
        None
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

#[derive(Default)]
pub struct Profiler {
    recording: Option<Recording>,
}

struct Recording {
    started: std::time::Instant,
    frames: Vec<FrameRecord>,
}

#[derive(Default)]
struct FrameRecord {
    at_ms: f64,
    spans: Vec<(&'static str, f64)>,
    counters: Vec<(&'static str, u64)>,
}

impl Profiler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_recording(&self) -> bool {
        self.recording.is_some()
    }

    pub fn toggle(&mut self) -> io::Result<Option<std::path::PathBuf>> {
        match self.recording.take() {
            None => {
                self.recording = Some(Recording {
                    started: std::time::Instant::now(),
                    frames: Vec::new(),
                });
                Ok(None)
            }
            Some(recording) => {
                std::fs::create_dir_all("profiles")?;
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(io::Error::other)?
                    .as_secs();
                let path = std::path::PathBuf::from(format!("profiles/profile-{stamp}.json"));
                std::fs::write(&path, report_json(&recording.frames))?;
                Ok(Some(path))
            }
        }
    }

    pub fn begin_frame(&mut self) {
        if let Some(recording) = &mut self.recording {
            recording.frames.push(FrameRecord {
                at_ms: recording.started.elapsed().as_secs_f64() * 1000.0,
                ..FrameRecord::default()
            });
        }
    }

    pub fn span<T>(&mut self, name: &'static str, work: impl FnOnce() -> T) -> T {
        let start = std::time::Instant::now();
        let result = work();
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        if let Some(frame) = self.current_frame() {
            frame.spans.push((name, elapsed_ms));
        }
        result
    }

    pub fn count(&mut self, name: &'static str, value: u64) {
        if let Some(frame) = self.current_frame() {
            frame.counters.push((name, value));
        }
    }

    fn current_frame(&mut self) -> Option<&mut FrameRecord> {
        self.recording.as_mut().and_then(|r| r.frames.last_mut())
    }
}

fn report_json(frames: &[FrameRecord]) -> String {
    let mut span_stats: Vec<(&str, Vec<f64>)> = Vec::new();
    let mut counter_stats: Vec<(&str, Vec<u64>)> = Vec::new();
    for frame in frames {
        for &(name, ms) in &frame.spans {
            match span_stats.iter_mut().find(|(n, _)| *n == name) {
                Some((_, values)) => values.push(ms),
                None => span_stats.push((name, vec![ms])),
            }
        }
        for &(name, value) in &frame.counters {
            match counter_stats.iter_mut().find(|(n, _)| *n == name) {
                Some((_, values)) => values.push(value),
                None => counter_stats.push((name, vec![value])),
            }
        }
    }

    let mut out = String::from("{\n  \"summary\": {\n    \"frames\": ");
    out.push_str(&frames.len().to_string());
    for (name, values) in &span_stats {
        let total: f64 = values.iter().sum();
        let max = values.iter().cloned().fold(0.0f64, f64::max);
        out.push_str(&format!(
            ",\n    \"{name}\": {{\"total_ms\": {total:.3}, \"mean_ms\": {:.3}, \"max_ms\": {max:.3}}}",
            total / values.len() as f64
        ));
    }
    for (name, values) in &counter_stats {
        let total: u64 = values.iter().sum();
        let max = values.iter().max().copied().unwrap_or(0);
        out.push_str(&format!(
            ",\n    \"{name}\": {{\"total\": {total}, \"mean\": {:.1}, \"max\": {max}}}",
            total as f64 / values.len() as f64
        ));
    }
    out.push_str("\n  },\n  \"frames\": [\n");
    for (i, frame) in frames.iter().enumerate() {
        out.push_str(&format!("    {{\"at_ms\": {:.3}", frame.at_ms));
        for &(name, ms) in &frame.spans {
            out.push_str(&format!(", \"{name}_ms\": {ms:.3}"));
        }
        for &(name, value) in &frame.counters {
            out.push_str(&format!(", \"{name}\": {value}"));
        }
        out.push_str(if i + 1 == frames.len() { "}\n" } else { "},\n" });
    }
    out.push_str("  ]\n}\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transmit_emits_single_chunk_for_small_images() {
        let out = kitty_transmit(1, 1, 1, &[0xff, 0x00, 0x00, 0xff]);
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with("\x1b_Ga=T,f=32,o=z,s=1,v=1,t=d,i=1,p=1,q=2,m=0;"));
        assert!(text.ends_with("\x1b\\"));

        let payload = text
            .split_once(';')
            .and_then(|(_, rest)| rest.strip_suffix("\x1b\\"))
            .unwrap();
        let decompressed =
            miniz_oxide::inflate::decompress_to_vec_zlib(&BASE64.decode(payload).unwrap()).unwrap();
        assert_eq!(decompressed, [0xff, 0x00, 0x00, 0xff]);
    }

    #[test]
    fn transmit_chunks_large_payloads() {
        // Pseudo-random pixels so zlib can't shrink them below one chunk.
        let mut seed = 0x12345678u32;
        let pixels: Vec<u8> = (0..64 * 64 * 4)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed >> 24) as u8
            })
            .collect();
        let out = kitty_transmit(1, 64, 64, &pixels);
        let text = String::from_utf8_lossy(&out);
        let opens = text.matches("\x1b_G").count();
        assert!(opens > 1, "expected multiple chunks, got {opens}");
        assert_eq!(text.matches("m=1").count(), opens - 1);
        assert_eq!(text.matches("m=0").count(), 1);
        assert!(text.ends_with("\x1b\\"));
    }

    #[test]
    fn transmit_compresses_flat_canvases_hard() {
        let mut canvas = Canvas::new(256, 256);
        canvas.fill([24, 24, 32, 255]);
        let out = kitty_transmit(1, canvas.width, canvas.height, &canvas.pixels);
        // 256KB of raw RGBA (350KB base64) should collapse to a few hundred
        // bytes of escape stream.
        assert!(out.len() < 4096, "expected tiny output, got {}", out.len());
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
    fn profiler_report_includes_frames_and_summary() {
        let frames = vec![
            FrameRecord {
                at_ms: 0.0,
                spans: vec![("render", 2.0), ("draw", 10.0)],
                counters: vec![("bytes", 1000)],
            },
            FrameRecord {
                at_ms: 5.0,
                spans: vec![("render", 4.0), ("draw", 20.0)],
                counters: vec![("bytes", 3000)],
            },
        ];
        let json = report_json(&frames);
        assert!(json.contains("\"frames\": 2"));
        assert!(
            json.contains(
                "\"render\": {\"total_ms\": 6.000, \"mean_ms\": 3.000, \"max_ms\": 4.000}"
            )
        );
        assert!(json.contains("\"bytes\": {\"total\": 4000, \"mean\": 2000.0, \"max\": 3000}"));
        assert!(json.contains(
            "{\"at_ms\": 5.000, \"render_ms\": 4.000, \"draw_ms\": 20.000, \"bytes\": 3000}"
        ));
    }

    #[test]
    fn parses_cell_size_report_amid_noise() {
        assert_eq!(parse_cell_size_report(b"\x1b[6;14;7t"), Some((7, 14)));
        assert_eq!(parse_cell_size_report(b"ab\x1b[6;28;13tcd"), Some((13, 28)));
        assert_eq!(parse_cell_size_report(b"\x1b[6;14"), None);
        assert_eq!(parse_cell_size_report(b"\x1b[6;0;0t"), None);
    }

    #[test]
    fn blend_mask_clips_out_of_bounds_positions() {
        let mut canvas = Canvas::new(2, 2);
        canvas.blend_mask(-1, -1, 3, 3, &[255; 9], [10, 20, 30, 255]);
        assert_eq!(&canvas.pixels[0..4], &[10, 20, 30, 255]);
    }
}
