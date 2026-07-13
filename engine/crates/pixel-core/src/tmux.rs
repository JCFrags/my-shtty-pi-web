pub fn in_tmux() -> bool {
    std::env::var_os("TMUX").is_some()
}

/// Passthrough requires tmux's `allow-passthrough` pane option (tmux >= 3.3),
/// which is off by default. Setting it for just our pane is safe, so do it
/// instead of asking the user to edit their tmux config.
pub fn enable_passthrough() {
    let _ = std::process::Command::new("tmux")
        .args(["set", "-p", "allow-passthrough", "on"])
        .output();
}

/// Wraps a sequence so tmux forwards it verbatim to the outer terminal:
/// `ESC P tmux;` ... `ESC \`, with every ESC in the payload doubled.
pub fn passthrough(seq: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(seq.len() + 16);
    out.extend_from_slice(b"\x1bPtmux;");
    for &byte in seq {
        if byte == 0x1b {
            out.push(0x1b);
        }
        out.push(byte);
    }
    out.extend_from_slice(b"\x1b\\");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_doubles_escapes_and_wraps() {
        assert_eq!(
            passthrough(b"\x1b_Gi=1;AA\x1b\\"),
            b"\x1bPtmux;\x1b\x1b_Gi=1;AA\x1b\x1b\\\x1b\\"
        );
    }
}
