use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};

use crate::terminal::Waker;

pub struct NativeDelta {
    pub delta_y: f32,
    pub precise: bool,
}

enum Msg {
    Scale(f32),
    Delta(NativeDelta),
}

pub struct NativeScroll {
    child: Child,
    rx: Receiver<Msg>,
    pub scale: f32,
}

impl NativeScroll {
    pub fn spawn(waker: Option<Waker>) -> Option<Self> {
        let path = std::env::var("NATIVE_SCROLL_HELPER")
            .ok()
            .or_else(|| option_env!("NATIVE_SCROLL_HELPER").map(String::from))?;
        let mut child = Command::new(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let stdout = child.stdout.take()?;
        let (tx, rx) = channel();
        std::thread::spawn(move || read_lines(stdout, &tx, waker.as_ref()));
        Some(Self {
            child,
            rx,
            scale: 2.0,
        })
    }

    pub fn drain(&mut self) -> Vec<NativeDelta> {
        let mut deltas = Vec::new();
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                Msg::Scale(scale) => self.scale = scale,
                Msg::Delta(delta) => deltas.push(delta),
            }
        }
        deltas
    }
}

impl Drop for NativeScroll {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn read_lines(stdout: std::process::ChildStdout, tx: &Sender<Msg>, waker: Option<&Waker>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else {
            return;
        };
        let fields: Vec<&str> = line.split_whitespace().collect();
        let msg = match fields[..] {
            ["scale", scale] => scale.parse().ok().map(Msg::Scale),
            ["s", delta, _phase, _momentum, precise] => delta.parse().ok().map(|delta_y| {
                Msg::Delta(NativeDelta {
                    delta_y,
                    precise: precise == "1",
                })
            }),
            _ => None,
        };
        if let Some(msg) = msg {
            if tx.send(msg).is_err() {
                return;
            }
            if let Some(waker) = waker {
                waker.wake();
            }
        }
    }
}
