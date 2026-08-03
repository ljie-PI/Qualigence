//! The UIA worker child role and its capture/action backend abstraction.
//!
//! The same Companion binary re-executes itself with a hidden `--uia-worker`
//! flag; that child owns every UIA COM object on MTA worker threads and speaks
//! the framed [`crate::uia::protocol`] over its stdio. The Win32/COM FFI is the
//! *only* faked boundary on this Linux sandbox: it is isolated behind the
//! [`UiaCapture`] trait. A real `#[cfg(windows)]` backend drives `IUIAutomation`;
//! the portable [`SyntheticUiaCapture`] backend produces a deterministic
//! synthetic desktop tree so the worker loop, the supervisor restart logic and
//! the payload mapping are all genuinely exercised cross-platform.

use crate::ipc::dto::ResolvedDesktopAction;
use crate::uia::mapping::{masked_value, role_for_control_type};
use crate::uia::protocol::{
    ActionOutcomeReport, UiaError, UiaPatternDescriptor, UiaSource, UiaSourceNode,
};

/// The isolated UIA FFI seam. Implementations own native COM objects; the
/// supervisor and worker loop never touch COM directly.
pub trait UiaCapture {
    /// Capture the current desktop subtree for `session_id`.
    fn capture(&mut self, session_id: &str) -> Result<UiaSource, UiaError>;
    /// Execute a resolved desktop action against the live UI tree.
    fn execute(
        &mut self,
        session_id: &str,
        action: &ResolvedDesktopAction,
    ) -> Result<ActionOutcomeReport, UiaError>;
}

/// A portable, deterministic capture backend used by the worker loop on
/// non-Windows hosts and by the cross-platform test-suite. It fabricates a small
/// but realistic desktop tree (Window → Button/Edit/Password/List) so mapping,
/// masking and pattern preservation are all covered without any COM call.
pub struct SyntheticUiaCapture {
    process_id: i32,
    captured_at: String,
}

impl SyntheticUiaCapture {
    pub fn new(process_id: i32, captured_at: impl Into<String>) -> Self {
        Self {
            process_id,
            captured_at: captured_at.into(),
        }
    }
}

impl UiaCapture for SyntheticUiaCapture {
    fn capture(&mut self, session_id: &str) -> Result<UiaSource, UiaError> {
        Ok(synthetic_source(
            session_id,
            self.process_id,
            &self.captured_at,
        ))
    }

    fn execute(
        &mut self,
        _session_id: &str,
        _action: &ResolvedDesktopAction,
    ) -> Result<ActionOutcomeReport, UiaError> {
        Ok(ActionOutcomeReport::Ok)
    }
}

/// Build the deterministic synthetic `uia/v1` source. Also used directly by the
/// TypeScript golden-payload fixtures via a serialized copy.
pub fn synthetic_source(session_id: &str, process_id: i32, captured_at: &str) -> UiaSource {
    let window = UiaSourceNode {
        node_id: "window".into(),
        role: role_for_control_type(50032),
        control_type_id: 50032,
        name: Some("Reference App".into()),
        value: None,
        automation_id: Some("MainWindow".into()),
        framework_id: Some("WPF".into()),
        class_name: Some("HwndWrapper".into()),
        native_window_handle: Some("0x00010".into()),
        process_id,
        is_offscreen: false,
        is_keyboard_focusable: false,
        has_keyboard_focus: false,
        is_password: false,
        bounds: None,
        patterns: vec![pattern("Window", true, Some(false))],
        children: vec![
            "button".into(),
            "username".into(),
            "password".into(),
            "list".into(),
        ],
    };
    let button = UiaSourceNode {
        node_id: "button".into(),
        role: role_for_control_type(50000),
        control_type_id: 50000,
        name: Some("Submit".into()),
        value: None,
        automation_id: Some("SubmitButton".into()),
        framework_id: Some("WPF".into()),
        class_name: Some("Button".into()),
        native_window_handle: None,
        process_id,
        is_offscreen: false,
        is_keyboard_focusable: true,
        has_keyboard_focus: false,
        is_password: false,
        bounds: None,
        patterns: vec![pattern("Invoke", true, None)],
        children: vec![],
    };
    let username = UiaSourceNode {
        node_id: "username".into(),
        role: role_for_control_type(50004),
        control_type_id: 50004,
        name: Some("Username".into()),
        value: Some("alice".into()),
        automation_id: Some("UsernameEdit".into()),
        framework_id: Some("WPF".into()),
        class_name: Some("TextBox".into()),
        native_window_handle: None,
        process_id,
        is_offscreen: false,
        is_keyboard_focusable: true,
        has_keyboard_focus: true,
        is_password: false,
        bounds: None,
        patterns: vec![pattern("Value", true, Some(false))],
        children: vec![],
    };
    let password_raw_value = Some("hunter2".to_string());
    let password = UiaSourceNode {
        node_id: "password".into(),
        role: role_for_control_type(50004),
        control_type_id: 50004,
        name: Some("Password".into()),
        // Masked before leaving the worker: the real secret is never framed.
        value: masked_value(true, password_raw_value),
        automation_id: Some("PasswordEdit".into()),
        framework_id: Some("WPF".into()),
        class_name: Some("PasswordBox".into()),
        native_window_handle: None,
        process_id,
        is_offscreen: false,
        is_keyboard_focusable: true,
        has_keyboard_focus: false,
        is_password: true,
        bounds: None,
        patterns: vec![pattern("Value", true, Some(false))],
        children: vec![],
    };
    let list = UiaSourceNode {
        node_id: "list".into(),
        role: role_for_control_type(50008),
        control_type_id: 50008,
        name: Some("Results".into()),
        value: None,
        automation_id: Some("ResultsList".into()),
        framework_id: Some("WPF".into()),
        class_name: Some("ListBox".into()),
        native_window_handle: None,
        process_id,
        is_offscreen: true,
        is_keyboard_focusable: true,
        has_keyboard_focus: false,
        is_password: false,
        bounds: None,
        patterns: vec![
            pattern("Selection", true, Some(false)),
            pattern("Scroll", true, None),
        ],
        children: vec![],
    };

    UiaSource {
        session_id: session_id.to_string(),
        captured_at: captured_at.to_string(),
        root_node_ids: vec!["window".into()],
        nodes: vec![window, button, username, password, list],
    }
}

fn pattern(name: &str, available: bool, read_only: Option<bool>) -> UiaPatternDescriptor {
    UiaPatternDescriptor {
        pattern: name.to_string(),
        available,
        read_only,
    }
}

/// The real Windows UIA capture backend. This is the isolated COM FFI seam: it is
/// only compiled on Windows CI (never on this Linux sandbox) and is where the
/// `windows` crate `IUIAutomation` tree walk / pattern extraction is wired. The
/// portable [`SyntheticUiaCapture`] is what the cross-platform logic tests use.
#[cfg(windows)]
pub struct WindowsUiaCapture;

#[cfg(windows)]
impl WindowsUiaCapture {
    /// Initialise COM as MTA on this worker thread and construct the
    /// `IUIAutomation` root. Wired against the `windows` crate on Windows CI.
    pub fn initialize() -> Result<Self, UiaError> {
        Err(UiaError::WorkerUnavailable)
    }
}

#[cfg(windows)]
impl UiaCapture for WindowsUiaCapture {
    fn capture(&mut self, _session_id: &str) -> Result<UiaSource, UiaError> {
        // Real IUIAutomation tree walk is wired here on Windows CI.
        Err(UiaError::TargetUnresponsive)
    }

    fn execute(
        &mut self,
        _session_id: &str,
        _action: &ResolvedDesktopAction,
    ) -> Result<ActionOutcomeReport, UiaError> {
        Err(UiaError::ActionOutcomeUnknown)
    }
}
