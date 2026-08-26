# 30 â€” Implement native UIA, Job Object, and Companion daemon

**What to build:** Deliver the actual Windows Companion daemon with contained application lifecycle, restartable UIA child, one-use permits, and Emergency Stop.

**Blocked by:** 29 â€” Implement native Windows Named Pipe authority.

**Status:** needs-info

## Tracked scope

This ticket owns native UIA capture/action, Job Object application lifecycle, daemon/tray routing, and native WPF/WinUI automated E2E. Ticket 31 owns independent manual acceptance and signatures.

## Migration

No relational migration is allocated; existing and allocated closure migrations are unchanged. Replace the `WindowsUiaCapture` and `WindowsDesktopProcessHost` error-only seams in place. Portable state-machine and synthetic tests remain supporting contract evidence, never a native-completion fallback.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/windows/CONTEXT.md`

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 3.1, 4, 6.2-6.5, 7, 8, 10, 11, 13, 14.3, and 15.
- `CONTEXT-MAP.md` and the affected context documents above.
- `docs/testing/windows-m3-manual-checklist.md`, especially sections 5-13 and 16.
- The Desktop IPC, Graph v1, action, and Permit public contracts already exposed by `packages/contracts/desktop`, `packages/contracts/observation`, and `packages/runner-kernel`.

## Allowed Files

This is the complete edit scope, including post-review native acceptance:

- `.scratch/remaining-production-closure/issues/30-native-uia-jobobject-daemon.md` for ticket-local final evidence only
- `Cargo.lock`
- `apps/companion/Cargo.toml`
- `apps/companion/src/uia/**`
- `apps/companion/src/process/**`
- `apps/companion/src/tray.rs`
- `apps/companion/src/main.rs`
- `tests/rust/companion/**`
- `tests/component/windows-uia/**`
- `tests/replay/windows-uia/**`
- `tests/conformance/observation/windows-uia.test.ts`
- `tests/e2e/windows/companion-daemon.test.ts`
- `docs/testing/windows-m3-manual-checklist.md`

## Requirements

- [ ] Applications launch suspended, enter configured Job Object, then resume; reset/shutdown verify image, creation time, and membership.
- [ ] UIA runs in a bounded MTA child that is killed/restarted on timeout without losing Companion state.
- [ ] Permit/value digest is verified and consumed atomically before action; buffers are cleared after execution.
- [ ] Emergency Stop cancels in-flight work and latches denial until a new session; daemon routes every lifecycle request.
- [ ] The hidden `--uia-worker` initializes COM MTA and owns all UIA handles; the Companion main process owns authenticated IPC, approval/session state, deny latch, App Job, and worker supervision.
- [ ] Capture enforces request deadline and node/property bounds, maps Button/Edit/Password/List/Dialog and required patterns to Graph v1, preserves AutomationId/control type/framework/pattern source through `uia/v1`, and masks password values before serialization.
- [ ] Only supported Invoke/Value/Selection/Scroll/Window patterns execute; unsupported patterns return `UiaPatternUnsupported` without fallback.
- [ ] Worker timeout/corruption/exit kills and lazily replaces only the worker Job. Capture timeout is `TargetUnresponsive`; action timeout is `ActionOutcomeUnknown` and is never automatically replayed.
- [ ] `CreateProcessW` suspended, kill-on-close `CreateJobObjectW`, `AssignProcessToJobObject`, and `ResumeThread` occur in that order. Partial startup is cleaned without executing uncontained code.
- [ ] Shutdown/reset act only on verified PID plus creation time and Job membership, never image name. Packaged/protected/elevated targets fail as `AppLifecycleUnsupported` or `UiaAccessDenied`, with no breakaway/elevation fallback.
- [ ] `action.execute` revalidates the complete local Permit/action/value binding, atomically consumes it before worker dispatch, clears bounded plaintext buffers after every outcome, and emits no secret plaintext.
- [ ] Default daemon mode routes launch/reset/shutdown/capture/permit/action/pause/resume/stop/close and keeps `uiAccess=false`.

## Focused Gate

Run on Windows 11 during implementation and after every code/test review fix:

```bash
cargo fmt --check
cargo build --workspace
cargo test --workspace
corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts
corepack pnpm typecheck
git diff --check
```

`Windows11Unavailable`, `CargoUnavailable`, or unavailable WPF/WinUI prerequisites block native completion; synthetic fixtures do not substitute.

## Post-review acceptance

- Automated native E2E, Windows 11 only: set `QUALIGENCE_WINDOWS_UIA_TEST=true`, run `cargo test --workspace --test companion_reference_app_scenario`, then `corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts tests/e2e/windows/companion-daemon.test.ts`, and remove the environment variable. The run must build/drive real WPF and WinUI fixtures and cover launch, capture, click/input/select/scroll/window, crash signal, reset, shutdown, worker hang/exit/corruption, and clean process teardown.
- Manual acceptance: N/A for resolving this ticket. Do not fill or sign the manual record here; ticket 31 owns independent local-console/RDP execution.
- Release acceptance: retain the native reports and reviewed-head SHA for `gate-windows-rust`, and record their exact paths/hashes under this ticket's `## Comments`; keep Graph v1 `candidate` and the milestone open.

## Delivery and review

Record base/reviewed SHAs in `## Comments`. Review the entire native/contract diff and every matrix row before provisioning the real fixtures. A code change after native E2E requires affected focused Gates, a fresh complete-matrix review, and a full E2E rerun. After five rounds with a core blocker, set this ticket to `needs-info`, block tickets 31-35, and request maintainer scope/ownership. Do not create recursive remediation tickets. Defer only non-Critical advanced hardening through a linked GitHub Issue.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary | Public result | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Valid AppTarget launches, captures, acts, resets, and shuts down | `started` at suspended process creation | Typed lifecycle/capture/action outcomes | Session tracks verified PID, creation time, opaque Job, UIA worker generation, Permit state, and deny latch | Lifecycle commands obey request/Permit idempotency; actions execute once | Native process order, Graph, action outcome, and clean Job teardown |
| Invalid/canonicalization-failed or unsupported AppTarget | `not_started` | `AppLaunchFailed` or `AppLifecycleUnsupported` | No App session/Job authority | Corrected new request only | Zero process creation evidence |
| Process created suspended but Job creation/assignment fails | `started` | `AppLaunchFailed` | No active App session; partial process is terminated | New launch starts from clean state; never resume partial process | Call ordering and zero-resume assertion |
| Packaged/protected/elevated/other-session target | `not_started` or suspended partial start only | `AppLifecycleUnsupported` or `UiaAccessDenied` | No active executable outside containment | No elevation, breakaway, or image-name fallback | Native rejection and cleanup evidence |
| Capture succeeds | `not_started` for external application mutation | Valid Graph v1 with lossless `uia/v1` and masked secrets | Observation/Artifact references are returned to Runner; Companion retains no raw evidence durably | Re-capture obtains fresh UIA objects | Schema conformance and secret scan |
| Capture validation, bounds, unsupported access, or pre-dispatch timeout fails | `not_started` | Structured capture error or `TargetUnresponsive` | Worker may be recycled; App/approval/session state remains | Capture may retry with a fresh worker/request under caller budget | Worker generation and no action evidence |
| Permit missing, expired, consumed, mismatched, denied, or ProductionForbidden | `not_started` | Stable local Permit/approval error | Permit remains rejected/consumed as appropriate; no action success | Never execute/replay with that Permit | Zero UIA dispatch and binding matrix |
| Valid Permit and action complete | `started` only after atomic Permit consumption | Typed `ActionOutcome` | Permit is consumed exactly once; value buffer cleared | Duplicate action/Permit is rejected | One consume, one worker dispatch, buffer-clear evidence |
| Cancel/timeout before worker action dispatch | `not_started` after no Permit consumption, or `started` if consumption is already atomic | Stable cancellation/timeout reflecting boundary | No fabricated action success; consumed Permit is never restored | Fresh authorization required if consumed | Dispatch/consume ordering evidence |
| Worker action timeout, corruption, or exit after dispatch | `outcome_unknown` | `ActionOutcomeUnknown` | Consumed Permit remains consumed; worker recycled; App/Companion state remains | Never automatic replay; human/new action required | One dispatch, worker restart, unknown terminal result |
| Emergency Stop before action | `not_started` | `EmergencyStopped` | Session deny latch set; no new Permit/action | Resume does not clear latch; only a new explicit Session does | Zero dispatch after stop |
| Emergency Stop during action | `outcome_unknown` | `EmergencyStopped`/unknown outcome without success fabrication | Worker request cancelled/killed; deny latch persists; App Job remains contained | No action replay; new Session required for later work | Cancel/restart and post-stop denial evidence |
| Concurrent requests or duplicate Permit replay | `not_started` for rejected duplicate; `started` for sole winner | Bounded/consumed error for losers | One atomic Permit winner and serialized bounded worker request | Duplicate never dispatches | Concurrency exactly-once evidence |
| Worker or Companion restart | `started` only for already launched App; old request may be unknown | Fresh worker is usable; old IPC/session/Permit authority is invalid | App Job survives worker recycle, not Companion authority loss; no stale Permit survives | Reauthenticate/reopen Session and re-observe; never replay old action | Generation/session invalidation evidence |
| Reset/shutdown sees PID reuse, image/creation mismatch, or non-Job same-name process | `not_started` | Stable lifecycle rejection | Verified Job members remain the only termination scope | Re-query verified membership; never kill by name/PID alone | Unrelated-process survival evidence |
| Terminal response/Trace handoff fails after native action | `outcome_unknown` | Connection/recording failure, never false success | Companion keeps consumed Permit; Runner owns durable Trace recovery | No native action replay; only result/Trace transport may retry | Consumed Permit plus absent duplicate dispatch |

## Comments

### start - 2026-08-26

- Fixed base: `6a0a0adc0ae35359e137d89163b72bca38c65a51` (`main` after Ticket 29 PR #120 merge), verified as the current worktree head before edits.
- Predecessor evidence: Ticket 29 is `resolved`; PR #120 merged as `6a0a0adc0ae35359e137d89163b72bca38c65a51`; reviewed code/test head `16f4f90df56a21e589d64b3748fdbb90180a6cb4`; final Ticket 29 gates recorded in `.scratch/remaining-production-closure/issues/29-native-windows-pipe-authority.md` passed, including native Rust Gate, `tests/e2e/windows/named-pipe-authority.test.ts`, the current named-pipe Companion client contract, `corepack pnpm typecheck`, and `git diff --check`.
- Behavior Matrix applicability: applicable. The frozen matrix in this ticket governs native Windows suspended launch / Job assignment / resume ordering, reset/shutdown verification by PID plus creation time plus Job membership, bounded restartable UIA MTA worker lifecycle, Graph v1 `uia/v1` capture/masking/bounds/deadlines, supported-pattern-only actions, atomic Permit/value digest consumption before dispatch, Emergency Stop, default daemon routing, worker timeout/corruption/exit recovery, and no replay after `ActionOutcomeUnknown`.
- Planned focused Gate: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check`, `cargo build --workspace`, `cargo test --workspace`, `CI=true corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts`, `CI=true corepack pnpm typecheck`, and `git diff --check`.
- Scope guard: implementation is limited to the Ticket 30 Allowed Files. Ticket 31 owns independent manual/local-console/RDP evidence; signatures/checklist signoff, Graph v1 freeze, unrelated protocol/storage/product changes, public contract changes beyond existing Companion DTO behavior, and files outside the allowed list require explicit maintainer authorization before editing.
- Dependency approval: supervisor approved a narrow `windows` crate addition for `apps/companion` only, pinned to compatible `0.62.x` with minimal UIAutomation/COM/required Win32 feature set, because native UIA COM implementation is not practical through the existing low-level `windows-sys` surface alone.
- Scope amendment: supervisor approved a narrow `apps/companion/src/ipc/dto.rs` edit solely to align Rust `DesktopActionKind::Input/Select` serde with the existing public desktop IPC contract's `valueRef` camelCase field and to add direct Rust coverage that old `value_ref` input is rejected.

### review-fix - 2026-08-26

- Reviewed head fixed: `86281d4b8d377d5ee81fe8a14f10b3f5c168bfb7`; exact base remains `6a0a0adc0ae35359e137d89163b72bca38c65a51`.
- Findings addressed in this fix commit: default daemon now stays alive and dispatches authenticated pipe requests for probe/session control/app lifecycle/UIA capture/permit/action; UIA worker requests carry verified AppSession target authority (`sessionId`, PID, root HWND) and native capture/action starts from that root instead of the desktop root; Session Stop/Close invokes the Emergency Stop latch and worker cancellation hook; native worker spawn and reset-helper partial starts kill/wait partial children; capture traversal now fails on node/depth/property bounds instead of returning a truncated successful graph; native child enumeration uses the Windows process snapshot instead of an empty stub; action plaintext clones are cleared after dispatch; Window Focus requires Window pattern availability; a native daemon E2E entrypoint exists at `tests/e2e/windows/companion-daemon.test.ts` and reports stable prerequisite blockers instead of skipping or claiming synthetic success.
- Fix commits: `bb84216cc409f406f89c80d9b495ff4343b91a4a` (core daemon/UIA/process fixes) and `8c48972ea4d1d5d0dcbe37517b83baf2426b45db` (native E2E prerequisite harness surface update).
- Gates run for this fix before commit: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check` (pass), `cargo build --workspace` (pass), `cargo test --workspace` (pass), `CI=true corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts` (pass: 5 files, 29 passed, 1 skipped), `CI=true corepack pnpm typecheck` (pass), `git diff --check` (pass). New E2E surface command `CI=true corepack pnpm vitest run tests/e2e/windows/companion-daemon.test.ts` failed with stable blocker `Windows11Unavailable` because `QUALIGENCE_WINDOWS_UIA_TEST=true`/local native WPF+WinUI prerequisites were not present for this run.
- Status remains `claimed`; no PR/final evidence is recorded in this review-fix update.

### review2-fix - 2026-08-26

- Reviewed head fixed: `61f815129be5f1720215c21e32737ef22e19e91c`; exact base remains `6a0a0adc0ae35359e137d89163b72bca38c65a51`.
- Findings addressed in this fix commit: default daemon `action.execute` is now handled on a bounded admitted worker thread while the authenticated pipe loop continues reading control frames; `session.stop`/`session.close` latch every Companion session and signal the worker cancellation token so an in-flight action cannot report success after the stop is observed. Already-issued permits rejected under the Emergency Stop latch now return a stable `EmergencyStopped` action outcome instead of the generic `LocalPermitInvalid` mapping.
- Findings addressed in this fix commit: Rust-side IPC validation and daemon dispatch now enforce the public `1..600000ms` bound for `uia.capture`, `action.execute`, reset helper timeouts, and shutdown graceful timeouts before worker/process dispatch.
- Findings addressed in this fix commit: native UIA capture now reports true `SelectionPattern` containers separately from `SelectionItemPattern`, and native `select` execution supports `Selection` containers by selecting a matching descendant `SelectionItem` from the verified AppSession subtree.
- Fix commits: `3d64b7be0f72fd7320de286d36dcaf9cd5e130b7` and `55a4bc7179666981e99bc181c9a48d6156ea6fbe`.
- Gates run after the code fix commits: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check` (pass), `cargo build --workspace` (pass), `cargo test --workspace` (pass), `CI=true corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts` (pass: 5 files, 31 passed, 1 skipped), `CI=true corepack pnpm typecheck` (pass), `git diff --check` (pass). Native E2E prerequisite command `CI=true corepack pnpm vitest run tests/e2e/windows/companion-daemon.test.ts` still fails closed with stable blocker `Windows11Unavailable` because `QUALIGENCE_WINDOWS_UIA_TEST=true`/local native prerequisites were not configured for this run.
- Status remains `claimed`; no PR/final evidence is recorded in this review-fix update.

### review3-fix - 2026-08-26

- Reviewed head fixed: `e295f9f102b5f3cb74a351b290bec1eae08a0f50`; exact base remains `6a0a0adc0ae35359e137d89163b72bca38c65a51`.
- Findings addressed in this fix commit: queued concurrent `action.execute` now waits for the serialized UIA supervisor under the original request deadline/cancellation checkpoint before consuming a Permit; expired/cancelled queued actions return before Permit consumption and worker dispatch; consumed actions dispatch with only the remaining request budget and no replayable success fabrication.
- Findings addressed in this fix commit: native worker dispatch checks cancellation/deadline before writing a worker request frame, and tests cover no dispatch after cancellation/deadline.
- Findings addressed in this fix commit: Rust AppTarget reset/shutdown timeout validation now accepts the public `0..600000ms` contract while keeping `uia.capture` and `action.execute` deadlines on `1..600000ms`.
- Findings addressed in this fix commit: `uia.capture` is handled on the cancellable worker path so `session.stop`/`session.close` can be processed by the single-instance pipe loop; in-flight capture cancellation maps to `EmergencyStopped`, and post-stop capture is denied until a new session.
- Findings addressed in this fix commit: Rust IPC/action handling enforces the public 64 KiB plaintext value bound for value bindings and plaintext payloads before Permit consumption or worker dispatch, with plaintext buffers cleared on rejection.
- Fix commits: `da8d124331538b0122021da8bb424467590df516` and `3bb6a9c6257070a98c3c9e5150d65f535dd0e397`.
- Gates run before the evidence update: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check` (pass), `cargo build --workspace` (pass), `cargo test --workspace` (pass), `CI=true corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts` (pass: 5 files, 31 passed, 1 skipped), `CI=true corepack pnpm typecheck` (pass), `git diff --check` (pass). Native E2E prerequisite command `CI=true corepack pnpm vitest run tests/e2e/windows/companion-daemon.test.ts` failed closed with stable blocker `Windows11Unavailable` because `QUALIGENCE_WINDOWS_UIA_TEST=true`/local native prerequisites were not configured for this run.
- Status remains `claimed`; no PR/final evidence is recorded in this review-fix update.

### review4-fix - 2026-08-26

- Reviewed head fixed: `667d31553916d201c4002dd5db2ef6670a098746`; exact base remains `6a0a0adc0ae35359e137d89163b72bca38c65a51`.
- Findings addressed in this fix commit: native `permit.request` now allows policy-imposed higher risk (`ExternalSideEffect`/`Destructive`) to cover an intrinsically `Normal` click so the local approval gate can prompt and issue a Permit; lower/understated policy risk is still rejected before Permit minting, and `ProductionForbidden` still flows to the fail-closed denial path. Action execution also revalidates that the Permit risk does not understate the local action-kind risk.
- Findings addressed in this fix commit: `AppTarget.window.titlePattern` and `AppTarget.window.automationId` are preserved into the native `AppLaunchSpec`, stored on `AppSessionState`, serialized to the UIA worker request target, and enforced during window/root selection. The process host selects a visible matching top-level HWND by host-observable title, and the UIA worker revalidates/searches same-process top-level UIA windows against title and AutomationId before capture/action; no matching selector fails closed with `AppTargetWindowNotFound`/launch failure.
- Findings addressed in these fix commits: shutdown now removes session authority only after host Job termination succeeds; the native Windows host checks the `TerminateJobObject` return value before dropping Job/process tracking. Reset success now propagates reset-helper Job termination failure instead of reporting success, while preserving the target AppSession authority; `app.reset`/`app.shutdown` host failures now surface stable `AppResetFailed`/`AppShutdownFailed` messages instead of misreporting launch success/failure semantics.
- Fix commits: `01abc56e4322a100923a703d28777bf045e04031` and `9d39c4c297367b7f61b56bd56674e098282ad15a`.
- Gates run before the evidence update: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check` (pass), `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo build --workspace` (pass), `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo test --workspace` (pass), `CI=true corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts` (pass: 5 files, 31 passed, 1 skipped), `CI=true corepack pnpm typecheck` (pass), `git diff --check` (pass). Native E2E prerequisite command `CI=true corepack pnpm vitest run tests/e2e/windows/companion-daemon.test.ts` failed closed with stable blocker `Windows11Unavailable` because `QUALIGENCE_WINDOWS_UIA_TEST=true`/local native WPF+WinUI prerequisites were not configured for this run.
- Status remains `claimed`; no PR/final evidence is recorded in this review-fix update.


### review5-fix - 2026-08-26

- Reviewed head fixed: `56c3db3c48e61aead623ba1791f9c41f10c51229`; exact base remains `6a0a0adc0ae35359e137d89163b72bca38c65a51`.
- Complete-matrix Standards review reported one remaining Important core blocker: selector-miss launch cleanup ignored a failed Job termination after the target process had already been resumed, which could leave an unreturned/untracked target process and Job authority.
- Fix commit: `e5250b4fac66abbde765bf9a4f631d0b0d25ffd8`. Selector-miss launch cleanup now retries through direct tracked-process termination plus a second Job termination attempt when the first `terminate_job` call fails, and a focused lifecycle regression covers the injected first-termination failure without retaining a session or running process.
- Gates run before the code fix commit: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check` (pass), `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo build --workspace` (pass), `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo test --workspace` (pass), `CI=true corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts` (pass: 5 files, 31 passed, 1 skipped), `CI=true corepack pnpm typecheck` (pass), and `git diff --check` (pass). Native E2E prerequisite command `CI=true corepack pnpm vitest run tests/e2e/windows/companion-daemon.test.ts` failed closed with stable blocker `Windows11Unavailable` because `QUALIGENCE_WINDOWS_UIA_TEST=true`/local native WPF+WinUI prerequisites were not configured for this run.
- Status remains `claimed`; no PR/final evidence is recorded in this review-fix update.


### post-review-acceptance-blocked - 2026-08-26

- Reviewed code/test head: `5324a6eaea1501c22fbecdd188051047b5e67244`. Complete-matrix review reported no core blockers: `Q:/Qualigence/.pi-subagents/artifacts/outputs/b646caa3-7f17-4328-98e1-b71dac74bdfd/ticket30-review6/standards.md` and `Q:/Qualigence/.pi-subagents/artifacts/outputs/b646caa3-7f17-4328-98e1-b71dac74bdfd/ticket30-review6/spec.md`.
- Final focused Gates passed at the reviewed head: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check`, `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo build --workspace`, `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo test --workspace`, `CI=true corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts` (5 files, 31 passed, 1 skipped), `CI=true corepack pnpm typecheck`, and `git diff --check`.
- Post-review native acceptance could not complete in this environment. With `QUALIGENCE_WINDOWS_UIA_TEST=true`, `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo test --workspace --test companion_reference_app_scenario` passed (3 tests), but `CI=true corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts tests/e2e/windows/companion-daemon.test.ts` failed closed: the component real-UIA placeholder reported `real Windows 11 UIA capture must be run manually by an operator`, and `tests/e2e/windows/companion-daemon.test.ts` reported `WindowsUiaPrerequisiteUnavailable: set QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS to the native daemon WPF/WinUI driver harness`. A non-opt-in E2E run also reports stable `Windows11Unavailable`.
- Status set to `needs-info`: code review is clean, but Ticket 30 is not PR-/closure-ready until a real Windows 11 interactive native daemon harness path is provided and the required post-review WPF/WinUI E2E passes. No final/PR evidence is recorded.
