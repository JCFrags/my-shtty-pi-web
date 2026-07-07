use std::io::{self, Read as _, Write as _};
use std::time::{Duration, Instant};

use rustix::termios::{self, OptionalActions, Termios};

use crate::canvas::Canvas;
use crate::kitty::kitty_transmit;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Key(Key),
    Mouse(Mouse),
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

/// Mouse position is always in pixels relative to the terminal's top-left,
/// regardless of whether the terminal reports pixel (mode 1016) or cell
/// coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mouse {
    pub kind: MouseKind,
    pub button: MouseButton,
    pub x: u32,
    pub y: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseKind {
    Down,
    Up,
    Move,
    ScrollUp,
    ScrollDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    None,
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
    mouse_pixels: bool,
    cell: Option<(u32, u32)>,
}

impl Terminal {
    pub fn new() -> io::Result<Self> {
        let stdin = io::stdin();
        let saved = termios::tcgetattr(&stdin)?;
        let mut raw = saved.clone();
        raw.make_raw();
        termios::tcsetattr(&stdin, OptionalActions::Drain, &raw)?;

        let mut stdout = io::stdout();
        // Alt screen, hidden cursor, then mouse reporting: button events
        // (1002), SGR encoding (1006), pixel coordinates (1016).
        stdout.write_all(b"\x1b[?1049h\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?1016h")?;
        stdout.flush()?;

        let mut terminal = Self {
            stdin,
            stdout,
            saved,
            last_frame_size: None,
            mouse_pixels: false,
            cell: None,
        };
        terminal.mouse_pixels = terminal.probe_mouse_pixels()?;
        Ok(terminal)
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

    pub fn read_event(&mut self) -> io::Result<Event> {
        let b = self.read_byte()?;
        match b {
            0x1b => self.read_escape(),
            0x0d => Ok(Event::Key(Key::Enter)),
            0x7f | 0x08 => Ok(Event::Key(Key::Backspace)),
            c @ 0x01..=0x1a => Ok(Event::Key(Key::Ctrl((b'a' + c - 1) as char))),
            c if c.is_ascii() => Ok(Event::Key(Key::Char(c as char))),
            _ => Ok(Event::Key(Key::Unknown)),
        }
    }

    fn read_escape(&mut self) -> io::Result<Event> {
        if self.read_byte()? != b'[' {
            return Ok(Event::Key(Key::Unknown));
        }
        let mut params = Vec::new();
        let terminator = loop {
            let b = self.read_byte()?;
            if (0x40..=0x7e).contains(&b) {
                break b;
            }
            params.push(b);
            if params.len() > 24 {
                return Ok(Event::Key(Key::Unknown));
            }
        };
        Ok(match terminator {
            b'A' => Event::Key(Key::Up),
            b'B' => Event::Key(Key::Down),
            b'C' => Event::Key(Key::Right),
            b'D' => Event::Key(Key::Left),
            b'M' | b'm' => match parse_sgr_mouse(&params, terminator == b'M') {
                Some((kind, button, col_or_x, row_or_y)) => {
                    let (x, y) = self.mouse_position_px(col_or_x, row_or_y);
                    Event::Mouse(Mouse { kind, button, x, y })
                }
                None => Event::Key(Key::Unknown),
            },
            _ => Event::Key(Key::Unknown),
        })
    }

    /// SGR coordinates are 1-based; cell coordinates map to the cell's center.
    fn mouse_position_px(&self, x: u32, y: u32) -> (u32, u32) {
        if self.mouse_pixels {
            (x.saturating_sub(1), y.saturating_sub(1))
        } else {
            let (cw, ch) = self
                .cell
                .or_else(|| self.size().ok().and_then(|ws| ws.cell_size()))
                .unwrap_or((16, 32));
            ((x - 1) * cw + cw / 2, (y - 1) * ch + ch / 2)
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
        if self.cell.is_some() {
            return Ok(self.cell);
        }
        if let Some(cell) = self.size()?.cell_size() {
            self.cell = Some(cell);
            return Ok(self.cell);
        }
        self.stdout.write_all(b"\x1b[16t")?;
        self.stdout.flush()?;
        self.cell = self.read_report(300, parse_cell_size_report)?;
        Ok(self.cell)
    }

    fn probe_mouse_pixels(&mut self) -> io::Result<bool> {
        self.stdout.write_all(b"\x1b[?1016$p")?;
        self.stdout.flush()?;
        Ok(self.read_report(150, parse_decrqm_1016)?.unwrap_or(false))
    }

    fn read_report<T>(
        &mut self,
        timeout_ms: u64,
        parse: impl Fn(&[u8]) -> Option<T>,
    ) -> io::Result<Option<T>> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut buf = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
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
            if let Some(value) = parse(&buf) {
                return Ok(Some(value));
            }
        }
    }

    fn read_byte(&mut self) -> io::Result<u8> {
        let mut b = [0u8; 1];
        self.stdin.read_exact(&mut b)?;
        Ok(b[0])
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.stdout.write_all(
            b"\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?1016l\x1b[?1006l\x1b[?1002l\x1b[?25h\x1b[?1049l",
        );
        let _ = self.stdout.flush();
        let _ = termios::tcsetattr(&self.stdin, OptionalActions::Flush, &self.saved);
    }
}

/// Params are the bytes between `CSI` and the final `M`/`m`, e.g. `<0;80;24`.
fn parse_sgr_mouse(params: &[u8], press: bool) -> Option<(MouseKind, MouseButton, u32, u32)> {
    let rest = params.strip_prefix(b"<")?;
    let mut fields = rest.split(|&b| b == b';');
    let mut next_int = || -> Option<u32> { std::str::from_utf8(fields.next()?).ok()?.parse().ok() };
    let b = next_int()?;
    let x = next_int()?;
    let y = next_int()?;
    if x == 0 || y == 0 {
        return None;
    }

    let button = match b & 3 {
        0 => MouseButton::Left,
        1 => MouseButton::Middle,
        2 => MouseButton::Right,
        _ => MouseButton::None,
    };
    let kind = if b & 64 != 0 {
        if b & 1 == 0 {
            MouseKind::ScrollUp
        } else {
            MouseKind::ScrollDown
        }
    } else if b & 32 != 0 {
        MouseKind::Move
    } else if press {
        MouseKind::Down
    } else {
        MouseKind::Up
    };
    Some((kind, button, x, y))
}

/// DECRQM reply: `CSI ? 1016 ; Ps $ y`, where Ps 1/3 means the mode is set.
fn parse_decrqm_1016(buf: &[u8]) -> Option<bool> {
    let start = buf.windows(8).position(|w| w == b"\x1b[?1016;")? + 8;
    let ps = *buf.get(start)?;
    Some(ps == b'1' || ps == b'3')
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

    #[test]
    fn parses_sgr_mouse_events() {
        assert_eq!(
            parse_sgr_mouse(b"<0;100;200", true),
            Some((MouseKind::Down, MouseButton::Left, 100, 200))
        );
        assert_eq!(
            parse_sgr_mouse(b"<2;5;6", false),
            Some((MouseKind::Up, MouseButton::Right, 5, 6))
        );
        assert_eq!(
            parse_sgr_mouse(b"<32;9;9", true),
            Some((MouseKind::Move, MouseButton::Left, 9, 9))
        );
        assert_eq!(
            parse_sgr_mouse(b"<64;1;1", true),
            Some((MouseKind::ScrollUp, MouseButton::Left, 1, 1))
        );
        assert_eq!(
            parse_sgr_mouse(b"<65;1;1", true),
            Some((MouseKind::ScrollDown, MouseButton::Middle, 1, 1))
        );
        assert_eq!(parse_sgr_mouse(b"0;1;1", true), None);
        assert_eq!(parse_sgr_mouse(b"<0;0;1", true), None);
    }

    #[test]
    fn parses_decrqm_mouse_pixel_reply() {
        assert_eq!(parse_decrqm_1016(b"\x1b[?1016;1$y"), Some(true));
        assert_eq!(parse_decrqm_1016(b"\x1b[?1016;2$y"), Some(false));
        assert_eq!(parse_decrqm_1016(b"\x1b[?1016;0$y"), Some(false));
        assert_eq!(parse_decrqm_1016(b"\x1b[?1015;1$y"), None);
    }
}
