//! Windows 11 native Named Pipe authority checks. These tests use real Win32
//! Named Pipe handles and process/token inspection; on non-Windows hosts they
//! fail with the stable blocker `Windows11Unavailable` instead of silently
//! claiming native coverage.

#[cfg(not(windows))]
#[test]
fn windows_11_native_named_pipe_tests_require_windows() {
    panic!("Windows11Unavailable: native Named Pipe authority tests require Windows 11");
}

#[cfg(windows)]
mod windows_native {
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::thread;
    use std::time::Duration;

    use companion::ipc::security::{
        AuthenticatedCertificateRunner, CompanionProofSignatureAlgorithm,
    };
    use companion::ipc::server::{parse_request, AuthenticatedSessionGate, FrameError};
    use companion::ipc::windows_pipe::{
        assert_windows_11_or_newer, authenticode_signer_thumbprints_sha1, connect_client_for_test,
        current_logon_sid_string, normalize_path_for_comparison, pipe_dacl_sddl_for_logon_sid,
        pipe_path_for_logon_sid, BinarySignaturePolicy, NamedPipeListener, NativePipeConfig,
        NativePipeError, WindowsPeerAuthorizer, WindowsPeerIdentity, WindowsPeerPolicy,
    };

    fn signed_system_binary() -> PathBuf {
        PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string()))
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe")
    }

    fn unique_prefix() -> String {
        format!(
            "qualigence-companion-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        )
    }

    #[test]
    fn host_is_windows_11_for_native_authority() {
        assert_eq!(assert_windows_11_or_newer(), Ok(()), "Windows11Unavailable");
    }

    #[test]
    fn listener_uses_current_logon_sid_first_instance_remote_rejection_and_dacl() {
        assert_windows_11_or_newer().expect("Windows11Unavailable");
        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            connect_timeout_ms: 2_000,
            ..NativePipeConfig::default()
        };
        let listener = NamedPipeListener::bind_for_current_logon(&config).expect("bind listener");
        let logon_sid = current_logon_sid_string().expect("logon sid");
        assert_eq!(listener.logon_sid(), logon_sid);
        assert!(listener.path().contains(&logon_sid));
        assert!(listener.path().starts_with(r"\\.\pipe\"));
        assert_eq!(
            pipe_dacl_sddl_for_logon_sid(&logon_sid),
            format!("D:P(A;;GA;;;SY)(A;;GA;;;{logon_sid})")
        );

        let duplicate = NamedPipeListener::bind_path_for_tests(
            listener.path(),
            listener.logon_sid(),
            config.max_frame_bytes,
        );
        assert_eq!(
            duplicate.err(),
            Some(NativePipeError::FirstInstanceAlreadyExists)
        );
    }

    #[test]
    fn connected_client_admission_reads_pid_token_logon_session_and_image() {
        assert_windows_11_or_newer().expect("Windows11Unavailable");
        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            connect_timeout_ms: 2_000,
            ..NativePipeConfig::default()
        };
        let listener = NamedPipeListener::bind_for_current_logon(&config).expect("bind");
        let path = listener.path().to_string();
        let client = thread::spawn(move || {
            // Give ConnectNamedPipe a chance to enter the overlapped wait.
            thread::sleep(Duration::from_millis(25));
            let _client = connect_client_for_test(&path).expect("client connect");
            thread::sleep(Duration::from_millis(25));
        });

        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let identity = listener.client_identity().expect("client identity");
        assert_eq!(identity.pid, std::process::id());
        let policy = WindowsPeerPolicy::for_current_process_test_only().expect("policy");
        let authorizer = WindowsPeerAuthorizer::new(policy);
        assert_eq!(authorizer.authorize(&identity), Ok(()));

        client.join().expect("join client");
    }

    #[test]
    fn request_before_auth_and_malformed_frames_have_stable_fail_closed_errors() {
        let request = parse_request(
            br#"{"protocolMajor":1,"requestId":"req-1","type":"session.pause","payload":{"runId":"run-1"}}"#,
        )
        .expect("request");
        let mut gate = AuthenticatedSessionGate::new();
        assert!(gate.require_authenticated(&request).is_err());

        assert_eq!(
            parse_request(
                br#"{"protocolMajor":1,"requestId":"req-2","type":"unknown","payload":{}}"#
            ),
            Err(FrameError::Malformed)
        );
        gate.accept(AuthenticatedCertificateRunner {
            runner_id: "runner-1".to_string(),
            certificate_sha256_fingerprint: "a".repeat(64),
            signature_algorithm: CompanionProofSignatureAlgorithm::EcdsaP256Sha256,
        });
        assert_eq!(gate.require_authenticated(&request), Ok(()));
        gate.clear();
        assert!(gate.require_authenticated(&request).is_err());
    }

    #[test]
    fn production_authenticode_signer_allowlist_accepts_and_rejects_signed_images() {
        assert_windows_11_or_newer().expect("Windows11Unavailable");
        let signed_image = signed_system_binary();
        let signed_image = signed_image.to_string_lossy().to_string();
        let thumbprints = authenticode_signer_thumbprints_sha1(&signed_image)
            .expect("Windows system binary must have an Authenticode signer");
        let allowed = thumbprints.iter().next().expect("signer").clone();

        let current = WindowsPeerIdentity::for_current_process().expect("identity");
        let identity = WindowsPeerIdentity {
            image_path: signed_image.clone(),
            ..current.clone()
        };
        let mut allowed_paths = HashSet::new();
        allowed_paths.insert(normalize_path_for_comparison(&signed_image));
        let policy = WindowsPeerPolicy {
            expected_logon_sid: current.logon_sid,
            expected_token_user_sid: current.token_user_sid,
            expected_session_id: current.session_id,
            allowed_image_paths: allowed_paths.clone(),
            signature_policy: BinarySignaturePolicy::RequireAuthenticodeSigner {
                allowed_sha1_thumbprints: [allowed].into_iter().collect(),
            },
        };
        assert_eq!(
            WindowsPeerAuthorizer::new(policy).authorize(&identity),
            Ok(())
        );

        let policy = WindowsPeerPolicy {
            expected_logon_sid: identity.logon_sid.clone(),
            expected_token_user_sid: identity.token_user_sid.clone(),
            expected_session_id: identity.session_id,
            allowed_image_paths: allowed_paths,
            signature_policy: BinarySignaturePolicy::RequireAuthenticodeSigner {
                allowed_sha1_thumbprints: ["00".repeat(20)].into_iter().collect(),
            },
        };
        assert_eq!(
            WindowsPeerAuthorizer::new(policy).authorize(&identity),
            Err(NativePipeError::CompanionIdentityRejected)
        );
    }

    #[test]
    fn pipe_path_rejects_non_local_or_malformed_name_components() {
        let sid = current_logon_sid_string().expect("logon sid");
        assert!(pipe_path_for_logon_sid("qualigence", &sid).is_ok());
        assert_eq!(
            pipe_path_for_logon_sid(r"qualigence\evil", &sid),
            Err(NativePipeError::InvalidPipeName)
        );
        assert_eq!(
            pipe_path_for_logon_sid("qualigence", r"S-1-5-5\evil"),
            Err(NativePipeError::InvalidPipeName)
        );
    }
}
