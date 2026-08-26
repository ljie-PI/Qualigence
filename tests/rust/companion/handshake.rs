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
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgLpkHlViRQ/JRu+f5
zoJiFJ7jtNK5l0g7+epxAKmzyNahRANCAARLLuvzUOW6FeHl03eam9Z5jMB2CLwA
9SjDUf/t+ocb1Q3882yfOqpgKOUHmXigPa4ubfMorvsv3CBR4uqHP94Y
-----END PRIVATE KEY-----"#;

const ECDSA_CERT: &str = r#"-----BEGIN CERTIFICATE-----
MIICJjCCAc2gAwIBAgIUTlwcdg0R28tGWcSOPvwTmv1Nx2gwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZUXVhbGlnZW5jZSBUZXN0IFJ1bm5lciBDQTAeFw0yNjA4MjYw
ODUzMjNaFw0zNjA4MjMwODUzMjNaMBMxETAPBgNVBAMMCHJ1bm5lci0xMFkwEwYH
KoZIzj0CAQYIKoZIzj0DAQcDQgAESy7r81DluhXh5dN3mpvWeYzAdgi8APUow1H/
7fqHG9UN/PNsnzqqYCjlB5l4oD2uLm3zKK77L9wgUeLqhz/eGKOB7TCB6jAMBgNV
HRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDAjB1
BgNVHREEbjBsgghydW5uZXItMYYedXJuOnF1YWxpZ2VuY2U6cnVubmVyOnJ1bm5l
ci0xhh51cm46cXVhbGlnZW5jZTp0ZW5hbnQ6dGVuYW50LTGGIHVybjpxdWFsaWdl
bmNlOnByb2plY3Q6cHJvamVjdC0xMB0GA1UdDgQWBBSmTjV1yMrhLbt3kYxXFi0S
W4TNVzAfBgNVHSMEGDAWgBT9wrZDegq05yv6vcNZRs55b/AFjzAKBggqhkjOPQQD
AgNHADBEAiAGp3MPTsz5WdGOxTK6xqvZxzQctZlfl/YiogQLuda26wIgbA6yekPk
khXIzEH9gv0fW/FKFd53I60UDdEfnA158Xc=
-----END CERTIFICATE-----"#;

const RSA_KEY: &str = r#"-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7842WC/QANcuF
dfCuoeiPQhtr9C0IzRfI5R5wBeEj57M0sXYNWKCbrJQj9/UlEqjrUeVIERpu95fD
jH6v8Dlal/MwQxMpXmicwYsXbdW2aD6HLEqUeMmwUwhWWfbwb2Qi1Xcm0co+UmXx
jzXDFSTsJdMgIMyXb3yY0GZFCdo4qKnzi4G2ntkhTdb3NVn/Jb7pSsJcDuo2LW8q
NiGHrXTFii8eDw/xfSBKnRFmgrWPCkccKKD5jQ17zz+8jYCzN3BcZjCKgzR0vRby
8Obgyg6MIsjm13nrjZQKJG2Y2XVKqrVG3B6s7G4b7PJ+ml5FRtMP0wXH7QXtZsKp
zfBh34pFAgMBAAECggEABGAqcO6Uzudxtkj1Yj9rOGCX3lbIMJ8DuX3aDE4avHkB
s02ZW7yvOoiVR1QXvTX2wEm/DoM1bBVwD1GnRmXPlAQbGYnKOamUwmeAGzrHobBC
GmgF0XiRa303YblE9jqFqIjzNfBm5rYI4QuOOx00J5pG1MXmtXTXQACEDQHqdmyu
jaNje1dVOP6p4oI9XKrg2PaQ2x7plATjy3tgwjA+clKVEyrp33OtOKoqAF4QpLXx
bxHQ9f8u5QhodseCrkZWBTmxwozbGpPSWMJqdFjZhbimtXjXM4ZLs539wm/moTbV
/RtSE6dBduvG85oDjpvB3TXrP5BSVyFwELMOn9y+sQKBgQDvTt9ZDAuGkIigdjDA
VKCEwU02jRpvDTmy5HjqtPVlqGb7G+4TsHuMxUUhUznthj+tqidbz5ujCVlTs5xs
8g6zQCp0+TBGu67Bk60JISOu9bdQuQd9F0oZzlAbIiUONbGA2Q+sORKsSUMKdn/r
22OGiH00cNnYA9ioJBVCRS9tEQKBgQDJD6Vio8+sRrY3Wx6LgPP2sNWvboRIVQsW
xdCjE3vtSzCkrUXZgLb3VqJdd3vJX1AMlimzmT6917X5mBwUQIGS8ZReR4U9GNUh
jfMVSKNqxoDfuXG/GzzamYF01HhoZ6frk8rSg7wKBngYX9yB1FZnrGkT/wRuI/ti
L6Bhcn2Z9QKBgDrthx4cUzI9oQcyU2ro6+YE24iVUm8KKK0eiY/yI4N25nTrOcLr
cGEHqrA8GEWfC0suXSbEhqStBqwPzHMfX/NP16SaQAMK8EuGm9Nlr63Dn/JmvatV
8s9L+HnV/J31JtJ9oNhd7XUzTSjkaTeg/G8CaSJir6H7wHwW9o0tEDKhAoGBAJlQ
uvZKn3NowE3Zx6LtBBtaoLcTeP+HCduloACaPOenbEJGdnrycZKNl2XaVKQrb+kJ
IGd5NaShtnvLB65RufyJBnAV7X23T940VeYm66XiFCeFSz1E0dSHNXYXBnHmiN9U
ZVa9aUfjwvQjNQwzFGgdykqbLY+nFGu8kXl9SlV5AoGAVmM9EbDluPUn0yR3RuRm
6hZjp8kbzLwfBK7kIxcw3rd5MpCUGC2+VBO+lbhhpCRkDoJQuYrV5dJ9Pu8g++jw
8EXCSlCChzH9IH6tQwf6cHoQXcILDiB7huVAzKZjY8T9z5DVVD7LHAAuNAuUbTS8
lxPvy2pc7Yu8lHniveE00XQ=
-----END PRIVATE KEY-----"#;

const RSA_CERT: &str = r#"-----BEGIN CERTIFICATE-----
MIIC+TCCAp6gAwIBAgIUTlwcdg0R28tGWcSOPvwTmv1Nx2kwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZUXVhbGlnZW5jZSBUZXN0IFJ1bm5lciBDQTAeFw0yNjA4MjYw
ODUzMjRaFw0zNjA4MjMwODUzMjRaMBUxEzARBgNVBAMMCnJ1bm5lci1yc2EwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7842WC/QANcuFdfCuoeiPQhtr
9C0IzRfI5R5wBeEj57M0sXYNWKCbrJQj9/UlEqjrUeVIERpu95fDjH6v8Dlal/Mw
QxMpXmicwYsXbdW2aD6HLEqUeMmwUwhWWfbwb2Qi1Xcm0co+UmXxjzXDFSTsJdMg
IMyXb3yY0GZFCdo4qKnzi4G2ntkhTdb3NVn/Jb7pSsJcDuo2LW8qNiGHrXTFii8e
Dw/xfSBKnRFmgrWPCkccKKD5jQ17zz+8jYCzN3BcZjCKgzR0vRby8Obgyg6MIsjm
13nrjZQKJG2Y2XVKqrVG3B6s7G4b7PJ+ml5FRtMP0wXH7QXtZsKpzfBh34pFAgMB
AAGjgfEwge4wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAww
CgYIKwYBBQUHAwIweQYDVR0RBHIwcIIKcnVubmVyLXJzYYYgdXJuOnF1YWxpZ2Vu
Y2U6cnVubmVyOnJ1bm5lci1yc2GGHnVybjpxdWFsaWdlbmNlOnRlbmFudDp0ZW5h
bnQtMYYgdXJuOnF1YWxpZ2VuY2U6cHJvamVjdDpwcm9qZWN0LTEwHQYDVR0OBBYE
FCqJcUYmM1dTwio2HwX1+IIF/4cUMB8GA1UdIwQYMBaAFP3CtkN6CrTnK/q9w1lG
znlv8AWPMAoGCCqGSM49BAMCA0kAMEYCIQDIJeGN/4BuPj95iaz3FEIov6KjZyUN
XfWmTBhW42yw0gIhAK0YkcLIpYYg6HWHgC+i04H3JhxCHVLI2Io7uD1ASfCP
-----END CERTIFICATE-----"#;

const CA_CERT: &str = r#"-----BEGIN CERTIFICATE-----
MIIBsTCCAVagAwIBAgIUd4XQSEbTF76koS/80HeYebOZh10wCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZUXVhbGlnZW5jZSBUZXN0IFJ1bm5lciBDQTAeFw0yNjA4MjYw
ODUzMjNaFw0zNjA4MjMwODUzMjNaMCQxIjAgBgNVBAMMGVF1YWxpZ2VuY2UgVGVz
dCBSdW5uZXIgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATKvUOn4Xa5k3qo
g497Un732k31Crr1Jvz34UAWd3zsidoVSnULPnuChjPZ4HrmWacnHCogmoMG7eue
fnv8mZYSo2YwZDASBgNVHRMBAf8ECDAGAQH/AgEBMA4GA1UdDwEB/wQEAwIBBjAd
BgNVHQ4EFgQU/cK2Q3oKtOcr+r3DWUbOeW/wBY8wHwYDVR0jBBgwFoAU/cK2Q3oK
tOcr+r3DWUbOeW/wBY8wCgYIKoZIzj0EAwIDSQAwRgIhAMV+8OhJBQh8D5uro3as
mHzX07UK31vFNoS8JMxsdg2wAiEAkhXKJ0LsSqHY3FE1OMRZY8C7tum8bsuPuG4E
DzQHpEk=
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

fn chain(leaf: &str) -> String {
    format!("{leaf}\n{CA_CERT}")
}

fn policy(cert: &str, runner_id: &str, san: &str) -> RunnerCertificatePolicy {
    RunnerCertificatePolicy {
        runner_id: runner_id.to_string(),
        expected_fingerprint_sha256: fingerprint(cert),
        required_san: san.to_string(),
        required_scope_sans: vec![
            format!("urn:qualigence:runner:{runner_id}"),
            "urn:qualigence:tenant:tenant-1".to_string(),
            "urn:qualigence:project:project-1".to_string(),
        ],
        trusted_issuer_fingerprint_sha256: Some(fingerprint(CA_CERT)),
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
        .begin(PROTOCOL_MAJOR, "runner-1", &chain(ECDSA_CERT))
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
        .begin(PROTOCOL_MAJOR, "runner-rsa", &chain(RSA_CERT))
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
        required_scope_sans: vec![
            "urn:qualigence:runner:runner-1".to_string(),
            "urn:qualigence:tenant:tenant-1".to_string(),
            "urn:qualigence:project:project-1".to_string(),
        ],
        trusted_issuer_fingerprint_sha256: Some(fingerprint(CA_CERT)),
    };
    let mut v = cert_verifier(Arc::clone(&clock), vec![wrong_fingerprint]);
    assert_eq!(
        v.begin(PROTOCOL_MAJOR, "runner-1", &chain(ECDSA_CERT)),
        Err(CertificateHandshakeError::Certificate(
            CertificateError::FingerprintMismatch
        ))
    );

    let mut v = cert_verifier(
        Arc::clone(&clock),
        vec![policy(ECDSA_CERT, "runner-1", "other-runner")],
    );
    assert_eq!(
        v.begin(PROTOCOL_MAJOR, "runner-1", &chain(ECDSA_CERT)),
        Err(CertificateHandshakeError::Certificate(
            CertificateError::MissingRunnerSan
        ))
    );

    let mut wrong_scope = policy(ECDSA_CERT, "runner-1", "runner-1");
    wrong_scope
        .required_scope_sans
        .push("urn:qualigence:project:not-allowed".to_string());
    let mut v = cert_verifier(Arc::clone(&clock), vec![wrong_scope]);
    assert_eq!(
        v.begin(PROTOCOL_MAJOR, "runner-1", &chain(ECDSA_CERT)),
        Err(CertificateHandshakeError::Certificate(
            CertificateError::MissingRunnerSan
        ))
    );

    let mut v = cert_verifier(
        Arc::clone(&clock),
        vec![policy(ECDSA_CERT, "runner-1", "runner-1")],
    );
    assert_eq!(
        v.begin(PROTOCOL_MAJOR, "runner-1", ECDSA_CERT),
        Err(CertificateHandshakeError::Certificate(
            CertificateError::ChainRejected
        ))
    );

    let mut v = cert_verifier(
        Arc::clone(&clock),
        vec![policy(ECDSA_CERT, "runner-1", "runner-1")],
    );
    let challenge = v
        .begin(PROTOCOL_MAJOR, "runner-1", &chain(ECDSA_CERT))
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
        .begin(PROTOCOL_MAJOR, "runner-1", &chain(ECDSA_CERT))
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
        .begin(PROTOCOL_MAJOR, "runner-1", &chain(ECDSA_CERT))
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
        .begin(PROTOCOL_MAJOR, "runner-1", &chain(ECDSA_CERT))
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
        .begin(PROTOCOL_MAJOR, "runner-1", &chain(ECDSA_CERT))
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
            "runner-2",
            &challenge.challenge_id,
            INSTANCE,
            &challenge.nonce_base64(),
            &signature,
            CompanionProofSignatureAlgorithm::EcdsaP256Sha256,
        ),
        Err(CertificateHandshakeError::RunnerMismatch)
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
        .begin(PROTOCOL_MAJOR, "runner-1", &chain(ECDSA_CERT))
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
