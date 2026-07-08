use std::io::{self, Write as _};
use std::time::{Duration, Instant};

use rustix::termios::{self, OptionalActions, Termios};

use crate::canvas::Canvas;
use crate::kitty::kitty_transmit;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Key(Key),
    Mouse(Mouse),
    Focus(bool),
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
    ScrollLeft,
    ScrollRight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    None,
}

/// Colors reported by the terminal itself; None where it didn't answer.
#[derive(Debug, Clone, Copy, Default)]
pub struct TerminalColors {
    pub foreground: Option<[u8; 4]>,
    pub background: Option<[u8; 4]>,
    pub palette: [Option<[u8; 4]>; 16],
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
    last_frame_size: Option<(u32, u32)>,
    mouse_pixels: bool,
    cell: Option<(u32, u32)>,
    /// Unparsed input. Reads bypass io::Stdin's internal buffer: bytes hiding
    /// there would make poll() report an idle fd while input sits unparsed.
    pending: Vec<u8>,
    /// True once the startup probe confirms the terminal can read our shared
    /// memory; everything else gets frames as base64 over the pty.
    shm_frames: bool,
    frame_seq: u64,
}

impl Terminal {
    pub fn new() -> io::Result<Self> {
        let stdin = io::stdin();
        let saved = termios::tcgetattr(&stdin)?;
        let mut raw = saved.clone();
        raw.make_raw();
        termios::tcsetattr(&stdin, OptionalActions::Drain, &raw)?;

        let mut stdout = io::stdout();
        // Alt screen, hidden cursor, then mouse reporting: all motion
        // (1003, needed for hover), SGR encoding (1006), pixel coords (1016),
        // focus reporting (1004).
        stdout.write_all(b"\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[?1016h\x1b[?1004h")?;
        stdout.flush()?;

        let mut terminal = Self {
            stdin,
            stdout,
            saved,
            last_frame_size: None,
            mouse_pixels: false,
            cell: None,
            pending: Vec::new(),
            shm_frames: false,
            frame_seq: 0,
        };
        terminal.mouse_pixels = terminal.probe_mouse_pixels()?;
        terminal.shm_frames = terminal.probe_shm_frames()?;
        Ok(terminal)
    }

    fn probe_shm_frames(&mut self) -> io::Result<bool> {
        let name = format!("/px-{}-q", std::process::id());
        if write_shm(&name, &[0, 0, 0, 255]).is_err() {
            return Ok(false);
        }
        self.stdout
            .write_all(&crate::kitty::kitty_query_shm(SHM_PROBE_ID, &name))?;
        self.stdout.flush()?;
        let reply = self.read_report(300, |buf| parse_probe_reply(buf, b"_Gi=299;"))?;
        let _ = rustix::shm::unlink(&name);
        Ok(reply.unwrap_or(false))
    }

    fn shm_name(seq: u64) -> String {
        format!("/px-{}-{seq}", std::process::id())
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
        if self.shm_frames {
            let name = Self::shm_name(self.frame_seq);
            crate::profiler::span("kitty.shm", || write_shm(&name, &canvas.pixels))?;
            self.frame_seq += 1;
            frame.extend_from_slice(&crate::kitty::kitty_transmit_shm(
                1,
                canvas.width,
                canvas.height,
                &name,
            ));
        } else {
            frame.extend_from_slice(&kitty_transmit(
                1,
                canvas.width,
                canvas.height,
                &canvas.pixels,
            ));
        }
        frame.extend_from_slice(b"\x1b[?2026l");
        crate::profiler::span("term.write", || {
            self.stdout.write_all(&frame)?;
            self.stdout.flush()
        })?;
        Ok(frame.len())
    }

    pub fn read_event(&mut self) -> io::Result<Event> {
        match self.poll_event(None)? {
            Some(event) => Ok(event),
            None => Err(io::ErrorKind::UnexpectedEof.into()),
        }
    }

    /// Next event, or None once `timeout` passes (None waits forever;
    /// Duration::ZERO drains already-arrived input without waiting).
    pub fn poll_event(&mut self, timeout: Option<Duration>) -> io::Result<Option<Event>> {
        let deadline = timeout.map(|t| Instant::now() + t);
        loop {
            if let Some((raw, used)) = parse_event(&self.pending) {
                self.pending.drain(..used);
                return Ok(Some(match raw {
                    RawEvent::Key(key) => Event::Key(key),
                    RawEvent::Focus(focused) => Event::Focus(focused),
                    RawEvent::Mouse(kind, button, x, y) => {
                        let (x, y) = self.mouse_position_px(x, y);
                        Event::Mouse(Mouse { kind, button, x, y })
                    }
                }));
            }
            let wait = deadline.map(|d| d.saturating_duration_since(Instant::now()));
            if !self.wait_for_input(wait)? {
                return Ok(None);
            }
            let mut chunk = [0u8; 256];
            let n = rustix::io::read(&self.stdin, &mut chunk)?;
            if n == 0 {
                return Ok(None);
            }
            self.pending.extend_from_slice(&chunk[..n]);
        }
    }

    /// True when stdin has bytes to read; false when the wait elapsed first.
    fn wait_for_input(&self, wait: Option<Duration>) -> io::Result<bool> {
        let mut fds = [rustix::event::PollFd::new(
            &self.stdin,
            rustix::event::PollFlags::IN,
        )];
        let timeout = match wait {
            Some(w) => Some(
                rustix::event::Timespec::try_from(w)
                    .map_err(|_| io::Error::other("timeout out of range"))?,
            ),
            None => None,
        };
        Ok(rustix::event::poll(&mut fds, timeout.as_ref())? > 0)
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

    /// Queries the terminal's own colors (OSC 10/11 for fg/bg, OSC 4 for the
    /// ANSI palette) so apps can match its theme. Terminals answer what they
    /// support; the rest stays None.
    pub fn query_colors(&mut self) -> io::Result<TerminalColors> {
        let mut query = b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\".to_vec();
        for i in 0..16 {
            query.extend_from_slice(format!("\x1b]4;{i};?\x1b\\").as_bytes());
        }
        self.stdout.write_all(&query)?;
        self.stdout.flush()?;

        let deadline = Instant::now() + Duration::from_millis(300);
        let mut buf = Vec::new();
        loop {
            let replies = buf.windows(4).filter(|w| w == b"rgb:").count();
            if replies >= 18 {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            // Once replies start arriving, a short silence means the terminal
            // has answered everything it supports.
            let wait = if replies > 0 {
                remaining.min(Duration::from_millis(60))
            } else {
                remaining
            };
            if wait.is_zero() || buf.len() > 4096 {
                break;
            }
            if !self.wait_for_input(Some(wait))? {
                break;
            }
            let mut chunk = [0u8; 256];
            let n = rustix::io::read(&self.stdin, &mut chunk)?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }

        let mut colors = TerminalColors {
            foreground: parse_osc_color(&buf, "10;"),
            background: parse_osc_color(&buf, "11;"),
            ..TerminalColors::default()
        };
        for (i, slot) in colors.palette.iter_mut().enumerate() {
            *slot = parse_osc_color(&buf, &format!("4;{i};"));
        }
        Ok(colors)
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
            if !self.wait_for_input(Some(remaining))? {
                return Ok(None);
            }
            let mut chunk = [0u8; 64];
            let n = rustix::io::read(&self.stdin, &mut chunk)?;
            if n == 0 {
                return Ok(None);
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(value) = parse(&buf) {
                return Ok(Some(value));
            }
        }
    }
}

const SHM_PROBE_ID: u32 = 299;

fn parse_probe_reply(buf: &[u8], needle: &[u8]) -> Option<bool> {
    let pos = buf.windows(needle.len()).position(|w| w == needle)?;
    let rest = &buf[pos + needle.len()..];
    if rest.len() < 2 {
        return None;
    }
    Some(rest.starts_with(b"OK"))
}

/// macOS shm fds reject read/write syscalls, so filling the object takes an
/// mmap round-trip.
#[allow(unsafe_code)]
fn write_shm(name: &str, data: &[u8]) -> io::Result<()> {
    let fd = rustix::shm::open(
        name,
        rustix::shm::OFlags::CREATE | rustix::shm::OFlags::EXCL | rustix::shm::OFlags::RDWR,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )?;
    rustix::fs::ftruncate(&fd, data.len() as u64)?;
    // SAFETY: a fresh shared mapping sized to data.len() by the ftruncate
    // above, written once and unmapped before the fd closes.
    unsafe {
        let ptr = rustix::mm::mmap(
            std::ptr::null_mut(),
            data.len(),
            rustix::mm::ProtFlags::READ | rustix::mm::ProtFlags::WRITE,
            rustix::mm::MapFlags::SHARED,
            &fd,
            0,
        )?;
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr.cast(), data.len());
        rustix::mm::munmap(ptr, data.len())?;
    }
    Ok(())
}

impl Drop for Terminal {
    fn drop(&mut self) {
        // The terminal unlinks each object it reads; sweep the rest.
        for seq in 0..self.frame_seq {
            let _ = rustix::shm::unlink(Self::shm_name(seq));
        }
        let _ = self.stdout.write_all(
            b"\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?1004l\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l",
        );
        let _ = self.stdout.flush();
        let _ = termios::tcsetattr(&self.stdin, OptionalActions::Flush, &self.saved);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RawEvent {
    Key(Key),
    Mouse(MouseKind, MouseButton, u32, u32),
    Focus(bool),
}

/// One event from the front of `buf` plus the bytes it consumed. None means
/// an incomplete sequence; garbage always consumes and yields Key::Unknown.
fn parse_event(buf: &[u8]) -> Option<(RawEvent, usize)> {
    let b0 = *buf.first()?;
    if b0 != 0x1b {
        let key = match b0 {
            0x0d => Key::Enter,
            0x7f | 0x08 => Key::Backspace,
            c @ 0x01..=0x1a => Key::Ctrl((b'a' + c - 1) as char),
            c if c.is_ascii() => Key::Char(c as char),
            _ => Key::Unknown,
        };
        return Some((RawEvent::Key(key), 1));
    }
    // String sequences (graphics replies, late query answers) must be
    // swallowed whole or their bodies leak into the input as typed keys.
    if matches!(*buf.get(1)?, b'_' | b']' | b'P' | b'X' | b'^') {
        return consume_string_sequence(buf).map(|end| (RawEvent::Key(Key::Unknown), end));
    }
    if *buf.get(1)? != b'[' {
        return Some((RawEvent::Key(Key::Unknown), 2));
    }
    let mut end = 2;
    let terminator = loop {
        let b = *buf.get(end)?;
        end += 1;
        if (0x40..=0x7e).contains(&b) {
            break b;
        }
        if end - 2 > 24 {
            return Some((RawEvent::Key(Key::Unknown), end));
        }
    };
    let params = &buf[2..end - 1];
    let event = match terminator {
        b'A' => RawEvent::Key(Key::Up),
        b'B' => RawEvent::Key(Key::Down),
        b'C' => RawEvent::Key(Key::Right),
        b'D' => RawEvent::Key(Key::Left),
        b'I' => RawEvent::Focus(true),
        b'O' => RawEvent::Focus(false),
        b'M' | b'm' => match parse_sgr_mouse(params, terminator == b'M') {
            Some((kind, button, x, y)) => RawEvent::Mouse(kind, button, x, y),
            None => RawEvent::Key(Key::Unknown),
        },
        _ => RawEvent::Key(Key::Unknown),
    };
    Some((event, end))
}

/// Bytes up to and including the terminator (ST, or BEL for OSC); None means
/// the terminator hasn't arrived yet. Capped so garbage can't buffer forever.
fn consume_string_sequence(buf: &[u8]) -> Option<usize> {
    let mut i = 2;
    loop {
        match *buf.get(i)? {
            0x07 if buf[1] == b']' => return Some(i + 1),
            0x1b => {
                if *buf.get(i + 1)? == b'\\' {
                    return Some(i + 2);
                }
                i += 1;
            }
            _ if i > 4096 => return Some(i),
            _ => i += 1,
        }
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
        // 64 up, 65 down, 66 left, 67 right; trackpads emit the horizontal
        // pair whenever a two-finger scroll drifts sideways.
        match b & 3 {
            0 => MouseKind::ScrollUp,
            1 => MouseKind::ScrollDown,
            2 => MouseKind::ScrollLeft,
            _ => MouseKind::ScrollRight,
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

/// Finds `ESC ] {selector} rgb:RRRR/GGGG/BBBB` and reads the high byte of
/// each channel; terminals report 1-4 hex digits per channel.
fn parse_osc_color(buf: &[u8], selector: &str) -> Option<[u8; 4]> {
    let text = String::from_utf8_lossy(buf);
    let prefix = format!("\x1b]{selector}rgb:");
    let start = text.find(&prefix)? + prefix.len();
    let spec: String = text[start..]
        .chars()
        .take_while(|c| c.is_ascii_hexdigit() || *c == '/')
        .collect();
    let mut channels = spec.split('/').map(|hex| {
        let value = u16::from_str_radix(hex, 16).ok()?;
        Some(match hex.len() {
            1 => (value * 17) as u8,
            2 => value as u8,
            3 => (value >> 4) as u8,
            4 => (value >> 8) as u8,
            _ => return None,
        })
    });
    let r = channels.next()??;
    let g = channels.next()??;
    let b = channels.next()??;
    Some([r, g, b, 255])
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
    fn parses_probe_replies() {
        let parse = |buf: &[u8]| parse_probe_reply(buf, b"_Gi=299;");
        assert_eq!(parse(b"\x1b_Gi=299;OK\x1b\\"), Some(true));
        assert_eq!(parse(b"noise\x1b_Gi=299;ENOENT:not found\x1b\\"), Some(false));
        assert_eq!(parse(b"\x1b_Gi=299;O"), None, "partial");
        assert_eq!(parse(b"\x1b[?1016;1$y"), None);
    }

    #[test]
    #[allow(unsafe_code)]
    fn shm_roundtrip() {
        let name = format!("/px-test-{}", std::process::id());
        let data: Vec<u8> = (0..8192).map(|i| (i % 251) as u8).collect();
        write_shm(&name, &data).unwrap();

        let fd = rustix::shm::open(&name, rustix::shm::OFlags::RDONLY, rustix::fs::Mode::empty())
            .unwrap();
        // SAFETY: read-only mapping of the object just written, sized to
        // match, unmapped before the fd closes.
        let read_back = unsafe {
            let ptr = rustix::mm::mmap(
                std::ptr::null_mut(),
                data.len(),
                rustix::mm::ProtFlags::READ,
                rustix::mm::MapFlags::SHARED,
                &fd,
                0,
            )
            .unwrap();
            let bytes = std::slice::from_raw_parts(ptr.cast::<u8>(), data.len()).to_vec();
            rustix::mm::munmap(ptr, data.len()).unwrap();
            bytes
        };
        rustix::shm::unlink(&name).unwrap();
        assert_eq!(read_back, data);
    }

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
        assert_eq!(
            parse_sgr_mouse(b"<66;1;1", true).unwrap().0,
            MouseKind::ScrollLeft
        );
        assert_eq!(
            parse_sgr_mouse(b"<67;1;1", true).unwrap().0,
            MouseKind::ScrollRight
        );
        assert_eq!(parse_sgr_mouse(b"0;1;1", true), None);
        assert_eq!(parse_sgr_mouse(b"<0;0;1", true), None);
    }

    #[test]
    fn parse_event_consumes_one_event_and_reports_incomplete_tails() {
        assert_eq!(parse_event(b""), None);
        assert_eq!(parse_event(b"a"), Some((RawEvent::Key(Key::Char('a')), 1)));
        assert_eq!(parse_event(b"\x1b"), None, "escape alone: wait for more");
        assert_eq!(parse_event(b"\x1b["), None);
        assert_eq!(parse_event(b"\x1b[<65;10;2"), None, "mouse mid-sequence");
        assert_eq!(
            parse_event(b"\x1b[<65;10;20Mxyz"),
            Some((
                RawEvent::Mouse(MouseKind::ScrollDown, MouseButton::Middle, 10, 20),
                12
            ))
        );
        assert_eq!(parse_event(b"\x1b[Aq"), Some((RawEvent::Key(Key::Up), 3)));
        assert_eq!(parse_event(b"\x1b[I"), Some((RawEvent::Focus(true), 3)));
        assert_eq!(parse_event(b"\x1b[O"), Some((RawEvent::Focus(false), 3)));
        assert_eq!(parse_event(b"\x1bOP"), Some((RawEvent::Key(Key::Unknown), 2)));
    }

    #[test]
    fn terminal_reply_strings_never_leak_as_keystrokes() {
        // xterm.js < May 2026 replies OK to every transmission despite q=2.
        assert_eq!(
            parse_event(b"\x1b_Gi=1;OK\x1b\\"),
            Some((RawEvent::Key(Key::Unknown), 11))
        );
        assert_eq!(parse_event(b"\x1b_Gi=1;OK"), None, "reply mid-arrival");
        assert_eq!(
            parse_event(b"\x1b]11;rgb:1e/2a/34\x07x"),
            Some((RawEvent::Key(Key::Unknown), 18)),
            "late OSC reply, BEL-terminated"
        );
        assert_eq!(
            parse_event(b"\x1bP1$r0m\x1b\\"),
            Some((RawEvent::Key(Key::Unknown), 9))
        );
    }

    #[test]
    fn parses_osc_color_replies() {
        let reply =
            b"\x1b]11;rgb:1e1e/2a2a/3434\x1b\\\x1b]10;rgb:ff/ee/dd\x07\x1b]4;13;rgb:9f/86/eb\x1b\\";
        assert_eq!(parse_osc_color(reply, "11;"), Some([0x1e, 0x2a, 0x34, 255]));
        assert_eq!(parse_osc_color(reply, "10;"), Some([0xff, 0xee, 0xdd, 255]));
        assert_eq!(
            parse_osc_color(reply, "4;13;"),
            Some([0x9f, 0x86, 0xeb, 255])
        );
        assert_eq!(parse_osc_color(reply, "4;2;"), None);
        assert_eq!(parse_osc_color(b"garbage", "11;"), None);
    }

    #[test]
    fn parses_decrqm_mouse_pixel_reply() {
        assert_eq!(parse_decrqm_1016(b"\x1b[?1016;1$y"), Some(true));
        assert_eq!(parse_decrqm_1016(b"\x1b[?1016;2$y"), Some(false));
        assert_eq!(parse_decrqm_1016(b"\x1b[?1016;0$y"), Some(false));
        assert_eq!(parse_decrqm_1016(b"\x1b[?1015;1$y"), None);
    }
}
