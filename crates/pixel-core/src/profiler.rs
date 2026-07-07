use std::cell::RefCell;
use std::io;
use std::time::Instant;

// Thread-local so engine internals can record spans without every function
// threading a profiler reference through its signature.
thread_local! {
    static ACTIVE: RefCell<Option<Recording>> = const { RefCell::new(None) };
}

/// Runs `work`, recording its duration in the current frame of the active
/// recording (no-op when not recording). Nested spans each get their own row.
pub fn span<T>(name: &'static str, work: impl FnOnce() -> T) -> T {
    if !is_recording() {
        return work();
    }
    let start = Instant::now();
    let result = work();
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    with_current_frame(|frame| frame.spans.push((name, elapsed_ms)));
    result
}

pub fn count(name: &'static str, value: u64) {
    with_current_frame(|frame| frame.counters.push((name, value)));
}

pub fn is_recording() -> bool {
    ACTIVE.with(|active| active.borrow().is_some())
}

fn with_current_frame(update: impl FnOnce(&mut FrameRecord)) {
    ACTIVE.with(|active| {
        if let Some(recording) = active.borrow_mut().as_mut()
            && let Some(frame) = recording.frames.last_mut()
        {
            update(frame);
        }
    });
}

#[derive(Default)]
pub struct Profiler;

struct Recording {
    started: Instant,
    frames: Vec<FrameRecord>,
}

#[derive(Default)]
struct FrameRecord {
    at_ms: f64,
    spans: Vec<(&'static str, f64)>,
    counters: Vec<(&'static str, u64)>,
}

impl Profiler {
    pub fn new() -> Self {
        Self
    }

    pub fn is_recording(&self) -> bool {
        is_recording()
    }

    /// Starts recording, or stops and writes the report, returning its path.
    pub fn toggle(&mut self) -> io::Result<Option<std::path::PathBuf>> {
        let stopped = ACTIVE.with(|active| active.borrow_mut().take());
        match stopped {
            Some(recording) => {
                std::fs::create_dir_all("profiles")?;
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(io::Error::other)?
                    .as_secs();
                let path = std::path::PathBuf::from(format!("profiles/profile-{stamp}.json"));
                std::fs::write(&path, report_json(&recording.frames))?;
                Ok(Some(path))
            }
            None => {
                ACTIVE.with(|active| {
                    *active.borrow_mut() = Some(Recording {
                        started: Instant::now(),
                        frames: Vec::new(),
                    });
                });
                Ok(None)
            }
        }
    }

    pub fn begin_frame(&mut self) {
        ACTIVE.with(|active| {
            if let Some(recording) = active.borrow_mut().as_mut() {
                recording.frames.push(FrameRecord {
                    at_ms: recording.started.elapsed().as_secs_f64() * 1000.0,
                    ..FrameRecord::default()
                });
            }
        });
    }

    pub fn span<T>(&mut self, name: &'static str, work: impl FnOnce() -> T) -> T {
        span(name, work)
    }

    pub fn count(&mut self, name: &'static str, value: u64) {
        count(name, value);
    }
}

fn report_json(frames: &[FrameRecord]) -> String {
    let mut span_stats: Vec<(&str, Vec<f64>)> = Vec::new();
    let mut counter_stats: Vec<(&str, Vec<u64>)> = Vec::new();
    for frame in frames {
        for &(name, ms) in &frame.spans {
            match span_stats.iter_mut().find(|(n, _)| *n == name) {
                Some((_, values)) => values.push(ms),
                None => span_stats.push((name, vec![ms])),
            }
        }
        for &(name, value) in &frame.counters {
            match counter_stats.iter_mut().find(|(n, _)| *n == name) {
                Some((_, values)) => values.push(value),
                None => counter_stats.push((name, vec![value])),
            }
        }
    }

    let mut out = String::from("{\n  \"summary\": {\n    \"frames\": ");
    out.push_str(&frames.len().to_string());
    for (name, values) in &span_stats {
        let total: f64 = values.iter().sum();
        let max = values.iter().cloned().fold(0.0f64, f64::max);
        out.push_str(&format!(
            ",\n    \"{name}\": {{\"total_ms\": {total:.3}, \"mean_ms\": {:.3}, \"max_ms\": {max:.3}}}",
            total / values.len() as f64
        ));
    }
    for (name, values) in &counter_stats {
        let total: u64 = values.iter().sum();
        let max = values.iter().max().copied().unwrap_or(0);
        out.push_str(&format!(
            ",\n    \"{name}\": {{\"total\": {total}, \"mean\": {:.1}, \"max\": {max}}}",
            total as f64 / values.len() as f64
        ));
    }
    out.push_str("\n  },\n  \"frames\": [\n");
    for (i, frame) in frames.iter().enumerate() {
        out.push_str(&format!("    {{\"at_ms\": {:.3}", frame.at_ms));
        for &(name, ms) in &frame.spans {
            out.push_str(&format!(", \"{name}_ms\": {ms:.3}"));
        }
        for &(name, value) in &frame.counters {
            out.push_str(&format!(", \"{name}\": {value}"));
        }
        out.push_str(if i + 1 == frames.len() { "}\n" } else { "},\n" });
    }
    out.push_str("  ]\n}\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiler_report_includes_frames_and_summary() {
        let frames = vec![
            FrameRecord {
                at_ms: 0.0,
                spans: vec![("render", 2.0), ("draw", 10.0)],
                counters: vec![("bytes", 1000)],
            },
            FrameRecord {
                at_ms: 5.0,
                spans: vec![("render", 4.0), ("draw", 20.0)],
                counters: vec![("bytes", 3000)],
            },
        ];
        let json = report_json(&frames);
        assert!(json.contains("\"frames\": 2"));
        assert!(
            json.contains(
                "\"render\": {\"total_ms\": 6.000, \"mean_ms\": 3.000, \"max_ms\": 4.000}"
            )
        );
        assert!(json.contains("\"bytes\": {\"total\": 4000, \"mean\": 2000.0, \"max\": 3000}"));
        assert!(json.contains(
            "{\"at_ms\": 5.000, \"render_ms\": 4.000, \"draw_ms\": 20.000, \"bytes\": 3000}"
        ));
    }

    #[test]
    fn free_spans_record_into_active_frames() {
        let mut profiler = Profiler::new();
        assert_eq!(span("idle", || 7), 7);

        profiler.toggle().ok();
        profiler.begin_frame();
        span("work", || {
            std::thread::sleep(std::time::Duration::from_millis(1))
        });
        count("items", 3);

        let captured = ACTIVE.with(|active| {
            let recording = active.borrow_mut().take().unwrap();
            recording.frames
        });
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].spans[0].0, "work");
        assert!(captured[0].spans[0].1 >= 1.0);
        assert_eq!(captured[0].counters[0], ("items", 3));
    }
}
