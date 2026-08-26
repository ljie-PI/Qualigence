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
    use std::io;
    use std::io::Write;
    use std::ptr::null;
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::thread::JoinHandle;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use companion::approval::{ApprovalOutcome, ApprovalRequest, ApprovalState, ScriptedApprover};
    use companion::clock::SystemClock;
    use companion::ipc::dto::{
        validate_app_target_timeout_ms, validate_deadline_ms, ActionExecutePayload, AppTarget,
        CompanionRequestPayload, DesktopPlatform,
    };
    use companion::ipc::security::{CertificateHandshakeVerifier, RunnerCertificatePolicy};
    use companion::ipc::server::{write_frame, FrameLimits};
    use companion::ipc::windows_pipe::{
        normalize_path_for_comparison, AdmittedNativeApplicationRequest, BinarySignaturePolicy,
        NamedPipeListener, NativePipeConfig, NativePipeError, NativePipeRequestEvent,
        NativePipeRequestProcessor, WindowsPeerAuthorizer, WindowsPeerIdentity, WindowsPeerPolicy,
    };
    use companion::permit::{IssuedPermit, PermitBinding, PermitStore};
    use companion::process::app_session::{AppSessionManager, AppSessionState};
    use companion::process::job_object::{
        AppLaunchSpec, LifecycleError, ResetSpec, WindowsDesktopProcessHost,
    };
    use companion::risk::Risk;
    use companion::uia::action::{
        classify_desktop_action, desktop_action_digest_sha256, ensure_companion_accepts_uia_work,
        execute_desktop_action_request_before_deadline, DesktopActionError,
    };
    use companion::uia::protocol::{ActionOutcomeReport, UiaError, UiaSessionTarget};
    use companion::uia::worker_supervisor::{
        lock_supervisor_until, NativeUiaWorkerSpawner, RequestDeadline, UiaWorkerSupervisor,
        WorkerCancellation, WorkerError,
    };
    use companion::{Companion, PermitRequestOutcome};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_IO_PENDING, HANDLE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Storage::FileSystem::WriteFile;
    use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

    type DaemonCompanion = Companion<SystemClock, ScriptedApprover>;

    struct DaemonState {
        clock: Arc<SystemClock>,
        sessions: AppSessionManager<WindowsDesktopProcessHost>,
        companions: HashMap<String, Arc<Mutex<DaemonCompanion>>>,
        reset_specs: HashMap<String, ResetSpec>,
        supervisor: Arc<Mutex<UiaWorkerSupervisor<NativeUiaWorkerSpawner>>>,
        worker_cancellation: WorkerCancellation,
    }

    #[derive(Clone)]
    struct SharedResponseWriter {
        handle: usize,
        lock: Arc<Mutex<()>>,
    }

    impl SharedResponseWriter {
        fn new(handle: HANDLE) -> Self {
            Self {
                handle: handle as usize,
                lock: Arc::new(Mutex::new(())),
            }
        }

        fn write_ok(
            &self,
            request_id: &str,
            response_type: &str,
            payload: serde_json::Value,
            limits: &FrameLimits,
        ) -> Result<(), companion::ipc::server::FrameError> {
            let mut writer = self.locked();
            write_ok(&mut writer, request_id, response_type, payload, limits)
        }

        fn write_error(
            &self,
            request_id: &str,
            response_type: &str,
            code: &str,
            safe_message: &str,
            limits: &FrameLimits,
        ) -> Result<(), companion::ipc::server::FrameError> {
            let mut writer = self.locked();
            write_error(
                &mut writer,
                request_id,
                response_type,
                code,
                safe_message,
                limits,
            )
        }

        fn write_action_outcome(
            &self,
            request_id: &str,
            outcome: ActionOutcomeReport,
            limits: &FrameLimits,
        ) -> Result<(), companion::ipc::server::FrameError> {
            let mut writer = self.locked();
            write_action_outcome(&mut writer, request_id, outcome, limits)
        }

        fn write_lifecycle_error(
            &self,
            request_id: &str,
            response_type: &str,
            error: LifecycleError,
            limits: &FrameLimits,
        ) -> Result<(), companion::ipc::server::FrameError> {
            let mut writer = self.locked();
            write_lifecycle_error(&mut writer, request_id, response_type, error, limits)
        }

        fn write_uia_error(
            &self,
            request_id: &str,
            response_type: &str,
            error: UiaError,
            limits: &FrameLimits,
        ) -> Result<(), companion::ipc::server::FrameError> {
            let mut writer = self.locked();
            write_uia_error(&mut writer, request_id, response_type, error, limits)
        }

        fn locked(&self) -> RawPipeWriter<'_> {
            RawPipeWriter {
                handle: self.handle as HANDLE,
                _guard: self.lock.lock().expect("pipe response writer poisoned"),
            }
        }
    }

    struct RawPipeWriter<'a> {
        handle: HANDLE,
        _guard: MutexGuard<'a, ()>,
    }

    impl Write for RawPipeWriter<'_> {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let len = buf.len().min(u32::MAX as usize) as u32;
            let event = unsafe { CreateEventW(null(), 1, 0, null()) };
            if event.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut transferred = 0u32;
            let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
            overlapped.hEvent = event;
            let ok = unsafe {
                WriteFile(
                    self.handle,
                    buf.as_ptr(),
                    len,
                    &mut transferred,
                    &mut overlapped,
                )
            };
            let result = complete_pipe_write(self.handle, ok, &mut overlapped, transferred);
            unsafe {
                CloseHandle(event);
            }
            result
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn complete_pipe_write(
        handle: HANDLE,
        ok: i32,
        overlapped: &mut OVERLAPPED,
        immediate_transferred: u32,
    ) -> io::Result<usize> {
        if ok != 0 {
            return Ok(immediate_transferred as usize);
        }
        let code = unsafe { GetLastError() };
        if code != ERROR_IO_PENDING {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let wait = unsafe { WaitForSingleObject(overlapped.hEvent, 5_000) };
        if wait != WAIT_OBJECT_0 {
            unsafe {
                CancelIoEx(handle, overlapped);
            }
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "pipe response write timed out",
            ));
        }
        let mut transferred = 0u32;
        let ok = unsafe { GetOverlappedResult(handle, overlapped, &mut transferred, 0) };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(transferred as usize)
        }
    }

    impl DaemonState {
        fn new(clock: Arc<SystemClock>) -> Self {
            let supervisor = UiaWorkerSupervisor::new(NativeUiaWorkerSpawner::new());
            let worker_cancellation = supervisor.cancellation_handle();
            Self {
                clock,
                sessions: AppSessionManager::new(WindowsDesktopProcessHost::new()),
                companions: HashMap::new(),
                reset_specs: HashMap::new(),
                supervisor: Arc::new(Mutex::new(supervisor)),
                worker_cancellation,
            }
        }

        fn companion_for(&mut self, session_id: &str, run_id: &str) -> Arc<Mutex<DaemonCompanion>> {
            let clock = Arc::clone(&self.clock);
            Arc::clone(
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
                        Arc::new(Mutex::new(Companion::new(
                            session_id.to_string(),
                            approval,
                            permits,
                        )))
                    }),
            )
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
        let response_writer = SharedResponseWriter::new(listener.raw_handle());
        let mut action_threads: Vec<JoinHandle<()>> = Vec::new();
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
                    let _ = response_writer.write_error(
                        "unknown",
                        "companion.probe",
                        error.stable_code(),
                        error.stable_code(),
                        &frame_limits,
                    );
                    processor.disconnect_cleanup();
                    cancel_worker_for_stop(&state);
                    break;
                }
            };
            action_threads.retain(|handle| !handle.is_finished());
            let write_result = match event {
                NativePipeRequestEvent::ChallengeIssued {
                    request_id,
                    challenge_id,
                    nonce_base64,
                } => response_writer.write_ok(
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
                } => response_writer.write_ok(
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
                        admitted,
                        &response_writer,
                        &frame_limits,
                        &mut action_threads,
                    )
                }
            };
            if write_result.is_err() {
                processor.disconnect_cleanup();
                cancel_worker_for_stop(&state);
                break;
            }
        }
        cancel_worker_for_stop(&state);
        for handle in action_threads {
            let _ = handle.join();
        }
    }

    fn dispatch_application_request(
        state: &mut DaemonState,
        admitted: AdmittedNativeApplicationRequest,
        response_writer: &SharedResponseWriter,
        frame_limits: &FrameLimits,
        action_threads: &mut Vec<JoinHandle<()>>,
    ) -> Result<(), companion::ipc::server::FrameError> {
        let request = admitted.request.clone();
        let request_id = request.request_id.clone();
        match request.payload {
            CompanionRequestPayload::CompanionProbe(payload) => {
                if payload.target_adapter != "desktop-windows-uia"
                    || payload.observation_extension != "uia/v1"
                {
                    return response_writer.write_error(
                        &request_id,
                        "companion.probe",
                        "CapabilityMismatch",
                        "Companion supports desktop-windows-uia with uia/v1 only",
                        frame_limits,
                    );
                }
                response_writer.write_ok(
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
            CompanionRequestPayload::SessionShow(payload) => response_writer.write_ok(
                &request_id,
                "session.show",
                session_payload(&payload.run_id, "shown"),
                frame_limits,
            ),
            CompanionRequestPayload::SessionPause(payload) => {
                for companion in state.companions.values() {
                    if let Ok(mut companion) = companion.lock() {
                        companion.pause();
                    }
                }
                response_writer.write_ok(
                    &request_id,
                    "session.pause",
                    session_payload(&payload.run_id, "paused"),
                    frame_limits,
                )
            }
            CompanionRequestPayload::SessionResume(payload) => {
                for companion in state.companions.values() {
                    if let Ok(mut companion) = companion.lock() {
                        companion.resume();
                    }
                }
                response_writer.write_ok(
                    &request_id,
                    "session.resume",
                    session_payload(&payload.run_id, "resumed"),
                    frame_limits,
                )
            }
            CompanionRequestPayload::SessionStop(payload) => {
                for companion in state.companions.values() {
                    if let Ok(mut companion) = companion.lock() {
                        companion.emergency_stop();
                    }
                }
                cancel_worker_for_stop(state);
                response_writer.write_ok(
                    &request_id,
                    "session.stop",
                    session_payload(&payload.run_id, "stopped"),
                    frame_limits,
                )
            }
            CompanionRequestPayload::SessionClose(payload) => {
                for companion in state.companions.values() {
                    if let Ok(mut companion) = companion.lock() {
                        companion.emergency_stop();
                    }
                }
                cancel_worker_for_stop(state);
                response_writer.write_ok(
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
                if !target_deadlines_are_valid(&payload.target) {
                    return response_writer.write_error(
                        &request_id,
                        "app.launch",
                        "CompanionProtocolViolation",
                        "InvalidDeadline",
                        frame_limits,
                    );
                }
                let spec = launch_spec(&payload.target);
                match state.sessions.launch(&session_id, &spec) {
                    Ok(session) => {
                        state
                            .reset_specs
                            .insert(session_id.clone(), reset_spec(&payload.target));
                        let _ = state.companion_for(&session_id, "");
                        response_writer.write_ok(
                            &request_id,
                            "app.launch",
                            app_session_payload(&session),
                            frame_limits,
                        )
                    }
                    Err(error) => response_writer.write_lifecycle_error(
                        &request_id,
                        "app.launch",
                        error,
                        frame_limits,
                    ),
                }
            }
            CompanionRequestPayload::AppReset(payload) => {
                let Some(reset) = state.reset_specs.get(&payload.session_id).cloned() else {
                    return response_writer.write_error(
                        &request_id,
                        "app.reset",
                        "ApplicationError",
                        "SessionNotFound",
                        frame_limits,
                    );
                };
                match state.sessions.reset(&payload.session_id, &reset) {
                    Ok(()) => response_writer.write_ok(
                        &request_id,
                        "app.reset",
                        lifecycle_done_payload(&payload.session_id),
                        frame_limits,
                    ),
                    Err(error) => response_writer.write_lifecycle_error(
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
                        response_writer.write_ok(
                            &request_id,
                            "app.shutdown",
                            lifecycle_done_payload(&payload.session_id),
                            frame_limits,
                        )
                    }
                    Err(error) => response_writer.write_lifecycle_error(
                        &request_id,
                        "app.shutdown",
                        error,
                        frame_limits,
                    ),
                }
            }
            CompanionRequestPayload::UiaCapture(payload) => {
                let Some(deadline) = checked_deadline(payload.deadline_ms) else {
                    return response_writer.write_error(
                        &request_id,
                        "uia.capture",
                        "CompanionProtocolViolation",
                        "InvalidDeadline",
                        frame_limits,
                    );
                };
                if let Err(error) = state.sessions.verify_children(&payload.session_id) {
                    return response_writer.write_lifecycle_error(
                        &request_id,
                        "uia.capture",
                        error,
                        frame_limits,
                    );
                }
                let target = match state.target_for(&payload.session_id) {
                    Ok(target) => target,
                    Err(error) => {
                        return response_writer.write_lifecycle_error(
                            &request_id,
                            "uia.capture",
                            error,
                            frame_limits,
                        )
                    }
                };
                let Some(companion) = state.companions.get(&payload.session_id).cloned() else {
                    return response_writer.write_error(
                        &request_id,
                        "uia.capture",
                        "ApplicationError",
                        "SessionNotFound",
                        frame_limits,
                    );
                };
                match companion
                    .lock()
                    .map_err(|_| UiaError::WorkerUnavailable)
                    .and_then(|companion| ensure_companion_accepts_uia_work(&*companion))
                {
                    Ok(()) => {}
                    Err(error) => {
                        return response_writer.write_uia_error(
                            &request_id,
                            "uia.capture",
                            error,
                            frame_limits,
                        )
                    }
                }
                let supervisor = Arc::clone(&state.supervisor);
                let cancellation = state.worker_cancellation.checkpoint();
                let deadline = RequestDeadline::after(deadline);
                let writer = response_writer.clone();
                let limits = *frame_limits;
                action_threads.push(std::thread::spawn(move || {
                    let _admitted = admitted;
                    let capture_result =
                        match lock_supervisor_until(&supervisor, &deadline, &cancellation) {
                            Ok(mut supervisor) => {
                                supervisor.capture_until(&target, &deadline, &cancellation)
                            }
                            Err(WorkerError::Timeout) => Err(UiaError::TargetUnresponsive),
                            Err(WorkerError::Cancelled) => Err(UiaError::EmergencyStopped),
                            Err(_) => Err(UiaError::WorkerUnavailable),
                        };
                    let _ = match capture_result {
                        Ok(source) => writer.write_ok(
                            &request_id,
                            "uia.capture",
                            serde_json::to_value(source).unwrap_or(serde_json::Value::Null),
                            &limits,
                        ),
                        Err(error) => {
                            writer.write_uia_error(&request_id, "uia.capture", error, &limits)
                        }
                    };
                }));
                Ok(())
            }
            CompanionRequestPayload::PermitRequest(payload) => {
                let permit_request = payload.request;
                let session_id = permit_request.session_id.clone();
                if state.sessions.session(&session_id).is_none() {
                    return response_writer.write_error(
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
                    return response_writer.write_error(
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
                    return response_writer.write_error(
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
                let companion = state.companion_for(&session_id, &permit_request.run_id);
                let outcome = match companion.lock() {
                    Ok(mut companion) => companion.request_permit(&approval, binding),
                    Err(_) => {
                        return response_writer.write_error(
                            &request_id,
                            "permit.request",
                            "ApplicationError",
                            "CompanionUnavailable",
                            frame_limits,
                        );
                    }
                };
                match outcome {
                    PermitRequestOutcome::Issued(permit) => response_writer.write_ok(
                        &request_id,
                        "permit.request",
                        issued_permit_payload(
                            &permit_request.approval_id,
                            &permit_request.authorization,
                            permit,
                        ),
                        frame_limits,
                    ),
                    PermitRequestOutcome::Rejected(decision) => response_writer.write_ok(
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
                let Some(deadline) = checked_deadline(payload.deadline_ms) else {
                    return response_writer.write_error(
                        &request_id,
                        "action.execute",
                        "CompanionProtocolViolation",
                        "InvalidDeadline",
                        frame_limits,
                    );
                };
                if let Err(error) = state.sessions.verify_children(&payload.session_id) {
                    return response_writer.write_lifecycle_error(
                        &request_id,
                        "action.execute",
                        error,
                        frame_limits,
                    );
                }
                let target = match state.target_for(&payload.session_id) {
                    Ok(target) => target,
                    Err(error) => {
                        return response_writer.write_lifecycle_error(
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
                let Some(companion) = state.companions.get(&payload.session_id).cloned() else {
                    return response_writer.write_error(
                        &request_id,
                        "action.execute",
                        "ApplicationError",
                        "SessionNotFound",
                        frame_limits,
                    );
                };
                let supervisor = Arc::clone(&state.supervisor);
                let cancellation = state.worker_cancellation.checkpoint();
                let deadline = RequestDeadline::after(deadline);
                let writer = response_writer.clone();
                let limits = *frame_limits;
                action_threads.push(std::thread::spawn(move || {
                    let _admitted = admitted;
                    let ActionExecutePayload {
                        session_id: _,
                        action,
                        permit,
                        value,
                        deadline_ms: _,
                    } = payload;
                    let result = execute_desktop_action_request_before_deadline(
                        &companion,
                        &supervisor,
                        &cancellation,
                        &target,
                        &action,
                        &permit,
                        value,
                        &binding,
                        &deadline,
                    );
                    let _ = write_action_execute_result(&writer, &request_id, result, &limits);
                }));
                Ok(())
            }
            CompanionRequestPayload::HandshakeBegin(_)
            | CompanionRequestPayload::HandshakeProve(_) => response_writer.write_error(
                &request_id,
                "handshake.accepted",
                "CompanionProtocolViolation",
                "handshake routed as application request",
                frame_limits,
            ),
        }?;
        Ok(())
    }

    fn write_action_execute_result(
        writer: &SharedResponseWriter,
        request_id: &str,
        result: Result<ActionOutcomeReport, DesktopActionError>,
        frame_limits: &FrameLimits,
    ) -> Result<(), companion::ipc::server::FrameError> {
        match result {
            Ok(outcome) => writer.write_action_outcome(request_id, outcome, frame_limits),
            Err(DesktopActionError::Uia(UiaError::ActionOutcomeUnknown)) => writer.write_error(
                request_id,
                "action.execute",
                "ActionOutcomeUnknown",
                "ActionOutcomeUnknown",
                frame_limits,
            ),
            Err(DesktopActionError::Permit(companion::permit::PermitError::EmergencyStopped))
            | Err(DesktopActionError::Uia(UiaError::EmergencyStopped)) => writer
                .write_action_outcome(
                    request_id,
                    ActionOutcomeReport::Failed {
                        error_code: "EmergencyStopped".to_string(),
                    },
                    frame_limits,
                ),
            Err(DesktopActionError::RequestDeadlineExpired) => writer.write_error(
                request_id,
                "action.execute",
                "CompanionRequestTimeout",
                "CompanionRequestTimeout",
                frame_limits,
            ),
            Err(DesktopActionError::RequestCancelled) => writer.write_error(
                request_id,
                "action.execute",
                "CompanionUnavailable",
                "RequestCancelled",
                frame_limits,
            ),
            Err(DesktopActionError::ValueTooLarge) => writer.write_error(
                request_id,
                "action.execute",
                "InvalidAction",
                "PlaintextValueTooLarge",
                frame_limits,
            ),
            Err(error) => writer.write_error(
                request_id,
                "action.execute",
                "ApplicationError",
                action_error_message(&error),
                frame_limits,
            ),
        }
    }

    fn action_error_message(error: &DesktopActionError) -> &str {
        match error {
            DesktopActionError::Permit(companion::permit::PermitError::EmergencyStopped) => {
                "EmergencyStopped"
            }
            DesktopActionError::Permit(_) => "LocalPermitInvalid",
            DesktopActionError::BindingMismatch => "LocalPermitBindingMismatch",
            DesktopActionError::ValueTooLarge => "PlaintextValueTooLarge",
            DesktopActionError::RequestDeadlineExpired => "CompanionRequestTimeout",
            DesktopActionError::RequestCancelled => "RequestCancelled",
            DesktopActionError::Uia(error) => error.code(),
        }
    }

    fn checked_deadline(deadline_ms: u64) -> Option<Duration> {
        validate_deadline_ms(deadline_ms)
            .ok()
            .map(Duration::from_millis)
    }

    fn cancel_worker_for_stop(state: &DaemonState) {
        state.worker_cancellation.cancel_in_flight();
        if let Ok(mut supervisor) = state.supervisor.try_lock() {
            supervisor.cancel_in_flight();
        }
    }

    fn target_deadlines_are_valid(target: &AppTarget) -> bool {
        validate_app_target_timeout_ms(target.reset.timeout_ms).is_ok()
            && validate_app_target_timeout_ms(target.shutdown.graceful_timeout_ms).is_ok()
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
        let code = match error {
            UiaError::ActionOutcomeUnknown => "ActionOutcomeUnknown",
            UiaError::EmergencyStopped => "ApplicationError",
            _ => "ApplicationError",
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
