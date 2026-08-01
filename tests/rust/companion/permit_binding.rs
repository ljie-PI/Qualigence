//! One-time, action-bound Permit binding, replay and expiry.

use std::sync::Arc;

use companion::clock::ManualClock;
use companion::emergency_stop::SessionControl;
use companion::permit::{PermitBinding, PermitError, PermitStore};
use companion::risk::Risk;

fn binding() -> PermitBinding {
    PermitBinding {
        session_id: "sess-1".into(),
        run_id: "run-1".into(),
        action_id: "act-1".into(),
        action_digest_sha256: "a".repeat(64),
        graph_id: "graph-1".into(),
        risk: Risk::Normal,
    }
}

#[test]
fn a_valid_permit_is_consumed_exactly_once() {
    let clock = Arc::new(ManualClock::new(1_000));
    let mut store = PermitStore::new(clock, 30_000);
    let control = SessionControl::new();

    let permit = store.issue(binding());
    assert_eq!(store.consume(&control, &permit.token, &binding()), Ok(()));
    // A replay of the same token is rejected.
    assert_eq!(
        store.consume(&control, &permit.token, &binding()),
        Err(PermitError::AlreadyConsumed)
    );
}

#[test]
fn an_unknown_token_is_rejected() {
    let clock = Arc::new(ManualClock::new(1_000));
    let mut store = PermitStore::new(clock, 30_000);
    let control = SessionControl::new();
    assert_eq!(
        store.consume(&control, "not-a-real-token", &binding()),
        Err(PermitError::UnknownToken)
    );
}

#[test]
fn every_bound_field_must_match() {
    let clock = Arc::new(ManualClock::new(1_000));
    let mut store = PermitStore::new(clock, 30_000);
    let control = SessionControl::new();

    type Mutator = fn(&mut PermitBinding);
    let mutators: Vec<(&str, Mutator)> = vec![
        ("session", |b| b.session_id = "other".into()),
        ("run", |b| b.run_id = "other".into()),
        ("action", |b| b.action_id = "other".into()),
        ("digest", |b| b.action_digest_sha256 = "b".repeat(64)),
        ("graph", |b| b.graph_id = "other".into()),
        ("risk", |b| b.risk = Risk::ExternalSideEffect),
    ];

    for (label, mutate) in mutators {
        let permit = store.issue(binding());
        let mut tampered = binding();
        mutate(&mut tampered);
        assert_eq!(
            store.consume(&control, &permit.token, &tampered),
            Err(PermitError::BindingMismatch),
            "mutating {label} must fail closed"
        );
        // A binding mismatch must not burn the token: the original still works.
        assert_eq!(
            store.consume(&control, &permit.token, &binding()),
            Ok(()),
            "original binding still valid after a mismatched attempt on {label}"
        );
    }
}

#[test]
fn a_stale_permit_is_rejected() {
    let clock = Arc::new(ManualClock::new(1_000));
    let mut store = PermitStore::new(Arc::clone(&clock), 30_000);
    let control = SessionControl::new();

    let permit = store.issue(binding());
    clock.advance(30_001);
    assert_eq!(
        store.consume(&control, &permit.token, &binding()),
        Err(PermitError::Expired)
    );
}

#[test]
fn production_forbidden_is_never_consumed() {
    let clock = Arc::new(ManualClock::new(1_000));
    let mut store = PermitStore::new(clock, 30_000);
    let control = SessionControl::new();

    let mut forbidden = binding();
    forbidden.risk = Risk::ProductionForbidden;
    let permit = store.issue(forbidden.clone());
    assert_eq!(
        store.consume(&control, &permit.token, &forbidden),
        Err(PermitError::ProductionForbidden)
    );
}
