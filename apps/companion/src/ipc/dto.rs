//! Strict, versioned serde DTOs for the Companion IPC wire protocol. These
//! mirror the TypeScript `@qualigence/desktop-contracts` discriminated union
//! exactly (tag field `type`). Deserialization is the Rust authority that rejects
//! unknown request types and malformed frames before any dispatch.

use serde::de::Error as DeError;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize};

use crate::risk::Risk;

pub const MIN_DEADLINE_MS: u64 = 1;
pub const MIN_APP_TARGET_TIMEOUT_MS: u64 = 0;
pub const MAX_DEADLINE_MS: u64 = 600_000;
pub const MAX_PLAINTEXT_VALUE_BYTES: u64 = 64 * 1024;

pub fn validate_deadline_ms(value: u64) -> Result<u64, String> {
    if (MIN_DEADLINE_MS..=MAX_DEADLINE_MS).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "deadlineMs must be between {MIN_DEADLINE_MS} and {MAX_DEADLINE_MS}"
        ))
    }
}

pub fn validate_app_target_timeout_ms(value: u64) -> Result<u64, String> {
    if (MIN_APP_TARGET_TIMEOUT_MS..=MAX_DEADLINE_MS).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "AppTarget timeoutMs must be between {MIN_APP_TARGET_TIMEOUT_MS} and {MAX_DEADLINE_MS}"
        ))
    }
}

pub fn validate_plaintext_value_byte_length(value: u64) -> Result<u64, String> {
    if value <= MAX_PLAINTEXT_VALUE_BYTES {
        Ok(value)
    } else {
        Err(format!(
            "plaintext value must be at most {MAX_PLAINTEXT_VALUE_BYTES} bytes"
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawResolvedDesktopAction {
    pub target_kind: TargetKind,
    #[serde(flatten)]
    pub kind: DesktopActionKind,
    pub action_id: String,
    pub graph_id: String,
    pub node_id: String,
    pub resolution: DesktopResolution,
    #[serde(default)]
    pub uia_pattern: Option<String>,
}

impl<'de> Deserialize<'de> for ResolvedDesktopAction {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        validate_action_keys(&value).map_err(D::Error::custom)?;
        let raw =
            serde_json::from_value::<RawResolvedDesktopAction>(value).map_err(D::Error::custom)?;
        Ok(Self {
            target_kind: raw.target_kind,
            kind: raw.kind,
            action_id: raw.action_id,
            graph_id: raw.graph_id,
            node_id: raw.node_id,
            resolution: raw.resolution,
            uia_pattern: raw.uia_pattern,
        })
    }
}

fn validate_action_keys(value: &serde_json::Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "action must be an object".to_string())?;
    let kind = object
        .get("kind")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "action.kind must be present".to_string())?;
    let allowed: &[&str] = match kind {
        "click" => &[
            "targetKind",
            "kind",
            "actionId",
            "graphId",
            "nodeId",
            "resolution",
            "uiaPattern",
        ],
        "input" | "select" => &[
            "targetKind",
            "kind",
            "actionId",
            "graphId",
            "nodeId",
            "resolution",
            "uiaPattern",
            "valueRef",
        ],
        "scroll" => &[
            "targetKind",
            "kind",
            "actionId",
            "graphId",
            "nodeId",
            "resolution",
            "uiaPattern",
            "direction",
            "amount",
        ],
        "window" => &[
            "targetKind",
            "kind",
            "actionId",
            "graphId",
            "nodeId",
            "resolution",
            "uiaPattern",
            "windowOperation",
        ],
        _ => return Err("action.kind is unsupported".to_string()),
    };
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("action.{key} is not a known field"));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Desktop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum DesktopActionKind {
    Click,
    Input {
        #[serde(rename = "valueRef")]
        value_ref: String,
    },
    Select {
        #[serde(rename = "valueRef")]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopValueBinding {
    pub value_ref: String,
    pub value_sha256: String,
    pub value_byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawDesktopValueBinding {
    value_ref: String,
    value_sha256: String,
    value_byte_length: u64,
}

impl<'de> Deserialize<'de> for DesktopValueBinding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawDesktopValueBinding::deserialize(deserializer)?;
        validate_plaintext_value_byte_length(raw.value_byte_length).map_err(D::Error::custom)?;
        Ok(Self {
            value_ref: raw.value_ref,
            value_sha256: raw.value_sha256,
            value_byte_length: raw.value_byte_length,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPlaintextValue {
    pub value_ref: String,
    pub value_sha256: String,
    pub value_byte_length: u64,
    pub plaintext: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawDesktopPlaintextValue {
    value_ref: String,
    value_sha256: String,
    value_byte_length: u64,
    plaintext: String,
}

impl<'de> Deserialize<'de> for DesktopPlaintextValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawDesktopPlaintextValue::deserialize(deserializer)?;
        validate_plaintext_value_byte_length(raw.value_byte_length).map_err(D::Error::custom)?;
        validate_plaintext_value_byte_length(raw.plaintext.as_bytes().len() as u64)
            .map_err(D::Error::custom)?;
        Ok(Self {
            value_ref: raw.value_ref,
            value_sha256: raw.value_sha256,
            value_byte_length: raw.value_byte_length,
            plaintext: raw.plaintext,
        })
    }
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

pub const PROTOCOL_MAJOR: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompanionCapabilityProbeRequest {
    pub target_adapter: String,
    pub observation_extension: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppTargetLaunch {
    pub executable: String,
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppTargetProcess {
    pub expected_image_name: String,
    pub allowed_child_image_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppTargetWindow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppTargetReset {
    pub command: String,
    pub args: Vec<String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppTargetShutdown {
    pub graceful_timeout_ms: u64,
    pub force_after_timeout: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopPlatform {
    Windows,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppTarget {
    pub target_id: String,
    pub platform: DesktopPlatform,
    pub launch: AppTargetLaunch,
    pub process: AppTargetProcess,
    pub window: AppTargetWindow,
    pub reset: AppTargetReset,
    pub shutdown: AppTargetShutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCompanionRequestEnvelope {
    protocol_major: u8,
    request_id: String,
    #[serde(rename = "type")]
    request_type: String,
    payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanionRequest {
    pub protocol_major: u8,
    pub request_id: String,
    pub payload: CompanionRequestPayload,
}

impl Serialize for CompanionRequest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("CompanionRequest", 4)?;
        state.serialize_field("protocolMajor", &self.protocol_major)?;
        state.serialize_field("requestId", &self.request_id)?;
        state.serialize_field("type", self.request_type())?;
        self.payload.serialize_payload_field(&mut state)?;
        state.end()
    }
}

impl CompanionRequest {
    pub fn request_type(&self) -> &'static str {
        self.payload.request_type()
    }

    pub fn from_slice(body: &[u8]) -> Result<Self, serde_json::Error> {
        let raw = serde_json::from_slice::<RawCompanionRequestEnvelope>(body)?;
        let payload = CompanionRequestPayload::from_type_and_value(&raw.request_type, raw.payload)?;
        Ok(Self {
            protocol_major: raw.protocol_major,
            request_id: raw.request_id,
            payload,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "payload")]
pub enum CompanionRequestPayload {
    #[serde(rename = "handshake.begin")]
    HandshakeBegin(HandshakeBeginPayload),
    #[serde(rename = "handshake.prove")]
    HandshakeProve(HandshakeProvePayload),
    #[serde(rename = "session.show")]
    SessionShow(SessionShowPayload),
    #[serde(rename = "session.pause")]
    SessionPause(RunIdPayload),
    #[serde(rename = "session.resume")]
    SessionResume(RunIdPayload),
    #[serde(rename = "session.stop")]
    SessionStop(RunIdPayload),
    #[serde(rename = "session.close")]
    SessionClose(RunIdPayload),
    #[serde(rename = "companion.probe")]
    CompanionProbe(CompanionCapabilityProbeRequest),
    #[serde(rename = "app.launch")]
    AppLaunch(AppLaunchPayload),
    #[serde(rename = "app.reset")]
    AppReset(SessionIdPayload),
    #[serde(rename = "app.shutdown")]
    AppShutdown(SessionIdPayload),
    #[serde(rename = "uia.capture")]
    UiaCapture(UiaCapturePayload),
    #[serde(rename = "permit.request")]
    PermitRequest(PermitRequestPayload),
    #[serde(rename = "action.execute")]
    ActionExecute(ActionExecutePayload),
    #[serde(rename = "diagnostics.test")]
    TestDiagnostics(TestDiagnosticsPayload),
}

impl CompanionRequestPayload {
    fn from_type_and_value(
        request_type: &str,
        payload: serde_json::Value,
    ) -> Result<Self, serde_json::Error> {
        Ok(match request_type {
            "handshake.begin" => Self::HandshakeBegin(serde_json::from_value(payload)?),
            "handshake.prove" => Self::HandshakeProve(serde_json::from_value(payload)?),
            "session.show" => Self::SessionShow(serde_json::from_value(payload)?),
            "session.pause" => Self::SessionPause(serde_json::from_value(payload)?),
            "session.resume" => Self::SessionResume(serde_json::from_value(payload)?),
            "session.stop" => Self::SessionStop(serde_json::from_value(payload)?),
            "session.close" => Self::SessionClose(serde_json::from_value(payload)?),
            "companion.probe" => Self::CompanionProbe(serde_json::from_value(payload)?),
            "app.launch" => Self::AppLaunch(serde_json::from_value(payload)?),
            "app.reset" => Self::AppReset(serde_json::from_value(payload)?),
            "app.shutdown" => Self::AppShutdown(serde_json::from_value(payload)?),
            "uia.capture" => Self::UiaCapture(serde_json::from_value(payload)?),
            "permit.request" => Self::PermitRequest(serde_json::from_value(payload)?),
            "action.execute" => Self::ActionExecute(serde_json::from_value(payload)?),
            "diagnostics.test" => Self::TestDiagnostics(serde_json::from_value(payload)?),
            _ => {
                return Err(serde_json::from_str::<serde_json::Value>(
                    "__unknown_companion_request_type__",
                )
                .expect_err("invalid JSON sentinel must fail"))
            }
        })
    }

    pub fn request_type(&self) -> &'static str {
        match self {
            Self::HandshakeBegin(_) => "handshake.begin",
            Self::HandshakeProve(_) => "handshake.prove",
            Self::SessionShow(_) => "session.show",
            Self::SessionPause(_) => "session.pause",
            Self::SessionResume(_) => "session.resume",
            Self::SessionStop(_) => "session.stop",
            Self::SessionClose(_) => "session.close",
            Self::CompanionProbe(_) => "companion.probe",
            Self::AppLaunch(_) => "app.launch",
            Self::AppReset(_) => "app.reset",
            Self::AppShutdown(_) => "app.shutdown",
            Self::UiaCapture(_) => "uia.capture",
            Self::PermitRequest(_) => "permit.request",
            Self::ActionExecute(_) => "action.execute",
            Self::TestDiagnostics(_) => "diagnostics.test",
        }
    }

    fn serialize_payload_field<S>(&self, state: &mut S) -> Result<(), S::Error>
    where
        S: SerializeStruct,
    {
        match self {
            Self::HandshakeBegin(payload) => state.serialize_field("payload", payload),
            Self::HandshakeProve(payload) => state.serialize_field("payload", payload),
            Self::SessionShow(payload) => state.serialize_field("payload", payload),
            Self::SessionPause(payload) => state.serialize_field("payload", payload),
            Self::SessionResume(payload) => state.serialize_field("payload", payload),
            Self::SessionStop(payload) => state.serialize_field("payload", payload),
            Self::SessionClose(payload) => state.serialize_field("payload", payload),
            Self::CompanionProbe(payload) => state.serialize_field("payload", payload),
            Self::AppLaunch(payload) => state.serialize_field("payload", payload),
            Self::AppReset(payload) => state.serialize_field("payload", payload),
            Self::AppShutdown(payload) => state.serialize_field("payload", payload),
            Self::UiaCapture(payload) => state.serialize_field("payload", payload),
            Self::PermitRequest(payload) => state.serialize_field("payload", payload),
            Self::ActionExecute(payload) => state.serialize_field("payload", payload),
            Self::TestDiagnostics(payload) => state.serialize_field("payload", payload),
        }
    }

    pub fn is_handshake(&self) -> bool {
        matches!(self, Self::HandshakeBegin(_) | Self::HandshakeProve(_))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestDiagnosticsPayload {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandshakeBeginPayload {
    pub runner_id: String,
    pub certificate_pem: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandshakeProvePayload {
    pub challenge_id: String,
    pub companion_instance_id: String,
    pub nonce_base64: String,
    pub signature_base64: String,
    pub signature_algorithm: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionShowPayload {
    pub run_id: String,
    pub target_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunIdPayload {
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionIdPayload {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppLaunchPayload {
    pub target: AppTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiaCapturePayload {
    pub session_id: String,
    pub deadline_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermitRequestPayload {
    pub request: LocalPermitRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionExecutePayload {
    pub session_id: String,
    pub action: ResolvedDesktopAction,
    pub permit: LocalExecutionPermit,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<DesktopPlaintextValue>,
    pub deadline_ms: u64,
}
