use crate::ui::Note;

pub fn demo_notes() -> Vec<Note> {
    vec![
        Note {
            title: "fix flaky auth test".into(),
            text: flaky_test_session(),
        },
        Note {
            title: "add scroll profiles".into(),
            text: scroll_profiles_session(),
        },
        Note {
            title: "hunt render regression".into(),
            text: render_regression_session(),
        },
        Note {
            title: "scratch".into(),
            text: String::new(),
        },
    ]
}

fn flaky_test_session() -> String {
    let mut t = String::new();
    t.push_str(
        "› the auth tests fail like 1 in 10 runs on CI, can you figure out why\n\
         \n\
         ● I'll start by running the suite enough times to reproduce the flake\n\
         locally, then narrow down which test is time-sensitive.\n\
         \n\
         ● Bash(go test ./internal/auth/... -count=25 -run TestToken)\n",
    );
    for i in 1..=6 {
        t.push_str(&format!("  │ ok   internal/auth  0.4{:02}s (run {i})\n", 7 * i));
    }
    t.push_str(
        "  │ --- FAIL: TestTokenExpiry (0.03s)\n\
         \x20 │     token_test.go:71: token expired 1ms before ExpiresAt\n\
         \x20 │ FAIL  internal/auth  0.442s (run 7)\n\
         \n\
         ● Reproduced on run 7 of 25. TestTokenExpiry asserts an exact expiry\n\
         boundary, which smells like two separate clock reads racing. Reading the\n\
         implementation and the test.\n\
         \n\
         ● Read(internal/auth/token.go)\n\
         \x20 │ Read 182 lines\n\
         \n\
         ● Read(internal/auth/token_test.go)\n\
         \x20 │ Read 143 lines\n\
         \n\
         ● Found it. NewToken reads the clock twice:\n\
         \n\
         \x20   IssuedAt:  time.Now(),\n\
         \x20   ExpiresAt: time.Now().Add(ttl),\n\
         \n\
         Any scheduler hiccup between the two calls shrinks the real TTL below\n\
         ttl, and the test asserts the boundary exactly. The fix is one clock\n\
         read shared by both fields.\n\
         \n\
         ● Edit(internal/auth/token.go)\n\
         \x20 │ Added 3 lines, removed 2 lines\n\
         \x20 │   - IssuedAt:  time.Now(),\n\
         \x20 │   - ExpiresAt: time.Now().Add(ttl),\n\
         \x20 │   + now := time.Now()\n\
         \x20 │   + IssuedAt:  now,\n\
         \x20 │   + ExpiresAt: now.Add(ttl),\n\
         \n\
         ● The test itself also deserves hardening — it should inject a fake\n\
         clock instead of sleeping against the real one.\n\
         \n\
         ● Edit(internal/auth/token_test.go)\n\
         \x20 │ Added 9 lines, removed 4 lines\n\
         \x20 │   - token := NewToken(ttl)\n\
         \x20 │   - time.Sleep(ttl)\n\
         \x20 │   - if !token.Expired() {\n\
         \x20 │   + clock := clockwork.NewFakeClock()\n\
         \x20 │   + token := NewTokenAt(clock.Now(), ttl)\n\
         \x20 │   + clock.Advance(ttl - time.Nanosecond)\n\
         \x20 │   + if token.ExpiredAt(clock.Now()) {\n\
         \x20 │   +     t.Fatal(\"expired one tick early\")\n\
         \x20 │   + }\n\
         \x20 │   + clock.Advance(time.Nanosecond)\n\
         \x20 │   + if !token.ExpiredAt(clock.Now()) {\n\
         \n\
         ● NewTokenAt doesn't exist yet — adding it as the injectable core that\n\
         NewToken wraps.\n\
         \n\
         ● Edit(internal/auth/token.go)\n\
         \x20 │ Added 6 lines, removed 1 line\n\
         \n\
         ● Bash(go test ./internal/auth/... -count=200 -run TestToken)\n",
    );
    for i in 1..=8 {
        t.push_str(&format!(
            "  │ ok   internal/auth  0.4{:02}s (runs {}-{})\n",
            11 * i,
            25 * (i - 1) + 1,
            25 * i
        ));
    }
    t.push_str(
        "\n\
         ● Bash(go vet ./... && golangci-lint run internal/auth)\n\
         \x20 │ clean\n\
         \n\
         ● Fixed. The flake was a double clock read in NewToken splitting\n\
         IssuedAt and ExpiresAt across a scheduler boundary; 200 consecutive\n\
         runs now pass. The test also injects a fake clock, so it can never\n\
         race the wall clock again, and it now pins both sides of the expiry\n\
         boundary instead of only one.\n\
         \n\
         ▸ session: 14 tool calls · 3 files changed · +18 -7 · go test ×2\n",
    );
    t
}

fn scroll_profiles_session() -> String {
    let mut t = String::new();
    t.push_str(
        "› lets make the abstraction \"scroll profiles\" and have different\n\
         profiles, one being the default tui feel, and at least 2 others\n\
         \n\
         ● Good abstraction to force now — three genuinely different integrators\n\
         behind one interface. Plan: a ScrollState/ScrollProfile pair in\n\
         pixel-core, and a cycler in the example so you can A/B the feel live.\n\
         \n\
         ● Read(crates/pixel-core/src/scroll.rs)\n\
         \x20 │ Read 172 lines\n\
         \n\
         ● Write(crates/pixel-core/src/scroll/mod.rs)\n\
         \x20 │ Wrote 84 lines\n\
         \x20 │   pub trait ScrollProfile: std::fmt::Debug {\n\
         \x20 │       fn tick(&self, state: &mut ScrollState, delta: f32, max: f32);\n\
         \x20 │       fn step(&self, state: &mut ScrollState, dt: f32, max: f32);\n\
         \x20 │   }\n\
         \n\
         ● Write(crates/pixel-core/src/scroll/profiles/tui.rs)\n\
         \x20 │ Wrote 25 lines\n\
         \n\
         ● Write(crates/pixel-core/src/scroll/profiles/smooth.rs)\n\
         \x20 │ Wrote 72 lines\n\
         \n\
         ● Write(crates/pixel-core/src/scroll/profiles/glide.rs)\n\
         \x20 │ Wrote 83 lines\n\
         \n\
         ● The physics split cleanly: Tui snaps target to position, Smooth closes\n\
         63% of the gap per tau seconds, Glide adds velocity that coasts after\n\
         input stops and dies on edge contact.\n\
         \n\
         ● Bash(cargo test --workspace)\n",
    );
    for name in [
        "clip_restricts_all_drawing_and_pops_back_off",
        "nested_clips_intersect",
        "clip_masks_path_painting",
        "blend_mask_clips_out_of_bounds_positions",
        "scroll_area_reports_overflowing_content",
        "scroll_offset_shifts_children_and_clips_painting",
        "scrolled_out_children_do_not_take_clicks",
        "smooth_brakes_once_the_stream_goes_quiet",
        "glide_counter_tick_kills_the_coast_instead_of_fighting_it",
        "ticks_clamp_but_follow_targets_may_lead_content_growth",
        "parse_event_consumes_one_event_and_reports_incomplete_tails",
        "parses_osc_color_replies",
        "text_leaves_size_the_layout",
    ] {
        t.push_str(&format!("  │ test {name} ... ok\n"));
    }
    t.push_str(
        "  │ test result: ok. 31 passed; 0 failed\n\
         \n\
         ● Bash(cargo clippy --workspace --all-targets)\n\
         \x20 │ warning: very complex type used. Consider factoring parts into\n\
         \x20 │ `type` definitions  --> crates/pixel-core/src/scroll/mod.rs:14\n\
         \n\
         ● Fixing the lint with a type alias rather than suppressing it.\n\
         \n\
         ● Edit(crates/pixel-core/src/scroll/mod.rs)\n\
         \x20 │ Added 2 lines, removed 1 line\n\
         \n\
         ● Bash(cargo clippy --workspace --all-targets)\n\
         \x20 │ clean\n\
         \n\
         › hm this feels off reading the code. e.g tick has a random glide if\n\
         case here. id expect a generic api and then implementations in diff\n\
         files\n\
         \n\
         ● Agreed — the enum-with-match couples every profile's physics into one\n\
         function; profile-per-file with a trait is the right shape. The\n\
         Glide-only velocity logic that was squatting in the shared tick now\n\
         lives entirely in glide.rs, and adding a fourth profile is one new file\n\
         implementing two methods, engine changes zero.\n\
         \n\
         ● Verified end-to-end in the pty harness — same 5-tick gesture under\n\
         each profile:\n\
         \n\
         \x20   tui     5 frames (one per tick, instant)   settles 5 lines up\n\
         \x20   smooth  47 frames (eased, ~250ms)          settles 5 lines up\n\
         \x20   glide   119 frames (coasts after input)    settles ~10 lines up\n\
         \n\
         ▸ session: 22 tool calls · 9 files changed · +391 -168 · tests 31 ✓\n",
    );
    t
}

fn render_regression_session() -> String {
    let mut t = String::new();
    t.push_str(
        "› rn render performance is bottleneck check the last profile in\n\
         profiles\n\
         \n\
         ● Reading the latest recording from your live run.\n\
         \n\
         ● Read(profiles/profile-1783479530.json)\n\
         \x20 │ Read 44 frames\n\
         \n\
         ● ~46ms per frame — 21fps. Breakdown per frame:\n\
         \n\
         \x20   scene.paint      20.5ms   44%\n\
         \x20   scene.layout      9.8ms   21%\n\
         \x20   kitty.compress    6.5ms   14%\n\
         \x20   term.write        7.8ms   17%\n\
         \n\
         ● Three problems: every glyph rasterizes every frame with no cache, all\n\
         200 note lines paint even when clipped out, and the workspace crates\n\
         compile at opt-level 0 in dev while the per-pixel loops are the frame\n\
         budget.\n\
         \n\
         ● Edit(crates/pixel-core/src/canvas.rs)\n\
         \x20 │ Added 24 lines, removed 9 lines\n\
         \x20 │   glyph raster + advance caches keyed on\n\
         \x20 │   (font file hash, char, px bits)\n\
         \n\
         ● Edit(crates/pixel-core/src/scene.rs)\n\
         \x20 │ Added 10 lines\n\
         \x20 │   cull lines outside the clip, one line of slack\n\
         \n\
         ● Edit(Cargo.toml)\n\
         \x20 │ Added 4 lines\n\
         \x20 │   [profile.dev.package.pixel-core]\n\
         \x20 │   opt-level = 2\n\
         \n\
         ● Bash(bench: dev build, scripted scroll load)\n\
         \x20 │ scene.paint   13.8ms -> 0.8ms\n\
         \x20 │ scene.layout   6.2ms -> 0.6ms\n\
         \x20 │ frame total   26.5ms -> 11.0ms\n\
         \n\
         ● Render is fixed; the frame is now ~80% transport — zlib+base64 over\n\
         the pty at 540KB per frame. The kitty protocol has a medium for exactly\n\
         this: t=s shared-memory transmission. The escape carries only the shm\n\
         object name; pixels never cross the pty.\n\
         \n\
         ● Edit(crates/pixel-core/src/terminal.rs)\n\
         \x20 │ Added 41 lines, removed 6 lines\n\
         \n\
         ● Bash(cargo test --workspace)\n\
         \x20 │ test terminal::tests::shm_roundtrip ... ok\n\
         \x20 │ test result: ok. 31 passed; 0 failed\n\
         \n\
         ● Bash(bench: release build, shm transport)\n\
         \x20 │ kitty.shm     1.34ms mean\n\
         \x20 │ term.write    0.01ms\n\
         \x20 │ frame total   5.6ms -> 180 fps ceiling\n\
         \n\
         ● Where the frame time went, start to finish:\n\
         \n\
         \x20   baseline (your live run)        46.0ms   21 fps\n\
         \x20   engine crate at opt 2           11.0ms   91 fps\n\
         \x20   glyph cache + line culling       9.8ms  102 fps\n\
         \x20   shm transport                    5.7ms  175 fps\n\
         \n\
         ● The native delta burst regression test now produces 30 frames — one\n\
         per delta — where the same test produced 3 before, because frames no\n\
         longer outlast the delta cadence.\n\
         \n\
         ▸ session: 31 tool calls · 6 files changed · +214 -38 · 8× faster\n",
    );
    t
}
