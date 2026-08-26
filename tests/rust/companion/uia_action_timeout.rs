//! Companion-brokered desktop action execution (specialist finding W-01): every
//! action consumes a one-time Permit through the Companion BEFORE the worker is
//! ever touched, unsafe actions are never auto-approved, and an action timeout is
//! a non-replayable `ActionOutcomeUnknown`.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use companion::approval::{ApprovalOutcome, ApprovalRequest, ApprovalState, ScriptedApprover};
use companion::clock::ManualClock;
use companion::ipc::dto::{
    DesktopActionKind, DesktopPlaintextValue, DesktopResolution, DesktopValueBinding,
    LocalExecutionPermit, ResolvedDesktopAction, TargetKind, WindowOperation,
};
use companion::permit::{PermitBinding, PermitError, PermitStore};
use companion::risk::Risk;
use companion::uia::action::{
    classify_desktop_action, desktop_action_digest_sha256, execute_desktop_action,
    execute_desktop_action_request, DesktopActionError,
};
use companion::uia::protocol::{ActionOutcomeReport, UiaError, WorkerRequest, WorkerResponse};
use companion::uia::worker_supervisor::{
    UiaWorkerSupervisor, WorkerError, WorkerHandle, WorkerSpawner,
};
use companion::{Companion, PermitRequestOutcome};

/// A worker child scripted with a fixed sequence of per-request results. It also
/// records whether it was ever asked to do anything, so a test can prove that a
/// rejected Permit never reaches the worker.
struct ScriptedHandle {
    responses: VecDeque<Result<WorkerResponse, WorkerError>>,
    alive: bool,
    request_count: Arc<std::sync::atomic::AtomicUsize>,
}

impl WorkerHandle for ScriptedHandle {
    fn request(
        &mut self,
        _req: &WorkerRequest,
        _deadline: Duration,
    ) -> Result<WorkerResponse, WorkerError> {
        self.request_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        match self.responses.pop_front() {
            Some(Ok(response)) => Ok(response),
            Some(Err(err)) => {
                self.alive = false;
                Err(err)
            }
            None => {
                self.alive = false;
                Err(WorkerError::Closed)
            }
        }
    }

    fn kill(&mut self) {
        self.alive = false;
    }

    fn is_alive(&self) -> bool {
        self.alive
    }
}

struct ScriptedSpawner {
    scripts: VecDeque<VecDeque<Result<WorkerResponse, WorkerError>>>,
    request_count: Arc<std::sync::atomic::AtomicUsize>,
}

impl ScriptedSpawner {
    fn new(
        scripts: impl IntoIterator<Item = Vec<Result<WorkerResponse, WorkerError>>>,
        request_count: Arc<std::sync::atomic::AtomicUsize>,
    ) -> Self {
        Self {
            scripts: scripts
                .into_iter()
                .map(|s| s.into_iter().collect())
                .collect(),
            request_count,
        }
    }
}

impl WorkerSpawner for ScriptedSpawner {
    type Handle = ScriptedHandle;

    fn spawn(&mut self) -> Result<Self::Handle, WorkerError> {
        match self.scripts.pop_front() {
            Some(responses) => Ok(ScriptedHandle {
                responses,
                alive: true,
                request_count: Arc::clone(&self.request_count),
            }),
            None => Err(WorkerError::Spawn),
        }
    }
}

fn click_action(action_id: &str) -> ResolvedDesktopAction {
    ResolvedDesktopAction {
        target_kind: TargetKind::Desktop,
        kind: DesktopActionKind::Click,
        action_id: action_id.into(),
        graph_id: "graph-1".into(),
        node_id: "button".into(),
        resolution: DesktopResolution::Semantic,
        uia_pattern: Some("Invoke".into()),
    }
}

fn binding_for(action_id: &str, risk: Risk) -> PermitBinding {
    PermitBinding {
        session_id: "sess-1".into(),
        run_id: "run-1".into(),
        action_id: action_id.into(),
        action_digest_sha256: "a".repeat(64),
        graph_id: "graph-1".into(),
        risk,
    }
}

fn approval_for(action_id: &str, risk: Risk) -> ApprovalRequest {
    ApprovalRequest {
        approval_id: format!("ap-{action_id}"),
        session_id: "sess-1".into(),
        run_id: "run-1".into(),
        action_id: action_id.into(),
        risk,
        safe_summary: "desktop action".into(),
    }
}

fn companion_with(approver: ScriptedApprover) -> Companion<ManualClock, ScriptedApprover> {
    let clock = Arc::new(ManualClock::new(1_000));
    let approval = ApprovalState::new("run-1", approver);
    let permits = PermitStore::new(clock, 30_000);
    Companion::new("sess-1", approval, permits)
}

#[test]
fn desktop_action_risk_classification_matches_the_safety_model() {
    // Read-only-ish interactions auto-approve; state change needs approval; a
    // window close is destructive.
    assert_eq!(classify_desktop_action(&click_action("a")), Risk::Normal);

    let mut input = click_action("b");
    input.kind = DesktopActionKind::Input {
        value_ref: "secret-ref".into(),
    };
    assert_eq!(classify_desktop_action(&input), Risk::ExternalSideEffect);

    let mut close = click_action("c");
    close.kind = DesktopActionKind::Window {
        window_operation: WindowOperation::Close,
    };
    assert_eq!(classify_desktop_action(&close), Risk::Destructive);

    let mut focus = click_action("d");
    focus.kind = DesktopActionKind::Window {
        window_operation: WindowOperation::Focus,
    };
    assert_eq!(classify_desktop_action(&focus), Risk::Normal);
}

#[test]
fn a_brokered_action_consumes_its_permit_then_reaches_the_worker() {
    let request_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let spawner = ScriptedSpawner::new(
        vec![vec![Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })]],
        Arc::clone(&request_count),
    );
    let mut supervisor = UiaWorkerSupervisor::new(spawner);

    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));
    let binding = binding_for("act-1", Risk::Normal);
    let token =
        match companion.request_permit(&approval_for("act-1", Risk::Normal), binding.clone()) {
            PermitRequestOutcome::Issued(permit) => permit.token,
            other => panic!("expected permit issue, got {other:?}"),
        };

    let outcome = execute_desktop_action(
        &mut companion,
        &mut supervisor,
        "sess-1",
        &click_action("act-1"),
        &token,
        &binding,
        Duration::from_millis(50),
    )
    .expect("brokered action succeeds");
    assert_eq!(outcome, ActionOutcomeReport::Ok);
    assert_eq!(request_count.load(std::sync::atomic::Ordering::SeqCst), 1);

    // The Permit is one-time: replaying the token is rejected and the worker is
    // never touched again.
    let request_count_before = request_count.load(std::sync::atomic::Ordering::SeqCst);
    let replay = execute_desktop_action(
        &mut companion,
        &mut supervisor,
        "sess-1",
        &click_action("act-1"),
        &token,
        &binding,
        Duration::from_millis(50),
    );
    assert_eq!(
        replay,
        Err(DesktopActionError::Permit(PermitError::AlreadyConsumed))
    );
    assert_eq!(
        request_count.load(std::sync::atomic::Ordering::SeqCst),
        request_count_before,
        "a rejected Permit must never reach the worker"
    );
}

#[test]
fn a_rejected_permit_never_reaches_the_worker() {
    let request_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    // A worker that would succeed if ever asked — but it must never be asked.
    let spawner = ScriptedSpawner::new(
        vec![vec![Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })]],
        Arc::clone(&request_count),
    );
    let mut supervisor = UiaWorkerSupervisor::new(spawner);

    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));
    let binding = binding_for("act-1", Risk::Normal);
    // No Permit is ever issued: authorize_action fails closed.
    let result = execute_desktop_action(
        &mut companion,
        &mut supervisor,
        "sess-1",
        &click_action("act-1"),
        "forged-token",
        &binding,
        Duration::from_millis(50),
    );
    assert_eq!(
        result,
        Err(DesktopActionError::Permit(PermitError::UnknownToken))
    );
    assert_eq!(
        request_count.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "no Permit means no worker dispatch"
    );
}

#[test]
fn destructive_actions_are_never_auto_approved() {
    // A destructive (window close) action with a scripted DENY is refused at the
    // approval gate, so no Permit is ever minted.
    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Denied));
    let mut close = click_action("act-close");
    close.kind = DesktopActionKind::Window {
        window_operation: WindowOperation::Close,
    };
    let risk = classify_desktop_action(&close);
    assert_eq!(risk, Risk::Destructive);

    let outcome = companion.request_permit(
        &approval_for("act-close", risk),
        binding_for("act-close", risk),
    );
    match outcome {
        PermitRequestOutcome::Rejected(_) => {}
        PermitRequestOutcome::Issued(_) => {
            panic!("a destructive action must never be auto-approved")
        }
    }
}

#[test]
fn an_emergency_stop_blocks_a_brokered_action_before_the_worker() {
    let request_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let spawner = ScriptedSpawner::new(
        vec![vec![Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })]],
        Arc::clone(&request_count),
    );
    let mut supervisor = UiaWorkerSupervisor::new(spawner);

    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));
    let binding = binding_for("act-1", Risk::Normal);
    let token =
        match companion.request_permit(&approval_for("act-1", Risk::Normal), binding.clone()) {
            PermitRequestOutcome::Issued(permit) => permit.token,
            other => panic!("expected permit issue, got {other:?}"),
        };

    // Emergency Stop invalidates every live Permit and latches the deny state.
    companion.emergency_stop();
    let result = execute_desktop_action(
        &mut companion,
        &mut supervisor,
        "sess-1",
        &click_action("act-1"),
        &token,
        &binding,
        Duration::from_millis(50),
    );
    assert!(matches!(result, Err(DesktopActionError::Permit(_))));
    assert_eq!(
        request_count.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "an emergency-stopped action must never reach the worker"
    );
}

#[test]
fn an_action_timeout_is_a_non_replayable_unknown_outcome() {
    let request_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    // The worker hangs on the action; the supervisor kills it and reports the
    // outcome as unknown — the side effect may already have happened.
    let spawner = ScriptedSpawner::new(
        vec![vec![Err(WorkerError::Timeout)]],
        Arc::clone(&request_count),
    );
    let mut supervisor = UiaWorkerSupervisor::new(spawner);

    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));
    let binding = binding_for("act-1", Risk::Normal);
    let token =
        match companion.request_permit(&approval_for("act-1", Risk::Normal), binding.clone()) {
            PermitRequestOutcome::Issued(permit) => permit.token,
            other => panic!("expected permit issue, got {other:?}"),
        };

    let result = execute_desktop_action(
        &mut companion,
        &mut supervisor,
        "sess-1",
        &click_action("act-1"),
        &token,
        &binding,
        Duration::from_millis(10),
    );
    assert_eq!(
        result,
        Err(DesktopActionError::Uia(UiaError::ActionOutcomeUnknown))
    );
    // The worker was recycled; there is no automatic retry.
    assert_eq!(supervisor.restart_count(), 1);
    assert_eq!(request_count.load(std::sync::atomic::Ordering::SeqCst), 1);
}

fn input_action(action_id: &str, value_ref: &str) -> ResolvedDesktopAction {
    let mut action = click_action(action_id);
    action.kind = DesktopActionKind::Input {
        value_ref: value_ref.to_string(),
    };
    action.uia_pattern = Some("Value".to_string());
    action
}

fn local_execution_permit(
    token: String,
    action: &ResolvedDesktopAction,
    binding: &PermitBinding,
    value_binding: Option<DesktopValueBinding>,
) -> LocalExecutionPermit {
    let decision_id = "decision:act".to_string();
    let policy_id = "policy:desktop".to_string();
    let nonce_base64 = "nonce".to_string();
    let expires_at = "2026-08-02T00:01:00.000Z".to_string();
    LocalExecutionPermit {
        permit_token: token,
        nonce_base64: nonce_base64.clone(),
        session_id: binding.session_id.clone(),
        run_id: binding.run_id.clone(),
        action_id: action.action_id.clone(),
        action_digest_sha256: desktop_action_digest_sha256(
            &binding.session_id,
            &binding.run_id,
            action,
            &decision_id,
            &policy_id,
            binding.risk,
            &expires_at,
            &nonce_base64,
            value_binding.as_ref(),
        ),
        graph_id: action.graph_id.clone(),
        decision_id,
        policy_id,
        risk: binding.risk,
        issued_at: "2026-08-02T00:00:00.000Z".to_string(),
        expires_at,
        value_binding,
    }
}

#[test]
fn action_execute_revalidates_value_digest_before_consuming_or_dispatching() {
    let request_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let spawner = ScriptedSpawner::new(
        vec![vec![Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })]],
        Arc::clone(&request_count),
    );
    let mut supervisor = UiaWorkerSupervisor::new(spawner);
    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));
    let action = input_action("act-input", "secret-ref");
    let mut binding = binding_for("act-input", Risk::ExternalSideEffect);
    let value_binding = DesktopValueBinding {
        value_ref: "secret-ref".to_string(),
        value_sha256: "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b"
            .to_string(),
        value_byte_length: 6,
    };
    let digest = desktop_action_digest_sha256(
        &binding.session_id,
        &binding.run_id,
        &action,
        "decision:act",
        "policy:desktop",
        binding.risk,
        "2026-08-02T00:01:00.000Z",
        "nonce",
        Some(&value_binding),
    );
    assert_eq!(
        digest,
        "dac280eb961c48c285e87e882574fbf662c2a6ac8c1eb9f75b1e180eed2981f5"
    );
    binding.action_digest_sha256 = digest;
    let token = match companion.request_permit(
        &approval_for("act-input", Risk::ExternalSideEffect),
        binding.clone(),
    ) {
        PermitRequestOutcome::Issued(permit) => permit.token,
        other => panic!("expected permit issue, got {other:?}"),
    };

    let bad_permit = local_execution_permit(
        token.clone(),
        &action,
        &binding,
        Some(DesktopValueBinding {
            value_ref: "secret-ref".to_string(),
            value_sha256: "0".repeat(64),
            value_byte_length: 6,
        }),
    );
    let bad_value = DesktopPlaintextValue {
        value_ref: "secret-ref".to_string(),
        value_sha256: "0".repeat(64),
        value_byte_length: 6,
        plaintext: "secret".to_string(),
    };
    assert_eq!(
        execute_desktop_action_request(
            &mut companion,
            &mut supervisor,
            "sess-1",
            &action,
            &bad_permit,
            Some(bad_value),
            &binding,
            Duration::from_millis(50),
        ),
        Err(DesktopActionError::BindingMismatch)
    );
    assert_eq!(request_count.load(std::sync::atomic::Ordering::SeqCst), 0);

    let good_hash = "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b";
    let good_permit = local_execution_permit(token, &action, &binding, Some(value_binding));
    let good_value = DesktopPlaintextValue {
        value_ref: "secret-ref".to_string(),
        value_sha256: good_hash.to_string(),
        value_byte_length: 6,
        plaintext: "secret".to_string(),
    };
    assert_eq!(
        execute_desktop_action_request(
            &mut companion,
            &mut supervisor,
            "sess-1",
            &action,
            &good_permit,
            Some(good_value),
            &binding,
            Duration::from_millis(50),
        ),
        Ok(ActionOutcomeReport::Ok)
    );
    assert_eq!(request_count.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
fn unsupported_uia_pattern_is_reported_without_fallback() {
    let request_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let spawner = ScriptedSpawner::new(
        vec![vec![Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })]],
        Arc::clone(&request_count),
    );
    let mut supervisor = UiaWorkerSupervisor::new(spawner);
    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));
    let mut action = click_action("act-unsupported");
    action.uia_pattern = Some("Value".to_string());
    let binding = binding_for("act-unsupported", Risk::Normal);
    let token = match companion.request_permit(
        &approval_for("act-unsupported", Risk::Normal),
        binding.clone(),
    ) {
        PermitRequestOutcome::Issued(permit) => permit.token,
        other => panic!("expected permit issue, got {other:?}"),
    };

    assert_eq!(
        execute_desktop_action(
            &mut companion,
            &mut supervisor,
            "sess-1",
            &action,
            &token,
            &binding,
            Duration::from_millis(50),
        ),
        Err(DesktopActionError::Uia(UiaError::Reported(
            "UiaPatternUnsupported".to_string()
        )))
    );
    assert_eq!(request_count.load(std::sync::atomic::Ordering::SeqCst), 0);
}
