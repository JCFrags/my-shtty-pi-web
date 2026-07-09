use pixel_core::{
    Align, Border, Color, Dimension, Edges, FlexDirection, Glide, InputAction, Justify,
    MenuEntry, MenuItem, MenuStyle, Node, Overflow, ScrollProfile, Smooth, Style, TerminalColors,
    TextInput, Tui, context_menu, fontdue,
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
    // what the hell is this
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
pub fn editor_pad(rem: f32) -> f32 {
    rem * 1.1
}

pub const FONT_UI: usize = 0;
pub const FONT_MONO: usize = 1;

/// Scene ids for the notes editor: the scroll viewport and the input inside.
pub const EDITOR: &str = "editor";
pub const EDITOR_INPUT: &str = "editor-text";

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
    selection: Color,
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
            selection: mix(bg, accent, 0.35),
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
    pub reveal_caret: bool,
    pub scroll_profile: usize,
    pub native: bool,
    pub stats: FrameStats,
    pub context_menu: Option<(f32, f32)>,
    /// Action chosen from a menu item, run by the main loop: item handlers
    /// can't reach the terminal for clipboard I/O.
    pub pending: Option<InputAction>,
}

/// Rolling frame timings from the main loop, shown in the status bar.
#[derive(Default)]
pub struct FrameStats {
    pub frame_ms: f32,
    pub fps: f32,
}

pub struct Note {
    pub title: String,
    pub input: TextInput,
}

pub fn px_for_cell_height(font: &fontdue::Font, cell_height: f32) -> f32 {
    let probe = font
        .horizontal_line_metrics(100.0)
        .expect("font has horizontal metrics");
    (cell_height * 100.0 / probe.new_line_size).clamp(6.0, 512.0)
}

pub fn build_ui(
    app: &App,
    window: (u32, u32),
    base_px: f32,
    recording: bool,
    font: &fontdue::Font,
) -> Node<App> {
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
        text: Some("header".into()),
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
                app.reveal_caret = true;
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
        text: Some("+ ".into()),
        on_click: Some(Box::new(|app: &mut App| {
            app.notes.push(Note {
                title: format!("untitled {}", app.notes.len() + 1),
                input: TextInput::new(String::new()),
            });
            app.active = app.notes.len() - 1;
            app.reveal_caret = true;
        })),
        ..Node::default()
    });

    let sidebar = Node {
        style: Style {
            flex_direction: FlexDirection::Column,
            width: Dimension::Px(rem * 14.0),
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
        &format!("{} lines", app.notes[app.active].input.text().lines().count()),
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
                text: Some("ctrl-s scroll feel / ctrl-p profile / ctrl-q quit".into()),
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
                id: Some(EDITOR),
                scroll_offset: app.editor_scroll,
                children: vec![{
                    let mut input = app.notes[app.active].input.node(t.accent, t.selection);
                    input.style = Style {
                        padding: Edges::all(editor_pad(rem)),
                        flex_shrink: 0.0,
                        ..Style::default()
                    };
                    input.id = Some(EDITOR_INPUT);
                    input
                }],
                ..Node::default()
            },
            status_bar,
        ],
        ..Node::default()
    };

    let mut children = vec![sidebar, main];
    if let Some(at) = app.context_menu {
        children.push(editor_menu(app, at, window, rem, font));
    }

    Node {
        style: Style {
            width: Dimension::Px(window.0 as f32),
            height: Dimension::Px(window.1 as f32),
            color: Some(t.fg),
            font_size: Some(base_px),
            font: Some(FONT_UI),
            ..Style::default()
        },
        children,
        ..Node::default()
    }
}

fn editor_menu(
    app: &App,
    at: (f32, f32),
    window: (u32, u32),
    px: f32,
    font: &fontdue::Font,
) -> Node<App> {
    let input = &app.notes[app.active].input;
    let has_selection = input.selection().is_some();
    let item = |label, shortcut, enabled, action: InputAction| {
        MenuEntry::from(MenuItem::new(
            label,
            Some(shortcut),
            enabled,
            move |app: &mut App| {
                app.pending = Some(action);
                app.context_menu = None;
            },
        ))
    };
    let t = &app.theme;
    context_menu(
        vec![
            item("Undo", "⌘Z", input.can_undo(), InputAction::Undo),
            item("Redo", "⇧⌘Z", input.can_redo(), InputAction::Redo),
            MenuEntry::Separator,
            item("Cut", "⌘X", has_selection, InputAction::Cut),
            item("Copy", "⌘C", has_selection, InputAction::Copy),
            item("Paste", "⌘V", true, InputAction::Paste),
            MenuEntry::Separator,
            item("Select All", "⌘A", true, InputAction::SelectAll),
        ],
        at,
        (window.0 as f32, window.1 as f32),
        px,
        font,
        &MenuStyle {
            background: mix(t.bg, t.fg, 0.07),
            foreground: t.fg,
            disabled: t.muted,
            hover: t.item_hover,
            shortcut: t.muted,
            border: t.hairline,
        },
    )
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

