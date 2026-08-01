//! Cryptographically secure random bytes for tokens and nonces.

use getrandom::getrandom;

/// Fill an `N`-byte array from the OS CSPRNG. Panics only if the OS entropy
/// source is unavailable, which is an unrecoverable security condition.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom(&mut buf).expect("OS CSPRNG must be available");
    buf
}
