//! Companion binary entry point.
//!
//! The default mode is the native Companion daemon entry point; the hidden
//! `--uia-worker` role is spawned only by the daemon and owns all UI Automation
//! COM handles in an MTA child process. The main process owns authenticated IPC,
//! approval/session state, the application Job Object, the Emergency Stop latch,
//! and worker supervision.

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--uia-worker") => run_uia_worker(),
        _ => run_daemon(),
    }
}

#[cfg(windows)]
fn run_uia_worker() {
    let mut capture = match companion::uia::worker::WindowsUiaCapture::initialize() {
        Ok(capture) => capture,
        Err(error) => {
            eprintln!(
                "companion uia worker failed to initialize: {}",
                error.code()
            );
            std::process::exit(2);
        }
    };
    if let Err(error) = companion::uia::worker::run_worker_stdio(&mut capture) {
        eprintln!("companion uia worker stopped: {}", error.code());
        std::process::exit(3);
    }
}

#[cfg(not(windows))]
fn run_uia_worker() {
    let mut capture = companion::uia::worker::SyntheticUiaCapture::new(
        std::process::id() as i32,
        "non-windows-worker",
    );
    if let Err(error) = companion::uia::worker::run_worker_stdio(&mut capture) {
        eprintln!("companion synthetic uia worker stopped: {}", error.code());
        std::process::exit(3);
    }
}

#[cfg(windows)]
fn run_daemon() {
    use std::collections::{HashMap, HashSet};
    use std::io::Write;
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use companion::approval::{ApprovalOutcome, ApprovalRequest, ApprovalState, ScriptedApprover};
    use companion::clock::SystemClock;
    use companion::ipc::dto::{
        AppTarget, CompanionRequest, CompanionRequestPayload, DesktopPlatform,
    };
    use companion::ipc::security::{CertificateHandshakeVerifier, RunnerCertificatePolicy};
    use companion::ipc::server::{write_frame, FrameLimits};
    use companion::ipc::windows_pipe::{
        normalize_path_for_comparison, BinarySignaturePolicy, NamedPipeListener, NativePipeConfig,
        NativePipeError, NativePipeRequestEvent, NativePipeRequestProcessor, WindowsPeerAuthorizer,
        WindowsPeerIdentity, WindowsPeerPolicy,
    };
    use companion::permit::{IssuedPermit, PermitBinding, PermitStore};
    use companion::process::app_session::{AppSessionManager, AppSessionState};
    use companion::process::job_object::{
        AppLaunchSpec, LifecycleError, ResetSpec, WindowsDesktopProcessHost,
    };
    use companion::risk::Risk;
    use companion::uia::action::{
        classify_desktop_action, desktop_action_digest_sha256, execute_desktop_action_request,
        DesktopActionError,
    };
    use companion::uia::protocol::{ActionOutcomeReport, UiaError, UiaSessionTarget};
    use companion::uia::worker_supervisor::{NativeUiaWorkerSpawner, UiaWorkerSupervisor};
    use companion::{Companion, PermitRequestOutcome};

    type DaemonCompanion = Companion<SystemClock, ScriptedApprover>;

    struct DaemonState {
        clock: Arc<SystemClock>,
        sessions: AppSessionManager<WindowsDesktopProcessHost>,
        companions: HashMap<String, DaemonCompanion>,
        reset_specs: HashMap<String, ResetSpec>,
        supervisor: UiaWorkerSupervisor<NativeUiaWorkerSpawner>,
    }

    impl DaemonState {
        fn new(clock: Arc<SystemClock>) -> Self {
            Self {
                clock,
                sessions: AppSessionManager::new(WindowsDesktopProcessHost::new()),
                companions: HashMap::new(),
                reset_specs: HashMap::new(),
                supervisor: UiaWorkerSupervisor::new(NativeUiaWorkerSpawner::new()),
            }
        }

        fn companion_for(&mut self, session_id: &str, run_id: &str) -> &mut DaemonCompanion {
            let clock = Arc::clone(&self.clock);
            self.companions
                .entry(session_id.to_string())
                .or_insert_with(|| {
                    let approver = if std::env::var("QUALIGENCE_COMPANION_TEST_APPROVE_ALL")
                        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
                        .unwrap_or(false)
                    {
                        ScriptedApprover::always(ApprovalOutcome::Approved)
                    } else {
                        ScriptedApprover::always(ApprovalOutcome::TimedOut)
                    };
                    let approval = ApprovalState::new(run_id.to_string(), approver);
                    let permits = PermitStore::new(clock, 30_000);
                    Companion::new(session_id.to_string(), approval, permits)
                })
        }

        fn target_for(&self, session_id: &str) -> Result<UiaSessionTarget, LifecycleError> {
            let state = self.sessions.verified_session(session_id)?;
            Ok(UiaSessionTarget {
                session_id: state.session_id.clone(),
                process_id: state.pid as i32,
                root_window_handle: state.root_window_handle.clone(),
            })
        }
    }

    let clock = Arc::new(SystemClock::new());
    let mut state = DaemonState::new(Arc::clone(&clock));
    let pipe_config = NativePipeConfig {
        name_prefix: std::env::var("QUALIGENCE_COMPANION_PIPE_PREFIX")
            .unwrap_or_else(|_| NativePipeConfig::default().name_prefix),
        ..NativePipeConfig::default()
    };
    let frame_limits = FrameLimits::default();
    let companion_instance_id = format!(
        "companion-{}",
        hex::encode(companion::random::random_bytes::<16>())
    );
    let certificate_policies = load_certificate_policies();
    let mut announced = false;

    loop {
        let listener = match NamedPipeListener::bind_for_current_logon(&pipe_config) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("companion daemon unavailable: {}", error.stable_code());
                std::process::exit(1);
            }
        };
        if !announced {
            println!(
                "Qualigence Desktop Companion daemon listening on {} (uiAccess=false)",
                listener.path()
            );
            announced = true;
        }
        if let Err(error) = listener.connect(pipe_config.connect_timeout_ms) {
            eprintln!("companion daemon accept failed: {}", error.stable_code());
            continue;
        }
        if let Err(error) = authorize_peer(&listener) {
            eprintln!("companion daemon rejected peer: {}", error.stable_code());
            continue;
        }

        let mut connection = listener.connection();
        let verifier = CertificateHandshakeVerifier::new(
            companion::ipc::dto::PROTOCOL_MAJOR,
            companion_instance_id.clone(),
            certificate_policies.clone(),
            Arc::clone(&clock),
            5_000,
        );
        let mut processor = NativePipeRequestProcessor::new(frame_limits, verifier);
        loop {
            let event = match processor.process_next_request(&mut connection) {
                Ok(event) => event,
                Err(error) => {
                    let _ = write_error(
                        &mut connection,
                        "unknown",
                        "companion.probe",
                        error.stable_code(),
                        error.stable_code(),
                        &frame_limits,
                    );
                    processor.disconnect_cleanup();
                    break;
                }
            };
            let write_result = match event {
                NativePipeRequestEvent::ChallengeIssued {
                    request_id,
                    challenge_id,
                    nonce_base64,
                } => write_ok(
                    &mut connection,
                    &request_id,
                    "handshake.challenge",
                    serde_json::json!({
                        "challengeId": challenge_id,
                        "companionInstanceId": companion_instance_id.clone(),
                        "nonceBase64": nonce_base64,
                    }),
                    &frame_limits,
                ),
                NativePipeRequestEvent::Authenticated {
                    request_id,
                    runner_id,
                    certificate_sha256_fingerprint,
                } => write_ok(
                    &mut connection,
                    &request_id,
                    "handshake.accepted",
                    serde_json::json!({
                        "companionInstanceId": companion_instance_id.clone(),
                        "runnerId": runner_id,
                        "certificateSha256Fingerprint": certificate_sha256_fingerprint,
                        "acceptedAt": now_string(),
                    }),
                    &frame_limits,
                ),
                NativePipeRequestEvent::ApplicationRequest(admitted) => {
                    dispatch_application_request(
                        &mut state,
                        admitted.request,
                        &mut connection,
                        &frame_limits,
                    )
                }
            };
            if write_result.is_err() {
                processor.disconnect_cleanup();
                break;
            }
        }
    }

    fn dispatch_application_request<W: Write>(
        state: &mut DaemonState,
        request: CompanionRequest,
        connection: &mut W,
        frame_limits: &FrameLimits,
    ) -> Result<(), companion::ipc::server::FrameError> {
        let request_id = request.request_id.clone();
        match request.payload {
            CompanionRequestPayload::CompanionProbe(payload) => {
                if payload.target_adapter != "desktop-windows-uia"
                    || payload.observation_extension != "uia/v1"
                {
                    return write_error(
                        connection,
                        &request_id,
                        "companion.probe",
                        "CapabilityMismatch",
                        "Companion supports desktop-windows-uia with uia/v1 only",
                        frame_limits,
                    );
                }
                write_ok(
                    connection,
                    &request_id,
                    "companion.probe",
                    serde_json::json!({
                        "ready": true,
                        "protocolMajor": companion::ipc::dto::PROTOCOL_MAJOR,
                        "targetAdapter": payload.target_adapter,
                        "observationExtension": payload.observation_extension,
                        "checkedAt": now_string(),
                    }),
                    frame_limits,
                )
            }
            CompanionRequestPayload::SessionShow(payload) => write_ok(
                connection,
                &request_id,
                "session.show",
                session_payload(&payload.run_id, "shown"),
                frame_limits,
            ),
            CompanionRequestPayload::SessionPause(payload) => {
                for companion in state.companions.values_mut() {
                    companion.pause();
                }
                write_ok(
                    connection,
                    &request_id,
                    "session.pause",
                    session_payload(&payload.run_id, "paused"),
                    frame_limits,
                )
            }
            CompanionRequestPayload::SessionResume(payload) => {
                for companion in state.companions.values_mut() {
                    companion.resume();
                }
                write_ok(
                    connection,
                    &request_id,
                    "session.resume",
                    session_payload(&payload.run_id, "resumed"),
                    frame_limits,
                )
            }
            CompanionRequestPayload::SessionStop(payload) => {
                for companion in state.companions.values_mut() {
                    companion.emergency_stop();
                }
                state.supervisor.cancel_in_flight();
                write_ok(
                    connection,
                    &request_id,
                    "session.stop",
                    session_payload(&payload.run_id, "stopped"),
                    frame_limits,
                )
            }
            CompanionRequestPayload::SessionClose(payload) => {
                for companion in state.companions.values_mut() {
                    companion.emergency_stop();
                }
                state.supervisor.cancel_in_flight();
                write_ok(
                    connection,
                    &request_id,
                    "session.close",
                    session_payload(&payload.run_id, "closed"),
                    frame_limits,
                )
            }
            CompanionRequestPayload::AppLaunch(payload) => {
                let session_id = format!(
                    "app-{}",
                    hex::encode(companion::random::random_bytes::<16>())
                );
                let spec = launch_spec(&payload.target);
                match state.sessions.launch(&session_id, &spec) {
                    Ok(session) => {
                        state
                            .reset_specs
                            .insert(session_id.clone(), reset_spec(&payload.target));
                        let _ = state.companion_for(&session_id, "");
                        write_ok(
                            connection,
                            &request_id,
                            "app.launch",
                            app_session_payload(&session),
                            frame_limits,
                        )
                    }
                    Err(error) => write_lifecycle_error(
                        connection,
                        &request_id,
                        "app.launch",
                        error,
                        frame_limits,
                    ),
                }
            }
            CompanionRequestPayload::AppReset(payload) => {
                let Some(reset) = state.reset_specs.get(&payload.session_id).cloned() else {
                    return write_error(
                        connection,
                        &request_id,
                        "app.reset",
                        "ApplicationError",
                        "SessionNotFound",
                        frame_limits,
                    );
                };
                match state.sessions.reset(&payload.session_id, &reset) {
                    Ok(()) => write_ok(
                        connection,
                        &request_id,
                        "app.reset",
                        lifecycle_done_payload(&payload.session_id),
                        frame_limits,
                    ),
                    Err(error) => write_lifecycle_error(
                        connection,
                        &request_id,
                        "app.reset",
                        error,
                        frame_limits,
                    ),
                }
            }
            CompanionRequestPayload::AppShutdown(payload) => {
                match state.sessions.shutdown(&payload.session_id) {
                    Ok(()) => {
                        state.companions.remove(&payload.session_id);
                        state.reset_specs.remove(&payload.session_id);
                        write_ok(
                            connection,
                            &request_id,
                            "app.shutdown",
                            lifecycle_done_payload(&payload.session_id),
                            frame_limits,
                        )
                    }
                    Err(error) => write_lifecycle_error(
                        connection,
                        &request_id,
                        "app.shutdown",
                        error,
                        frame_limits,
                    ),
                }
            }
            CompanionRequestPayload::UiaCapture(payload) => {
                if let Err(error) = state.sessions.verify_children(&payload.session_id) {
                    return write_lifecycle_error(
                        connection,
                        &request_id,
                        "uia.capture",
                        error,
                        frame_limits,
                    );
                }
                let target = match state.target_for(&payload.session_id) {
                    Ok(target) => target,
                    Err(error) => {
                        return write_lifecycle_error(
                            connection,
                            &request_id,
                            "uia.capture",
                            error,
                            frame_limits,
                        )
                    }
                };
                match state
                    .supervisor
                    .capture(&target, Duration::from_millis(payload.deadline_ms))
                {
                    Ok(source) => write_ok(
                        connection,
                        &request_id,
                        "uia.capture",
                        serde_json::to_value(source).unwrap_or(serde_json::Value::Null),
                        frame_limits,
                    ),
                    Err(error) => {
                        write_uia_error(connection, &request_id, "uia.capture", error, frame_limits)
                    }
                }
            }
            CompanionRequestPayload::PermitRequest(payload) => {
                let permit_request = payload.request;
                let session_id = permit_request.session_id.clone();
                if state.sessions.session(&session_id).is_none() {
                    return write_error(
                        connection,
                        &request_id,
                        "permit.request",
                        "ApplicationError",
                        "SessionNotFound",
                        frame_limits,
                    );
                }
                let local_risk = classify_desktop_action(&permit_request.action);
                if permit_request.authorization.risk != Risk::ProductionForbidden
                    && permit_request.authorization.risk != local_risk
                {
                    return write_error(
                        connection,
                        &request_id,
                        "permit.request",
                        "PolicyDenied",
                        "RiskMismatch",
                        frame_limits,
                    );
                }
                let expected_digest = desktop_action_digest_sha256(
                    &permit_request.session_id,
                    &permit_request.run_id,
                    &permit_request.action,
                    &permit_request.authorization.decision_id,
                    &permit_request.authorization.policy_id,
                    permit_request.authorization.risk,
                    &permit_request.authorization.expires_at,
                    &permit_request.authorization.nonce_base64,
                    permit_request.authorization.value_binding.as_ref(),
                );
                if expected_digest != permit_request.authorization.action_digest_sha256 {
                    return write_error(
                        connection,
                        &request_id,
                        "permit.request",
                        "PolicyDenied",
                        "ActionDigestMismatch",
                        frame_limits,
                    );
                }
                let binding = PermitBinding {
                    session_id: permit_request.session_id.clone(),
                    run_id: permit_request.run_id.clone(),
                    action_id: permit_request.action.action_id.clone(),
                    action_digest_sha256: permit_request.authorization.action_digest_sha256.clone(),
                    graph_id: permit_request.action.graph_id.clone(),
                    risk: permit_request.authorization.risk,
                };
                let approval = ApprovalRequest {
                    approval_id: permit_request.approval_id.clone(),
                    session_id: permit_request.session_id.clone(),
                    run_id: permit_request.run_id.clone(),
                    action_id: permit_request.action.action_id.clone(),
                    risk: permit_request.authorization.risk,
                    safe_summary: permit_request.safe_summary.clone(),
                };
                let outcome = state
                    .companion_for(&session_id, &permit_request.run_id)
                    .request_permit(&approval, binding);
                match outcome {
                    PermitRequestOutcome::Issued(permit) => write_ok(
                        connection,
                        &request_id,
                        "permit.request",
                        issued_permit_payload(
                            &permit_request.approval_id,
                            &permit_request.authorization,
                            permit,
                        ),
                        frame_limits,
                    ),
                    PermitRequestOutcome::Rejected(decision) => write_ok(
                        connection,
                        &request_id,
                        "permit.request",
                        serde_json::json!({
                            "status": decision_status(decision),
                            "approvalId": permit_request.approval_id,
                            "decidedAt": now_string(),
                        }),
                        frame_limits,
                    ),
                }
            }
            CompanionRequestPayload::ActionExecute(payload) => {
                if let Err(error) = state.sessions.verify_children(&payload.session_id) {
                    return write_lifecycle_error(
                        connection,
                        &request_id,
                        "action.execute",
                        error,
                        frame_limits,
                    );
                }
                let target = match state.target_for(&payload.session_id) {
                    Ok(target) => target,
                    Err(error) => {
                        return write_lifecycle_error(
                            connection,
                            &request_id,
                            "action.execute",
                            error,
                            frame_limits,
                        )
                    }
                };
                let binding = PermitBinding {
                    session_id: payload.permit.session_id.clone(),
                    run_id: payload.permit.run_id.clone(),
                    action_id: payload.permit.action_id.clone(),
                    action_digest_sha256: payload.permit.action_digest_sha256.clone(),
                    graph_id: payload.permit.graph_id.clone(),
                    risk: payload.permit.risk,
                };
                let Some(companion) = state.companions.get_mut(&payload.session_id) else {
                    return write_error(
                        connection,
                        &request_id,
                        "action.execute",
                        "ApplicationError",
                        "SessionNotFound",
                        frame_limits,
                    );
                };
                match execute_desktop_action_request(
                    companion,
                    &mut state.supervisor,
                    &target,
                    &payload.action,
                    &payload.permit,
                    payload.value,
                    &binding,
                    Duration::from_millis(payload.deadline_ms),
                ) {
                    Ok(outcome) => {
                        write_action_outcome(connection, &request_id, outcome, frame_limits)
                    }
                    Err(DesktopActionError::Uia(UiaError::ActionOutcomeUnknown)) => write_error(
                        connection,
                        &request_id,
                        "action.execute",
                        "ActionOutcomeUnknown",
                        "ActionOutcomeUnknown",
                        frame_limits,
                    ),
                    Err(error) => write_error(
                        connection,
                        &request_id,
                        "action.execute",
                        "ApplicationError",
                        action_error_message(&error),
                        frame_limits,
                    ),
                }
            }
            CompanionRequestPayload::HandshakeBegin(_)
            | CompanionRequestPayload::HandshakeProve(_) => write_error(
                connection,
                &request_id,
                "handshake.accepted",
                "CompanionProtocolViolation",
                "handshake routed as application request",
                frame_limits,
            ),
        }?;
        Ok(())
    }

    fn authorize_peer(listener: &NamedPipeListener) -> Result<(), NativePipeError> {
        let identity = listener.client_identity()?;
        let current = WindowsPeerIdentity::for_current_process()?;
        let allowed_image_paths = std::env::var("QUALIGENCE_COMPANION_ALLOWED_RUNNER_IMAGES")
            .ok()
            .map(|value| {
                split_env_list(&value)
                    .into_iter()
                    .map(|path| normalize_path_for_comparison(&path))
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_else(|| {
                [normalize_path_for_comparison(&current.image_path)]
                    .into_iter()
                    .collect()
            });
        let allow_unsigned_test_only =
            std::env::var("QUALIGENCE_COMPANION_ALLOW_UNSIGNED_TEST_ONLY")
                .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
        let signature_policy = if allow_unsigned_test_only {
            BinarySignaturePolicy::AllowUnsignedForNativeTestOnly
        } else {
            BinarySignaturePolicy::RequireAuthenticodeSigner {
                allowed_sha1_thumbprints: std::env::var(
                    "QUALIGENCE_COMPANION_ALLOWED_RUNNER_SIGNERS_SHA1",
                )
                .map(|value| {
                    split_env_list(&value)
                        .into_iter()
                        .map(|thumbprint| thumbprint.replace(':', "").to_ascii_lowercase())
                        .collect()
                })
                .unwrap_or_default(),
            }
        };
        let policy = WindowsPeerPolicy {
            expected_logon_sid: listener.logon_sid().to_string(),
            expected_token_user_sid: current.token_user_sid,
            expected_session_id: current.session_id,
            allowed_image_paths,
            signature_policy,
        };
        WindowsPeerAuthorizer::new(policy).authorize(&identity)
    }

    fn load_certificate_policies() -> Vec<RunnerCertificatePolicy> {
        let runner_id = match std::env::var("QUALIGENCE_COMPANION_RUNNER_ID") {
            Ok(value) if !value.trim().is_empty() => value,
            _ => return Vec::new(),
        };
        let expected_fingerprint_sha256 =
            match std::env::var("QUALIGENCE_COMPANION_RUNNER_CERT_SHA256") {
                Ok(value) if !value.trim().is_empty() => {
                    value.replace(':', "").to_ascii_lowercase()
                }
                _ => return Vec::new(),
            };
        let required_san = match std::env::var("QUALIGENCE_COMPANION_RUNNER_SAN") {
            Ok(value) if !value.trim().is_empty() => value,
            _ => return Vec::new(),
        };
        let required_scope_sans = std::env::var("QUALIGENCE_COMPANION_RUNNER_SCOPE_SANS")
            .map(|value| split_env_list(&value))
            .unwrap_or_default();
        let trusted_issuer_fingerprint_sha256 =
            std::env::var("QUALIGENCE_COMPANION_RUNNER_ISSUER_SHA256")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.replace(':', "").to_ascii_lowercase());
        vec![RunnerCertificatePolicy {
            runner_id,
            expected_fingerprint_sha256,
            required_san,
            required_scope_sans,
            trusted_issuer_fingerprint_sha256,
        }]
    }

    fn split_env_list(value: &str) -> Vec<String> {
        value
            .split(|ch| ch == ';' || ch == ',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToOwned::to_owned)
            .collect()
    }

    fn launch_spec(target: &AppTarget) -> AppLaunchSpec {
        AppLaunchSpec {
            executable: target.launch.executable.clone(),
            args: target.launch.args.clone(),
            working_directory: target.launch.working_directory.clone(),
            expected_image_name: target.process.expected_image_name.clone(),
            allowed_child_image_names: target.process.allowed_child_image_names.clone(),
            packaged_cannot_join_job: !matches!(target.platform, DesktopPlatform::Windows),
        }
    }

    fn reset_spec(target: &AppTarget) -> ResetSpec {
        ResetSpec {
            command: target.reset.command.clone(),
            args: target.reset.args.clone(),
            timeout_ms: target.reset.timeout_ms,
        }
    }

    fn app_session_payload(session: &AppSessionState) -> serde_json::Value {
        serde_json::json!({
            "sessionId": session.session_id,
            "processId": session.pid,
            "processCreationTime": session.creation_time,
            "processGroupId": session.process_group_id,
            "rootWindowHandle": session.root_window_handle,
            "startedAt": now_string(),
        })
    }

    fn lifecycle_done_payload(session_id: &str) -> serde_json::Value {
        serde_json::json!({
            "sessionId": session_id,
            "completedAt": now_string(),
        })
    }

    fn session_payload(run_id: &str, state: &str) -> serde_json::Value {
        serde_json::json!({
            "runId": run_id,
            "state": state,
            "changedAt": now_string(),
        })
    }

    fn issued_permit_payload(
        approval_id: &str,
        authorization: &companion::ipc::dto::LocalPermitAuthorization,
        permit: IssuedPermit,
    ) -> serde_json::Value {
        let mut permit_payload = serde_json::Map::new();
        permit_payload.insert(
            "permitToken".into(),
            serde_json::Value::String(permit.token),
        );
        permit_payload.insert(
            "nonceBase64".into(),
            serde_json::Value::String(authorization.nonce_base64.clone()),
        );
        permit_payload.insert(
            "sessionId".into(),
            serde_json::Value::String(permit.binding.session_id),
        );
        permit_payload.insert(
            "runId".into(),
            serde_json::Value::String(permit.binding.run_id),
        );
        permit_payload.insert(
            "actionId".into(),
            serde_json::Value::String(permit.binding.action_id),
        );
        permit_payload.insert(
            "actionDigestSha256".into(),
            serde_json::Value::String(permit.binding.action_digest_sha256),
        );
        permit_payload.insert(
            "graphId".into(),
            serde_json::Value::String(permit.binding.graph_id),
        );
        permit_payload.insert(
            "decisionId".into(),
            serde_json::Value::String(authorization.decision_id.clone()),
        );
        permit_payload.insert(
            "policyId".into(),
            serde_json::Value::String(authorization.policy_id.clone()),
        );
        permit_payload.insert(
            "risk".into(),
            serde_json::to_value(permit.binding.risk).unwrap_or(serde_json::Value::Null),
        );
        permit_payload.insert("issuedAt".into(), serde_json::Value::String(now_string()));
        permit_payload.insert(
            "expiresAt".into(),
            serde_json::Value::String(authorization.expires_at.clone()),
        );
        if let Some(value_binding) = &authorization.value_binding {
            permit_payload.insert(
                "valueBinding".into(),
                serde_json::to_value(value_binding).unwrap_or(serde_json::Value::Null),
            );
        }
        serde_json::json!({
            "status": "approved",
            "approvalId": approval_id,
            "decidedAt": now_string(),
            "permit": serde_json::Value::Object(permit_payload),
        })
    }

    fn write_action_outcome<W: Write>(
        connection: &mut W,
        request_id: &str,
        outcome: ActionOutcomeReport,
        limits: &FrameLimits,
    ) -> Result<(), companion::ipc::server::FrameError> {
        write_ok(
            connection,
            request_id,
            "action.execute",
            serde_json::to_value(outcome).unwrap_or(serde_json::Value::Null),
            limits,
        )
    }

    fn write_lifecycle_error<W: Write>(
        connection: &mut W,
        request_id: &str,
        response_type: &str,
        error: LifecycleError,
        limits: &FrameLimits,
    ) -> Result<(), companion::ipc::server::FrameError> {
        match error {
            LifecycleError::AppLifecycleUnsupported => write_error(
                connection,
                request_id,
                response_type,
                "ApplicationError",
                "AppLifecycleUnsupported",
                limits,
            ),
            LifecycleError::UnexpectedChild(_) => write_error(
                connection,
                request_id,
                response_type,
                "ApplicationError",
                "UnexpectedChild",
                limits,
            ),
            LifecycleError::SessionNotFound => write_error(
                connection,
                request_id,
                response_type,
                "ApplicationError",
                "SessionNotFound",
                limits,
            ),
            LifecycleError::AppResetFailed => write_error(
                connection,
                request_id,
                response_type,
                "ApplicationError",
                "AppResetFailed",
                limits,
            ),
            LifecycleError::AppLaunchFailed | LifecycleError::HostError => write_error(
                connection,
                request_id,
                response_type,
                "ApplicationError",
                "AppLaunchFailed",
                limits,
            ),
        }
    }

    fn write_uia_error<W: Write>(
        connection: &mut W,
        request_id: &str,
        response_type: &str,
        error: UiaError,
        limits: &FrameLimits,
    ) -> Result<(), companion::ipc::server::FrameError> {
        let code = if matches!(error, UiaError::ActionOutcomeUnknown) {
            "ActionOutcomeUnknown"
        } else {
            "ApplicationError"
        };
        write_error(
            connection,
            request_id,
            response_type,
            code,
            error.code(),
            limits,
        )
    }

    fn action_error_message(error: &DesktopActionError) -> &str {
        match error {
            DesktopActionError::Permit(_) => "LocalPermitInvalid",
            DesktopActionError::BindingMismatch => "LocalPermitBindingMismatch",
            DesktopActionError::Uia(error) => error.code(),
        }
    }

    fn decision_status(decision: companion::approval::Decision) -> &'static str {
        match decision {
            companion::approval::Decision::Approved => "approved",
            companion::approval::Decision::Denied | companion::approval::Decision::Paused => {
                "denied"
            }
            companion::approval::Decision::TimedOut => "timed_out",
            companion::approval::Decision::EmergencyStopped => "emergency_stopped",
        }
    }

    fn write_ok<W: Write>(
        connection: &mut W,
        request_id: &str,
        response_type: &str,
        payload: serde_json::Value,
        limits: &FrameLimits,
    ) -> Result<(), companion::ipc::server::FrameError> {
        let body = serde_json::to_vec(&serde_json::json!({
            "protocolMajor": companion::ipc::dto::PROTOCOL_MAJOR,
            "requestId": request_id,
            "type": response_type,
            "status": "ok",
            "payload": payload,
        }))
        .map_err(|_| companion::ipc::server::FrameError::Malformed)?;
        write_frame(connection, &body, limits)
    }

    fn write_error<W: Write>(
        connection: &mut W,
        request_id: &str,
        response_type: &str,
        code: &str,
        safe_message: &str,
        limits: &FrameLimits,
    ) -> Result<(), companion::ipc::server::FrameError> {
        let body = serde_json::to_vec(&serde_json::json!({
            "protocolMajor": companion::ipc::dto::PROTOCOL_MAJOR,
            "requestId": request_id,
            "type": response_type,
            "status": "error",
            "error": {
                "code": code,
                "safeMessage": safe_message,
            },
        }))
        .map_err(|_| companion::ipc::server::FrameError::Malformed)?;
        write_frame(connection, &body, limits)
    }

    fn now_string() -> String {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        format!("unix-ms:{millis}")
    }
}

#[cfg(not(windows))]
fn run_daemon() {
    eprintln!("companion daemon requires Windows 11: Windows11Unavailable");
    std::process::exit(1);
}
