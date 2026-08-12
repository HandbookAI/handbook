//! Emits a point once a window is full, and never before.

use crate::window::{Aggregation, Fold, Point, Window};

/// Why a rollup produced nothing. Reported rather than collapsed into `None`,
/// so a caller can tell "not enough data yet" from "the fold refused".
pub enum Pending {
    NotFull,
    Refused,
}

pub struct Rollup {
    metric: String,
    window: Window,
    how: Aggregation,
}

impl Rollup {
    pub fn new(metric: &str, capacity: usize, how: Aggregation) -> Self {
        Rollup { metric: metric.to_string(), window: Window::new(capacity), how }
    }

    /// Feed one sample. Returns a point only when the window just filled.
    pub fn push(&mut self, value: f64) -> Result<Point, Pending> {
        self.window.observe(value);
        if !self.window.is_full() {
            return Err(Pending::NotFull);
        }
        match self.how.fold(self.window.snapshot()) {
            Some(folded) => Ok((self.describe(), folded)),
            None => Err(Pending::Refused),
        }
    }

    fn describe(&self) -> String {
        format!("{}.{}", self.metric, self.how.label())
    }
}
