//! Minimal Companion tray/status surface.
//!
//! The tray shows only run/target/pause state — never project, report, or Skill
//! UI, and never a secret value. This is the state model behind the real tray;
//! rendering is platform-specific and out of scope for this PR.

use crate::emergency_stop::ControlState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayStatus {
    pub run_id: String,
    pub target_name: String,
    pub control: ControlState,
}

impl TrayStatus {
    pub fn new(run_id: impl Into<String>, target_name: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
            target_name: target_name.into(),
            control: ControlState::Active,
        }
    }

    /// A one-line, secret-free description safe to display or log.
    pub fn summary(&self) -> String {
        let state = match self.control {
            ControlState::Active => "active",
            ControlState::Paused => "paused",
            ControlState::EmergencyStopped => "emergency-stopped",
        };
        format!(
            "run {} · target {} · {}",
            self.run_id, self.target_name, state
        )
    }
}
