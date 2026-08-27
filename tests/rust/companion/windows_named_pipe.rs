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
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;
    use companion::clock::ManualClock;
    use companion::ipc::dto::CompanionRequestPayload;
    use companion::ipc::security::{
        proof_bytes, AuthenticatedCertificateRunner, CertificateHandshakeError,
        CertificateHandshakeVerifier, CompanionProofSignatureAlgorithm, RunnerCertificatePolicy,
    };
    use companion::ipc::server::{
        parse_request, write_frame, AuthenticatedSessionGate, FrameError, FrameLimits,
        RequestProcessError,
    };
    use companion::ipc::windows_pipe::{
        assert_windows_11_or_newer, authenticode_signer_thumbprints_sha1, connect_client_for_test,
        current_logon_sid_string, normalize_path_for_comparison, pipe_dacl_sddl_for_logon_sid,
        pipe_path_for_logon_sid, BinarySignaturePolicy, NamedPipeListener, NativePipeConfig,
        NativePipeError, NativePipeRequestError, NativePipeRequestEvent,
        NativePipeRequestProcessor, WindowsPeerAuthorizer, WindowsPeerIdentity, WindowsPeerPolicy,
    };
    use p256::ecdsa::signature::Signer as EcdsaSigner;
    use p256::ecdsa::SigningKey as EcdsaSigningKey;
    use p256::pkcs8::DecodePrivateKey as DecodeP256PrivateKey;
    use sha2::{Digest, Sha256};

    fn signed_system_binary() -> PathBuf {
        PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string()))
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe")
    }

    const PROTOCOL_MAJOR: u8 = 1;
    const INSTANCE: &str = "native-companion-instance-1";
    const RUNNER_ID: &str = "runner-1";
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

    fn pem_der(cert: &str) -> Vec<u8> {
        let body: String = cert
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        BASE64.decode(body).expect("fixture pem")
    }

    fn fingerprint(cert: &str) -> String {
        hex::encode(Sha256::digest(pem_der(cert)))
    }

    fn certificate_chain() -> String {
        format!("{ECDSA_CERT}\n{CA_CERT}")
    }

    fn certificate_policy() -> RunnerCertificatePolicy {
        RunnerCertificatePolicy {
            runner_id: RUNNER_ID.to_string(),
            expected_fingerprint_sha256: fingerprint(ECDSA_CERT),
            required_san: RUNNER_ID.to_string(),
            required_scope_sans: vec![
                format!("urn:qualigence:runner:{RUNNER_ID}"),
                "urn:qualigence:tenant:tenant-1".to_string(),
                "urn:qualigence:project:project-1".to_string(),
            ],
            trusted_issuer_fingerprint_sha256: Some(fingerprint(CA_CERT)),
        }
    }

    fn certificate_verifier(clock: Arc<ManualClock>) -> CertificateHandshakeVerifier<ManualClock> {
        CertificateHandshakeVerifier::new(
            PROTOCOL_MAJOR,
            INSTANCE,
            [certificate_policy()],
            clock,
            DEADLINE_MS,
        )
    }

    fn processor(limits: FrameLimits) -> NativePipeRequestProcessor<ManualClock> {
        NativePipeRequestProcessor::new(
            limits,
            certificate_verifier(Arc::new(ManualClock::new(1_000))),
        )
    }

    fn sign_ecdsa(nonce_base64: &str, runner_id: &str) -> String {
        let key = EcdsaSigningKey::from_pkcs8_pem(ECDSA_KEY).expect("ecdsa key");
        let proof = proof_bytes(PROTOCOL_MAJOR, INSTANCE, nonce_base64, runner_id);
        let signature: p256::ecdsa::Signature = key.sign(&proof);
        BASE64.encode(signature.to_der())
    }

    fn begin_request(request_id: &str) -> serde_json::Value {
        serde_json::json!({
            "protocolMajor": PROTOCOL_MAJOR,
            "requestId": request_id,
            "type": "handshake.begin",
            "payload": {
                "runnerId": RUNNER_ID,
                "certificatePem": certificate_chain()
            }
        })
    }

    fn prove_request(
        request_id: &str,
        challenge_id: &str,
        nonce_base64: &str,
        signature_base64: &str,
    ) -> serde_json::Value {
        prove_request_with_algorithm(
            request_id,
            challenge_id,
            nonce_base64,
            signature_base64,
            "ecdsa-p256-sha256",
        )
    }

    fn prove_request_with_algorithm(
        request_id: &str,
        challenge_id: &str,
        nonce_base64: &str,
        signature_base64: &str,
        signature_algorithm: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "protocolMajor": PROTOCOL_MAJOR,
            "requestId": request_id,
            "type": "handshake.prove",
            "payload": {
                "challengeId": challenge_id,
                "companionInstanceId": INSTANCE,
                "nonceBase64": nonce_base64,
                "signatureBase64": signature_base64,
                "signatureAlgorithm": signature_algorithm
            }
        })
    }

    fn pause_request(request_id: &str) -> serde_json::Value {
        serde_json::json!({
            "protocolMajor": PROTOCOL_MAJOR,
            "requestId": request_id,
            "type": "session.pause",
            "payload": { "runId": "run-1" }
        })
    }

    fn write_json_frame<W: Write>(writer: &mut W, value: serde_json::Value, limits: &FrameLimits) {
        let body = serde_json::to_vec(&value).expect("json request");
        write_frame(writer, &body, limits).expect("write request frame");
    }

    fn connected_listener(config: &NativePipeConfig) -> (NamedPipeListener, String) {
        let listener = NamedPipeListener::bind_for_current_logon(config).expect("bind");
        let path = listener.path().to_string();
        (listener, path)
    }

    fn pipe_name_for_dotnet_client(path: &str) -> String {
        path.strip_prefix(r"\\.\pipe\")
            .expect("local named pipe path")
            .to_string()
    }

    fn powershell_write_frame_script(pipe_name: &str, request: serde_json::Value) -> String {
        let json = serde_json::to_string(&request).expect("request json");
        let escaped_pipe = pipe_name.replace('\'', "''");
        let escaped_json = json.replace('\'', "''");
        format!(
            "$ErrorActionPreference = 'Stop'; \
             $pipeName = '{escaped_pipe}'; \
             $json = '{escaped_json}'; \
             $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut); \
             $client.Connect(2000); \
             $bytes = [System.Text.Encoding]::UTF8.GetBytes($json); \
             $length = [BitConverter]::GetBytes([UInt32]$bytes.Length); \
             if ([BitConverter]::IsLittleEndian) {{ [Array]::Reverse($length) }}; \
             $client.Write($length, 0, 4); \
             $client.Write($bytes, 0, $bytes.Length); \
             $client.Flush(); \
             Start-Sleep -Milliseconds 500; \
             $client.Dispose();"
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
    fn real_signed_process_pid_image_and_signature_are_authorized_over_native_pipe() {
        assert_windows_11_or_newer().expect("Windows11Unavailable");
        let signed_image = signed_system_binary();
        let signed_image = signed_image.to_string_lossy().to_string();
        let thumbprints = authenticode_signer_thumbprints_sha1(&signed_image)
            .expect("Windows system binary must have an Authenticode signer");

        let limits = FrameLimits {
            max_frame_bytes: 16 * 1024,
            max_queue_depth: 4,
            max_concurrent_requests: 2,
        };
        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: limits.max_frame_bytes,
            connect_timeout_ms: 2_000,
        };
        let (listener, path) = connected_listener(&config);
        let pipe_name = pipe_name_for_dotnet_client(&path);
        let request = begin_request("req-real-signed-process");
        let script = powershell_write_frame_script(&pipe_name, request);
        let mut child = Command::new(&signed_image)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .spawn()
            .expect("spawn signed PowerShell client");

        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let identity = listener.client_identity().expect("client identity");
        assert_ne!(identity.pid, std::process::id());
        assert_eq!(
            normalize_path_for_comparison(&identity.image_path),
            normalize_path_for_comparison(&signed_image)
        );

        let current = WindowsPeerIdentity::for_current_process().expect("current identity");
        let mut allowed_paths = HashSet::new();
        allowed_paths.insert(normalize_path_for_comparison(&signed_image));
        let allowed_policy = WindowsPeerPolicy {
            expected_logon_sid: current.logon_sid.clone(),
            expected_token_user_sid: current.token_user_sid.clone(),
            expected_session_id: current.session_id,
            allowed_image_paths: allowed_paths.clone(),
            signature_policy: BinarySignaturePolicy::RequireAuthenticodeSigner {
                allowed_sha1_thumbprints: thumbprints.clone(),
            },
        };
        WindowsPeerAuthorizer::new(allowed_policy)
            .authorize(&identity)
            .expect("real signed connecting process is allowed");

        let wrong_signer_policy = WindowsPeerPolicy {
            expected_logon_sid: current.logon_sid,
            expected_token_user_sid: current.token_user_sid,
            expected_session_id: current.session_id,
            allowed_image_paths: allowed_paths,
            signature_policy: BinarySignaturePolicy::RequireAuthenticodeSigner {
                allowed_sha1_thumbprints: ["00".repeat(20)].into_iter().collect(),
            },
        };
        assert_eq!(
            WindowsPeerAuthorizer::new(wrong_signer_policy).authorize(&identity),
            Err(NativePipeError::CompanionIdentityRejected)
        );

        let mut connection = listener.connection();
        let mut session = processor(limits);
        match session
            .process_next_request(&mut connection)
            .expect("real process challenge issued")
        {
            NativePipeRequestEvent::ChallengeIssued { request_id, .. } => {
                assert_eq!(request_id, "req-real-signed-process");
            }
            _ => panic!("expected challenge event from real signed process"),
        }

        let status = child.wait().expect("wait signed PowerShell client");
        assert!(
            status.success(),
            "signed PowerShell client failed: {status}"
        );
    }

    #[test]
    fn native_session_accepts_valid_certificate_proof_before_application_request() {
        assert_windows_11_or_newer().expect("Windows11Unavailable");
        let limits = FrameLimits {
            max_frame_bytes: 16 * 1024,
            max_queue_depth: 4,
            max_concurrent_requests: 2,
        };
        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: limits.max_frame_bytes,
            connect_timeout_ms: 2_000,
        };
        let (listener, path) = connected_listener(&config);
        let (challenge_tx, challenge_rx) = mpsc::channel::<(String, String)>();
        let client_limits = limits;
        let client = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            let mut client = connect_client_for_test(&path).expect("client connect");
            write_json_frame(&mut client, begin_request("req-begin"), &client_limits);
            let (challenge_id, nonce_base64) = challenge_rx.recv().expect("challenge");
            let signature = sign_ecdsa(&nonce_base64, RUNNER_ID);
            write_json_frame(
                &mut client,
                prove_request("req-prove", &challenge_id, &nonce_base64, &signature),
                &client_limits,
            );
            write_json_frame(&mut client, pause_request("req-app"), &client_limits);
            thread::sleep(Duration::from_millis(25));
        });

        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let policy = WindowsPeerPolicy::for_current_process_test_only().expect("policy");
        WindowsPeerAuthorizer::new(policy)
            .authorize(&listener.client_identity().expect("client identity"))
            .expect("OS peer identity");
        let mut connection = listener.connection();
        let mut session = processor(limits);

        match session
            .process_next_request(&mut connection)
            .expect("challenge issued")
        {
            NativePipeRequestEvent::ChallengeIssued {
                request_id,
                challenge_id,
                nonce_base64,
            } => {
                assert_eq!(request_id, "req-begin");
                challenge_tx
                    .send((challenge_id, nonce_base64))
                    .expect("send challenge");
            }
            _ => panic!("expected challenge event"),
        }
        match session
            .process_next_request(&mut connection)
            .expect("authenticated")
        {
            NativePipeRequestEvent::Authenticated {
                request_id,
                runner_id,
                ..
            } => {
                assert_eq!(request_id, "req-prove");
                assert_eq!(runner_id, RUNNER_ID);
            }
            _ => panic!("expected authenticated event"),
        }
        assert!(session.is_authenticated());
        match session
            .process_next_request(&mut connection)
            .expect("application request admitted")
        {
            NativePipeRequestEvent::ApplicationRequest(admitted) => {
                assert_eq!(admitted.request.request_id, "req-app");
                assert!(matches!(
                    admitted.request.payload,
                    CompanionRequestPayload::SessionPause(_)
                ));
            }
            _ => panic!("expected application request"),
        }

        client.join().expect("join client");
    }

    #[test]
    fn native_session_rejects_bad_proof_replay_and_app_request_before_auth() {
        assert_windows_11_or_newer().expect("Windows11Unavailable");
        let limits = FrameLimits {
            max_frame_bytes: 16 * 1024,
            max_queue_depth: 4,
            max_concurrent_requests: 2,
        };
        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: limits.max_frame_bytes,
            connect_timeout_ms: 2_000,
        };
        let (listener, path) = connected_listener(&config);
        let (challenge_tx, challenge_rx) = mpsc::channel::<(String, String)>();
        let client_limits = limits;
        let client = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            let mut client = connect_client_for_test(&path).expect("client connect");
            write_json_frame(&mut client, begin_request("req-begin"), &client_limits);
            let (challenge_id, nonce_base64) = challenge_rx.recv().expect("challenge");
            let bad_signature = BASE64.encode([0u8; 64]);
            write_json_frame(
                &mut client,
                prove_request(
                    "req-bad-proof",
                    &challenge_id,
                    &nonce_base64,
                    &bad_signature,
                ),
                &client_limits,
            );
            write_json_frame(
                &mut client,
                pause_request("req-app-before-auth"),
                &client_limits,
            );
            let correct_signature = sign_ecdsa(&nonce_base64, RUNNER_ID);
            write_json_frame(
                &mut client,
                prove_request(
                    "req-replay",
                    &challenge_id,
                    &nonce_base64,
                    &correct_signature,
                ),
                &client_limits,
            );
            thread::sleep(Duration::from_millis(25));
        });

        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let mut connection = listener.connection();
        let mut session = processor(limits);

        match session
            .process_next_request(&mut connection)
            .expect("challenge issued")
        {
            NativePipeRequestEvent::ChallengeIssued {
                challenge_id,
                nonce_base64,
                ..
            } => challenge_tx
                .send((challenge_id, nonce_base64))
                .expect("send challenge"),
            _ => panic!("expected challenge event"),
        }
        assert!(matches!(
            session.process_next_request(&mut connection),
            Err(NativePipeRequestError::Handshake(
                CertificateHandshakeError::Certificate(_)
            ))
        ));
        assert!(!session.is_authenticated());
        assert!(matches!(
            session.process_next_request(&mut connection),
            Err(NativePipeRequestError::Request(
                RequestProcessError::Session(_)
            ))
        ));
        assert!(matches!(
            session.process_next_request(&mut connection),
            Err(NativePipeRequestError::Handshake(
                CertificateHandshakeError::ReplayedChallenge
            ))
        ));

        client.join().expect("join client");
    }

    #[test]
    fn native_session_consumes_challenge_on_unsupported_proof_algorithm() {
        assert_windows_11_or_newer().expect("Windows11Unavailable");
        let limits = FrameLimits {
            max_frame_bytes: 16 * 1024,
            max_queue_depth: 4,
            max_concurrent_requests: 2,
        };
        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: limits.max_frame_bytes,
            connect_timeout_ms: 2_000,
        };
        let (listener, path) = connected_listener(&config);
        let (challenge_tx, challenge_rx) = mpsc::channel::<(String, String)>();
        let client_limits = limits;
        let client = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            let mut client = connect_client_for_test(&path).expect("client connect");
            write_json_frame(&mut client, begin_request("req-begin"), &client_limits);
            let (challenge_id, nonce_base64) = challenge_rx.recv().expect("challenge");
            let signature = sign_ecdsa(&nonce_base64, RUNNER_ID);
            write_json_frame(
                &mut client,
                prove_request_with_algorithm(
                    "req-unsupported-algorithm",
                    &challenge_id,
                    &nonce_base64,
                    &signature,
                    "ed25519-sha512",
                ),
                &client_limits,
            );
            write_json_frame(
                &mut client,
                prove_request("req-valid-replay", &challenge_id, &nonce_base64, &signature),
                &client_limits,
            );
            thread::sleep(Duration::from_millis(25));
        });

        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let mut connection = listener.connection();
        let mut session = processor(limits);

        match session
            .process_next_request(&mut connection)
            .expect("challenge issued")
        {
            NativePipeRequestEvent::ChallengeIssued {
                challenge_id,
                nonce_base64,
                ..
            } => challenge_tx
                .send((challenge_id, nonce_base64))
                .expect("send challenge"),
            _ => panic!("expected challenge event"),
        }
        assert!(matches!(
            session.process_next_request(&mut connection),
            Err(NativePipeRequestError::Handshake(
                CertificateHandshakeError::Certificate(_)
            ))
        ));
        assert!(!session.is_authenticated());
        assert!(matches!(
            session.process_next_request(&mut connection),
            Err(NativePipeRequestError::Handshake(
                CertificateHandshakeError::ReplayedChallenge
            ))
        ));

        client.join().expect("join client");
    }

    #[test]
    fn oversized_and_truncated_frames_fail_closed_over_native_pipe() {
        assert_windows_11_or_newer().expect("Windows11Unavailable");
        let limits = FrameLimits {
            max_frame_bytes: 32,
            max_queue_depth: 2,
            max_concurrent_requests: 1,
        };

        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: limits.max_frame_bytes,
            connect_timeout_ms: 2_000,
        };
        let (listener, path) = connected_listener(&config);
        let client = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            let mut client = connect_client_for_test(&path).expect("client connect");
            client
                .write_all(&(limits.max_frame_bytes + 1).to_be_bytes())
                .expect("oversize prefix");
            thread::sleep(Duration::from_millis(25));
        });
        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let mut connection = listener.connection();
        let mut session = processor(limits);
        assert!(matches!(
            session.process_next_request(&mut connection),
            Err(NativePipeRequestError::Request(RequestProcessError::Frame(
                FrameError::FrameTooLarge
            )))
        ));
        client.join().expect("join oversize client");

        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: 128,
            connect_timeout_ms: 2_000,
        };
        let trunc_limits = FrameLimits {
            max_frame_bytes: 128,
            max_queue_depth: 2,
            max_concurrent_requests: 1,
        };
        let (listener, path) = connected_listener(&config);
        let client = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            let mut client = connect_client_for_test(&path).expect("client connect");
            client.write_all(&64u32.to_be_bytes()).expect("length");
            client.write_all(b"{").expect("partial body");
        });
        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let mut connection = listener.connection();
        let mut session = processor(trunc_limits);
        assert!(matches!(
            session.process_next_request(&mut connection),
            Err(NativePipeRequestError::Request(RequestProcessError::Frame(
                FrameError::Truncated
            )))
        ));
        client.join().expect("join truncated client");
    }

    #[test]
    fn bounded_admission_rejects_flooded_native_pipe_requests() {
        assert_windows_11_or_newer().expect("Windows11Unavailable");
        let limits = FrameLimits {
            max_frame_bytes: 16 * 1024,
            max_queue_depth: 1,
            max_concurrent_requests: 1,
        };
        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: limits.max_frame_bytes,
            connect_timeout_ms: 2_000,
        };
        let (listener, path) = connected_listener(&config);
        let client_limits = limits;
        let client = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            let mut client = connect_client_for_test(&path).expect("client connect");
            write_json_frame(&mut client, begin_request("req-queued"), &client_limits);
            thread::sleep(Duration::from_millis(25));
        });
        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let mut connection = listener.connection();
        let mut session = processor(limits);
        let _queue_slot = session.admission().try_queue().expect("fill queue");
        assert!(matches!(
            session.process_next_request(&mut connection),
            Err(NativePipeRequestError::Request(RequestProcessError::Frame(
                FrameError::Overloaded
            )))
        ));
        client.join().expect("join queue client");

        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: limits.max_frame_bytes,
            connect_timeout_ms: 2_000,
        };
        let (listener, path) = connected_listener(&config);
        let client = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            let mut client = connect_client_for_test(&path).expect("client connect");
            write_json_frame(&mut client, begin_request("req-in-flight"), &client_limits);
            thread::sleep(Duration::from_millis(25));
        });
        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let mut connection = listener.connection();
        let mut session = processor(limits);
        let _in_flight = session.admission().try_admit().expect("fill in-flight");
        assert!(matches!(
            session.process_next_request(&mut connection),
            Err(NativePipeRequestError::Request(RequestProcessError::Frame(
                FrameError::Overloaded
            )))
        ));
        client.join().expect("join in-flight client");
    }

    #[test]
    fn disconnect_cleanup_and_restart_reject_old_native_session_state() {
        assert_windows_11_or_newer().expect("Windows11Unavailable");
        let limits = FrameLimits {
            max_frame_bytes: 16 * 1024,
            max_queue_depth: 4,
            max_concurrent_requests: 2,
        };
        let mut session = processor(limits);

        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: limits.max_frame_bytes,
            connect_timeout_ms: 2_000,
        };
        let (listener, path) = connected_listener(&config);
        let client_limits = limits;
        let first_client = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            let mut client = connect_client_for_test(&path).expect("client connect");
            write_json_frame(&mut client, begin_request("req-begin"), &client_limits);
        });
        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let mut connection = listener.connection();
        let (challenge_id, nonce_base64) = match session
            .process_next_request(&mut connection)
            .expect("challenge issued")
        {
            NativePipeRequestEvent::ChallengeIssued {
                challenge_id,
                nonce_base64,
                ..
            } => (challenge_id, nonce_base64),
            _ => panic!("expected challenge event"),
        };
        first_client.join().expect("join first client");
        session.disconnect_cleanup();
        assert!(!session.is_authenticated());

        let signature = sign_ecdsa(&nonce_base64, RUNNER_ID);
        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: limits.max_frame_bytes,
            connect_timeout_ms: 2_000,
        };
        let (listener, path) = connected_listener(&config);
        let replay_proof = prove_request("req-old-proof", &challenge_id, &nonce_base64, &signature);
        let client = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            let mut client = connect_client_for_test(&path).expect("client connect");
            write_json_frame(&mut client, replay_proof, &client_limits);
        });
        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let mut connection = listener.connection();
        assert!(matches!(
            session.process_next_request(&mut connection),
            Err(NativePipeRequestError::Handshake(
                CertificateHandshakeError::UnknownChallenge
            ))
        ));
        client.join().expect("join replay client");

        let mut restarted = processor(limits);
        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: limits.max_frame_bytes,
            connect_timeout_ms: 2_000,
        };
        let (listener, path) = connected_listener(&config);
        let replay_proof = prove_request(
            "req-restart-proof",
            &challenge_id,
            &nonce_base64,
            &signature,
        );
        let client = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            let mut client = connect_client_for_test(&path).expect("client connect");
            write_json_frame(&mut client, replay_proof, &client_limits);
        });
        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let mut connection = listener.connection();
        assert!(matches!(
            restarted.process_next_request(&mut connection),
            Err(NativePipeRequestError::Handshake(
                CertificateHandshakeError::UnknownChallenge
            ))
        ));
        client.join().expect("join restart client");
    }

    #[test]
    fn authenticated_disconnect_clears_native_session_before_later_requests() {
        assert_windows_11_or_newer().expect("Windows11Unavailable");
        let limits = FrameLimits {
            max_frame_bytes: 16 * 1024,
            max_queue_depth: 4,
            max_concurrent_requests: 2,
        };
        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: limits.max_frame_bytes,
            connect_timeout_ms: 2_000,
        };
        let (listener, path) = connected_listener(&config);
        let (challenge_tx, challenge_rx) = mpsc::channel::<(String, String)>();
        let client_limits = limits;
        let client = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            let mut client = connect_client_for_test(&path).expect("client connect");
            write_json_frame(&mut client, begin_request("req-begin"), &client_limits);
            let (challenge_id, nonce_base64) = challenge_rx.recv().expect("challenge");
            let signature = sign_ecdsa(&nonce_base64, RUNNER_ID);
            write_json_frame(
                &mut client,
                prove_request("req-prove", &challenge_id, &nonce_base64, &signature),
                &client_limits,
            );
        });
        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let mut connection = listener.connection();
        let mut session = processor(limits);
        match session
            .process_next_request(&mut connection)
            .expect("challenge issued")
        {
            NativePipeRequestEvent::ChallengeIssued {
                challenge_id,
                nonce_base64,
                ..
            } => challenge_tx
                .send((challenge_id, nonce_base64))
                .expect("send challenge"),
            _ => panic!("expected challenge event"),
        }
        session
            .process_next_request(&mut connection)
            .expect("authenticated");
        assert!(session.is_authenticated());
        client.join().expect("join authenticated client");
        session.disconnect_cleanup();
        assert!(!session.is_authenticated());

        let config = NativePipeConfig {
            name_prefix: unique_prefix(),
            max_frame_bytes: limits.max_frame_bytes,
            connect_timeout_ms: 2_000,
        };
        let (listener, path) = connected_listener(&config);
        let client = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            let mut client = connect_client_for_test(&path).expect("client connect");
            write_json_frame(
                &mut client,
                pause_request("req-after-disconnect"),
                &client_limits,
            );
        });
        listener
            .connect(config.connect_timeout_ms)
            .expect("server connect");
        let mut connection = listener.connection();
        assert!(matches!(
            session.process_next_request(&mut connection),
            Err(NativePipeRequestError::Request(
                RequestProcessError::Session(_)
            ))
        ));
        client.join().expect("join unauth client");
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
    fn only_transport_io_errors_are_deferred_while_actions_are_in_flight() {
        assert!(
            NativePipeRequestError::Request(RequestProcessError::Frame(FrameError::Io))
                .is_deferable_while_in_flight()
        );
        assert!(!NativePipeRequestError::Request(RequestProcessError::Frame(
            FrameError::Malformed
        ))
        .is_deferable_while_in_flight());
        assert!(!NativePipeRequestError::Request(RequestProcessError::Frame(
            FrameError::FrameTooLarge
        ))
        .is_deferable_while_in_flight());
        assert!(!NativePipeRequestError::Request(RequestProcessError::Frame(
            FrameError::Truncated
        ))
        .is_deferable_while_in_flight());
        assert!(!NativePipeRequestError::Request(RequestProcessError::Frame(
            FrameError::Overloaded
        ))
        .is_deferable_while_in_flight());
        assert!(
            !NativePipeRequestError::Request(RequestProcessError::Session(
                companion::ipc::server::SessionAdmissionError::CompanionUnauthenticated
            ))
            .is_deferable_while_in_flight()
        );
        assert!(
            !NativePipeRequestError::Handshake(CertificateHandshakeError::UnknownRunner)
                .is_deferable_while_in_flight()
        );
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
