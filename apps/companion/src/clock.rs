//! A minimal clock abstraction so security-critical timing (permit TTL and
//! approval deadlines) is deterministically testable. Production uses
//! [`SystemClock`]; tests use [`ManualClock`] to prove expiry, clock-skew and
//! deadline behaviour without sleeping.
//!
//! Wall time drives the human-facing permit `expiresAt`, while a separate
//! monotonic reading drives internal deadlines so a system-clock rollback can
//! never *extend* a Permit's or an approval's effective lifetime.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    /// Wall-clock milliseconds since the Unix epoch.
    fn now_ms(&self) -> u64;
    /// Monotonic milliseconds from an arbitrary fixed origin. Never moves
    /// backwards, even if the wall clock is stepped back.
    fn monotonic_ms(&self) -> u64;
}

#[derive(Clone)]
pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn monotonic_ms(&self) -> u64 {
        self.origin.elapsed().as_millis() as u64
    }
}

/// A manually advanced clock for tests. Wall and monotonic readings advance
/// independently so scenarios like "the wall clock jumped back but the monotonic
/// deadline still elapsed" are expressible.
#[derive(Clone)]
pub struct ManualClock {
    wall: Arc<AtomicU64>,
    mono: Arc<AtomicU64>,
}

impl ManualClock {
    pub fn new(now_ms: u64) -> Self {
        Self {
            wall: Arc::new(AtomicU64::new(now_ms)),
            mono: Arc::new(AtomicU64::new(now_ms)),
        }
    }

    /// Advance both wall and monotonic readings by `delta_ms`.
    pub fn advance(&self, delta_ms: u64) {
        self.wall.fetch_add(delta_ms, Ordering::SeqCst);
        self.mono.fetch_add(delta_ms, Ordering::SeqCst);
    }

    /// Step the wall clock backwards without moving the monotonic reading.
    pub fn rewind_wall(&self, delta_ms: u64) {
        self.wall.fetch_sub(delta_ms, Ordering::SeqCst);
    }

    /// Advance only the monotonic reading (deadline elapses without wall change).
    pub fn advance_monotonic(&self, delta_ms: u64) {
        self.mono.fetch_add(delta_ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.wall.load(Ordering::SeqCst)
    }

    fn monotonic_ms(&self) -> u64 {
        self.mono.load(Ordering::SeqCst)
    }
}
