//! The Qualigence M3 Desktop Companion (LS-13).
//!
//! The Companion is the **sole broker** for desktop process lifecycle, UIA
//! capture and UIA action execution (specialist review finding W-01). No other
//! process or code path in the system executes a desktop action: TypeScript may
//! only send typed, bounded, authenticated IPC requests, and every action must
//! carry a fresh, single-use, action-bound Permit that only the Companion can
//! mint and consume.
//!
//! This PR (PR-25) implements the security core only: authenticated IPC
//! (peer-identity + certificate challenge-response), one-time Permits, the human
//! approval gate, pause and Emergency Stop. UIA capture, the Job Object process
//! lifecycle and real action execution against a desktop app are PR-26.

pub mod approval;
pub mod clock;
pub mod emergency_stop;
pub mod ipc;
pub mod permit;
pub mod process;
pub mod random;
pub mod risk;
pub mod tray;
pub mod uia;

use std::sync::Arc;

use crate::approval::{ApprovalRequest, ApprovalState, Approver, Decision};
use crate::clock::Clock;
use crate::emergency_stop::{ControlState, SessionControl};
use crate::permit::{IssuedPermit, PermitBinding, PermitError, PermitStore};

/// The outcome of requesting a Permit for one desktop action.
#[derive(Debug)]
pub enum PermitRequestOutcome {
    /// Approved (auto for Normal, or human-approved) and a one-time Permit minted.
    Issued(IssuedPermit),
    /// Not authorized. Carries why (denied / timed out / paused / emergency).
    Rejected(Decision),
}

/// The single desktop-action broker. Owns the approval gate and the one-time
/// Permit store for one Session, and is the only object able to authorize an
/// action for execution.
pub struct Companion<C: Clock, A: Approver> {
    session_id: String,
    approval: ApprovalState<A>,
    permits: PermitStore<C>,
}

impl<C: Clock, A: Approver> Companion<C, A> {
    pub fn new(
        session_id: impl Into<String>,
        approval: ApprovalState<A>,
        permits: PermitStore<C>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            approval,
            permits,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn state(&self) -> ControlState {
        self.approval.state()
    }

    pub fn control(&self) -> &SessionControl {
        self.approval.control()
    }

    /// Run the approval policy for `request`; on approval, mint a single-use
    /// Permit bound to `binding`. A rejected request never mints a Permit.
    pub fn request_permit(
        &mut self,
        request: &ApprovalRequest,
        binding: PermitBinding,
    ) -> PermitRequestOutcome {
        match self.approval.decide(request) {
            Decision::Approved => PermitRequestOutcome::Issued(self.permits.issue(binding)),
            other => PermitRequestOutcome::Rejected(other),
        }
    }

    /// Authorize an action for execution by consuming its Permit. This is the
    /// ONLY path that authorizes a desktop action; the latches are enforced here
    /// so an Emergency Stop rejects even a fresh, otherwise-valid Permit.
    pub fn authorize_action(
        &mut self,
        token: &str,
        presented: &PermitBinding,
    ) -> Result<(), PermitError> {
        self.permits
            .consume(self.approval.control(), token, presented)
    }

    pub fn pause(&mut self) {
        self.approval.pause();
    }

    pub fn resume(&mut self) {
        self.approval.resume();
    }

    /// Trigger the absolute deny latch and invalidate every pending Permit so no
    /// stale token can survive into a later Session.
    pub fn emergency_stop(&mut self) {
        self.approval.emergency_stop();
        self.permits.invalidate_all();
    }

    /// Explicitly begin a new Session, clearing the emergency latch. Only a
    /// deliberate operator action does this — never `resume`.
    pub fn reset_session(&mut self, new_session_id: impl Into<String>) {
        self.approval.reset();
        self.permits.invalidate_all();
        self.session_id = new_session_id.into();
    }
}

/// Convenience constructor wiring a Companion with a [`SystemClock`]-backed
/// Permit store and the given approver.
pub fn companion_with_clock<C: Clock, A: Approver>(
    session_id: impl Into<String>,
    run_id: impl Into<String>,
    approver: A,
    clock: Arc<C>,
    permit_ttl_ms: u64,
) -> Companion<C, A> {
    let approval = ApprovalState::new(run_id, approver);
    let permits = PermitStore::new(clock, permit_ttl_ms);
    Companion::new(session_id, approval, permits)
}
