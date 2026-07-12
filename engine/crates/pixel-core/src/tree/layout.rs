
use crate::canvas::measure_text;
use crate::style::{Align, Dimension, FlexDirection, InsetValue, Justify, Overflow, Position, Style};
use crate::wrap::wrap_lines;

pub(crate) struct MeasureCtx {
    pub text: String,
    pub px: f32,
    pub font: usize,
    pub wrap: bool,
}

pub(super) fn measure(
    known: taffy::Size<Option<f32>>,
    available: taffy::Size<taffy::AvailableSpace>,
    context: Option<&MeasureCtx>,
    fonts: &[fontdue::Font],
) -> taffy::Size<f32> {
    let Some(ctx) = context else {
        return taffy::Size::ZERO;
    };
    let font = &fonts[ctx.font.min(fonts.len() - 1)];
    let line = font
        .horizontal_line_metrics(ctx.px)
        .map_or(ctx.px, |m| m.new_line_size);
    let max_width = if ctx.wrap {
        match (known.width, available.width) {
            (Some(w), _) => Some(w),
            (None, taffy::AvailableSpace::Definite(w)) => Some(w),
            (None, taffy::AvailableSpace::MinContent) => Some(0.0),
            (None, taffy::AvailableSpace::MaxContent) => None,
        }
    } else {
        None
    };
    let lines = wrap_lines(&ctx.text, font, ctx.px, max_width);
    let widest = lines
        .iter()
        .map(|r| {
            let visible = ctx.text[r.clone()].trim_end_matches(' ');
            measure_text(font, visible, ctx.px)
        })
        .fold(0.0f32, f32::max);
    taffy::Size {
        // Ceil so taffy's whole-pixel rounding never under-allocates the
        // text width.
        width: widest.ceil(),
        height: line * lines.len() as f32,
    }
}

pub(super) fn to_taffy(style: &Style, hidden: bool) -> taffy::Style {
    use taffy::prelude::{auto, length, percent};

    fn dimension(d: Dimension) -> taffy::Dimension {
        match d {
            Dimension::Auto => auto(),
            Dimension::Px(v) => length(v),
            Dimension::Percent(f) => percent(f),
        }
    }

    fn inset_edge(v: Option<InsetValue>) -> taffy::LengthPercentageAuto {
        match v {
            None => auto(),
            Some(InsetValue::Px(v)) => length(v),
            Some(InsetValue::Percent(f)) => percent(f),
        }
    }

    let overflow = match style.overflow {
        Overflow::Visible => taffy::Overflow::Visible,
        Overflow::Hidden => taffy::Overflow::Hidden,
        Overflow::Scroll => taffy::Overflow::Scroll,
    };

    taffy::Style {
        display: if hidden {
            taffy::Display::None
        } else {
            taffy::Display::Flex
        },
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
        flex_basis: dimension(style.flex_basis),
        size: taffy::Size {
            width: dimension(style.width),
            height: dimension(style.height),
        },
        max_size: taffy::Size {
            width: dimension(style.max_width),
            height: dimension(style.max_height),
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
