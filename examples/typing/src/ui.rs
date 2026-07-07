use pixel_core::taffy::prelude::*;
use pixel_core::taffy::{Size as TSize, TaffyTree};
use pixel_core::{Canvas, fontdue, measure_text};

pub const PAD: f32 = 12.0;
const SIDEBAR_W: f32 = 200.0;
const BG: [u8; 4] = [24, 24, 32, 255];
const FG: [u8; 4] = [230, 230, 240, 255];
const CARET: [u8; 4] = [120, 220, 160, 255];
const SIDEBAR_BG: [u8; 4] = [30, 30, 42, 255];
const TAB_ACTIVE_BG: [u8; 4] = [52, 52, 70, 255];
const TAB_FG: [u8; 4] = [170, 170, 188, 255];
const STATUS_BG: [u8; 4] = [40, 40, 54, 255];
const STATUS_FG: [u8; 4] = [150, 150, 168, 255];
const RECORDING_DOT: [u8; 4] = [235, 80, 80, 255];

pub struct PxRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl PxRect {
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

pub struct Ui {
    pub tabs: Vec<PxRect>,
    pub sidebar: PxRect,
    pub editor: PxRect,
    pub status_bar: PxRect,
    pub status_left: PxRect,
    pub status_right: PxRect,
}

pub fn px_for_cell_height(font: &fontdue::Font, cell_height: f32) -> f32 {
    let probe = font
        .horizontal_line_metrics(100.0)
        .expect("font has horizontal metrics");
    (cell_height * 100.0 / probe.new_line_size).clamp(6.0, 512.0)
}

fn layout_ui(
    font: &fontdue::Font,
    px: f32,
    line_height: f32,
    window: (f32, f32),
    tab_count: usize,
    left_label: &str,
    right_label: &str,
) -> Ui {
    let mut tree: TaffyTree<String> = TaffyTree::new();
    let leaf = |tree: &mut TaffyTree<String>, label: &str| {
        tree.new_leaf_with_context(Style::default(), label.to_string())
            .expect("leaf")
    };

    let tab_ids: Vec<_> = (0..tab_count)
        .map(|_| {
            tree.new_leaf(Style {
                size: TSize {
                    width: percent(1.0),
                    height: length(line_height + PAD),
                },
                ..Default::default()
            })
            .expect("tab")
        })
        .collect();
    let sidebar = tree
        .new_with_children(
            Style {
                flex_direction: FlexDirection::Column,
                size: TSize {
                    width: length(SIDEBAR_W),
                    height: percent(1.0),
                },
                padding: Rect {
                    left: zero(),
                    right: zero(),
                    top: length(PAD / 2.0),
                    bottom: zero(),
                },
                ..Default::default()
            },
            &tab_ids,
        )
        .expect("sidebar");
    let editor = tree
        .new_leaf(Style {
            flex_grow: 1.0,
            ..Default::default()
        })
        .expect("editor");
    let main = tree
        .new_with_children(
            Style {
                flex_direction: FlexDirection::Row,
                flex_grow: 1.0,
                size: TSize {
                    width: percent(1.0),
                    height: auto(),
                },
                ..Default::default()
            },
            &[sidebar, editor],
        )
        .expect("main");

    let status_left = leaf(&mut tree, left_label);
    let status_right = leaf(&mut tree, right_label);
    let status_bar = tree
        .new_with_children(
            Style {
                flex_direction: FlexDirection::Row,
                justify_content: Some(JustifyContent::SpaceBetween),
                align_items: Some(AlignItems::Center),
                size: TSize {
                    width: percent(1.0),
                    height: length(line_height + PAD),
                },
                padding: Rect {
                    left: length(PAD),
                    right: length(PAD),
                    top: zero(),
                    bottom: zero(),
                },
                ..Default::default()
            },
            &[status_left, status_right],
        )
        .expect("status bar");
    let root = tree
        .new_with_children(
            Style {
                flex_direction: FlexDirection::Column,
                size: TSize {
                    width: length(window.0),
                    height: length(window.1),
                },
                ..Default::default()
            },
            &[main, status_bar],
        )
        .expect("root");

    tree.compute_layout_with_measure(
        root,
        TSize::MAX_CONTENT,
        |_known, _available, _node, context, _style| match context {
            Some(text) => TSize {
                width: measure_text(font, text, px),
                height: line_height,
            },
            None => TSize::ZERO,
        },
    )
    .expect("layout");

    let rect = |tree: &TaffyTree<String>, id, dx: f32, dy: f32| {
        let layout = tree.layout(id).expect("layout");
        PxRect {
            x: layout.location.x + dx,
            y: layout.location.y + dy,
            w: layout.size.width,
            h: layout.size.height,
        }
    };
    let main_rect = rect(&tree, main, 0.0, 0.0);
    let sidebar_rect = rect(&tree, sidebar, main_rect.x, main_rect.y);
    let bar_rect = rect(&tree, status_bar, 0.0, 0.0);
    Ui {
        tabs: tab_ids
            .iter()
            .map(|&id| rect(&tree, id, sidebar_rect.x, sidebar_rect.y))
            .collect(),
        editor: rect(&tree, editor, main_rect.x, main_rect.y),
        status_left: rect(&tree, status_left, bar_rect.x, bar_rect.y),
        status_right: rect(&tree, status_right, bar_rect.x, bar_rect.y),
        sidebar: sidebar_rect,
        status_bar: bar_rect,
    }
}

pub struct Frame<'a> {
    pub font: &'a fontdue::Font,
    pub px: f32,
    pub window: (u32, u32),
    pub tab_titles: Vec<&'a str>,
    pub active: usize,
    pub text: &'a str,
    pub recording: bool,
}

pub fn render(frame: &Frame<'_>) -> (Canvas, Ui) {
    let line_metrics = frame
        .font
        .horizontal_line_metrics(frame.px)
        .expect("font has horizontal metrics");
    let line_height = line_metrics.new_line_size;
    let ascent = line_metrics.ascent;
    let baseline_center = |rect_h: f32| (rect_h - (ascent - line_metrics.descent)) / 2.0 + ascent;

    let char_count = format!("{} chars", frame.text.chars().count());
    let ui = layout_ui(
        frame.font,
        frame.px,
        line_height,
        (frame.window.0 as f32, frame.window.1 as f32),
        frame.tab_titles.len(),
        "click tabs | ctrl-p: profile | ctrl-c: quit",
        &char_count,
    );

    let mut canvas = Canvas::new(frame.window.0, frame.window.1);
    canvas.fill(BG);
    fill_px_rect(&mut canvas, &ui.sidebar, SIDEBAR_BG);
    fill_px_rect(&mut canvas, &ui.status_bar, STATUS_BG);

    for (i, (title, rect)) in frame.tab_titles.iter().zip(&ui.tabs).enumerate() {
        let color = if i == frame.active {
            fill_px_rect(&mut canvas, rect, TAB_ACTIVE_BG);
            FG
        } else {
            TAB_FG
        };
        canvas.draw_text(
            frame.font,
            title,
            (rect.x + PAD) as i32,
            (rect.y + baseline_center(rect.h)) as i32,
            frame.px,
            color,
        );
    }

    let lines: Vec<&str> = frame.text.split('\n').collect();
    let editor_bottom = ui.editor.y + ui.editor.h - PAD;
    let mut caret_line: Option<(usize, f32)> = None;
    for (i, line) in lines.iter().enumerate() {
        let top = ui.editor.y + PAD + line_height * i as f32;
        if top + line_height > editor_bottom {
            break;
        }
        canvas.draw_text(
            frame.font,
            line,
            (ui.editor.x + PAD) as i32,
            (top + ascent) as i32,
            frame.px,
            FG,
        );
        caret_line = Some((i, top));
    }
    if let Some((i, top)) = caret_line
        && i == lines.len() - 1
    {
        let caret_x = ui.editor.x + PAD + measure_text(frame.font, lines[i], frame.px);
        let caret_w = (frame.px / 8.0).max(2.0) as u32;
        canvas.fill_rect(
            caret_x as u32,
            top as u32,
            caret_w,
            line_height as u32,
            CARET,
        );
    }

    canvas.draw_text(
        frame.font,
        "click tabs | ctrl-p: profile | ctrl-c: quit",
        ui.status_left.x as i32,
        (ui.status_left.y + baseline_center(ui.status_left.h)) as i32,
        frame.px,
        STATUS_FG,
    );
    canvas.draw_text(
        frame.font,
        &char_count,
        ui.status_right.x as i32,
        (ui.status_right.y + baseline_center(ui.status_right.h)) as i32,
        frame.px,
        STATUS_FG,
    );
    if frame.recording {
        let dot = (frame.px / 3.0).max(6.0);
        canvas.fill_rect(
            (ui.status_right.x - dot * 2.0) as u32,
            (ui.status_bar.y + (ui.status_bar.h - dot) / 2.0) as u32,
            dot as u32,
            dot as u32,
            RECORDING_DOT,
        );
    }
    (canvas, ui)
}

fn fill_px_rect(canvas: &mut Canvas, rect: &PxRect, color: [u8; 4]) {
    canvas.fill_rect(
        rect.x as u32,
        rect.y as u32,
        rect.w as u32,
        rect.h as u32,
        color,
    );
}
