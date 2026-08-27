//! The restartable UIA worker supervisor (specialist finding W-03).
//!
//! The supervisor is the Companion-main-process object that owns the child
//! worker's *lifecycle* but none of its COM state. Every capture/action request
//! is serialised through it with a monotonic deadline. If the worker hangs,
//! exits, floods or corrupts a frame, the supervisor terminates only that child
//! (its private Job on Windows) and lazily spawns a clean replacement on the next
//! request. It never touches the Companion's approval gate, deny latch or App
//! Job Object — proving a hung UIA call cannot take down the security core.
//!
//! Both the transport ([`WorkerHandle`]) and the spawner ([`WorkerSpawner`]) are
//! traits, so the real same-binary child-process transport (Windows) and the
//! portable fake used by the Linux test-suite share the exact restart logic.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

use crate::ipc::dto::{DesktopPlaintextValue, ResolvedDesktopAction};
use crate::uia::protocol::{
    ActionOutcomeReport, UiaError, UiaSessionTarget, UiaSource, WorkerRequest, WorkerResponse,
};

/// A transport failure while talking to a worker child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerError {
    /// The worker did not respond before the monotonic deadline (a hung COM call).
    Timeout,
    /// Emergency Stop cancelled the in-flight request and killed the worker.
    Cancelled,
    /// The worker process exited / the channel closed.
    Closed,
    /// The worker produced an oversized or malformed frame.
    Corrupt,
    /// A replacement worker could not be spawned.
    Spawn,
}

/// Cloneable cancellation signal shared between daemon control handling and the
/// thread currently blocked in a worker request. It lets Emergency Stop cancel a
/// hung COM call without taking the supervisor lock that the request owns.
#[derive(Clone, Default)]
pub struct WorkerCancellation {
    epoch: Arc<AtomicU64>,
}

impl WorkerCancellation {
    pub fn cancel_in_flight(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }

    pub fn checkpoint(&self) -> WorkerCancellationCheckpoint {
        WorkerCancellationCheckpoint {
            cancellation: self.clone(),
            epoch: self.epoch.load(Ordering::SeqCst),
        }
    }

    pub fn is_cancelled_since(&self, snapshot: u64) -> bool {
        self.epoch.load(Ordering::SeqCst) != snapshot
    }
}

pub struct WorkerCancellationCheckpoint {
    cancellation: WorkerCancellation,
    epoch: u64,
}

impl WorkerCancellationCheckpoint {
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled_since(self.epoch)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RequestDeadline {
    expires_at: Instant,
}

impl RequestDeadline {
    pub fn after(duration: Duration) -> Self {
        Self {
            expires_at: Instant::now() + duration,
        }
    }

    pub fn remaining(&self) -> Result<Duration, WorkerError> {
        let now = Instant::now();
        if now >= self.expires_at {
            Err(WorkerError::Timeout)
        } else {
            Ok(self.expires_at.saturating_duration_since(now))
        }
    }
}

pub fn lock_supervisor_until<'a, S: WorkerSpawner>(
    supervisor: &'a Arc<Mutex<UiaWorkerSupervisor<S>>>,
    deadline: &RequestDeadline,
    cancellation: &WorkerCancellationCheckpoint,
) -> Result<MutexGuard<'a, UiaWorkerSupervisor<S>>, WorkerError> {
    loop {
        if cancellation.is_cancelled() {
            return Err(WorkerError::Cancelled);
        }
        let remaining = deadline.remaining()?;
        match supervisor.try_lock() {
            Ok(supervisor) => return Ok(supervisor),
            Err(TryLockError::WouldBlock) => {
                std::thread::sleep(remaining.min(Duration::from_millis(2)));
            }
            Err(TryLockError::Poisoned(_)) => return Err(WorkerError::Spawn),
        }
    }
}

/// A live handle to one worker child.
pub trait WorkerHandle {
    /// Send `req` and block until a response, cancellation, or the monotonic
    /// `deadline` elapses.
    fn request(
        &mut self,
        req: &WorkerRequest,
        deadline: Duration,
        cancellation: &WorkerCancellationCheckpoint,
    ) -> Result<WorkerResponse, WorkerError>;
    /// Forcibly terminate the worker (its private Job on Windows).
    fn kill(&mut self);
    /// Whether the worker is still running.
    fn is_alive(&self) -> bool;
}

/// A factory that spawns a fresh worker child.
pub trait WorkerSpawner {
    type Handle: WorkerHandle;
    fn spawn(&mut self) -> Result<Self::Handle, WorkerError>;
}

/// Owns the current worker and rebuilds it on any failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticWorkerFault {
    TimeoutNextAction,
    BlockNextActionUntilCancelled,
}

pub struct UiaWorkerSupervisor<S: WorkerSpawner> {
    spawner: S,
    worker: Option<S::Handle>,
    restarts: u32,
    spawns: u32,
    cancellation: WorkerCancellation,
    diagnostic_next_action_fault: Option<DiagnosticWorkerFault>,
}

impl<S: WorkerSpawner> UiaWorkerSupervisor<S> {
    pub fn new(spawner: S) -> Self {
        Self {
            spawner,
            worker: None,
            restarts: 0,
            spawns: 0,
            cancellation: WorkerCancellation::default(),
            diagnostic_next_action_fault: None,
        }
    }

    pub fn cancellation_handle(&self) -> WorkerCancellation {
        self.cancellation.clone()
    }

    /// Number of times a worker was terminated and scheduled for rebuild.
    pub fn restart_count(&self) -> u32 {
        self.restarts
    }

    /// Number of worker children ever spawned.
    pub fn spawn_count(&self) -> u32 {
        self.spawns
    }

    /// Whether a live worker is currently held.
    pub fn worker_alive(&self) -> bool {
        self.worker.as_ref().map(|w| w.is_alive()).unwrap_or(false)
    }

    /// Force-terminate the current worker for the env-gated Ticket 47 native
    /// acceptance harness. This exercises the same recycle path as timeout,
    /// exit, or corrupt transport failures while leaving Companion/App Job
    /// authority intact and making the next UIA request spawn a fresh child.
    pub fn force_recycle_for_diagnostic(&mut self) {
        self.recycle_worker();
    }

    pub fn force_next_action_timeout_for_diagnostic(&mut self) {
        self.diagnostic_next_action_fault = Some(DiagnosticWorkerFault::TimeoutNextAction);
    }

    pub fn block_next_action_until_cancelled_for_diagnostic(&mut self) {
        self.diagnostic_next_action_fault =
            Some(DiagnosticWorkerFault::BlockNextActionUntilCancelled);
    }

    fn ensure_worker(&mut self) -> Result<&mut S::Handle, WorkerError> {
        if self.worker.is_none() {
            let handle = self.spawner.spawn()?;
            self.spawns += 1;
            self.worker = Some(handle);
        }
        Ok(self.worker.as_mut().expect("worker just ensured"))
    }

    /// Terminate the current worker so the NEXT request lazily spawns a clean one.
    fn recycle_worker(&mut self) {
        if let Some(mut worker) = self.worker.take() {
            worker.kill();
            self.restarts += 1;
        }
    }

    /// Emergency Stop cancellation hook: kill the current worker child immediately
    /// and latch future work at the Companion permit layer. The App Job remains
    /// owned by the main process and is not torn down by worker cancellation.
    pub fn cancel_in_flight(&mut self) {
        self.cancellation.cancel_in_flight();
        self.recycle_worker();
    }

    fn dispatch_until(
        &mut self,
        req: &WorkerRequest,
        deadline: &RequestDeadline,
        cancellation: &WorkerCancellationCheckpoint,
    ) -> Result<WorkerResponse, WorkerError> {
        if cancellation.is_cancelled() {
            return Err(WorkerError::Cancelled);
        }
        self.ensure_worker()?;
        if cancellation.is_cancelled() {
            return Err(WorkerError::Cancelled);
        }
        let remaining = deadline.remaining()?;
        let worker = self.worker.as_mut().expect("worker ensured");
        match worker.request(req, remaining, cancellation) {
            Ok(response) => Ok(response),
            Err(err) => {
                // Any transport failure recycles ONLY the child worker; the
                // Companion's approval/deny-latch/App-Job state is untouched.
                self.recycle_worker();
                Err(err)
            }
        }
    }

    /// Capture the desktop subtree, killing + rebuilding the worker on timeout,
    /// exit or protocol corruption and returning a stable error instead of ever
    /// blocking the Companion.
    pub fn capture(
        &mut self,
        target: &UiaSessionTarget,
        deadline: Duration,
    ) -> Result<UiaSource, UiaError> {
        let cancellation = self.cancellation.checkpoint();
        let deadline = RequestDeadline::after(deadline);
        self.capture_until(target, &deadline, &cancellation)
    }

    pub fn capture_until(
        &mut self,
        target: &UiaSessionTarget,
        deadline: &RequestDeadline,
        cancellation: &WorkerCancellationCheckpoint,
    ) -> Result<UiaSource, UiaError> {
        let req = WorkerRequest::Capture {
            target: target.clone(),
        };
        match self.dispatch_until(&req, deadline, cancellation) {
            Ok(WorkerResponse::Captured { source }) => Ok(source),
            Ok(WorkerResponse::Error { message }) => Err(UiaError::Reported(message)),
            Ok(_) => {
                self.recycle_worker();
                Err(UiaError::ProtocolCorruption)
            }
            Err(WorkerError::Timeout) => Err(UiaError::TargetUnresponsive),
            Err(WorkerError::Cancelled) => Err(UiaError::EmergencyStopped),
            Err(WorkerError::Closed) | Err(WorkerError::Corrupt) => {
                Err(UiaError::TargetUnresponsive)
            }
            Err(WorkerError::Spawn) => Err(UiaError::WorkerUnavailable),
        }
    }

    /// Execute a resolved desktop action. A timeout is deliberately mapped to
    /// [`UiaError::ActionOutcomeUnknown`] — the side effect may already have
    /// happened, so the caller must never replay it automatically — and the
    /// worker is rebuilt for the next request.
    pub fn execute(
        &mut self,
        target: &UiaSessionTarget,
        action: &ResolvedDesktopAction,
        value: Option<&DesktopPlaintextValue>,
        deadline: Duration,
    ) -> Result<ActionOutcomeReport, UiaError> {
        let cancellation = self.cancellation.checkpoint();
        self.execute_with_cancellation(target, action, value, deadline, &cancellation)
    }

    pub fn execute_with_cancellation(
        &mut self,
        target: &UiaSessionTarget,
        action: &ResolvedDesktopAction,
        value: Option<&DesktopPlaintextValue>,
        deadline: Duration,
        cancellation: &WorkerCancellationCheckpoint,
    ) -> Result<ActionOutcomeReport, UiaError> {
        let deadline = RequestDeadline::after(deadline);
        self.execute_until(target, action, value, &deadline, cancellation)
    }

    pub fn execute_until(
        &mut self,
        target: &UiaSessionTarget,
        action: &ResolvedDesktopAction,
        value: Option<&DesktopPlaintextValue>,
        deadline: &RequestDeadline,
        cancellation: &WorkerCancellationCheckpoint,
    ) -> Result<ActionOutcomeReport, UiaError> {
        let mut req = WorkerRequest::Execute {
            target: target.clone(),
            action: action.clone(),
            value: value.cloned(),
        };
        if let Some(fault) = self.diagnostic_next_action_fault.take() {
            let result = self.dispatch_diagnostic_action_fault(fault, deadline, cancellation);
            clear_request_plaintext(&mut req);
            return result;
        }
        let result = match self.dispatch_until(&req, deadline, cancellation) {
            Ok(WorkerResponse::Executed { outcome }) => Ok(outcome),
            Ok(WorkerResponse::Error { message }) => Err(UiaError::Reported(message)),
            Ok(_) => {
                self.recycle_worker();
                Err(UiaError::ProtocolCorruption)
            }
            Err(WorkerError::Timeout) => Err(UiaError::ActionOutcomeUnknown),
            Err(WorkerError::Cancelled) => Err(UiaError::EmergencyStopped),
            Err(WorkerError::Closed) | Err(WorkerError::Corrupt) => {
                Err(UiaError::ActionOutcomeUnknown)
            }
            Err(WorkerError::Spawn) => Err(UiaError::WorkerUnavailable),
        };
        clear_request_plaintext(&mut req);
        result
    }

    fn dispatch_diagnostic_action_fault(
        &mut self,
        fault: DiagnosticWorkerFault,
        deadline: &RequestDeadline,
        cancellation: &WorkerCancellationCheckpoint,
    ) -> Result<ActionOutcomeReport, UiaError> {
        if self.ensure_worker().is_err() {
            return Err(UiaError::WorkerUnavailable);
        }
        match fault {
            DiagnosticWorkerFault::TimeoutNextAction => {
                self.recycle_worker();
                Err(UiaError::ActionOutcomeUnknown)
            }
            DiagnosticWorkerFault::BlockNextActionUntilCancelled => loop {
                if cancellation.is_cancelled() {
                    self.recycle_worker();
                    return Err(UiaError::EmergencyStopped);
                }
                if deadline.remaining().is_err() {
                    self.recycle_worker();
                    return Err(UiaError::ActionOutcomeUnknown);
                }
                std::thread::sleep(Duration::from_millis(10));
            },
        }
    }
}

fn clear_request_plaintext(req: &mut WorkerRequest) {
    if let WorkerRequest::Execute {
        value: Some(value), ..
    } = req
    {
        value.plaintext.clear();
    }
}

#[cfg(windows)]
mod native_child {
    use std::io::{Read, Write};
    use std::os::windows::io::AsRawHandle;
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::{
        WorkerCancellationCheckpoint, WorkerError, WorkerHandle, WorkerRequest, WorkerResponse,
        WorkerSpawner,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    #[derive(Debug, Default)]
    pub struct NativeUiaWorkerSpawner {
        executable: Option<std::path::PathBuf>,
    }

    impl NativeUiaWorkerSpawner {
        pub fn new() -> Self {
            Self { executable: None }
        }

        pub fn with_executable(executable: impl Into<std::path::PathBuf>) -> Self {
            Self {
                executable: Some(executable.into()),
            }
        }
    }

    impl WorkerSpawner for NativeUiaWorkerSpawner {
        type Handle = NativeUiaWorkerHandle;

        fn spawn(&mut self) -> Result<Self::Handle, WorkerError> {
            let executable = match &self.executable {
                Some(path) => path.clone(),
                None => std::env::current_exe().map_err(|_| WorkerError::Spawn)?,
            };
            let mut child = Command::new(executable)
                .arg("--uia-worker")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| WorkerError::Spawn)?;

            let stdin = match child.stdin.take() {
                Some(stdin) => stdin,
                None => {
                    kill_and_wait_child(&mut child);
                    return Err(WorkerError::Spawn);
                }
            };
            let stdout = match child.stdout.take() {
                Some(stdout) => stdout,
                None => {
                    kill_and_wait_child(&mut child);
                    return Err(WorkerError::Spawn);
                }
            };
            let job = match WorkerJob::create() {
                Ok(job) => job,
                Err(error) => {
                    kill_and_wait_child(&mut child);
                    return Err(error);
                }
            };
            if let Err(error) = job.assign_child(&child) {
                job.terminate();
                kill_and_wait_child(&mut child);
                return Err(error);
            }
            Ok(NativeUiaWorkerHandle {
                child,
                stdin,
                stdout: Arc::new(Mutex::new(stdout)),
                job,
                alive: true,
            })
        }
    }

    pub struct NativeUiaWorkerHandle {
        child: Child,
        stdin: ChildStdin,
        stdout: Arc<Mutex<ChildStdout>>,
        job: WorkerJob,
        alive: bool,
    }

    // The worker process/job handles are owned behind the daemon supervisor
    // mutex. The only cross-thread cancellation path is the atomic cancellation
    // token; native handle mutation still happens through the supervisor owner.
    unsafe impl Send for NativeUiaWorkerHandle {}

    impl WorkerHandle for NativeUiaWorkerHandle {
        fn request(
            &mut self,
            req: &WorkerRequest,
            deadline: Duration,
            cancellation: &WorkerCancellationCheckpoint,
        ) -> Result<WorkerResponse, WorkerError> {
            let started_at = Instant::now();
            if cancellation.is_cancelled() {
                return Err(WorkerError::Cancelled);
            }
            if started_at.elapsed() >= deadline {
                return Err(WorkerError::Timeout);
            }
            let body = serde_json::to_vec(req).map_err(|_| WorkerError::Corrupt)?;
            if cancellation.is_cancelled() {
                return Err(WorkerError::Cancelled);
            }
            if started_at.elapsed() >= deadline {
                return Err(WorkerError::Timeout);
            }
            crate::ipc::server::write_frame(
                &mut self.stdin,
                &body,
                &crate::ipc::server::FrameLimits::default(),
            )
            .map_err(|_| {
                self.alive = false;
                WorkerError::Closed
            })?;
            self.stdin.flush().map_err(|_| {
                self.alive = false;
                WorkerError::Closed
            })?;

            let stdout = Arc::clone(&self.stdout);
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let result = stdout
                    .lock()
                    .map_err(|_| WorkerError::Corrupt)
                    .and_then(|mut out| read_worker_response(&mut *out));
                let _ = tx.send(result);
            });

            loop {
                if cancellation.is_cancelled() {
                    self.kill();
                    return Err(WorkerError::Cancelled);
                }
                let elapsed = started_at.elapsed();
                if elapsed >= deadline {
                    self.kill();
                    return Err(WorkerError::Timeout);
                }
                let remaining = deadline.saturating_sub(elapsed);
                let wait_for = remaining.min(Duration::from_millis(25));
                match rx.recv_timeout(wait_for) {
                    Ok(Ok(response)) => {
                        if cancellation.is_cancelled() {
                            self.kill();
                            return Err(WorkerError::Cancelled);
                        }
                        return Ok(response);
                    }
                    Ok(Err(err)) => {
                        self.alive = false;
                        return Err(err);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        self.alive = false;
                        return Err(WorkerError::Closed);
                    }
                }
            }
        }

        fn kill(&mut self) {
            self.alive = false;
            self.job.terminate();
            let _ = self.child.kill();
            let _ = self.child.wait();
        }

        fn is_alive(&self) -> bool {
            self.alive
        }
    }

    fn kill_and_wait_child(child: &mut Child) {
        let _ = child.kill();
        let _ = child.wait();
    }

    fn read_worker_response<R: Read>(reader: &mut R) -> Result<WorkerResponse, WorkerError> {
        let body =
            crate::ipc::server::read_frame(reader, &crate::ipc::server::FrameLimits::default())
                .map_err(|error| match error {
                    crate::ipc::server::FrameError::Truncated
                    | crate::ipc::server::FrameError::Io => WorkerError::Closed,
                    _ => WorkerError::Corrupt,
                })?;
        serde_json::from_slice(&body).map_err(|_| WorkerError::Corrupt)
    }

    struct WorkerJob {
        handle: HANDLE,
    }

    unsafe impl Send for WorkerJob {}

    impl WorkerJob {
        fn create() -> Result<Self, WorkerError> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err(WorkerError::Spawn);
            }
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                unsafe {
                    CloseHandle(handle);
                }
                return Err(WorkerError::Spawn);
            }
            Ok(Self { handle })
        }

        fn assign_child(&self, child: &Child) -> Result<(), WorkerError> {
            let ok = unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle()) };
            if ok == 0 {
                Err(WorkerError::Spawn)
            } else {
                Ok(())
            }
        }

        fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.handle, 1);
            }
        }
    }

    impl Drop for WorkerJob {
        fn drop(&mut self) {
            if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(self.handle);
                }
            }
        }
    }
}

#[cfg(windows)]
pub use native_child::NativeUiaWorkerSpawner;
