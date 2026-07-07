pub type Color = [u8; 4];

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum Dimension {
    #[default]
    Auto,
    Px(f32),
    /// Fraction of the parent, 0.0..=1.0.
    Percent(f32),
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Edges {
    pub left: f32,
    pub right: f32,
    pub top: f32,
    pub bottom: f32,
}

impl Edges {
    pub fn all(v: f32) -> Self {
        Self {
            left: v,
            right: v,
            top: v,
            bottom: v,
        }
    }

    pub fn symmetric(horizontal: f32, vertical: f32) -> Self {
        Self {
            left: horizontal,
            right: horizontal,
            top: vertical,
            bottom: vertical,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FlexDirection {
    #[default]
    Row,
    Column,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Justify {
    Start,
    Center,
    End,
    SpaceBetween,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Start,
    Center,
    End,
    Stretch,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Border {
    pub width: f32,
    pub color: Color,
}

impl Border {
    pub fn hairline(color: Color) -> Self {
        Self { width: 1.0, color }
    }
}

/// One style object per node, DOM-like: layout and decoration together.
/// `color`, `font_size`, and `font` inherit to descendants; everything else
/// is local. `font` indexes into the fonts slice passed to `render_scene`.
#[derive(Debug, Clone, Default)]
pub struct Style {
    pub flex_direction: FlexDirection,
    pub flex_grow: f32,
    pub width: Dimension,
    pub height: Dimension,
    pub padding: Edges,
    pub margin: Edges,
    pub gap: f32,
    pub justify_content: Option<Justify>,
    pub align_items: Option<Align>,
    pub background: Option<Color>,
    pub corner_radius: f32,
    pub border: Option<Border>,
    pub color: Option<Color>,
    pub font_size: Option<f32>,
    pub font: Option<usize>,
    pub hover_background: Option<Color>,
    pub hover_color: Option<Color>,
}
