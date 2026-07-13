use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, PartialEq)]
pub struct PastedImage {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn temp_path() -> PathBuf {
    let dir = std::env::temp_dir().join("pixel-attachments");
    let _ = std::fs::create_dir_all(&dir);
    let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    dir.join(format!("paste-{}-{n}.png", std::process::id()))
}

fn dims(path: &Path) -> Option<(u32, u32)> {
    image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

fn from_file(path: &Path) -> Option<PastedImage> {
    let (width, height) = dims(path)?;
    Some(PastedImage {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
    })
}

/// Copying in Finder puts file paths on the clipboard; browsers and
/// screenshot tools put bitmap data. Prefer files, fall back to bitmap.
/// Runs on the engine thread: the read/downscale/encode spans are what a
/// paste-triggered frame stall looks like in a profile.
pub fn read_clipboard_image() -> Option<PastedImage> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    if let Ok(files) = clipboard.get().file_list()
        && let Some(pasted) = files.iter().find_map(|f| from_file(f))
    {
        return Some(pasted);
    }
    let img = crate::profiler::span("clipboard.image.read", || clipboard.get_image()).ok()?;
    let rgba = image::RgbaImage::from_raw(
        img.width as u32,
        img.height as u32,
        img.bytes.into_owned(),
    )?;
    let rgba = crate::profiler::span("clipboard.image.downscale", || downscale(rgba));
    let (width, height) = rgba.dimensions();
    let path = temp_path();
    crate::profiler::span("clipboard.image.encode", || rgba.save(&path)).ok()?;
    let src = path.to_string_lossy().into_owned();
    crate::image_cache::insert_decoded(src.clone(), &rgba);
    Some(PastedImage {
        path: src,
        width,
        height,
    })
}

// Retina screenshots easily exceed model input limits and cost tokens for
// detail vision models discard anyway.
const MAX_EDGE: u32 = 2000;

fn downscale(rgba: image::RgbaImage) -> image::RgbaImage {
    let (w, h) = rgba.dimensions();
    let edge = w.max(h);
    if edge <= MAX_EDGE {
        return rgba;
    }
    let scale = MAX_EDGE as f32 / edge as f32;
    image::imageops::resize(
        &rgba,
        ((w as f32 * scale) as u32).max(1),
        ((h as f32 * scale) as u32).max(1),
        image::imageops::FilterType::Triangle,
    )
}

/// Dropping a file on the terminal pastes its path as text, shell-escaped or
/// quoted or as a file:// URL depending on the terminal.
pub fn image_path_from_paste(text: &str) -> Option<PastedImage> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.contains('\n') {
        return None;
    }
    let unquoted = trimmed.trim_matches(|c| c == '\'' || c == '"');
    let path = match unquoted.strip_prefix("file://") {
        Some(rest) => percent_decode(rest),
        None => unescape(unquoted),
    };
    if !path.starts_with('/') && !path.starts_with('~') {
        return None;
    }
    let path = match path.strip_prefix("~/") {
        Some(rest) => Path::new(&std::env::var("HOME").ok()?).join(rest),
        None => PathBuf::from(path),
    };
    if !path.is_file() {
        return None;
    }
    from_file(&path)
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let decoded = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| u8::from_str_radix(&s[i + 1..i + 3], 16).ok())
            .flatten();
        match decoded {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_png(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("pixel-clipboard-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        image::RgbaImage::from_pixel(6, 4, image::Rgba([1, 2, 3, 255]))
            .save(&path)
            .unwrap();
        path
    }

    #[test]
    fn plain_path_paste_detects_an_image() {
        let path = temp_png("plain.png");
        let pasted = image_path_from_paste(&path.to_string_lossy()).unwrap();
        assert_eq!((pasted.width, pasted.height), (6, 4));
    }

    #[test]
    fn quoted_and_escaped_paths_normalize() {
        let path = temp_png("with space.png");
        let raw = path.to_string_lossy();
        assert!(image_path_from_paste(&format!("'{raw}'")).is_some());
        assert!(image_path_from_paste(&raw.replace(' ', "\\ ")).is_some());
    }

    #[test]
    fn file_urls_percent_decode() {
        let path = temp_png("url space.png");
        let url = format!("file://{}", path.to_string_lossy().replace(' ', "%20"));
        assert!(image_path_from_paste(&url).is_some());
    }

    #[test]
    fn ordinary_text_is_not_a_path() {
        assert!(image_path_from_paste("hello world").is_none());
        assert!(image_path_from_paste("/does/not/exist.png").is_none());
        assert!(image_path_from_paste("one\n/two.png").is_none());
    }

    #[test]
    fn non_image_files_are_rejected() {
        let dir = std::env::temp_dir().join("pixel-clipboard-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.txt");
        std::fs::write(&path, "just text").unwrap();
        assert!(image_path_from_paste(&path.to_string_lossy()).is_none());
    }
}
