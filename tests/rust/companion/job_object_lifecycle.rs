//! Windows Job Object process lifecycle policy (specialist finding W-02): a
//! target is created suspended, wrapped in a kill-on-close Job before it is
//! resumed, tracked by exact (pid + creation time), and torn down / reset by Job
//! membership only — never by image name or a reusable PID.

use companion::process::app_session::AppSessionManager;
use companion::process::job_object::{
    AppLaunchSpec, DesktopProcessHost, FakeDesktopProcessHost, HostProcess, LifecycleError,
    ResetSpec,
};

fn spec() -> AppLaunchSpec {
    AppLaunchSpec {
        executable: "C:/Apps/ReferenceApp.exe".into(),
        args: vec!["--kiosk".into()],
        working_directory: Some("C:/Apps".into()),
        expected_image_name: "ReferenceApp.exe".into(),
        allowed_child_image_names: vec!["ReferenceHelper.exe".into()],
        packaged_cannot_join_job: false,
    }
}

#[test]
fn launch_creates_suspended_wraps_in_job_then_resumes_in_order() {
    let mut manager = AppSessionManager::new(FakeDesktopProcessHost::new());
    let session = manager.launch("sess-1", &spec()).expect("launch succeeds");

    // The opaque process group id is NOT the native Job id.
    assert!(!session.process_group_id.is_empty());
    assert_ne!(session.process_group_id, "1");
    assert_eq!(session.image_name, "ReferenceApp.exe");

    let ops = &manager.host().ops;
    let create = ops
        .iter()
        .position(|o| o.starts_with("create_suspended"))
        .expect("suspended create recorded");
    let create_job = ops
        .iter()
        .position(|o| o.starts_with("create_job"))
        .expect("job create recorded");
    let kill_on_close = ops
        .iter()
        .position(|o| o.starts_with("kill_on_close"))
        .expect("kill-on-close recorded");
    let assign = ops
        .iter()
        .position(|o| o.starts_with("assign"))
        .expect("assign recorded");
    let resume = ops
        .iter()
        .position(|o| o.starts_with("resume"))
        .expect("resume recorded");

    // Suspended first, resumed strictly last, and the Job is kill-on-close and
    // owns the process BEFORE the main thread ever runs.
    assert!(create < create_job);
    assert!(kill_on_close < assign);
    assert!(assign < resume);
    assert_eq!(resume, ops.len() - 1);
}

#[test]
fn shutdown_terminates_only_job_members_not_same_named_bystanders() {
    let mut manager = AppSessionManager::new(FakeDesktopProcessHost::new());
    let session = manager.launch("sess-1", &spec()).expect("launch succeeds");

    // An unrelated process with the SAME image name, not in our Job.
    manager.host_mut().register_unrelated(HostProcess {
        pid: 9999,
        creation_time: "1999-01-01T00:00:00.000Z".into(),
        image_name: "ReferenceApp.exe".into(),
        root_window_handle: "0xDEAD".into(),
    });

    manager.shutdown("sess-1").expect("shutdown succeeds");

    // Our target is gone; the same-named bystander survives.
    assert!(!manager.host().is_running(session.pid));
    assert!(manager.host().is_running(9999));
}

#[test]
fn a_reused_pid_is_never_mistaken_for_a_job_member() {
    let mut manager = AppSessionManager::new(FakeDesktopProcessHost::new());
    let session = manager.launch("sess-1", &spec()).expect("launch succeeds");
    let pid = session.pid;

    manager.shutdown("sess-1").expect("shutdown succeeds");

    // The OS later reuses the same PID for a brand-new, unrelated process.
    manager.host_mut().register_unrelated(HostProcess {
        pid,
        creation_time: "2030-01-01T00:00:00.000Z".into(),
        image_name: "Notepad.exe".into(),
        root_window_handle: "0xBEEF".into(),
    });

    // The session tracked the original creation time, so the recycled PID is not
    // considered the same instance.
    assert!(!manager.is_session_alive("sess-1"));
    assert!(manager.host().is_running(pid));
}

#[test]
fn a_declared_child_is_accepted_but_an_unexpected_child_is_rejected() {
    let mut manager = AppSessionManager::new(FakeDesktopProcessHost::new());
    let session = manager.launch("sess-1", &spec()).expect("launch succeeds");

    // Declared helper child is allowed.
    manager.host_mut().set_children(
        session.pid,
        vec![HostProcess {
            pid: 5000,
            creation_time: "2026-08-02T00:01:00.000Z".into(),
            image_name: "ReferenceHelper.exe".into(),
            root_window_handle: "0x3000".into(),
        }],
    );
    assert_eq!(manager.verify_children("sess-1"), Ok(()));

    // An undeclared child (e.g. a spawned browser) is rejected by exact name.
    manager.host_mut().set_children(
        session.pid,
        vec![HostProcess {
            pid: 5001,
            creation_time: "2026-08-02T00:02:00.000Z".into(),
            image_name: "cmd.exe".into(),
            root_window_handle: "0x3001".into(),
        }],
    );
    assert_eq!(
        manager.verify_children("sess-1"),
        Err(LifecycleError::UnexpectedChild("cmd.exe".into()))
    );
}

#[test]
fn a_packaged_app_that_cannot_join_a_job_fails_as_unsupported() {
    let mut host = FakeDesktopProcessHost::new();
    // Make the fake refuse Job assignment for the next process, as a packaged /
    // breakaway-protected app would.
    let mut packaged = spec();
    packaged.packaged_cannot_join_job = true;

    // The fake host does not itself reject; drive the rejection via a wrapper that
    // returns AppLifecycleUnsupported on assign.
    struct PackagedHost(FakeDesktopProcessHost);
    impl DesktopProcessHost for PackagedHost {
        fn create_suspended(
            &mut self,
            spec: &AppLaunchSpec,
        ) -> Result<HostProcess, LifecycleError> {
            self.0.create_suspended(spec)
        }
        fn create_job(
            &mut self,
        ) -> Result<companion::process::job_object::HostJob, LifecycleError> {
            self.0.create_job()
        }
        fn set_kill_on_close(
            &mut self,
            job: companion::process::job_object::HostJob,
        ) -> Result<(), LifecycleError> {
            self.0.set_kill_on_close(job)
        }
        fn assign_to_job(
            &mut self,
            _job: companion::process::job_object::HostJob,
            _pid: u32,
        ) -> Result<(), LifecycleError> {
            Err(LifecycleError::AppLifecycleUnsupported)
        }
        fn resume(&mut self, pid: u32) -> Result<(), LifecycleError> {
            self.0.resume(pid)
        }
        fn list_children(&self, pid: u32) -> Vec<HostProcess> {
            self.0.list_children(pid)
        }
        fn terminate_job(
            &mut self,
            job: companion::process::job_object::HostJob,
        ) -> Result<(), LifecycleError> {
            self.0.terminate_job(job)
        }
        fn run_reset(&mut self, spec: &ResetSpec) -> Result<(), LifecycleError> {
            self.0.run_reset(spec)
        }
        fn is_alive(&self, pid: u32, creation_time: &str) -> bool {
            self.0.is_alive(pid, creation_time)
        }
    }

    let _ = &mut host;
    let mut manager = AppSessionManager::new(PackagedHost(host));
    let result = manager.launch("sess-1", &packaged);
    assert_eq!(result.err(), Some(LifecycleError::AppLifecycleUnsupported));
    // No session is tracked, so nothing can be resumed or killed by name.
    assert!(manager.session("sess-1").is_none());
}

#[test]
fn reset_uses_the_declared_argv_and_timeout() {
    let mut manager = AppSessionManager::new(FakeDesktopProcessHost::new());
    manager.launch("sess-1", &spec()).expect("launch succeeds");

    let reset = ResetSpec {
        command: "C:/Apps/reset.exe".into(),
        args: vec!["--wipe".into()],
        timeout_ms: 5_000,
    };
    manager.reset("sess-1", &reset).expect("reset succeeds");

    let recorded = manager
        .host()
        .last_reset
        .clone()
        .expect("reset spec recorded");
    assert_eq!(recorded, reset);
}
