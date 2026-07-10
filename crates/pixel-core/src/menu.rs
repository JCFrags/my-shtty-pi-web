// remindme: in vscode terminal disable, since it overlaps with their context menu
use crate::canvas::measure_text;
use crate::desc::Desc;
use crate::style::{
    Align, Border, Color, Dimension, Edges, FlexDirection, Inset, Justify, Position, Style,
};

pub const CONTEXT_MENU_KEY: &str = "context-menu";

pub struct MenuItem {
    pub label: String,
    pub shortcut: Option<String>,
    pub enabled: bool,
    pub key: String,
}

impl MenuItem {
    pub fn new(label: &str, shortcut: Option<&str>, enabled: bool, key: &str) -> Self {
        Self {
            label: label.into(),
            shortcut: shortcut.map(str::to_string),
            enabled,
            key: key.into(),
        }
    }
}

pub enum MenuEntry {
    Item(MenuItem),
    Separator,
}

impl From<MenuItem> for MenuEntry {
    fn from(item: MenuItem) -> Self {
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

pub fn context_menu(
    entries: Vec<MenuEntry>,
    at: (f32, f32),
    window: (f32, f32),
    px: f32,
    font: &fontdue::Font,
    style: &MenuStyle,
) -> Desc {
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
                    return Desc {
                        style: Style {
                            height: Dimension::Px(1.0),
                            margin: Edges::symmetric(0.0, separator_margin),
                            background: Some(style.border),
                            ..Style::default()
                        },
                        ..Desc::default()
                    };
                }
            };
            let color = if item.enabled {
                style.foreground
            } else {
                style.disabled
            };
            let mut row = Desc {
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
                key: Some(item.key),
                clickable: item.enabled,
                ..Desc::default()
            };
            row.children.push(Desc {
                text: Some(item.label),
                ..Desc::default()
            });
            if let Some(shortcut) = item.shortcut {
                row.children.push(Desc {
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
                    ..Desc::default()
                });
            }
            row
        })
        .collect();

    Desc {
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
        key: Some(CONTEXT_MENU_KEY.into()),
        clickable: true,
        children,
        ..Desc::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::Tree;

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

    fn items() -> Vec<MenuEntry> {
        vec![
            MenuItem::new("Copy", Some("⌘C"), true, "menu:copy").into(),
            MenuItem::new("Paste", Some("⌘V"), false, "menu:paste").into(),
        ]
    }

    fn menu_tree(at: (f32, f32)) -> Tree {
        let mut tree = Tree::new((400.0, 300.0));
        let f = font();
        tree.reconcile(Desc {
            children: vec![context_menu(items(), at, (400.0, 300.0), 16.0, &f, &style())],
            ..Desc::default()
        });
        tree.flush_layout(&[f], 16.0);
        tree
    }

    #[test]
    fn menu_dispatches_enabled_items_and_swallows_the_rest() {
        let tree = menu_tree((100.0, 50.0));
        let menu = tree.find(CONTEXT_MENU_KEY).unwrap();
        let rect = tree.rect(menu).unwrap();
        assert_eq!((rect.x, rect.y), (100.0, 50.0));

        let row_h = (rect.h - 2.0 * 16.0 * 0.55) / 2.0;
        let first_row = (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0 - row_h / 2.0);
        let hit = tree.hit_click(first_row.0, first_row.1).unwrap();
        assert_eq!(tree.key_of(hit), Some("menu:copy"));

        let second_row = (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0 + row_h / 2.0);
        let hit = tree.hit_click(second_row.0, second_row.1).unwrap();
        assert_eq!(
            tree.key_of(hit),
            Some(CONTEXT_MENU_KEY),
            "disabled row still swallows the click via the container"
        );
    }

    #[test]
    fn menu_shifts_inside_the_window() {
        let tree = menu_tree((395.0, 295.0));
        let rect = tree.rect(tree.find(CONTEXT_MENU_KEY).unwrap()).unwrap();
        assert!(rect.x + rect.w <= 400.0, "clamped horizontally: {rect:?}");
        assert!(rect.y + rect.h <= 300.0, "clamped vertically: {rect:?}");
    }
}
