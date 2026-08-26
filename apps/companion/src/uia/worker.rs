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

use crate::ipc::dto::{
    DesktopActionKind, DesktopPlaintextValue, ResolvedDesktopAction, WindowOperation,
};
use crate::uia::mapping::{masked_value, role_for_control_type};
use crate::uia::protocol::{
    ActionOutcomeReport, UiaError, UiaPatternDescriptor, UiaSessionTarget, UiaSource, UiaSourceNode,
};

/// The isolated UIA FFI seam. Implementations own native COM objects; the
/// supervisor and worker loop never touch COM directly.
pub trait UiaCapture {
    /// Capture the current desktop subtree for an authorized AppSession target.
    fn capture(&mut self, target: &UiaSessionTarget) -> Result<UiaSource, UiaError>;
    /// Execute a resolved desktop action against the authorized AppSession tree.
    fn execute(
        &mut self,
        target: &UiaSessionTarget,
        action: &ResolvedDesktopAction,
        value: Option<&DesktopPlaintextValue>,
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
    fn capture(&mut self, target: &UiaSessionTarget) -> Result<UiaSource, UiaError> {
        let process_id = if target.process_id == 0 {
            self.process_id
        } else {
            target.process_id
        };
        Ok(synthetic_source(
            &target.session_id,
            process_id,
            &self.captured_at,
        ))
    }

    fn execute(
        &mut self,
        _target: &UiaSessionTarget,
        action: &ResolvedDesktopAction,
        value: Option<&DesktopPlaintextValue>,
    ) -> Result<ActionOutcomeReport, UiaError> {
        if !action_pattern_is_supported(action) {
            return Err(UiaError::Reported("UiaPatternUnsupported".to_string()));
        }
        if matches!(
            action.kind,
            DesktopActionKind::Input { .. } | DesktopActionKind::Select { .. }
        ) && value.is_none()
        {
            return Err(UiaError::Reported("LocalPermitBindingMismatch".to_string()));
        }
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

pub fn action_pattern_is_supported(action: &ResolvedDesktopAction) -> bool {
    let Some(pattern) = action.uia_pattern.as_deref() else {
        return true;
    };
    match &action.kind {
        DesktopActionKind::Click => pattern == "Invoke",
        DesktopActionKind::Input { .. } => pattern == "Value",
        DesktopActionKind::Select { .. } => pattern == "Selection" || pattern == "SelectionItem",
        DesktopActionKind::Scroll { .. } => pattern == "Scroll",
        DesktopActionKind::Window { .. } => pattern == "Window",
    }
}

pub fn run_worker_stdio<C: UiaCapture>(capture: &mut C) -> Result<(), UiaError> {
    let limits = crate::ipc::server::FrameLimits::default();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    loop {
        let frame = match crate::ipc::server::read_frame(&mut input, &limits) {
            Ok(frame) => frame,
            Err(crate::ipc::server::FrameError::Truncated) => return Ok(()),
            Err(_) => return Err(UiaError::ProtocolCorruption),
        };
        let request: crate::uia::protocol::WorkerRequest =
            serde_json::from_slice(&frame).map_err(|_| UiaError::ProtocolCorruption)?;
        let response = match request {
            crate::uia::protocol::WorkerRequest::Capture { target } => {
                match capture.capture(&target) {
                    Ok(source) => crate::uia::protocol::WorkerResponse::Captured { source },
                    Err(error) => crate::uia::protocol::WorkerResponse::Error {
                        message: error.code().to_string(),
                    },
                }
            }
            crate::uia::protocol::WorkerRequest::Execute {
                target,
                action,
                mut value,
            } => {
                let response = match capture.execute(&target, &action, value.as_ref()) {
                    Ok(outcome) => crate::uia::protocol::WorkerResponse::Executed { outcome },
                    Err(error) => crate::uia::protocol::WorkerResponse::Error {
                        message: error.code().to_string(),
                    },
                };
                if let Some(value) = value.as_mut() {
                    value.plaintext.clear();
                }
                response
            }
            crate::uia::protocol::WorkerRequest::Ping => crate::uia::protocol::WorkerResponse::Pong,
        };
        let body = serde_json::to_vec(&response).map_err(|_| UiaError::ProtocolCorruption)?;
        crate::ipc::server::write_frame(&mut output, &body, &limits)
            .map_err(|_| UiaError::ProtocolCorruption)?;
        std::io::Write::flush(&mut output).map_err(|_| UiaError::ProtocolCorruption)?;
    }
}

#[cfg(windows)]
mod windows_uia {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        action_pattern_is_supported, masked_value, role_for_control_type, ActionOutcomeReport,
        DesktopActionKind, DesktopPlaintextValue, ResolvedDesktopAction, UiaCapture, UiaError,
        UiaPatternDescriptor, UiaSessionTarget, UiaSource, UiaSourceNode, WindowOperation,
    };
    use windows::core::BSTR;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation8, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
        IUIAutomationScrollPattern, IUIAutomationSelectionItemPattern,
        IUIAutomationSelectionPattern, IUIAutomationValuePattern, IUIAutomationWindowPattern,
        ScrollAmount_LargeDecrement, ScrollAmount_LargeIncrement, ScrollAmount_NoAmount,
        ScrollAmount_SmallDecrement, ScrollAmount_SmallIncrement, TreeScope_Children,
        TreeScope_Descendants, UIA_InvokePatternId, UIA_ScrollPatternId,
        UIA_SelectionItemPatternId, UIA_SelectionPatternId, UIA_ValuePatternId,
        UIA_WindowPatternId, WindowVisualState_Minimized, WindowVisualState_Normal,
    };

    const MAX_CAPTURE_NODES: usize = 512;
    const MAX_CAPTURE_DEPTH: usize = 16;
    const MAX_PROPERTY_BYTES: usize = 16 * 1024;

    struct ComMta;

    impl ComMta {
        fn init() -> Result<Self, UiaError> {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .map_err(|_| UiaError::WorkerUnavailable)?;
            Ok(Self)
        }
    }

    impl Drop for ComMta {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    /// Native Windows UIA capture/action backend. It is constructed only inside
    /// the hidden `--uia-worker` child, so all COM objects stay out of the
    /// Companion authority process.
    pub struct WindowsUiaCapture {
        _com: ComMta,
        automation: IUIAutomation,
    }

    impl WindowsUiaCapture {
        pub fn initialize() -> Result<Self, UiaError> {
            let com = ComMta::init()?;
            let automation =
                unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
                    .map_err(|_| UiaError::WorkerUnavailable)?;
            Ok(Self {
                _com: com,
                automation,
            })
        }
    }

    impl UiaCapture for WindowsUiaCapture {
        fn capture(&mut self, target: &UiaSessionTarget) -> Result<UiaSource, UiaError> {
            let root = self.root_for_target(target)?;
            let mut nodes = Vec::new();
            self.walk(target, &root, 0, &mut nodes)?;
            Ok(UiaSource {
                session_id: target.session_id.clone(),
                captured_at: now_iso_like(),
                root_node_ids: nodes
                    .first()
                    .map(|node| vec![node.node_id.clone()])
                    .unwrap_or_default(),
                nodes,
            })
        }

        fn execute(
            &mut self,
            target: &UiaSessionTarget,
            action: &ResolvedDesktopAction,
            value: Option<&DesktopPlaintextValue>,
        ) -> Result<ActionOutcomeReport, UiaError> {
            if !action_pattern_is_supported(action) {
                return Err(UiaError::Reported("UiaPatternUnsupported".to_string()));
            }
            let element = self.find_element(target, &action.node_id)?;
            match &action.kind {
                DesktopActionKind::Click => {
                    let pattern = unsafe {
                        element
                            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    }
                    .map_err(|_| UiaError::Reported("UiaPatternUnsupported".to_string()))?;
                    unsafe { pattern.Invoke() }
                        .map_err(|_| UiaError::Reported("UiaActionFailed".to_string()))?;
                }
                DesktopActionKind::Input { value_ref } => {
                    let Some(value) = value else {
                        return Err(UiaError::Reported("LocalPermitBindingMismatch".to_string()));
                    };
                    if &value.value_ref != value_ref {
                        return Err(UiaError::Reported("LocalPermitBindingMismatch".to_string()));
                    }
                    let pattern = unsafe {
                        element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    }
                    .map_err(|_| UiaError::Reported("UiaPatternUnsupported".to_string()))?;
                    let text = BSTR::from(value.plaintext.as_str());
                    unsafe { pattern.SetValue(&text) }
                        .map_err(|_| UiaError::Reported("UiaActionFailed".to_string()))?;
                }
                DesktopActionKind::Select { value_ref } => {
                    let Some(value) = value else {
                        return Err(UiaError::Reported("LocalPermitBindingMismatch".to_string()));
                    };
                    if &value.value_ref != value_ref {
                        return Err(UiaError::Reported("LocalPermitBindingMismatch".to_string()));
                    }
                    match action.uia_pattern.as_deref() {
                        Some("Selection") => {
                            self.select_descendant_from_container(
                                target,
                                &element,
                                &value.plaintext,
                            )?;
                        }
                        _ => {
                            let pattern = unsafe {
                                element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                                    UIA_SelectionItemPatternId,
                                )
                            }
                            .map_err(|_| UiaError::Reported("UiaPatternUnsupported".to_string()))?;
                            unsafe { pattern.Select() }
                                .map_err(|_| UiaError::Reported("UiaActionFailed".to_string()))?;
                        }
                    }
                }
                DesktopActionKind::Scroll { direction, amount } => {
                    let pattern = unsafe {
                        element
                            .GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                    }
                    .map_err(|_| UiaError::Reported("UiaPatternUnsupported".to_string()))?;
                    let small = matches!(amount, crate::ipc::dto::ScrollAmount::Small);
                    let (horizontal, vertical) = match direction {
                        crate::ipc::dto::ScrollDirection::Up => (
                            ScrollAmount_NoAmount,
                            if small {
                                ScrollAmount_SmallDecrement
                            } else {
                                ScrollAmount_LargeDecrement
                            },
                        ),
                        crate::ipc::dto::ScrollDirection::Down => (
                            ScrollAmount_NoAmount,
                            if small {
                                ScrollAmount_SmallIncrement
                            } else {
                                ScrollAmount_LargeIncrement
                            },
                        ),
                        crate::ipc::dto::ScrollDirection::Left => (
                            if small {
                                ScrollAmount_SmallDecrement
                            } else {
                                ScrollAmount_LargeDecrement
                            },
                            ScrollAmount_NoAmount,
                        ),
                        crate::ipc::dto::ScrollDirection::Right => (
                            if small {
                                ScrollAmount_SmallIncrement
                            } else {
                                ScrollAmount_LargeIncrement
                            },
                            ScrollAmount_NoAmount,
                        ),
                    };
                    unsafe { pattern.Scroll(horizontal, vertical) }
                        .map_err(|_| UiaError::Reported("UiaActionFailed".to_string()))?;
                }
                DesktopActionKind::Window { window_operation } => match window_operation {
                    WindowOperation::Focus => {
                        let _pattern = unsafe {
                            element.GetCurrentPatternAs::<IUIAutomationWindowPattern>(
                                UIA_WindowPatternId,
                            )
                        }
                        .map_err(|_| UiaError::Reported("UiaPatternUnsupported".to_string()))?;
                        unsafe { element.SetFocus() }
                            .map_err(|_| UiaError::Reported("UiaActionFailed".to_string()))?;
                    }
                    WindowOperation::Minimize => {
                        let pattern = unsafe {
                            element.GetCurrentPatternAs::<IUIAutomationWindowPattern>(
                                UIA_WindowPatternId,
                            )
                        }
                        .map_err(|_| UiaError::Reported("UiaPatternUnsupported".to_string()))?;
                        unsafe { pattern.SetWindowVisualState(WindowVisualState_Minimized) }
                            .map_err(|_| UiaError::Reported("UiaActionFailed".to_string()))?;
                    }
                    WindowOperation::Restore => {
                        let pattern = unsafe {
                            element.GetCurrentPatternAs::<IUIAutomationWindowPattern>(
                                UIA_WindowPatternId,
                            )
                        }
                        .map_err(|_| UiaError::Reported("UiaPatternUnsupported".to_string()))?;
                        unsafe { pattern.SetWindowVisualState(WindowVisualState_Normal) }
                            .map_err(|_| UiaError::Reported("UiaActionFailed".to_string()))?;
                    }
                    WindowOperation::Close => {
                        let pattern = unsafe {
                            element.GetCurrentPatternAs::<IUIAutomationWindowPattern>(
                                UIA_WindowPatternId,
                            )
                        }
                        .map_err(|_| UiaError::Reported("UiaPatternUnsupported".to_string()))?;
                        unsafe { pattern.Close() }
                            .map_err(|_| UiaError::Reported("UiaActionFailed".to_string()))?;
                    }
                },
            }
            Ok(ActionOutcomeReport::Ok)
        }
    }

    impl WindowsUiaCapture {
        fn root_for_target(
            &self,
            target: &UiaSessionTarget,
        ) -> Result<IUIAutomationElement, UiaError> {
            let hwnd = parse_hwnd(&target.root_window_handle)?;
            let root = unsafe { self.automation.ElementFromHandle(hwnd) }
                .map_err(|_| UiaError::Reported("UiaAccessDenied".to_string()))?;
            verify_process_scope(&root, target.process_id)?;
            Ok(root)
        }

        fn walk(
            &self,
            target: &UiaSessionTarget,
            element: &IUIAutomationElement,
            depth: usize,
            nodes: &mut Vec<UiaSourceNode>,
        ) -> Result<String, UiaError> {
            if nodes.len() >= MAX_CAPTURE_NODES || depth > MAX_CAPTURE_DEPTH {
                return Err(UiaError::Reported("UiaCaptureBoundsExceeded".to_string()));
            }
            let node_id = format!("uia-{}", nodes.len());
            let control_type = unsafe { element.CurrentControlType() }
                .map(|value| value.0)
                .unwrap_or(0);
            let is_password = unsafe { element.CurrentIsPassword() }
                .map(|value| value.as_bool())
                .unwrap_or(false);
            let process_id = unsafe { element.CurrentProcessId() }.unwrap_or_default();
            if target.process_id != 0 && process_id != target.process_id {
                return Err(UiaError::Reported("UiaAccessDenied".to_string()));
            }
            let value = if is_password {
                masked_value(true, None)
            } else {
                current_value(element)?
            };
            let rect = unsafe { element.CurrentBoundingRectangle() }.ok();
            let mut node = UiaSourceNode {
                node_id: node_id.clone(),
                role: role_for_control_type(control_type),
                control_type_id: control_type,
                name: current_bstr(element, |element| unsafe { element.CurrentName() })?,
                value,
                automation_id: current_bstr(element, |element| unsafe {
                    element.CurrentAutomationId()
                })?,
                framework_id: current_bstr(element, |element| unsafe {
                    element.CurrentFrameworkId()
                })?,
                class_name: current_bstr(element, |element| unsafe { element.CurrentClassName() })?,
                native_window_handle: unsafe { element.CurrentNativeWindowHandle() }
                    .ok()
                    .filter(|hwnd| !hwnd.is_invalid())
                    .map(|hwnd| format!("0x{:X}", hwnd.0 as usize)),
                process_id,
                is_offscreen: unsafe { element.CurrentIsOffscreen() }
                    .map(|value| value.as_bool())
                    .unwrap_or(false),
                is_keyboard_focusable: unsafe { element.CurrentIsKeyboardFocusable() }
                    .map(|value| value.as_bool())
                    .unwrap_or(false),
                has_keyboard_focus: unsafe { element.CurrentHasKeyboardFocus() }
                    .map(|value| value.as_bool())
                    .unwrap_or(false),
                is_password,
                bounds: rect.map(rect_to_bounds),
                patterns: supported_patterns(element),
                children: Vec::new(),
            };
            let index = nodes.len();
            nodes.push(node.clone());

            if depth < MAX_CAPTURE_DEPTH {
                let condition = unsafe { self.automation.CreateTrueCondition() }
                    .map_err(|_| UiaError::TargetUnresponsive)?;
                if let Ok(children) = unsafe { element.FindAll(TreeScope_Children, &condition) } {
                    let len = unsafe { children.Length() }.unwrap_or(0).max(0) as usize;
                    if len > MAX_CAPTURE_NODES.saturating_sub(nodes.len()) {
                        return Err(UiaError::Reported("UiaCaptureBoundsExceeded".to_string()));
                    }
                    for i in 0..len {
                        if let Ok(child) = unsafe { children.GetElement(i as i32) } {
                            let child_id = self.walk(target, &child, depth + 1, nodes)?;
                            node.children.push(child_id);
                        }
                    }
                }
            } else if has_children(element, &self.automation)? {
                return Err(UiaError::Reported("UiaCaptureBoundsExceeded".to_string()));
            }
            nodes[index] = node;
            Ok(node_id)
        }

        fn find_element(
            &self,
            target: &UiaSessionTarget,
            node_id: &str,
        ) -> Result<IUIAutomationElement, UiaError> {
            let root = self.root_for_target(target)?;
            let mut cursor = 0usize;
            let found = self.find_by_generated_id(target, &root, node_id, &mut cursor, 0)?;
            verify_process_scope(&found, target.process_id)?;
            Ok(found)
        }

        fn select_descendant_from_container(
            &self,
            target: &UiaSessionTarget,
            container: &IUIAutomationElement,
            requested_value: &str,
        ) -> Result<(), UiaError> {
            let _selection = unsafe {
                container
                    .GetCurrentPatternAs::<IUIAutomationSelectionPattern>(UIA_SelectionPatternId)
            }
            .map_err(|_| UiaError::Reported("UiaPatternUnsupported".to_string()))?;
            let condition = unsafe { self.automation.CreateTrueCondition() }
                .map_err(|_| UiaError::TargetUnresponsive)?;
            let children = unsafe { container.FindAll(TreeScope_Descendants, &condition) }
                .map_err(|_| UiaError::Reported("UiaElementNotFound".to_string()))?;
            let len = unsafe { children.Length() }.unwrap_or(0).max(0) as usize;
            if len > MAX_CAPTURE_NODES {
                return Err(UiaError::Reported("UiaCaptureBoundsExceeded".to_string()));
            }
            for i in 0..len {
                let Ok(child) = (unsafe { children.GetElement(i as i32) }) else {
                    continue;
                };
                verify_process_scope(&child, target.process_id)?;
                if !element_matches_selection_value(&child, requested_value)? {
                    continue;
                }
                let pattern = unsafe {
                    child.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                        UIA_SelectionItemPatternId,
                    )
                }
                .map_err(|_| UiaError::Reported("UiaPatternUnsupported".to_string()))?;
                unsafe { pattern.Select() }
                    .map_err(|_| UiaError::Reported("UiaActionFailed".to_string()))?;
                return Ok(());
            }
            Err(UiaError::Reported("UiaElementNotFound".to_string()))
        }

        fn find_by_generated_id(
            &self,
            target: &UiaSessionTarget,
            element: &IUIAutomationElement,
            wanted: &str,
            cursor: &mut usize,
            depth: usize,
        ) -> Result<IUIAutomationElement, UiaError> {
            if depth > MAX_CAPTURE_DEPTH || *cursor >= MAX_CAPTURE_NODES {
                return Err(UiaError::Reported("UiaCaptureBoundsExceeded".to_string()));
            }
            verify_process_scope(element, target.process_id)?;
            let current_id = format!("uia-{cursor}");
            *cursor += 1;
            if current_id == wanted {
                return Ok(element.clone());
            }
            let condition = unsafe { self.automation.CreateTrueCondition() }
                .map_err(|_| UiaError::TargetUnresponsive)?;
            if let Ok(children) = unsafe { element.FindAll(TreeScope_Children, &condition) } {
                let len = unsafe { children.Length() }.unwrap_or(0).max(0) as usize;
                if len > MAX_CAPTURE_NODES.saturating_sub(*cursor) {
                    return Err(UiaError::Reported("UiaCaptureBoundsExceeded".to_string()));
                }
                for i in 0..len {
                    if let Ok(child) = unsafe { children.GetElement(i as i32) } {
                        if let Ok(found) =
                            self.find_by_generated_id(target, &child, wanted, cursor, depth + 1)
                        {
                            return Ok(found);
                        }
                    }
                }
            }
            Err(UiaError::Reported("UiaElementNotFound".to_string()))
        }
    }

    fn current_bstr<F>(element: &IUIAutomationElement, f: F) -> Result<Option<String>, UiaError>
    where
        F: FnOnce(&IUIAutomationElement) -> windows::core::Result<BSTR>,
    {
        match f(element) {
            Ok(bstr) => bounded_optional_string(String::try_from(&bstr).unwrap_or_default()),
            Err(_) => Ok(None),
        }
    }

    fn current_value(element: &IUIAutomationElement) -> Result<Option<String>, UiaError> {
        let pattern =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
                .ok();
        let Some(pattern) = pattern else {
            return Ok(None);
        };
        match unsafe { pattern.CurrentValue() } {
            Ok(bstr) => bounded_optional_string(String::try_from(&bstr).unwrap_or_default()),
            Err(_) => Ok(None),
        }
    }

    fn element_matches_selection_value(
        element: &IUIAutomationElement,
        requested_value: &str,
    ) -> Result<bool, UiaError> {
        let name = current_bstr(element, |element| unsafe { element.CurrentName() })?;
        if name.as_deref() == Some(requested_value) {
            return Ok(true);
        }
        let automation_id =
            current_bstr(element, |element| unsafe { element.CurrentAutomationId() })?;
        if automation_id.as_deref() == Some(requested_value) {
            return Ok(true);
        }
        Ok(current_value(element)?.as_deref() == Some(requested_value))
    }

    fn parse_hwnd(value: &str) -> Result<HWND, UiaError> {
        let trimmed = value.trim();
        let hex = trimmed
            .strip_prefix("0x")
            .or_else(|| trimmed.strip_prefix("0X"))
            .unwrap_or(trimmed);
        let raw = usize::from_str_radix(hex, 16)
            .or_else(|_| trimmed.parse::<usize>())
            .map_err(|_| UiaError::Reported("UiaAccessDenied".to_string()))?;
        if raw == 0 {
            return Err(UiaError::Reported("UiaAccessDenied".to_string()));
        }
        Ok(HWND(raw as *mut std::ffi::c_void))
    }

    fn verify_process_scope(
        element: &IUIAutomationElement,
        expected_process_id: i32,
    ) -> Result<(), UiaError> {
        if expected_process_id == 0 {
            return Ok(());
        }
        let process_id = unsafe { element.CurrentProcessId() }
            .map_err(|_| UiaError::Reported("UiaAccessDenied".to_string()))?;
        if process_id == expected_process_id {
            Ok(())
        } else {
            Err(UiaError::Reported("UiaAccessDenied".to_string()))
        }
    }

    fn has_children(
        element: &IUIAutomationElement,
        automation: &IUIAutomation,
    ) -> Result<bool, UiaError> {
        let condition = unsafe { automation.CreateTrueCondition() }
            .map_err(|_| UiaError::TargetUnresponsive)?;
        Ok(unsafe { element.FindAll(TreeScope_Children, &condition) }
            .ok()
            .and_then(|children| unsafe { children.Length() }.ok())
            .map(|len| len > 0)
            .unwrap_or(false))
    }

    fn bounded_optional_string(value: String) -> Result<Option<String>, UiaError> {
        if value.is_empty() {
            Ok(None)
        } else if value.as_bytes().len() > MAX_PROPERTY_BYTES {
            Err(UiaError::Reported("UiaCaptureBoundsExceeded".to_string()))
        } else {
            Ok(Some(value))
        }
    }

    fn rect_to_bounds(rect: RECT) -> crate::uia::protocol::UiaBounds {
        crate::uia::protocol::UiaBounds {
            x: rect.left as f64,
            y: rect.top as f64,
            width: (rect.right - rect.left).max(0) as f64,
            height: (rect.bottom - rect.top).max(0) as f64,
        }
    }

    fn supported_patterns(element: &IUIAutomationElement) -> Vec<UiaPatternDescriptor> {
        let mut patterns = Vec::new();
        if unsafe { element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) }
            .is_ok()
        {
            patterns.push(pattern("Invoke", true, None));
        }
        if let Ok(value) =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
        {
            patterns.push(pattern(
                "Value",
                true,
                unsafe { value.CurrentIsReadOnly() }
                    .ok()
                    .map(|v| v.as_bool()),
            ));
        }
        if unsafe {
            element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                UIA_SelectionItemPatternId,
            )
        }
        .is_ok()
        {
            patterns.push(pattern("SelectionItem", true, None));
        }
        if unsafe {
            element.GetCurrentPatternAs::<IUIAutomationSelectionPattern>(UIA_SelectionPatternId)
        }
        .is_ok()
        {
            patterns.push(pattern("Selection", true, None));
        }
        if unsafe { element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) }
            .is_ok()
        {
            patterns.push(pattern("Scroll", true, None));
        }
        if unsafe { element.GetCurrentPatternAs::<IUIAutomationWindowPattern>(UIA_WindowPatternId) }
            .is_ok()
        {
            patterns.push(pattern("Window", true, None));
        }
        patterns
    }

    fn pattern(name: &str, available: bool, read_only: Option<bool>) -> UiaPatternDescriptor {
        UiaPatternDescriptor {
            pattern: name.to_string(),
            available,
            read_only,
        }
    }

    fn now_iso_like() -> String {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        format!("unix-ms:{millis}")
    }
}

#[cfg(windows)]
pub use windows_uia::WindowsUiaCapture;
