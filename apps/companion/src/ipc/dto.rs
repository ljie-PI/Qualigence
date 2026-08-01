//! Strict, versioned serde DTOs for the Companion IPC wire protocol. These
//! mirror the TypeScript `@qualigence/desktop-contracts` discriminated union
//! exactly (tag field `type`). Deserialization is the Rust authority that rejects
//! unknown request types and malformed frames before any dispatch.

use serde::{Deserialize, Serialize};

use crate::risk::Risk;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
        option: String,
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
#[serde(rename_all = "camelCase")]
pub struct LocalPermitAuthorization {
    pub decision_id: String,
    pub policy_id: String,
    pub action_digest_sha256: String,
    pub risk: Risk,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalExecutionPermit {
    pub permit_token: String,
    pub nonce_base64: String,
    pub session_id: String,
    pub run_id: String,
    pub action_id: String,
    pub action_digest_sha256: String,
    pub graph_id: String,
    pub risk: Risk,
    pub issued_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(tag = "type")]
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
        signature_base64: String,
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
        deadline_ms: u64,
    },
}
