//! IPC peer-identity verification and the certificate-style challenge-response
//! handshake.
//!
//! # Transport abstraction (Windows Named Pipe vs. Linux Unix socket)
//!
//! The frozen design targets a Windows Named Pipe whose DACL is scoped to the
//! current logon SID, whose client PID is verified with
//! `GetNamedPipeClientProcessId`, and whose token user SID / interactive session
//! are checked. That is genuinely OS-enforced peer identity — but it is not
//! testable on this Linux sandbox.
//!
//! To keep the security model *genuinely enforced and testable* without stubbing
//! it out, peer identity is abstracted behind [`PeerCredentialSource`]. The
//! portable, test-exercised implementation reads Unix-domain-socket peer
//! credentials (`SO_PEERCRED` on Linux, `getpeereid` elsewhere) and enforces that
//! the connecting process runs as the *same* uid as the Companion — the direct
//! analogue of the Windows "same logon SID" DACL check. The Windows Named Pipe
//! implementation is reserved for the real target (PR-26); the enforcement logic
//! ([`PeerAuthorizer`]) is transport-independent and shared by both.

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

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
/// This is the transport-independent equivalent of the Windows logon-SID DACL
/// check: on the real target the DACL already excludes other users, and this is
/// the belt-and-suspenders re-verification after accept.
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

/// Reserved Windows Named Pipe peer-identity implementation. On the real target
/// (PR-26) this uses `GetNamedPipeClientProcessId` plus token SID / interactive
/// session checks. It is intentionally not implemented in this sandbox build.
#[cfg(windows)]
pub struct NamedPipePeer;

#[cfg(windows)]
impl PeerCredentialSource for NamedPipePeer {
    fn peer_identity(&self) -> io::Result<PeerIdentity> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Windows Named Pipe peer identity is wired in PR-26",
        ))
    }
}

// --- Certificate-style challenge-response handshake ---------------------------

const HANDSHAKE_DOMAIN: &[u8] = b"qualigence-companion-handshake/v1\0";

/// A Runner registration: the runnerId bound to the public key whose SHA-256
/// fingerprint the Companion trusts. In production this is derived from the
/// LS-05/LS-11 client certificate; here it is the equivalent Ed25519 identity.
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

/// Verifies Runner identity via a nonce the Runner must sign with its registered
/// private key. A single reported fingerprint is never accepted as possession
/// proof: the signature over `{protocolMajor, companionInstanceId, nonce,
/// runnerId}` is verified against the registered key.
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

    /// The exact bytes a Runner must sign. Length-prefixed so no field boundary
    /// is ambiguous.
    pub fn message_to_sign(
        protocol_major: u8,
        companion_instance_id: &str,
        nonce: &[u8],
        runner_id: &str,
    ) -> Vec<u8> {
        let mut msg = Vec::with_capacity(HANDSHAKE_DOMAIN.len() + 64 + nonce.len());
        msg.extend_from_slice(HANDSHAKE_DOMAIN);
        msg.push(protocol_major);
        push_field(&mut msg, companion_instance_id.as_bytes());
        push_field(&mut msg, nonce);
        push_field(&mut msg, runner_id.as_bytes());
        msg
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
        let signature = Signature::from_slice(&signature_bytes)
            .map_err(|_| HandshakeError::MalformedSignature)?;

        let signature_ok = key.verify(&message, &signature).is_ok();

        // Consume the challenge exactly once regardless of the outcome, so a
        // failed or expired attempt cannot be retried against the same nonce.
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

fn push_field(buffer: &mut Vec<u8>, field: &[u8]) {
    buffer.extend_from_slice(&(field.len() as u32).to_be_bytes());
    buffer.extend_from_slice(field);
}

/// The Runner side of the handshake. In production the Runner is the TypeScript
/// process signing with its client-certificate key; this Ed25519 signer is the
/// portable equivalent used to prove and to test the Companion's verification.
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
