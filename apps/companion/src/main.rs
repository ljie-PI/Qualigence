//! Companion binary entry point.
//!
//! This PR (PR-25) delivers the security core as a library; the runnable daemon
//! (Named Pipe server loop, tray, Job Object lifecycle and UIA worker) is wired
//! in PR-26. The binary intentionally does nothing beyond reporting its role so
//! the crate builds as a real bin target and the hidden `--uia-worker` mode has
//! a reserved entry point.

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--uia-worker") => {
            // Reserved: PR-26 runs the restartable MTA UIA worker here.
            eprintln!("companion: --uia-worker mode is not available until PR-26");
        }
        _ => {
            println!(
                "Qualigence Desktop Companion (LS-13). Security core is exercised via `cargo test`; \
                 the IPC daemon and UIA worker are wired in PR-26."
            );
        }
    }
}
