use std::io;
use std::time::Instant;

#[derive(Default)]
pub struct Profiler {
    recording: Option<Recording>,
}

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
        Self::default()
    }

    pub fn is_recording(&self) -> bool {
        self.recording.is_some()
    }

    /// Starts recording, or stops and writes the report, returning its path.
    pub fn toggle(&mut self) -> io::Result<Option<std::path::PathBuf>> {
        match self.recording.take() {
            None => {
                self.recording = Some(Recording {
                    started: Instant::now(),
                    frames: Vec::new(),
                });
                Ok(None)
            }
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
        }
    }

    pub fn begin_frame(&mut self) {
        if let Some(recording) = &mut self.recording {
            recording.frames.push(FrameRecord {
                at_ms: recording.started.elapsed().as_secs_f64() * 1000.0,
                ..FrameRecord::default()
            });
        }
    }

    pub fn span<T>(&mut self, name: &'static str, work: impl FnOnce() -> T) -> T {
        let start = Instant::now();
        let result = work();
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        if let Some(frame) = self.current_frame() {
            frame.spans.push((name, elapsed_ms));
        }
        result
    }

    pub fn count(&mut self, name: &'static str, value: u64) {
        if let Some(frame) = self.current_frame() {
            frame.counters.push((name, value));
        }
    }

    fn current_frame(&mut self) -> Option<&mut FrameRecord> {
        self.recording.as_mut().and_then(|r| r.frames.last_mut())
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
}
