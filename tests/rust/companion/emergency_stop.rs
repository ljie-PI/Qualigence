//! Emergency Stop is absolute: once triggered, nothing executes — even a fresh,
//! otherwise-valid Permit — until an explicit reset begins a new Session.

use std::sync::Arc;

use companion::approval::Decision;
use companion::approval::{ApprovalOutcome, ApprovalRequest, ApprovalState, ScriptedApprover};
use companion::clock::ManualClock;
use companion::permit::{PermitBinding, PermitError, PermitStore};
use companion::risk::Risk;
use companion::{Companion, PermitRequestOutcome};

fn broker() -> Companion<ManualClock, ScriptedApprover> {
    let clock = Arc::new(ManualClock::new(1_000));
    let approval = ApprovalState::new("run-1", ScriptedApprover::always(ApprovalOutcome::Approved));
    let permits = PermitStore::new(clock, 30_000);
    Companion::new("sess-1", approval, permits)
}

fn request(risk: Risk) -> ApprovalRequest {
    ApprovalRequest {
        approval_id: "ap-1".into(),
        session_id: "sess-1".into(),
        run_id: "run-1".into(),
        action_id: "act-1".into(),
        risk,
        safe_summary: "Click the Submit button".into(),
    }
}

fn binding(risk: Risk) -> PermitBinding {
    PermitBinding {
        session_id: "sess-1".into(),
        run_id: "run-1".into(),
        action_id: "act-1".into(),
        action_digest_sha256: "a".repeat(64),
        graph_id: "graph-1".into(),
        risk,
    }
}

fn issued_token(outcome: PermitRequestOutcome) -> String {
    match outcome {
        PermitRequestOutcome::Issued(permit) => permit.token,
        PermitRequestOutcome::Rejected(d) => panic!("expected an issued permit, got {d:?}"),
    }
}

#[test]
fn a_normal_permit_authorizes_exactly_one_action() {
    let mut companion = broker();
    let token =
        issued_token(companion.request_permit(&request(Risk::Normal), binding(Risk::Normal)));
    assert_eq!(
        companion.authorize_action(&token, &binding(Risk::Normal)),
        Ok(())
    );
    // Single use.
    assert_eq!(
        companion.authorize_action(&token, &binding(Risk::Normal)),
        Err(PermitError::AlreadyConsumed)
    );
}

#[test]
fn emergency_stop_rejects_an_already_issued_fresh_permit() {
    let mut companion = broker();
    // Mint a perfectly valid, unexpired, unconsumed permit.
    let token =
        issued_token(companion.request_permit(&request(Risk::Normal), binding(Risk::Normal)));

    companion.emergency_stop();

    // Even though the permit is fresh and valid, the absolute latch rejects it.
    assert_eq!(
        companion.authorize_action(&token, &binding(Risk::Normal)),
        Err(PermitError::EmergencyStopped)
    );
    // And no new permit can be minted while stopped.
    match companion.request_permit(&request(Risk::Normal), binding(Risk::Normal)) {
        PermitRequestOutcome::Rejected(Decision::EmergencyStopped) => {}
        other => panic!("expected EmergencyStopped rejection, got {other:?}"),
    }
}

#[test]
fn reset_begins_a_new_session_and_discards_old_permits() {
    let mut companion = broker();
    let token =
        issued_token(companion.request_permit(&request(Risk::Normal), binding(Risk::Normal)));
    companion.emergency_stop();
    companion.reset_session("sess-2");

    // The old permit was invalidated by the stop/reset, so it no longer exists.
    assert_eq!(
        companion.authorize_action(&token, &binding(Risk::Normal)),
        Err(PermitError::UnknownToken)
    );
    // A brand-new Session can issue and authorize again.
    let token2 =
        issued_token(companion.request_permit(&request(Risk::Normal), binding(Risk::Normal)));
    assert_eq!(
        companion.authorize_action(&token2, &binding(Risk::Normal)),
        Ok(())
    );
}

#[test]
fn pause_blocks_authorizing_an_existing_permit() {
    let mut companion = broker();
    let token =
        issued_token(companion.request_permit(&request(Risk::Normal), binding(Risk::Normal)));
    companion.pause();
    assert_eq!(
        companion.authorize_action(&token, &binding(Risk::Normal)),
        Err(PermitError::Paused)
    );
    companion.resume();
    assert_eq!(
        companion.authorize_action(&token, &binding(Risk::Normal)),
        Ok(())
    );
}
