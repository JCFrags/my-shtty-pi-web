use std::cell::RefCell;
use std::collections::HashMap;

struct Entry {
    // None caches a failed decode so a bad path isn't re-read every frame.
    pixmap: Option<tiny_skia::Pixmap>,
    last_use: u64,
}

struct Cache {
    entries: HashMap<String, Entry>,
    tick: u64,
    bytes: usize,
}

const BUDGET_BYTES: usize = 256 * 1024 * 1024;

thread_local! {
    static CACHE: RefCell<Cache> = RefCell::new(Cache {
        entries: HashMap::new(),
        tick: 0,
        bytes: 0,
    });
}

// tiny-skia composites premultiplied pixels, decoders emit straight alpha.
fn premultiply(img: &image::RgbaImage) -> Option<tiny_skia::Pixmap> {
    let (w, h) = img.dimensions();
    let mut pixmap = tiny_skia::Pixmap::new(w, h)?;
    for (dst, src) in pixmap.pixels_mut().iter_mut().zip(img.pixels()) {
        let [r, g, b, a] = src.0;
        *dst = tiny_skia::ColorU8::from_rgba(r, g, b, a).premultiply();
    }
    Some(pixmap)
}

fn decode(src: &str) -> Option<tiny_skia::Pixmap> {
    let img = image::ImageReader::open(src)
        .ok()?
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?
        .into_rgba8();
    premultiply(&img)
}

fn evict_over_budget(cache: &mut Cache, keep: &str) {
    while cache.bytes > BUDGET_BYTES {
        let Some(key) = cache
            .entries
            .iter()
            .filter(|(k, _)| k.as_str() != keep)
            .min_by_key(|(_, e)| e.last_use)
            .map(|(k, _)| k.clone())
        else {
            return;
        };
        if let Some(entry) = cache.entries.remove(&key) {
            cache.bytes -= entry.pixmap.as_ref().map_or(0, |p| p.data().len());
        }
    }
}

fn with_entry<R>(src: &str, f: impl FnOnce(&tiny_skia::Pixmap) -> R) -> Option<R> {
    CACHE.with_borrow_mut(|cache| {
        cache.tick += 1;
        let tick = cache.tick;
        if !cache.entries.contains_key(src) {
            let pixmap = decode(src);
            cache.bytes += pixmap.as_ref().map_or(0, |p| p.data().len());
            cache.entries.insert(
                src.to_string(),
                Entry {
                    pixmap,
                    last_use: tick,
                },
            );
            evict_over_budget(cache, src);
        }
        let entry = cache.entries.get_mut(src)?;
        entry.last_use = tick;
        entry.pixmap.as_ref().map(f)
    })
}

pub(crate) fn image_size(src: &str) -> Option<(u32, u32)> {
    with_entry(src, |p| (p.width(), p.height()))
}

pub(crate) fn with_image<R>(src: &str, f: impl FnOnce(tiny_skia::PixmapRef<'_>) -> R) -> Option<R> {
    with_entry(src, |p| f(p.as_ref()))
}

pub(crate) fn insert_decoded(src: String, img: &image::RgbaImage) {
    let Some(pixmap) = premultiply(img) else {
        return;
    };
    CACHE.with_borrow_mut(|cache| {
        cache.tick += 1;
        let tick = cache.tick;
        if let Some(old) = cache.entries.remove(&src) {
            cache.bytes -= old.pixmap.as_ref().map_or(0, |p| p.data().len());
        }
        cache.bytes += pixmap.data().len();
        cache.entries.insert(
            src.clone(),
            Entry {
                pixmap: Some(pixmap),
                last_use: tick,
            },
        );
        evict_over_budget(cache, &src);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checker(w: u32, h: u32) -> image::RgbaImage {
        image::RgbaImage::from_fn(w, h, |x, y| {
            if (x + y) % 2 == 0 {
                image::Rgba([255, 0, 0, 255])
            } else {
                image::Rgba([0, 0, 255, 128])
            }
        })
    }

    #[test]
    fn decodes_once_and_reports_size() {
        let dir = std::env::temp_dir().join("pixel-image-cache-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("checker.png");
        checker(4, 2).save(&path).unwrap();
        let src = path.to_string_lossy().to_string();
        assert_eq!(image_size(&src), Some((4, 2)));
        std::fs::remove_file(&path).unwrap();
        // Still cached after the file is gone.
        assert_eq!(image_size(&src), Some((4, 2)));
    }

    #[test]
    fn missing_file_caches_the_failure() {
        assert_eq!(image_size("/nonexistent/nope.png"), None);
        assert_eq!(image_size("/nonexistent/nope.png"), None);
    }

    #[test]
    fn insert_decoded_serves_without_a_file() {
        let img = checker(3, 3);
        insert_decoded("mem://test".into(), &img);
        assert_eq!(image_size("mem://test"), Some((3, 3)));
        let alpha_seen = with_image("mem://test", |p| p.pixels().iter().any(|px| px.alpha() < 255));
        assert_eq!(alpha_seen, Some(true));
    }
}
