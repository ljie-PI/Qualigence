//! Peer-identity verification over a real Unix-domain-socket transport
//! (`SO_PEERCRED`). This is the portable, test-exercised stand-in for the Windows
//! Named Pipe logon-SID check: only a peer running as the same local user is
//! accepted.

use std::os::unix::net::UnixStream;

use companion::ipc::security::{IdentityError, PeerAuthorizer, PeerCredentialSource};

#[test]
fn a_same_user_peer_is_accepted() {
    let (a, _b) = UnixStream::pair().expect("socketpair");
    let authorizer = PeerAuthorizer::current_user();

    let peer = a.peer_identity().expect("peer credentials");
    // The socketpair peer runs as this same process/user.
    assert_eq!(peer.uid, authorizer.expected_uid());
    assert_eq!(authorizer.authorize(peer), Ok(()));
}

#[test]
fn authorize_source_reads_and_verifies_in_one_step() {
    let (a, _b) = UnixStream::pair().expect("socketpair");
    let authorizer = PeerAuthorizer::current_user();
    assert!(authorizer.authorize_source(&a).is_ok());
}

#[test]
fn a_different_user_peer_is_rejected() {
    let (a, _b) = UnixStream::pair().expect("socketpair");
    let peer = a.peer_identity().expect("peer credentials");

    // Emulate the connecting process belonging to a *different* logon user: the
    // authorizer expects a uid that is not the peer's, and must reject it.
    let other_uid = peer.uid.wrapping_add(1);
    let authorizer = PeerAuthorizer::with_expected_uid(other_uid);

    assert_eq!(
        authorizer.authorize(peer),
        Err(IdentityError::CompanionIdentityRejected)
    );
    assert_eq!(
        authorizer.authorize_source(&a),
        Err(IdentityError::CompanionIdentityRejected)
    );
}
