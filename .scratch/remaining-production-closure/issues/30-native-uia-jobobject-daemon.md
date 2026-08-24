# 30 — Implement native UIA, Job Object, and Companion daemon

**What to build:** Deliver the actual Windows Companion daemon with contained application lifecycle, restartable UIA child, one-use permits, and Emergency Stop.

**Blocked by:** 29 — Implement native Windows Named Pipe authority.

**Status:** ready-for-agent

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
