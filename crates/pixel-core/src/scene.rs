use taffy::TaffyTree;
use taffy::prelude::TaffyMaxContent as _;

use std::ops::Range;

use crate::canvas::{Canvas, measure_text};
use crate::style::{
    Align, Border, Color, Dimension, FlexDirection, Justify, Overflow, Position, Style,
};
use crate::text_input::{InputGeometry, InputRender, caret_width, offset_to_point};

pub type Handler<S> = Box<dyn Fn(&mut S)>;

pub struct Node<S> {
    pub style: Style,
    pub text: Option<String>,
    pub input: Option<InputRender>,
    pub id: Option<&'static str>,
    pub on_click: Option<Handler<S>>,
    pub scroll_offset: f32,
    pub children: Vec<Node<S>>,
}

impl<S> Default for Node<S> {
    fn default() -> Self {
        Self {
            style: Style::default(),
            text: None,
            input: None,
            id: None,
            on_click: None,
            scroll_offset: 0.0,
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

    pub fn intersect(&self, other: PxRect) -> PxRect {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        PxRect {
            x,
            y,
            w: ((self.x + self.w).min(other.x + other.w) - x).max(0.0),
            h: ((self.y + self.h).min(other.y + other.h) - y).max(0.0),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ScrollArea {
    pub id: Option<&'static str>,
    pub rect: PxRect,
    pub content_height: f32,
    pub offset: f32,
}

impl ScrollArea {
    pub fn max_scroll(&self) -> f32 {
        (self.content_height - self.rect.h).max(0.0)
    }

    pub fn target_to_reveal(&self, rect: PxRect, current: f32, margin: f32) -> Option<f32> {
        let top = rect.y - self.rect.y + self.offset - margin;
        let bottom = top + rect.h + 2.0 * margin;
        if top < current {
            Some(top.max(0.0))
        } else if bottom > current + self.rect.h {
            Some(bottom - self.rect.h)
        } else {
            None
        }
    }
}

pub struct Scene<S> {
    handlers: Vec<(PxRect, Handler<S>)>,
    ids: Vec<(&'static str, PxRect)>,
    hoverables: Vec<PxRect>,
    scrollables: Vec<ScrollArea>,
    inputs: Vec<(&'static str, InputGeometry)>,
}

impl<S> Scene<S> {
    pub fn dispatch_click(&self, x: f32, y: f32, state: &mut S) -> bool {
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

    pub fn hover_target(&self, x: f32, y: f32) -> Option<usize> {
        self.hoverables.iter().rposition(|rect| rect.contains(x, y))
    }

    pub fn scroll_area_at(&self, x: f32, y: f32) -> Option<&ScrollArea> {
        self.scrollables
            .iter()
            .rev()
            .find(|area| area.rect.contains(x, y))
    }

    pub fn scroll_area(&self, id: &str) -> Option<&ScrollArea> {
        self.scrollables
            .iter()
            .find(|area| area.id == Some(id))
    }

    pub fn input_geometry(&self, id: &str) -> Option<InputGeometry> {
        self.inputs
            .iter()
            .find(|(node_id, _)| *node_id == id)
            .map(|(_, geometry)| *geometry)
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
        scrollables: Vec::new(),
        inputs: Vec::new(),
    };
    crate::profiler::span("scene.paint", || {
        paint_node(
            &mut built,
            &tree,
            canvas,
            fonts,
            (0.0, 0.0),
            None,
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
    overflow: Overflow,
    scroll_offset: f32,
    text: Option<(String, Color, f32, usize)>,
    input: Option<InputRender>,
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
        overflow: node.style.overflow,
        scroll_offset: node.scroll_offset,
        text: node
            .text
            .map(|t| (t, inherited.color, inherited.px, inherited.font)),
        input: node.input,
        id: node.id,
        on_click: node.on_click,
        children,
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_node<S>(
    node: &mut BuiltNode<S>,
    tree: &TaffyTree<MeasureCtx>,
    canvas: &mut Canvas,
    fonts: &[fontdue::Font],
    offset: (f32, f32),
    clip: Option<PxRect>,
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
    let visible = clip.map_or(rect, |c| rect.intersect(c));
    let hovered = cursor.is_some_and(|(x, y)| visible.contains(x, y));

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

    let clips_children = node.overflow != Overflow::Visible;
    if clips_children {
        canvas.push_clip(rect.x, rect.y, rect.w, rect.h);
    }

    if let Some((text, color, px, font_index)) = &node.text {
        let font = &fonts[*font_index.min(&(fonts.len() - 1))];
        if let Some(line_metrics) = font.horizontal_line_metrics(*px) {
            let color = match (hovered, node.hover_color) {
                (true, Some(c)) => c,
                _ => *color,
            };
            let origin = (rect.x + layout.padding.left, rect.y + layout.padding.top);
            let line_h = line_metrics.new_line_size;
            if let Some(input) = &node.input {
                if let Some(id) = node.id {
                    scene.inputs.push((
                        id,
                        InputGeometry {
                            origin,
                            font: *font_index,
                            px: *px,
                        },
                    ));
                }
                if let Some(selection) = &input.selection {
                    paint_selection(
                        canvas,
                        text,
                        selection,
                        origin,
                        font,
                        *px,
                        line_h,
                        visible,
                        input.selection_color,
                    );
                }
            }
            for (i, line) in text.split('\n').enumerate() {
                let top = origin.1 + line_h * i as f32;
                if top + 2.0 * line_h < visible.y {
                    continue;
                }
                if top - line_h > visible.y + visible.h {
                    break;
                }
                canvas.draw_text(
                    font,
                    line,
                    origin.0 as i32,
                    (top + line_metrics.ascent) as i32,
                    *px,
                    color,
                );
            }
            if let Some(input) = &node.input
                && input.selection.is_none()
            {
                let (x, y) = offset_to_point(text, input.cursor, font, *px);
                canvas.fill_rounded_rect(
                    origin.0 + x,
                    origin.1 + y,
                    caret_width(*px),
                    line_h,
                    1.5,
                    input.caret_color,
                );
            }
        }
    }

    if node.hover_background.is_some() || node.hover_color.is_some() {
        scene.hoverables.push(visible);
    }
    if let Some(handler) = node.on_click.take() {
        scene.handlers.push((visible, handler));
    }
    if let Some(id) = node.id {
        scene.ids.push((id, rect));
    }
    if node.overflow == Overflow::Scroll {
        scene.scrollables.push(ScrollArea {
            id: node.id,
            rect: visible,
            content_height: layout.content_size.height,
            offset: node.scroll_offset,
        });
    }

    let child_origin = if node.overflow == Overflow::Scroll {
        (rect.x, rect.y - node.scroll_offset)
    } else {
        (rect.x, rect.y)
    };
    let child_clip = if clips_children { Some(visible) } else { clip };
    for child in &mut node.children {
        paint_node(
            child, tree, canvas, fonts, child_origin, child_clip, cursor, scene,
        );
    }
    if clips_children {
        canvas.pop_clip();
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_selection(
    canvas: &mut Canvas,
    text: &str,
    selection: &Range<usize>,
    origin: (f32, f32),
    font: &fontdue::Font,
    px: f32,
    line_h: f32,
    visible: PxRect,
    color: Color,
) {
    let newline_w = measure_text(font, " ", px);
    let mut line_start = 0usize;
    for (i, line) in text.split('\n').enumerate() {
        let line_end = line_start + line.len();
        if line_start > selection.end {
            break;
        }
        let top = origin.1 + line_h * i as f32;
        if top > visible.y + visible.h {
            break;
        }
        let overlaps = selection.start <= line_end && selection.end > line_start;
        if overlaps && top + line_h >= visible.y {
            let from = selection.start.max(line_start);
            let to = selection.end.min(line_end);
            let x1 = measure_text(font, &text[line_start..from], px);
            let mut x2 = measure_text(font, &text[line_start..to], px);
            if selection.end > line_end {
                x2 += newline_w;
            }
            canvas.fill_rounded_rect(origin.0 + x1, top, (x2 - x1).max(1.0), line_h, 0.0, color);
        }
        line_start = line_end + 1;
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

    fn inset_edge(v: Option<f32>) -> taffy::LengthPercentageAuto {
        v.map_or(auto(), length)
    }

    let overflow = match style.overflow {
        crate::style::Overflow::Visible => taffy::Overflow::Visible,
        crate::style::Overflow::Hidden => taffy::Overflow::Hidden,
        crate::style::Overflow::Scroll => taffy::Overflow::Scroll,
    };

    taffy::Style {
        position: match style.position {
            Position::Flow => taffy::Position::Relative,
            Position::Absolute => taffy::Position::Absolute,
        },
        inset: taffy::Rect {
            left: inset_edge(style.inset.left),
            right: inset_edge(style.inset.right),
            top: inset_edge(style.inset.top),
            bottom: inset_edge(style.inset.bottom),
        },
        overflow: taffy::Point {
            x: overflow,
            y: overflow,
        },
        flex_direction: match style.flex_direction {
            FlexDirection::Row => taffy::FlexDirection::Row,
            FlexDirection::Column => taffy::FlexDirection::Column,
        },
        flex_grow: style.flex_grow,
        flex_shrink: style.flex_shrink,
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

    fn scroll_container(offset: f32, on_click: bool) -> Node<usize> {
        let block = |color: Color, clicks: bool| Node {
            style: Style {
                width: Dimension::Px(40.0),
                height: Dimension::Px(40.0),
                flex_shrink: 0.0,
                background: Some(color),
                ..Style::default()
            },
            on_click: clicks.then(|| Box::new(|hit: &mut usize| *hit = 7) as Handler<usize>),
            ..Node::default()
        };
        Node {
            style: Style {
                flex_direction: FlexDirection::Column,
                width: Dimension::Px(40.0),
                height: Dimension::Px(40.0),
                overflow: Overflow::Scroll,
                ..Style::default()
            },
            id: Some("scroller"),
            scroll_offset: offset,
            children: vec![
                block([10, 0, 0, 255], false),
                block([0, 20, 0, 255], on_click),
            ],
            ..Node::default()
        }
    }

    #[test]
    fn scroll_area_reports_overflowing_content() {
        let mut canvas = Canvas::new(40, 40);
        let scene = scene_for(scroll_container(0.0, false), &mut canvas);
        let area = scene.scroll_area("scroller").unwrap();
        assert_eq!(area.content_height, 80.0);
        assert_eq!(area.max_scroll(), 40.0);
        assert!(scene.scroll_area_at(5.0, 5.0).is_some());
        assert!(scene.scroll_area_at(100.0, 5.0).is_none());
    }

    #[test]
    fn scroll_offset_shifts_children_and_clips_painting() {
        let mut canvas = Canvas::new(40, 60);
        scene_for(scroll_container(10.0, false), &mut canvas);
        // Offset 10 scrolls the red/green boundary from y=40 up to y=30.
        assert_eq!(&canvas.pixels[(29 * 40 * 4) as usize..][..4], &[10, 0, 0, 255]);
        assert_eq!(&canvas.pixels[(30 * 40 * 4) as usize..][..4], &[0, 20, 0, 255]);
        // The viewport ends at y=40; the green block must not paint below it.
        assert_eq!(&canvas.pixels[(40 * 40 * 4) as usize..][..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn scrolled_out_children_do_not_take_clicks() {
        let mut canvas = Canvas::new(40, 40);
        let scene = scene_for(scroll_container(0.0, true), &mut canvas);
        let mut hit = 0;
        assert!(
            !scene.dispatch_click(5.0, 35.0, &mut hit),
            "second block starts below the viewport"
        );

        let mut canvas = Canvas::new(40, 40);
        let scene = scene_for(scroll_container(40.0, true), &mut canvas);
        assert!(scene.dispatch_click(5.0, 35.0, &mut hit));
        assert_eq!(hit, 7, "fully scrolled, second block fills the viewport");
    }

    #[test]
    fn absolute_nodes_place_by_inset_and_sit_on_top() {
        use crate::style::{Inset, Position};
        let mut canvas = Canvas::new(100, 100);
        let under = Node {
            style: Style {
                width: Dimension::Px(100.0),
                height: Dimension::Px(100.0),
                ..Style::default()
            },
            on_click: Some(Box::new(|hit: &mut usize| *hit = 1)),
            ..Node::default()
        };
        let floating = Node {
            style: Style {
                position: Position::Absolute,
                inset: Inset::top_left(30.0, 40.0),
                width: Dimension::Px(20.0),
                height: Dimension::Px(10.0),
                background: Some([9, 9, 9, 255]),
                ..Style::default()
            },
            id: Some("float"),
            on_click: Some(Box::new(|hit: &mut usize| *hit = 2)),
            ..Node::default()
        };
        let root = Node {
            style: Style {
                width: Dimension::Px(100.0),
                height: Dimension::Px(100.0),
                ..Style::default()
            },
            children: vec![under, floating],
            ..Node::default()
        };
        let scene = scene_for(root, &mut canvas);

        let rect = scene.rect("float").unwrap();
        assert_eq!((rect.x, rect.y, rect.w, rect.h), (30.0, 40.0, 20.0, 10.0));
        assert_eq!(
            &canvas.pixels[((45 * 100 + 35) * 4) as usize..][..4],
            &[9, 9, 9, 255],
            "floating node paints over the sibling that fills the window"
        );
        let mut hit = 0;
        assert!(scene.dispatch_click(35.0, 45.0, &mut hit));
        assert_eq!(hit, 2, "floating node wins the hit test");
        assert!(scene.dispatch_click(5.0, 5.0, &mut hit));
        assert_eq!(hit, 1);
    }

    #[test]
    fn input_nodes_paint_caret_and_selection_and_expose_geometry() {
        use crate::text_input::TextInput;

        let editor = |input: &TextInput| {
            let mut node = input.node::<usize>([255, 0, 0, 255], [0, 255, 0, 255]);
            node.style = Style {
                padding: Edges::all(4.0),
                ..Style::default()
            };
            node.id = Some("in");
            Node {
                style: Style {
                    width: Dimension::Px(200.0),
                    height: Dimension::Px(60.0),
                    ..Style::default()
                },
                children: vec![node],
                ..Node::default()
            }
        };
        let pixel = |canvas: &Canvas, x: u32, y: u32| {
            let i = ((y * canvas.width + x) * 4) as usize;
            [canvas.pixels[i], canvas.pixels[i + 1], canvas.pixels[i + 2]]
        };

        let mut input = TextInput::new("hello".into());
        input.set_cursor(2, false);
        let mut canvas = Canvas::new(200, 60);
        let scene = scene_for(editor(&input), &mut canvas);

        let geometry = scene.input_geometry("in").unwrap();
        assert_eq!(geometry.origin, (4.0, 4.0), "origin is inside the padding");
        let caret = geometry.caret_rect(input.text(), input.cursor(), &[font()]);
        let center = (
            (caret.x + caret.w / 2.0) as u32,
            (caret.y + caret.h / 2.0) as u32,
        );
        assert_eq!(pixel(&canvas, center.0, center.1), [255, 0, 0], "caret painted");
        assert_eq!(
            geometry.offset_at(input.text(), (caret.x + 0.1, caret.y + 1.0), &[font()]),
            2,
            "geometry maps points back to offsets"
        );

        input.set_cursor(4, true);
        let mut canvas = Canvas::new(200, 60);
        scene_for(editor(&input), &mut canvas);
        let selected = geometry.caret_rect(input.text(), 3, &[font()]);
        assert_eq!(
            pixel(&canvas, selected.x as u32 + 1, selected.y as u32 + 1),
            [0, 255, 0],
            "selection painted behind the selected glyphs"
        );
        assert_eq!(
            pixel(&canvas, (caret.x + caret.w / 2.0) as u32, center.1),
            [0, 255, 0],
            "no caret while a selection is active"
        );
    }

    #[test]
    fn scroll_reveal_targets_the_nearest_edge() {
        let area = ScrollArea {
            id: None,
            rect: PxRect {
                x: 0.0,
                y: 100.0,
                w: 100.0,
                h: 50.0,
            },
            content_height: 500.0,
            offset: 20.0,
        };
        let rect = |y: f32| PxRect {
            x: 0.0,
            y,
            w: 2.0,
            h: 10.0,
        };
        assert_eq!(
            area.target_to_reveal(rect(90.0), 20.0, 0.0),
            Some(10.0),
            "above the viewport scrolls up to it"
        );
        assert_eq!(area.target_to_reveal(rect(110.0), 20.0, 0.0), None, "visible");
        assert_eq!(
            area.target_to_reveal(rect(160.0), 20.0, 0.0),
            Some(40.0),
            "below the viewport scrolls it flush with the bottom"
        );
        assert_eq!(
            area.target_to_reveal(rect(110.0), 20.0, 15.0),
            Some(15.0),
            "margin widens what counts as hidden"
        );
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
