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

use serde::{Deserialize, Serialize};

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

/// Public AppTarget window selector fields carried into native window binding.
///
/// `title_pattern` is matched as a literal substring against the current window
/// title/name; `automation_id` is matched exactly against UIA AutomationId. The
/// process host can enforce the title predicate while choosing a top-level HWND,
/// and the UIA worker enforces both fields before capture/action root binding.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWindowSelector {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
}

impl AppWindowSelector {
    pub fn is_empty(&self) -> bool {
        self.title_pattern.is_none() && self.automation_id.is_none()
    }

    pub fn matches(&self, title: Option<&str>, automation_id: Option<&str>) -> bool {
        if let Some(pattern) = self.title_pattern.as_deref() {
            if !title.map(|value| value.contains(pattern)).unwrap_or(false) {
                return false;
            }
        }
        if let Some(expected) = self.automation_id.as_deref() {
            if automation_id != Some(expected) {
                return false;
            }
        }
        true
    }
}

/// A visible top-level window candidate for a process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostWindow {
    pub handle: String,
    pub title: Option<String>,
    pub automation_id: Option<String>,
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
    pub window_selector: AppWindowSelector,
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
    /// Terminate a not-yet-contained suspended process during partial startup
    /// cleanup. This is used only before resume, so no uncontained code has run.
    fn terminate_process(&mut self, pid: u32) -> Result<(), LifecycleError>;
    /// Run the reset helper in its own controlled Job with the declared argv.
    fn run_reset(&mut self, spec: &ResetSpec) -> Result<(), LifecycleError>;
    /// Whether the exact process instance (pid + creation time) is still alive.
    fn is_alive(&self, pid: u32, creation_time: &str) -> bool;
    /// Return a visible root window handle for the process after resume, if one
    /// is available before the caller's launch budget expires.
    fn root_window_handle(&self, pid: u32) -> Option<String>;
    /// Return a visible root window handle selected with the host-observable
    /// AppTarget window fields. The UIA worker revalidates the complete selector
    /// (including AutomationId) before capture/action root binding.
    fn root_window_handle_for_selector(
        &self,
        pid: u32,
        selector: &AppWindowSelector,
    ) -> Option<String> {
        if selector.is_empty() {
            self.root_window_handle(pid)
        } else {
            None
        }
    }
    /// Verify the exact process instance is still a member of the tracked Job.
    fn verify_process_in_job(
        &self,
        job: HostJob,
        pid: u32,
        creation_time: &str,
        expected_image_name: &str,
    ) -> bool;
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
    /// Visible top-level windows keyed by owning pid, in enumeration order.
    root_windows: HashMap<u32, Vec<HostWindow>>,
    next_root_windows: Option<Vec<HostWindow>>,
    /// Ordered operation log for assertions.
    pub ops: Vec<String>,
    /// The last reset spec the host was asked to run.
    pub last_reset: Option<ResetSpec>,
    next_terminate_job_error: Option<LifecycleError>,
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
            root_windows: HashMap::new(),
            next_root_windows: None,
            ops: Vec::new(),
            last_reset: None,
            next_terminate_job_error: None,
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

    /// Replace the visible top-level window enumeration for a process.
    pub fn set_root_windows(&mut self, pid: u32, windows: Vec<HostWindow>) {
        self.root_windows.insert(pid, windows);
    }

    /// Replace the visible top-level window enumeration for the next process the
    /// fake host creates. This lets tests model a splash/modal enumerating before
    /// the intended target window without relying on native UI.
    pub fn set_next_root_windows(&mut self, windows: Vec<HostWindow>) {
        self.next_root_windows = Some(windows);
    }

    /// Make the next Job termination fail without removing Job/process state.
    pub fn fail_next_terminate_job(&mut self, error: LifecycleError) {
        self.next_terminate_job_error = Some(error);
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
        let default_window = HostWindow {
            handle: process.root_window_handle.clone(),
            title: Some("Reference App".into()),
            automation_id: Some("MainWindow".into()),
        };
        self.root_windows.insert(
            pid,
            self.next_root_windows
                .take()
                .unwrap_or_else(|| vec![default_window]),
        );
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
        self.ops.push(format!("terminate_job:{}", job.native_id));
        if let Some(error) = self.next_terminate_job_error.take() {
            return Err(error);
        }
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
            self.root_windows.remove(pid);
        }
        self.jobs.remove(&job.native_id);
        Ok(())
    }

    fn terminate_process(&mut self, pid: u32) -> Result<(), LifecycleError> {
        self.processes.remove(&pid);
        self.root_windows.remove(&pid);
        self.ops.push(format!("terminate_process:{pid}"));
        Ok(())
    }

    fn run_reset(&mut self, spec: &ResetSpec) -> Result<(), LifecycleError> {
        self.last_reset = Some(spec.clone());
        self.ops.push(format!("reset:{}", spec.command));
        if let Some(error) = self.next_terminate_job_error.take() {
            return Err(error);
        }
        Ok(())
    }

    fn is_alive(&self, pid: u32, creation_time: &str) -> bool {
        self.processes
            .get(&pid)
            .map(|(p, _)| p.creation_time == creation_time)
            .unwrap_or(false)
    }

    fn root_window_handle(&self, pid: u32) -> Option<String> {
        self.root_windows
            .get(&pid)
            .and_then(|windows| windows.first())
            .map(|window| window.handle.clone())
            .or_else(|| {
                self.processes
                    .get(&pid)
                    .map(|(process, _)| process.root_window_handle.clone())
            })
    }

    fn root_window_handle_for_selector(
        &self,
        pid: u32,
        selector: &AppWindowSelector,
    ) -> Option<String> {
        if selector.is_empty() {
            return self.root_window_handle(pid);
        }
        self.root_windows.get(&pid).and_then(|windows| {
            windows
                .iter()
                .find(|window| {
                    selector.matches(window.title.as_deref(), window.automation_id.as_deref())
                })
                .map(|window| window.handle.clone())
        })
    }

    fn verify_process_in_job(
        &self,
        job: HostJob,
        pid: u32,
        creation_time: &str,
        expected_image_name: &str,
    ) -> bool {
        self.processes
            .get(&pid)
            .map(|(p, owner)| {
                *owner == Some(job.native_id)
                    && p.creation_time == creation_time
                    && p.image_name.eq_ignore_ascii_case(expected_image_name)
            })
            .unwrap_or(false)
    }
}

#[cfg(windows)]
mod windows_host {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::iter::once;
    use std::mem::{size_of, zeroed};
    use std::path::Path;
    use std::ptr::null;

    use super::{
        AppLaunchSpec, AppWindowSelector, DesktopProcessHost, HostJob, HostProcess, LifecycleError,
        ResetSpec,
    };
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, FILETIME, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
        JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, GetExitCodeProcess, GetProcessTimes, OpenProcess,
        QueryFullProcessImageNameW, ResumeThread, TerminateProcess, WaitForSingleObject,
        CREATE_SUSPENDED, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, STARTUPINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    #[derive(Debug)]
    struct OwnedHandle(HANDLE);

    impl OwnedHandle {
        fn new(handle: HANDLE) -> Result<Self, LifecycleError> {
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                Err(LifecycleError::HostError)
            } else {
                Ok(Self(handle))
            }
        }

        fn raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    #[derive(Debug)]
    struct TrackedProcess {
        process: OwnedHandle,
        thread: Option<OwnedHandle>,
        creation_time: String,
        image_name: String,
        job_id: Option<u64>,
    }

    /// Native Windows Job Object host. It never exposes native handles outside
    /// this module: `HostJob.native_id` is only a process-local lookup key.
    #[derive(Debug, Default)]
    pub struct WindowsDesktopProcessHost {
        next_job_id: u64,
        jobs: HashMap<u64, OwnedHandle>,
        processes: HashMap<u32, TrackedProcess>,
    }

    impl WindowsDesktopProcessHost {
        pub fn new() -> Self {
            Self {
                next_job_id: 1,
                jobs: HashMap::new(),
                processes: HashMap::new(),
            }
        }
    }

    impl DesktopProcessHost for WindowsDesktopProcessHost {
        fn create_suspended(
            &mut self,
            spec: &AppLaunchSpec,
        ) -> Result<HostProcess, LifecycleError> {
            if spec.packaged_cannot_join_job {
                return Err(LifecycleError::AppLifecycleUnsupported);
            }

            let application = wide(&spec.executable);
            let mut command_line = wide(&command_line(&spec.executable, &spec.args));
            let working_directory = spec.working_directory.as_ref().map(|cwd| wide(cwd));
            let startup = STARTUPINFOW {
                cb: size_of::<STARTUPINFOW>() as u32,
                ..unsafe { zeroed() }
            };
            let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
            let ok = unsafe {
                CreateProcessW(
                    application.as_ptr(),
                    command_line.as_mut_ptr(),
                    null(),
                    null(),
                    0,
                    CREATE_SUSPENDED,
                    null(),
                    working_directory
                        .as_ref()
                        .map(|cwd| cwd.as_ptr())
                        .unwrap_or(null()),
                    &startup,
                    &mut process_info,
                )
            };
            if ok == 0 {
                return Err(LifecycleError::AppLaunchFailed);
            }

            let process = match OwnedHandle::new(process_info.hProcess) {
                Ok(process) => process,
                Err(error) => {
                    close_partial_process_handles(&process_info);
                    return Err(error);
                }
            };
            let thread = match OwnedHandle::new(process_info.hThread) {
                Ok(thread) => thread,
                Err(error) => {
                    terminate_and_wait(process.raw());
                    return Err(error);
                }
            };
            let image_path = match canonical_process_image_path(process.raw()) {
                Ok(image_path) => image_path,
                Err(error) => {
                    terminate_and_wait(process.raw());
                    return Err(error);
                }
            };
            let image_name = file_name(&image_path).unwrap_or_else(|| image_path.clone());
            if !image_name.eq_ignore_ascii_case(&spec.expected_image_name) {
                terminate_and_wait(process.raw());
                return Err(LifecycleError::AppLaunchFailed);
            }
            let creation_time = match process_creation_time(process.raw()) {
                Ok(creation_time) => creation_time,
                Err(error) => {
                    terminate_and_wait(process.raw());
                    return Err(error);
                }
            };
            let pid = process_info.dwProcessId;
            let root_window_handle = root_window_handle_for_pid(pid, &AppWindowSelector::default())
                .map(|hwnd| format!("0x{:X}", hwnd as usize))
                .unwrap_or_else(|| "0x0".to_string());
            self.processes.insert(
                pid,
                TrackedProcess {
                    process,
                    thread: Some(thread),
                    creation_time: creation_time.clone(),
                    image_name: image_name.clone(),
                    job_id: None,
                },
            );
            Ok(HostProcess {
                pid,
                creation_time,
                image_name,
                root_window_handle,
            })
        }

        fn create_job(&mut self) -> Result<HostJob, LifecycleError> {
            let handle = OwnedHandle::new(unsafe { CreateJobObjectW(null(), null()) })?;
            let id = self.next_job_id;
            self.next_job_id += 1;
            self.jobs.insert(id, handle);
            Ok(HostJob { native_id: id })
        }

        fn set_kill_on_close(&mut self, job: HostJob) -> Result<(), LifecycleError> {
            let handle = self
                .jobs
                .get(&job.native_id)
                .ok_or(LifecycleError::HostError)?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe {
                SetInformationJobObject(
                    handle.raw(),
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                Err(LifecycleError::HostError)
            } else {
                Ok(())
            }
        }

        fn assign_to_job(&mut self, job: HostJob, pid: u32) -> Result<(), LifecycleError> {
            let job_handle = self
                .jobs
                .get(&job.native_id)
                .ok_or(LifecycleError::HostError)?;
            let proc = self
                .processes
                .get_mut(&pid)
                .ok_or(LifecycleError::HostError)?;
            let ok = unsafe { AssignProcessToJobObject(job_handle.raw(), proc.process.raw()) };
            if ok == 0 {
                let code = unsafe { GetLastError() };
                // Protected, packaged or already-jobbed processes must not be
                // resumed through a breakaway/elevation fallback.
                return if code == windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED {
                    Err(LifecycleError::AppLifecycleUnsupported)
                } else {
                    Err(LifecycleError::HostError)
                };
            }
            proc.job_id = Some(job.native_id);
            Ok(())
        }

        fn resume(&mut self, pid: u32) -> Result<(), LifecycleError> {
            let proc = self
                .processes
                .get_mut(&pid)
                .ok_or(LifecycleError::HostError)?;
            let thread = proc.thread.take().ok_or(LifecycleError::HostError)?;
            let previous = unsafe { ResumeThread(thread.raw()) };
            if previous == u32::MAX {
                Err(LifecycleError::HostError)
            } else {
                Ok(())
            }
        }

        fn list_children(&self, pid: u32) -> Vec<HostProcess> {
            list_child_processes(pid)
        }

        fn terminate_job(&mut self, job: HostJob) -> Result<(), LifecycleError> {
            let handle = self
                .jobs
                .get(&job.native_id)
                .ok_or(LifecycleError::HostError)?;
            let ok = unsafe { TerminateJobObject(handle.raw(), 1) };
            if ok == 0 {
                return Err(LifecycleError::HostError);
            }
            self.jobs.remove(&job.native_id);
            self.processes
                .retain(|_, process| process.job_id != Some(job.native_id));
            Ok(())
        }

        fn terminate_process(&mut self, pid: u32) -> Result<(), LifecycleError> {
            if let Some(process) = self.processes.remove(&pid) {
                terminate_and_wait(process.process.raw());
            }
            Ok(())
        }

        fn run_reset(&mut self, spec: &ResetSpec) -> Result<(), LifecycleError> {
            let reset_launch = AppLaunchSpec {
                executable: spec.command.clone(),
                args: spec.args.clone(),
                working_directory: None,
                expected_image_name: file_name(&spec.command)
                    .unwrap_or_else(|| spec.command.clone()),
                allowed_child_image_names: Vec::new(),
                window_selector: AppWindowSelector::default(),
                packaged_cannot_join_job: false,
            };
            let process = self.create_suspended(&reset_launch)?;
            let job = match self.create_job() {
                Ok(job) => job,
                Err(error) => {
                    let _ = self.terminate_process(process.pid);
                    return Err(error);
                }
            };
            if let Err(error) = self.set_kill_on_close(job) {
                let _ = self.terminate_process(process.pid);
                let _ = self.terminate_job(job);
                return Err(error);
            }
            if let Err(error) = self.assign_to_job(job, process.pid) {
                let _ = self.terminate_process(process.pid);
                let _ = self.terminate_job(job);
                return Err(error);
            }
            if let Err(error) = self.resume(process.pid) {
                let _ = self.terminate_job(job);
                return Err(error);
            }
            let handle = self
                .processes
                .get(&process.pid)
                .ok_or(LifecycleError::HostError)?
                .process
                .raw();
            let wait = unsafe { WaitForSingleObject(handle, spec.timeout_ms as u32) };
            if wait == WAIT_OBJECT_0 {
                self.terminate_job(job)
            } else if wait == WAIT_TIMEOUT {
                let _ = self.terminate_job(job);
                Err(LifecycleError::AppResetFailed)
            } else {
                let _ = self.terminate_job(job);
                Err(LifecycleError::HostError)
            }
        }

        fn is_alive(&self, pid: u32, creation_time: &str) -> bool {
            self.processes
                .get(&pid)
                .map(|process| {
                    process.creation_time == creation_time
                        && process_exit_code(process.process.raw()) == Some(STILL_ACTIVE as u32)
                })
                .unwrap_or(false)
        }

        fn root_window_handle(&self, pid: u32) -> Option<String> {
            self.root_window_handle_for_selector(pid, &AppWindowSelector::default())
        }

        fn root_window_handle_for_selector(
            &self,
            pid: u32,
            selector: &AppWindowSelector,
        ) -> Option<String> {
            for _ in 0..200 {
                if let Some(hwnd) = root_window_handle_for_pid(pid, selector) {
                    return Some(format!("0x{:X}", hwnd as usize));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            None
        }

        fn verify_process_in_job(
            &self,
            job: HostJob,
            pid: u32,
            creation_time: &str,
            expected_image_name: &str,
        ) -> bool {
            let Some(job_handle) = self.jobs.get(&job.native_id) else {
                return false;
            };
            let Some(process) = self.processes.get(&pid) else {
                return false;
            };
            if process.creation_time != creation_time
                || !process.image_name.eq_ignore_ascii_case(expected_image_name)
            {
                return false;
            }
            let mut in_job = 0;
            let ok =
                unsafe { IsProcessInJob(process.process.raw(), job_handle.raw(), &mut in_job) };
            ok != 0 && in_job != 0
        }
    }

    fn process_exit_code(process: HANDLE) -> Option<u32> {
        let mut code = 0u32;
        let ok = unsafe { GetExitCodeProcess(process, &mut code) };
        if ok == 0 {
            None
        } else {
            Some(code)
        }
    }

    fn terminate_and_wait(process: HANDLE) {
        unsafe {
            TerminateProcess(process, 1);
            WaitForSingleObject(process, 5_000);
        }
    }

    fn close_partial_process_handles(info: &PROCESS_INFORMATION) {
        unsafe {
            if !info.hProcess.is_null() && info.hProcess != INVALID_HANDLE_VALUE {
                TerminateProcess(info.hProcess, 1);
                WaitForSingleObject(info.hProcess, 5_000);
                CloseHandle(info.hProcess);
            }
            if !info.hThread.is_null() && info.hThread != INVALID_HANDLE_VALUE {
                CloseHandle(info.hThread);
            }
        }
    }

    fn list_child_processes(parent_pid: u32) -> Vec<HostProcess> {
        let snapshot =
            match OwnedHandle::new(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) {
                Ok(snapshot) => snapshot,
                Err(_) => return Vec::new(),
            };
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..unsafe { zeroed() }
        };
        let mut children = Vec::new();
        let mut ok = unsafe { Process32FirstW(snapshot.raw(), &mut entry) };
        while ok != 0 {
            if entry.th32ParentProcessID == parent_pid {
                if let Some(child) = child_process_from_entry(&entry) {
                    children.push(child);
                }
            }
            ok = unsafe { Process32NextW(snapshot.raw(), &mut entry) };
        }
        children
    }

    fn child_process_from_entry(entry: &PROCESSENTRY32W) -> Option<HostProcess> {
        let process = OwnedHandle::new(unsafe {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID)
        })
        .ok()?;
        let image_path = canonical_process_image_path(process.raw()).ok();
        let image_name = image_path
            .as_deref()
            .and_then(file_name)
            .unwrap_or_else(|| exe_file_from_entry(entry));
        let creation_time =
            process_creation_time(process.raw()).unwrap_or_else(|_| "unknown".into());
        let root_window_handle =
            root_window_handle_for_pid(entry.th32ProcessID, &AppWindowSelector::default())
                .map(|hwnd| format!("0x{:X}", hwnd as usize))
                .unwrap_or_else(|| "0x0".to_string());
        Some(HostProcess {
            pid: entry.th32ProcessID,
            creation_time,
            image_name,
            root_window_handle,
        })
    }

    fn exe_file_from_entry(entry: &PROCESSENTRY32W) -> String {
        let end = entry
            .szExeFile
            .iter()
            .position(|ch| *ch == 0)
            .unwrap_or(entry.szExeFile.len());
        String::from_utf16_lossy(&entry.szExeFile[..end])
    }

    fn process_creation_time(process: HANDLE) -> Result<String, LifecycleError> {
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut kernel = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut user = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let ok =
            unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
        if ok == 0 {
            return Err(LifecycleError::HostError);
        }
        let ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
        Ok(format!("filetime:{ticks}"))
    }

    fn canonical_process_image_path(process: HANDLE) -> Result<String, LifecycleError> {
        let mut chars = 32768u32;
        let mut buffer = vec![0u16; chars as usize];
        let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut chars) };
        if ok == 0 {
            return Err(LifecycleError::HostError);
        }
        buffer.truncate(chars as usize);
        Ok(String::from_utf16_lossy(&buffer))
    }

    fn root_window_handle_for_pid(pid: u32, selector: &AppWindowSelector) -> Option<HANDLE> {
        #[repr(C)]
        struct Search<'a> {
            pid: u32,
            selector: &'a AppWindowSelector,
            hwnd: HANDLE,
        }
        unsafe extern "system" fn enum_proc(hwnd: HANDLE, lparam: isize) -> i32 {
            let search = &mut *(lparam as *mut Search<'_>);
            let mut window_pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut window_pid);
            if window_pid == search.pid
                && IsWindowVisible(hwnd) != 0
                && window_title_matches(hwnd, search.selector)
            {
                search.hwnd = hwnd;
                0
            } else {
                1
            }
        }
        let mut search = Search {
            pid,
            selector,
            hwnd: null_mut_handle(),
        };
        unsafe {
            EnumWindows(Some(enum_proc), &mut search as *mut _ as isize);
        }
        if search.hwnd.is_null() {
            None
        } else {
            Some(search.hwnd)
        }
    }

    fn window_title_matches(hwnd: HANDLE, selector: &AppWindowSelector) -> bool {
        let Some(pattern) = selector.title_pattern.as_deref() else {
            return true;
        };
        let title = window_title(hwnd);
        !title.is_empty() && title.contains(pattern)
    }

    fn window_title(hwnd: HANDLE) -> String {
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return String::new();
        }
        let mut buffer = vec![0u16; len as usize + 1];
        let copied = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if copied <= 0 {
            return String::new();
        }
        buffer.truncate(copied as usize);
        String::from_utf16_lossy(&buffer)
    }

    fn null_mut_handle() -> HANDLE {
        std::ptr::null_mut()
    }

    fn file_name(path: &str) -> Option<String> {
        Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
    }

    fn command_line(executable: &str, args: &[String]) -> String {
        std::iter::once(quote_arg(executable))
            .chain(args.iter().map(|arg| quote_arg(arg)))
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn quote_arg(arg: &str) -> String {
        if arg.is_empty() || arg.chars().any(|ch| ch.is_whitespace() || ch == '"') {
            let escaped = arg.replace('"', "\\\"");
            format!("\"{escaped}\"")
        } else {
            arg.to_string()
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(once(0)).collect()
    }
}

#[cfg(windows)]
pub use windows_host::WindowsDesktopProcessHost;
