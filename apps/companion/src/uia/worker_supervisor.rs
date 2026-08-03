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

use crate::ipc::dto::ResolvedDesktopAction;
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
        deadline: Duration,
    ) -> Result<ActionOutcomeReport, UiaError> {
        let req = WorkerRequest::Execute {
            session_id: session_id.to_string(),
            action: action.clone(),
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
