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

use std::time::Duration;

use crate::ipc::dto::{DesktopPlaintextValue, ResolvedDesktopAction};
use crate::uia::protocol::{
    ActionOutcomeReport, UiaError, UiaSource, WorkerRequest, WorkerResponse,
};

/// A transport failure while talking to a worker child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerError {
    /// The worker did not respond before the monotonic deadline (a hung COM call).
    Timeout,
    /// The worker process exited / the channel closed.
    Closed,
    /// The worker produced an oversized or malformed frame.
    Corrupt,
    /// A replacement worker could not be spawned.
    Spawn,
}

/// A live handle to one worker child.
pub trait WorkerHandle {
    /// Send `req` and block until a response or the monotonic `deadline` elapses.
    fn request(
        &mut self,
        req: &WorkerRequest,
        deadline: Duration,
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
pub struct UiaWorkerSupervisor<S: WorkerSpawner> {
    spawner: S,
    worker: Option<S::Handle>,
    restarts: u32,
    spawns: u32,
}

impl<S: WorkerSpawner> UiaWorkerSupervisor<S> {
    pub fn new(spawner: S) -> Self {
        Self {
            spawner,
            worker: None,
            restarts: 0,
            spawns: 0,
        }
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

    fn dispatch(
        &mut self,
        req: &WorkerRequest,
        deadline: Duration,
    ) -> Result<WorkerResponse, WorkerError> {
        self.ensure_worker()?;
        let worker = self.worker.as_mut().expect("worker ensured");
        match worker.request(req, deadline) {
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
    pub fn capture(&mut self, session_id: &str, deadline: Duration) -> Result<UiaSource, UiaError> {
        let req = WorkerRequest::Capture {
            session_id: session_id.to_string(),
        };
        match self.dispatch(&req, deadline) {
            Ok(WorkerResponse::Captured { source }) => Ok(source),
            Ok(WorkerResponse::Error { message }) => Err(UiaError::Reported(message)),
            Ok(_) => {
                self.recycle_worker();
                Err(UiaError::ProtocolCorruption)
            }
            Err(WorkerError::Timeout) => Err(UiaError::TargetUnresponsive),
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
        session_id: &str,
        action: &ResolvedDesktopAction,
        value: Option<DesktopPlaintextValue>,
        deadline: Duration,
    ) -> Result<ActionOutcomeReport, UiaError> {
        let req = WorkerRequest::Execute {
            session_id: session_id.to_string(),
            action: action.clone(),
            value,
        };
        match self.dispatch(&req, deadline) {
            Ok(WorkerResponse::Executed { outcome }) => Ok(outcome),
            Ok(WorkerResponse::Error { message }) => Err(UiaError::Reported(message)),
            Ok(_) => {
                self.recycle_worker();
                Err(UiaError::ProtocolCorruption)
            }
            Err(WorkerError::Timeout) => Err(UiaError::ActionOutcomeUnknown),
            Err(WorkerError::Closed) | Err(WorkerError::Corrupt) => {
                Err(UiaError::ActionOutcomeUnknown)
            }
            Err(WorkerError::Spawn) => Err(UiaError::WorkerUnavailable),
        }
    }
}

#[cfg(windows)]
mod native_child {
    use std::io::{Read, Write};
    use std::os::windows::io::AsRawHandle;
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    use super::{WorkerError, WorkerHandle, WorkerRequest, WorkerResponse, WorkerSpawner};
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

            let stdin = child.stdin.take().ok_or(WorkerError::Spawn)?;
            let stdout = child.stdout.take().ok_or(WorkerError::Spawn)?;
            let job = WorkerJob::create()?;
            job.assign_child(&child)?;
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

    impl WorkerHandle for NativeUiaWorkerHandle {
        fn request(
            &mut self,
            req: &WorkerRequest,
            deadline: Duration,
        ) -> Result<WorkerResponse, WorkerError> {
            let body = serde_json::to_vec(req).map_err(|_| WorkerError::Corrupt)?;
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

            match rx.recv_timeout(deadline) {
                Ok(Ok(response)) => Ok(response),
                Ok(Err(err)) => {
                    self.alive = false;
                    Err(err)
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.kill();
                    Err(WorkerError::Timeout)
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.alive = false;
                    Err(WorkerError::Closed)
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
