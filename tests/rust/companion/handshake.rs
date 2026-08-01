//! Certificate-style challenge-response: the Runner must prove key possession by
//! signing a fresh nonce. A reported fingerprint alone is never accepted, and
//! challenges are single-use and time-bounded.

use std::sync::Arc;

use companion::clock::ManualClock;
use companion::ipc::security::{HandshakeError, HandshakeVerifier, RunnerSigner};

const PROTOCOL_MAJOR: u8 = 1;
const INSTANCE: &str = "companion-instance-1";
const DEADLINE_MS: u64 = 5_000;

fn verifier(
    clock: Arc<ManualClock>,
    runners: Vec<&RunnerSigner>,
) -> HandshakeVerifier<ManualClock> {
    HandshakeVerifier::new(
        PROTOCOL_MAJOR,
        INSTANCE,
        runners.iter().map(|r| r.registration()),
        clock,
        DEADLINE_MS,
    )
}

#[test]
fn a_valid_signature_authenticates_the_runner() {
    let clock = Arc::new(ManualClock::new(1_000));
    let runner = RunnerSigner::generate("runner-1");
    let mut v = verifier(Arc::clone(&clock), vec![&runner]);

    let challenge = v.begin(PROTOCOL_MAJOR, "runner-1").expect("begin");
    let signature = runner.prove(PROTOCOL_MAJOR, INSTANCE, &challenge);
    let authed = v
        .verify("runner-1", &challenge.challenge_id, &signature)
        .expect("verify");
    assert_eq!(authed.runner_id, "runner-1");
}

#[test]
fn an_unregistered_runner_cannot_begin() {
    let clock = Arc::new(ManualClock::new(1_000));
    let runner = RunnerSigner::generate("runner-1");
    let mut v = verifier(clock, vec![&runner]);
    assert_eq!(
        v.begin(PROTOCOL_MAJOR, "intruder"),
        Err(HandshakeError::UnknownRunner)
    );
}

#[test]
fn the_wrong_protocol_major_is_rejected() {
    let clock = Arc::new(ManualClock::new(1_000));
    let runner = RunnerSigner::generate("runner-1");
    let mut v = verifier(clock, vec![&runner]);
    assert_eq!(v.begin(2, "runner-1"), Err(HandshakeError::WrongProtocol));
}

#[test]
fn a_signature_from_a_different_key_is_rejected() {
    let clock = Arc::new(ManualClock::new(1_000));
    let registered = RunnerSigner::generate("runner-1");
    let mut v = verifier(Arc::clone(&clock), vec![&registered]);

    // An imposter that claims runner-1 but holds a different private key.
    let imposter = RunnerSigner::from_seed("runner-1", [7u8; 32]);
    let challenge = v.begin(PROTOCOL_MAJOR, "runner-1").expect("begin");
    let forged = imposter.prove(PROTOCOL_MAJOR, INSTANCE, &challenge);
    assert_eq!(
        v.verify("runner-1", &challenge.challenge_id, &forged),
        Err(HandshakeError::BadSignature)
    );
}

#[test]
fn a_challenge_cannot_be_replayed() {
    let clock = Arc::new(ManualClock::new(1_000));
    let runner = RunnerSigner::generate("runner-1");
    let mut v = verifier(Arc::clone(&clock), vec![&runner]);

    let challenge = v.begin(PROTOCOL_MAJOR, "runner-1").expect("begin");
    let signature = runner.prove(PROTOCOL_MAJOR, INSTANCE, &challenge);
    assert!(v
        .verify("runner-1", &challenge.challenge_id, &signature)
        .is_ok());
    // The same challenge/signature cannot be presented again.
    assert_eq!(
        v.verify("runner-1", &challenge.challenge_id, &signature),
        Err(HandshakeError::ReplayedChallenge)
    );
}

#[test]
fn a_challenge_for_one_runner_cannot_be_answered_as_another() {
    let clock = Arc::new(ManualClock::new(1_000));
    let a = RunnerSigner::generate("runner-a");
    let b = RunnerSigner::generate("runner-b");
    let mut v = verifier(Arc::clone(&clock), vec![&a, &b]);

    let challenge = v.begin(PROTOCOL_MAJOR, "runner-a").expect("begin");
    let signature = b.prove(PROTOCOL_MAJOR, INSTANCE, &challenge);
    assert_eq!(
        v.verify("runner-b", &challenge.challenge_id, &signature),
        Err(HandshakeError::RunnerMismatch)
    );
}

#[test]
fn an_expired_challenge_is_rejected() {
    let clock = Arc::new(ManualClock::new(1_000));
    let runner = RunnerSigner::generate("runner-1");
    let mut v = verifier(Arc::clone(&clock), vec![&runner]);

    let challenge = v.begin(PROTOCOL_MAJOR, "runner-1").expect("begin");
    let signature = runner.prove(PROTOCOL_MAJOR, INSTANCE, &challenge);
    clock.advance_monotonic(DEADLINE_MS + 1);
    assert_eq!(
        v.verify("runner-1", &challenge.challenge_id, &signature),
        Err(HandshakeError::Expired)
    );
}
