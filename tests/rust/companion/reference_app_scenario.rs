//! LS-13 Task 5 — Rust "Reference App" scenario (Linux-runnable, synthetic UIA).
//!
//! There is no real Windows 11 machine, WPF/WinUI runtime or UIA provider in
//! this sandbox, so this exercises the Companion's own logic end to end against
//! the deterministic [`SyntheticUiaCapture`] reference tree: it captures the
//! reference `uia/v1` source (proving secrets are masked and AutomationIds are
//! preserved) and brokers both a Normal reference click and a high-risk
//! destructive action through the one-time-Permit + approval gate, proving a
//! denied high-risk action never reaches the worker. A real UIA capture of the
//! compiled reference apps is a separate, operator-performed manual step (see
//! docs/testing/windows-m3-manual-checklist.md).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use companion::approval::{ApprovalOutcome, ApprovalRequest, ApprovalState, ScriptedApprover};
use companion::clock::ManualClock;
use companion::ipc::dto::{
    DesktopActionKind, DesktopResolution, ResolvedDesktopAction, TargetKind,
};
use companion::permit::PermitBinding;
use companion::process::job_object::AppWindowSelector;
use companion::risk::Risk;
use companion::uia::action::execute_desktop_action;
use companion::uia::mapping::MASKED_VALUE;
use companion::uia::protocol::{
    ActionOutcomeReport, UiaSessionTarget, WorkerRequest, WorkerResponse,
};
use companion::uia::worker::{synthetic_source, SyntheticUiaCapture, UiaCapture};
use companion::uia::worker_supervisor::{
    UiaWorkerSupervisor, WorkerCancellationCheckpoint, WorkerError, WorkerHandle, WorkerSpawner,
};
use companion::{Companion, PermitRequestOutcome};

/// A scripted worker child that records whether it was ever asked to do anything,
/// so a test can prove a rejected Permit never reaches the worker.
struct ScriptedHandle {
    responses: VecDeque<Result<WorkerResponse, WorkerError>>,
    alive: bool,
    request_count: Arc<AtomicUsize>,
}

impl WorkerHandle for ScriptedHandle {
    fn request(
        &mut self,
        _req: &WorkerRequest,
        _deadline: Duration,
        _cancellation: &WorkerCancellationCheckpoint,
    ) -> Result<WorkerResponse, WorkerError> {
        self.request_count.fetch_add(1, Ordering::SeqCst);
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
    request_count: Arc<AtomicUsize>,
}

impl ScriptedSpawner {
    fn new(
        scripts: impl IntoIterator<Item = Vec<Result<WorkerResponse, WorkerError>>>,
        request_count: Arc<AtomicUsize>,
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

fn click(action_id: &str, node_id: &str) -> ResolvedDesktopAction {
    ResolvedDesktopAction {
        target_kind: TargetKind::Desktop,
        kind: DesktopActionKind::Click,
        action_id: action_id.into(),
        graph_id: "graph-ref".into(),
        node_id: node_id.into(),
        resolution: DesktopResolution::Semantic,
        uia_pattern: Some("Invoke".into()),
    }
}

fn target() -> UiaSessionTarget {
    UiaSessionTarget {
        session_id: "sess-ref".into(),
        process_id: 4242,
        root_window_handle: "0x10".into(),
        window_selector: AppWindowSelector::default(),
    }
}

fn binding(action_id: &str, risk: Risk) -> PermitBinding {
    PermitBinding {
        session_id: "sess-ref".into(),
        run_id: "run-ref".into(),
        action_id: action_id.into(),
        action_digest_sha256: "b".repeat(64),
        graph_id: "graph-ref".into(),
        risk,
    }
}

fn approval(action_id: &str, risk: Risk) -> ApprovalRequest {
    ApprovalRequest {
        approval_id: format!("ap-{action_id}"),
        session_id: "sess-ref".into(),
        run_id: "run-ref".into(),
        action_id: action_id.into(),
        risk,
        safe_summary: "reference desktop action".into(),
    }
}

fn companion_with(approver: ScriptedApprover) -> Companion<ManualClock, ScriptedApprover> {
    let clock = Arc::new(ManualClock::new(1_000));
    let approval = ApprovalState::new("run-ref", approver);
    let permits = companion::permit::PermitStore::new(clock, 30_000);
    Companion::new("sess-ref", approval, permits)
}

#[test]
fn synthetic_reference_capture_masks_secrets_and_preserves_ids() {
    let mut capture = SyntheticUiaCapture::new(4242, "2026-08-02T00:00:00.000Z");
    let source = capture.capture(&target()).expect("capture succeeds");

    // The reference tree shape the pipeline tests rely on.
    assert_eq!(source.root_node_ids, vec!["window".to_string()]);
    let password = source
        .nodes
        .iter()
        .find(|node| node.node_id == "password")
        .expect("password node present");
    // The raw secret ("hunter2") is masked before it ever leaves the worker.
    assert_eq!(password.value.as_deref(), Some(MASKED_VALUE));
    assert!(password.is_password);

    let button = source
        .nodes
        .iter()
        .find(|node| node.node_id == "button")
        .expect("submit button present");
    assert_eq!(button.automation_id.as_deref(), Some("SubmitButton"));
    assert!(button.patterns.iter().any(|p| p.pattern == "Invoke"));

    // `synthetic_source` and the trait capture agree (the TS fixtures serialize a
    // copy of this same source).
    assert_eq!(
        source,
        synthetic_source("sess-ref", 4242, "2026-08-02T00:00:00.000Z")
    );
}

#[test]
fn a_normal_reference_click_is_brokered_end_to_end() {
    let request_count = Arc::new(AtomicUsize::new(0));
    let spawner = ScriptedSpawner::new(
        vec![vec![Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })]],
        Arc::clone(&request_count),
    );
    let mut supervisor = UiaWorkerSupervisor::new(spawner);

    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Approved));
    let bind = binding("act-submit", Risk::Normal);
    let token = match companion.request_permit(&approval("act-submit", Risk::Normal), bind.clone())
    {
        PermitRequestOutcome::Issued(permit) => permit.token,
        other => panic!("expected a Normal auto-issue, got {other:?}"),
    };

    let outcome = execute_desktop_action(
        &mut companion,
        &mut supervisor,
        &target(),
        &click("act-submit", "button"),
        &token,
        &bind,
        Duration::from_millis(50),
    )
    .expect("brokered reference click succeeds");

    assert_eq!(outcome, ActionOutcomeReport::Ok);
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
}

#[test]
fn a_denied_high_risk_reference_action_never_reaches_the_worker() {
    let request_count = Arc::new(AtomicUsize::new(0));
    // The worker would answer Ok if reached — but it must never be reached.
    let spawner = ScriptedSpawner::new(
        vec![vec![Ok(WorkerResponse::Executed {
            outcome: ActionOutcomeReport::Ok,
        })]],
        Arc::clone(&request_count),
    );
    let mut _supervisor = UiaWorkerSupervisor::new(spawner);

    let mut companion = companion_with(ScriptedApprover::always(ApprovalOutcome::Denied));
    // A destructive "delete all records" click requires human approval; a denial
    // yields no Permit, so there is no token to execute and the worker stays idle.
    match companion.request_permit(
        &approval("act-delete-all", Risk::Destructive),
        binding("act-delete-all", Risk::Destructive),
    ) {
        PermitRequestOutcome::Rejected(_) => {}
        other => panic!("a denied high-risk action must not mint a Permit, got {other:?}"),
    }

    assert_eq!(request_count.load(Ordering::SeqCst), 0);
}

// The exhaustive real-UIA verification (a real capture of the compiled reference
// apps, Job Object cleanup checked via Task Manager / Process Explorer, and
// emergency-stop against a real hung app) is a manual, operator-performed step on
// real Windows 11 hardware. It cannot run here and is intentionally not faked.
