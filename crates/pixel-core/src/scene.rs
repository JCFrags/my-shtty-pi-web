use taffy::TaffyTree;
use taffy::prelude::TaffyMaxContent as _;

use crate::canvas::{Canvas, measure_text};
use crate::style::{Align, Border, Color, Dimension, FlexDirection, Justify, Style};

pub type Handler<S> = Box<dyn Fn(&mut S)>;

pub struct Node<S> {
    pub style: Style,
    pub text: Option<String>,
    pub id: Option<&'static str>,
    pub on_click: Option<Handler<S>>,
    pub children: Vec<Node<S>>,
}

impl<S> Default for Node<S> {
    fn default() -> Self {
        Self {
            style: Style::default(),
            text: None,
            id: None,
            on_click: None,
            children: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
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

/// The computed frame: where tagged nodes landed and which handlers are live.
/// Dispatch hit-tests internally, topmost node first.
pub struct Scene<S> {
    handlers: Vec<(PxRect, Handler<S>)>,
    ids: Vec<(&'static str, PxRect)>,
    hoverables: Vec<PxRect>,
}

impl<S> Scene<S> {
    pub fn dispatch_click(&self, x: f32, y: f32, state: &mut S) -> bool {
        // Handlers are collected in paint order, so the reverse scan finds
        // the topmost handler under the point.
        for (rect, handler) in self.handlers.iter().rev() {
            if rect.contains(x, y) {
                handler(state);
                return true;
            }
        }
        false
    }

    pub fn rect(&self, id: &str) -> Option<PxRect> {
        self.ids
            .iter()
            .find(|(node_id, _)| *node_id == id)
            .map(|(_, rect)| *rect)
    }

    /// Topmost hover-styled node under the point. Compare across frames to
    /// decide whether a mouse move needs a redraw.
    pub fn hover_target(&self, x: f32, y: f32) -> Option<usize> {
        self.hoverables.iter().rposition(|rect| rect.contains(x, y))
    }
}

pub fn render_scene<S>(
    root: Node<S>,
    canvas: &mut Canvas,
    fonts: &[fontdue::Font],
    base_px: f32,
    cursor: Option<(f32, f32)>,
) -> Scene<S> {
    assert!(!fonts.is_empty());
    let mut tree: TaffyTree<MeasureCtx> = TaffyTree::new();
    let mut built = crate::profiler::span("scene.build", || {
        build_node(
            root,
            &mut tree,
            Inherited {
                color: [255, 255, 255, 255],
                px: base_px,
                font: 0,
            },
        )
    });
    crate::profiler::span("scene.layout", || {
        tree.compute_layout_with_measure(
            built.taffy_id,
            taffy::Size::MAX_CONTENT,
            |_known, _available, _node, context, _style| match context {
                Some(ctx) => {
                    let font = &fonts[ctx.font.min(fonts.len() - 1)];
                    let line = font
                        .horizontal_line_metrics(ctx.px)
                        .map_or(ctx.px, |m| m.new_line_size);
                    let lines: Vec<&str> = ctx.text.split('\n').collect();
                    let widest = lines
                        .iter()
                        .map(|l| measure_text(font, l, ctx.px))
                        .fold(0.0f32, f32::max);
                    taffy::Size {
                        width: widest,
                        height: line * lines.len() as f32,
                    }
                }
                None => taffy::Size::ZERO,
            },
        )
        .expect("layout")
    });


    let mut scene = Scene {
        handlers: Vec::new(),
        ids: Vec::new(),
        hoverables: Vec::new(),
    };
    crate::profiler::span("scene.paint", || {
        paint_node(
            &mut built,
            &tree,
            canvas,
            fonts,
            (0.0, 0.0),
            cursor,
            &mut scene,
        )
    });
    scene
}

struct MeasureCtx {
    text: String,
    px: f32,
    font: usize,
}

#[derive(Clone, Copy)]
struct Inherited {
    color: Color,
    px: f32,
    font: usize,
}

struct BuiltNode<S> {
    taffy_id: taffy::NodeId,
    background: Option<Color>,
    hover_background: Option<Color>, // i find this very weird and probably a smell
    hover_color: Option<Color>,
    corner_radius: f32,
    border: Option<Border>,
    text: Option<(String, Color, f32, usize)>,
    id: Option<&'static str>,
    on_click: Option<Handler<S>>,
    children: Vec<BuiltNode<S>>,
}

fn build_node<S>(
    node: Node<S>,
    tree: &mut TaffyTree<MeasureCtx>,
    inherited: Inherited,
) -> BuiltNode<S> {
    let inherited = Inherited {
        color: node.style.color.unwrap_or(inherited.color),
        px: node.style.font_size.unwrap_or(inherited.px),
        font: node.style.font.unwrap_or(inherited.font),
    };
    let taffy_style = to_taffy(&node.style);

    let children: Vec<BuiltNode<S>> = node
        .children
        .into_iter()
        .map(|child| build_node(child, tree, inherited))
        .collect();
    let taffy_id = match (&node.text, children.is_empty()) {
        (Some(text), true) => tree
            .new_leaf_with_context(
                taffy_style,
                MeasureCtx {
                    text: text.clone(),
                    px: inherited.px,
                    font: inherited.font,
                },
            )
            .expect("taffy leaf"),
        _ => {
            let child_ids: Vec<_> = children.iter().map(|c| c.taffy_id).collect();
            tree.new_with_children(taffy_style, &child_ids)
                .expect("taffy node")
        }
    };

    BuiltNode {
        taffy_id,
        background: node.style.background,
        hover_background: node.style.hover_background,
        hover_color: node.style.hover_color,
        corner_radius: node.style.corner_radius,
        border: node.style.border,
        text: node
            .text
            .map(|t| (t, inherited.color, inherited.px, inherited.font)),
        id: node.id,
        on_click: node.on_click,
        children,
    }
}

fn paint_node<S>(
    node: &mut BuiltNode<S>,
    tree: &TaffyTree<MeasureCtx>,
    canvas: &mut Canvas,
    fonts: &[fontdue::Font],
    offset: (f32, f32),
    cursor: Option<(f32, f32)>,
    scene: &mut Scene<S>,
) {
    let layout = tree.layout(node.taffy_id).expect("layout");
    let rect = PxRect {
        x: offset.0 + layout.location.x,
        y: offset.1 + layout.location.y,
        w: layout.size.width,
        h: layout.size.height,
    };
    let hovered = cursor.is_some_and(|(x, y)| rect.contains(x, y));

    let background = match (hovered, node.hover_background) {
        (true, Some(bg)) => Some(bg),
        _ => node.background,
    };
    if let Some(bg) = background {
        canvas.fill_rounded_rect(rect.x, rect.y, rect.w, rect.h, node.corner_radius, bg);
    }
    if let Some(border) = node.border {
        canvas.stroke_rounded_rect(
            rect.x,
            rect.y,
            rect.w,
            rect.h,
            node.corner_radius,
            border.width,
            border.color,
        );
    }
    if let Some((text, color, px, font_index)) = &node.text {
        let font = &fonts[*font_index.min(&(fonts.len() - 1))];
        if let Some(line_metrics) = font.horizontal_line_metrics(*px) {
            let color = match (hovered, node.hover_color) {
                (true, Some(c)) => c,
                _ => *color,
            };
            let origin_x = rect.x + layout.padding.left;
            let origin_y = rect.y + layout.padding.top;
            for (i, line) in text.split('\n').enumerate() {
                canvas.draw_text(
                    font,
                    line,
                    origin_x as i32,
                    (origin_y + line_metrics.ascent + line_metrics.new_line_size * i as f32) as i32,
                    *px,
                    color,
                );
            }
        }
    }

    if node.hover_background.is_some() || node.hover_color.is_some() {
        scene.hoverables.push(rect);
    }
    if let Some(handler) = node.on_click.take() {
        scene.handlers.push((rect, handler));
    }
    if let Some(id) = node.id {
        scene.ids.push((id, rect));
    }
    for child in &mut node.children {
        paint_node(child, tree, canvas, fonts, (rect.x, rect.y), cursor, scene);
    }
}

fn to_taffy(style: &Style) -> taffy::Style {
    use taffy::prelude::{auto, length, percent};

    fn dimension(d: Dimension) -> taffy::Dimension {
        match d {
            Dimension::Auto => auto(),
            Dimension::Px(v) => length(v),
            Dimension::Percent(f) => percent(f),
        }
    }

    taffy::Style {
        flex_direction: match style.flex_direction {
            FlexDirection::Row => taffy::FlexDirection::Row,
            FlexDirection::Column => taffy::FlexDirection::Column,
        },
        flex_grow: style.flex_grow,
        size: taffy::Size {
            width: dimension(style.width),
            height: dimension(style.height),
        },
        padding: taffy::Rect {
            left: length(style.padding.left),
            right: length(style.padding.right),
            top: length(style.padding.top),
            bottom: length(style.padding.bottom),
        },
        margin: taffy::Rect {
            left: length(style.margin.left),
            right: length(style.margin.right),
            top: length(style.margin.top),
            bottom: length(style.margin.bottom),
        },
        gap: taffy::Size {
            width: length(style.gap),
            height: length(style.gap),
        },
        justify_content: style.justify_content.map(|j| match j {
            Justify::Start => taffy::JustifyContent::Start,
            Justify::Center => taffy::JustifyContent::Center,
            Justify::End => taffy::JustifyContent::End,
            Justify::SpaceBetween => taffy::JustifyContent::SpaceBetween,
        }),
        align_items: style.align_items.map(|a| match a {
            Align::Start => taffy::AlignItems::Start,
            Align::Center => taffy::AlignItems::Center,
            Align::End => taffy::AlignItems::End,
            Align::Stretch => taffy::AlignItems::Stretch,
        }),
        ..taffy::Style::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::style::Edges;

    static FONT_BYTES: &[u8] =
        include_bytes!("../../../examples/typing/assets/JetBrainsMono-Regular.ttf");

    fn font() -> fontdue::Font {
        fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default()).unwrap()
    }

    fn scene_for(root: Node<usize>, canvas: &mut Canvas) -> Scene<usize> {
        render_scene(root, canvas, &[font()], 16.0, None)
    }

    #[test]
    fn dispatches_click_to_topmost_handler_and_falls_back_to_ancestors() {
        let mut canvas = Canvas::new(200, 100);
        let child = Node {
            style: Style {
                width: Dimension::Px(50.0),
                height: Dimension::Px(50.0),
                ..Style::default()
            },
            on_click: Some(Box::new(|hit: &mut usize| *hit = 2)),
            ..Node::default()
        };
        let root = Node {
            style: Style {
                width: Dimension::Px(200.0),
                height: Dimension::Px(100.0),
                padding: Edges::all(10.0),
                ..Style::default()
            },
            on_click: Some(Box::new(|hit: &mut usize| *hit = 1)),
            children: vec![child],
            ..Node::default()
        };
        let scene = scene_for(root, &mut canvas);

        let mut hit = 0;
        assert!(scene.dispatch_click(15.0, 15.0, &mut hit));
        assert_eq!(hit, 2, "click inside child hits child handler");
        assert!(scene.dispatch_click(150.0, 50.0, &mut hit));
        assert_eq!(hit, 1, "click outside child falls back to root");
        assert!(!scene.dispatch_click(500.0, 500.0, &mut hit));
    }

    #[test]
    fn exposes_rects_by_id_and_paints_background() {
        let mut canvas = Canvas::new(100, 40);
        let root = Node::<usize> {
            style: Style {
                width: Dimension::Px(100.0),
                height: Dimension::Px(40.0),
                background: Some([10, 20, 30, 255]),
                ..Style::default()
            },
            id: Some("root"),
            ..Node::default()
        };
        let scene = scene_for(root, &mut canvas);

        let rect = scene.rect("root").unwrap();
        assert_eq!((rect.w, rect.h), (100.0, 40.0));
        assert!(scene.rect("missing").is_none());
        assert_eq!(&canvas.pixels[(50 * 4)..(50 * 4) + 4], &[10, 20, 30, 255]);
    }

    #[test]
    fn hover_swaps_background_under_cursor() {
        let node = |hover_bg| Node::<usize> {
            style: Style {
                width: Dimension::Px(10.0),
                height: Dimension::Px(10.0),
                background: Some([1, 1, 1, 255]),
                hover_background: hover_bg,
                ..Style::default()
            },
            ..Node::default()
        };

        let mut canvas = Canvas::new(10, 10);
        let scene = render_scene(
            node(Some([9, 9, 9, 255])),
            &mut canvas,
            &[font()],
            16.0,
            Some((5.0, 5.0)),
        );
        assert_eq!(&canvas.pixels[0..4], &[9, 9, 9, 255]);
        assert_eq!(scene.hover_target(5.0, 5.0), Some(0));
        assert_eq!(scene.hover_target(50.0, 50.0), None);

        let mut canvas = Canvas::new(10, 10);
        render_scene(
            node(Some([9, 9, 9, 255])),
            &mut canvas,
            &[font()],
            16.0,
            Some((50.0, 50.0)),
        );
        assert_eq!(&canvas.pixels[0..4], &[1, 1, 1, 255]);
    }

    #[test]
    fn text_leaves_size_the_layout() {
        let mut canvas = Canvas::new(400, 100);
        let root = Node::<usize> {
            style: Style {
                width: Dimension::Px(400.0),
                height: Dimension::Px(100.0),
                ..Style::default()
            },
            children: vec![Node {
                id: Some("label"),
                text: Some("hello".into()),
                ..Node::default()
            }],
            ..Node::default()
        };
        let scene = scene_for(root, &mut canvas);
        let label = scene.rect("label").unwrap();
        assert!(label.w > 0.0 && label.h > 0.0);
    }
}
