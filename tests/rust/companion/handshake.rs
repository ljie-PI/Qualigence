//! Certificate-style challenge-response: the Runner must prove mTLS private-key
//! possession by signing a fresh nonce. A reported fingerprint alone is never
//! accepted, and challenges are single-use and time-bounded.

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use companion::clock::ManualClock;
use companion::ipc::security::{
    proof_bytes, CertificateError, CertificateHandshakeError, CertificateHandshakeVerifier,
    CompanionProofSignatureAlgorithm, HandshakeError, HandshakeVerifier, RunnerCertificatePolicy,
    RunnerSigner,
};
use p256::ecdsa::signature::Signer as EcdsaSigner;
use p256::ecdsa::SigningKey as EcdsaSigningKey;
use p256::pkcs8::DecodePrivateKey as DecodeP256PrivateKey;
use rsa::pss::SigningKey as RsaPssSigningKey;
use rsa::rand_core::OsRng;
use rsa::RsaPrivateKey;
use sha2::{Digest, Sha256};
use signature::{RandomizedSigner, SignatureEncoding};

const PROTOCOL_MAJOR: u8 = 1;
const INSTANCE: &str = "companion-instance-1";
const DEADLINE_MS: u64 = 5_000;

const ECDSA_KEY: &str = r#"-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQggfWHS3+/LyrYeDcE
ZovQ7tp78+a5pQ3kDnmYXGsZhXuhRANCAAT6wsdKIvqbW9usdmjB/z888RPKPEYn
8glGRXCoqboNPy9q1xvaPv57kx8zr2HDYt5IvczMR4ZSRdweUceYUJUy
-----END PRIVATE KEY-----"#;

const ECDSA_CERT: &str = r#"-----BEGIN CERTIFICATE-----
MIIBcjCCARmgAwIBAgIUTOXLZn+Kw9tvTjs2BA5cqNNIsGkwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIcnVubmVyLTEwHhcNMjYwODI2MDgyMTQ5WhcNMzYwODIzMDgy
MTQ5WjATMREwDwYDVQQDDAhydW5uZXItMTBZMBMGByqGSM49AgEGCCqGSM49AwEH
A0IABPrCx0oi+ptb26x2aMH/PzzxE8o8RifyCUZFcKipug0/L2rXG9o+/nuTHzOv
YcNi3ki9zMxHhlJF3B5Rx5hQlTKjSzBJMBMGA1UdEQQMMAqCCHJ1bm5lci0xMBMG
A1UdJQQMMAoGCCsGAQUFBwMCMB0GA1UdDgQWBBQxXkpve/un77zjNyXyb6J1WsyV
nTAKBggqhkjOPQQDAgNHADBEAiBNJdqkqqY3PnA0SuE8f3qeUHsq6j88+xAwPhFL
sNwAVgIgdcy6zw1dxcWz05gQ4nHk3pu+7zZwclJgdhrRB1S2TOk=
-----END CERTIFICATE-----"#;

const RSA_KEY: &str = r#"-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDCWZwVSyLisRGf
PT8Y6hLggwEQfCbJxxn68vdVuHB+4Yh+UexrUZebOBNRGR7PkZBCxTtoSGxqPwDh
8KdK1bMhaEv4fER7aVW7/I+WgRmYLFrw8okp4ru4JYDtfRkSsEqMSS3gVx9ApfAY
0+kQUsKg0WUBQ8LxZAKWklU0NyG8sWAf5AqgE33OYxpPkwnDiEhab0s7GBjF3ln4
wRmhcbcKAUJHza782xHsvA3BNJ9m/GQKCyVswAboXHLm0kwNCBZOKmrLRboFe8e/
0cT/wqXjYPVX01D/i10cddMXUDTXtBXPdyvVAda0P/2yRnFQVOBJACYpN0DiwXv0
LqvhSKl7AgMBAAECggEAOQ4Ef83Mgn9X/IcG6IIDI6zh2ZyQ6IiOTHkaeixIvj7o
iqjzPng4CSXXqeW1gVsq3ic3rwAf77rqP+odup7s1QBg2SRmGFLOi/7zikwBHwba
dcTF1qmM0V0VMeMZQr7FS9TJ5oO9FYYBa9B+KcAaCgse21Wwu5vQFLMF12vd+B4Z
WHXEW6QiIAbFDYp8sWbQ6Ylmq9YVOKRdcl45BWcKVcrPtClYNDFqP0Noc5RvHV5H
jfWUAZjXlLvWYrz/WfYgz0W/3YnkkbeP1GAXvhvJx6P6liA1zlrkQO8QO4bOsA6y
PILfiwQUYD2+OiRM6lPQhTaEEj6ZNBSLh4KrsogjBQKBgQDoA/WtUr+6WtajSb9Y
ESwjqC+yECiSKnRBuYXA41HQkguzu5L/apgh1wg7lLIqjaxJz0cLURg4PY96jIA6
WP5DBjqp0vL3HRH4m8r0omf3CDxpijTxvYgCJ9nPEH3H+zSMv21v5R6fxTO+L72p
/rNJ+bx13+oICKgT5aJ01y3rPwKBgQDWcN/2kxqQdEMPwfq0PwzlQWPH9iyUVfnk
GsBT8AO1W8gp4cQVv06l2uhxdayG/M7WCjzH5ROTmCj8Y+Hpets1/83clt+oHxsQ
WPBU+c/bVrtRzsrSUf2tyZSVBvKmQHDXeoLHGHgW+aoXJ4qHDli4FiDNosTG3TPv
5Yk9BI7exQKBgFHoE/L8I3NGXj+G6WXNqidsWGokCi6Pjjslo3JUza0z4a2xqlNA
7jQEFYPzGnKrUQc9hXcZSdOQ5/X7Y8k1YY2HxW3uapeSS6XYWe3C57Dt12XqxIYS
wtEAAIR47e6LYCHP8nJuEEGW/I1HjU1V/TVAVKfIRHZRmARuLMvSqwNBAoGBAJm0
eGPmFxFZtEPUN54A335n+1x10IhWg/KDVj4T+KSC8BtNDt7DrFznZtsEjLCI/rye
w+hIA1s0opQeB+zxubSf8W/e2NtJyH1UMpfGI73FEilWPzy3tkxeA9k6DK0r3XYm
Ax0wJcvaEpfcKMgbeW4htkuPEtqz7SlT7qXE4Z89AoGAY5KtLAIsE7XTo5vPpyTi
khudgx+zTyn5MQ92YQlHz0bkejSqvwA9/1rHrnb+vdx7n/qic0zS/NaW+bmcdmCN
Xx1RW5QyCGEJ3heql/2VrqTjvmzfUXW3v1cF60q/prEipcploGDkkhwxIkwQS7ks
ZJYz+d9V7Rq2DPiIcXgM4pk=
-----END PRIVATE KEY-----"#;

const RSA_CERT: &str = r#"-----BEGIN CERTIFICATE-----
MIIDBTCCAe2gAwIBAgIUSVF0+5sft8aA5Sd6Os9VB174wIAwDQYJKoZIhvcNAQEL
BQAwFTETMBEGA1UEAwwKcnVubmVyLXJzYTAeFw0yNjA4MjYwODIxNTBaFw0zNjA4
MjMwODIxNTBaMBUxEzARBgNVBAMMCnJ1bm5lci1yc2EwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDCWZwVSyLisRGfPT8Y6hLggwEQfCbJxxn68vdVuHB+
4Yh+UexrUZebOBNRGR7PkZBCxTtoSGxqPwDh8KdK1bMhaEv4fER7aVW7/I+WgRmY
LFrw8okp4ru4JYDtfRkSsEqMSS3gVx9ApfAY0+kQUsKg0WUBQ8LxZAKWklU0NyG8
sWAf5AqgE33OYxpPkwnDiEhab0s7GBjF3ln4wRmhcbcKAUJHza782xHsvA3BNJ9m
/GQKCyVswAboXHLm0kwNCBZOKmrLRboFe8e/0cT/wqXjYPVX01D/i10cddMXUDTX
tBXPdyvVAda0P/2yRnFQVOBJACYpN0DiwXv0LqvhSKl7AgMBAAGjTTBLMBUGA1Ud
EQQOMAyCCnJ1bm5lci1yc2EwEwYDVR0lBAwwCgYIKwYBBQUHAwIwHQYDVR0OBBYE
FE4x0u74J+ossEdymY1defic7uh7MA0GCSqGSIb3DQEBCwUAA4IBAQAY55gMP6r6
rQrXnToNlN3C7OuGfAWPNfd/Q6zObGeiFnxnizMMhcLIg6l9bhDZzBx+3QHTL+4I
hRGmd0pciMdv4UfRCtRkUonu6Kp+VS96eGJ95rdwgNLds8UWd1Er/ebEGKQHNUA0
/tWofDsvu7SR/YUUEwBo0mfbo8lrrfq3wVB1XTfJCaKSH7re9TMitvm2Zs5owNbB
WOOHxfMtejVf0FPnexp3KL/7s9EtWlv1sCfw/TfJ/MJA9w/70mjqGekCx/sLQWQ1
2jU8+/bop8WuFv/eHo/c9o9hGISgUP178StV+LykGTdPp+H1crwbLx7I9rRylq6c
CZ16vEh3Vs9p
-----END CERTIFICATE-----"#;

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

fn fingerprint(cert: &str) -> String {
    hex::encode(Sha256::digest(pem_der(cert)))
}

fn policy(cert: &str, runner_id: &str, san: &str) -> RunnerCertificatePolicy {
    let fp = fingerprint(cert);
    RunnerCertificatePolicy {
        runner_id: runner_id.to_string(),
        expected_fingerprint_sha256: fp.clone(),
        required_san: san.to_string(),
        trusted_issuer_fingerprint_sha256: Some(fp),
    }
}

fn pem_der(cert: &str) -> Vec<u8> {
    let body: String = cert
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    BASE64.decode(body).expect("fixture pem")
}

fn cert_verifier(
    clock: Arc<ManualClock>,
    policies: Vec<RunnerCertificatePolicy>,
) -> CertificateHandshakeVerifier<ManualClock> {
    CertificateHandshakeVerifier::new(PROTOCOL_MAJOR, INSTANCE, policies, clock, DEADLINE_MS)
}

fn sign_ecdsa(proof: &[u8]) -> String {
    let key = EcdsaSigningKey::from_pkcs8_pem(ECDSA_KEY).expect("ecdsa key");
    let signature: p256::ecdsa::Signature = key.sign(proof);
    BASE64.encode(signature.to_der())
}

fn sign_rsa_pss(proof: &[u8]) -> String {
    let key = RsaPrivateKey::from_pkcs8_pem(RSA_KEY).expect("rsa key");
    let signing_key = RsaPssSigningKey::<Sha256>::new(key);
    let mut rng = OsRng;
    let signature = signing_key.sign_with_rng(&mut rng, proof);
    BASE64.encode(signature.to_bytes())
}

#[test]
fn proof_bytes_match_the_ticket_27_contract_exactly() {
    assert_eq!(
        proof_bytes(1, "companion-1", "bm9uY2U=", "runner-1"),
        b"qualigence-companion-proof/v1\n1\ncompanion-1\nbm9uY2U=\nrunner-1\n".to_vec()
    );
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

#[test]
fn certificate_handshake_accepts_ecdsa_p256_client_auth_san_fingerprint_and_proof() {
    let clock = Arc::new(ManualClock::new(1_000));
    let mut v = cert_verifier(
        Arc::clone(&clock),
        vec![policy(ECDSA_CERT, "runner-1", "runner-1")],
    );
    let challenge = v
        .begin(PROTOCOL_MAJOR, "runner-1", ECDSA_CERT)
        .expect("begin");
    let proof = proof_bytes(
        PROTOCOL_MAJOR,
        INSTANCE,
        &challenge.nonce_base64(),
        "runner-1",
    );
    let signature = sign_ecdsa(&proof);
    let accepted = v
        .verify(
            "runner-1",
            &challenge.challenge_id,
            INSTANCE,
            &challenge.nonce_base64(),
            &signature,
            CompanionProofSignatureAlgorithm::EcdsaP256Sha256,
        )
        .expect("accepted");
    assert_eq!(accepted.runner_id, "runner-1");
    assert_eq!(
        accepted.signature_algorithm,
        CompanionProofSignatureAlgorithm::EcdsaP256Sha256
    );
}

#[test]
fn certificate_handshake_accepts_rsa_pss_client_auth_san_fingerprint_and_proof() {
    let clock = Arc::new(ManualClock::new(1_000));
    let mut v = cert_verifier(
        Arc::clone(&clock),
        vec![policy(RSA_CERT, "runner-rsa", "runner-rsa")],
    );
    let challenge = v
        .begin(PROTOCOL_MAJOR, "runner-rsa", RSA_CERT)
        .expect("begin");
    let proof = proof_bytes(
        PROTOCOL_MAJOR,
        INSTANCE,
        &challenge.nonce_base64(),
        "runner-rsa",
    );
    let signature = sign_rsa_pss(&proof);
    let accepted = v
        .verify(
            "runner-rsa",
            &challenge.challenge_id,
            INSTANCE,
            &challenge.nonce_base64(),
            &signature,
            CompanionProofSignatureAlgorithm::RsaPssSha256,
        )
        .expect("accepted");
    assert_eq!(accepted.runner_id, "runner-rsa");
    assert_eq!(
        accepted.signature_algorithm,
        CompanionProofSignatureAlgorithm::RsaPssSha256
    );
}

#[test]
fn certificate_handshake_rejects_wrong_fingerprint_san_algorithm_bad_signature_and_replay() {
    let clock = Arc::new(ManualClock::new(1_000));
    let wrong_fingerprint = RunnerCertificatePolicy {
        runner_id: "runner-1".to_string(),
        expected_fingerprint_sha256: "0".repeat(64),
        required_san: "runner-1".to_string(),
        trusted_issuer_fingerprint_sha256: None,
    };
    let mut v = cert_verifier(Arc::clone(&clock), vec![wrong_fingerprint]);
    assert_eq!(
        v.begin(PROTOCOL_MAJOR, "runner-1", ECDSA_CERT),
        Err(CertificateHandshakeError::Certificate(
            CertificateError::FingerprintMismatch
        ))
    );

    let mut v = cert_verifier(
        Arc::clone(&clock),
        vec![policy(ECDSA_CERT, "runner-1", "other-runner")],
    );
    assert_eq!(
        v.begin(PROTOCOL_MAJOR, "runner-1", ECDSA_CERT),
        Err(CertificateHandshakeError::Certificate(
            CertificateError::MissingRunnerSan
        ))
    );

    let mut v = cert_verifier(
        Arc::clone(&clock),
        vec![policy(ECDSA_CERT, "runner-1", "runner-1")],
    );
    let challenge = v
        .begin(PROTOCOL_MAJOR, "runner-1", ECDSA_CERT)
        .expect("begin");
    let proof = proof_bytes(
        PROTOCOL_MAJOR,
        INSTANCE,
        &challenge.nonce_base64(),
        "runner-1",
    );
    let signature = sign_ecdsa(&proof);
    assert_eq!(
        v.verify(
            "runner-1",
            &challenge.challenge_id,
            INSTANCE,
            &challenge.nonce_base64(),
            &signature,
            CompanionProofSignatureAlgorithm::RsaPssSha256,
        ),
        Err(CertificateHandshakeError::Certificate(
            CertificateError::SignatureAlgorithmMismatch
        ))
    );
    assert_eq!(
        v.verify(
            "runner-1",
            &challenge.challenge_id,
            INSTANCE,
            &challenge.nonce_base64(),
            &signature,
            CompanionProofSignatureAlgorithm::EcdsaP256Sha256,
        ),
        Err(CertificateHandshakeError::ReplayedChallenge)
    );

    let mut v = cert_verifier(
        Arc::clone(&clock),
        vec![policy(ECDSA_CERT, "runner-1", "runner-1")],
    );
    let challenge = v
        .begin(PROTOCOL_MAJOR, "runner-1", ECDSA_CERT)
        .expect("begin");
    assert_eq!(
        v.verify(
            "runner-1",
            &challenge.challenge_id,
            INSTANCE,
            &challenge.nonce_base64(),
            &BASE64.encode(b"not a signature"),
            CompanionProofSignatureAlgorithm::EcdsaP256Sha256,
        ),
        Err(CertificateHandshakeError::Certificate(
            CertificateError::MalformedSignature
        ))
    );
}

#[test]
fn certificate_challenge_expires_and_binds_instance_nonce_and_runner() {
    let clock = Arc::new(ManualClock::new(1_000));
    let mut v = cert_verifier(
        Arc::clone(&clock),
        vec![policy(ECDSA_CERT, "runner-1", "runner-1")],
    );
    let challenge = v
        .begin(PROTOCOL_MAJOR, "runner-1", ECDSA_CERT)
        .expect("begin");
    let proof = proof_bytes(
        PROTOCOL_MAJOR,
        INSTANCE,
        &challenge.nonce_base64(),
        "runner-1",
    );
    let signature = sign_ecdsa(&proof);

    assert_eq!(
        v.verify(
            "runner-1",
            &challenge.challenge_id,
            "other-instance",
            &challenge.nonce_base64(),
            &signature,
            CompanionProofSignatureAlgorithm::EcdsaP256Sha256,
        ),
        Err(CertificateHandshakeError::CompanionInstanceMismatch)
    );

    let mut v = cert_verifier(
        Arc::clone(&clock),
        vec![policy(ECDSA_CERT, "runner-1", "runner-1")],
    );
    let challenge = v
        .begin(PROTOCOL_MAJOR, "runner-1", ECDSA_CERT)
        .expect("begin");
    let proof = proof_bytes(
        PROTOCOL_MAJOR,
        INSTANCE,
        &challenge.nonce_base64(),
        "runner-1",
    );
    let signature = sign_ecdsa(&proof);
    assert_eq!(
        v.verify(
            "runner-1",
            &challenge.challenge_id,
            INSTANCE,
            "different-nonce",
            &signature,
            CompanionProofSignatureAlgorithm::EcdsaP256Sha256,
        ),
        Err(CertificateHandshakeError::NonceMismatch)
    );

    let mut v = cert_verifier(
        Arc::clone(&clock),
        vec![policy(ECDSA_CERT, "runner-1", "runner-1")],
    );
    let challenge = v
        .begin(PROTOCOL_MAJOR, "runner-1", ECDSA_CERT)
        .expect("begin");
    let proof = proof_bytes(
        PROTOCOL_MAJOR,
        INSTANCE,
        &challenge.nonce_base64(),
        "runner-1",
    );
    let signature = sign_ecdsa(&proof);
    clock.advance_monotonic(DEADLINE_MS + 1);
    assert_eq!(
        v.verify(
            "runner-1",
            &challenge.challenge_id,
            INSTANCE,
            &challenge.nonce_base64(),
            &signature,
            CompanionProofSignatureAlgorithm::EcdsaP256Sha256,
        ),
        Err(CertificateHandshakeError::Expired)
    );
}
