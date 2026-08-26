//! Peer-identity verification. Unix keeps the portable SO_PEERCRED coverage; the
//! Windows branch exercises the real Named Pipe logon-SID/PID/token/session path.

#[cfg(unix)]
mod unix_acl {
    use std::os::unix::net::UnixStream;

    use companion::ipc::security::{IdentityError, PeerAuthorizer, PeerCredentialSource};

    #[test]
    fn a_same_user_peer_is_accepted() {
        let (a, _b) = UnixStream::pair().expect("socketpair");
        let authorizer = PeerAuthorizer::current_user();

        let peer = a.peer_identity().expect("peer credentials");
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
}

#[cfg(windows)]
mod windows_acl {
    use companion::ipc::windows_pipe::{
        current_logon_sid_string, current_session_id, current_user_sid_string,
        pipe_path_for_logon_sid, WindowsPeerAuthorizer, WindowsPeerIdentity, WindowsPeerPolicy,
    };

    #[test]
    fn pipe_name_includes_the_current_logon_sid() {
        let logon_sid = current_logon_sid_string().expect("current logon SID");
        let path =
            pipe_path_for_logon_sid("qualigence-companion-test", &logon_sid).expect("pipe path");
        assert!(path.starts_with(r"\\.\pipe\qualigence-companion-test-S-"));
        assert!(path.ends_with(&logon_sid));
    }

    #[test]
    fn current_process_identity_contains_user_logon_session_and_canonical_image() {
        let identity =
            WindowsPeerIdentity::for_current_process().expect("current process identity");
        assert_eq!(
            identity.logon_sid,
            current_logon_sid_string().expect("logon sid")
        );
        assert_eq!(
            identity.token_user_sid,
            current_user_sid_string().expect("user sid")
        );
        assert_eq!(
            identity.session_id,
            current_session_id().expect("session id")
        );
        assert!(identity.image_path.to_ascii_lowercase().ends_with(".exe"));
    }

    #[test]
    fn windows_peer_authorizer_rejects_wrong_sid_session_and_image() {
        let identity = WindowsPeerIdentity::for_current_process().expect("identity");
        let policy = WindowsPeerPolicy::for_current_process_test_only().expect("policy");
        let authorizer = WindowsPeerAuthorizer::new(policy.clone());
        assert_eq!(authorizer.authorize(&identity), Ok(()));

        let mut wrong = identity.clone();
        wrong.logon_sid.push_str("-1");
        assert!(authorizer.authorize(&wrong).is_err());

        let mut wrong = identity.clone();
        wrong.token_user_sid.push_str("-1");
        assert!(authorizer.authorize(&wrong).is_err());

        let mut wrong = identity.clone();
        wrong.session_id = wrong.session_id.saturating_add(1);
        assert!(authorizer.authorize(&wrong).is_err());

        let mut wrong = identity.clone();
        wrong.image_path = r"C:\Windows\System32\not-the-runner.exe".to_string();
        assert!(authorizer.authorize(&wrong).is_err());
    }
}
