use std::io::{self, Read as _, Write as _};

use rustix::termios::{self, OptionalActions, Termios};

use crate::canvas::Canvas;
use crate::kitty::kitty_transmit;

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
    /// Some terminal stacks leave the pixel fields zero, hence Option.
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
            // Terminals send 0x7f for the Backspace key; 0x08 is Ctrl-H.
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

    /// Falls back to the `CSI 16 t` query when the winsize ioctl reports no
    /// pixel sizes (e.g. VS Code); the terminal answers on stdin.
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

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self
            .stdout
            .write_all(b"\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?25h\x1b[?1049l");
        let _ = self.stdout.flush();
        let _ = termios::tcsetattr(&self.stdin, OptionalActions::Flush, &self.saved);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cell_size_report_amid_noise() {
        assert_eq!(parse_cell_size_report(b"\x1b[6;14;7t"), Some((7, 14)));
        assert_eq!(parse_cell_size_report(b"ab\x1b[6;28;13tcd"), Some((13, 28)));
        assert_eq!(parse_cell_size_report(b"\x1b[6;14"), None);
        assert_eq!(parse_cell_size_report(b"\x1b[6;0;0t"), None);
    }
}
