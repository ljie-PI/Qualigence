//! Companion-brokered desktop action execution (specialist finding W-01): every
//! action consumes a one-time Permit through the Companion BEFORE the worker is
//! ever touched, unsafe actions are never auto-approved, and an action timeout is
//! a non-replayable `ActionOutcomeUnknown`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use companion::approval::{ApprovalOutcome, ApprovalRequest, ApprovalState, ScriptedApprover};
use companion::clock::ManualClock;
use companion::ipc::dto::{
    DesktopActionKind, DesktopPlaintextValue, DesktopResolution, DesktopValueBinding,
    LocalExecutionPermit, ResolvedDesktopAction, TargetKind, WindowOperation,
};
use companion::permit::{PermitBinding, PermitError, PermitStore};
use companion::process::job_object::AppWindowSelector;
use companion::risk::Risk;
use companion::uia::action::{
    authorization_risk_covers_action, classify_desktop_action, desktop_action_digest_sha256,
    ensure_companion_accepts_uia_work, execute_desktop_action, execute_desktop_action_request,
    execute_desktop_action_request_before_deadline, DesktopActionError,
};
use companion::uia::protocol::{
    ActionOutcomeReport, UiaError, UiaSessionTarget, WorkerRequest, WorkerResponse,
};
use companion::uia::worker_supervisor::{
    RequestDeadline, UiaWorkerSupervisor, WorkerCancellationCheckpoint, WorkerError, WorkerHandle,
    WorkerSpawner,
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
        _cancellation: &WorkerCancellationCheckpoint,
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

struct ConcurrentHandle {
    request_count: Arc<AtomicUsize>,
    release_first: Arc<AtomicBool>,
    alive: bool,
}

impl WorkerHandle for ConcurrentHandle {
    fn request(
        &mut self,
        _req: &WorkerRequest,
        deadline: Duration,
        cancellation: &WorkerCancellationCheckpoint,
    ) -> Result<WorkerResponse, WorkerError> {
        let index = self.request_count.fetch_add(1, Ordering::SeqCst);
        if index == 0 {
            let started = std::time::Instant::now();
            while !self.release_first.load(Ordering::SeqCst) {
                if cancellation.is_cancelled() {
                    self.kill();
                    return Err(WorkerError::Cancelled);
                }
                if started.elapsed() >= deadline {
                    self.kill();
                    return Err(WorkerError::Timeout);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            if cancellation.is_cancelled() {
                self.kill();
                return Err(WorkerError::Cancelled);
            }
        }
        Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })
    }

    fn kill(&mut self) {
        self.alive = false;
    }

    fn is_alive(&self) -> bool {
        self.alive
    }
}

struct ConcurrentSpawner {
    request_count: Arc<AtomicUsize>,
    release_first: Arc<AtomicBool>,
}

impl WorkerSpawner for ConcurrentSpawner {
    type Handle = ConcurrentHandle;

    fn spawn(&mut self) -> Result<Self::Handle, WorkerError> {
        Ok(ConcurrentHandle {
            request_count: Arc::clone(&self.request_count),
            release_first: Arc::clone(&self.release_first),
            alive: true,
        })
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

fn target() -> UiaSessionTarget {
    UiaSessionTarget {
        session_id: "sess-1".into(),
        process_id: 4242,
        root_window_handle: "0x10".into(),
        window_selector: AppWindowSelector::default(),
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
fn policy_escalated_click_risk_is_authorized_but_downgrades_are_rejected() {
    let click = click_action("act-delete-all");
    assert_eq!(classify_desktop_action(&click), Risk::Normal);
    assert!(authorization_risk_covers_action(
        &click,
        Risk::ExternalSideEffect
    ));
    assert!(authorization_risk_covers_action(&click, Risk::Destructive));
    assert!(authorization_risk_covers_action(
        &click,
        Risk::ProductionForbidden
    ));

    let mut input = click_action("act-input");
    input.kind = DesktopActionKind::Input {
        value_ref: "secret-ref".into(),
    };
    assert!(!authorization_risk_covers_action(&input, Risk::Normal));
    assert!(authorization_risk_covers_action(
        &input,
        Risk::ExternalSideEffect
    ));
    assert!(authorization_risk_covers_action(&input, Risk::Destructive));

    let mut close = click_action("act-close");
    close.kind = DesktopActionKind::Window {
        window_operation: WindowOperation::Close,
    };
    assert!(!authorization_risk_covers_action(&close, Risk::Normal));
    assert!(!authorization_risk_covers_action(
        &close,
        Risk::ExternalSideEffect
    ));
    assert!(authorization_risk_covers_action(&close, Risk::Destructive));
}

#[test]
fn approved_policy_escalated_click_consumes_permit_and_executes() {
    let request_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let spawner = ScriptedSpawner::new(
        vec![vec![Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })]],
        Arc::clone(&request_count),
    );
    let mut supervisor = UiaWorkerSupervisor::new(spawner);
    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));
    let action = click_action("act-delete-all");
    let binding = binding_for("act-delete-all", Risk::Destructive);
    let token = match companion.request_permit(
        &approval_for("act-delete-all", Risk::Destructive),
        binding.clone(),
    ) {
        PermitRequestOutcome::Issued(permit) => permit.token,
        other => panic!("expected policy-escalated permit issue, got {other:?}"),
    };

    let outcome = execute_desktop_action(
        &mut companion,
        &mut supervisor,
        &target(),
        &action,
        &token,
        &binding,
        Duration::from_millis(50),
    )
    .expect("approved policy-escalated click executes");

    assert_eq!(outcome, ActionOutcomeReport::Ok);
    assert_eq!(request_count.load(std::sync::atomic::Ordering::SeqCst), 1);
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
        &target(),
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
        &target(),
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
        &target(),
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
fn emergency_stopped_session_denies_new_capture_work() {
    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));

    companion.emergency_stop();

    assert_eq!(
        ensure_companion_accepts_uia_work(&companion),
        Err(UiaError::EmergencyStopped)
    );

    companion.reset_session("sess-2");
    assert_eq!(ensure_companion_accepts_uia_work(&companion), Ok(()));
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
        &target(),
        &click_action("act-1"),
        &token,
        &binding,
        Duration::from_millis(50),
    );
    assert_eq!(
        result,
        Err(DesktopActionError::Permit(PermitError::EmergencyStopped))
    );
    assert_eq!(
        request_count.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "an emergency-stopped action must never reach the worker"
    );
}

#[test]
fn action_execute_after_emergency_stop_surfaces_the_stable_latch_reason() {
    let request_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let spawner = ScriptedSpawner::new(
        vec![vec![Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })]],
        Arc::clone(&request_count),
    );
    let mut supervisor = UiaWorkerSupervisor::new(spawner);
    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));
    let action = click_action("act-stop");
    let mut binding = binding_for("act-stop", Risk::Normal);
    let permit = local_execution_permit("permit-stop".to_string(), &action, &binding, None);
    binding.action_digest_sha256 = permit.action_digest_sha256.clone();
    let token =
        match companion.request_permit(&approval_for("act-stop", Risk::Normal), binding.clone()) {
            PermitRequestOutcome::Issued(issued) => issued.token,
            other => panic!("expected permit issue, got {other:?}"),
        };
    let permit = LocalExecutionPermit {
        permit_token: token,
        ..permit
    };

    companion.emergency_stop();
    assert_eq!(
        execute_desktop_action_request(
            &mut companion,
            &mut supervisor,
            &target(),
            &action,
            &permit,
            None,
            &binding,
            Duration::from_millis(50),
        ),
        Err(DesktopActionError::Permit(PermitError::EmergencyStopped))
    );
    assert_eq!(request_count.load(std::sync::atomic::Ordering::SeqCst), 0);
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
        &target(),
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

#[test]
fn concurrent_action_requests_wait_for_supervisor_without_consuming_late_permits() {
    let request_count = Arc::new(AtomicUsize::new(0));
    let release_first = Arc::new(AtomicBool::new(false));
    let supervisor = Arc::new(Mutex::new(UiaWorkerSupervisor::new(ConcurrentSpawner {
        request_count: Arc::clone(&request_count),
        release_first: Arc::clone(&release_first),
    })));
    let cancellation = supervisor
        .lock()
        .expect("supervisor lock")
        .cancellation_handle();
    let companion = Arc::new(Mutex::new(companion_with(ScriptedApprover::always(
        ApprovalOutcome::Approved,
    ))));
    let action_one = click_action("act-concurrent-1");
    let action_two = click_action("act-concurrent-2");
    let mut binding_one = binding_for("act-concurrent-1", Risk::Normal);
    let mut binding_two = binding_for("act-concurrent-2", Risk::Normal);
    let permit_one = issue_local_execution_permit(
        &mut companion.lock().expect("companion lock"),
        &action_one,
        &mut binding_one,
        None,
    );
    let permit_two = issue_local_execution_permit(
        &mut companion.lock().expect("companion lock"),
        &action_two,
        &mut binding_two,
        None,
    );

    let first_companion = Arc::clone(&companion);
    let first_supervisor = Arc::clone(&supervisor);
    let first_checkpoint = cancellation.checkpoint();
    let first = std::thread::spawn(move || {
        execute_desktop_action_request_before_deadline(
            &first_companion,
            &first_supervisor,
            &first_checkpoint,
            &target(),
            &action_one,
            &permit_one,
            None,
            &binding_one,
            &RequestDeadline::after(Duration::from_millis(1_000)),
        )
    });

    while request_count.load(Ordering::SeqCst) == 0 {
        std::thread::sleep(Duration::from_millis(1));
    }

    let second_companion = Arc::clone(&companion);
    let second_supervisor = Arc::clone(&supervisor);
    let second_checkpoint = cancellation.checkpoint();
    let second = std::thread::spawn(move || {
        execute_desktop_action_request_before_deadline(
            &second_companion,
            &second_supervisor,
            &second_checkpoint,
            &target(),
            &action_two,
            &permit_two,
            None,
            &binding_two,
            &RequestDeadline::after(Duration::from_millis(1_000)),
        )
    });

    std::thread::sleep(Duration::from_millis(25));
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    release_first.store(true, Ordering::SeqCst);

    assert_eq!(
        first.join().expect("first action"),
        Ok(ActionOutcomeReport::Ok)
    );
    assert_eq!(
        second.join().expect("second action"),
        Ok(ActionOutcomeReport::Ok)
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 2);
}

#[test]
fn expired_queued_action_does_not_consume_permit_or_dispatch() {
    let request_count = Arc::new(AtomicUsize::new(0));
    let release_first = Arc::new(AtomicBool::new(false));
    let supervisor = Arc::new(Mutex::new(UiaWorkerSupervisor::new(ConcurrentSpawner {
        request_count: Arc::clone(&request_count),
        release_first: Arc::clone(&release_first),
    })));
    let cancellation = supervisor
        .lock()
        .expect("supervisor lock")
        .cancellation_handle();
    let companion = Arc::new(Mutex::new(companion_with(ScriptedApprover::always(
        ApprovalOutcome::Approved,
    ))));
    let first_action = click_action("act-deadline-holder");
    let queued_action = click_action("act-deadline-queued");
    let mut first_binding = binding_for("act-deadline-holder", Risk::Normal);
    let mut queued_binding = binding_for("act-deadline-queued", Risk::Normal);
    let first_permit = issue_local_execution_permit(
        &mut companion.lock().expect("companion lock"),
        &first_action,
        &mut first_binding,
        None,
    );
    let queued_permit = issue_local_execution_permit(
        &mut companion.lock().expect("companion lock"),
        &queued_action,
        &mut queued_binding,
        None,
    );

    let first_companion = Arc::clone(&companion);
    let first_supervisor = Arc::clone(&supervisor);
    let first_checkpoint = cancellation.checkpoint();
    let first = std::thread::spawn(move || {
        execute_desktop_action_request_before_deadline(
            &first_companion,
            &first_supervisor,
            &first_checkpoint,
            &target(),
            &first_action,
            &first_permit,
            None,
            &first_binding,
            &RequestDeadline::after(Duration::from_millis(1_000)),
        )
    });

    while request_count.load(Ordering::SeqCst) == 0 {
        std::thread::sleep(Duration::from_millis(1));
    }

    let queued_result = execute_desktop_action_request_before_deadline(
        &companion,
        &supervisor,
        &cancellation.checkpoint(),
        &target(),
        &queued_action,
        &queued_permit,
        None,
        &queued_binding,
        &RequestDeadline::after(Duration::from_millis(10)),
    );
    assert_eq!(
        queued_result,
        Err(DesktopActionError::RequestDeadlineExpired)
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 1);

    release_first.store(true, Ordering::SeqCst);
    assert_eq!(
        first.join().expect("first action"),
        Ok(ActionOutcomeReport::Ok)
    );

    assert_eq!(
        execute_desktop_action_request_before_deadline(
            &companion,
            &supervisor,
            &cancellation.checkpoint(),
            &target(),
            &queued_action,
            &queued_permit,
            None,
            &queued_binding,
            &RequestDeadline::after(Duration::from_millis(1_000)),
        ),
        Ok(ActionOutcomeReport::Ok)
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 2);
}

#[test]
fn cancelled_queued_action_does_not_consume_permit_or_dispatch() {
    let request_count = Arc::new(AtomicUsize::new(0));
    let release_first = Arc::new(AtomicBool::new(false));
    let supervisor = Arc::new(Mutex::new(UiaWorkerSupervisor::new(ConcurrentSpawner {
        request_count: Arc::clone(&request_count),
        release_first: Arc::clone(&release_first),
    })));
    let cancellation = supervisor
        .lock()
        .expect("supervisor lock")
        .cancellation_handle();
    let companion = Arc::new(Mutex::new(companion_with(ScriptedApprover::always(
        ApprovalOutcome::Approved,
    ))));
    let first_action = click_action("act-cancel-holder");
    let queued_action = click_action("act-cancel-queued");
    let mut first_binding = binding_for("act-cancel-holder", Risk::Normal);
    let mut queued_binding = binding_for("act-cancel-queued", Risk::Normal);
    let first_permit = issue_local_execution_permit(
        &mut companion.lock().expect("companion lock"),
        &first_action,
        &mut first_binding,
        None,
    );
    let queued_permit = issue_local_execution_permit(
        &mut companion.lock().expect("companion lock"),
        &queued_action,
        &mut queued_binding,
        None,
    );

    let first_companion = Arc::clone(&companion);
    let first_supervisor = Arc::clone(&supervisor);
    let first_checkpoint = cancellation.checkpoint();
    let first = std::thread::spawn(move || {
        execute_desktop_action_request_before_deadline(
            &first_companion,
            &first_supervisor,
            &first_checkpoint,
            &target(),
            &first_action,
            &first_permit,
            None,
            &first_binding,
            &RequestDeadline::after(Duration::from_millis(1_000)),
        )
    });

    while request_count.load(Ordering::SeqCst) == 0 {
        std::thread::sleep(Duration::from_millis(1));
    }

    let queued_action_retry = queued_action.clone();
    let queued_permit_retry = queued_permit.clone();
    let queued_binding_retry = queued_binding.clone();
    let queued_companion = Arc::clone(&companion);
    let queued_supervisor = Arc::clone(&supervisor);
    let queued_checkpoint = cancellation.checkpoint();
    let queued_thread = std::thread::spawn(move || {
        execute_desktop_action_request_before_deadline(
            &queued_companion,
            &queued_supervisor,
            &queued_checkpoint,
            &target(),
            &queued_action,
            &queued_permit,
            None,
            &queued_binding,
            &RequestDeadline::after(Duration::from_millis(1_000)),
        )
    });

    std::thread::sleep(Duration::from_millis(25));
    cancellation.cancel_in_flight();
    release_first.store(true, Ordering::SeqCst);
    assert_eq!(
        first.join().expect("first action"),
        Err(DesktopActionError::Uia(UiaError::EmergencyStopped))
    );
    assert_eq!(
        queued_thread.join().expect("queued action"),
        Err(DesktopActionError::RequestCancelled)
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 1);

    assert_eq!(
        execute_desktop_action_request_before_deadline(
            &companion,
            &supervisor,
            &cancellation.checkpoint(),
            &target(),
            &queued_action_retry,
            &queued_permit_retry,
            None,
            &queued_binding_retry,
            &RequestDeadline::after(Duration::from_millis(1_000)),
        ),
        Ok(ActionOutcomeReport::Ok)
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 2);
}

fn input_action(action_id: &str, value_ref: &str) -> ResolvedDesktopAction {
    let mut action = click_action(action_id);
    action.kind = DesktopActionKind::Input {
        value_ref: value_ref.to_string(),
    };
    action.uia_pattern = Some("Value".to_string());
    action
}

fn select_action(action_id: &str, value_ref: &str, uia_pattern: &str) -> ResolvedDesktopAction {
    let mut action = click_action(action_id);
    action.kind = DesktopActionKind::Select {
        value_ref: value_ref.to_string(),
    };
    action.uia_pattern = Some(uia_pattern.to_string());
    action
}

fn issue_local_execution_permit(
    companion: &mut Companion<ManualClock, ScriptedApprover>,
    action: &ResolvedDesktopAction,
    binding: &mut PermitBinding,
    value_binding: Option<DesktopValueBinding>,
) -> LocalExecutionPermit {
    let permit_template =
        local_execution_permit("pending-token".to_string(), action, binding, value_binding);
    binding.action_digest_sha256 = permit_template.action_digest_sha256.clone();
    let token = match companion.request_permit(
        &approval_for(&action.action_id, binding.risk),
        binding.clone(),
    ) {
        PermitRequestOutcome::Issued(issued) => issued.token,
        other => panic!("expected permit issue, got {other:?}"),
    };
    LocalExecutionPermit {
        permit_token: token,
        ..permit_template
    }
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
fn action_execute_rejects_understated_permit_risk_before_dispatch() {
    let request_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let spawner = ScriptedSpawner::new(
        vec![vec![Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })]],
        Arc::clone(&request_count),
    );
    let mut supervisor = UiaWorkerSupervisor::new(spawner);
    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));
    let mut action = click_action("act-close");
    action.kind = DesktopActionKind::Window {
        window_operation: WindowOperation::Close,
    };
    action.uia_pattern = Some("Window".to_string());
    let mut understated = binding_for("act-close", Risk::ExternalSideEffect);
    let permit = issue_local_execution_permit(&mut companion, &action, &mut understated, None);

    assert_eq!(
        execute_desktop_action_request(
            &mut companion,
            &mut supervisor,
            &target(),
            &action,
            &permit,
            None,
            &understated,
            Duration::from_millis(50),
        ),
        Err(DesktopActionError::BindingMismatch)
    );
    assert_eq!(request_count.load(std::sync::atomic::Ordering::SeqCst), 0);
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
            &target(),
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
            &target(),
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
fn oversized_plaintext_is_rejected_before_permit_consumption_or_worker_dispatch() {
    let request_count = Arc::new(AtomicUsize::new(0));
    let spawner = ScriptedSpawner::new(
        vec![vec![Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })]],
        Arc::clone(&request_count),
    );
    let mut supervisor = UiaWorkerSupervisor::new(spawner);
    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));
    let action = input_action("act-oversized", "secret-ref");
    let mut binding = binding_for("act-oversized", Risk::ExternalSideEffect);
    let oversized_plaintext =
        "x".repeat((companion::ipc::dto::MAX_PLAINTEXT_VALUE_BYTES + 1) as usize);
    let oversized_hash = {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(oversized_plaintext.as_bytes()))
    };
    let value_binding = DesktopValueBinding {
        value_ref: "secret-ref".to_string(),
        value_sha256: oversized_hash.clone(),
        value_byte_length: oversized_plaintext.as_bytes().len() as u64,
    };
    let permit = local_execution_permit(
        "permit-oversized".to_string(),
        &action,
        &binding,
        Some(value_binding.clone()),
    );
    binding.action_digest_sha256 = permit.action_digest_sha256.clone();
    let token = match companion.request_permit(
        &approval_for("act-oversized", Risk::ExternalSideEffect),
        binding.clone(),
    ) {
        PermitRequestOutcome::Issued(issued) => issued.token,
        other => panic!("expected permit issue, got {other:?}"),
    };
    let permit = LocalExecutionPermit {
        permit_token: token,
        ..permit
    };
    let value = DesktopPlaintextValue {
        value_ref: "secret-ref".to_string(),
        value_sha256: oversized_hash,
        value_byte_length: value_binding.value_byte_length,
        plaintext: oversized_plaintext,
    };

    assert_eq!(
        execute_desktop_action_request(
            &mut companion,
            &mut supervisor,
            &target(),
            &action,
            &permit,
            Some(value),
            &binding,
            Duration::from_millis(50),
        ),
        Err(DesktopActionError::ValueTooLarge)
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
}

#[test]
fn selection_pattern_container_select_is_permit_bound_and_dispatched() {
    let request_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let spawner = ScriptedSpawner::new(
        vec![vec![Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })]],
        Arc::clone(&request_count),
    );
    let mut supervisor = UiaWorkerSupervisor::new(spawner);
    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));
    let action = select_action("act-select", "role-ref", "Selection");
    let mut binding = binding_for("act-select", Risk::ExternalSideEffect);
    let value_binding = DesktopValueBinding {
        value_ref: "role-ref".to_string(),
        value_sha256: "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b"
            .to_string(),
        value_byte_length: 6,
    };
    let permit = local_execution_permit(
        "permit-select".to_string(),
        &action,
        &binding,
        Some(value_binding.clone()),
    );
    binding.action_digest_sha256 = permit.action_digest_sha256.clone();
    let token = match companion.request_permit(
        &approval_for("act-select", Risk::ExternalSideEffect),
        binding.clone(),
    ) {
        PermitRequestOutcome::Issued(issued) => issued.token,
        other => panic!("expected permit issue, got {other:?}"),
    };
    let permit = LocalExecutionPermit {
        permit_token: token,
        ..permit
    };
    let value = DesktopPlaintextValue {
        value_ref: "role-ref".to_string(),
        value_sha256: value_binding.value_sha256,
        value_byte_length: value_binding.value_byte_length,
        plaintext: "secret".to_string(),
    };

    assert_eq!(
        execute_desktop_action_request(
            &mut companion,
            &mut supervisor,
            &target(),
            &action,
            &permit,
            Some(value),
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
            &target(),
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
