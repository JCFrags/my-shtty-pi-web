// remindme: in vscode terminal disable, since it overlaps with their context menu
use crate::canvas::measure_text;
use crate::scene::{Handler, Node};
use crate::style::{
    Align, Border, Color, Dimension, Edges, FlexDirection, Inset, Justify, Position, Style,
};

// fixme: i don't like this special id
pub const CONTEXT_MENU_ID: &str = "context-menu";

pub struct MenuItem<S> {
    pub label: String,
    pub shortcut: Option<String>,
    pub enabled: bool,
    pub on_select: Handler<S>,
}

impl<S> MenuItem<S> {
    pub fn new(
        label: &str,
        shortcut: Option<&str>,
        enabled: bool,
        on_select: impl Fn(&mut S) + 'static,
    ) -> Self {
        Self {
            label: label.into(),
            shortcut: shortcut.map(str::to_string),
            enabled,
            on_select: Box::new(on_select),
        }
    }
}

pub enum MenuEntry<S> {
    Item(MenuItem<S>),
    Separator,
}

impl<S> From<MenuItem<S>> for MenuEntry<S> {
    fn from(item: MenuItem<S>) -> Self {
        MenuEntry::Item(item)
    }
}

pub struct MenuStyle {
    pub background: Color,
    pub foreground: Color,
    pub disabled: Color,
    pub hover: Color,
    pub shortcut: Color,
    pub border: Color,
}

/**
 * this seems way too complex, i suspect a zindex abstracton should help?
 */
pub fn context_menu<S>(
    entries: Vec<MenuEntry<S>>,
    at: (f32, f32),
    window: (f32, f32),
    px: f32,
    font: &fontdue::Font,
    style: &MenuStyle,
) -> Node<S> {
    let pad = px * 0.55;
    let item_pad = Edges::symmetric(px * 0.7, px * 0.35);
    let gap_between = px * 2.0;
    let separator_margin = px * 0.3;
    let line_h = crate::text_input::line_height(font, px);

    let width = entries
        .iter()
        .filter_map(|entry| match entry {
            MenuEntry::Item(item) => Some(
                measure_text(font, &item.label, px)
                    + item
                        .shortcut
                        .as_deref()
                        .map_or(0.0, |s| gap_between + measure_text(font, s, px)),
            ),
            MenuEntry::Separator => None,
        })
        .fold(0.0f32, f32::max)
        + item_pad.left
        + item_pad.right
        + pad * 2.0;
    let height = entries
        .iter()
        .map(|entry| match entry {
            MenuEntry::Item(_) => line_h + item_pad.top + item_pad.bottom,
            MenuEntry::Separator => 1.0 + 2.0 * separator_margin,
        })
        .sum::<f32>()
        + pad * 2.0;
    let x = at.0.min(window.0 - width).max(0.0);
    let y = at.1.min(window.1 - height).max(0.0);

    let children = entries
        .into_iter()
        .map(|entry| {
            let item = match entry {
                MenuEntry::Item(item) => item,
                MenuEntry::Separator => {
                    return Node {
                        style: Style {
                            height: Dimension::Px(1.0),
                            margin: Edges::symmetric(0.0, separator_margin),
                            background: Some(style.border),
                            ..Style::default()
                        },
                        ..Node::default()
                    };
                }
            };
            let color = if item.enabled {
                style.foreground
            } else {
                style.disabled
            };
            let mut row = Node {
                style: Style {
                    justify_content: Some(Justify::SpaceBetween),
                    align_items: Some(Align::Center),
                    gap: gap_between,
                    padding: item_pad,
                    corner_radius: px * 0.3,
                    color: Some(color),
                    hover_background: item.enabled.then_some(style.hover),
                    ..Style::default()
                },
                on_click: item.enabled.then_some(item.on_select),
                ..Node::default()
            };
            row.children.push(Node {
                text: Some(item.label),
                ..Node::default()
            });
            if let Some(shortcut) = item.shortcut {
                row.children.push(Node {
                    style: Style {
                        color: Some(if item.enabled {
                            style.shortcut
                        } else {
                            style.disabled
                        }),
                        font_size: Some(px * 0.85),
                        ..Style::default()
                    },
                    text: Some(shortcut),
                    ..Node::default()
                });
            }
            row
        })
        .collect();

    Node {
        style: Style {
            position: Position::Absolute,
            inset: Inset::top_left(x, y),
            flex_direction: FlexDirection::Column,
            padding: Edges::all(pad),
            background: Some(style.background),
            corner_radius: px * 0.5,
            border: Some(Border::hairline(style.border)),
            ..Style::default()
        },
        id: Some(CONTEXT_MENU_ID),
        // hm
        on_click: Some(Box::new(|_| {})),
        children,
        ..Node::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas::Canvas;
    use crate::scene::render_scene;

    static FONT_BYTES: &[u8] =
        include_bytes!("../../../examples/typing/assets/JetBrainsMono-Regular.ttf");

    fn font() -> fontdue::Font {
        fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default()).unwrap()
    }

    fn style() -> MenuStyle {
        MenuStyle {
            background: [30, 30, 40, 255],
            foreground: [220, 220, 230, 255],
            disabled: [120, 120, 130, 255],
            hover: [60, 60, 80, 255],
            shortcut: [140, 140, 150, 255],
            border: [80, 80, 90, 255],
        }
    }

    fn menu_scene(
        items: Vec<MenuEntry<Option<&'static str>>>,
        at: (f32, f32),
    ) -> (Canvas, crate::scene::Scene<Option<&'static str>>) {
        let mut canvas = Canvas::new(400, 300);
        let f = font();
        let root = Node {
            style: Style {
                width: Dimension::Px(400.0),
                height: Dimension::Px(300.0),
                ..Style::default()
            },
            children: vec![context_menu(items, at, (400.0, 300.0), 16.0, &f, &style())],
            ..Node::default()
        };
        let scene = render_scene(root, &mut canvas, &[f], 16.0, None);
        (canvas, scene)
    }

    fn items() -> Vec<MenuEntry<Option<&'static str>>> {
        vec![
            MenuItem::new("Copy", Some("⌘C"), true, |hit| *hit = Some("copy")).into(),
            MenuItem::new("Paste", Some("⌘V"), false, |hit| *hit = Some("paste")).into(),
        ]
    }

    #[test]
    fn menu_dispatches_enabled_items_and_swallows_the_rest() {
        let (_, scene) = menu_scene(items(), (100.0, 50.0));
        let rect = scene.rect(CONTEXT_MENU_ID).unwrap();
        assert_eq!((rect.x, rect.y), (100.0, 50.0));

        let mut hit = None;
        let row_h = (rect.h - 2.0 * 16.0 * 0.55) / 2.0;
        let first_row = (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0 - row_h / 2.0);
        assert!(scene.dispatch_click(first_row.0, first_row.1, &mut hit));
        assert_eq!(hit, Some("copy"));

        hit = None;
        let second_row = (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0 + row_h / 2.0);
        assert!(
            scene.dispatch_click(second_row.0, second_row.1, &mut hit),
            "disabled row still swallows the click via the container"
        );
        assert_eq!(hit, None, "disabled item never fires");
    }

    #[test]
    fn menu_shifts_inside_the_window() {
        let (_, scene) = menu_scene(items(), (395.0, 295.0));
        let rect = scene.rect(CONTEXT_MENU_ID).unwrap();
        assert!(rect.x + rect.w <= 400.0, "clamped horizontally: {rect:?}");
        assert!(rect.y + rect.h <= 300.0, "clamped vertically: {rect:?}");
    }
}
