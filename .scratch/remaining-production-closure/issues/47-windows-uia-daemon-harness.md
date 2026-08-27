# 47 — Provide Windows UIA daemon acceptance harness

**What to build:** Provide a real, repo-owned Windows 11 native daemon acceptance harness for Ticket 31 so `QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS` points to an executable that drives the compiled WPF/WinUI reference apps through the production Companion daemon path.

**Blocked by:** 30 — Implement native UIA, Job Object, and Companion daemon.

**Status:** claimed

## Tracked scope

Ticket 31 is human-owned native acceptance and cannot be completed until a real harness exists. Ticket 47 owns the missing automation bridge only: an executable harness that the existing Windows daemon E2E can invoke as:

```text
<QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS> <WPF_PROJECT> <WINUI_PROJECT>
```

The harness must drive real Windows 11 native behavior through the production Companion daemon / IPC / Permit / UIA worker / Job Object path. It must not use the Linux synthetic `FakeReferenceCompanion`, static fixture JSON, `echo pass`, in-process UIA substitutes, or manual-only prose as a pass condition.

Ticket 47 does **not** replace Ticket 31's human checklist, local-console/RDP coverage, Section 16 veto review, or two-person signatures. It only makes the automated native prerequisite executable and evidence-producing so the human operators can run and cite it.

## Migration

None. This ticket may not add or modify a database/schema migration.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/deployment/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/protocol/CONTEXT.md`
- `docs/contexts/windows/CONTEXT.md`

## Authority

- `.scratch/remaining-production-closure/spec.md` native Windows, Desktop, release-evidence, and no-synthetic-evidence requirements.
- `.scratch/remaining-production-closure/issues/30-native-uia-jobobject-daemon.md` for the production Companion daemon/UIA/Job Object implementation this harness must exercise.
- `.scratch/remaining-production-closure/issues/31-windows-native-acceptance.md` for the human acceptance gate that consumes the harness output.
- `docs/testing/windows-m3-manual-checklist.md`, especially Sections 5-7, 9, 12, 16-18.
- `tests/e2e/windows/companion-daemon.test.ts` for the environment variable contract and invocation shape.
- `tests/fixtures/windows-reference-wpf/**` and `tests/fixtures/windows-reference-winui/**` for the reference applications and required UI structure.

## Allowed Files

This is the expected edit scope. If implementation requires production Companion seams beyond these paths, stop and obtain maintainer approval before editing because that may reopen Ticket 30 product authority.

- `.scratch/remaining-production-closure/issues/47-windows-uia-daemon-harness.md`
- `.scratch/remaining-production-closure/issues/31-windows-native-acceptance.md` only for dependency/blocker evidence
- `tests/e2e/windows/companion-daemon.test.ts`
- `tests/e2e/windows/**/README.md`
- `tests/e2e/windows/**/package.json`
- `tests/e2e/windows/**/*.{ts,tsx,js,mjs,cjs,rs,cs,ps1,cmd,json,toml}`
- `tests/fixtures/windows-reference-wpf/**`
- `tests/fixtures/windows-reference-winui/**`
- `tests/helpers/windows-*.ts`
- `apps/companion/**` only if a narrow test-only entrypoint or stable daemon CLI invocation is required and reviewed as part of this ticket
- `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, workspace/tsconfig files only when required for the harness build and kept narrowly scoped

Hard exclusions: do not weaken Ticket 30 security behavior, do not make `tests/e2e/windows/companion-daemon.test.ts` pass without a real native harness, do not modify release/freeze evidence consumers to accept synthetic Windows evidence, and do not add a second Runner identity/enrollment system.

## Requirements

- [ ] A documented command builds or locates a Windows executable suitable for `QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS`.
- [ ] The harness accepts exactly the WPF and WinUI project paths supplied by `tests/e2e/windows/companion-daemon.test.ts`, builds or locates the compiled apps, and fails with a stable non-zero error if prerequisites are missing.
- [ ] The harness starts or attaches to the production Companion daemon path with `uiAccess=false`; TypeScript/Node must not directly execute UIA or manage target PIDs.
- [ ] WPF and WinUI each pass launch, capture, supported action execution, value/selection/invoke coverage, password masking, reset, shutdown, and UIA worker restart evidence.
- [ ] Permit binding/replay/expiry/mismatch, approval denial/timeout, Emergency Stop, worker timeout, malformed/bounded IPC, and unsupported-pattern failures are exercised through real IPC and produce stable evidence.
- [ ] Job Object containment is proven from first instruction: create suspended, assign to Job, resume; shutdown/reset verify PID, creation time, image, and Job membership; unrelated same-name/PID-reuse processes are not killed.
- [ ] Harness output includes machine-readable evidence paths/IDs and a concise human-readable summary that Ticket 31 operators can cite in the manual checklist without exposing secret plaintext.
- [ ] Exit code `0` occurs only when all required native checks passed on real Windows 11 prerequisites. Missing Windows 11, .NET Desktop/Windows App SDK, harness dependency, certificate/key, Companion daemon, local interactive session, or required app fixture produces a stable non-zero prerequisite error.
- [ ] The existing `corepack pnpm vitest run tests/e2e/windows/companion-daemon.test.ts` passes on a correctly provisioned Windows 11 machine with `QUALIGENCE_WINDOWS_UIA_TEST=true` and `QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS` set to the built harness executable.
- [ ] Ticket 31 remains responsible for signed local-console/RDP checklist evidence; this harness result alone is not release/native acceptance.

## Focused Gate

Run during implementation and after every review fix on the implementation host:

```bash
cargo fmt --check
cargo build --workspace
cargo test --workspace --test companion_reference_app_scenario
corepack pnpm typecheck
git diff --check
```

If the harness adds a package-local unit/integration suite, include it in the focused Gate and record the exact command under `## Comments`.

## Post-review acceptance

After exact-head complete-matrix review reports no core Critical or Important findings, run on a real local interactive Windows 11 machine with required native prerequisites:

```powershell
$env:QUALIGENCE_WINDOWS_UIA_TEST = "true"
$env:QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS = "<path-to-built-harness-exe>"
corepack pnpm vitest run tests/e2e/windows/companion-daemon.test.ts
```

Retain the command output, harness evidence directory, and environment metadata. A missing harness, `Windows11Unavailable`, `WindowsUiaPrerequisiteUnavailable`, skipped native case, or synthetic/in-process pass keeps Ticket 47 open and keeps Ticket 31 blocked.

## Delivery and review

Record base/reviewed SHAs, harness build path, command output path/hash, focused Gate results, post-review native E2E result, and any residual Ticket 31 handoff notes under `## Comments`. Use the standard complete-matrix review process for the whole diff. After five review rounds with a remaining core blocker, set this ticket to `needs-info`, keep Ticket 31 blocked, and request maintainer direction. Non-Critical advanced hardening may be deferred to a GitHub Issue; do not implement it in this ticket unless promoted.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary | Public result | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Supported Windows 11 local interactive session with all prerequisites and valid apps | `started` at Companion/app launch | Harness exits 0 after all checks pass | Evidence directory records command, app identities, session metadata, and check results | Re-running creates a new evidence directory; never overwrite a prior signed run | Harness summary plus detailed evidence refs |
| Non-Windows, unsupported Windows build, locked/non-interactive desktop, missing .NET Desktop SDK/Windows App SDK, or missing fixture | `not_started` | Stable prerequisite failure | No native pass evidence is emitted | Retry only after environment provisioning | Non-zero exit and prerequisite diagnostic |
| Harness executable missing or not configured | `not_started` | `WindowsUiaPrerequisiteUnavailable` remains visible through E2E | Ticket 31 stays blocked | Configure/build the real harness; do not stub | Failed E2E output |
| Companion daemon cannot start/authenticate or uses wrong identity/certificate | `not_started` | Stable identity/daemon failure | No UI action or Permit consumption | Fix provisioning or product blocker; never weaken identity | Daemon/auth failure evidence |
| Valid app launch | `started` after create-suspended before resume | App session starts contained | PID, creation time, image, Job membership recorded | New session for retry | Launch containment proof |
| Partial launch before Job assignment/resume fails | `not_started` or `outcome_unknown` if OS accepted process start | Stable cleanup failure/success | No uncontained running target remains | Retry launches fresh process only after cleanup verified | Process cleanup evidence |
| Real UIA capture succeeds | `started` at worker capture request | Graph/source evidence available | Capture evidence redacts password/plaintext | Capture may retry after worker generation advance | WPF/WinUI capture refs |
| UIA worker hangs/exits/corrupts | `not_started` for capture or `outcome_unknown` for dispatched action | `TargetUnresponsive` or `ActionOutcomeUnknown` | Companion and App Job survive; worker generation advances | Capture may retry; action never auto-replays | Worker restart evidence |
| Valid authorized action | `started` after one-use Permit consumption | Action result observed and verified | Permit consumed once, action and value digest bound | Duplicate Permit/action fails | Action/Permit evidence |
| Permit missing/expired/consumed/mismatched or policy/approval denied | `not_started` | Stable denial | No target mutation | New explicit Permit/proposal only | Zero-action denial evidence |
| Emergency Stop before/during action | `not_started` or `outcome_unknown` after dispatch | Stop/unknown, never fabricated success | Deny latch blocks subsequent actions | New session required | Stop and post-stop denial evidence |
| Shutdown/reset with unrelated same-name or PID-reuse process present | `not_started` for unrelated process | Only owned Job target is reset/shutdown or mismatch is denied | Unrelated process remains alive | Re-identify owned app; never kill by name/PID alone | Before/after process proof |
| Harness evidence/log write fails after behavior ran | `outcome_unknown` | Harness exits non-zero; no acceptance claim | Partial evidence is marked invalid | Rerun full harness; never reconstruct pass manually | Write failure and invalid evidence marker |
| Cancel/timeout during harness | `outcome_unknown` | Non-zero/cancelled result | Cleanup attempted; no pass evidence | Operator reruns full harness after verifying cleanup | Timeout/cancel logs |

## Comments

- start — Created by maintainer direction after Ticket 30 merged and Ticket 31 was found to require `QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS` without any repo-owned or provided harness path. This ticket owns the missing executable harness; Ticket 31 remains the human signed native acceptance gate.

### start — 2026-08-27

- Fixed base: `5a5dfa00601d9a24f56b707350b0b5e3574a37ee` (`main` after Ticket 45 merge); dedicated branch/worktree `ticket-47-windows-uia-daemon-harness` / `C:/Users/jieliu1/AppData/Local/Temp/pi-ticket-47`.
- Dependency status: Ticket 30 is merged/resolved, so Ticket 47 is unblocked. Ticket 31 remains human-owned and blocked until this harness exists and real native evidence is produced.
- Behavior Matrix applicability: complete Ticket 47 matrix is applicable. Rows cover supported Windows 11/native prerequisite pass, stable prerequisite failures, missing harness, Companion identity/daemon failures, contained launch, partial launch cleanup, UIA capture, worker hang/restart, permit/action denial paths, Emergency Stop, unrelated process/PID-reuse protection, evidence write failure, and timeout/cancel. No row is declared N/A at start, but native post-review acceptance requires a real local interactive Windows 11 environment.
- Planned focused Gate: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check`, `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo build --workspace`, `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo test --workspace --test companion_reference_app_scenario`, `CI=true corepack pnpm typecheck`, and `git diff --check`; add any package-local harness suite discovered during implementation.
- Planned post-review acceptance after clean complete-matrix review: on real Windows 11 with native prerequisites, set `QUALIGENCE_WINDOWS_UIA_TEST=true` and `QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS=<built-harness-exe>`, then run `corepack pnpm vitest run tests/e2e/windows/companion-daemon.test.ts`. A missing native environment remains a stable prerequisite failure and does not complete Ticket 47.
