use std::ops::Range;

use crate::canvas::{Canvas, measure_text};
use crate::style::{Color, Overflow};
use crate::text_input::{caret_width, offset_to_point};
use crate::tree::{NodeId, PxRect, Tree};
use crate::wrap::wrap_lines;

// todo: check why, and verify this statement "Requires `flush_layout` to have run first."
pub fn paint(tree: &Tree, canvas: &mut Canvas, fonts: &[fontdue::Font], cursor: Option<(f32, f32)>) {
    assert!(!fonts.is_empty());
    crate::profiler::span("tree.paint", || {
        paint_node(tree, tree.root(), canvas, fonts, cursor);
    });
}

fn paint_node(
    tree: &Tree,
    id: NodeId,
    canvas: &mut Canvas,
    fonts: &[fontdue::Font],
    cursor: Option<(f32, f32)>,
) {
    let Some(node) = tree.get(id) else {
        return;
    };
    if node.hidden {
        return;
    }
    let rect = node.abs;
    let visible = node.visible;
    let hovered = cursor.is_some_and(|(x, y)| visible.contains(x, y));

    let background = match (hovered, node.style.hover_background) {
        (true, Some(bg)) => Some(bg),
        _ => node.style.background,
    };
    if let Some(bg) = background {
        canvas.fill_rounded_rect(rect.x, rect.y, rect.w, rect.h, node.style.corner_radius, bg);
    }
    if let Some(border) = node.style.border {
        canvas.stroke_rounded_rect(
            rect.x,
            rect.y,
            rect.w,
            rect.h,
            node.style.corner_radius,
            border.width,
            border.color,
        );
    }

    let clips_children = node.style.overflow != Overflow::Visible;
    if clips_children {
        canvas.push_clip(rect.x, rect.y, rect.w, rect.h);
    }

    if let Some(text) = &node.text {
        let px = node.resolved.px;
        let font = &fonts[node.resolved.font.min(fonts.len() - 1)];
        if let Some(line_metrics) = font.horizontal_line_metrics(px) {
            let color = match (hovered, node.style.hover_color) {
                (true, Some(c)) => c,
                _ => node.resolved.color,
            };
            let padding = tree
                .taffy
                .layout(node.taffy)
                .map(|l| (l.padding.left, l.padding.top, l.padding.right))
                .unwrap_or((0.0, 0.0, 0.0));
            let origin = (rect.x + padding.0, rect.y + padding.1);
            let wrap = node
                .style
                .wrap
                .then(|| (rect.w - padding.0 - padding.2).max(0.0) + crate::wrap::WRAP_SLACK);
            let lines = wrap_lines(text, font, px, wrap);
            let line_h = line_metrics.new_line_size;
            if let Some(state) = &node.input
                && let Some(selection) = state.input.selection()
            {
                paint_selection(
                    canvas,
                    text,
                    &lines,
                    &selection,
                    origin,
                    font,
                    px,
                    line_h,
                    visible,
                    state.selection_color,
                );
            }
            for (i, line) in lines.iter().enumerate() {
                let top = origin.1 + line_h * i as f32;
                if top + 2.0 * line_h < visible.y {
                    continue;
                }
                if top - line_h > visible.y + visible.h {
                    break;
                }
                canvas.draw_text(
                    font,
                    &text[line.clone()],
                    origin.0 as i32,
                    (top + line_metrics.ascent) as i32,
                    px,
                    color,
                );
            }
            if let Some(state) = &node.input
                && state.input.selection().is_none()
                && tree.focus() == Some(id)
            {
                let (x, y) = offset_to_point(text, state.input.cursor(), font, px, wrap);
                canvas.fill_rounded_rect(
                    origin.0 + x,
                    origin.1 + y,
                    caret_width(px),
                    line_h,
                    1.5,
                    state.caret_color,
                );
            }
        }
    }

    for &child in &node.children {
        paint_node(tree, child, canvas, fonts, cursor);
    }
    paint_scrollbar(tree, id, canvas);
    if clips_children {
        canvas.pop_clip();
    }
}

fn paint_scrollbar(tree: &Tree, id: NodeId, canvas: &mut Canvas) {
    let Some(node) = tree.get(id) else {
        return;
    };
    let opacity = node.bar.opacity;
    if opacity <= 0.0 {
        return;
    }
    let Some(rects) = tree.scrollbar_rects(id) else {
        return;
    };
    let Some(bar) = tree.scrollbar_style(id) else {
        return;
    };
    let expand = node.bar.expand;
    if expand > 0.0 {
        let track = fade(bar.track_color, opacity * expand);
        canvas.fill_rounded_rect(
            rects.track.x,
            rects.track.y,
            rects.track.w,
            rects.track.h,
            rects.track.w / 2.0,
            track,
        );
    }
    let thumb = fade(lerp_color(bar.thumb_color, bar.thumb_hover_color, expand), opacity);
    canvas.fill_rounded_rect(
        rects.thumb.x,
        rects.thumb.y,
        rects.thumb.w,
        rects.thumb.h,
        rects.thumb.w / 2.0,
        thumb,
    );
}

fn fade(color: Color, factor: f32) -> Color {
    [
        color[0],
        color[1],
        color[2],
        (color[3] as f32 * factor.clamp(0.0, 1.0)) as u8,
    ]
}

fn lerp_color(from: Color, to: Color, t: f32) -> Color {
    let ch = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t) as u8;
    [
        ch(from[0], to[0]),
        ch(from[1], to[1]),
        ch(from[2], to[2]),
        ch(from[3], to[3]),
    ]
}

#[allow(clippy::too_many_arguments)]
fn paint_selection(
    canvas: &mut Canvas,
    text: &str,
    lines: &[Range<usize>],
    selection: &Range<usize>,
    origin: (f32, f32),
    font: &fontdue::Font,
    px: f32,
    line_h: f32,
    visible: PxRect,
    color: Color,
) {
    let newline_w = measure_text(font, " ", px);
    for (i, line) in lines.iter().enumerate() {
        if line.start > selection.end {
            break;
        }
        let top = origin.1 + line_h * i as f32;
        if top > visible.y + visible.h {
            break;
        }
        let overlaps = selection.start <= line.end && selection.end > line.start;
        if overlaps && top + line_h >= visible.y {
            let from = selection.start.max(line.start);
            let to = selection.end.min(line.end);
            let x1 = measure_text(font, &text[line.start..from], px);
            let mut x2 = measure_text(font, &text[line.start..to], px);
            // A selection crossing an explicit newline shows it as a space.
            if selection.end > line.end && text[line.end..].starts_with('\n') {
                x2 += newline_w;
            }
            canvas.fill_rounded_rect(origin.0 + x1, top, (x2 - x1).max(1.0), line_h, 0.0, color);
        }
    }
}
