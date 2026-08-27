# Windows native Companion daemon E2E

Ticket 47 provides a real Windows-only harness executable for the existing
`tests/e2e/windows/companion-daemon.test.ts` contract. Build it from the repo
root with the same Rust workspace gate used for the Companion:

```powershell
cargo build --workspace
```

The executable is emitted beside the production Companion daemon binary:

```text
target\debug\companion-daemon-harness.exe
```

The native E2E invokes the harness as:

```text
<QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS> <WPF_PROJECT> <WINUI_PROJECT>
```

For an operator run on a local interactive Windows 11 machine:

```powershell
$env:QUALIGENCE_WINDOWS_UIA_TEST = "true"
$env:QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS = "<repo>\target\debug\companion-daemon-harness.exe"
corepack pnpm vitest run tests/e2e/windows/companion-daemon.test.ts
```

Optional environment:

- `QUALIGENCE_COMPANION_DAEMON`: override the production Companion daemon path.
  If unset, the harness locates `companion.exe` next to itself.
- `QUALIGENCE_WINDOWS_UIA_HARNESS_EVIDENCE_DIR`: directory where the harness
  writes `windows-uia-daemon-harness-evidence.json` and `summary.md`. If unset,
  a new directory is created under `%TEMP%\qualigence-uia-harness\`.

The harness starts the production Companion daemon with `uiAccess=false`,
authenticates over the native named pipe using the existing certificate
challenge-response protocol, builds the supplied WPF and WinUI projects, launches
those compiled applications through Companion `app.launch`, captures them through
Companion `uia.capture`, and executes value, selection, invoke, permit replay,
permit mismatch, approval denial/timeout, Emergency Stop, malformed IPC,
reset/shutdown, and unrelated same-name process survival checks through real IPC.

It is not a substitute for Ticket 31. Ticket 31 still requires the signed
local-console/RDP Windows checklist, Section 16 veto review, and two-person
attestation before native release acceptance can be claimed.
