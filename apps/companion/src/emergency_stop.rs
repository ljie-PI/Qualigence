//! Per-Session control latches: pause and Emergency Stop.
//!
//! Emergency Stop is an *absolute* deny latch. Once set, the Companion refuses
//! every subsequent action — even one carrying an otherwise-valid fresh Permit —
//! until an explicit [`SessionControl::reset`] begins a new Session. Pause is a
//! softer latch: no new actions are accepted while paused, but resuming restores
//! normal operation without discarding the Session.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlState {
    Active,
    Paused,
    EmergencyStopped,
}

#[derive(Debug, Default)]
pub struct SessionControl {
    emergency_stopped: bool,
    paused: bool,
}

impl SessionControl {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> ControlState {
        if self.emergency_stopped {
            ControlState::EmergencyStopped
        } else if self.paused {
            ControlState::Paused
        } else {
            ControlState::Active
        }
    }

    pub fn is_emergency_stopped(&self) -> bool {
        self.emergency_stopped
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// True only when the Session will accept a *new* action request.
    pub fn accepts_new_actions(&self) -> bool {
        !self.emergency_stopped && !self.paused
    }

    pub fn pause(&mut self) {
        // Emergency stop dominates pause; a paused-then-resumed Session must not
        // silently clear an emergency latch.
        if !self.emergency_stopped {
            self.paused = true;
        }
    }

    pub fn resume(&mut self) {
        if !self.emergency_stopped {
            self.paused = false;
        }
    }

    /// Trigger the absolute deny latch. Idempotent and irreversible until
    /// [`reset`](Self::reset) starts a brand-new Session.
    pub fn emergency_stop(&mut self) {
        self.emergency_stopped = true;
        self.paused = false;
    }

    /// Explicitly begin a new Session, clearing the emergency latch. Only a
    /// deliberate operator action (never `resume`) may do this.
    pub fn reset(&mut self) {
        self.emergency_stopped = false;
        self.paused = false;
    }
}
