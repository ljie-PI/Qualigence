//! IPC peer-identity verification and the certificate challenge-response
//! handshake.
//!
//! The production Windows target authenticates a Runner in two layers before any
//! application request is admitted:
//!
//! 1. the Named Pipe listener is a first-instance, local-only endpoint whose
//!    DACL is scoped to the current logon SID and LocalSystem; after accept the
//!    Companion re-reads the client's PID, token SID, logon SID, interactive
//!    session and canonical image path; and
//! 2. the Runner proves possession of its enrolled mTLS private key by signing a
//!    one-use 256-bit nonce over the exact Ticket 27 byte vector
//!    `qualigence-companion-proof/v1\n{protocolMajor}\n{companionInstanceId}\n{nonceBase64}\n{runnerId}\n`.
//!
//! Portable Unix peer-credential helpers remain only to keep the transport-
//! independent state machines testable on non-Windows hosts. The Windows native
//! peer implementation lives in [`crate::ipc::windows_pipe`].

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature as Ed25519Signature, Signer, SigningKey, Verifier, VerifyingKey};
use p256::ecdsa::{Signature as EcdsaSignature, VerifyingKey as EcdsaVerifyingKey};
use rsa::pkcs8::DecodePublicKey;
use rsa::pss::{Signature as RsaPssSignature, VerifyingKey as RsaPssVerifyingKey};
use rsa::RsaPublicKey;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use signature::hazmat::PrehashVerifier;
use x509_parser::extensions::{GeneralName, ParsedExtension};
use x509_parser::pem::parse_x509_pem;
use x509_parser::prelude::*;

use crate::clock::Clock;
use crate::random::random_bytes;

/// OS-level identity of a connected peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerIdentity {
    /// Peer process id (`-1` when the platform cannot report it).
    pub pid: i32,
    pub uid: u32,
    pub gid: u32,
}

/// A transport that can report its connected peer's OS credentials.
pub trait PeerCredentialSource {
    fn peer_identity(&self) -> io::Result<PeerIdentity>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum IdentityError {
    /// The peer is not the expected local Runner identity.
    CompanionIdentityRejected,
}

/// Enforces that a connecting peer runs as the same local user as the Companion.
/// This is the portable analogue of the Windows logon-SID DACL check.
pub struct PeerAuthorizer {
    expected_uid: u32,
}

impl PeerAuthorizer {
    pub fn with_expected_uid(expected_uid: u32) -> Self {
        Self { expected_uid }
    }

    /// The Companion's own effective uid: the only uid permitted to connect.
    #[cfg(unix)]
    pub fn current_user() -> Self {
        let uid = unsafe { libc::geteuid() };
        Self { expected_uid: uid }
    }

    pub fn expected_uid(&self) -> u32 {
        self.expected_uid
    }

    pub fn authorize(&self, peer: PeerIdentity) -> Result<(), IdentityError> {
        if peer.uid == self.expected_uid {
            Ok(())
        } else {
            Err(IdentityError::CompanionIdentityRejected)
        }
    }

    /// Convenience: read + verify a transport's peer credentials in one step.
    pub fn authorize_source<T: PeerCredentialSource>(
        &self,
        source: &T,
    ) -> Result<PeerIdentity, IdentityError> {
        let peer = source
            .peer_identity()
            .map_err(|_| IdentityError::CompanionIdentityRejected)?;
        self.authorize(peer)?;
        Ok(peer)
    }
}

#[cfg(unix)]
mod unix_peer {
    use super::PeerIdentity;
    use std::io;
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::UnixStream;

    #[cfg(target_os = "linux")]
    pub fn peer_identity(stream: &UnixStream) -> io::Result<PeerIdentity> {
        let mut cred = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let ret = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut cred as *mut libc::ucred as *mut libc::c_void,
                &mut len,
            )
        };
        if ret != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(PeerIdentity {
            pid: cred.pid,
            uid: cred.uid,
            gid: cred.gid,
        })
    }

    #[cfg(not(target_os = "linux"))]
    pub fn peer_identity(stream: &UnixStream) -> io::Result<PeerIdentity> {
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        let ret = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
        if ret != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(PeerIdentity { pid: -1, uid, gid })
    }
}

#[cfg(unix)]
impl PeerCredentialSource for std::os::unix::net::UnixStream {
    fn peer_identity(&self) -> io::Result<PeerIdentity> {
        unix_peer::peer_identity(self)
    }
}

/// Windows Named Pipe peer-identity adapter. Full SID/session/image admission is
/// exposed by [`crate::ipc::windows_pipe`]; this compatibility adapter replaces
/// the former `Unsupported` placeholder for callers that only need the peer PID.
#[cfg(windows)]
pub struct NamedPipePeer {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl NamedPipePeer {
    pub fn new(handle: windows_sys::Win32::Foundation::HANDLE) -> Self {
        Self { handle }
    }
}

#[cfg(windows)]
impl PeerCredentialSource for NamedPipePeer {
    fn peer_identity(&self) -> io::Result<PeerIdentity> {
        let mut pid = 0u32;
        let ok = unsafe {
            windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId(self.handle, &mut pid)
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(PeerIdentity {
            pid: pid as i32,
            uid: 0,
            gid: 0,
        })
    }
}

// --- Certificate-style challenge-response handshake ---------------------------

const COMPANION_PROOF_CONTEXT: &str = "qualigence-companion-proof/v1";

/// A Runner registration: the runnerId bound to the public key whose SHA-256
/// fingerprint the Companion trusts. This Ed25519 helper is portable test-only;
/// Windows production admission uses [`CertificateHandshakeVerifier`] below.
#[derive(Clone)]
pub struct RunnerRegistration {
    pub runner_id: String,
    pub verifying_key: VerifyingKey,
}

/// A pending, single-use challenge issued to a specific Runner.
struct PendingChallenge {
    runner_id: String,
    nonce: [u8; 32],
    issued_monotonic_ms: u64,
}

/// The proof handed to a Runner: a random nonce it must sign.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    pub challenge_id: String,
    pub nonce: [u8; 32],
}

impl Challenge {
    pub fn nonce_base64(&self) -> String {
        BASE64.encode(self.nonce)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthenticatedRunner<'a> {
    pub runner_id: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HandshakeError {
    UnknownRunner,
    UnknownChallenge,
    RunnerMismatch,
    ReplayedChallenge,
    Expired,
    BadSignature,
    MalformedSignature,
    WrongProtocol,
}

/// Verifies the portable Ed25519 test identity via a nonce. Use
/// [`CertificateHandshakeVerifier`] for the production Runner mTLS profile.
pub struct HandshakeVerifier<C: Clock> {
    protocol_major: u8,
    companion_instance_id: String,
    registrations: HashMap<String, VerifyingKey>,
    pending: HashMap<String, PendingChallenge>,
    consumed_challenges: HashSet<String>,
    clock: Arc<C>,
    deadline_ms: u64,
}

impl<C: Clock> HandshakeVerifier<C> {
    pub fn new(
        protocol_major: u8,
        companion_instance_id: impl Into<String>,
        registrations: impl IntoIterator<Item = RunnerRegistration>,
        clock: Arc<C>,
        deadline_ms: u64,
    ) -> Self {
        let registrations = registrations
            .into_iter()
            .map(|r| (r.runner_id, r.verifying_key))
            .collect();
        Self {
            protocol_major,
            companion_instance_id: companion_instance_id.into(),
            registrations,
            pending: HashMap::new(),
            consumed_challenges: HashSet::new(),
            clock,
            deadline_ms,
        }
    }

    /// The exact Ticket 27 byte vector a Runner must sign.
    pub fn message_to_sign(
        protocol_major: u8,
        companion_instance_id: &str,
        nonce: &[u8],
        runner_id: &str,
    ) -> Vec<u8> {
        proof_bytes(
            protocol_major,
            companion_instance_id,
            &BASE64.encode(nonce),
            runner_id,
        )
    }

    /// Begin a handshake for `runner_id`, minting a single-use nonce challenge.
    pub fn begin(
        &mut self,
        protocol_major: u8,
        runner_id: &str,
    ) -> Result<Challenge, HandshakeError> {
        if protocol_major != self.protocol_major {
            return Err(HandshakeError::WrongProtocol);
        }
        if !self.registrations.contains_key(runner_id) {
            return Err(HandshakeError::UnknownRunner);
        }
        let challenge_id = BASE64.encode(random_bytes::<16>());
        let nonce = random_bytes::<32>();
        self.pending.insert(
            challenge_id.clone(),
            PendingChallenge {
                runner_id: runner_id.to_string(),
                nonce,
                issued_monotonic_ms: self.clock.monotonic_ms(),
            },
        );
        Ok(Challenge {
            challenge_id,
            nonce,
        })
    }

    /// Verify a Runner's signature over the challenge nonce. Consumes the
    /// challenge on both success and definitive failure so it can never be
    /// replayed.
    pub fn verify<'a>(
        &mut self,
        runner_id: &'a str,
        challenge_id: &str,
        signature_base64: &str,
    ) -> Result<AuthenticatedRunner<'a>, HandshakeError> {
        if self.consumed_challenges.contains(challenge_id) {
            return Err(HandshakeError::ReplayedChallenge);
        }
        let pending = self
            .pending
            .get(challenge_id)
            .ok_or(HandshakeError::UnknownChallenge)?;
        if pending.runner_id != runner_id {
            return Err(HandshakeError::RunnerMismatch);
        }

        let now = self.clock.monotonic_ms();
        let expired = now.saturating_sub(pending.issued_monotonic_ms) > self.deadline_ms;

        let key = self
            .registrations
            .get(runner_id)
            .ok_or(HandshakeError::UnknownRunner)?;
        let message = Self::message_to_sign(
            self.protocol_major,
            &self.companion_instance_id,
            &pending.nonce,
            runner_id,
        );

        let signature_bytes = BASE64
            .decode(signature_base64)
            .map_err(|_| HandshakeError::MalformedSignature)?;
        let signature = Ed25519Signature::from_slice(&signature_bytes)
            .map_err(|_| HandshakeError::MalformedSignature)?;

        let signature_ok = key.verify(&message, &signature).is_ok();

        self.pending.remove(challenge_id);
        self.consumed_challenges.insert(challenge_id.to_string());

        if expired {
            return Err(HandshakeError::Expired);
        }
        if !signature_ok {
            return Err(HandshakeError::BadSignature);
        }
        Ok(AuthenticatedRunner { runner_id })
    }
}

/// The Runner side of the portable Ed25519 test handshake.
pub struct RunnerSigner {
    signing_key: SigningKey,
    pub runner_id: String,
}

impl RunnerSigner {
    pub fn generate(runner_id: impl Into<String>) -> Self {
        let signing_key = SigningKey::from_bytes(&random_bytes::<32>());
        Self {
            signing_key,
            runner_id: runner_id.into(),
        }
    }

    pub fn from_seed(runner_id: impl Into<String>, seed: [u8; 32]) -> Self {
        Self {
            signing_key: SigningKey::from_bytes(&seed),
            runner_id: runner_id.into(),
        }
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing_key.verifying_key()
    }

    pub fn registration(&self) -> RunnerRegistration {
        RunnerRegistration {
            runner_id: self.runner_id.clone(),
            verifying_key: self.verifying_key(),
        }
    }

    /// Produce the base64 signature over a challenge from `verifier`.
    pub fn prove(
        &self,
        protocol_major: u8,
        companion_instance_id: &str,
        challenge: &Challenge,
    ) -> String {
        let message = HandshakeVerifier::<crate::clock::SystemClock>::message_to_sign(
            protocol_major,
            companion_instance_id,
            &challenge.nonce,
            &self.runner_id,
        );
        let signature = self.signing_key.sign(&message);
        BASE64.encode(signature.to_bytes())
    }
}

// --- Production certificate/mTLS-key handshake --------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompanionProofSignatureAlgorithm {
    EcdsaP256Sha256,
    RsaPssSha256,
}

impl CompanionProofSignatureAlgorithm {
    pub fn parse(value: &str) -> Result<Self, CertificateError> {
        match value {
            "ecdsa-p256-sha256" => Ok(Self::EcdsaP256Sha256),
            "rsa-pss-sha256" => Ok(Self::RsaPssSha256),
            _ => Err(CertificateError::UnsupportedKeyAlgorithm),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::EcdsaP256Sha256 => "ecdsa-p256-sha256",
            Self::RsaPssSha256 => "rsa-pss-sha256",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerCertificatePolicy {
    pub runner_id: String,
    pub expected_fingerprint_sha256: String,
    pub required_san: String,
    pub required_scope_sans: Vec<String>,
    pub trusted_issuer_fingerprint_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedRunnerCertificate {
    pub runner_id: String,
    pub fingerprint_sha256: String,
    pub public_key_algorithm: CompanionProofSignatureAlgorithm,
    pub der: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CertificateError {
    MalformedCertificate,
    ExpiredCertificate,
    MissingClientAuthEku,
    MissingRunnerSan,
    FingerprintMismatch,
    ChainRejected,
    UnsupportedKeyAlgorithm,
    SignatureAlgorithmMismatch,
    MalformedSignature,
    BadSignature,
}

struct PendingCertificateChallenge {
    runner_id: String,
    nonce_base64: String,
    issued_monotonic_ms: u64,
    certificate: ValidatedRunnerCertificate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedCertificateRunner {
    pub runner_id: String,
    pub certificate_sha256_fingerprint: String,
    pub signature_algorithm: CompanionProofSignatureAlgorithm,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CertificateHandshakeError {
    UnknownRunner,
    UnknownChallenge,
    RunnerMismatch,
    CompanionInstanceMismatch,
    NonceMismatch,
    ReplayedChallenge,
    Expired,
    WrongProtocol,
    Certificate(CertificateError),
}

pub struct CertificateHandshakeVerifier<C: Clock> {
    protocol_major: u8,
    companion_instance_id: String,
    policies: HashMap<String, RunnerCertificatePolicy>,
    pending: HashMap<String, PendingCertificateChallenge>,
    consumed_challenges: HashSet<String>,
    clock: Arc<C>,
    deadline_ms: u64,
}

impl<C: Clock> CertificateHandshakeVerifier<C> {
    pub fn new(
        protocol_major: u8,
        companion_instance_id: impl Into<String>,
        policies: impl IntoIterator<Item = RunnerCertificatePolicy>,
        clock: Arc<C>,
        deadline_ms: u64,
    ) -> Self {
        Self {
            protocol_major,
            companion_instance_id: companion_instance_id.into(),
            policies: policies
                .into_iter()
                .map(|p| (p.runner_id.clone(), p))
                .collect(),
            pending: HashMap::new(),
            consumed_challenges: HashSet::new(),
            clock,
            deadline_ms,
        }
    }

    pub fn companion_instance_id(&self) -> &str {
        &self.companion_instance_id
    }

    pub fn begin(
        &mut self,
        protocol_major: u8,
        runner_id: &str,
        certificate_pem: &str,
    ) -> Result<Challenge, CertificateHandshakeError> {
        if protocol_major != self.protocol_major {
            return Err(CertificateHandshakeError::WrongProtocol);
        }
        let policy = self
            .policies
            .get(runner_id)
            .ok_or(CertificateHandshakeError::UnknownRunner)?;
        let certificate = validate_runner_certificate(certificate_pem, policy)
            .map_err(CertificateHandshakeError::Certificate)?;
        let challenge_id = BASE64.encode(random_bytes::<16>());
        let nonce = random_bytes::<32>();
        let nonce_base64 = BASE64.encode(nonce);
        self.pending.insert(
            challenge_id.clone(),
            PendingCertificateChallenge {
                runner_id: runner_id.to_string(),
                nonce_base64,
                issued_monotonic_ms: self.clock.monotonic_ms(),
                certificate,
            },
        );
        Ok(Challenge {
            challenge_id,
            nonce,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn verify(
        &mut self,
        runner_id: &str,
        challenge_id: &str,
        companion_instance_id: &str,
        nonce_base64: &str,
        signature_base64: &str,
        signature_algorithm: CompanionProofSignatureAlgorithm,
    ) -> Result<AuthenticatedCertificateRunner, CertificateHandshakeError> {
        if self.consumed_challenges.contains(challenge_id) {
            return Err(CertificateHandshakeError::ReplayedChallenge);
        }
        let pending = self
            .pending
            .remove(challenge_id)
            .ok_or(CertificateHandshakeError::UnknownChallenge)?;
        self.consumed_challenges.insert(challenge_id.to_string());
        if pending.runner_id != runner_id {
            return Err(CertificateHandshakeError::RunnerMismatch);
        }
        if companion_instance_id != self.companion_instance_id {
            return Err(CertificateHandshakeError::CompanionInstanceMismatch);
        }
        if nonce_base64 != pending.nonce_base64 {
            return Err(CertificateHandshakeError::NonceMismatch);
        }

        let expired = self
            .clock
            .monotonic_ms()
            .saturating_sub(pending.issued_monotonic_ms)
            > self.deadline_ms;
        let proof = proof_bytes(
            self.protocol_major,
            &self.companion_instance_id,
            &pending.nonce_base64,
            runner_id,
        );
        let certificate = pending.certificate.clone();

        if expired {
            return Err(CertificateHandshakeError::Expired);
        }
        verify_certificate_signature(&certificate, &proof, signature_base64, signature_algorithm)
            .map_err(CertificateHandshakeError::Certificate)?;
        Ok(AuthenticatedCertificateRunner {
            runner_id: certificate.runner_id,
            certificate_sha256_fingerprint: certificate.fingerprint_sha256,
            signature_algorithm,
        })
    }
}

pub fn proof_bytes(
    protocol_major: u8,
    companion_instance_id: &str,
    nonce_base64: &str,
    runner_id: &str,
) -> Vec<u8> {
    format!(
        "{COMPANION_PROOF_CONTEXT}\n{protocol_major}\n{companion_instance_id}\n{nonce_base64}\n{runner_id}\n"
    )
    .into_bytes()
}

pub fn validate_runner_certificate(
    certificate_pem: &str,
    policy: &RunnerCertificatePolicy,
) -> Result<ValidatedRunnerCertificate, CertificateError> {
    let chain_der = certificate_chain_der(certificate_pem.as_bytes())?;
    let der = chain_der
        .first()
        .ok_or(CertificateError::MalformedCertificate)?
        .clone();
    let certificates = parse_certificate_chain(&chain_der)?;
    let cert = certificates
        .first()
        .ok_or(CertificateError::MalformedCertificate)?;

    validate_chain_path(&certificates, &chain_der, policy)?;

    if !has_client_auth_eku(cert) {
        return Err(CertificateError::MissingClientAuthEku);
    }
    if !has_required_san(cert, &policy.required_san)
        || policy
            .required_scope_sans
            .iter()
            .any(|required| !has_required_san(cert, required))
    {
        return Err(CertificateError::MissingRunnerSan);
    }
    let fingerprint_sha256 = hex::encode(Sha256::digest(&der));
    if !fingerprint_sha256.eq_ignore_ascii_case(&policy.expected_fingerprint_sha256) {
        return Err(CertificateError::FingerprintMismatch);
    }

    let public_key_algorithm = public_key_algorithm(cert)?;
    Ok(ValidatedRunnerCertificate {
        runner_id: policy.runner_id.clone(),
        fingerprint_sha256,
        public_key_algorithm,
        der,
    })
}

pub fn verify_certificate_signature(
    certificate: &ValidatedRunnerCertificate,
    proof_bytes: &[u8],
    signature_base64: &str,
    signature_algorithm: CompanionProofSignatureAlgorithm,
) -> Result<(), CertificateError> {
    if signature_algorithm != certificate.public_key_algorithm {
        return Err(CertificateError::SignatureAlgorithmMismatch);
    }
    let (_, cert) = X509Certificate::from_der(&certificate.der)
        .map_err(|_| CertificateError::MalformedCertificate)?;
    let spki_der = cert.public_key().raw;
    let signature_bytes = BASE64
        .decode(signature_base64)
        .map_err(|_| CertificateError::MalformedSignature)?;
    match signature_algorithm {
        CompanionProofSignatureAlgorithm::EcdsaP256Sha256 => {
            let key = EcdsaVerifyingKey::from_public_key_der(spki_der)
                .map_err(|_| CertificateError::UnsupportedKeyAlgorithm)?;
            let sig = EcdsaSignature::from_der(&signature_bytes)
                .or_else(|_| EcdsaSignature::from_slice(&signature_bytes))
                .map_err(|_| CertificateError::MalformedSignature)?;
            key.verify(proof_bytes, &sig)
                .map_err(|_| CertificateError::BadSignature)
        }
        CompanionProofSignatureAlgorithm::RsaPssSha256 => {
            let key = RsaPublicKey::from_public_key_der(spki_der)
                .map_err(|_| CertificateError::UnsupportedKeyAlgorithm)?;
            let verifying_key = RsaPssVerifyingKey::<Sha256>::new(key);
            let sig = RsaPssSignature::try_from(signature_bytes.as_slice())
                .map_err(|_| CertificateError::MalformedSignature)?;
            let digest = Sha256::digest(proof_bytes);
            verifying_key
                .verify_prehash(&digest, &sig)
                .map_err(|_| CertificateError::BadSignature)
        }
    }
}

fn certificate_chain_der(input: &[u8]) -> Result<Vec<Vec<u8>>, CertificateError> {
    if input.starts_with(b"-----BEGIN") {
        let mut rest = input;
        let mut chain = Vec::new();
        while rest.iter().any(|byte| !byte.is_ascii_whitespace()) {
            let (remaining, pem) =
                parse_x509_pem(rest).map_err(|_| CertificateError::MalformedCertificate)?;
            chain.push(pem.contents.to_vec());
            rest = remaining;
        }
        if chain.is_empty() {
            Err(CertificateError::MalformedCertificate)
        } else {
            Ok(chain)
        }
    } else {
        Ok(vec![input.to_vec()])
    }
}

fn parse_certificate_chain<'a>(
    chain_der: &'a [Vec<u8>],
) -> Result<Vec<X509Certificate<'a>>, CertificateError> {
    chain_der
        .iter()
        .map(|der| {
            X509Certificate::from_der(der)
                .map(|(_, cert)| cert)
                .map_err(|_| CertificateError::MalformedCertificate)
        })
        .collect()
}

fn validate_chain_path(
    certificates: &[X509Certificate<'_>],
    chain_der: &[Vec<u8>],
    policy: &RunnerCertificatePolicy,
) -> Result<(), CertificateError> {
    if certificates.is_empty() {
        return Err(CertificateError::MalformedCertificate);
    }
    if certificates
        .iter()
        .any(|certificate| !certificate.validity().is_valid())
    {
        return Err(CertificateError::ExpiredCertificate);
    }

    let trusted = policy
        .trusted_issuer_fingerprint_sha256
        .as_ref()
        .ok_or(CertificateError::ChainRejected)?;
    let trust_anchor = certificates.last().ok_or(CertificateError::ChainRejected)?;
    let trust_anchor_der = chain_der.last().ok_or(CertificateError::ChainRejected)?;
    let trust_anchor_fingerprint = hex::encode(Sha256::digest(trust_anchor_der));
    if !trusted.eq_ignore_ascii_case(&trust_anchor_fingerprint) {
        return Err(CertificateError::ChainRejected);
    }

    if certificates.len() == 1 {
        let cert = &certificates[0];
        if cert.subject() != cert.issuer() || cert.verify_signature(None).is_err() {
            return Err(CertificateError::ChainRejected);
        }
        return Ok(());
    }

    for pair in certificates.windows(2) {
        let subject = &pair[0];
        let issuer = &pair[1];
        if subject.issuer() != issuer.subject() {
            return Err(CertificateError::ChainRejected);
        }
        if !is_certificate_authority(issuer)? {
            return Err(CertificateError::ChainRejected);
        }
        if subject
            .verify_signature(Some(&issuer.tbs_certificate.subject_pki))
            .is_err()
        {
            return Err(CertificateError::ChainRejected);
        }
    }

    if trust_anchor.subject() != trust_anchor.issuer()
        || trust_anchor.verify_signature(None).is_err()
    {
        return Err(CertificateError::ChainRejected);
    }
    if !is_certificate_authority(trust_anchor)? {
        return Err(CertificateError::ChainRejected);
    }
    Ok(())
}

fn is_certificate_authority(cert: &X509Certificate<'_>) -> Result<bool, CertificateError> {
    let basic_constraints = cert
        .basic_constraints()
        .map_err(|_| CertificateError::ChainRejected)?
        .ok_or(CertificateError::ChainRejected)?;
    if !basic_constraints.value.ca {
        return Ok(false);
    }
    if let Some(key_usage) = cert
        .key_usage()
        .map_err(|_| CertificateError::ChainRejected)?
    {
        return Ok(key_usage.value.key_cert_sign());
    }
    Ok(true)
}

fn public_key_algorithm(
    cert: &X509Certificate<'_>,
) -> Result<CompanionProofSignatureAlgorithm, CertificateError> {
    let oid = cert.public_key().algorithm.algorithm.to_id_string();
    match oid.as_str() {
        // id-ecPublicKey. Ticket 29 accepts only ECDSA P-256/SHA-256. The
        // verifier rejects non-P-256 keys when importing the SPKI.
        "1.2.840.10045.2.1" => Ok(CompanionProofSignatureAlgorithm::EcdsaP256Sha256),
        // rsaEncryption. The proof scheme is RSA-PSS/SHA-256 even when the
        // certificate SPKI uses the generic RSA OID.
        "1.2.840.113549.1.1.1" => Ok(CompanionProofSignatureAlgorithm::RsaPssSha256),
        _ => Err(CertificateError::UnsupportedKeyAlgorithm),
    }
}

fn has_client_auth_eku(cert: &X509Certificate<'_>) -> bool {
    for ext in cert.extensions() {
        if let ParsedExtension::ExtendedKeyUsage(eku) = ext.parsed_extension() {
            if eku.client_auth {
                return true;
            }
        }
    }
    false
}

fn has_required_san(cert: &X509Certificate<'_>, required: &str) -> bool {
    for ext in cert.extensions() {
        if let ParsedExtension::SubjectAlternativeName(san) = ext.parsed_extension() {
            for name in &san.general_names {
                match name {
                    GeneralName::DNSName(value)
                    | GeneralName::URI(value)
                    | GeneralName::RFC822Name(value) => {
                        if value.eq_ignore_ascii_case(required) {
                            return true;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    false
}

#[allow(dead_code)]
fn _sha1_hex_for_legacy_diagnostics(bytes: &[u8]) -> String {
    hex::encode(Sha1::digest(bytes))
}
