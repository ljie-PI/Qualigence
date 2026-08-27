use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use companion::ipc::dto::{
    AppTarget, AppTargetLaunch, AppTargetProcess, AppTargetReset, AppTargetShutdown,
    AppTargetWindow, CompanionRequest, CompanionRequestPayload, DesktopActionKind,
    DesktopPlaintextValue, DesktopPlatform, DesktopResolution, DesktopValueBinding,
    HandshakeBeginPayload, HandshakeProvePayload, LocalExecutionPermit, LocalPermitAuthorization,
    LocalPermitRequest, ResolvedDesktopAction, SessionIdPayload, TargetKind, UiaCapturePayload,
    PROTOCOL_MAJOR,
};
use companion::ipc::security::proof_bytes;
use companion::risk::Risk;
use companion::uia::action::desktop_action_digest_sha256;
use companion::uia::mapping::MASKED_VALUE;
use companion::uia::protocol::UiaSource;
use p256::ecdsa::signature::Signer as EcdsaSigner;
use p256::ecdsa::SigningKey as EcdsaSigningKey;
use p256::pkcs8::DecodePrivateKey as DecodeP256PrivateKey;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const RUNNER_ID: &str = "runner-1";
const TENANT_SCOPE_SAN: &str = "urn:qualigence:tenant:tenant-1";
const PROJECT_SCOPE_SAN: &str = "urn:qualigence:project:project-1";
const SECRET_PLAINTEXT: &str = "ticket47-secret-do-not-log";
const MAX_FRAME_BYTES: usize = 1024 * 1024;

const ECDSA_KEY: &str = r#"-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgLpkHlViRQ/JRu+f5
zoJiFJ7jtNK5l0g7+epxAKmzyNahRANCAARLLuvzUOW6FeHl03eam9Z5jMB2CLwA
9SjDUf/t+ocb1Q3882yfOqpgKOUHmXigPa4ubfMorvsv3CBR4uqHP94Y
-----END PRIVATE KEY-----"#;

const ECDSA_CERT: &str = r#"-----BEGIN CERTIFICATE-----
MIICJjCCAc2gAwIBAgIUTlwcdg0R28tGWcSOPvwTmv1Nx2gwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZUXVhbGlnZW5jZSBUZXN0IFJ1bm5lciBDQTAeFw0yNjA4MjYw
ODUzMjNaFw0zNjA4MjMwODUzMjNaMBMxETAPBgNVBAMMCHJ1bm5lci0xMFkwEwYH
KoZIzj0CAQYIKoZIzj0DAQcDQgAESy7r81DluhXh5dN3mpvWeYzAdgi8APUow1H/
7fqHG9UN/PNsnzqqYCjlB5l4oD2uLm3zKK77L9wgUeLqhz/eGKOB7TCB6jAMBgNV
HRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDAjB1
BgNVHREEbjBsgghydW5uZXItMYYedXJuOnF1YWxpZ2VuY2U6cnVubmVyOnJ1bm5l
ci0xhh51cm46cXVhbGlnZW5jZTp0ZW5hbnQ6dGVuYW50LTGGIHVybjpxdWFsaWdl
bmNlOnByb2plY3Q6cHJvamVjdC0xMB0GA1UdDgQWBBSmTjV1yMrhLbt3kYxXFi0S
W4TNVzAfBgNVHSMEGDAWgBT9wrZDegq05yv6vcNZRs55b/AFjzAKBggqhkjOPQQD
AgNHADBEAiAGp3MPTsz5WdGOxTK6xqvZxzQctZlfl/YiogQLuda26wIgbA6yekPk
khXIzEH9gv0fW/FKFd53I60UDdEfnA158Xc=
-----END CERTIFICATE-----"#;

const CA_CERT: &str = r#"-----BEGIN CERTIFICATE-----
MIIBsTCCAVagAwIBAgIUd4XQSEbTF76koS/80HeYebOZh10wCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZUXVhbGlnZW5jZSBUZXN0IFJ1bm5lciBDQTAeFw0yNjA4MjYw
ODUzMjNaFw0zNjA4MjMwODUzMjNaMCQxIjAgBgNVBAMMGVF1YWxpZ2VuY2UgVGVz
dCBSdW5uZXIgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATKvUOn4Xa5k3qo
g497Un732k31Crr1Jvz34UAWd3zsidoVSnULPnuChjPZ4HrmWacnHCogmoMG7eue
fnv8mZYSo2YwZDASBgNVHRMBAf8ECDAGAQH/AgEBMA4GA1UdDwEB/wQEAwIBBjAd
BgNVHQ4EFgQU/cK2Q3oKtOcr+r3DWUbOeW/wBY8wHwYDVR0jBBgwFoAU/cK2Q3oK
tOcr+r3DWUbOeW/wBY8wCgYIKoZIzj0EAwIDSQAwRgIhAMV+8OhJBQh8D5uro3as
mHzX07UK31vFNoS8JMxsdg2wAiEAkhXKJ0LsSqHY3FE1OMRZY8C7tum8bsuPuG4E
DzQHpEk=
-----END CERTIFICATE-----"#;

#[derive(Debug)]
struct HarnessError {
    code: &'static str,
    message: String,
    exit: u8,
}

type HarnessResult<T> = Result<T, HarnessError>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceDocument {
    schema_version: &'static str,
    status: &'static str,
    command_line: Vec<String>,
    companion_executable: String,
    harness_executable: String,
    companion_pipe: String,
    ui_access: bool,
    machine: MachineEvidence,
    checks: Vec<CheckEvidence>,
    apps: Vec<AppEvidence>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MachineEvidence {
    os: String,
    session_name: Option<String>,
    windows_build: Option<u32>,
    runner_id: &'static str,
    certificate_sha256_fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckEvidence {
    id: String,
    status: &'static str,
    summary: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppEvidence {
    technology: String,
    project: String,
    executable: String,
    session_id: String,
    process_id: u64,
    process_creation_time: String,
    process_group_id: String,
    root_window_handle: String,
    capture_node_count: usize,
    checks: Vec<CheckEvidence>,
}

fn main() -> ExitCode {
    let args = env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("--reset-reference-state") {
        return run_reset_helper(&args[2..]);
    }
    if args.get(1).map(String::as_str) == Some("--sleep-until-killed") {
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }

    match run_harness(args) {
        Ok(path) => {
            println!("Ticket 47 Windows UIA daemon harness passed");
            println!(
                "QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS_EVIDENCE={}",
                path.display()
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{}: {}", error.code, error.message);
            ExitCode::from(error.exit)
        }
    }
}

fn run_reset_helper(args: &[String]) -> ExitCode {
    if args.len() != 1 {
        eprintln!("WindowsUiaPrerequisiteUnavailable: reset helper expects exactly the app output directory");
        return ExitCode::from(11);
    }
    let path = Path::new(&args[0]).join("reference-state.json");
    match fs::write(&path, br#"{"Username":"","Role":"Viewer","Results":[]}"#) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!(
                "WindowsUiaPrerequisiteUnavailable: failed to reset reference state at {}: {error}",
                path.display()
            );
            ExitCode::from(11)
        }
    }
}

fn run_harness(args: Vec<String>) -> HarnessResult<PathBuf> {
    if args.len() != 3 {
        return Err(prereq(
            "usage: companion-daemon-harness <WPF_PROJECT> <WINUI_PROJECT>",
        ));
    }
    ensure_supported_windows()?;

    let wpf_project = PathBuf::from(&args[1]);
    let winui_project = PathBuf::from(&args[2]);
    ensure_file(&wpf_project, "WPF project")?;
    ensure_file(&winui_project, "WinUI project")?;
    ensure_dotnet()?;

    let harness_exe = env::current_exe()
        .map_err(|e| prereq(format!("cannot resolve harness executable: {e}")))?;
    let companion_exe = companion_executable(&harness_exe)?;

    let evidence_dir = env::var_os("QUALIGENCE_WINDOWS_UIA_HARNESS_EVIDENCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::temp_dir()
                .join("qualigence-uia-harness")
                .join(run_id())
        });
    fs::create_dir_all(&evidence_dir).map_err(|e| {
        evidence_error(format!(
            "cannot create evidence directory {}: {e}",
            evidence_dir.display()
        ))
    })?;

    let wpf_exe = build_reference_app(&wpf_project, "WindowsReferenceWpf.exe")?;
    let winui_exe = build_reference_app(&winui_project, "WindowsReferenceWinUi.exe")?;
    prepare_reference_state(&wpf_exe)?;
    prepare_reference_state(&winui_exe)?;

    let pipe_prefix = format!("qualigence-ticket47-{}", std::process::id());
    let cert_fingerprint = fingerprint(ECDSA_CERT)?;
    let mut daemon = start_companion_daemon(
        &companion_exe,
        &harness_exe,
        &pipe_prefix,
        &cert_fingerprint,
        true,
    )?;
    let mut checks = Vec::new();
    let mut client =
        check_malformed_ipc_rejected_and_daemon_survives(&daemon.pipe_path, &mut checks)?;
    check_probe(&mut client, &mut checks)?;

    let mut apps = Vec::new();
    apps.push(run_app_scenario(
        &mut client,
        "wpf",
        &wpf_project,
        &wpf_exe,
        &harness_exe,
    )?);
    apps.push(run_app_scenario(
        &mut client,
        "winui",
        &winui_project,
        &winui_exe,
        &harness_exe,
    )?);

    check_policy_denial_and_emergency_stop(
        &mut client,
        &winui_project,
        &winui_exe,
        &harness_exe,
        &mut checks,
    )?;

    daemon.shutdown();
    check_high_risk_approval_timeout(
        &companion_exe,
        &harness_exe,
        &cert_fingerprint,
        &wpf_project,
        &wpf_exe,
        &mut checks,
    )?;

    checks.push(pass("ticket31-handoff", "Harness result is an automated prerequisite only; Ticket 31 remains responsible for signed local-console/RDP checklist evidence"));
    let document = EvidenceDocument {
        schema_version: "qualigence-windows-uia-daemon-harness/v1",
        status: "passed",
        command_line: args,
        companion_executable: companion_exe.display().to_string(),
        harness_executable: harness_exe.display().to_string(),
        companion_pipe: daemon.pipe_path.clone(),
        ui_access: false,
        machine: MachineEvidence {
            os: env::consts::OS.to_string(),
            session_name: env::var("SESSIONNAME").ok(),
            windows_build: windows_build().ok().flatten(),
            runner_id: RUNNER_ID,
            certificate_sha256_fingerprint: cert_fingerprint,
        },
        checks,
        apps,
    };
    let evidence_json = serde_json::to_string_pretty(&document)
        .map_err(|e| evidence_error(format!("cannot serialize evidence: {e}")))?;
    if evidence_json.contains(SECRET_PLAINTEXT) {
        return Err(evidence_error(
            "evidence serialization attempted to include secret plaintext",
        ));
    }
    let evidence_path = evidence_dir.join("windows-uia-daemon-harness-evidence.json");
    fs::write(&evidence_path, evidence_json).map_err(|e| {
        evidence_error(format!(
            "cannot write evidence {}: {e}",
            evidence_path.display()
        ))
    })?;
    let summary_path = evidence_dir.join("summary.md");
    fs::write(&summary_path, summary_markdown(&document, &evidence_path)).map_err(|e| {
        evidence_error(format!(
            "cannot write summary {}: {e}",
            summary_path.display()
        ))
    })?;
    Ok(evidence_path)
}

fn run_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("{millis}-{}", std::process::id())
}

fn ensure_supported_windows() -> HarnessResult<()> {
    if cfg!(not(windows)) {
        return Err(HarnessError {
            code: "Windows11Unavailable",
            message: "Ticket 47 harness must run on a local interactive Windows 11 session".into(),
            exit: 10,
        });
    }
    let Some(build) = windows_build()? else {
        return Err(prereq("unable to determine Windows build"));
    };
    if build < 22_000 {
        return Err(HarnessError {
            code: "Windows11Unavailable",
            message: format!("Windows build {build} is below the Windows 11 baseline 22000"),
            exit: 10,
        });
    }
    let session_name = env::var("SESSIONNAME").unwrap_or_default();
    if session_name.trim().is_empty() || session_name.eq_ignore_ascii_case("Services") {
        return Err(HarnessError {
            code: "Windows11Unavailable",
            message: "local interactive Windows session is required".into(),
            exit: 10,
        });
    }
    Ok(())
}

fn windows_build() -> HarnessResult<Option<u32>> {
    if cfg!(not(windows)) {
        return Ok(None);
    }
    let output = Command::new("cmd.exe")
        .args(["/C", "ver"])
        .output()
        .map_err(|e| prereq(format!("cmd.exe /C ver failed: {e}")))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let build = text
        .split(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .filter(|part| part.contains('.'))
        .find_map(|part| part.split('.').nth(2).and_then(|v| v.parse::<u32>().ok()));
    Ok(build)
}

fn ensure_file(path: &Path, label: &str) -> HarnessResult<()> {
    if path.is_file() {
        Ok(())
    } else {
        Err(prereq(format!("{label} is missing: {}", path.display())))
    }
}

fn ensure_dotnet() -> HarnessResult<()> {
    let output = Command::new("dotnet")
        .arg("--info")
        .output()
        .map_err(|e| prereq(format!("dotnet --info failed to start: {e}")))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(prereq(format!(
            "dotnet --info failed with status {:?}: {}{}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )))
    }
}

fn build_reference_app(project: &Path, expected_exe_name: &str) -> HarnessResult<PathBuf> {
    let output = Command::new("dotnet")
        .args([
            "build",
            &project.display().to_string(),
            "-c",
            "Release",
            "--nologo",
        ])
        .env("CI", "true")
        .output()
        .map_err(|e| {
            prereq(format!(
                "dotnet build failed to start for {}: {e}",
                project.display()
            ))
        })?;
    if !output.status.success() {
        return Err(prereq(format!(
            "dotnet build failed for {} with status {:?}: {}{}",
            project.display(),
            output.status.code(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    find_built_exe(project, expected_exe_name).ok_or_else(|| {
        prereq(format!(
            "dotnet build completed but {expected_exe_name} was not found below {}",
            project
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("bin")
                .display()
        ))
    })
}

fn find_built_exe(project: &Path, expected_exe_name: &str) -> Option<PathBuf> {
    let root = project.parent()?.join("bin").join("Release");
    let mut matches = Vec::new();
    collect_named_files(&root, expected_exe_name, &mut matches);
    matches.sort_by_key(|path| fs::metadata(path).and_then(|m| m.modified()).ok());
    matches.pop()
}

fn collect_named_files(dir: &Path, expected_name: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_named_files(&path, expected_name, out);
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case(expected_name))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

fn prepare_reference_state(exe: &Path) -> HarnessResult<()> {
    let dir = exe.parent().ok_or_else(|| {
        prereq(format!(
            "cannot resolve app output directory for {}",
            exe.display()
        ))
    })?;
    fs::write(
        dir.join("reference-state.json"),
        br#"{"Username":"","Role":"Viewer","Results":[]}"#,
    )
    .map_err(|e| {
        prereq(format!(
            "cannot write reference-state.json beside {}: {e}",
            exe.display()
        ))
    })
}

fn companion_executable(harness_exe: &Path) -> HarnessResult<PathBuf> {
    if let Some(path) = env::var_os("QUALIGENCE_COMPANION_DAEMON") {
        let path = PathBuf::from(path);
        ensure_file(&path, "Companion daemon")?;
        return Ok(path);
    }
    let dir = harness_exe
        .parent()
        .ok_or_else(|| prereq("cannot resolve harness directory"))?;
    let file = if cfg!(windows) {
        "companion.exe"
    } else {
        "companion"
    };
    let candidate = dir.join(file);
    ensure_file(&candidate, "Companion daemon sibling")?;
    Ok(candidate)
}

struct CompanionDaemon {
    child: Child,
    pipe_path: String,
}

impl CompanionDaemon {
    fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for CompanionDaemon {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn start_companion_daemon(
    companion_exe: &Path,
    harness_exe: &Path,
    pipe_prefix: &str,
    cert_fingerprint: &str,
    approve_all: bool,
) -> HarnessResult<CompanionDaemon> {
    let mut child = Command::new(companion_exe)
        .env("QUALIGENCE_COMPANION_PIPE_PREFIX", pipe_prefix)
        .env("QUALIGENCE_COMPANION_ALLOWED_RUNNER_IMAGES", harness_exe)
        .env("QUALIGENCE_COMPANION_ALLOW_UNSIGNED_TEST_ONLY", "true")
        .env("QUALIGENCE_COMPANION_RUNNER_ID", RUNNER_ID)
        .env("QUALIGENCE_COMPANION_RUNNER_CERT_SHA256", cert_fingerprint)
        .env("QUALIGENCE_COMPANION_RUNNER_SAN", RUNNER_ID)
        .env(
            "QUALIGENCE_COMPANION_RUNNER_SCOPE_SANS",
            format!("urn:qualigence:runner:{RUNNER_ID};{TENANT_SCOPE_SAN};{PROJECT_SCOPE_SAN}"),
        )
        .env(
            "QUALIGENCE_COMPANION_RUNNER_ISSUER_SHA256",
            fingerprint(CA_CERT)?,
        )
        .env(
            "QUALIGENCE_COMPANION_TEST_APPROVE_ALL",
            if approve_all { "true" } else { "false" },
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            companion_error(format!(
                "failed to start Companion daemon {}: {e}",
                companion_exe.display()
            ))
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| companion_error("missing Companion stdout"))?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| {
        companion_error(format!("failed to read Companion daemon startup line: {e}"))
    })?;
    if !line.contains("uiAccess=false") {
        return Err(companion_error(format!(
            "Companion daemon did not announce uiAccess=false: {}",
            line.trim()
        )));
    }
    let pipe_path = line
        .split("listening on ")
        .nth(1)
        .and_then(|rest| rest.split(" (uiAccess=false)").next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            companion_error(format!(
                "could not parse Companion pipe path from: {}",
                line.trim()
            ))
        })?
        .to_string();
    Ok(CompanionDaemon { child, pipe_path })
}

struct CompanionPipeClient {
    pipe: File,
    next_request: u64,
}

impl CompanionPipeClient {
    fn connect(path: &str) -> HarnessResult<Self> {
        let started = SystemTime::now();
        loop {
            match OpenOptions::new().read(true).write(true).open(path) {
                Ok(pipe) => {
                    return Ok(Self {
                        pipe,
                        next_request: 1,
                    })
                }
                Err(error) => {
                    if started.elapsed().unwrap_or_default() > Duration::from_secs(10) {
                        return Err(companion_error(format!(
                            "failed to connect to Companion pipe {path}: {error}"
                        )));
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }

    fn handshake(&mut self) -> HarnessResult<()> {
        let response = self.request(CompanionRequestPayload::HandshakeBegin(
            HandshakeBeginPayload {
                runner_id: RUNNER_ID.to_string(),
                certificate_pem: format!("{ECDSA_CERT}\n{CA_CERT}"),
            },
        ))?;
        let payload = response_payload(&response)?;
        let challenge_id = string_field(payload, "challengeId")?;
        let companion_instance_id = string_field(payload, "companionInstanceId")?;
        let nonce_base64 = string_field(payload, "nonceBase64")?;
        let proof = proof_bytes(
            PROTOCOL_MAJOR,
            &companion_instance_id,
            &nonce_base64,
            RUNNER_ID,
        );
        let signature = sign_ecdsa(&proof)?;
        self.request(CompanionRequestPayload::HandshakeProve(
            HandshakeProvePayload {
                challenge_id,
                companion_instance_id,
                nonce_base64,
                signature_base64: signature,
                signature_algorithm: "ecdsa-p256-sha256".to_string(),
            },
        ))?;
        Ok(())
    }

    fn request(&mut self, payload: CompanionRequestPayload) -> HarnessResult<Value> {
        let request = CompanionRequest {
            protocol_major: PROTOCOL_MAJOR,
            request_id: format!("ticket47-{}", self.next_request),
            payload,
        };
        self.next_request += 1;
        let expected_request_id = request.request_id.clone();
        let expected_type = request.request_type();
        let body = serde_json::to_vec(&request)
            .map_err(|e| companion_error(format!("failed to encode Companion request: {e}")))?;
        write_frame(&mut self.pipe, &body)?;
        let response = read_frame(&mut self.pipe)?;
        let value: Value = serde_json::from_slice(&response)
            .map_err(|e| companion_error(format!("Companion returned malformed JSON: {e}")))?;
        if value.get("requestId").and_then(Value::as_str) != Some(expected_request_id.as_str())
            || value.get("type").and_then(Value::as_str) != Some(expected_type)
        {
            return Err(companion_error(format!(
                "Companion response correlation mismatch for {expected_request_id}/{expected_type}: {value}"
            )));
        }
        if value.get("status").and_then(Value::as_str) == Some("error") {
            return Ok(value);
        }
        if value.get("status").and_then(Value::as_str) != Some("ok") {
            return Err(companion_error(format!(
                "Companion returned unknown status: {value}"
            )));
        }
        Ok(value)
    }

    fn expect_ok(
        &mut self,
        payload: CompanionRequestPayload,
        context: &str,
    ) -> HarnessResult<Value> {
        let response = self.request(payload)?;
        if response.get("status").and_then(Value::as_str) == Some("ok") {
            Ok(response_payload(&response)?.clone())
        } else {
            Err(native_check(format!("{context} failed: {response}")))
        }
    }
}

fn write_frame(writer: &mut File, body: &[u8]) -> HarnessResult<()> {
    if body.len() > MAX_FRAME_BYTES {
        return Err(companion_error(
            "client attempted to send an oversized frame",
        ));
    }
    writer
        .write_all(&(body.len() as u32).to_be_bytes())
        .and_then(|_| writer.write_all(body))
        .and_then(|_| writer.flush())
        .map_err(|e| companion_error(format!("failed to write Companion frame: {e}")))
}

fn read_frame(reader: &mut File) -> HarnessResult<Vec<u8>> {
    let mut len = [0u8; 4];
    reader
        .read_exact(&mut len)
        .map_err(|e| companion_error(format!("failed to read Companion frame length: {e}")))?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(companion_error(format!(
            "Companion response exceeded {MAX_FRAME_BYTES} bytes"
        )));
    }
    let mut body = vec![0u8; len];
    reader
        .read_exact(&mut body)
        .map_err(|e| companion_error(format!("failed to read Companion frame body: {e}")))?;
    Ok(body)
}

fn check_probe(
    client: &mut CompanionPipeClient,
    checks: &mut Vec<CheckEvidence>,
) -> HarnessResult<()> {
    let payload = client.expect_ok(
        CompanionRequestPayload::CompanionProbe(
            companion::ipc::dto::CompanionCapabilityProbeRequest {
                target_adapter: "desktop-windows-uia".to_string(),
                observation_extension: "uia/v1".to_string(),
            },
        ),
        "companion.probe",
    )?;
    if payload.get("ready").and_then(Value::as_bool) != Some(true) {
        return Err(native_check(format!(
            "companion.probe was not ready: {payload}"
        )));
    }
    checks.push(pass("companion.probe", "Production Companion daemon authenticated over native pipe and reported desktop-windows-uia/uia/v1 readiness"));
    Ok(())
}

fn check_malformed_ipc_rejected_and_daemon_survives(
    pipe_path: &str,
    checks: &mut Vec<CheckEvidence>,
) -> HarnessResult<CompanionPipeClient> {
    let mut bad = CompanionPipeClient::connect(pipe_path)?;
    bad.pipe
        .write_all(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes())
        .map_err(|e| companion_error(format!("failed to write malformed IPC frame: {e}")))?;
    drop(bad);
    // The daemon should close the malformed connection and re-bind. Connect and authenticate through a fresh session.
    let mut client = CompanionPipeClient::connect(pipe_path)?;
    client.handshake()?;
    checks.push(pass("ipc.malformed-bounded", "Oversized malformed frame was rejected and the daemon accepted a fresh authenticated connection afterward"));
    Ok(client)
}

fn run_app_scenario(
    client: &mut CompanionPipeClient,
    technology: &str,
    project: &Path,
    exe: &Path,
    harness_exe: &Path,
) -> HarnessResult<AppEvidence> {
    let app_dir = exe
        .parent()
        .ok_or_else(|| prereq("missing app output directory"))?;
    let target = app_target(technology, exe, harness_exe, app_dir);
    let session_payload = client.expect_ok(
        CompanionRequestPayload::AppLaunch(companion::ipc::dto::AppLaunchPayload { target }),
        &format!("{technology} app.launch"),
    )?;
    let session_id = string_field(&session_payload, "sessionId")?;
    let process_id = number_field(&session_payload, "processId")?;
    let process_creation_time = string_field(&session_payload, "processCreationTime")?;
    let process_group_id = string_field(&session_payload, "processGroupId")?;
    let root_window_handle = string_field(&session_payload, "rootWindowHandle")?;

    let source = capture(
        client,
        &session_id,
        10_000,
        &format!("{technology} initial capture"),
    )?;
    let mut checks = vec![
        pass("app.launch-contained", format!("{technology} launched through Companion with PID {process_id}, creation time {process_creation_time}, process group {process_group_id}, root {root_window_handle}")),
    ];
    validate_reference_capture(technology, &source, &mut checks)?;

    let username_node = node_id_by_automation_id(&source, "UsernameEdit")?;
    let password_node = node_id_by_automation_id(&source, "PasswordEdit")?;
    let role_node = node_id_by_automation_id(&source, "RoleCombo")?;
    let submit_node = node_id_by_automation_id(&source, "SubmitButton")?;
    let reset_node = node_id_by_automation_id(&source, "ResetButton")?;

    execute_value_action(
        client,
        &session_id,
        &username_node,
        "UsernameEdit",
        "ticket47-user",
        technology,
        "input-username",
    )?;
    execute_value_action(
        client,
        &session_id,
        &password_node,
        "PasswordEdit",
        SECRET_PLAINTEXT,
        technology,
        "input-password",
    )?;
    let after_secret = capture(
        client,
        &session_id,
        10_000,
        &format!("{technology} post-password capture"),
    )?;
    assert_no_secret_in_capture(&after_secret, technology)?;
    checks.push(pass(
        "password.masked",
        format!("{technology} password control remained masked after value-bound input"),
    ));

    execute_select_action(client, &session_id, &role_node, "Editor", technology)?;
    execute_click_action(
        client,
        &session_id,
        &submit_node,
        technology,
        "invoke-submit",
    )?;
    execute_click_action(client, &session_id, &reset_node, technology, "invoke-reset")?;
    checks.push(pass("actions.supported", format!("{technology} executed Value, Selection, and Invoke actions through Companion Permit/action IPC")));

    let unsupported = action_click(
        "unsupported-invoke-on-edit",
        "graph-ticket47",
        &username_node,
        Some("Invoke"),
    );
    let permit = request_permit(client, &session_id, unsupported.clone(), Risk::Normal, None)?;
    let payload = action_execute_payload(&session_id, unsupported, permit, None, 10_000);
    let response = client.request(CompanionRequestPayload::ActionExecute(payload))?;
    assert_action_failed_with(&response, "UiaPatternUnsupported", "unsupported-pattern")?;
    checks.push(pass(
        "action.unsupported-pattern",
        format!("{technology} unsupported UIA pattern failed closed"),
    ));

    let replay_action = action_click(
        "permit-replay",
        "graph-ticket47",
        &submit_node,
        Some("Invoke"),
    );
    let replay_permit = request_permit(
        client,
        &session_id,
        replay_action.clone(),
        Risk::Normal,
        None,
    )?;
    let first = client.expect_ok(
        CompanionRequestPayload::ActionExecute(action_execute_payload(
            &session_id,
            replay_action.clone(),
            replay_permit.clone(),
            None,
            10_000,
        )),
        "permit replay first execute",
    )?;
    if first.get("status").and_then(Value::as_str) != Some("ok") {
        return Err(native_check(format!(
            "first replay setup action failed: {first}"
        )));
    }
    let second = client.request(CompanionRequestPayload::ActionExecute(
        action_execute_payload(&session_id, replay_action, replay_permit, None, 10_000),
    ))?;
    assert_action_failed_with(&second, "LocalPermitInvalid", "permit replay")?;
    checks.push(pass(
        "permit.replay-denied",
        format!("{technology} consumed permit replay was denied"),
    ));

    let mismatch_action = action_click(
        "permit-mismatch",
        "graph-ticket47",
        &submit_node,
        Some("Invoke"),
    );
    let mismatch_permit = request_permit(
        client,
        &session_id,
        mismatch_action.clone(),
        Risk::Normal,
        None,
    )?;
    let mut bad_action = mismatch_action.clone();
    bad_action.action_id = "permit-mismatch-tampered".to_string();
    let mismatch_response = client.request(CompanionRequestPayload::ActionExecute(
        action_execute_payload(&session_id, bad_action, mismatch_permit, None, 10_000),
    ))?;
    assert_error_code(&mismatch_response, "ApplicationError", "permit mismatch")?;
    checks.push(pass(
        "permit.mismatch-denied",
        format!("{technology} mismatched permit/action binding was denied before trusted success"),
    ));

    let expired_action = action_click(
        "permit-expiry",
        "graph-ticket47",
        &submit_node,
        Some("Invoke"),
    );
    let expired_permit = request_permit(
        client,
        &session_id,
        expired_action.clone(),
        Risk::Normal,
        None,
    )?;
    thread::sleep(Duration::from_millis(31_000));
    let expired_response = client.request(CompanionRequestPayload::ActionExecute(
        action_execute_payload(&session_id, expired_action, expired_permit, None, 10_000),
    ))?;
    assert_error_code(&expired_response, "ApplicationError", "permit expiry")?;
    checks.push(pass(
        "permit.expiry-denied",
        format!("{technology} expired permit was denied"),
    ));

    let timeout_response =
        client.request(CompanionRequestPayload::UiaCapture(UiaCapturePayload {
            session_id: session_id.clone(),
            deadline_ms: 1,
        }))?;
    if timeout_response.get("status").and_then(Value::as_str) == Some("ok") {
        checks.push(pass(
            "uia.worker-short-deadline",
            format!(
                "{technology} short-deadline capture completed without corrupting Companion state"
            ),
        ));
    } else {
        assert_error_code(
            &timeout_response,
            "TargetUnresponsive",
            "short-deadline worker timeout",
        )?;
        checks.push(pass(
            "uia.worker-timeout",
            format!("{technology} short-deadline capture failed closed as TargetUnresponsive"),
        ));
    }
    capture(
        client,
        &session_id,
        10_000,
        &format!("{technology} capture after worker timeout/restart"),
    )?;
    checks.push(pass(
        "uia.worker-restart",
        format!("{technology} Companion remained usable after worker timeout/short-deadline path"),
    ));

    client.expect_ok(
        CompanionRequestPayload::AppReset(SessionIdPayload {
            session_id: session_id.clone(),
        }),
        &format!("{technology} app.reset"),
    )?;
    checks.push(pass(
        "app.reset",
        format!("{technology} reset executed through Companion reset-helper Job"),
    ));

    let unrelated = start_unrelated_same_name(exe, harness_exe)?;
    client.expect_ok(
        CompanionRequestPayload::AppShutdown(SessionIdPayload {
            session_id: session_id.clone(),
        }),
        &format!("{technology} app.shutdown"),
    )?;
    let unrelated_survived = process_alive(unrelated.id());
    terminate_child(unrelated);
    if !unrelated_survived {
        return Err(native_check(format!(
            "{technology} shutdown killed an unrelated same-name process"
        )));
    }
    checks.push(pass("app.shutdown-unrelated-survives", format!("{technology} shutdown did not kill an unrelated same-name process outside the Companion Job")));

    Ok(AppEvidence {
        technology: technology.to_string(),
        project: project.display().to_string(),
        executable: exe.display().to_string(),
        session_id,
        process_id,
        process_creation_time,
        process_group_id,
        root_window_handle,
        capture_node_count: source.nodes.len(),
        checks,
    })
}

fn check_policy_denial_and_emergency_stop(
    client: &mut CompanionPipeClient,
    project: &Path,
    exe: &Path,
    harness_exe: &Path,
    checks: &mut Vec<CheckEvidence>,
) -> HarnessResult<()> {
    let app_dir = exe
        .parent()
        .ok_or_else(|| prereq("missing app output directory"))?;
    let target = app_target("approval-timeout", exe, harness_exe, app_dir);
    let payload = client.expect_ok(
        CompanionRequestPayload::AppLaunch(companion::ipc::dto::AppLaunchPayload { target }),
        "approval-timeout app.launch",
    )?;
    let session_id = string_field(&payload, "sessionId")?;
    let source = capture(client, &session_id, 10_000, "approval-timeout capture")?;
    let delete_node = node_id_by_automation_id(&source, "DeleteAllButton")?;
    let forbidden = action_click(
        "production-forbidden-denial",
        "graph-ticket47",
        &delete_node,
        Some("Invoke"),
    );
    let denial = request_permit_response(
        client,
        &session_id,
        forbidden,
        Risk::ProductionForbidden,
        None,
    )?;
    if response_payload(&denial)?
        .get("status")
        .and_then(Value::as_str)
        != Some("denied")
    {
        return Err(native_check(format!(
            "ProductionForbidden was not denied: {denial}"
        )));
    }
    checks.push(pass(
        "approval.denial",
        "ProductionForbidden high-risk action was denied without Permit issuance",
    ));

    client.expect_ok(
        CompanionRequestPayload::SessionStop(companion::ipc::dto::RunIdPayload {
            run_id: "run-ticket47".to_string(),
        }),
        "session.stop",
    )?;
    let stopped = request_permit_response(
        client,
        &session_id,
        action_click(
            "emergency-stop-denial",
            "graph-ticket47",
            &delete_node,
            Some("Invoke"),
        ),
        Risk::Normal,
        None,
    )?;
    if response_payload(&stopped)?
        .get("status")
        .and_then(Value::as_str)
        != Some("emergency_stopped")
    {
        return Err(native_check(format!(
            "post-stop permit was not emergency_stopped: {stopped}"
        )));
    }
    checks.push(pass(
        "emergency-stop.denies-new-actions",
        "Session stop latched Emergency Stop and denied subsequent Permit requests",
    ));
    client.expect_ok(
        CompanionRequestPayload::AppShutdown(SessionIdPayload { session_id }),
        "approval-timeout app.shutdown",
    )?;
    checks.push(pass(
        "approval.denial-path",
        format!(
            "{} exercised denial and emergency-stop branches without direct UIA/PID access",
            project.display()
        ),
    ));
    Ok(())
}

fn check_high_risk_approval_timeout(
    companion_exe: &Path,
    harness_exe: &Path,
    cert_fingerprint: &str,
    project: &Path,
    exe: &Path,
    checks: &mut Vec<CheckEvidence>,
) -> HarnessResult<()> {
    let pipe_prefix = format!("qualigence-ticket47-timeout-{}", std::process::id());
    let mut daemon = start_companion_daemon(
        companion_exe,
        harness_exe,
        &pipe_prefix,
        cert_fingerprint,
        false,
    )?;
    let mut client = CompanionPipeClient::connect(&daemon.pipe_path)?;
    client.handshake()?;
    let app_dir = exe
        .parent()
        .ok_or_else(|| prereq("missing app output directory"))?;
    let target = app_target("approval-timeout", exe, harness_exe, app_dir);
    let payload = client.expect_ok(
        CompanionRequestPayload::AppLaunch(companion::ipc::dto::AppLaunchPayload { target }),
        "approval-timeout app.launch",
    )?;
    let session_id = string_field(&payload, "sessionId")?;
    let source = capture(&mut client, &session_id, 10_000, "approval-timeout capture")?;
    let delete_node = node_id_by_automation_id(&source, "DeleteAllButton")?;
    let high_risk = action_click(
        "high-risk-timeout",
        "graph-ticket47",
        &delete_node,
        Some("Invoke"),
    );
    let timeout =
        request_permit_response(&mut client, &session_id, high_risk, Risk::Destructive, None)?;
    if response_payload(&timeout)?
        .get("status")
        .and_then(Value::as_str)
        != Some("timed_out")
    {
        return Err(native_check(format!(
            "high-risk approval prompt did not time out: {timeout}"
        )));
    }
    client.expect_ok(
        CompanionRequestPayload::AppShutdown(SessionIdPayload { session_id }),
        "approval-timeout app.shutdown",
    )?;
    daemon.shutdown();
    checks.push(pass(
        "approval.timeout",
        format!(
            "{} high-risk approval prompt timed out without Permit issuance when no scripted approval was configured",
            project.display()
        ),
    ));
    Ok(())
}

fn app_target(technology: &str, exe: &Path, harness_exe: &Path, app_dir: &Path) -> AppTarget {
    AppTarget {
        target_id: format!("windows-reference-{technology}"),
        platform: DesktopPlatform::Windows,
        launch: AppTargetLaunch {
            executable: exe.display().to_string(),
            args: vec!["--reference-mode".to_string()],
            working_directory: Some(app_dir.display().to_string()),
        },
        process: AppTargetProcess {
            expected_image_name: exe
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "WindowsReference.exe".to_string()),
            allowed_child_image_names: Vec::new(),
        },
        window: AppTargetWindow {
            title_pattern: Some("Reference App".to_string()),
            automation_id: None,
        },
        reset: AppTargetReset {
            command: harness_exe.display().to_string(),
            args: vec![
                "--reset-reference-state".to_string(),
                app_dir.display().to_string(),
            ],
            timeout_ms: 10_000,
        },
        shutdown: AppTargetShutdown {
            graceful_timeout_ms: 5_000,
            force_after_timeout: true,
        },
    }
}

fn capture(
    client: &mut CompanionPipeClient,
    session_id: &str,
    deadline_ms: u64,
    context: &str,
) -> HarnessResult<UiaSource> {
    let payload = client.expect_ok(
        CompanionRequestPayload::UiaCapture(UiaCapturePayload {
            session_id: session_id.to_string(),
            deadline_ms,
        }),
        context,
    )?;
    serde_json::from_value(payload)
        .map_err(|e| native_check(format!("{context} returned invalid UiaSource: {e}")))
}

fn validate_reference_capture(
    technology: &str,
    source: &UiaSource,
    checks: &mut Vec<CheckEvidence>,
) -> HarnessResult<()> {
    for automation_id in [
        "UsernameEdit",
        "PasswordEdit",
        "RoleCombo",
        "SubmitButton",
        "ResultsList",
        "ResetButton",
    ] {
        node_id_by_automation_id(source, automation_id)?;
    }
    let password = source
        .nodes
        .iter()
        .find(|node| node.automation_id.as_deref() == Some("PasswordEdit"))
        .ok_or_else(|| native_check(format!("{technology} missing PasswordEdit")))?;
    if !password.is_password || password.value.as_deref() == Some(SECRET_PLAINTEXT) {
        return Err(native_check(format!(
            "{technology} password value was not masked"
        )));
    }
    if let Some(value) = password.value.as_deref() {
        if value != MASKED_VALUE {
            return Err(native_check(format!(
                "{technology} password mask used unexpected value"
            )));
        }
    }
    checks.push(pass("uia.capture", format!("{technology} captured real UIA tree with required AutomationIds and masked password metadata")));
    Ok(())
}

fn assert_no_secret_in_capture(source: &UiaSource, technology: &str) -> HarnessResult<()> {
    let text = serde_json::to_string(source)
        .map_err(|e| native_check(format!("{technology} capture serialization failed: {e}")))?;
    if text.contains(SECRET_PLAINTEXT) {
        Err(native_check(format!(
            "{technology} capture leaked secret plaintext"
        )))
    } else {
        Ok(())
    }
}

fn node_id_by_automation_id(source: &UiaSource, automation_id: &str) -> HarnessResult<String> {
    source
        .nodes
        .iter()
        .find(|node| node.automation_id.as_deref() == Some(automation_id))
        .map(|node| node.node_id.clone())
        .ok_or_else(|| native_check(format!("UIA capture missing AutomationId {automation_id}")))
}

fn execute_click_action(
    client: &mut CompanionPipeClient,
    session_id: &str,
    node_id: &str,
    technology: &str,
    id: &str,
) -> HarnessResult<()> {
    let action = action_click(
        &format!("{technology}-{id}"),
        "graph-ticket47",
        node_id,
        Some("Invoke"),
    );
    let permit = request_permit(client, session_id, action.clone(), Risk::Normal, None)?;
    let payload = action_execute_payload(session_id, action, permit, None, 10_000);
    let response = client.expect_ok(CompanionRequestPayload::ActionExecute(payload), id)?;
    if response.get("status").and_then(Value::as_str) == Some("ok") {
        Ok(())
    } else {
        Err(native_check(format!(
            "{id} action did not return ok: {response}"
        )))
    }
}

fn execute_value_action(
    client: &mut CompanionPipeClient,
    session_id: &str,
    node_id: &str,
    value_ref: &str,
    plaintext: &str,
    technology: &str,
    id: &str,
) -> HarnessResult<()> {
    let action = ResolvedDesktopAction {
        target_kind: TargetKind::Desktop,
        kind: DesktopActionKind::Input {
            value_ref: value_ref.to_string(),
        },
        action_id: format!("{technology}-{id}"),
        graph_id: "graph-ticket47".to_string(),
        node_id: node_id.to_string(),
        resolution: DesktopResolution::Semantic,
        uia_pattern: Some("Value".to_string()),
    };
    let binding = value_binding(value_ref, plaintext);
    let permit = request_permit(
        client,
        session_id,
        action.clone(),
        Risk::Normal,
        Some(binding.clone()),
    )?;
    let value = DesktopPlaintextValue {
        value_ref: value_ref.to_string(),
        value_sha256: binding.value_sha256,
        value_byte_length: binding.value_byte_length,
        plaintext: plaintext.to_string(),
    };
    let payload = action_execute_payload(session_id, action, permit, Some(value), 10_000);
    let response = client.expect_ok(CompanionRequestPayload::ActionExecute(payload), id)?;
    if response.get("status").and_then(Value::as_str) == Some("ok") {
        Ok(())
    } else {
        Err(native_check(format!(
            "{id} action did not return ok: {response}"
        )))
    }
}

fn execute_select_action(
    client: &mut CompanionPipeClient,
    session_id: &str,
    node_id: &str,
    selected: &str,
    technology: &str,
) -> HarnessResult<()> {
    let action = ResolvedDesktopAction {
        target_kind: TargetKind::Desktop,
        kind: DesktopActionKind::Select {
            value_ref: "RoleCombo".to_string(),
        },
        action_id: format!("{technology}-select-role"),
        graph_id: "graph-ticket47".to_string(),
        node_id: node_id.to_string(),
        resolution: DesktopResolution::Semantic,
        uia_pattern: Some("Selection".to_string()),
    };
    let binding = value_binding("RoleCombo", selected);
    let permit = request_permit(
        client,
        session_id,
        action.clone(),
        Risk::Normal,
        Some(binding.clone()),
    )?;
    let value = DesktopPlaintextValue {
        value_ref: "RoleCombo".to_string(),
        value_sha256: binding.value_sha256,
        value_byte_length: binding.value_byte_length,
        plaintext: selected.to_string(),
    };
    let payload = action_execute_payload(session_id, action, permit, Some(value), 10_000);
    let response = client.expect_ok(
        CompanionRequestPayload::ActionExecute(payload),
        "select role",
    )?;
    if response.get("status").and_then(Value::as_str) == Some("ok") {
        Ok(())
    } else {
        Err(native_check(format!(
            "select role did not return ok: {response}"
        )))
    }
}

fn request_permit(
    client: &mut CompanionPipeClient,
    session_id: &str,
    action: ResolvedDesktopAction,
    risk: Risk,
    value_binding: Option<DesktopValueBinding>,
) -> HarnessResult<LocalExecutionPermit> {
    let response = request_permit_response(client, session_id, action, risk, value_binding)?;
    let payload = response_payload(&response)?;
    if payload.get("status").and_then(Value::as_str) != Some("approved") {
        return Err(native_check(format!("permit was not approved: {payload}")));
    }
    let permit = payload.get("permit").cloned().ok_or_else(|| {
        native_check(format!("approved permit response lacked permit: {payload}"))
    })?;
    serde_json::from_value(permit).map_err(|e| {
        native_check(format!(
            "permit response did not match LocalExecutionPermit: {e}"
        ))
    })
}

fn request_permit_response(
    client: &mut CompanionPipeClient,
    session_id: &str,
    action: ResolvedDesktopAction,
    risk: Risk,
    value_binding: Option<DesktopValueBinding>,
) -> HarnessResult<Value> {
    let decision_id = format!("decision-{}", action.action_id);
    let policy_id = "ticket47-native-policy".to_string();
    let expires_at = future_iso_like();
    let nonce_base64 = BASE64.encode(format!("nonce-{}", action.action_id));
    let digest = desktop_action_digest_sha256(
        session_id,
        "run-ticket47",
        &action,
        &decision_id,
        &policy_id,
        risk,
        &expires_at,
        &nonce_base64,
        value_binding.as_ref(),
    );
    let authorization = LocalPermitAuthorization {
        decision_id,
        policy_id,
        action_digest_sha256: digest,
        risk,
        expires_at: expires_at.clone(),
        nonce_base64,
        value_binding,
    };
    let request = LocalPermitRequest {
        approval_id: format!("approval-{}", action.action_id),
        session_id: session_id.to_string(),
        run_id: "run-ticket47".to_string(),
        action,
        authorization,
        safe_summary: "Ticket 47 native reference app check".to_string(),
        expires_at,
    };
    client.request(CompanionRequestPayload::PermitRequest(
        companion::ipc::dto::PermitRequestPayload { request },
    ))
}

fn action_click(
    action_id: &str,
    graph_id: &str,
    node_id: &str,
    pattern: Option<&str>,
) -> ResolvedDesktopAction {
    ResolvedDesktopAction {
        target_kind: TargetKind::Desktop,
        kind: DesktopActionKind::Click,
        action_id: action_id.to_string(),
        graph_id: graph_id.to_string(),
        node_id: node_id.to_string(),
        resolution: DesktopResolution::Semantic,
        uia_pattern: pattern.map(str::to_string),
    }
}

fn action_execute_payload(
    session_id: &str,
    action: ResolvedDesktopAction,
    permit: LocalExecutionPermit,
    value: Option<DesktopPlaintextValue>,
    deadline_ms: u64,
) -> companion::ipc::dto::ActionExecutePayload {
    companion::ipc::dto::ActionExecutePayload {
        session_id: session_id.to_string(),
        action,
        permit,
        value,
        deadline_ms,
    }
}

fn value_binding(value_ref: &str, plaintext: &str) -> DesktopValueBinding {
    DesktopValueBinding {
        value_ref: value_ref.to_string(),
        value_sha256: hex::encode(Sha256::digest(plaintext.as_bytes())),
        value_byte_length: plaintext.as_bytes().len() as u64,
    }
}

fn future_iso_like() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() + 300_000)
        .unwrap_or(300_000);
    format!("unix-ms:{millis}")
}

fn start_unrelated_same_name(exe: &Path, harness_exe: &Path) -> HarnessResult<Child> {
    let temp_dir = env::temp_dir().join(format!("qualigence-uia-unrelated-{}", run_id()));
    fs::create_dir_all(&temp_dir)
        .map_err(|e| native_check(format!("cannot create unrelated-process directory: {e}")))?;
    let copied = temp_dir.join(
        exe.file_name()
            .ok_or_else(|| native_check("target executable lacks a file name"))?,
    );
    fs::copy(harness_exe, &copied).map_err(|e| {
        native_check(format!(
            "cannot create same-name unrelated process helper: {e}"
        ))
    })?;
    Command::new(&copied)
        .arg("--sleep-until-killed")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            native_check(format!(
                "cannot start same-name unrelated process helper: {e}"
            ))
        })
}

fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = unsafe { GetExitCodeProcess(handle, &mut code) };
        unsafe {
            CloseHandle(handle);
        }
        ok != 0 && code == STILL_ACTIVE as u32
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

fn terminate_child(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn assert_action_failed_with(response: &Value, expected: &str, context: &str) -> HarnessResult<()> {
    if response.get("status").and_then(Value::as_str) == Some("error") {
        let message = response
            .get("error")
            .and_then(|e| e.get("safeMessage"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let code = response
            .get("error")
            .and_then(|e| e.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if code == expected || message == expected {
            return Ok(());
        }
    }
    if response.get("status").and_then(Value::as_str) == Some("ok") {
        if response_payload(response)?
            .get("status")
            .and_then(Value::as_str)
            == Some("failed")
            && response_payload(response)?
                .get("errorCode")
                .and_then(Value::as_str)
                == Some(expected)
        {
            return Ok(());
        }
    }
    Err(native_check(format!(
        "{context} did not fail with {expected}: {response}"
    )))
}

fn assert_error_code(response: &Value, expected_code: &str, context: &str) -> HarnessResult<()> {
    let code = response
        .get("error")
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if response.get("status").and_then(Value::as_str) == Some("error") && code == expected_code {
        Ok(())
    } else {
        Err(native_check(format!(
            "{context} did not return error code {expected_code}: {response}"
        )))
    }
}

fn response_payload(response: &Value) -> HarnessResult<&Value> {
    response
        .get("payload")
        .ok_or_else(|| companion_error(format!("Companion response lacked payload: {response}")))
}

fn string_field(value: &Value, field: &str) -> HarnessResult<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| native_check(format!("field {field} missing or not a string in {value}")))
}

fn number_field(value: &Value, field: &str) -> HarnessResult<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| native_check(format!("field {field} missing or not a number in {value}")))
}

fn sign_ecdsa(proof: &[u8]) -> HarnessResult<String> {
    let key = EcdsaSigningKey::from_pkcs8_pem(ECDSA_KEY).map_err(|e| {
        companion_error(format!("test runner private key could not be loaded: {e}"))
    })?;
    let signature: p256::ecdsa::Signature = key.sign(proof);
    Ok(BASE64.encode(signature.to_der()))
}

fn fingerprint(cert: &str) -> HarnessResult<String> {
    Ok(hex::encode(Sha256::digest(pem_der(cert)?)))
}

fn pem_der(cert: &str) -> HarnessResult<Vec<u8>> {
    let body = cert
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>();
    BASE64
        .decode(body)
        .map_err(|e| companion_error(format!("fixture certificate PEM decode failed: {e}")))
}

fn summary_markdown(document: &EvidenceDocument, evidence_path: &Path) -> String {
    let mut lines = vec![
        "# Ticket 47 Windows UIA daemon harness evidence".to_string(),
        String::new(),
        format!("- Status: `{}`", document.status),
        format!("- Evidence JSON: `{}`", evidence_path.display()),
        format!(
            "- Companion executable: `{}`",
            document.companion_executable
        ),
        format!("- Harness executable: `{}`", document.harness_executable),
        format!("- Companion pipe: `{}`", document.companion_pipe),
        format!("- uiAccess: `{}`", document.ui_access),
        format!("- Windows build: `{:?}`", document.machine.windows_build),
        String::new(),
        "## Apps".to_string(),
    ];
    for app in &document.apps {
        lines.push(format!(
            "- {}: PID {}, creation `{}`, process group `{}`, nodes {}",
            app.technology,
            app.process_id,
            app.process_creation_time,
            app.process_group_id,
            app.capture_node_count
        ));
    }
    lines.push(String::new());
    lines.push("Ticket 31 still owns local-console/RDP human checklist execution and two-person signatures.".to_string());
    lines.push(String::new());
    lines.join("\n")
}

fn pass(id: impl Into<String>, summary: impl Into<String>) -> CheckEvidence {
    CheckEvidence {
        id: id.into(),
        status: "pass",
        summary: summary.into(),
    }
}

fn prereq(message: impl Into<String>) -> HarnessError {
    HarnessError {
        code: "WindowsUiaPrerequisiteUnavailable",
        message: message.into(),
        exit: 11,
    }
}

fn companion_error(message: impl Into<String>) -> HarnessError {
    HarnessError {
        code: "WindowsUiaDaemonUnavailable",
        message: message.into(),
        exit: 12,
    }
}

fn native_check(message: impl Into<String>) -> HarnessError {
    HarnessError {
        code: "WindowsUiaNativeCheckFailed",
        message: message.into(),
        exit: 13,
    }
}

fn evidence_error(message: impl Into<String>) -> HarnessError {
    HarnessError {
        code: "WindowsUiaEvidenceWriteFailed",
        message: message.into(),
        exit: 14,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_certificate_fixture_fingerprint_is_stable() {
        assert_eq!(fingerprint(ECDSA_CERT).expect("fingerprint").len(), 64);
        assert_eq!(fingerprint(CA_CERT).expect("fingerprint").len(), 64);
    }

    #[test]
    fn value_binding_records_hash_and_length_without_plaintext() {
        let binding = value_binding("ref", SECRET_PLAINTEXT);
        let serialized = serde_json::to_string(&binding).expect("serialize");
        assert!(!serialized.contains(SECRET_PLAINTEXT));
        assert_eq!(binding.value_byte_length, SECRET_PLAINTEXT.len() as u64);
    }

    #[test]
    fn reset_helper_requires_one_directory_argument() {
        assert_eq!(run_reset_helper(&[]), ExitCode::from(11));
    }
}
