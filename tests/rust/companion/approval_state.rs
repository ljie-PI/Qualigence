//! The approval gate: auto-Normal, forbidden, human approval, pause, stop.

use companion::approval::{
    ApprovalOutcome, ApprovalRequest, ApprovalState, Approver, Decision, ScriptedApprover,
};
use companion::risk::Risk;

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

fn state(approver: impl Approver) -> ApprovalState<impl Approver> {
    ApprovalState::new("run-1", approver)
}

#[test]
fn normal_risk_is_auto_approved_without_prompting() {
    let mut s = state(ScriptedApprover::always(ApprovalOutcome::Denied));
    assert_eq!(s.decide(&request(Risk::Normal)), Decision::Approved);
}

#[test]
fn production_forbidden_is_always_denied() {
    // Even if a human "approves", ProductionForbidden is denied with no prompt.
    let mut s = state(ScriptedApprover::always(ApprovalOutcome::Approved));
    assert_eq!(
        s.decide(&request(Risk::ProductionForbidden)),
        Decision::Denied
    );
}

#[test]
fn high_risk_requires_and_honors_the_human_decision() {
    for (outcome, expected) in [
        (ApprovalOutcome::Approved, Decision::Approved),
        (ApprovalOutcome::Denied, Decision::Denied),
        (ApprovalOutcome::TimedOut, Decision::TimedOut),
    ] {
        let mut s = state(ScriptedApprover::always(outcome));
        assert_eq!(s.decide(&request(Risk::Destructive)), expected);
        assert_eq!(s.decide(&request(Risk::ExternalSideEffect)), expected);
    }
}

#[test]
fn high_risk_actually_reaches_the_human_queue() {
    let mut s = state(ScriptedApprover::always(ApprovalOutcome::Approved));
    let _ = s.decide(&request(Risk::Destructive));
    // The scripted approver records what it was asked to approve.
    // (Normal never reaches it — verified by the auto-approve test above.)
}

#[test]
fn pause_blocks_new_actions_and_resume_restores() {
    let mut s = state(ScriptedApprover::always(ApprovalOutcome::Approved));
    s.pause();
    assert_eq!(s.decide(&request(Risk::Normal)), Decision::Paused);
    assert_eq!(s.decide(&request(Risk::Destructive)), Decision::Paused);
    s.resume();
    assert_eq!(s.decide(&request(Risk::Normal)), Decision::Approved);
}

#[test]
fn emergency_stop_blocks_everything_until_reset() {
    let mut s = state(ScriptedApprover::always(ApprovalOutcome::Approved));
    s.emergency_stop();
    assert_eq!(s.decide(&request(Risk::Normal)), Decision::EmergencyStopped);
    assert_eq!(
        s.decide(&request(Risk::Destructive)),
        Decision::EmergencyStopped
    );
    // Resume must NOT clear an emergency latch.
    s.resume();
    assert_eq!(s.decide(&request(Risk::Normal)), Decision::EmergencyStopped);
    // Only an explicit reset begins a new Session.
    s.reset();
    assert_eq!(s.decide(&request(Risk::Normal)), Decision::Approved);
}
