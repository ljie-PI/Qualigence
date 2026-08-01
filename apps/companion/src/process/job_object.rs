//! Windows Job Object process-lifecycle host (specialist finding W-02).
//!
//! A desktop target must be managed as a *securable unit*, never by broad image
//! name or a reusable PID: the Companion creates the process suspended, creates a
//! kill-on-close Job Object, assigns the process to it, then resumes it. Shutdown
//! and reset act only on verified Job members. If a packaged / breakaway-protected
//! process cannot join the Job, the launch fails as `AppLifecycleUnsupported` —
//! it NEVER degrades to a name-based kill that could hit an unrelated app.
//!
//! The Win32 FFI (`CreateProcessW` + `CREATE_SUSPENDED`, `CreateJobObjectW`,
//! `AssignProcessToJobObject`, `ResumeThread`, `TerminateJobObject`) is the only
//! faked boundary here: it is isolated behind [`DesktopProcessHost`]. A real
//! `#[cfg(windows)]` host is reserved for Windows CI; the portable
//! [`FakeDesktopProcessHost`] lets the cross-platform test-suite prove the
//! ordering and membership policy without any OS call.

use std::collections::HashMap;

/// Stable lifecycle errors surfaced to the Runner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleError {
    /// The process could not be created or its image did not match the target.
    AppLaunchFailed,
    /// The process cannot be managed as a Job (packaged / breakaway-protected);
    /// the target needs a human — we never fall back to a name-based kill.
    AppLifecycleUnsupported,
    /// The reset helper failed or exceeded its declared timeout.
    AppResetFailed,
    /// A child process outside the declared allowlist appeared in the Job.
    UnexpectedChild(String),
    /// No live session is tracked for the given id.
    SessionNotFound,
    /// The underlying host reported a failure.
    HostError,
}

/// A launched OS process as reported by the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostProcess {
    pub pid: u32,
    /// The process creation time; combined with the PID it uniquely identifies a
    /// process instance so a later PID reuse can never be mistaken for a member.
    pub creation_time: String,
    pub image_name: String,
    pub root_window_handle: String,
}

/// An opaque native Job handle. Its `native_id` is never exposed outside the
/// Companion; callers only ever see the session's generated `process_group_id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostJob {
    pub native_id: u64,
}

/// A resolved launch specification (the Rust-native projection of an `AppTarget`
/// the Companion has already canonicalised).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppLaunchSpec {
    pub executable: String,
    pub args: Vec<String>,
    pub working_directory: Option<String>,
    pub expected_image_name: String,
    pub allowed_child_image_names: Vec<String>,
    /// Set by the host allowlist when the target is a packaged / protected app
    /// that cannot join a Job without breakaway.
    pub packaged_cannot_join_job: bool,
}

/// A resolved reset specification: explicit argv under a bounded timeout, run in
/// its own controlled Job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetSpec {
    pub command: String,
    pub args: Vec<String>,
    pub timeout_ms: u64,
}

/// The isolated Win32 process/Job FFI seam.
pub trait DesktopProcessHost {
    /// Create the target process in a SUSPENDED state (`CREATE_SUSPENDED`).
    fn create_suspended(&mut self, spec: &AppLaunchSpec) -> Result<HostProcess, LifecycleError>;
    /// Create a fresh Job Object.
    fn create_job(&mut self) -> Result<HostJob, LifecycleError>;
    /// Configure `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` on the Job.
    fn set_kill_on_close(&mut self, job: HostJob) -> Result<(), LifecycleError>;
    /// Assign a process to the Job. Returns `AppLifecycleUnsupported` if the
    /// process cannot join (packaged / breakaway-protected).
    fn assign_to_job(&mut self, job: HostJob, pid: u32) -> Result<(), LifecycleError>;
    /// Resume the process's main thread (`ResumeThread`).
    fn resume(&mut self, pid: u32) -> Result<(), LifecycleError>;
    /// The children currently observed under `pid` (for allowlist enforcement).
    fn list_children(&self, pid: u32) -> Vec<HostProcess>;
    /// Terminate every process in the Job atomically (`TerminateJobObject`).
    fn terminate_job(&mut self, job: HostJob) -> Result<(), LifecycleError>;
    /// Run the reset helper in its own controlled Job with the declared argv.
    fn run_reset(&mut self, spec: &ResetSpec) -> Result<(), LifecycleError>;
    /// Whether the exact process instance (pid + creation time) is still alive.
    fn is_alive(&self, pid: u32, creation_time: &str) -> bool;
}

/// A portable, deterministic host used by the cross-platform test-suite and by a
/// Linux dev build. It records the ordered sequence of operations so tests can
/// assert create-suspended → create-job → kill-on-close → assign → resume, and it
/// only ever terminates processes that are genuine Job members — an unrelated
/// same-name process or a reused PID registered outside the Job is untouched.
pub struct FakeDesktopProcessHost {
    next_pid: u32,
    next_job: u64,
    creation_seq: u64,
    /// pid → (process, owning job id if a member).
    processes: HashMap<u32, (HostProcess, Option<u64>)>,
    /// job id → kill-on-close configured.
    jobs: HashMap<u64, bool>,
    /// Observed children keyed by parent pid.
    children: HashMap<u32, Vec<HostProcess>>,
    /// Ordered operation log for assertions.
    pub ops: Vec<String>,
    /// The last reset spec the host was asked to run.
    pub last_reset: Option<ResetSpec>,
}

impl Default for FakeDesktopProcessHost {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeDesktopProcessHost {
    pub fn new() -> Self {
        Self {
            next_pid: 1000,
            next_job: 1,
            creation_seq: 0,
            processes: HashMap::new(),
            jobs: HashMap::new(),
            children: HashMap::new(),
            ops: Vec::new(),
            last_reset: None,
        }
    }

    /// Register a pre-existing, unrelated process (e.g. a same-image app or a
    /// reused PID) that is NOT a member of any Companion Job.
    pub fn register_unrelated(&mut self, process: HostProcess) {
        self.processes.insert(process.pid, (process, None));
    }

    /// Queue observed children for a parent pid (used to exercise the allowlist).
    pub fn set_children(&mut self, parent_pid: u32, children: Vec<HostProcess>) {
        self.children.insert(parent_pid, children);
    }

    /// Whether a pid is currently tracked as alive by the host.
    pub fn is_running(&self, pid: u32) -> bool {
        self.processes.contains_key(&pid)
    }

    fn alloc_pid(&mut self) -> u32 {
        let pid = self.next_pid;
        self.next_pid += 1;
        pid
    }
}

impl DesktopProcessHost for FakeDesktopProcessHost {
    fn create_suspended(&mut self, spec: &AppLaunchSpec) -> Result<HostProcess, LifecycleError> {
        let pid = self.alloc_pid();
        self.creation_seq += 1;
        let process = HostProcess {
            pid,
            creation_time: format!("2026-08-02T00:00:{:02}.000Z", self.creation_seq),
            image_name: spec.expected_image_name.clone(),
            root_window_handle: format!("0x{:08X}", 0x2000 + pid),
        };
        self.processes.insert(pid, (process.clone(), None));
        self.ops.push(format!("create_suspended:{pid}"));
        Ok(process)
    }

    fn create_job(&mut self) -> Result<HostJob, LifecycleError> {
        let native_id = self.next_job;
        self.next_job += 1;
        self.jobs.insert(native_id, false);
        self.ops.push(format!("create_job:{native_id}"));
        Ok(HostJob { native_id })
    }

    fn set_kill_on_close(&mut self, job: HostJob) -> Result<(), LifecycleError> {
        self.jobs.insert(job.native_id, true);
        self.ops.push(format!("kill_on_close:{}", job.native_id));
        Ok(())
    }

    fn assign_to_job(&mut self, job: HostJob, pid: u32) -> Result<(), LifecycleError> {
        let (_, owner) = self
            .processes
            .get_mut(&pid)
            .ok_or(LifecycleError::HostError)?;
        *owner = Some(job.native_id);
        self.ops.push(format!("assign:{pid}->{}", job.native_id));
        Ok(())
    }

    fn resume(&mut self, pid: u32) -> Result<(), LifecycleError> {
        if !self.processes.contains_key(&pid) {
            return Err(LifecycleError::HostError);
        }
        self.ops.push(format!("resume:{pid}"));
        Ok(())
    }

    fn list_children(&self, pid: u32) -> Vec<HostProcess> {
        self.children.get(&pid).cloned().unwrap_or_default()
    }

    fn terminate_job(&mut self, job: HostJob) -> Result<(), LifecycleError> {
        // Only genuine members of THIS job are terminated; unrelated processes
        // and reused PIDs (owner != this job) survive.
        let victims: Vec<u32> = self
            .processes
            .iter()
            .filter_map(|(pid, (_, owner))| {
                if *owner == Some(job.native_id) {
                    Some(*pid)
                } else {
                    None
                }
            })
            .collect();
        for pid in &victims {
            self.processes.remove(pid);
        }
        self.jobs.remove(&job.native_id);
        self.ops.push(format!("terminate_job:{}", job.native_id));
        Ok(())
    }

    fn run_reset(&mut self, spec: &ResetSpec) -> Result<(), LifecycleError> {
        self.last_reset = Some(spec.clone());
        self.ops.push(format!("reset:{}", spec.command));
        Ok(())
    }

    fn is_alive(&self, pid: u32, creation_time: &str) -> bool {
        self.processes
            .get(&pid)
            .map(|(p, _)| p.creation_time == creation_time)
            .unwrap_or(false)
    }
}

/// The real Windows Job Object host. This is the isolated Win32 FFI seam,
/// compiled only on Windows CI. It is where `CreateProcessW`/`CreateJobObjectW`/
/// `AssignProcessToJobObject`/`ResumeThread`/`TerminateJobObject` are wired; the
/// portable [`FakeDesktopProcessHost`] is what the logic tests exercise.
#[cfg(windows)]
pub struct WindowsDesktopProcessHost;

#[cfg(windows)]
impl DesktopProcessHost for WindowsDesktopProcessHost {
    fn create_suspended(&mut self, _spec: &AppLaunchSpec) -> Result<HostProcess, LifecycleError> {
        Err(LifecycleError::HostError)
    }
    fn create_job(&mut self) -> Result<HostJob, LifecycleError> {
        Err(LifecycleError::HostError)
    }
    fn set_kill_on_close(&mut self, _job: HostJob) -> Result<(), LifecycleError> {
        Err(LifecycleError::HostError)
    }
    fn assign_to_job(&mut self, _job: HostJob, _pid: u32) -> Result<(), LifecycleError> {
        Err(LifecycleError::AppLifecycleUnsupported)
    }
    fn resume(&mut self, _pid: u32) -> Result<(), LifecycleError> {
        Err(LifecycleError::HostError)
    }
    fn list_children(&self, _pid: u32) -> Vec<HostProcess> {
        Vec::new()
    }
    fn terminate_job(&mut self, _job: HostJob) -> Result<(), LifecycleError> {
        Err(LifecycleError::HostError)
    }
    fn run_reset(&mut self, _spec: &ResetSpec) -> Result<(), LifecycleError> {
        Err(LifecycleError::HostError)
    }
    fn is_alive(&self, _pid: u32, _creation_time: &str) -> bool {
        false
    }
}
