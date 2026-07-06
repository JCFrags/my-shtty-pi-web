# Protocol capabilities to research before building

The luma POC (kitty-graphics-explore) proved the model: retained per-region planes,
damage tracking, ~60-byte placement moves, pixel mouse. But it transmits every
changed plane as a full zlib+base64 RGBA image over the escape stream, re-ships
whole planes when any pixel changes, writes multi-plane frames unsynchronized,
and handles tmux with a passthrough + heartbeat hack. The four protocol features
below address exactly those four weaknesses. Each section lists what we know,
what to verify empirically, and open questions.

---

## 1. Shared-memory transmission (`t=s`)

**What it is.** Instead of base64-encoding pixel data into the escape stream
(`t=d`, what the POC does), the client writes raw pixels into a POSIX shared
memory object (`shm_open` + `ftruncate` + `mmap`) and sends only the shm name
in the escape payload. The terminal maps it directly. No base64 (4/3 inflation),
no chunking, no escape-stream parsing of megabytes, no zlib needed.

**Support.** kitty (reference impl), Ghostty (merged Aug 2024, PR ghostty-org/ghostty#2064).
`kitten icat --transfer-mode=memory` is a working reference client.

**To verify:**
- [ ] Measure transfer latency vs `t=d` for typical plane sizes (a full-window
      plane at ~2100×1320 and a small input-bar plane) on Ghostty and kitty.
- [ ] Lifecycle: who unlinks the shm object and when? (Spec says terminal
      unlinks after reading; confirm on both terminals. The tuios commit notes
      guest-managed lifecycle when proxying.)
- [ ] Detection: how do we know the terminal supports `t=s` AND is local?
      Probable answer: send a tiny `t=s` transmit with a query (`q=1`/`i` +
      response), fall back to `t=d`. Also SSH detection (env, or just the probe
      failing).
- [ ] WezTerm / Konsole support status for `t=s`.
- [ ] macOS specifics: shm name length limits (PSHMNAMLEN ~31 chars on darwin?),
      permissions, sandboxed terminals.
- [ ] Can we keep a pool of shm buffers and rotate them (avoid create/unlink
      per frame)? Does the terminal read synchronously before responding, i.e.
      when is it safe to reuse the buffer?

**Design implication if it works:** the paint surface can *be* the shm buffer —
widgets rasterize directly into terminal-readable memory; the escape stream
carries only control. That collapses encode cost to zero.

## 2. Animation-frame deltas (`a=f` / `a=a`)

**What it is.** The protocol's animation facility doubles as a sub-rectangle
update mechanism: after transmitting an image, you can transmit data for *part*
of a frame (x/y offset + width/height within the image) and tell the terminal to
compose it onto an existing frame, then display it. In-place partial updates of
an already-placed image — no re-ship of the whole plane, no delete/re-place flicker.

Notcurses uses exactly this trick (`NCPIXEL_KITTY_ANIMATED` / `KITTY_SELFREF`
tiers, incl. `a=c` self-referential composition from 0.22.0) for cell wiping
and redraws.

**Why it matters for us.** The POC's unit of damage is a whole plane: one dirty
pixel in the messages plane re-ships ~50 KB. With frame deltas the unit of damage
becomes an arbitrary rect *within* a plane. Combined with shm, a caret blink
could cost a ~20×40px update.

**To verify:**
- [ ] Exact key grammar for composing onto the *current* root frame vs a named
      frame (`r=`, `c=`, `x=`,`y=` keys in `a=f` transmissions) — read the
      "Transferring animation frame data" section of the spec carefully.
- [ ] Does a frame-delta update to a displayed image repaint immediately without
      a new placement (`a=p`)? Any flicker?
- [ ] Support matrix: kitty yes; Ghostty? WezTerm? Konsole? (Ghostty's kitty
      graphics impl is newer — animation support may be partial. Test.)
- [ ] Interaction with `t=s`: can frame data itself ride shared memory? (mpv
      `--vo=kitty --vo-kitty-use-shm=yes` suggests yes in kitty; Ghostty had
      a chunking bug with mpv per PR #2064 discussion.)
- [ ] Cost model: at what damage-area fraction is a delta cheaper than a full
      plane re-ship? (Probably almost always with shm; matters more for t=d.)
- [ ] Fallback strategy detection — how notcurses degrades across its three
      kitty tiers is a ready-made map of version/capability gates.

## 3. Synchronized updates (mode 2026 / DCS BSU-ESU)

**What it is.** `CSI ? 2026 h` … `CSI ? 2026 l` (or `DCS =1s ST` / `DCS =2s ST`)
brackets output so the terminal presents it atomically — no intermediate paints.
A multi-plane commit (e.g. sidebar + messages + input bar in one frame, or a
delete+replace of a placement) renders without tearing or one-plane-early flicker.

**To verify:**
- [ ] Which terminals honor it around *graphics* escapes, not just text?
      (tuios wraps kitty graphics in BSU/ESU, suggesting it works; confirm on
      Ghostty, kitty, WezTerm.)
- [ ] Detection via DECRQM query for mode 2026 (same probe machinery the POC
      already has for mode 1016).
- [ ] Timeout behavior: terminals force-present after N ms if ESU never arrives —
      what are the budgets? Does a large shm transfer inside a sync block risk
      hitting them?
- [ ] Does wrapping every frame have a latency cost on terminals that
      double-buffer anyway?

**Design implication:** the renderer's flush becomes `BSU + (all plane ops) + ESU`
— which also means we can stop being clever about op ordering to minimize
visible intermediate states.

## 4. Unicode placeholders (graphics through tmux/mux)

**What it is.** Instead of positioning images with placements tied to escape-time
cursor position, transmit the image with `U=1` and place it by writing rows of
U+10EEEE placeholder characters whose fg color + diacritics encode image ID and
row/column. The image then behaves *like text cells*: tmux/screen scroll, redraw,
and reflow them like any other cells, so placements survive mux redraws without
our re-assertion heartbeat.

The POC instead wraps escapes in tmux DCS passthrough, computes pane origin via
`tmux display-message`, and re-asserts placements at 4 Hz — fragile and wasteful.

**To verify:**
- [ ] Support matrix: kitty (origin of the extension), Ghostty, WezTerm, Konsole;
      and inside tmux ≥ 3.4 (which added forwarding of the relevant bits?) —
      confirm what tmux versions do with U+10EEEE cells natively.
- [ ] Pixel offsets: placeholder placement is cell-granular. Do we lose the
      sub-cell `X=`/`Y=` offsets the POC uses for pixel-precise plane positions?
      If yes, mux mode may need cell-aligned layout (probably acceptable).
- [ ] z-ordering and overlap between placeholder images (diacritic encoding
      supports multiple placements? one image per cell?).
- [ ] Cost of repainting placeholder cells vs re-asserting placements.
- [ ] Interplay with 24-bit color (placeholder encodes ID in fg color — conflicts
      with truecolor escape handling in muxes?). There's an 8-digit ID variant
      via extra diacritics; check what tmux preserves.

## 5. Other threads worth a pass (lower priority)

- **Capability probing in general.** One startup interrogation: DA1, DECRQM 1016
  (pixel mouse) / 2026 (sync) / 2027?, kitty graphics query (`a=q`), kitty
  keyboard protocol progressive enhancement, XTGETTCAP. Build the detection
  matrix once, drive backend selection from it. (POC does env-var sniffing —
  brittle.)
- **Compression on `t=d`.** `o=z` zlib is what the POC uses; check whether
  terminals accept zlib with `t=s`/`t=f` too (spec says o=z applies to any
  medium) — probably irrelevant once shm works, needed for the SSH path.
- **iTerm2/OSC 1337 path.** No shm, no deltas, no placements — the POC's
  compose-locally + ship-dirty-PNG-crops approach is likely already optimal
  there. Confirm whether iTerm2's newer builds added kitty protocol support
  (it was discussed upstream).
- **Sixel:** still skip (palette quantization butchers AA text/gradients), but
  note Jexer's HQSixelEncoder claims ~20-bit effective depth via PCA if we ever
  need a last-resort fallback.
- **Prior-art code to read before writing ours:**
  - notcurses `sprixel` machinery — kitty tier degradation, cell wiping via
    frame composition (dankamongmen/notcurses).
  - awrit / glimpse-tty — CEF paint-rect → kitty damage path and input
    forwarding (chase/awrit).
  - kitten icat source — canonical `t=s` client behavior.
  - kui.nvim — scene-graph-over-kitty design (romgrk/kui.nvim), and why it
    topped out at ~30fps.
  - egui-term (flaneur2020/egui-term) — 2026 experiment, offscreen wgpu → kitty.

## References

- kitty graphics protocol spec: https://sw.kovidgoyal.net/kitty/graphics-protocol/
  (sections: shared memory transmission, animation, unicode placeholders, deletion)
- Ghostty shm support: https://github.com/ghostty-org/ghostty/pull/2064
- Synchronized output spec (contour): https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md
- tmux passthrough vs placeholders context: tuios commit dbf28f5 (Gaurav-Gosain/tuios)
- notcurses pixel tiers: USAGE.md `ncpixelimpl_e` (NCPIXEL_KITTY_STATIC/ANIMATED/SELFREF)
- POC baseline numbers to beat: kitty-graphics-explore/README.md (1.1 ms keypress
  latency, ~8 KB per keypress, 0 bytes idle — all with t=d + full-plane re-ships)
