//! Restartable UIA worker: `uia/v1` source serialization, secret masking, and
//! the supervisor's kill-and-rebuild restart behavior (specialist finding W-03).

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use companion::approval::{ApprovalOutcome, ApprovalRequest, ApprovalState, ScriptedApprover};
use companion::clock::ManualClock;
use companion::permit::{PermitBinding, PermitStore};
use companion::risk::Risk;
use companion::uia::mapping::MASKED_VALUE;
use companion::uia::protocol::{UiaError, UiaSource, WorkerRequest, WorkerResponse};
use companion::uia::worker::synthetic_source;
use companion::uia::worker_supervisor::{
    UiaWorkerSupervisor, WorkerError, WorkerHandle, WorkerSpawner,
};
use companion::{Companion, PermitRequestOutcome};

/// A worker child scripted with a fixed sequence of per-request results.
struct ScriptedHandle {
    responses: VecDeque<Result<WorkerResponse, WorkerError>>,
    alive: bool,
    requests: Vec<WorkerRequest>,
}

impl WorkerHandle for ScriptedHandle {
    fn request(
        &mut self,
        req: &WorkerRequest,
        _deadline: Duration,
    ) -> Result<WorkerResponse, WorkerError> {
        self.requests.push(req.clone());
        match self.responses.pop_front() {
            Some(Ok(response)) => Ok(response),
            Some(Err(err)) => {
                if matches!(err, WorkerError::Closed | WorkerError::Timeout) {
                    self.alive = false;
                }
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

/// A spawner that hands out a pre-scripted sequence of worker children.
struct ScriptedSpawner {
    scripts: VecDeque<VecDeque<Result<WorkerResponse, WorkerError>>>,
}

impl ScriptedSpawner {
    fn new(scripts: impl IntoIterator<Item = Vec<Result<WorkerResponse, WorkerError>>>) -> Self {
        Self {
            scripts: scripts
                .into_iter()
                .map(|s| s.into_iter().collect())
                .collect(),
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
                requests: Vec::new(),
            }),
            None => Err(WorkerError::Spawn),
        }
    }
}

fn captured(session_id: &str) -> WorkerResponse {
    WorkerResponse::Captured {
        source: synthetic_source(session_id, 4242, "2026-08-02T00:00:00.000Z"),
    }
}

#[test]
fn uia_source_round_trips_through_json_with_masked_password() {
    let source = synthetic_source("sess-1", 4242, "2026-08-02T00:00:00.000Z");

    let json = serde_json::to_string(&source).expect("serialize uia source");
    // The real secret is never serialized; only the mask token appears.
    assert!(json.contains(MASKED_VALUE));
    assert!(!json.contains("hunter2"));

    let restored: UiaSource = serde_json::from_str(&json).expect("deserialize uia source");
    assert_eq!(restored, source);

    let password = restored
        .nodes
        .iter()
        .find(|n| n.node_id == "password")
        .expect("password node present");
    assert!(password.is_password);
    assert_eq!(password.value.as_deref(), Some(MASKED_VALUE));
}

#[test]
fn a_hung_worker_is_recycled_and_the_replacement_resumes_capture() {
    // Worker #1 hangs on its first capture; worker #2 succeeds.
    let spawner = ScriptedSpawner::new(vec![
        vec![Err(WorkerError::Timeout)],
        vec![Ok(captured("sess-1"))],
    ]);
    let mut supervisor = UiaWorkerSupervisor::new(spawner);

    // First capture: the worker hangs, so we get a non-blocking TargetUnresponsive
    // and the child is torn down.
    let first = supervisor.capture("sess-1", Duration::from_millis(50));
    assert_eq!(first, Err(UiaError::TargetUnresponsive));
    assert_eq!(supervisor.restart_count(), 1);
    assert!(!supervisor.worker_alive());

    // Second capture: a fresh worker is spawned lazily and the session resumes
    // without any external restart.
    let second = supervisor
        .capture("sess-1", Duration::from_millis(50))
        .expect("replacement worker captures");
    assert_eq!(second.session_id, "sess-1");
    assert_eq!(supervisor.spawn_count(), 2);
    assert!(supervisor.worker_alive());
}

#[test]
fn a_corrupt_frame_recycles_the_worker() {
    let spawner = ScriptedSpawner::new(vec![
        vec![Err(WorkerError::Corrupt)],
        vec![Ok(captured("sess-1"))],
    ]);
    let mut supervisor = UiaWorkerSupervisor::new(spawner);

    assert_eq!(
        supervisor.capture("sess-1", Duration::from_millis(50)),
        Err(UiaError::TargetUnresponsive)
    );
    assert_eq!(supervisor.restart_count(), 1);

    let ok = supervisor
        .capture("sess-1", Duration::from_millis(50))
        .expect("replacement worker recovers");
    assert_eq!(ok.root_node_ids, vec!["window".to_string()]);
}

#[test]
fn a_worker_crash_does_not_disturb_the_companion_security_core() {
    // The supervisor and the Companion are independent objects; a hung worker
    // must never impair the approval gate or the deny latch.
    let clock = Arc::new(ManualClock::new(1_000));
    let approver = ScriptedApprover::always(ApprovalOutcome::Approved);
    let approval = ApprovalState::new("run-1", approver);
    let permits = PermitStore::new(clock, 30_000);
    let mut companion = Companion::new("sess-1", approval, permits);

    let spawner = ScriptedSpawner::new(vec![vec![Err(WorkerError::Timeout)]]);
    let mut supervisor = UiaWorkerSupervisor::new(spawner);
    assert_eq!(
        supervisor.capture("sess-1", Duration::from_millis(10)),
        Err(UiaError::TargetUnresponsive)
    );

    // After the worker crash the Companion still mints and consumes Permits.
    let binding = PermitBinding {
        session_id: "sess-1".into(),
        run_id: "run-1".into(),
        action_id: "act-1".into(),
        action_digest_sha256: "a".repeat(64),
        graph_id: "graph-1".into(),
        risk: Risk::Normal,
    };
    let request = ApprovalRequest {
        approval_id: "ap-1".into(),
        session_id: "sess-1".into(),
        run_id: "run-1".into(),
        action_id: "act-1".into(),
        risk: Risk::Normal,
        safe_summary: "click Submit".into(),
    };
    let outcome = companion.request_permit(&request, binding.clone());
    let token = match outcome {
        PermitRequestOutcome::Issued(permit) => permit.token,
        PermitRequestOutcome::Rejected(decision) => {
            panic!("permit should be issued, got {decision:?}")
        }
    };
    assert_eq!(companion.authorize_action(&token, &binding), Ok(()));
}
