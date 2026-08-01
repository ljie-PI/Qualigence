//! Companion-brokered desktop action execution and Companion-side risk
//! classification (specialist finding W-01).
//!
//! This is the ONLY path that runs a desktop action. It first consumes the
//! one-time [`crate::permit::PermitBinding`]-bound Permit through the Companion's
//! approval/latch-guarded [`Companion::authorize_action`], and only if that
//! atomic consume succeeds does it hand the action to the restartable UIA worker
//! supervisor. A missing / replayed / expired / mismatched Permit, a paused
//! Session or an Emergency Stop fails closed *before* any COM call is attempted,
//! so TypeScript can never obtain an alternate execution path.

use std::time::Duration;

use crate::approval::Approver;
use crate::clock::Clock;
use crate::ipc::dto::{DesktopActionKind, ResolvedDesktopAction, WindowOperation};
use crate::permit::{PermitBinding, PermitError};
use crate::risk::Risk;
use crate::uia::protocol::{ActionOutcomeReport, UiaError};
use crate::uia::worker_supervisor::{UiaWorkerSupervisor, WorkerSpawner};
use crate::Companion;

/// The Companion-side, independent risk classification for a desktop action.
///
/// This mirrors the Runner Kernel `classifyDesktopActionRisk` so the Companion
/// never has to trust the risk the Runner *claims*: read-only-ish interactions
/// are `Normal`, state-changing input is an `ExternalSideEffect`, and a window
/// close is `Destructive`. `ProductionForbidden` is never derived from the kind
/// alone — it is imposed by explicit policy — so it is never returned here.
pub fn classify_desktop_action(action: &ResolvedDesktopAction) -> Risk {
    match &action.kind {
        DesktopActionKind::Click | DesktopActionKind::Scroll { .. } => Risk::Normal,
        DesktopActionKind::Input { .. } | DesktopActionKind::Select { .. } => {
            Risk::ExternalSideEffect
        }
        DesktopActionKind::Window { window_operation } => match window_operation {
            WindowOperation::Close => Risk::Destructive,
            WindowOperation::Focus | WindowOperation::Minimize | WindowOperation::Restore => {
                Risk::Normal
            }
        },
    }
}

/// Failure to broker a desktop action.
#[derive(Debug, PartialEq, Eq)]
pub enum DesktopActionError {
    /// The one-time Permit was missing, replayed, expired, mismatched, or the
    /// Session was paused / emergency-stopped. No COM call was attempted.
    Permit(PermitError),
    /// The Permit was consumed but the UIA worker failed (e.g. timeout →
    /// `ActionOutcomeUnknown`). Never retried automatically.
    Uia(UiaError),
}

/// Execute a desktop action through the Companion broker.
///
/// The Permit is consumed FIRST; only on success is the action dispatched to the
/// worker supervisor. This ordering is the enforcement of the sole-broker
/// invariant — there is no code path that dispatches to the worker without a
/// successfully consumed Permit.
pub fn execute_desktop_action<C, A, S>(
    companion: &mut Companion<C, A>,
    supervisor: &mut UiaWorkerSupervisor<S>,
    session_id: &str,
    action: &ResolvedDesktopAction,
    permit_token: &str,
    binding: &PermitBinding,
    deadline: Duration,
) -> Result<ActionOutcomeReport, DesktopActionError>
where
    C: Clock,
    A: Approver,
    S: WorkerSpawner,
{
    companion
        .authorize_action(permit_token, binding)
        .map_err(DesktopActionError::Permit)?;

    supervisor
        .execute(session_id, action, deadline)
        .map_err(DesktopActionError::Uia)
}
