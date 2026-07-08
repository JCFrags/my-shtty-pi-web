---
name: verify
description: Drive the typing example headlessly in a pty and decode its kitty-graphics frames into PNGs for visual verification.
---

The apps here render via the kitty graphics protocol, so they can be verified
without a real terminal: spawn the binary in a Python pty, feed it bytes, and
decode the frames it emits.

1. `cargo build --workspace`, binary at `target/debug/typing`.
2. Spawn in a pty with `TIOCSWINSZ` set including **pixel** dimensions (e.g.
   rows=30 cols=100 xpixel=800 ypixel=600) so the app skips the `CSI 16 t`
   cell-size query. Set `TERM=xterm-kitty`, `preexec_fn=os.setsid`.
3. While pumping output, answer the mouse-capability probe: when
   `\x1b[?1016$p` appears, write back `\x1b[?1016;1$y` — then mouse event
   coordinates are pixels, easy to aim. Color queries can be ignored (the app
   times out and uses fallbacks).
4. Input bytes: keys are plain ASCII (`\r` for Enter, `\x03` for Ctrl-C quit),
   wheel up/down over pixel (x, y) is `\x1b[<64;x;yM` / `\x1b[<65;x;yM`.
5. Frames arrive as `\x1b_Ga=T,f=32,o=z,s=W,v=H,...;base64\x1b\\`, chunked
   with `m=1` continuations. Concatenate chunk payloads, base64-decode,
   `zlib.decompress` → raw RGBA; count frames with `data.count(b"a=T,f=32")`
   to assert which inputs caused redraws. Write RGBA to PNG (pure-python,
   no Pillow installed) and Read the file to look at it.
6. Keep pumping the pty after `\x03` or the exit never gets observed.

A working harness from a previous session:
`drive_typing.py` in the session scratchpad — recreate from this recipe if gone.
