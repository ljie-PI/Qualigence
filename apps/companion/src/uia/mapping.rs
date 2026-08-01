//! Control-type → generic role mapping and secret masking shared by every UIA
//! capture backend.
//!
//! The numeric `control_type_id` values are the stable Windows UIA
//! `UIA_ControlTypeIds` (see the Microsoft UI Automation Control Type
//! Identifiers). Mapping them to generic roles here means the cross-platform
//! Observation Graph stays platform-neutral while the raw id is still preserved
//! losslessly in the `uia/v1` extension.

/// Well-known UIA control type identifiers used by the reference mapping.
pub mod control_type {
    pub const BUTTON: i32 = 50000;
    pub const EDIT: i32 = 50004;
    pub const HYPERLINK: i32 = 50005;
    pub const IMAGE: i32 = 50006;
    pub const LIST_ITEM: i32 = 50007;
    pub const LIST: i32 = 50008;
    pub const MENU_ITEM: i32 = 50011;
    pub const COMBO_BOX: i32 = 50003;
    pub const CHECK_BOX: i32 = 50002;
    pub const RADIO_BUTTON: i32 = 50013;
    pub const SCROLL_BAR: i32 = 50021;
    pub const TEXT: i32 = 50020;
    pub const WINDOW: i32 = 50032;
    pub const PANE: i32 = 50033;
    pub const GROUP: i32 = 50026;
    pub const DIALOG: i32 = 50010; // ControlType "Group" is 50026; dialogs surface as Window/Pane.
}

/// Map a UIA control type id to a generic, cross-platform role. Unknown ids fall
/// back to a stable `uia:<id>` role so the mapping is never lossy.
pub fn role_for_control_type(control_type_id: i32) -> String {
    match control_type_id {
        control_type::BUTTON => "button",
        control_type::EDIT => "textbox",
        control_type::HYPERLINK => "link",
        control_type::IMAGE => "image",
        control_type::LIST_ITEM => "listitem",
        control_type::LIST => "list",
        control_type::MENU_ITEM => "menuitem",
        control_type::COMBO_BOX => "combobox",
        control_type::CHECK_BOX => "checkbox",
        control_type::RADIO_BUTTON => "radio",
        control_type::SCROLL_BAR => "scrollbar",
        control_type::TEXT => "text",
        control_type::WINDOW => "window",
        control_type::PANE => "pane",
        control_type::GROUP => "group",
        _ => return format!("uia:{control_type_id}"),
    }
    .to_string()
}

/// The value a masked (password/protected) node exposes. The worker replaces the
/// real value with this token *before* the value ever leaves the worker process,
/// so a secret is never framed onto the IPC channel or written to a log.
pub const MASKED_VALUE: &str = "\u{2022}\u{2022}\u{2022}\u{2022}";

/// Mask a node's value if it is a password/protected control.
pub fn masked_value(is_password: bool, value: Option<String>) -> Option<String> {
    if is_password {
        Some(MASKED_VALUE.to_string())
    } else {
        value
    }
}
