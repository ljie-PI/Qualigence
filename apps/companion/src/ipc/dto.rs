//! Strict, versioned serde DTOs for the Companion IPC wire protocol. These
//! mirror the TypeScript `@qualigence/desktop-contracts` discriminated union
//! exactly (tag field `type`). Deserialization is the Rust authority that rejects
//! unknown request types and malformed frames before any dispatch.

use serde::{Deserialize, Serialize};

use crate::risk::Risk;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedDesktopAction {
    pub target_kind: TargetKind,
    #[serde(flatten)]
    pub kind: DesktopActionKind,
    pub action_id: String,
    pub graph_id: String,
    pub node_id: String,
    pub resolution: DesktopResolution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uia_pattern: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Desktop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DesktopActionKind {
    Click,
    Input {
        value_ref: String,
    },
    Select {
        value_ref: String,
    },
    Scroll {
        direction: ScrollDirection,
        amount: ScrollAmount,
    },
    Window {
        window_operation: WindowOperation,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollAmount {
    Page,
    Small,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowOperation {
    Focus,
    Minimize,
    Restore,
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DesktopResolution {
    #[serde(rename = "semantic")]
    Semantic,
    #[serde(rename = "uia")]
    Uia,
    #[serde(rename = "visual")]
    Visual,
    #[serde(rename = "coordinate")]
    Coordinate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalPermitAuthorization {
    pub decision_id: String,
    pub policy_id: String,
    pub action_digest_sha256: String,
    pub risk: Risk,
    pub expires_at: String,
    pub nonce_base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_binding: Option<DesktopValueBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopValueBinding {
    pub value_ref: String,
    pub value_sha256: String,
    pub value_byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopPlaintextValue {
    pub value_ref: String,
    pub value_sha256: String,
    pub value_byte_length: u64,
    pub plaintext: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalExecutionPermit {
    pub permit_token: String,
    pub nonce_base64: String,
    pub session_id: String,
    pub run_id: String,
    pub action_id: String,
    pub action_digest_sha256: String,
    pub graph_id: String,
    pub decision_id: String,
    pub policy_id: String,
    pub risk: Risk,
    pub issued_at: String,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_binding: Option<DesktopValueBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalPermitRequest {
    pub approval_id: String,
    pub session_id: String,
    pub run_id: String,
    pub action: ResolvedDesktopAction,
    pub authorization: LocalPermitAuthorization,
    pub safe_summary: String,
    pub expires_at: String,
}

/// The Companion IPC request union. `type` is the discriminant; any value not in
/// this set fails deserialization (unknown request type rejected).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum CompanionRequest {
    #[serde(rename = "handshake.begin", rename_all = "camelCase")]
    HandshakeBegin {
        protocol_major: u8,
        runner_id: String,
        certificate_pem: String,
    },
    #[serde(rename = "handshake.prove", rename_all = "camelCase")]
    HandshakeProve {
        challenge_id: String,
        companion_instance_id: String,
        nonce_base64: String,
        signature_base64: String,
        signature_algorithm: String,
    },
    #[serde(rename = "session.show", rename_all = "camelCase")]
    SessionShow { run_id: String, target_name: String },
    #[serde(rename = "session.pause", rename_all = "camelCase")]
    SessionPause { run_id: String },
    #[serde(rename = "session.resume", rename_all = "camelCase")]
    SessionResume { run_id: String },
    #[serde(rename = "session.stop", rename_all = "camelCase")]
    SessionStop { run_id: String },
    #[serde(rename = "session.close", rename_all = "camelCase")]
    SessionClose { run_id: String },
    #[serde(rename = "app.reset", rename_all = "camelCase")]
    AppReset { session_id: String },
    #[serde(rename = "app.shutdown", rename_all = "camelCase")]
    AppShutdown { session_id: String },
    #[serde(rename = "uia.capture", rename_all = "camelCase")]
    UiaCapture {
        session_id: String,
        deadline_ms: u64,
    },
    #[serde(rename = "permit.request", rename_all = "camelCase")]
    PermitRequest { request: LocalPermitRequest },
    #[serde(rename = "action.execute", rename_all = "camelCase")]
    ActionExecute {
        session_id: String,
        action: ResolvedDesktopAction,
        permit: LocalExecutionPermit,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<DesktopPlaintextValue>,
        deadline_ms: u64,
    },
}
