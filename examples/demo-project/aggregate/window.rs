//! Time-window aggregation. The window decides *what* a number means; the
//! rollup decides *when* to emit it.

/// A metric name paired with its aggregated value. An alias, not a newtype:
/// callers legitimately treat it as the tuple it is.
pub type Point = (String, f64);

/// How a window folds many samples into one number.
pub enum Aggregation {
    Sum,
    Mean,
    Max,
}

/// Anything that can fold a slice of values.
pub trait Fold {
    /// Returns `None` for an empty slice rather than a zero, because zero is a
    /// legitimate measurement and "nothing measured" is not.
    fn fold(&self, values: &[f64]) -> Option<f64>;

    fn label(&self) -> &'static str;
}

impl Fold for Aggregation {
    fn fold(&self, values: &[f64]) -> Option<f64> {
        if values.is_empty() {
            return None;
        }
        Some(match self {
            Aggregation::Sum => values.iter().sum(),
            Aggregation::Mean => values.iter().sum::<f64>() / values.len() as f64,
            Aggregation::Max => values.iter().copied().fold(f64::MIN, f64::max),
        })
    }

    fn label(&self) -> &'static str {
        match self {
            Aggregation::Sum => "sum",
            Aggregation::Mean => "mean",
            Aggregation::Max => "max",
        }
    }
}

/// A fixed-capacity window. Full means the oldest value leaves, so a long run
/// cannot grow this without bound.
pub struct Window {
    capacity: usize,
    values: Vec<f64>,
}

impl Window {
    pub fn new(capacity: usize) -> Self {
        Window { capacity, values: Vec::new() }
    }

    pub fn observe(&mut self, value: f64) {
        if self.values.len() == self.capacity {
            self.values.remove(0);
        }
        self.values.push(value);
    }

    pub fn is_full(&self) -> bool {
        self.values.len() == self.capacity
    }

    pub fn snapshot(&self) -> &[f64] {
        &self.values
    }
}
