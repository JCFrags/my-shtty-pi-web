use pixel_core::{
    Align, Border, Color, Desc, Dimension, Edges, FlexDirection, FrameStats, Glide, InputAction,
    InputProps, Justify, MenuEntry, MenuItem, MenuStyle, Overflow, ScrollProfile, SelectionMode,
    Smooth, Style, TerminalColors, Tui, context_menu, fontdue,
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

pub const PROFILES: [&'static dyn ScrollProfile; 3] = [&SCROLL_SMOOTH, &SCROLL_GLIDE, &SCROLL_TUI];

impl App {
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
        let name = debug
            .split_whitespace()
            .next()
            .unwrap_or("?")
            .to_lowercase();
        format!("scroll: {name}")
    }
}

pub fn editor_pad(rem: f32) -> f32 {
    rem * 1.1
}

pub const FONT_UI: usize = 0;
pub const FONT_MONO: usize = 1;

pub const EDITOR: &str = "editor";
pub const BACKDROP: &str = "backdrop";
pub const ADD_NOTE: &str = "add-note";

pub fn note_key(index: usize) -> String {
    format!("note:{index}")
}

pub fn input_key(index: usize) -> String {
    format!("editor-input:{index}")
}

pub const MENU_ACTIONS: [(&str, InputAction); 6] = [
    ("menu:undo", InputAction::Undo),
    ("menu:redo", InputAction::Redo),
    ("menu:cut", InputAction::Cut),
    ("menu:copy", InputAction::Copy),
    ("menu:paste", InputAction::Paste),
    ("menu:select-all", InputAction::SelectAll),
];

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
    pub scroll_profile: usize,
    pub native: bool,
    pub context_menu: Option<(f32, f32)>,
}

pub struct Note {
    pub title: String,
    pub text: String,
}

pub struct EngineSample {
    pub recording: bool,
    pub stats: FrameStats,
    pub editor_scroll: f32,
    pub can_undo: bool,
    pub can_redo: bool,
    pub has_selection: bool,
}

pub fn build_ui(
    app: &App,
    window: (u32, u32),
    base_px: f32,
    sample: &EngineSample,
    font: &fontdue::Font,
) -> Desc {
    let small = base_px * 0.85;
    let rem = base_px;
    let hair = (rem / 16.0).max(1.0);
    let t = &app.theme;

    let mut sidebar_children = vec![Desc {
        style: Style {
            padding: Edges::symmetric(rem * 0.6, rem * 0.35),
            color: Some(t.muted),
            font_size: Some(small),
            ..Style::default()
        },
        text: Some("header".into()),
        ..Desc::default()
    }];
    for (i, note) in app.notes.iter().enumerate() {
        let active = i == app.active;
        sidebar_children.push(Desc {
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
            key: Some(note_key(i)),
            clickable: true,
            ..Desc::default()
        });
    }
    sidebar_children.push(Desc {
        style: Style {
            flex_grow: 1.0,
            ..Style::default()
        },
        ..Desc::default()
    });
    sidebar_children.push(Desc {
        style: Style {
            padding: Edges::symmetric(rem * 0.6, rem * 0.35),
            corner_radius: rem * 0.4,
            border: Some(Border::all(hair, t.hairline)),
            color: Some(t.accent),
            hover_background: Some(t.item_hover),
            ..Style::default()
        },
        text: Some("+ ".into()),
        key: Some(ADD_NOTE.into()),
        clickable: true,
        ..Desc::default()
    });

    let sidebar = Desc {
        style: Style {
            flex_direction: FlexDirection::Column,
            width: Dimension::Px(rem * 14.0),
            flex_shrink: 0.0,
            margin: Edges::all(rem * 0.4),
            padding: Edges::all(rem * 0.6),
            gap: rem * 0.125,
            background: Some(t.sidebar_bg),
            corner_radius: rem * 0.6,
            selection_mode: SelectionMode::Unified,
            ..Style::default()
        },
        children: sidebar_children,
        ..Desc::default()
    };

    let title_bar = Desc {
        style: Style {
            justify_content: Some(Justify::SpaceBetween),
            align_items: Some(Align::Center),
            padding: Edges::symmetric(editor_pad(rem), rem * 0.7),
            ..Style::default()
        },
        children: vec![
            Desc {
                style: Style {
                    font_size: Some(base_px * 1.35),
                    ..Style::default()
                },
                text: Some(app.notes[app.active].title.clone()),
                ..Desc::default()
            },
            chip("markdown", small, t.muted, t.chip_bg),
        ],
        ..Desc::default()
    };

    let mut status_right = vec![];
    if sample.recording {
        status_right.push(chip("REC", small, t.fg, t.recording));
    }
    status_right.push(chip(&app.profile_label(), small, t.accent, t.chip_bg));
    status_right.push(chip(
        &format!("{} lines", app.notes[app.active].text.lines().count()),
        small,
        t.muted,
        t.chip_bg,
    ));
    status_right.push(chip(
        &format!("{:.0}px", sample.editor_scroll),
        small,
        t.muted,
        t.chip_bg,
    ));
    if sample.stats.frame_ms > 0.0 {
        status_right.push(chip(
            &format!("{:.1}ms", sample.stats.frame_ms),
            small,
            t.muted,
            t.chip_bg,
        ));
        status_right.push(chip(
            &format!("{:.0}fps", sample.stats.fps),
            small,
            t.accent,
            t.chip_bg,
        ));
    }
    let status_bar = Desc {
        style: Style {
            justify_content: Some(Justify::SpaceBetween),
            align_items: Some(Align::Center),
            padding: Edges::symmetric(rem * 0.75, rem * 0.5),
            ..Style::default()
        },
        children: vec![
            Desc {
                style: Style {
                    color: Some(t.muted),
                    font_size: Some(small),
                    ..Style::default()
                },
                text: Some("ctrl-s scroll feel / ctrl-p profile / ctrl-q quit".into()),
                ..Desc::default()
            },
            Desc {
                style: Style {
                    gap: rem * 0.5,
                    align_items: Some(Align::Center),
                    ..Style::default()
                },
                children: status_right,
                ..Desc::default()
            },
        ],
        ..Desc::default()
    };

    let editor_input = Desc {
        style: Style {
            padding: Edges::all(editor_pad(rem)),
            flex_shrink: 0.0,
            ..Style::default()
        },
        key: Some(input_key(app.active)),
        input: Some(InputProps {
            initial: app.notes[app.active].text.clone(),
            caret_color: t.accent,
            selection_color: t.selection,
            auto_focus: true,
            ..InputProps::default()
        }),
        ..Desc::default()
    };

    let main = Desc {
        style: Style {
            flex_direction: FlexDirection::Column,
            flex_grow: 1.0,
            // flex: 1 — sized by the container, not by content, so typing
            // long lines can't grow the column and squeeze the sidebar.
            flex_basis: Dimension::Px(0.0),
            overflow: Overflow::Hidden,
            ..Style::default()
        },
        children: vec![
            title_bar,
            Desc {
                style: Style {
                    height: Dimension::Px(hair),
                    width: Dimension::Percent(1.0),
                    background: Some(t.hairline),
                    ..Style::default()
                },
                ..Desc::default()
            },
            Desc {
                style: Style {
                    flex_direction: FlexDirection::Column,
                    flex_grow: 1.0,
                    flex_basis: Dimension::Px(0.0),
                    overflow: Overflow::Scroll,
                    ..Style::default()
                },
                key: Some(EDITOR.into()),
                children: vec![editor_input],
                ..Desc::default()
            },
            status_bar,
        ],
        ..Desc::default()
    };

    let mut children = vec![sidebar, main];
    if let Some(at) = app.context_menu {
        children.push(editor_menu(app, sample, at, window, rem, font));
    }

    Desc {
        style: Style {
            width: Dimension::Px(window.0 as f32),
            height: Dimension::Px(window.1 as f32),
            color: Some(t.fg),
            font_size: Some(base_px),
            font: Some(FONT_UI),
            ..Style::default()
        },
        // Clickable so clicks on dead space still dispatch (to close menus).
        key: Some(BACKDROP.into()),
        clickable: true,
        children,
        ..Desc::default()
    }
}

fn editor_menu(
    app: &App,
    sample: &EngineSample,
    at: (f32, f32),
    window: (u32, u32),
    px: f32,
    font: &fontdue::Font,
) -> Desc {
    let t = &app.theme;
    let item = |label, shortcut, enabled, key: &str| {
        MenuEntry::from(MenuItem::new(label, Some(shortcut), enabled, key))
    };
    context_menu(
        vec![
            item("Undo", "⌘Z", sample.can_undo, "menu:undo"),
            item("Redo", "⇧⌘Z", sample.can_redo, "menu:redo"),
            MenuEntry::Separator,
            item("Cut", "⌘X", sample.has_selection, "menu:cut"),
            item("Copy", "⌘C", sample.has_selection, "menu:copy"),
            item("Paste", "⌘V", true, "menu:paste"),
            MenuEntry::Separator,
            item("Select All", "⌘A", true, "menu:select-all"),
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

fn chip(label: &str, px: f32, color: Color, background: Color) -> Desc {
    Desc {
        style: Style {
            padding: Edges::symmetric(px * 0.7, px * 0.2),
            corner_radius: 999.0,
            background: Some(background),
            color: Some(color),
            font_size: Some(px),
            font: Some(FONT_MONO),
            flex_shrink: 0.0,
            wrap: false,
            ..Style::default()
        },
        text: Some(label.into()),
        ..Desc::default()
    }
}
