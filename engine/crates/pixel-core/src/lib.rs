mod canvas;
pub mod clipboard_image;
mod desc;
mod engine;
pub mod ghostty;
mod image_cache;
mod kitty;
pub mod logging;
mod menu;
mod native;
mod paint;
pub mod profiler;
mod scroll;
mod scrollbar;
mod selection;
mod style;
mod terminal;
mod text_input;
mod throttle;
mod tree;
mod wrap;

pub use canvas::{Canvas, measure_text};
pub use desc::Desc;
pub use engine::{
    AttachmentRef, Engine, EngineConfig, EngineEvent, FrameStats, HighlightArea,
    px_for_cell_height,
};
pub use kitty::kitty_transmit;
pub use logging::{LogEntry, LogLevel};
pub use menu::{CONTEXT_MENU_KEY, MenuEntry, MenuItem, MenuStyle, context_menu};
pub use native::{NativeDelta, NativeScroll};
pub use paint::paint;
pub use profiler::{CounterRecord, ProfileData, Profiler, SpanRecord};
pub use scroll::profiles::{Glide, Smooth, Tui};
pub use scroll::{ScrollProfile, ScrollState};
pub use scrollbar::ScrollbarRects;
pub use selection::{DocPos, DocSelection};
pub use style::{
    Align, Border, BorderSide, Color, Dimension, Edges, FlexDirection, Inset, InsetValue, Justify,
    Overflow, Position, ScrollbarStyle, SelectionMode, Style,
};
pub use terminal::{
    Event, Key, KeyEvent, Mods, Mouse, MouseButton, MouseKind, Terminal, TerminalColors, Waker,
    WindowSize,
};
pub use text_input::{
    ATOM_CHAR, Atom, Granularity, InputAction, InputGeometry, InputReply, TextInput, atom_advance,
    line_height, offset_to_point, point_to_offset,
};
pub use throttle::CpuThrottle;
pub use tree::{
    BoxMetrics, HitTarget, ImageProps, InputProps, NodeId, Props, PxRect, ScrollArea, TextSpan,
    Tree,
};
pub use wrap::{line_of_offset, wrap_lines};

pub use fontdue;
