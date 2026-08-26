//! App session lifecycle policy on top of the Job Object host.
//!
//! [`AppSessionManager`] owns the ordering and membership *policy* that keeps a
//! desktop target securable: it launches suspended, wraps the process in a
//! kill-on-close Job before resuming, tracks the exact (pid + creation time)
//! instance plus an opaque `process_group_id`, enforces the declared child
//! allowlist, and tears down / resets only verified Job members. None of this
//! logic touches Win32 directly — it drives a [`DesktopProcessHost`], so the
//! whole policy is exercised on Linux via [`super::job_object::FakeDesktopProcessHost`].

use std::collections::HashMap;

use crate::process::job_object::{
    AppLaunchSpec, AppWindowSelector, DesktopProcessHost, HostJob, LifecycleError, ResetSpec,
};
use crate::random::random_bytes;

/// A live, Job-managed desktop session.
#[derive(Debug, Clone)]
pub struct AppSessionState {
    pub session_id: String,
    /// Opaque, Companion-generated group id. NEVER the native Job id — callers
    /// cannot use it to address the OS Job directly.
    pub process_group_id: String,
    pub pid: u32,
    pub creation_time: String,
    pub image_name: String,
    pub root_window_handle: String,
    pub window_selector: AppWindowSelector,
    allowed_child_image_names: Vec<String>,
    job: HostJob,
}

impl AppSessionState {
    pub fn allowed_child_image_names(&self) -> &[String] {
        &self.allowed_child_image_names
    }
}

/// Tracks and manages every live app session.
pub struct AppSessionManager<H: DesktopProcessHost> {
    host: H,
    sessions: HashMap<String, AppSessionState>,
}

impl<H: DesktopProcessHost> AppSessionManager<H> {
    pub fn new(host: H) -> Self {
        Self {
            host,
            sessions: HashMap::new(),
        }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    pub fn session(&self, session_id: &str) -> Option<&AppSessionState> {
        self.sessions.get(session_id)
    }

    /// Return a session only after rechecking the tracked PID + creation time +
    /// image + Job membership. Capture/action callers use this so UIA authority
    /// cannot survive PID reuse, image replacement, or Job escape.
    pub fn verified_session(&self, session_id: &str) -> Result<&AppSessionState, LifecycleError> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or(LifecycleError::SessionNotFound)?;
        if self.host.verify_process_in_job(
            session.job,
            session.pid,
            &session.creation_time,
            &session.image_name,
        ) {
            Ok(session)
        } else {
            Err(LifecycleError::AppLifecycleUnsupported)
        }
    }

    /// Launch a target under a kill-on-close Job.
    ///
    /// Ordering is load-bearing: create suspended → create job → kill-on-close →
    /// assign → resume. A process that cannot join the Job fails as
    /// `AppLifecycleUnsupported` and its suspended husk is terminated — we never
    /// resume an unmanaged process or fall back to a name-based kill.
    pub fn launch(
        &mut self,
        session_id: &str,
        spec: &AppLaunchSpec,
    ) -> Result<AppSessionState, LifecycleError> {
        let process = self.host.create_suspended(spec)?;
        if !process
            .image_name
            .eq_ignore_ascii_case(&spec.expected_image_name)
        {
            let _ = self.host.terminate_process(process.pid);
            return Err(LifecycleError::AppLaunchFailed);
        }

        let job = match self.host.create_job() {
            Ok(job) => job,
            Err(err) => {
                let _ = self.host.terminate_process(process.pid);
                return Err(err);
            }
        };
        if let Err(err) = self.host.set_kill_on_close(job) {
            let _ = self.host.terminate_process(process.pid);
            let _ = self.host.terminate_job(job);
            return Err(err);
        }

        if let Err(err) = self.host.assign_to_job(job, process.pid) {
            // Clean up the suspended husk without ever resuming it, and surface
            // the unsupported target to the human — no name-based fallback.
            let _ = self.host.terminate_process(process.pid);
            let _ = self.host.terminate_job(job);
            return match err {
                LifecycleError::AppLifecycleUnsupported => {
                    Err(LifecycleError::AppLifecycleUnsupported)
                }
                other => Err(other),
            };
        }

        if let Err(err) = self.host.resume(process.pid) {
            let _ = self.host.terminate_job(job);
            return Err(err);
        }

        let root_window_handle = match self
            .host
            .root_window_handle_for_selector(process.pid, &spec.window_selector)
        {
            Some(handle) => handle,
            None if spec.window_selector.is_empty() => process.root_window_handle.clone(),
            None => {
                self.cleanup_resumed_failed_launch(job, process.pid)?;
                return Err(LifecycleError::AppLaunchFailed);
            }
        };
        let state = AppSessionState {
            session_id: session_id.to_string(),
            process_group_id: hex::encode(random_bytes::<16>()),
            pid: process.pid,
            creation_time: process.creation_time.clone(),
            image_name: process.image_name.clone(),
            root_window_handle,
            window_selector: spec.window_selector.clone(),
            allowed_child_image_names: spec.allowed_child_image_names.clone(),
            job,
        };
        self.sessions.insert(session_id.to_string(), state.clone());
        Ok(state)
    }

    fn cleanup_resumed_failed_launch(
        &mut self,
        job: HostJob,
        pid: u32,
    ) -> Result<(), LifecycleError> {
        match self.host.terminate_job(job) {
            Ok(()) => Ok(()),
            Err(first_error) => {
                let process_result = self.host.terminate_process(pid);
                let retry_result = self.host.terminate_job(job);
                if process_result.is_ok() && retry_result.is_ok() {
                    Ok(())
                } else {
                    Err(first_error)
                }
            }
        }
    }

    /// Verify that every observed child is in the declared allowlist. Returns the
    /// first unexpected child's image name as an error so the Runner can stop.
    pub fn verify_children(&self, session_id: &str) -> Result<(), LifecycleError> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or(LifecycleError::SessionNotFound)?;
        for child in self.host.list_children(session.pid) {
            if !session
                .allowed_child_image_names
                .iter()
                .any(|name| name.eq_ignore_ascii_case(&child.image_name))
            {
                return Err(LifecycleError::UnexpectedChild(child.image_name));
            }
        }
        Ok(())
    }

    /// Whether the tracked process instance is still the same one (guards against
    /// PID reuse: a recycled PID has a different creation time).
    pub fn is_session_alive(&self, session_id: &str) -> bool {
        self.sessions
            .get(session_id)
            .map(|s| self.host.is_alive(s.pid, &s.creation_time))
            .unwrap_or(false)
    }

    /// Run the declared reset helper (explicit argv + timeout, own Job).
    pub fn reset(&mut self, session_id: &str, spec: &ResetSpec) -> Result<(), LifecycleError> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or(LifecycleError::SessionNotFound)?;
        if !self.host.verify_process_in_job(
            session.job,
            session.pid,
            &session.creation_time,
            &session.image_name,
        ) {
            return Err(LifecycleError::AppLifecycleUnsupported);
        }
        self.host.run_reset(spec)
    }

    /// Shut down a session by terminating ONLY its Job. Unrelated same-name
    /// processes and reused PIDs are never touched.
    pub fn shutdown(&mut self, session_id: &str) -> Result<(), LifecycleError> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or(LifecycleError::SessionNotFound)?
            .clone();
        if !self.host.verify_process_in_job(
            session.job,
            session.pid,
            &session.creation_time,
            &session.image_name,
        ) {
            return Err(LifecycleError::AppLifecycleUnsupported);
        }
        self.host.terminate_job(session.job)?;
        self.sessions.remove(session_id);
        Ok(())
    }
}
