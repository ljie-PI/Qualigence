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
use crate::ipc::dto::{
    DesktopActionKind, DesktopPlaintextValue, LocalExecutionPermit, ResolvedDesktopAction,
    WindowOperation,
};
use crate::permit::{PermitBinding, PermitError};
use crate::risk::Risk;
use crate::uia::protocol::{ActionOutcomeReport, UiaError, UiaSessionTarget};
use crate::uia::worker::action_pattern_is_supported;
use crate::uia::worker_supervisor::{UiaWorkerSupervisor, WorkerSpawner};
use crate::Companion;
use sha2::{Digest, Sha256};

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
    /// The presented LocalExecutionPermit, action digest, or plaintext value
    /// binding did not match. No worker dispatch occurred.
    BindingMismatch,
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
    target: &UiaSessionTarget,
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
    if target.session_id != binding.session_id {
        return Err(DesktopActionError::BindingMismatch);
    }

    if !action_pattern_is_supported(action) {
        return Err(DesktopActionError::Uia(UiaError::Reported(
            "UiaPatternUnsupported".to_string(),
        )));
    }

    companion
        .authorize_action(permit_token, binding)
        .map_err(DesktopActionError::Permit)?;

    supervisor
        .execute(target, action, None, deadline)
        .map_err(DesktopActionError::Uia)
}

/// A validated action request whose Permit has been atomically consumed before
/// the caller may dispatch it to the UIA worker.
pub struct PreparedDesktopActionRequest {
    pub value: Option<DesktopPlaintextValue>,
}

impl PreparedDesktopActionRequest {
    pub fn clear_plaintext(&mut self) {
        clear_plaintext(&mut self.value);
    }
}

impl Drop for PreparedDesktopActionRequest {
    fn drop(&mut self) {
        self.clear_plaintext();
    }
}

/// Revalidate an `action.execute` IPC request and atomically consume its
/// one-use Permit. Callers that need concurrent daemon control handling can drop
/// their Companion lock after this returns and before blocking on the worker.
pub fn prepare_desktop_action_request<C, A>(
    companion: &mut Companion<C, A>,
    target: &UiaSessionTarget,
    action: &ResolvedDesktopAction,
    permit: &LocalExecutionPermit,
    mut value: Option<DesktopPlaintextValue>,
    binding: &PermitBinding,
) -> Result<PreparedDesktopActionRequest, DesktopActionError>
where
    C: Clock,
    A: Approver,
{
    if !permit_matches_action(&target.session_id, action, permit, binding)
        || !value_matches_permit(action, permit, value.as_ref())
    {
        clear_plaintext(&mut value);
        return Err(DesktopActionError::BindingMismatch);
    }

    if !action_pattern_is_supported(action) {
        clear_plaintext(&mut value);
        return Err(DesktopActionError::Uia(UiaError::Reported(
            "UiaPatternUnsupported".to_string(),
        )));
    }

    let consume = companion
        .authorize_action(&permit.permit_token, binding)
        .map_err(DesktopActionError::Permit);
    if let Err(error) = consume {
        clear_plaintext(&mut value);
        return Err(error);
    }

    Ok(PreparedDesktopActionRequest { value })
}

/// Execute an `action.execute` IPC request. This revalidates the complete local
/// Permit/action/value envelope before atomically consuming the one-use Permit,
/// then clears any plaintext buffer after every outcome.
pub fn execute_desktop_action_request<C, A, S>(
    companion: &mut Companion<C, A>,
    supervisor: &mut UiaWorkerSupervisor<S>,
    target: &UiaSessionTarget,
    action: &ResolvedDesktopAction,
    permit: &LocalExecutionPermit,
    value: Option<DesktopPlaintextValue>,
    binding: &PermitBinding,
    deadline: Duration,
) -> Result<ActionOutcomeReport, DesktopActionError>
where
    C: Clock,
    A: Approver,
    S: WorkerSpawner,
{
    let mut prepared =
        prepare_desktop_action_request(companion, target, action, permit, value, binding)?;

    let outcome = supervisor
        .execute(target, action, prepared.value.as_ref(), deadline)
        .map_err(DesktopActionError::Uia);
    clear_plaintext(&mut prepared.value);
    outcome
}

fn permit_matches_action(
    session_id: &str,
    action: &ResolvedDesktopAction,
    permit: &LocalExecutionPermit,
    binding: &PermitBinding,
) -> bool {
    permit.session_id == session_id
        && permit.session_id == binding.session_id
        && permit.run_id == binding.run_id
        && permit.action_id == binding.action_id
        && permit.action_id == action.action_id
        && permit.action_digest_sha256 == binding.action_digest_sha256
        && permit.action_digest_sha256
            == desktop_action_digest_sha256(
                &permit.session_id,
                &permit.run_id,
                action,
                &permit.decision_id,
                &permit.policy_id,
                permit.risk,
                &permit.expires_at,
                &permit.nonce_base64,
                permit.value_binding.as_ref(),
            )
        && permit.graph_id == binding.graph_id
        && permit.graph_id == action.graph_id
        && permit.risk == binding.risk
        && !permit.permit_token.is_empty()
        && !permit.nonce_base64.is_empty()
        && !permit.decision_id.is_empty()
        && !permit.policy_id.is_empty()
        && !permit.issued_at.is_empty()
        && !permit.expires_at.is_empty()
}

fn value_matches_permit(
    action: &ResolvedDesktopAction,
    permit: &LocalExecutionPermit,
    value: Option<&DesktopPlaintextValue>,
) -> bool {
    let action_value_ref = match &action.kind {
        DesktopActionKind::Input { value_ref } | DesktopActionKind::Select { value_ref } => {
            Some(value_ref)
        }
        _ => None,
    };
    match (action_value_ref, permit.value_binding.as_ref(), value) {
        (None, None, None) => true,
        (Some(action_ref), Some(binding), Some(value)) => {
            action_ref == &binding.value_ref
                && value.value_ref == binding.value_ref
                && value.value_sha256 == binding.value_sha256
                && value.value_byte_length == binding.value_byte_length
                && value.value_byte_length == value.plaintext.as_bytes().len() as u64
                && sha256_hex(value.plaintext.as_bytes()) == binding.value_sha256
        }
        _ => false,
    }
}

fn clear_plaintext(value: &mut Option<DesktopPlaintextValue>) {
    if let Some(value) = value.as_mut() {
        value.plaintext.clear();
    }
}

pub fn desktop_action_digest_sha256(
    session_id: &str,
    run_id: &str,
    action: &ResolvedDesktopAction,
    decision_id: &str,
    policy_id: &str,
    risk: Risk,
    expires_at: &str,
    nonce_base64: &str,
    value_binding: Option<&crate::ipc::dto::DesktopValueBinding>,
) -> String {
    let mut object = serde_json::Map::new();
    object.insert(
        "schema".to_string(),
        serde_json::Value::String("qualigence-desktop-action-digest/v1".to_string()),
    );
    object.insert(
        "sessionId".to_string(),
        serde_json::Value::String(session_id.to_string()),
    );
    object.insert(
        "runId".to_string(),
        serde_json::Value::String(run_id.to_string()),
    );
    object.insert(
        "action".to_string(),
        serde_json::to_value(action).unwrap_or(serde_json::Value::Null),
    );
    object.insert(
        "decisionId".to_string(),
        serde_json::Value::String(decision_id.to_string()),
    );
    object.insert(
        "policyId".to_string(),
        serde_json::Value::String(policy_id.to_string()),
    );
    object.insert(
        "risk".to_string(),
        serde_json::to_value(risk).unwrap_or(serde_json::Value::Null),
    );
    object.insert(
        "expiresAt".to_string(),
        serde_json::Value::String(expires_at.to_string()),
    );
    object.insert(
        "nonceBase64".to_string(),
        serde_json::Value::String(nonce_base64.to_string()),
    );
    if let Some(value_binding) = value_binding {
        object.insert(
            "valueBinding".to_string(),
            serde_json::to_value(value_binding).unwrap_or(serde_json::Value::Null),
        );
    }
    sha256_hex(canonicalize_json(&serde_json::Value::Object(object)).as_bytes())
}

fn canonicalize_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => {
            serde_json::to_string(value).expect("string serializes")
        }
        serde_json::Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonicalize_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        serde_json::Value::Object(map) => {
            let mut entries = map
                .iter()
                .filter(|(_, value)| !value.is_null())
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("key serializes"),
                        canonicalize_json(value)
                    )
                })
                .collect::<Vec<_>>();
            entries.sort();
            format!("{{{}}}", entries.join(","))
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}
