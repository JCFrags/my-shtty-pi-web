use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImageStatus {
    Pending,
    Ready,
    Failed,
}

enum State {
    Pending { queued: Instant, seq: u64 },
    Ready(tiny_skia::Pixmap),
    Failed,
}

// Width, height, and the corner radii baked into the variant's alpha.
type ScaledKey = (u32, u32, [u32; 4]);

struct Entry {
    dims: Option<(u32, u32)>,
    state: State,
    scaled: HashMap<ScaledKey, tiny_skia::Pixmap>,
    last_use: u64,
}

type WakerFn = Box<dyn Fn() + Send>;

struct Job {
    src: String,
    queued: Instant,
    seq: u64,
}

struct DecodeResult {
    src: String,
    pixmap: Option<tiny_skia::Pixmap>,
    queued: Instant,
    started: Instant,
    finished: Instant,
    attempts: u32,
    seq: u64,
}

struct Cache {
    entries: HashMap<String, Entry>,
    tick: u64,
    bytes: usize,
    next_seq: u64,
    jobs: Option<Sender<Job>>,
    results: Option<Receiver<DecodeResult>>,
    waker: Arc<Mutex<Option<WakerFn>>>,
}

const BUDGET_BYTES: usize = 256 * 1024 * 1024;

thread_local! {
    static CACHE: RefCell<Cache> = RefCell::new(Cache {
        entries: HashMap::new(),
        tick: 0,
        bytes: 0,
        next_seq: 0,
        jobs: None,
        results: None,
        waker: Arc::new(Mutex::new(None)),
    });
}

fn basename(src: &str) -> &str {
    src.rsplit('/').next().unwrap_or(src)
}

fn premultiply(img: &image::RgbaImage) -> Option<tiny_skia::Pixmap> {
    let (w, h) = img.dimensions();
    /*
      oh more tiny skia things, whats apixel map?


     */
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
        /*
          fine actually, i wonder if this is ever an expensive traversal vs sniffing metadata
         */
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?
        .into_rgba8();
    premultiply(&img)
}

// Reads only the header, so layout can know the size before the decode lands.
fn sniff_dims(src: &str) -> Option<(u32, u32)> {
    image::ImageReader::open(src)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

// Apps sometimes set src moments before the file finishes writing, so a
// failed decode retries briefly before the failure sticks.
const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_millis(100),
    Duration::from_millis(300),
    Duration::from_millis(900),
];

fn decode_with_retries(src: &str) -> (Option<tiny_skia::Pixmap>, u32) {
    let mut attempts = 0;
    for delay in RETRY_DELAYS {
        attempts += 1;
        if let Some(pixmap) = decode(src) {
            return (Some(pixmap), attempts);
        }
        std::thread::sleep(delay);
    }
    (decode(src), attempts + 1)
}

fn decode_worker(
    jobs: Receiver<Job>,
    results: Sender<DecodeResult>,
    waker: Arc<Mutex<Option<WakerFn>>>,
) {
    for job in jobs {
        let started = Instant::now();
        let (pixmap, attempts) = decode_with_retries(&job.src);
        let result = DecodeResult {
            src: job.src,
            pixmap,
            queued: job.queued,
            started,
            finished: Instant::now(),
            attempts,
            seq: job.seq,
        };
        if results.send(result).is_err() {
            return;
        }
        if let Some(wake) = waker.lock().unwrap().as_ref() {
            wake();
        }
    }
}

fn jobs_sender(cache: &mut Cache) -> &Sender<Job> {
    if cache.jobs.is_none() {
        let (jobs_tx, jobs_rx) = channel();
        let (results_tx, results_rx) = channel();
        let waker = cache.waker.clone();
        std::thread::Builder::new()
            .name("pixel-image-decode".into())
            .spawn(move || decode_worker(jobs_rx, results_tx, waker))
            .expect("spawn image decode worker");
        cache.jobs = Some(jobs_tx);
        cache.results = Some(results_rx);
    }
    cache.jobs.as_ref().expect("jobs sender just created")
}

fn ensure(cache: &mut Cache, src: &str) {
    cache.tick += 1;
    let tick = cache.tick;
    if let Some(entry) = cache.entries.get_mut(src) {
        entry.last_use = tick;
        return;
    }
    let dims = crate::profiler::span_labeled(
        "image.sniff",
        || basename(src).to_string(),
        || sniff_dims(src),
    );
    let queued = Instant::now();
    cache.next_seq += 1;
    let seq = cache.next_seq;
    let _ = jobs_sender(cache).send(Job {
        src: src.to_string(),
        queued,
        seq,
    });
    cache.entries.insert(
        src.to_string(),
        Entry {
            dims,
            state: State::Pending { queued, seq },
            scaled: HashMap::new(),
            last_use: tick,
        },
    );
}

fn entry_bytes(entry: &Entry) -> usize {
    let full = match &entry.state {
        State::Ready(pixmap) => pixmap.data().len(),
        _ => 0,
    };
    full + entry.scaled.values().map(|p| p.data().len()).sum::<usize>()
}

fn evict_over_budget(cache: &mut Cache, keep: &str) {
    while cache.bytes > BUDGET_BYTES {
        let Some(key) = cache
            .entries
            .iter()
            .filter(|(k, e)| k.as_str() != keep && matches!(e.state, State::Ready(_)))
            .min_by_key(|(_, e)| e.last_use)
            .map(|(k, _)| k.clone())
        else {
            return;
        };
        if let Some(entry) = cache.entries.remove(&key) {
            cache.bytes -= entry_bytes(&entry);
        }
    }
}

pub(crate) fn status(src: &str) -> ImageStatus {
    CACHE.with_borrow_mut(|cache| {
        ensure(cache, src);
        match cache.entries[src].state {
            State::Pending { .. } => ImageStatus::Pending,
            State::Ready(_) => ImageStatus::Ready,
            State::Failed => ImageStatus::Failed,
        }
    })
}

pub(crate) fn image_size(src: &str) -> Option<(u32, u32)> {
    CACHE.with_borrow_mut(|cache| {
        ensure(cache, src);
        cache.entries[src].dims
    })
}

// Full-resolution pixels; painting goes through with_scaled_image instead.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn with_image<R>(src: &str, f: impl FnOnce(tiny_skia::PixmapRef<'_>) -> R) -> Option<R> {
    CACHE.with_borrow_mut(|cache| {
        ensure(cache, src);
        match &cache.entries[src].state {
            State::Ready(pixmap) => Some(f(pixmap.as_ref())),
            _ => None,
        }
    })
}

// Resample once per (size, radius) so per-frame drawing is a plain blit; the
// corner radii are baked into the variant's alpha.
fn make_scaled(
    full: tiny_skia::PixmapRef<'_>,
    w: u32,
    h: u32,
    radius: [f32; 4],
) -> Option<tiny_skia::Pixmap> {
    let mut out = tiny_skia::Pixmap::new(w, h)?;
    let path = crate::canvas::rounded_rect_path(0.0, 0.0, w as f32, h as f32, radius)?;
    let to_rect = tiny_skia::Transform::from_row(
        w as f32 / full.width() as f32,
        0.0,
        0.0,
        h as f32 / full.height() as f32,
        0.0,
        0.0,
    );
    let mut paint = tiny_skia::Paint {
        shader: tiny_skia::Pattern::new(
            full,
            tiny_skia::SpreadMode::Pad,
            tiny_skia::FilterQuality::Bilinear,
            1.0,
            to_rect,
        ),
        ..tiny_skia::Paint::default()
    };
    paint.anti_alias = true;
    out.as_mut().fill_path(
        &path,
        &paint,
        tiny_skia::FillRule::Winding,
        tiny_skia::Transform::identity(),
        None,
    );
    Some(out)
}

pub(crate) fn with_scaled_image<R>(
    src: &str,
    w: u32,
    h: u32,
    radius: [f32; 4],
    f: impl FnOnce(tiny_skia::PixmapRef<'_>) -> R,
) -> Option<R> {
    if w == 0 || h == 0 {
        return None;
    }
    CACHE.with_borrow_mut(|cache| {
        ensure(cache, src);
        let key = (w, h, radius.map(f32::to_bits));
        let entry = cache.entries.get(src)?;
        if !matches!(entry.state, State::Ready(_)) {
            return None;
        }
        if !entry.scaled.contains_key(&key) {
            let scaled = {
                let State::Ready(full) = &entry.state else {
                    return None;
                };
                crate::profiler::span_labeled(
                    "image.scale",
                    || format!("{} → {w}×{h}", basename(src)),
                    || make_scaled(full.as_ref(), w, h, radius),
                )?
            };
            cache.bytes += scaled.data().len();
            cache.entries.get_mut(src)?.scaled.insert(key, scaled);
            evict_over_budget(cache, src);
        }
        let entry = cache.entries.get(src)?;
        Some(f(entry.scaled[&key].as_ref()))
    })
}

pub(crate) fn insert_decoded(src: String, img: &image::RgbaImage) {
    let Some(pixmap) = crate::profiler::span_labeled(
        "image.premultiply",
        || basename(&src).to_string(),
        || premultiply(img),
    ) else {
        return;
    };
    CACHE.with_borrow_mut(|cache| {
        cache.tick += 1;
        let tick = cache.tick;
        if let Some(old) = cache.entries.remove(&src) {
            cache.bytes -= entry_bytes(&old);
        }
        cache.bytes += pixmap.data().len();
        cache.entries.insert(
            src.clone(),
            Entry {
                dims: Some((pixmap.width(), pixmap.height())),
                state: State::Ready(pixmap),
                scaled: HashMap::new(),
                last_use: tick,
            },
        );
        evict_over_budget(cache, &src);
    });
}

// The wake closure runs on the decode worker thread whenever a result is
// ready; it should interrupt whatever the calling thread blocks on.
pub(crate) fn set_waker(wake: impl Fn() + Send + 'static) {
    CACHE.with_borrow_mut(|cache| {
        *cache.waker.lock().unwrap() = Some(Box::new(wake));
    });
}

#[derive(Default)]
pub(crate) struct Landed {
    pub any: bool,
    pub resized: bool,
}

pub(crate) fn drain_completed() -> Landed {
    CACHE.with_borrow_mut(|cache| {
        let mut landed = Landed::default();
        let completed: Vec<DecodeResult> = match &cache.results {
            Some(results) => results.try_iter().collect(),
            None => return landed,
        };
        for result in completed {
            let src = result.src.clone();
            let Some(entry) = cache.entries.get_mut(&src) else {
                continue;
            };
            // insert_decoded can win the race; its pixels are fresher.
            if matches!(entry.state, State::Ready(_)) {
                continue;
            }
            landed.any = true;
            emit_lifecycle(&result);
            match result.pixmap {
                Some(pixmap) => {
                    let dims = (pixmap.width(), pixmap.height());
                    if entry.dims != Some(dims) {
                        entry.dims = Some(dims);
                        landed.resized = true;
                    }
                    cache.bytes += pixmap.data().len();
                    entry.state = State::Ready(pixmap);
                    evict_over_budget(cache, &src);
                }
                None => entry.state = State::Failed,
            }
        }
        landed
    })
}

// The wait span covers enqueue → visible (this drain); the decode span is the
// worker's part, including its brief file-appearance retries.
fn emit_lifecycle(result: &DecodeResult) {
    let Some(now) = crate::profiler::now_ms() else {
        return;
    };
    let queued = crate::profiler::ms_of(result.queued).unwrap_or(0.0);
    let started = crate::profiler::ms_of(result.started).unwrap_or(0.0);
    let decode_ms = result
        .finished
        .saturating_duration_since(result.started)
        .as_secs_f64()
        * 1000.0;
    let name = basename(&result.src);
    let outcome = match &result.pixmap {
        Some(p) => format!("{}×{}", p.width(), p.height()),
        None => "failed".to_string(),
    };
    let tries = if result.attempts > 1 {
        format!(", {} tries", result.attempts)
    } else {
        String::new()
    };
    crate::profiler::emit_span(
        "image.wait",
        queued,
        now - queued,
        0,
        Some(result.seq),
        Some(format!("{name} ({outcome}{tries})")),
    );
    crate::profiler::emit_span(
        "image.decode",
        started,
        decode_ms,
        1,
        Some(result.seq),
        Some(name.to_string()),
    );
}

// Called when a recording stops so images still in flight show up as
// open-ended waits instead of disappearing from the profile.
pub(crate) fn emit_pending_waits() {
    CACHE.with_borrow(|cache| {
        let Some(now) = crate::profiler::now_ms() else {
            return;
        };
        for (src, entry) in &cache.entries {
            if let State::Pending { queued, seq } = entry.state {
                let start = crate::profiler::ms_of(queued).unwrap_or(0.0);
                crate::profiler::emit_span(
                    "image.wait",
                    start,
                    now - start,
                    0,
                    Some(seq),
                    Some(format!("{} (still decoding)", basename(src))),
                );
            }
        }
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

    fn drain_until_landed() -> Landed {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let landed = drain_completed();
            if landed.any {
                return landed;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "decode never completed"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn size_is_known_before_decode_and_survives_deletion() {
        let dir = std::env::temp_dir().join("pixel-image-cache-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("checker.png");
        checker(4, 2).save(&path).unwrap();
        let src = path.to_string_lossy().to_string();
        assert_eq!(image_size(&src), Some((4, 2)));
        drain_until_landed();
        std::fs::remove_file(&path).unwrap();
        // Still cached after the file is gone.
        assert_eq!(image_size(&src), Some((4, 2)));
        assert_eq!(status(&src), ImageStatus::Ready);
    }

    #[test]
    fn decode_is_async_and_lands_via_drain() {
        let dir = std::env::temp_dir().join("pixel-image-cache-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("async.png");
        checker(3, 3).save(&path).unwrap();
        let src = path.to_string_lossy().to_string();
        assert_eq!(status(&src), ImageStatus::Pending);
        assert!(with_image(&src, |_| ()).is_none());
        drain_until_landed();
        assert_eq!(status(&src), ImageStatus::Ready);
        let alpha_seen = with_image(&src, |p| p.pixels().iter().any(|px| px.alpha() < 255));
        assert_eq!(alpha_seen, Some(true));
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn missing_file_fails_after_retries() {
        let src = "/nonexistent/nope.png";
        assert_eq!(image_size(src), None);
        assert_eq!(status(src), ImageStatus::Pending);
        drain_until_landed();
        assert_eq!(status(src), ImageStatus::Failed);
        assert_eq!(image_size(src), None);
    }

    #[test]
    fn drain_emits_lifecycle_spans_while_recording() {
        let dir = std::env::temp_dir().join("pixel-image-cache-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("profiled.png");
        checker(5, 4).save(&path).unwrap();
        let src = path.to_string_lossy().to_string();
        crate::profiler::start();
        assert_eq!(status(&src), ImageStatus::Pending);
        drain_until_landed();
        emit_pending_waits();
        let data = crate::profiler::stop().unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(data.spans.iter().any(|s| s.name == "image.sniff"));
        let wait = data
            .spans
            .iter()
            .find(|s| s.name == "image.wait")
            .expect("wait span");
        let label = wait.label.as_deref().expect("wait label");
        assert!(label.contains("profiled.png") && label.contains("5×4"), "{label}");
        let decode = data
            .spans
            .iter()
            .find(|s| s.name == "image.decode")
            .expect("decode span");
        assert_eq!(decode.arg, wait.arg);
        assert!(wait.dur_ms >= decode.dur_ms);
        // The image landed, so nothing should report as still decoding.
        assert!(!data.spans.iter().any(|s| {
            s.label.as_deref().is_some_and(|l| l.contains("still decoding"))
        }));
    }

    #[test]
    fn stopping_a_recording_reports_in_flight_images() {
        let src = "/nonexistent/slow.png";
        crate::profiler::start();
        assert_eq!(status(src), ImageStatus::Pending);
        emit_pending_waits();
        let data = crate::profiler::stop().unwrap();
        let wait = data
            .spans
            .iter()
            .find(|s| s.name == "image.wait")
            .expect("pending wait span");
        assert!(
            wait.label.as_deref().unwrap().contains("still decoding"),
            "{:?}",
            wait.label
        );
    }

    #[test]
    fn scaled_variants_serve_at_the_requested_size() {
        let img = image::RgbaImage::from_pixel(8, 4, image::Rgba([10, 220, 30, 255]));
        insert_decoded("mem://scaled".into(), &img);
        let size = with_scaled_image("mem://scaled", 4, 2, [0.0; 4], |p| {
            (p.width(), p.height(), p.pixels()[0].green())
        });
        assert_eq!(size, Some((4, 2, 220)));
        // Radius is baked into the variant's corner alpha.
        let corner = with_scaled_image("mem://scaled", 8, 8, [4.0; 4], |p| p.pixels()[0].alpha());
        assert_eq!(corner, Some(0));
        assert!(with_scaled_image("mem://scaled", 0, 2, [0.0; 4], |_| ()).is_none());
        assert!(with_scaled_image("mem://missing-entirely", 4, 2, [0.0; 4], |_| ()).is_none());
    }

    #[test]
    fn insert_decoded_serves_without_a_file() {
        let img = checker(3, 3);
        insert_decoded("mem://test".into(), &img);
        assert_eq!(image_size("mem://test"), Some((3, 3)));
        assert_eq!(status("mem://test"), ImageStatus::Ready);
        let alpha_seen = with_image("mem://test", |p| p.pixels().iter().any(|px| px.alpha() < 255));
        assert_eq!(alpha_seen, Some(true));
    }
}
