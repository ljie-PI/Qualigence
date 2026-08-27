//! One-time, action-bound execution Permits.
//!
//! A Permit is minted for exactly one desktop action and binds the full identity
//! of that action: session, run, action id, canonical action digest, graph, risk
//! and a per-Permit nonce. The store keeps only the SHA-256 *hash* of the random
//! 256-bit token (never the token itself) plus the binding and expiry in memory.
//!
//! Consumption is atomic and single-use: a replay of the same token, a stale
//! (expired) token, or any binding-field substitution all fail closed, and a
//! successful consume marks the token spent so a second attempt is rejected.
//! Emergency Stop / pause are checked *before* the store is even consulted.

use std::collections::HashMap;
use std::sync::Arc;

use crate::clock::Clock;
use crate::emergency_stop::SessionControl;
use crate::random::random_bytes;
use crate::risk::Risk;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use sha2::{Digest, Sha256};

/// The immutable identity a Permit is bound to. Every field must match on
/// consume, so any substitution (a changed action, a different session, a
/// mismatched digest) is rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermitBinding {
    pub session_id: String,
    pub run_id: String,
    pub action_id: String,
    pub action_digest_sha256: String,
    pub graph_id: String,
    pub risk: Risk,
}

/// The Permit as handed back to the caller after a successful mint. Only the
/// caller ever sees the raw `token`; the store retains just its hash.
#[derive(Debug, Clone)]
pub struct IssuedPermit {
    pub token: String,
    pub nonce_base64: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub binding: PermitBinding,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PermitError {
    /// No live Permit matches the presented token.
    UnknownToken,
    /// The token was already consumed exactly once.
    AlreadyConsumed,
    /// The Permit's TTL has elapsed.
    Expired,
    /// The presented action/session binding does not match what was minted.
    BindingMismatch,
    /// The Session is under an Emergency Stop deny latch.
    EmergencyStopped,
    /// The Session is paused and accepts no new actions.
    Paused,
    /// ProductionForbidden risk is never authorized.
    ProductionForbidden,
}

struct StoredPermit {
    binding: PermitBinding,
    expires_at_ms: u64,
    consumed: bool,
}

pub struct PermitStore<C: Clock> {
    clock: Arc<C>,
    entries: HashMap<String, StoredPermit>,
    default_ttl_ms: u64,
}

impl<C: Clock> PermitStore<C> {
    pub fn new(clock: Arc<C>, default_ttl_ms: u64) -> Self {
        Self {
            clock,
            entries: HashMap::new(),
            default_ttl_ms,
        }
    }

    /// Mint a single-use Permit for `binding`, expiring `default_ttl_ms` from now.
    pub fn issue(&mut self, binding: PermitBinding) -> IssuedPermit {
        self.issue_with_ttl(binding, self.default_ttl_ms)
    }

    pub fn issue_with_ttl(&mut self, binding: PermitBinding, ttl_ms: u64) -> IssuedPermit {
        let token = BASE64.encode(random_bytes::<32>());
        let nonce_base64 = BASE64.encode(random_bytes::<32>());
        let issued_at_ms = self.clock.now_ms();
        let expires_at_ms = issued_at_ms.saturating_add(ttl_ms);
        self.entries.insert(
            token_hash(&token),
            StoredPermit {
                binding: binding.clone(),
                expires_at_ms,
                consumed: false,
            },
        );
        IssuedPermit {
            token,
            nonce_base64,
            issued_at_ms,
            expires_at_ms,
            binding,
        }
    }

    /// Number of live (unconsumed, matching) entries, for diagnostics/tests.
    pub fn live_count(&self) -> usize {
        self.entries.values().filter(|e| !e.consumed).count()
    }

    /// Consume a Permit, verifying the full binding under the current control
    /// state. On success the token is atomically marked spent.
    pub fn consume(
        &mut self,
        control: &SessionControl,
        token: &str,
        presented: &PermitBinding,
    ) -> Result<(), PermitError> {
        // Absolute latches are enforced before the store is consulted, so an
        // emergency stop or pause rejects even a perfectly valid fresh Permit.
        if control.is_emergency_stopped() {
            return Err(PermitError::EmergencyStopped);
        }
        if control.is_paused() {
            return Err(PermitError::Paused);
        }
        if presented.risk == Risk::ProductionForbidden {
            return Err(PermitError::ProductionForbidden);
        }

        let hash = token_hash(token);
        let now = self.clock.now_ms();
        let entry = match self.entries.get_mut(&hash) {
            Some(entry) => entry,
            None => return Err(PermitError::UnknownToken),
        };
        if entry.consumed {
            return Err(PermitError::AlreadyConsumed);
        }
        if now >= entry.expires_at_ms {
            return Err(PermitError::Expired);
        }
        if !constant_time_binding_eq(&entry.binding, presented) {
            // A binding mismatch does not burn the token: only a fully valid
            // match consumes it exactly once.
            return Err(PermitError::BindingMismatch);
        }
        entry.consumed = true;
        Ok(())
    }

    /// Invalidate every pending Permit (used when Emergency Stop fires or a
    /// Session ends) so no stale token survives into a later Session.
    pub fn invalidate_all(&mut self) {
        self.entries.clear();
    }

    /// Test-only diagnostic helper: force all pending Permits to be expired
    /// without changing their tokens or bindings. Production code never calls
    /// this; the daemon exposes it only behind the Ticket 47 diagnostics gate.
    pub fn expire_all_for_diagnostic(&mut self) {
        for entry in self.entries.values_mut() {
            entry.expires_at_ms = 0;
        }
    }
}

fn token_hash(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

/// Compare every bound field. String fields use a constant-time comparison so a
/// caller cannot learn where a forged binding diverges by timing.
fn constant_time_binding_eq(a: &PermitBinding, b: &PermitBinding) -> bool {
    a.risk == b.risk
        && ct_eq(&a.session_id, &b.session_id)
        && ct_eq(&a.run_id, &b.run_id)
        && ct_eq(&a.action_id, &b.action_id)
        && ct_eq(&a.action_digest_sha256, &b.action_digest_sha256)
        && ct_eq(&a.graph_id, &b.graph_id)
}

fn ct_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
