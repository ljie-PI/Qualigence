//! Wire protocol for the restartable UIA capture/action worker.
//!
//! All UIA COM work runs in a short-lived child worker process (specialist
//! finding W-03): a hung `IUIAutomation` call must be able to take down only the
//! worker, never the Companion main process that owns approvals, the deny latch
//! and the App Job Object. This module defines the bounded, framed request /
//! response DTOs exchanged with that worker plus the lossless `uia/v1` *source*
//! payload the worker returns.
//!
//! The DTOs are `serde`-serialisable so the real transport can length-prefix
//! them exactly like the IPC server frames; the portable supervisor logic and
//! the fake worker used by the Linux test-suite exchange the very same types.

use serde::{Deserialize, Serialize};

use crate::ipc::dto::{DesktopPlaintextValue, ResolvedDesktopAction};

/// The AppSession authority the Companion passes into the UIA worker for every
/// capture/action. The worker must scope all lookup to this root HWND and verify
/// the owning process before it walks or invokes anything, so a permit for one
/// AppSession cannot hit unrelated desktop UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiaSessionTarget {
    pub session_id: String,
    pub process_id: i32,
    pub root_window_handle: String,
}

/// A single UIA pattern availability descriptor, mirrored losslessly from the
/// native `IUIAutomationElement` pattern set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiaPatternDescriptor {
    pub pattern: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
}

/// Axis-aligned element bounds in device-independent pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct UiaBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// One captured UIA element. Everything the generic Observation Graph cannot
/// represent (AutomationId, ControlType, framework, patterns, focus/offscreen
/// flags) is preserved here losslessly and mapped into the `uia/v1` extension by
/// the TypeScript adapter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiaSourceNode {
    pub node_id: String,
    /// Generic, cross-platform role mapped from `control_type_id`.
    pub role: String,
    pub control_type_id: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framework_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_window_handle: Option<String>,
    pub process_id: i32,
    pub is_offscreen: bool,
    pub is_keyboard_focusable: bool,
    pub has_keyboard_focus: bool,
    /// Password / protected edit control: the worker masks the value before it
    /// ever leaves the worker process.
    pub is_password: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<UiaBounds>,
    pub patterns: Vec<UiaPatternDescriptor>,
    /// Child node ids, in document order.
    pub children: Vec<String>,
}

/// A full captured desktop subtree. This is the lossless `uia/v1` source the
/// TypeScript adapter maps into an `observation-graph/v1`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiaSource {
    pub session_id: String,
    pub captured_at: String,
    pub root_node_ids: Vec<String>,
    pub nodes: Vec<UiaSourceNode>,
}

/// The outcome of a UIA action attempt, as reported by the worker. A timeout is
/// never reported here — it is surfaced by the supervisor as
/// [`UiaError::ActionOutcomeUnknown`] after it kills the unresponsive worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ActionOutcomeReport {
    Ok,
    Failed { error_code: String },
}

/// A request sent to the worker child. Bounded and framed identically to the IPC
/// server transport.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkerRequest {
    Capture {
        target: UiaSessionTarget,
    },
    Execute {
        target: UiaSessionTarget,
        action: ResolvedDesktopAction,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<DesktopPlaintextValue>,
    },
    Ping,
}

/// A response from the worker child.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkerResponse {
    Captured { source: UiaSource },
    Executed { outcome: ActionOutcomeReport },
    Pong,
    Error { message: String },
}

/// Stable UIA errors surfaced to the Companion / Runner. Every variant is a
/// documented, non-blocking failure — a hung worker becomes
/// [`UiaError::TargetUnresponsive`] (capture) or
/// [`UiaError::ActionOutcomeUnknown`] (action), never an indefinite block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UiaError {
    /// The UIA call did not return before its monotonic deadline; the worker was
    /// terminated and will be rebuilt on the next request.
    TargetUnresponsive,
    /// An action deadline elapsed: the side effect may or may not have occurred,
    /// so it must never be replayed automatically.
    ActionOutcomeUnknown,
    /// The worker could not be started.
    WorkerUnavailable,
    /// The worker returned a corrupt or unexpected frame.
    ProtocolCorruption,
    /// The worker reported a specific, stable error (e.g. `UiaPatternUnsupported`).
    Reported(String),
}

impl UiaError {
    pub fn code(&self) -> &str {
        match self {
            UiaError::TargetUnresponsive => "TargetUnresponsive",
            UiaError::ActionOutcomeUnknown => "ActionOutcomeUnknown",
            UiaError::WorkerUnavailable => "CompanionUnavailable",
            UiaError::ProtocolCorruption => "UiaElementStale",
            UiaError::Reported(code) => code,
        }
    }
}
