//! Windows Job Object process lifecycle policy (specialist finding W-02): a
//! target is created suspended, wrapped in a kill-on-close Job before it is
//! resumed, tracked by exact (pid + creation time), and torn down / reset by Job
//! membership only — never by image name or a reusable PID.

use companion::process::app_session::AppSessionManager;
use companion::process::job_object::{
    AppLaunchSpec, AppWindowSelector, DesktopProcessHost, FakeDesktopProcessHost, HostProcess,
    HostWindow, LifecycleError, ResetSpec,
};

fn spec() -> AppLaunchSpec {
    AppLaunchSpec {
        executable: "C:/Apps/ReferenceApp.exe".into(),
        args: vec!["--kiosk".into()],
        working_directory: Some("C:/Apps".into()),
        expected_image_name: "ReferenceApp.exe".into(),
        allowed_child_image_names: vec!["ReferenceHelper.exe".into()],
        window_selector: AppWindowSelector::default(),
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
        fn terminate_process(&mut self, pid: u32) -> Result<(), LifecycleError> {
            self.0.terminate_process(pid)
        }
        fn run_reset(&mut self, spec: &ResetSpec) -> Result<(), LifecycleError> {
            self.0.run_reset(spec)
        }
        fn is_alive(&self, pid: u32, creation_time: &str) -> bool {
            self.0.is_alive(pid, creation_time)
        }
        fn root_window_handle(&self, pid: u32) -> Option<String> {
            self.0.root_window_handle(pid)
        }
        fn verify_process_in_job(
            &self,
            job: companion::process::job_object::HostJob,
            pid: u32,
            creation_time: &str,
            expected_image_name: &str,
        ) -> bool {
            self.0
                .verify_process_in_job(job, pid, creation_time, expected_image_name)
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
fn launch_selects_the_matching_app_target_window_instead_of_first_visible_window() {
    let mut target = spec();
    target.window_selector = AppWindowSelector {
        title_pattern: Some("Reference App".into()),
        automation_id: Some("MainWindow".into()),
    };
    let mut host = FakeDesktopProcessHost::new();
    host.set_next_root_windows(vec![
        HostWindow {
            handle: "0xSPLASH".into(),
            title: Some("Loading".into()),
            automation_id: Some("SplashWindow".into()),
        },
        HostWindow {
            handle: "0xMAIN".into(),
            title: Some("Reference App - Ready".into()),
            automation_id: Some("MainWindow".into()),
        },
    ]);
    let mut manager = AppSessionManager::new(host);

    let session = manager
        .launch("sess-1", &target)
        .expect("matching window launches");
    assert_eq!(session.root_window_handle, "0xMAIN");
    assert_eq!(session.window_selector, target.window_selector);
}

#[test]
fn launch_fails_closed_when_no_visible_window_matches_the_app_target_selector() {
    let mut target = spec();
    target.window_selector = AppWindowSelector {
        title_pattern: Some("Reference App".into()),
        automation_id: Some("MainWindow".into()),
    };
    let mut host = FakeDesktopProcessHost::new();
    host.set_next_root_windows(vec![HostWindow {
        handle: "0xSPLASH".into(),
        title: Some("Loading".into()),
        automation_id: Some("SplashWindow".into()),
    }]);
    let mut manager = AppSessionManager::new(host);

    let result = manager.launch("sess-1", &target);
    assert!(matches!(result, Err(LifecycleError::AppLaunchFailed)));
    assert!(manager.session("sess-1").is_none());
}

#[test]
fn launch_selector_miss_retries_cleanup_after_job_termination_failure() {
    let mut target = spec();
    target.window_selector = AppWindowSelector {
        title_pattern: Some("Reference App".into()),
        automation_id: Some("MainWindow".into()),
    };
    let mut host = FakeDesktopProcessHost::new();
    host.set_next_root_windows(vec![HostWindow {
        handle: "0xSPLASH".into(),
        title: Some("Loading".into()),
        automation_id: Some("SplashWindow".into()),
    }]);
    host.fail_next_terminate_job(LifecycleError::HostError);
    let mut manager = AppSessionManager::new(host);

    let result = manager.launch("sess-1", &target);

    assert!(matches!(result, Err(LifecycleError::AppLaunchFailed)));
    assert!(manager.session("sess-1").is_none());
    assert!(!manager.host().is_running(1000));
    assert_eq!(
        manager
            .host()
            .ops
            .iter()
            .filter(|op| op.starts_with("terminate_job"))
            .count(),
        2
    );
    assert!(manager
        .host()
        .ops
        .iter()
        .any(|op| op == "terminate_process:1000"));
}

#[test]
fn shutdown_failure_preserves_session_authority_and_running_process() {
    let mut manager = AppSessionManager::new(FakeDesktopProcessHost::new());
    let session = manager.launch("sess-1", &spec()).expect("launch succeeds");
    manager
        .host_mut()
        .fail_next_terminate_job(LifecycleError::HostError);

    assert_eq!(manager.shutdown("sess-1"), Err(LifecycleError::HostError));
    assert!(manager.session("sess-1").is_some());
    assert!(manager.host().is_running(session.pid));

    manager.shutdown("sess-1").expect("retry succeeds");
    assert!(manager.session("sess-1").is_none());
    assert!(!manager.host().is_running(session.pid));
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

#[test]
fn reset_failure_surfaces_error_and_preserves_session_authority() {
    let mut manager = AppSessionManager::new(FakeDesktopProcessHost::new());
    let session = manager.launch("sess-1", &spec()).expect("launch succeeds");
    manager
        .host_mut()
        .fail_next_terminate_job(LifecycleError::HostError);
    let reset = ResetSpec {
        command: "C:/Apps/reset.exe".into(),
        args: vec!["--wipe".into()],
        timeout_ms: 5_000,
    };

    assert_eq!(
        manager.reset("sess-1", &reset),
        Err(LifecycleError::HostError)
    );
    assert!(manager.session("sess-1").is_some());
    assert!(manager.host().is_running(session.pid));
}

#[test]
fn reset_and_shutdown_require_exact_job_membership_before_side_effects() {
    struct MembershipRejectingHost(FakeDesktopProcessHost);
    impl DesktopProcessHost for MembershipRejectingHost {
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
            job: companion::process::job_object::HostJob,
            pid: u32,
        ) -> Result<(), LifecycleError> {
            self.0.assign_to_job(job, pid)
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
        fn terminate_process(&mut self, pid: u32) -> Result<(), LifecycleError> {
            self.0.terminate_process(pid)
        }
        fn run_reset(&mut self, spec: &ResetSpec) -> Result<(), LifecycleError> {
            self.0.run_reset(spec)
        }
        fn is_alive(&self, pid: u32, creation_time: &str) -> bool {
            self.0.is_alive(pid, creation_time)
        }
        fn root_window_handle(&self, pid: u32) -> Option<String> {
            self.0.root_window_handle(pid)
        }
        fn verify_process_in_job(
            &self,
            _job: companion::process::job_object::HostJob,
            _pid: u32,
            _creation_time: &str,
            _expected_image_name: &str,
        ) -> bool {
            false
        }
    }

    let mut manager =
        AppSessionManager::new(MembershipRejectingHost(FakeDesktopProcessHost::new()));
    manager.launch("sess-1", &spec()).expect("launch succeeds");

    let reset = ResetSpec {
        command: "C:/Apps/reset.exe".into(),
        args: vec!["--wipe".into()],
        timeout_ms: 5_000,
    };
    assert_eq!(
        manager.reset("sess-1", &reset),
        Err(LifecycleError::AppLifecycleUnsupported)
    );
    assert!(manager.host().0.last_reset.is_none());

    assert_eq!(
        manager.shutdown("sess-1"),
        Err(LifecycleError::AppLifecycleUnsupported)
    );
    assert!(manager.session("sess-1").is_some());
}

#[cfg(windows)]
#[test]
fn native_windows_host_launches_in_job_and_shutdown_verifies_membership() {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:/Windows".to_string());
    let powershell = format!("{system_root}/System32/WindowsPowerShell/v1.0/powershell.exe");
    let spec = AppLaunchSpec {
        executable: powershell,
        args: vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-Command".into(),
            "Start-Sleep -Seconds 30".into(),
        ],
        working_directory: None,
        expected_image_name: "powershell.exe".into(),
        allowed_child_image_names: vec![],
        window_selector: AppWindowSelector::default(),
        packaged_cannot_join_job: false,
    };
    let mut manager =
        AppSessionManager::new(companion::process::job_object::WindowsDesktopProcessHost::new());
    let session = manager
        .launch("native-sess", &spec)
        .expect("native target launches under a Job Object");
    assert!(manager.is_session_alive("native-sess"));
    assert_eq!(session.image_name, "powershell.exe");
    manager
        .shutdown("native-sess")
        .expect("verified Job member shuts down");
}
