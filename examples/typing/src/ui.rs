use pixel_core::{
    Align, Border, Canvas, Color, Dimension, Edges, FlexDirection, Glide, Justify, Node, Overflow,
    Scene, ScrollProfile, Smooth, Style, TerminalColors, Tui, fontdue, measure_text,
};

static SCROLL_SMOOTH: Smooth = Smooth {
    tau: 0.08,
    brake: 0.025,
};
static SCROLL_GLIDE: Glide = Glide {
    tau: 0.07,
    friction: 0.20,
    gain: 1.0,
};
static SCROLL_TUI: Tui = Tui;

pub const PROFILES: [&'static dyn ScrollProfile; 3] =
    [&SCROLL_SMOOTH, &SCROLL_GLIDE, &SCROLL_TUI];

impl App {
    /// Native mode still needs an integrator for programmatic moves like
    /// caret follow; wheel deltas bypass it and write positions directly.
    pub fn profile(&self) -> &'static dyn ScrollProfile {
        if self.native_active() {
            &SCROLL_SMOOTH
        } else {
            PROFILES[self.scroll_profile]
        }
    }

    pub fn native_active(&self) -> bool {
        self.scroll_profile == PROFILES.len()
    }

    pub fn enable_native(&mut self) {
        self.native = true;
        self.scroll_profile = PROFILES.len();
    }

    pub fn cycle_scroll_profile(&mut self) {
        let cycle = PROFILES.len() + self.native as usize;
        self.scroll_profile = (self.scroll_profile + 1) % cycle;
    }

    pub fn profile_label(&self) -> String {
        if self.native_active() {
            return "scroll: native".into();
        }
        let debug = format!("{:?}", PROFILES[self.scroll_profile]);
        let name = debug.split_whitespace().next().unwrap_or("?").to_lowercase();
        format!("scroll: {name}")
    }
}

/// All chrome is sized in multiples of the base font size (em-style):
/// terminals disagree on whether a "pixel" is a device or logical pixel, but
/// base_px is derived from the cell height so it carries the right density.
fn editor_pad(rem: f32) -> f32 {
    rem * 1.1
}

pub const FONT_UI: usize = 0;
pub const FONT_MONO: usize = 1;

/// Fallback palette (the previous hardcoded look) for terminals that don't
/// answer color queries.
const FALLBACK_BG: Color = [22, 22, 30, 255];
const FALLBACK_FG: Color = [222, 220, 235, 255];
const FALLBACK_ACCENT: Color = [159, 134, 235, 255];
const FALLBACK_RED: Color = [220, 90, 100, 255];

pub struct Theme {
    pub bg: Color,
    fg: Color,
    muted: Color,
    sidebar_bg: Color,
    item_hover: Color,
    item_active: Color,
    accent: Color,
    chip_bg: Color,
    hairline: Color,
    recording: Color,
}

impl Theme {
    /// Derives the whole palette from the terminal's reported colors, mixing
    /// toward fg/bg so it works for both dark and light themes.
    pub fn from_terminal(colors: &TerminalColors) -> Self {
        let bg = colors.background.unwrap_or(FALLBACK_BG);
        let fg = colors.foreground.unwrap_or(FALLBACK_FG);
        // ANSI 13 (bright magenta) reads as "accent" in most themes.
        let accent = colors.palette[13]
            .or(colors.palette[12])
            .unwrap_or(FALLBACK_ACCENT);
        let red = colors.palette[1].unwrap_or(FALLBACK_RED);

        Self {
            bg,
            fg,
            muted: mix(fg, bg, 0.45),
            sidebar_bg: mix(bg, fg, 0.04),
            item_hover: mix(bg, fg, 0.10),
            item_active: mix(bg, accent, 0.35),
            accent,
            chip_bg: mix(bg, fg, 0.09),
            hairline: mix(bg, fg, 0.15),
            recording: mix(bg, red, 0.75),
        }
    }
}

fn mix(base: Color, toward: Color, t: f32) -> Color {
    let channel = |b: u8, t2: u8| (b as f32 + (t2 as f32 - b as f32) * t) as u8;
    [
        channel(base[0], toward[0]),
        channel(base[1], toward[1]),
        channel(base[2], toward[2]),
        255,
    ]
}

pub struct App {
    pub notes: Vec<Note>,
    pub active: usize,
    pub theme: Theme,
    pub editor_scroll: f32,
    /// Pins the editor to the bottom; wheel turns it off, typing back on.
    pub follow: bool,
    pub scroll_profile: usize,
    /// Whether the macOS scroll helper spawned; adds "native" to the cycle.
    pub native: bool,
    pub stats: FrameStats,
}

/// Rolling frame timings from the main loop, shown in the status bar.
#[derive(Default)]
pub struct FrameStats {
    pub frame_ms: f32,
    pub fps: f32,
}

pub struct Note {
    pub title: String,
    pub text: String,
}

pub fn px_for_cell_height(font: &fontdue::Font, cell_height: f32) -> f32 {
    let probe = font
        .horizontal_line_metrics(100.0)
        .expect("font has horizontal metrics");
    (cell_height * 100.0 / probe.new_line_size).clamp(6.0, 512.0)
}

pub fn build_ui(app: &App, window: (u32, u32), base_px: f32, recording: bool) -> Node<App> {
    let small = base_px * 0.85;
    let rem = base_px;
    let hair = (rem / 16.0).max(1.0);
    let t = &app.theme;

    let mut sidebar_children = vec![Node {
        style: Style {
            padding: Edges::symmetric(rem * 0.6, rem * 0.35),
            color: Some(t.muted),
            font_size: Some(small),
            ..Style::default()
        },
        text: Some("VAULT".into()),
        ..Node::default()
    }];
    for (i, note) in app.notes.iter().enumerate() {
        let active = i == app.active;
        sidebar_children.push(Node {
            style: Style {
                padding: Edges::symmetric(rem * 0.6, rem * 0.35),
                corner_radius: rem * 0.4,
                background: active.then_some(t.item_active),
                hover_background: (!active).then_some(t.item_hover),
                color: Some(if active { t.fg } else { t.muted }),
                hover_color: (!active).then_some(t.fg),
                ..Style::default()
            },
            text: Some(note.title.clone()),
            on_click: Some(Box::new(move |app: &mut App| {
                app.active = i;
                app.follow = true;
            })),
            ..Node::default()
        });
    }
    sidebar_children.push(Node {
        style: Style {
            flex_grow: 1.0,
            ..Style::default()
        },
        ..Node::default()
    });
    sidebar_children.push(Node {
        style: Style {
            padding: Edges::symmetric(rem * 0.6, rem * 0.35),
            corner_radius: rem * 0.4,
            border: Some(Border {
                width: hair,
                color: t.hairline,
            }),
            color: Some(t.accent),
            hover_background: Some(t.item_hover),
            ..Style::default()
        },
        text: Some("+ new note".into()),
        on_click: Some(Box::new(|app: &mut App| {
            app.notes.push(Note {
                title: format!("untitled {}", app.notes.len() + 1),
                text: String::new(),
            });
            app.active = app.notes.len() - 1;
            app.follow = true;
        })),
        ..Node::default()
    });

    let sidebar = Node {
        style: Style {
            flex_direction: FlexDirection::Column,
            width: Dimension::Px(rem * 14.0),
            // Inset from the window edges: terminals often pad the grid, so a
            // floating panel reads better than a flush one. Height comes from
            // the row's default stretch, which respects the margin.
            margin: Edges::all(rem * 0.4),
            padding: Edges::all(rem * 0.6),
            gap: rem * 0.125,
            background: Some(t.sidebar_bg),
            corner_radius: rem * 0.6,
            ..Style::default()
        },
        children: sidebar_children,
        ..Node::default()
    };

    let title_bar = Node {
        style: Style {
            justify_content: Some(Justify::SpaceBetween),
            align_items: Some(Align::Center),
            padding: Edges::symmetric(editor_pad(rem), rem * 0.7),
            ..Style::default()
        },
        children: vec![
            Node {
                style: Style {
                    font_size: Some(base_px * 1.35),
                    ..Style::default()
                },
                text: Some(app.notes[app.active].title.clone()),
                ..Node::default()
            },
            chip("markdown", small, t.muted, t.chip_bg),
        ],
        ..Node::default()
    };

    let mut status_right = vec![];
    if recording {
        status_right.push(chip("REC", small, t.fg, t.recording));
    }
    status_right.push(chip(
        &app.profile_label(),
        small,
        t.accent,
        t.chip_bg,
    ));
    status_right.push(chip(
        &format!("{} lines", app.notes[app.active].text.lines().count()),
        small,
        t.muted,
        t.chip_bg,
    ));
    status_right.push(chip(
        &format!("{:.0}px", app.editor_scroll),
        small,
        t.muted,
        t.chip_bg,
    ));
    if app.stats.frame_ms > 0.0 {
        status_right.push(chip(
            &format!("{:.1}ms", app.stats.frame_ms),
            small,
            t.muted,
            t.chip_bg,
        ));
        status_right.push(chip(
            &format!("{:.0}fps", app.stats.fps),
            small,
            t.accent,
            t.chip_bg,
        ));
    }
    let status_bar = Node {
        style: Style {
            justify_content: Some(Justify::SpaceBetween),
            align_items: Some(Align::Center),
            padding: Edges::symmetric(rem * 0.75, rem * 0.5),
            ..Style::default()
        },
        children: vec![
            Node {
                style: Style {
                    color: Some(t.muted),
                    font_size: Some(small),
                    ..Style::default()
                },
                text: Some("ctrl-s scroll feel / ctrl-p profile / ctrl-c quit".into()),
                ..Node::default()
            },
            Node {
                style: Style {
                    gap: rem * 0.5,
                    align_items: Some(Align::Center),
                    ..Style::default()
                },
                children: status_right,
                ..Node::default()
            },
        ],
        ..Node::default()
    };

    let main = Node {
        style: Style {
            flex_direction: FlexDirection::Column,
            flex_grow: 1.0,
            ..Style::default()
        },
        children: vec![
            title_bar,
            Node {
                style: Style {
                    height: Dimension::Px(hair),
                    width: Dimension::Percent(1.0),
                    background: Some(t.hairline),
                    ..Style::default()
                },
                ..Node::default()
            },
            Node {
                style: Style {
                    flex_direction: FlexDirection::Column,
                    flex_grow: 1.0,
                    overflow: Overflow::Scroll,
                    ..Style::default()
                },
                id: Some("editor"),
                scroll_offset: app.editor_scroll,
                children: vec![Node {
                    style: Style {
                        padding: Edges::all(editor_pad(rem)),
                        flex_shrink: 0.0,
                        ..Style::default()
                    },
                    id: Some("editor-text"),
                    text: Some(app.notes[app.active].text.clone()),
                    ..Node::default()
                }],
                ..Node::default()
            },
            status_bar,
        ],
        ..Node::default()
    };

    Node {
        style: Style {
            width: Dimension::Px(window.0 as f32),
            height: Dimension::Px(window.1 as f32),
            color: Some(t.fg),
            font_size: Some(base_px),
            font: Some(FONT_UI),
            ..Style::default()
        },
        children: vec![sidebar, main],
        ..Node::default()
    }
}

fn chip(label: &str, px: f32, color: Color, background: Color) -> Node<App> {
    Node {
        style: Style {
            padding: Edges::symmetric(px * 0.7, px * 0.2),
            corner_radius: 999.0,
            background: Some(background),
            color: Some(color),
            font_size: Some(px),
            font: Some(FONT_MONO),
            ..Style::default()
        },
        text: Some(label.into()),
        ..Node::default()
    }
}

/// Scroll needed to put the last line at the bottom; mirrors the layout
/// math (the text child is padded lines of text) rather than reading taffy.
pub fn editor_max_scroll(app: &App, font: &fontdue::Font, px: f32, viewport_h: f32) -> f32 {
    let Some(line_metrics) = font.horizontal_line_metrics(px) else {
        return 0.0;
    };
    let lines = app.notes[app.active].text.split('\n').count();
    let content_h = editor_pad(px) * 2.0 + line_metrics.new_line_size * lines as f32;
    (content_h - viewport_h).max(0.0)
}

pub fn paint_caret(
    canvas: &mut Canvas,
    scene: &Scene<App>,
    font: &fontdue::Font,
    px: f32,
    app: &App,
) {
    let Some(viewport) = scene.rect("editor") else {
        return;
    };
    let Some(text_rect) = scene.rect("editor-text") else {
        return;
    };
    let Some(line_metrics) = font.horizontal_line_metrics(px) else {
        return;
    };
    let line_height = line_metrics.new_line_size;
    let lines: Vec<&str> = app.notes[app.active].text.split('\n').collect();
    let pad = editor_pad(px);
    let caret_x = text_rect.x + pad + measure_text(font, lines[lines.len() - 1], px);
    let caret_top = text_rect.y + pad + line_height * (lines.len() - 1) as f32;

    canvas.push_clip(viewport.x, viewport.y, viewport.w, viewport.h);
    canvas.fill_rounded_rect(
        caret_x,
        caret_top,
        (px / 8.0).max(2.0),
        line_height,
        1.5,
        app.theme.accent,
    );
    canvas.pop_clip();
}
