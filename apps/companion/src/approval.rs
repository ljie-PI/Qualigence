//! The human approval gate.
//!
//! Certain action classes may never execute without an explicit human approval
//! signal. This module models that as a real gate the Companion blocks on: a
//! [`ChannelApprover`] waits on a pending-approval queue with a monotonic
//! deadline, exactly as the production tray prompt would. `Normal` risk is
//! auto-issued in an active unpaused Session; `ProductionForbidden` is always
//! denied; Emergency Stop and pause short-circuit before any prompt.

use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use crate::emergency_stop::{ControlState, SessionControl};
use crate::risk::{Risk, RiskPolicy};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub session_id: String,
    pub run_id: String,
    pub action_id: String,
    pub risk: Risk,
    /// A redacted, human-readable summary. Never carries secret values.
    pub safe_summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalOutcome {
    Approved,
    Denied,
    TimedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Approved,
    Denied,
    TimedOut,
    Paused,
    EmergencyStopped,
}

/// A source of human approvals. A real implementation blocks on a UI prompt with
/// a deadline; tests may script outcomes.
pub trait Approver {
    fn request_approval(&mut self, request: &ApprovalRequest) -> ApprovalOutcome;
}

/// The approval state machine for a single Session/run.
pub struct ApprovalState<A: Approver> {
    run_id: String,
    control: SessionControl,
    approver: A,
}

impl<A: Approver> ApprovalState<A> {
    pub fn new(run_id: impl Into<String>, approver: A) -> Self {
        Self {
            run_id: run_id.into(),
            control: SessionControl::new(),
            approver,
        }
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn control(&self) -> &SessionControl {
        &self.control
    }

    pub fn state(&self) -> ControlState {
        self.control.state()
    }

    pub fn pause(&mut self) {
        self.control.pause();
    }

    pub fn resume(&mut self) {
        self.control.resume();
    }

    pub fn emergency_stop(&mut self) {
        self.control.emergency_stop();
    }

    pub fn reset(&mut self) {
        self.control.reset();
    }

    /// Decide whether an action may proceed. The absolute latches win first, then
    /// the risk policy, and only `RequiresApproval` reaches the human queue.
    pub fn decide(&mut self, request: &ApprovalRequest) -> Decision {
        match self.control.state() {
            ControlState::EmergencyStopped => return Decision::EmergencyStopped,
            ControlState::Paused => return Decision::Paused,
            ControlState::Active => {}
        }
        match request.risk.policy() {
            RiskPolicy::Forbidden => Decision::Denied,
            RiskPolicy::AutoNormal => Decision::Approved,
            RiskPolicy::RequiresApproval => match self.approver.request_approval(request) {
                ApprovalOutcome::Approved => Decision::Approved,
                ApprovalOutcome::Denied => Decision::Denied,
                ApprovalOutcome::TimedOut => Decision::TimedOut,
            },
        }
    }
}

/// A deterministic approver that replays a scripted sequence of outcomes. Used to
/// exercise the state machine without a real UI.
pub struct ScriptedApprover {
    outcomes: VecDeque<ApprovalOutcome>,
    default: ApprovalOutcome,
    pub seen: Vec<ApprovalRequest>,
}

impl ScriptedApprover {
    pub fn new(outcomes: impl IntoIterator<Item = ApprovalOutcome>) -> Self {
        Self {
            outcomes: outcomes.into_iter().collect(),
            default: ApprovalOutcome::TimedOut,
            seen: Vec::new(),
        }
    }

    pub fn always(outcome: ApprovalOutcome) -> Self {
        Self {
            outcomes: VecDeque::new(),
            default: outcome,
            seen: Vec::new(),
        }
    }
}

impl Approver for ScriptedApprover {
    fn request_approval(&mut self, request: &ApprovalRequest) -> ApprovalOutcome {
        self.seen.push(request.clone());
        self.outcomes.pop_front().unwrap_or(self.default)
    }
}

/// A realistic approver that blocks on a pending-approval queue until a human
/// decision arrives or the monotonic deadline elapses. This is genuinely
/// blocking: the caller waits, and a missing decision fails closed as `TimedOut`.
pub struct ChannelApprover {
    receiver: Receiver<ApprovalOutcome>,
    deadline: Duration,
}

impl ChannelApprover {
    pub fn new(receiver: Receiver<ApprovalOutcome>, deadline: Duration) -> Self {
        Self { receiver, deadline }
    }
}

impl Approver for ChannelApprover {
    fn request_approval(&mut self, _request: &ApprovalRequest) -> ApprovalOutcome {
        match self.receiver.recv_timeout(self.deadline) {
            Ok(outcome) => outcome,
            Err(RecvTimeoutError::Timeout) => ApprovalOutcome::TimedOut,
            // A disconnected queue (Companion tray gone) fails closed.
            Err(RecvTimeoutError::Disconnected) => ApprovalOutcome::Denied,
        }
    }
}
