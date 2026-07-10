use std::collections::VecDeque;
use std::ops::Range;
use std::time::{Duration, Instant};

use crate::canvas::measure_text;
use crate::terminal::{Key, KeyEvent, Mouse, MouseButton, MouseKind};
use crate::tree::PxRect;
use crate::wrap::{line_of_offset, wrap_lines};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Granularity {
    Char,
    Word,
    Line,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputAction {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputReply {
    None,
    Edited,
    Moved,
    Selected,
    Copy(String),
    Cut(String),
    RequestPaste,
}

#[derive(Debug, Clone, Copy)]
pub struct InputGeometry {
    pub origin: (f32, f32),
    pub font: usize,
    pub px: f32,
    pub max_width: Option<f32>,
}

impl InputGeometry {
    pub fn offset_at(&self, text: &str, point: (f32, f32), fonts: &[fontdue::Font]) -> usize {
        let font = &fonts[self.font.min(fonts.len() - 1)];
        point_to_offset(
            text,
            point.0 - self.origin.0,
            point.1 - self.origin.1,
            font,
            self.px,
            self.max_width,
        )
    }

    pub fn caret_rect(&self, text: &str, cursor: usize, fonts: &[fontdue::Font]) -> PxRect {
        let font = &fonts[self.font.min(fonts.len() - 1)];
        let (x, y) = offset_to_point(text, cursor, font, self.px, self.max_width);
        PxRect {
            x: self.origin.0 + x,
            y: self.origin.1 + y,
            w: caret_width(self.px),
            h: line_height(font, self.px),
        }
    }
}

pub(crate) fn caret_width(px: f32) -> f32 {
    (px / 8.0).max(2.0)
}

#[derive(Debug, Clone, Default)]
struct ClickTracker {
    last: Option<(Instant, (f32, f32))>,
    count: u32,
}

impl ClickTracker {
    fn register(&mut self, point: (f32, f32), now: Instant) -> u32 {
        let chained = self.last.is_some_and(|(at, p)| {
            now.duration_since(at) < Duration::from_millis(450)
                && (p.0 - point.0).abs() < 6.0
                && (p.1 - point.1).abs() < 6.0
        });
        self.count = if chained { self.count + 1 } else { 1 };
        self.last = Some((now, point));
        self.count
    }
}

#[derive(Debug, Clone)]
struct Edit {
    at: usize,
    removed: String,
    inserted: String,
    cursor_before: usize,
    anchor_before: Option<usize>,
    kind: EditKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EditKind {
    Typing,
    Backspace,
    Other,
}

const MAX_UNDO: usize = 1000;

#[derive(Debug, Clone, Default)]
pub struct TextInput {
    text: String,
    cursor: usize,
    anchor: Option<usize>,
    goal_x: Option<f32>,
    undo: VecDeque<Edit>,
    redo: Vec<Edit>,
    sealed: bool,
    clicks: ClickTracker,
    selecting: bool,
}

impl TextInput {
    pub fn new(text: String) -> Self {
        let cursor = text.len();
        Self {
            text,
            cursor,
            ..Self::default()
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn selection(&self) -> Option<Range<usize>> {
        let anchor = self.anchor?;
        if anchor == self.cursor {
            return None;
        }
        Some(anchor.min(self.cursor)..anchor.max(self.cursor))
    }

    pub fn selected_text(&self) -> Option<&str> {
        self.selection().map(|range| &self.text[range])
    }

    pub fn insert(&mut self, s: &str) {
        // The caret is a zero-width selection: replacing it is insertion.
        let caret = self.cursor..self.cursor;
        let range = self.selection().unwrap_or(caret);
        let kind = if range.is_empty() && s.chars().count() == 1 && s != "\n" {
            EditKind::Typing
        } else {
            EditKind::Other
        };
        self.splice(range, s, kind);
    }

    pub fn delete_selection(&mut self) -> bool {
        let Some(range) = self.selection() else {
            self.anchor = None;
            return false;
        };
        self.splice(range, "", EditKind::Other);
        true
    }

    pub fn delete_backward(&mut self, granularity: Granularity) {
        if self.delete_selection() {
            return;
        }
        let start = self.left_boundary(granularity);
        let kind = if granularity == Granularity::Char {
            EditKind::Backspace
        } else {
            EditKind::Other
        };
        self.splice(start..self.cursor, "", kind);
    }

    pub fn delete_forward(&mut self, granularity: Granularity) {
        if self.delete_selection() {
            return;
        }
        let end = self.right_boundary(granularity);
        self.splice(self.cursor..end, "", EditKind::Other);
    }

    fn splice(&mut self, range: Range<usize>, replacement: &str, kind: EditKind) {
        let edit = Edit {
            at: range.start,
            removed: self.text[range.clone()].to_string(),
            inserted: replacement.to_string(),
            cursor_before: self.cursor,
            anchor_before: self.anchor,
            kind,
        };
        self.text.replace_range(range.clone(), replacement);
        self.cursor = range.start + replacement.len();
        self.anchor = None;
        self.goal_x = None;
        self.record(edit);
    }

    
    fn record(&mut self, edit: Edit) {
        self.redo.clear();
        let may_coalesce = !self.sealed;
        self.sealed = false;
        if may_coalesce && let Some(prev) = self.undo.back_mut() {
            match (prev.kind, edit.kind) {
                (EditKind::Typing, EditKind::Typing)
                    if edit.at == prev.at + prev.inserted.len() =>
                {
                    prev.inserted.push_str(&edit.inserted);
                    return;
                }
                (EditKind::Backspace, EditKind::Backspace)
                    if edit.at + edit.removed.len() == prev.at =>
                {
                    prev.at = edit.at;
                    prev.removed = format!("{}{}", edit.removed, prev.removed);
                    return;
                }
                _ => {}
            }
        }
        self.undo.push_back(edit);
        if self.undo.len() > MAX_UNDO {
            self.undo.pop_front();
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn undo(&mut self) -> bool {
        let Some(edit) = self.undo.pop_back() else {
            return false;
        };
        self.text
            .replace_range(edit.at..edit.at + edit.inserted.len(), &edit.removed);
        self.cursor = edit.cursor_before;
        self.anchor = edit.anchor_before;
        self.goal_x = None;
        self.sealed = true;
        self.redo.push(edit);
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(edit) = self.redo.pop() else {
            return false;
        };
        self.text
            .replace_range(edit.at..edit.at + edit.removed.len(), &edit.inserted);
        self.cursor = edit.at + edit.inserted.len();
        self.anchor = None;
        self.goal_x = None;
        self.sealed = true;
        self.undo.push_back(edit);
        true
    }

    pub fn move_left(&mut self, granularity: Granularity, extend: bool) {
        if !extend
            && granularity == Granularity::Char
            && let Some(range) = self.selection()
        {
            self.place(range.start, false);
            return;
        }
        let target = self.left_boundary(granularity);
        self.place(target, extend);
    }

    pub fn move_right(&mut self, granularity: Granularity, extend: bool) {
        if !extend
            && granularity == Granularity::Char
            && let Some(range) = self.selection()
        {
            self.place(range.end, false);
            return;
        }
        let target = self.right_boundary(granularity);
        self.place(target, extend);
    }

    pub fn move_up(&mut self, extend: bool, font: &fontdue::Font, px: f32, wrap: Option<f32>) {
        self.move_vertical(true, extend, font, px, wrap);
    }

    pub fn move_down(&mut self, extend: bool, font: &fontdue::Font, px: f32, wrap: Option<f32>) {
        self.move_vertical(false, extend, font, px, wrap);
    }

    fn move_vertical(
        &mut self,
        up: bool,
        extend: bool,
        font: &fontdue::Font,
        px: f32,
        wrap: Option<f32>,
    ) {
        if !extend && let Some(range) = self.selection() {
            self.cursor = if up { range.start } else { range.end };
            self.anchor = None;
        }
        let lines = wrap_lines(&self.text, font, px, wrap);
        let line = line_of_offset(&lines, self.cursor);
        let range = &lines[line];
        let x = self
            .goal_x
            .unwrap_or_else(|| measure_text(font, &self.text[range.start..self.cursor], px));
        let target = if up {
            if line == 0 {
                0
            } else {
                let prev = &lines[line - 1];
                prev.start + nearest_column(&self.text[prev.clone()], x, font, px)
            }
        } else if line + 1 >= lines.len() {
            self.text.len()
        } else {
            let next = &lines[line + 1];
            next.start + nearest_column(&self.text[next.clone()], x, font, px)
        };
        self.place(target, extend);
        self.goal_x = Some(x);
    }

    pub fn move_doc_start(&mut self, extend: bool) {
        self.place(0, extend);
    }

    pub fn move_doc_end(&mut self, extend: bool) {
        self.place(self.text.len(), extend);
    }

    pub fn select_all(&mut self) {
        self.anchor = Some(0);
        self.cursor = self.text.len();
        self.goal_x = None;
        self.sealed = true;
    }

    pub fn collapse(&mut self) -> bool {
        let had_selection = self.selection().is_some();
        self.anchor = None;
        self.sealed = true;
        had_selection
    }

    pub fn set_cursor(&mut self, offset: usize, extend: bool) {
        self.place(snap_to_boundary(&self.text, offset), extend);
    }

    pub fn select_word_at(&mut self, offset: usize) {
        let offset = snap_to_boundary(&self.text, offset);
        // prefer the word to the left when the click lands on a boundary.
        let pivot = if self.text[offset..].chars().next().is_some_and(is_word_char) {
            offset
        } else if self.text[..offset].chars().next_back().is_some_and(is_word_char) {
            prev_char(&self.text, offset)
        } else if offset < self.text.len() {
            offset
        } else if offset > 0 {
            prev_char(&self.text, offset)
        } else {
            return;
        };
        let class = char_class(self.text[pivot..].chars().next().expect("pivot in bounds"));
        let mut start = pivot;
        for (i, c) in self.text[..pivot].char_indices().rev() {
            if char_class(c) != class {
                break;
            }
            start = i;
        }
        let mut end = pivot;
        for (i, c) in self.text[pivot..].char_indices() {
            if char_class(c) != class {
                break;
            }
            end = pivot + i + c.len_utf8();
        }
        self.anchor = Some(start);
        self.cursor = end;
        self.goal_x = None;
        self.sealed = true;
    }

    pub fn select_line_at(&mut self, offset: usize) {
        let offset = snap_to_boundary(&self.text, offset);
        let start = line_start(&self.text, offset);
        let end = line_end(&self.text, offset);
        self.anchor = Some(start);
        self.cursor = (end + 1).min(self.text.len());
        self.goal_x = None;
        self.sealed = true;
    }

    fn place(&mut self, target: usize, extend: bool) {
        if extend {
            if self.anchor.is_none() {
                self.anchor = Some(self.cursor);
            }
        } else {
            self.anchor = None;
        }
        self.cursor = target;
        self.goal_x = None;
        self.sealed = true;
    }

    fn left_boundary(&self, granularity: Granularity) -> usize {
        match granularity {
            Granularity::Char => prev_char(&self.text, self.cursor),
            Granularity::Word => prev_word_boundary(&self.text, self.cursor),
            Granularity::Line => line_start(&self.text, self.cursor),
        }
    }

    fn right_boundary(&self, granularity: Granularity) -> usize {
        match granularity {
            Granularity::Char => next_char(&self.text, self.cursor),
            Granularity::Word => next_word_boundary(&self.text, self.cursor),
            Granularity::Line => line_end(&self.text, self.cursor),
        }
    }

    pub fn replace_all(&mut self, text: &str) {
        if self.text == text {
            return;
        }
        self.sealed = true;
        let end = self.text.len();
        self.splice(0..end, text, EditKind::Other);
        self.sealed = true;
    }

    pub fn apply(&mut self, action: InputAction) -> InputReply {
        match action {
            InputAction::Undo => {
                if self.undo() {
                    InputReply::Edited
                } else {
                    InputReply::None
                }
            }
            InputAction::Redo => {
                if self.redo() {
                    InputReply::Edited
                } else {
                    InputReply::None
                }
            }
            InputAction::Copy => match self.selected_text() {
                Some(text) => InputReply::Copy(text.to_string()),
                None => InputReply::None,
            },
            InputAction::Cut => match self.selected_text().map(str::to_string) {
                Some(text) => {
                    self.delete_selection();
                    InputReply::Cut(text)
                }
                None => InputReply::None,
            },
            InputAction::Paste => InputReply::RequestPaste,
            InputAction::SelectAll => {
                self.select_all();
                InputReply::Selected
            }
        }
    }

    pub fn handle_key(
        &mut self,
        key: KeyEvent,
        font: &fontdue::Font,
        px: f32,
        wrap: Option<f32>,
    ) -> InputReply {
        use Granularity::{Char, Line, Word};
        let m = key.mods;
        let combo = m.ctrl || m.sup;
        let horizontal = if m.alt {
            Word
        } else if m.sup {
            Line
        } else {
            Char
        };
        match key.key {
            Key::Char('a') if m.sup => self.apply(InputAction::SelectAll),
            Key::Char('z') if combo => self.apply(if m.shift {
                InputAction::Redo
            } else {
                InputAction::Undo
            }),
            Key::Char('c') if combo => self.apply(InputAction::Copy),
            Key::Char('x') if combo => self.apply(InputAction::Cut),
            Key::Char('v') if combo => self.apply(InputAction::Paste),
            Key::Left => {
                self.move_left(horizontal, m.shift);
                InputReply::Moved
            }
            Key::Right => {
                self.move_right(horizontal, m.shift);
                InputReply::Moved
            }
            Key::Up if m.sup => {
                self.move_doc_start(m.shift);
                InputReply::Moved
            }
            Key::Down if m.sup => {
                self.move_doc_end(m.shift);
                InputReply::Moved
            }
            Key::Up => {
                self.move_up(m.shift, font, px, wrap);
                InputReply::Moved
            }
            Key::Down => {
                self.move_down(m.shift, font, px, wrap);
                InputReply::Moved
            }
            Key::Home => {
                self.move_left(Line, m.shift);
                InputReply::Moved
            }
            Key::End => {
                self.move_right(Line, m.shift);
                InputReply::Moved
            }
            Key::Backspace => {
                self.delete_backward(horizontal);
                InputReply::Edited
            }
            Key::Delete => {
                self.delete_forward(if m.alt { Word } else { Char });
                InputReply::Edited
            }
            Key::Enter => {
                self.insert("\n");
                InputReply::Edited
            }
            Key::Escape => {
                if self.collapse() {
                    InputReply::Selected
                } else {
                    InputReply::None
                }
            }
            // The Cocoa control keys; also what Ghostty's default keybinds
            // rewrite cmd+left/right/backspace and option+arrows into.
            Key::Char('a') if m.ctrl => {
                self.move_left(Line, m.shift);
                InputReply::Moved
            }
            Key::Char('e') if m.ctrl => {
                self.move_right(Line, m.shift);
                InputReply::Moved
            }
            Key::Char('b') if m.ctrl => {
                self.move_left(Char, m.shift);
                InputReply::Moved
            }
            Key::Char('f') if m.ctrl => {
                self.move_right(Char, m.shift);
                InputReply::Moved
            }
            Key::Char('b') if m.alt => {
                self.move_left(Word, m.shift);
                InputReply::Moved
            }
            Key::Char('f') if m.alt => {
                self.move_right(Word, m.shift);
                InputReply::Moved
            }
            Key::Char('d') if m.ctrl => {
                self.delete_forward(Char);
                InputReply::Edited
            }
            Key::Char('k') if m.ctrl => {
                self.delete_forward(Line);
                InputReply::Edited
            }
            Key::Char('w') if m.ctrl => {
                self.delete_backward(Word);
                InputReply::Edited
            }
            Key::Char('u') if m.ctrl => {
                self.delete_backward(Line);
                InputReply::Edited
            }
            Key::Char(c) if !m.ctrl && !m.sup && !m.alt && !c.is_control() => {
                self.insert(c.encode_utf8(&mut [0u8; 4]));
                InputReply::Edited
            }
            _ => InputReply::None,
        }
    }

    pub fn handle_mouse(
        &mut self,
        mouse: &Mouse,
        geometry: InputGeometry,
        fonts: &[fontdue::Font],
    ) -> InputReply {
        let point = (mouse.x as f32, mouse.y as f32);
        match (mouse.kind, mouse.button) {
            (MouseKind::Down, MouseButton::Left) => {
                let offset = geometry.offset_at(&self.text, point, fonts);
                match self.clicks.register(point, Instant::now()) % 3 {
                    1 => {
                        self.set_cursor(offset, false);
                        self.selecting = true;
                    }
                    2 => self.select_word_at(offset),
                    _ => self.select_line_at(offset),
                }
                InputReply::Selected
            }
            (MouseKind::Move, MouseButton::Left) if self.selecting => {
                let offset = geometry.offset_at(&self.text, point, fonts);
                self.set_cursor(offset, true);
                InputReply::Selected
            }
            (MouseKind::Up, _) => {
                self.selecting = false;
                InputReply::None
            }
            _ => InputReply::None,
        }
    }
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn char_class(c: char) -> u8 {
    if is_word_char(c) {
        0
    } else if c == '\n' {
        1
    } else {
        2
    }
}

fn snap_to_boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

fn prev_char(text: &str, offset: usize) -> usize {
    text[..offset].char_indices().next_back().map_or(0, |(i, _)| i)
}

fn next_char(text: &str, offset: usize) -> usize {
    text[offset..]
        .chars()
        .next()
        .map_or(offset, |c| offset + c.len_utf8())
}

fn prev_word_boundary(text: &str, offset: usize) -> usize {
    let mut pos = offset;
    let mut iter = text[..offset].char_indices().rev().peekable();
    while let Some(&(i, c)) = iter.peek() {
        if is_word_char(c) {
            break;
        }
        pos = i;
        iter.next();
    }
    while let Some(&(i, c)) = iter.peek() {
        if !is_word_char(c) {
            break;
        }
        pos = i;
        iter.next();
    }
    pos
}

fn next_word_boundary(text: &str, offset: usize) -> usize {
    let mut pos = offset;
    let mut iter = text[offset..].char_indices().peekable();
    while let Some(&(i, c)) = iter.peek() {
        if is_word_char(c) {
            break;
        }
        pos = offset + i + c.len_utf8();
        iter.next();
    }
    while let Some(&(i, c)) = iter.peek() {
        if !is_word_char(c) {
            break;
        }
        pos = offset + i + c.len_utf8();
        iter.next();
    }
    pos
}

fn line_start(text: &str, offset: usize) -> usize {
    text[..offset].rfind('\n').map_or(0, |i| i + 1)
}

fn line_end(text: &str, offset: usize) -> usize {
    text[offset..].find('\n').map_or(text.len(), |i| offset + i)
}

pub fn line_height(font: &fontdue::Font, px: f32) -> f32 {
    font.horizontal_line_metrics(px)
        .map_or(px, |m| m.new_line_size)
}

pub fn offset_to_point(
    text: &str,
    offset: usize,
    font: &fontdue::Font,
    px: f32,
    wrap: Option<f32>,
) -> (f32, f32) {
    let offset = snap_to_boundary(text, offset);
    let lines = wrap_lines(text, font, px, wrap);
    let line = line_of_offset(&lines, offset);
    let start = lines[line].start;
    (
        measure_text(font, &text[start..offset.max(start)], px),
        line as f32 * line_height(font, px),
    )
}

pub fn point_to_offset(
    text: &str,
    x: f32,
    y: f32,
    font: &fontdue::Font,
    px: f32,
    wrap: Option<f32>,
) -> usize {
    let lines = wrap_lines(text, font, px, wrap);
    let line = ((y / line_height(font, px)).floor().max(0.0) as usize).min(lines.len() - 1);
    let range = &lines[line];
    range.start + nearest_column(&text[range.clone()], x, font, px)
}

fn nearest_column(line: &str, x: f32, font: &fontdue::Font, px: f32) -> usize {
    let mut pen = 0.0;
    for (i, c) in line.char_indices() {
        let mut buf = [0u8; 4];
        let advance = measure_text(font, c.encode_utf8(&mut buf), px);
        if x < pen + advance / 2.0 {
            return i;
        }
        pen += advance;
    }
    line.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    static FONT_BYTES: &[u8] =
        include_bytes!("../../../examples/typing/assets/JetBrainsMono-Regular.ttf");

    fn font() -> fontdue::Font {
        fontdue::Font::from_bytes(FONT_BYTES, fontdue::FontSettings::default()).unwrap()
    }

    fn input(text: &str, cursor: usize) -> TextInput {
        let mut input = TextInput::new(text.into());
        input.set_cursor(cursor, false);
        input
    }

    #[test]
    fn inserts_and_deletes_at_the_cursor() {
        let mut i = input("hello world", 5);
        i.insert(",");
        assert_eq!(i.text(), "hello, world");
        assert_eq!(i.cursor(), 6);
        i.delete_backward(Granularity::Char);
        assert_eq!(i.text(), "hello world");
        assert_eq!(i.cursor(), 5);
        i.delete_forward(Granularity::Char);
        assert_eq!(i.text(), "helloworld");
    }

    #[test]
    fn typing_replaces_the_selection() {
        let mut i = input("hello world", 0);
        i.set_cursor(5, false);
        i.set_cursor(0, true);
        i.insert("goodbye");
        assert_eq!(i.text(), "goodbye world");
        assert_eq!(i.cursor(), 7);
        assert_eq!(i.selection(), None);
    }

    #[test]
    fn backspace_with_selection_deletes_only_the_selection() {
        let mut i = input("hello world", 6);
        i.set_cursor(11, true);
        i.delete_backward(Granularity::Word);
        assert_eq!(i.text(), "hello ");
        assert_eq!(i.cursor(), 6);
    }

    #[test]
    fn word_movement_lands_on_word_edges() {
        let mut i = input("foo bar_baz  qux", 16);
        i.move_left(Granularity::Word, false);
        assert_eq!(i.cursor(), 13, "start of qux");
        i.move_left(Granularity::Word, false);
        assert_eq!(i.cursor(), 4, "start of bar_baz");
        i.move_right(Granularity::Word, false);
        assert_eq!(i.cursor(), 11, "end of bar_baz");
        i.move_right(Granularity::Word, false);
        assert_eq!(i.cursor(), 16, "end of qux");
    }

    #[test]
    fn word_movement_crosses_newlines() {
        let mut i = input("one\ntwo", 4);
        i.move_left(Granularity::Word, false);
        assert_eq!(i.cursor(), 0);
        i.move_right(Granularity::Word, false);
        assert_eq!(i.cursor(), 3);
    }

    #[test]
    fn line_movement_uses_the_current_line() {
        let mut i = input("first\nsecond line\nthird", 10);
        i.move_left(Granularity::Line, false);
        assert_eq!(i.cursor(), 6);
        i.move_right(Granularity::Line, false);
        assert_eq!(i.cursor(), 17);
    }

    #[test]
    fn delete_backward_word_and_line() {
        let mut i = input("one two three", 13);
        i.delete_backward(Granularity::Word);
        assert_eq!(i.text(), "one two ");
        i.delete_backward(Granularity::Line);
        assert_eq!(i.text(), "");
    }

    #[test]
    fn shift_extends_and_plain_arrows_collapse() {
        let mut i = input("abcdef", 2);
        i.move_right(Granularity::Char, true);
        i.move_right(Granularity::Char, true);
        assert_eq!(i.selection(), Some(2..4));
        assert_eq!(i.selected_text(), Some("cd"));

        i.move_left(Granularity::Char, false);
        assert_eq!(i.selection(), None);
        assert_eq!(i.cursor(), 2, "left collapses to selection start");

        i.move_right(Granularity::Char, true);
        i.move_right(Granularity::Char, false);
        assert_eq!(i.cursor(), 3, "right collapses to selection end");
    }

    #[test]
    fn shrinking_a_selection_back_to_the_anchor_empties_it() {
        let mut i = input("abc", 1);
        i.move_right(Granularity::Char, true);
        assert_eq!(i.selection(), Some(1..2));
        i.move_left(Granularity::Char, true);
        assert_eq!(i.selection(), None);
    }

    #[test]
    fn vertical_movement_keeps_the_goal_column() {
        let f = font();
        let mut i = input("a long first line\nab\nanother long line", 12);
        i.move_down(false, &f, 16.0, None);
        assert_eq!(i.cursor(), 20, "short line clamps to its end");
        i.move_down(false, &f, 16.0, None);
        let (x, _) = offset_to_point(i.text(), i.cursor(), &f, 16.0, None);
        let (goal_x, _) = offset_to_point("a long first line", 12, &f, 16.0, None);
        assert!((x - goal_x).abs() < 1.0, "goal column restored: {x} vs {goal_x}");
        i.move_up(false, &f, 16.0, None);
        i.move_up(false, &f, 16.0, None);
        assert_eq!(i.cursor(), 12, "round trip returns home");
    }

    #[test]
    fn vertical_movement_at_the_edges_goes_to_doc_ends() {
        let f = font();
        let mut i = input("one\ntwo", 1);
        i.move_up(false, &f, 16.0, None);
        assert_eq!(i.cursor(), 0);
        i.set_cursor(5, false);
        i.move_down(false, &f, 16.0, None);
        assert_eq!(i.cursor(), 7);
    }

    #[test]
    fn vertical_movement_with_selection_collapses_then_moves() {
        let f = font();
        let mut i = input("one\ntwo\nthree", 5);
        i.set_cursor(2, true);
        assert_eq!(i.selection(), Some(2..5));
        i.move_down(false, &f, 16.0, None);
        assert_eq!(i.selection(), None);
        assert!(i.cursor() > 7, "moved below the selection end line");
    }

    #[test]
    fn select_all_and_collapse() {
        let mut i = input("hello", 2);
        i.select_all();
        assert_eq!(i.selected_text(), Some("hello"));
        assert!(i.collapse());
        assert_eq!(i.selection(), None);
        assert_eq!(i.cursor(), 5);
    }

    #[test]
    fn double_click_selects_the_word_under_the_point() {
        let mut i = input("foo bar baz", 0);
        i.select_word_at(5);
        assert_eq!(i.selected_text(), Some("bar"));
        i.select_word_at(7);
        assert_eq!(i.selected_text(), Some("bar"), "boundary prefers the word left of it");
        i.select_word_at(3);
        assert_eq!(i.selected_text(), Some("foo"));
    }

    #[test]
    fn triple_click_selects_the_line_with_its_newline() {
        let mut i = input("one\ntwo\nthree", 0);
        i.select_line_at(5);
        assert_eq!(i.selected_text(), Some("two\n"));
        i.select_line_at(10);
        assert_eq!(i.selected_text(), Some("three"), "last line has no newline");
    }

    #[test]
    fn handles_multibyte_chars() {
        let mut i = input("héllo", 0);
        i.move_right(Granularity::Char, false);
        i.move_right(Granularity::Char, false);
        assert_eq!(i.cursor(), 3, "é is two bytes");
        i.delete_backward(Granularity::Char);
        assert_eq!(i.text(), "hllo");
        i.set_cursor(2, false);
        assert_eq!(i.cursor(), 2);
    }

    #[test]
    fn typing_runs_undo_as_one_step_and_redo_restores_them() {
        let mut i = input("", 0);
        for c in ["h", "e", "y"] {
            i.insert(c);
        }
        assert!(i.undo());
        assert_eq!(i.text(), "", "a typing run is one undo step");
        assert_eq!(i.cursor(), 0);
        assert!(!i.undo(), "history is exhausted");
        assert!(i.redo());
        assert_eq!(i.text(), "hey");
        assert_eq!(i.cursor(), 3);
    }

    #[test]
    fn cursor_movement_seals_the_typing_group() {
        let mut i = input("", 0);
        i.insert("a");
        i.insert("b");
        i.move_left(Granularity::Char, false);
        i.move_right(Granularity::Char, false);
        i.insert("c");
        assert_eq!(i.text(), "abc");
        i.undo();
        assert_eq!(i.text(), "ab", "moving broke the group despite adjacency");
        i.undo();
        assert_eq!(i.text(), "");
    }

    #[test]
    fn enter_and_paste_are_their_own_steps() {
        let mut i = input("", 0);
        i.insert("a");
        i.insert("\n");
        i.insert("pasted text");
        i.undo();
        assert_eq!(i.text(), "a\n");
        i.undo();
        assert_eq!(i.text(), "a");
        i.undo();
        assert_eq!(i.text(), "");
    }

    #[test]
    fn backspace_runs_coalesce() {
        let mut i = input("hello", 5);
        i.delete_backward(Granularity::Char);
        i.delete_backward(Granularity::Char);
        i.delete_backward(Granularity::Char);
        assert_eq!(i.text(), "he");
        assert!(i.undo());
        assert_eq!(i.text(), "hello", "the whole run comes back at once");
        assert_eq!(i.cursor(), 5);
    }

    #[test]
    fn undo_restores_the_selection_that_was_replaced() {
        let mut i = input("hello world", 0);
        i.set_cursor(5, false);
        i.set_cursor(0, true);
        i.insert("goodbye");
        assert_eq!(i.text(), "goodbye world");
        assert!(i.undo());
        assert_eq!(i.text(), "hello world");
        assert_eq!(i.selection(), Some(0..5), "selection comes back with undo");
        assert!(i.redo());
        assert_eq!(i.text(), "goodbye world");
        assert_eq!(i.cursor(), 7);
        assert_eq!(i.selection(), None);
    }

    #[test]
    fn word_delete_is_a_single_separate_step() {
        let mut i = input("one two", 7);
        i.delete_backward(Granularity::Word);
        i.delete_backward(Granularity::Word);
        assert_eq!(i.text(), "");
        i.undo();
        assert_eq!(i.text(), "one ");
        i.undo();
        assert_eq!(i.text(), "one two");
    }

    #[test]
    fn new_edits_clear_the_redo_stack() {
        let mut i = input("", 0);
        i.insert("a");
        i.undo();
        assert!(i.can_redo());
        i.insert("b");
        assert!(!i.can_redo(), "diverging kills the redo branch");
        assert_eq!(i.text(), "b");
    }

    #[test]
    fn undo_then_typing_then_undo_round_trips() {
        let mut i = input("base", 4);
        i.insert(" one");
        i.undo();
        i.insert(" two");
        assert_eq!(i.text(), "base two");
        i.undo();
        assert_eq!(i.text(), "base");
        assert!(!i.can_undo() || {
            i.undo();
            i.text() == "base"
        });
    }

    use crate::terminal::Mods;

    fn key(k: Key, mods: Mods) -> KeyEvent {
        KeyEvent { key: k, mods }
    }

    const CTRL: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: true,
        sup: false,
    };
    const SUPER: Mods = Mods {
        shift: false,
        alt: false,
        ctrl: false,
        sup: true,
    };

    #[test]
    fn keys_drive_the_input_like_a_text_field() {
        let f = font();
        let mut i = input("one two", 7);
        assert_eq!(
            i.handle_key(key(Key::Char('a'), CTRL), &f, 16.0, None),
            InputReply::Moved
        );
        assert_eq!(i.cursor(), 0, "ctrl-a is line start, not select all");
        assert_eq!(
            i.handle_key(key(Key::Char('x'), CTRL), &f, 16.0, None),
            InputReply::None,
            "cut without a selection does nothing"
        );
        assert_eq!(
            i.handle_key(key(Key::Char('a'), SUPER), &f, 16.0, None),
            InputReply::Selected
        );
        assert_eq!(
            i.handle_key(key(Key::Char('c'), SUPER), &f, 16.0, None),
            InputReply::Copy("one two".into())
        );
        assert_eq!(
            i.handle_key(key(Key::Char('x'), SUPER), &f, 16.0, None),
            InputReply::Cut("one two".into())
        );
        assert_eq!(i.text(), "");
        assert_eq!(
            i.handle_key(key(Key::Char('z'), SUPER), &f, 16.0, None),
            InputReply::Edited
        );
        assert_eq!(i.text(), "one two");
        assert_eq!(
            i.handle_key(key(Key::Char('v'), CTRL), &f, 16.0, None),
            InputReply::RequestPaste
        );
        assert_eq!(
            i.handle_key(key(Key::Char('!'), Mods::default()), &f, 16.0, None),
            InputReply::Edited
        );
    }

    #[test]
    fn mouse_places_selects_and_drags() {
        let fonts = [font()];
        let geometry = InputGeometry {
            origin: (10.0, 5.0),
            font: 0,
            px: 16.0,
            max_width: None,
        };
        let text = "hello world";
        let mut i = input(text, 0);
        let event = |kind, button, offset: usize| {
            let (x, y) = offset_to_point(text, offset, &fonts[0], 16.0, None);
            Mouse {
                kind,
                button,
                x: (10.0 + x + 0.5) as u32,
                y: (5.0 + y + 1.0) as u32,
            }
        };

        let reply = i.handle_mouse(&event(MouseKind::Down, MouseButton::Left, 8), geometry, &fonts);
        assert_eq!(reply, InputReply::Selected);
        assert_eq!(i.cursor(), 8, "click lands the caret at the point");

        i.handle_mouse(&event(MouseKind::Move, MouseButton::Left, 2), geometry, &fonts);
        assert_eq!(i.selection(), Some(2..8), "dragging extends");

        i.handle_mouse(&event(MouseKind::Up, MouseButton::Left, 2), geometry, &fonts);
        let reply = i.handle_mouse(&event(MouseKind::Move, MouseButton::Left, 5), geometry, &fonts);
        assert_eq!(reply, InputReply::None, "no drag after release");
        assert_eq!(i.selection(), Some(2..8));

        // A second down at the first click's point within the chain window
        // is a double click: the word under it gets selected.
        i.handle_mouse(&event(MouseKind::Down, MouseButton::Left, 8), geometry, &fonts);
        assert_eq!(i.selected_text(), Some("world"));
        i.handle_mouse(&event(MouseKind::Down, MouseButton::Left, 8), geometry, &fonts);
        assert_eq!(i.selected_text(), Some("hello world"), "third click takes the line");
    }

    #[test]
    fn caret_rect_sits_at_the_offset() {
        let fonts = [font()];
        let geometry = InputGeometry {
            origin: (10.0, 5.0),
            font: 0,
            px: 16.0,
            max_width: None,
        };
        let rect = geometry.caret_rect("ab\ncd", 4, &fonts);
        let (x, y) = offset_to_point("ab\ncd", 4, &fonts[0], 16.0, None);
        assert_eq!((rect.x, rect.y), (10.0 + x, 5.0 + y));
        assert!(rect.h > 0.0 && rect.w > 0.0);
    }

    #[test]
    fn point_offset_mapping_round_trips() {
        let f = font();
        let text = "first line\nsecond\n\nlast";
        for offset in [0, 5, 10, 11, 17, 18, 19, 23] {
            let (x, y) = offset_to_point(text, offset, &f, 16.0, None);
            assert_eq!(
                point_to_offset(text, x + 0.1, y + 1.0, &f, 16.0, None),
                offset,
                "offset {offset}"
            );
        }
    }

    #[test]
    fn points_outside_the_text_clamp() {
        let f = font();
        let text = "short\nlonger line";
        assert_eq!(point_to_offset(text, -5.0, -10.0, &f, 16.0, None), 0);
        assert_eq!(point_to_offset(text, 10_000.0, 0.0, &f, 16.0, None), 5, "past line end");
        assert_eq!(
            point_to_offset(text, 10_000.0, 10_000.0, &f, 16.0, None),
            text.len(),
            "below the last line"
        );
    }

    #[test]
    fn click_right_of_a_glyphs_midpoint_lands_after_it() {
        let f = font();
        let w = measure_text(&f, "a", 16.0);
        assert_eq!(point_to_offset("abc", w * 0.4, 0.0, &f, 16.0, None), 0);
        assert_eq!(point_to_offset("abc", w * 0.6, 0.0, &f, 16.0, None), 1);
    }
}
