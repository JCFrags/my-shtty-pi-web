use std::time::{Duration, Instant};

use crate::native::{NativeDelta, PHASE_BEGAN};

const PAIR_WINDOW: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, PartialEq)]
enum Gesture {
    Idle,
    Undecided { since: Instant },
    Paired,
    Dropped,
}

pub(super) struct NativePairing {
    gesture: Gesture,
    buffer: Vec<(f32, f32)>,
    ready: Vec<(f32, f32)>,
    zoom: f32,
}

impl NativePairing {
    pub fn new() -> Self {
        Self {
            gesture: Gesture::Idle,
            buffer: Vec::new(),
            ready: Vec::new(),
            zoom: 1.0,
        }
    }

    pub fn ingest(&mut self, deltas: Vec<NativeDelta>, scale: f32, now: Instant) {
        for delta in deltas {
            match delta {
                NativeDelta::Zoom { magnification } => {
                    self.zoom *= 1.0 + magnification;
                }
                NativeDelta::Scroll {
                    delta_x,
                    delta_y,
                    precise,
                    phase,
                    ..
                } => {
                    if !precise {
                        continue;
                    }
                    if phase & PHASE_BEGAN != 0 {
                        self.buffer.clear();
                        self.gesture = Gesture::Undecided { since: now };
                    }
                    let px = (delta_x * scale, delta_y * scale);
                    match self.gesture {
                        Gesture::Idle => {
                            self.gesture = Gesture::Undecided { since: now };
                            self.buffer.push(px);
                        }
                        Gesture::Undecided { .. } => self.buffer.push(px),
                        Gesture::Paired => self.ready.push(px),
                        Gesture::Dropped => {}
                    }
                }
            }
        }
        if let Gesture::Undecided { since } = self.gesture
            && now.duration_since(since) > PAIR_WINDOW
        {
            self.gesture = Gesture::Dropped;
            self.buffer.clear();
        }
    }

    pub fn on_wheel_tick(&mut self) -> bool {
        match self.gesture {
            Gesture::Undecided { .. } => {
                self.gesture = Gesture::Paired;
                self.ready.append(&mut self.buffer);
                true
            }
            Gesture::Paired => true,
            Gesture::Dropped => {
                self.gesture = Gesture::Paired;
                false
            }
            Gesture::Idle => false,
        }
    }

    pub fn take(&mut self) -> (f32, Vec<(f32, f32)>) {
        (
            std::mem::replace(&mut self.zoom, 1.0),
            std::mem::take(&mut self.ready),
        )
    }

    pub fn reset(&mut self) {
        self.gesture = Gesture::Idle;
        self.buffer.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scroll(delta_y: f32, phase: u32) -> NativeDelta {
        NativeDelta::Scroll {
            delta_x: 0.0,
            delta_y,
            precise: true,
            phase,
            momentum: 0,
        }
    }

    #[test]
    fn tick_pairs_gesture_and_flushes_buffer() {
        let mut pairing = NativePairing::new();
        let now = Instant::now();
        pairing.ingest(vec![scroll(3.0, PHASE_BEGAN), scroll(2.0, 0)], 1.0, now);
        assert_eq!(pairing.take().1, Vec::<(f32, f32)>::new());

        assert!(pairing.on_wheel_tick());
        assert_eq!(pairing.take().1, vec![(0.0, 3.0), (0.0, 2.0)]);

        pairing.ingest(vec![scroll(1.0, 0)], 1.0, now);
        assert!(pairing.on_wheel_tick());
        assert_eq!(pairing.take().1, vec![(0.0, 1.0)]);
    }

    #[test]
    fn unpaired_gesture_expires_and_is_dropped() {
        let mut pairing = NativePairing::new();
        let start = Instant::now();
        pairing.ingest(vec![scroll(3.0, PHASE_BEGAN)], 1.0, start);
        let late = start + PAIR_WINDOW + Duration::from_millis(1);
        pairing.ingest(vec![scroll(2.0, 0)], 1.0, late);
        pairing.ingest(vec![scroll(2.0, 0)], 1.0, late);
        assert_eq!(pairing.take().1, Vec::<(f32, f32)>::new());
    }

    #[test]
    fn tick_after_drop_scrolls_itself_then_rides_stream() {
        let mut pairing = NativePairing::new();
        let start = Instant::now();
        pairing.ingest(vec![scroll(3.0, PHASE_BEGAN)], 1.0, start);
        pairing.ingest(Vec::new(), 1.0, start + PAIR_WINDOW + Duration::from_millis(1));

        assert!(!pairing.on_wheel_tick());
        pairing.ingest(vec![scroll(2.0, 0)], 1.0, start + PAIR_WINDOW + Duration::from_millis(2));
        assert_eq!(pairing.take().1, vec![(0.0, 2.0)]);
    }

    #[test]
    fn imprecise_deltas_are_ignored() {
        let mut pairing = NativePairing::new();
        let now = Instant::now();
        pairing.ingest(
            vec![NativeDelta::Scroll {
                delta_x: 0.0,
                delta_y: 5.0,
                precise: false,
                phase: PHASE_BEGAN,
                momentum: 0,
            }],
            1.0,
            now,
        );
        assert!(!pairing.on_wheel_tick());
    }

    #[test]
    fn zoom_accumulates_multiplicatively_and_scale_applies_to_deltas() {
        let mut pairing = NativePairing::new();
        let now = Instant::now();
        pairing.ingest(
            vec![
                NativeDelta::Zoom { magnification: 0.5 },
                NativeDelta::Zoom { magnification: 0.5 },
                scroll(2.0, PHASE_BEGAN),
            ],
            2.0,
            now,
        );
        assert!(pairing.on_wheel_tick());
        let (zoom, scrolls) = pairing.take();
        assert_eq!(zoom, 2.25);
        assert_eq!(scrolls, vec![(0.0, 4.0)]);
        assert_eq!(pairing.take().0, 1.0);
    }
}
