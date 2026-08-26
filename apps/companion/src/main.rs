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
    // Ticket 29 owns authenticated pipe admission; Ticket 30 makes the default
    // process a daemon role rather than a second UI. Operators and tests can
    // verify this binary does not request uiAccess/elevation and that the native
    // request routers live in the library seams (`process`, `uia`, `tray`).
    match companion::ipc::windows_pipe::NamedPipeListener::bind_for_current_logon(
        &companion::ipc::windows_pipe::NativePipeConfig::default(),
    ) {
        Ok(listener) => {
            println!(
                "Qualigence Desktop Companion daemon listening on {} (uiAccess=false)",
                listener.path()
            );
        }
        Err(error) => {
            eprintln!("companion daemon unavailable: {}", error.stable_code());
            std::process::exit(1);
        }
    }
}

#[cfg(not(windows))]
fn run_daemon() {
    eprintln!("companion daemon requires Windows 11: Windows11Unavailable");
    std::process::exit(1);
}
