# 32 — Restore cross-platform quarantines

**What to build:** Remove the four temporary Windows quarantines and prove each behavior on both Windows and Linux without sleeps, platform shortcuts, or silent skips.

**Blocked by:** None for implementation. **Final release-resolution dependency:** Ticket 31 signed Windows native acceptance.

**Status:** claimed

## Tracked scope

This ticket owns exactly the four temporary Windows cases identified by the quarantine markers and the smallest production seams needed to make those same cases deterministic on Windows and Linux. Under the 2026-08-27 two-phase authority, this implementation may start now and merge after its deterministic code/platform evidence is clean; Ticket 31 signed human acceptance remains a hard input to final release/freeze convergence, not a prerequisite to this ticket's code work.

## Migration

No relational migration is allocated; existing and allocated closure migrations are unchanged. Remove each adjacent `TODO(Task 21): remove this Windows quarantine` and its `it.skipIf` only after that exact case is green on Windows and Linux. No replacement skip, platform no-op, timing-only assertion, broad process scan, or weakened file-permission assertion is allowed.

## Affected contexts

- `docs/contexts/deployment/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 3, 6.4, 8, 10, 11, 13, and 15.
- `CONTEXT-MAP.md` and the affected context documents above.
- The existing process lifecycle, SQLite close, Playwright browser ownership, and KMS signer public contracts in the Allowed Files.
- The exact four quarantine markers and their historical introducing evidence; no fifth quarantine is in scope.

## Allowed Files

This is the complete edit scope, including the named post-review platform acceptance workflows:

- `.scratch/remaining-production-closure/issues/32-restore-platform-quarantines.md` for ticket-local final evidence only
- `tests/component/local-launcher/start-stop.test.ts`
- `tests/component/skill-lifecycle/recording-to-replay.test.ts`
- `tests/component/web-execution/playwright-web-target.test.ts`
- `tests/contract/kms-local/skill-signing.test.ts`
- `apps/local-launcher/src/child-process-unit.ts`
- `apps/local-launcher/src/process-supervisor.ts` — maintainer-approved 2026-08-28 scope extension, limited to the detached Launcher owned-process identity verification and TERM/grace/force/reap lifecycle evidence required by this ticket; no broad PID/name scan or termination, second identity system, or public contract change.
- `apps/local-launcher/src/main.ts` — maintainer-approved 2026-08-28 scope extension, limited to capturing the originating Core/Runner child identity before detached-supervisor handoff and passing it to rollback/shutdown verification; validation failure must fail closed with zero signal/false reap. No public contract, second identity system, or broad PID/name scan/termination.
- `packages/target-adapters/web-playwright/src/browser-session.ts`
- `packages/storage-providers/kms-local/src/local-skill-signer.ts`
- `tests/helpers/windows-file-acl.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/windows-companion.yml`

The workflow files may change only to execute and retain Windows/Linux evidence for these four restored cases. Browser workflow, general CI composition, Self-hosted jobs, and release behavior remain ticket 33/34 work.

## Requirements

- [ ] Launcher termination proves observable TERM/grace/forced/reap events cross-platform.
- [ ] SQLite reopened runtime cleanup closes every handle deterministically.
- [ ] Browser process identity/lifecycle uses a repository-owned cross-platform seam.
- [ ] Signing-key permissions prove POSIX mode and Windows ACL restrictions with zero skips.
- [ ] `ChildProcessUnit` exposes observable process lifecycle events proving graceful termination request, grace expiry, forced termination request, and final reaping; elapsed time or “Windows exited quickly” is not escalation evidence.
- [ ] Reopened `SqliteRuntime` ownership uses deterministic `try/finally` cleanup and awaits `close()` on success and every thrown path; the temporary directory is immediately removable on Windows.
- [ ] Playwright captures only the launched browser identity through a repository-owned seam, closes it through adapter ownership, and proves it exited. `/proc` scans and termination of unrelated processes are forbidden.
- [ ] POSIX retains the `0600` key assertion. Windows verifies the ACL permits the current user and only required system/administrator principals, and grants no broad Users/Everyone access.
- [ ] `rg -n 'TODO\(Task 21\): remove this Windows quarantine' tests` returns no matches and exit code 1; all four declarations are ordinary tests and execute rather than skip.
- [ ] Separate Windows and Linux reports show all four cases passed with zero quarantine skip.

## Focused Gate

Run on the current implementation platform after each related change and after every review fix:

```bash
corepack pnpm vitest run tests/component/local-launcher/start-stop.test.ts tests/component/skill-lifecycle/recording-to-replay.test.ts tests/component/web-execution/playwright-web-target.test.ts tests/contract/kms-local/skill-signing.test.ts
rg -n 'TODO\(Task 21\): remove this Windows quarantine' tests
corepack pnpm typecheck
git diff --check
```

The expected `rg` result is no output and exit code 1. Any test skip or missing Chromium/platform facility is a failure/block, not acceptance.

## Post-review acceptance

- Automated Windows: on the exact reviewed head, run `corepack pnpm vitest run tests/component/local-launcher/start-stop.test.ts tests/component/skill-lifecycle/recording-to-replay.test.ts tests/component/web-execution/playwright-web-target.test.ts tests/contract/kms-local/skill-signing.test.ts`, then the marker `rg` command above. Retain the zero-skip job report through `.github/workflows/windows-companion.yml`.
- Automated Linux: run the same Vitest command, then the same marker `rg`. Retain the zero-skip job report through `.github/workflows/ci.yml`.
- Manual acceptance: N/A. These are automated cross-platform behaviors; ticket 31 owns human Windows acceptance.
- Release acceptance: both named platform artifacts must identify the same reviewed commit and contain all four executed cases with zero skips. Record their exact paths/hashes and reviewed commit under this ticket's `## Comments`. Missing either artifact keeps release verification blocked; ticket 32 does not publish a release.

## Delivery and review

Record base and reviewed SHAs in `## Comments`. Every review covers the four complete workflows and all Behavior Matrix rows, even when a commit changes one case. Fix core findings on this ticket and rerun the affected focused/platform evidence plus a fresh complete-matrix review. After five rounds with a core blocker, set this ticket to `needs-info`, block tickets 33-35, and request a maintainer decision. Do not create recursive remediation tickets. Only non-Critical advanced hardening may be deferred to a linked GitHub Issue.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary | Public result | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Child exits after graceful request | `started` at termination request | Stop succeeds | Observed lifecycle records request and reap | Repeated stop observes already-exited child without signaling unrelated PID | TERM/reap events and dead-child probe |
| Child ignores graceful request through grace deadline | `started` | Forced stop succeeds only after escalation | Grace expiry and forced request are observable | Escalation occurs once; duplicate stop is idempotent | TERM/grace/force/reap sequence |
| Cancellation/error before termination request | `not_started` | Stable cancellation/error | No process signal emitted | Caller may retry stop while ownership remains valid | Zero-signal assertion |
| Process identity changes/PID is no longer owned | `not_started` | Stable ownership/exit result | No unrelated process is affected | Re-probe owned child; never signal by stale identity | Owned-process seam evidence |
| Reopened SQLite runtime succeeds | `started` at database open; no external domain mutation beyond fixture | Replay result | Runtime closes all handles in `finally` | Reopening/replay remains deterministic | Immediate temp-directory deletion |
| SQLite assertion/setup throws after open | `started` | Original stable failure; cleanup still completes | Handles closed; no locked temp state | Retry uses a fresh runtime/directory | Failure injection plus deletion evidence |
| Browser launches and adapter closes | `started` at owned browser spawn | Close succeeds | Repository seam tracks owned browser only | Duplicate close is safe; no process resurrection | Captured identity and exit probe |
| Browser launch partially fails or close times out | `started` | Stable browser lifecycle error | Any acquired owned process is cleaned; unrelated processes untouched | Retry creates a fresh browser identity | Failure injection and owned-process-only evidence |
| POSIX key creation succeeds | `started` at key file create | Signer ready | Key exists with mode `0600` | Existing insecure file is rejected/repaired only per current public contract | Mode assertion and signing result |
| Windows key creation succeeds | `started` at key file create/ACL set | Signer ready | ACL grants only current user and required system/admin principals | Re-open revalidates ACL; no broad-principal tolerance | Parsed ACL evidence and signing result |
| Key permission/ACL application or verification fails | `started` if file was created | Stable fail-closed signer error | No usable insecure signer is reported; partial secret file is handled by existing ownership contract | Never continue with a no-op permission check | Injected ACL/mode failure and absent signing |
| Duplicate test/restart on either platform | `started` per isolated fixture | Same passing behavior | No leaked process, DB handle, browser, or key fixture crosses tests | Replay is isolated and deterministic | Repeated platform job evidence |
| Platform/Chromium/ACL tooling is unavailable | `not_started` | Stable non-zero infrastructure block | No skipped acceptance artifact | Retry only after provisioning required infrastructure | Failed job with stable reason, zero skip conversion |
| Test report/artifact write fails after behavior ran | `outcome_unknown` for release evidence | Platform acceptance fails | No valid named platform artifact exists | Rerun the whole four-test platform Gate; do not reconstruct success manually | Missing/invalid artifact blocks downstream release |

## Comments

- update - 2026-08-27: Tickets 15 and 21 are resolved. Ticket 32 remains blocked only by Ticket 31 human Windows native acceptance.
- update - 2026-08-27: Maintainer authorized code-first closure. Ticket 32 is the immediate implementation frontier. It must still produce real zero-skip Windows/Linux automated evidence; Ticket 31 is deferred only as a final release/freeze dependency, not replaced or waived.
- start - 2026-08-28: Fixed base `bb4d11b95098ce6bd604d3bc02d13f0fd798c334`; branch/worktree `ticket-32-restore-platform-quarantines` / `C:/Users/jieliu1/AppData/Local/Temp/pi-ticket-32`. Under the 2026-08-27 two-phase authority, Ticket 32 implementation and real zero-skip Windows/Linux automated evidence may complete before Ticket 31 human sign-off; Ticket 31 remains a final release/freeze dependency. Behavior Matrix: all 14 rows are applicable; no row is N/A. Planned focused Gate is the four named quarantine suites, required no-match `rg` check, typecheck, and diff check; post-review acceptance retains same-commit Windows/Linux zero-skip reports.
- scope — 2026-08-28: Maintainer authorized `apps/local-launcher/src/process-supervisor.ts` for Ticket 32 review1 remediation. The edit is limited to making the production detached shutdown path preserve/verify owned-process identity before every signal and emit the required TERM/grace/force/reap lifecycle evidence. It must neither add a public contract nor use PID/name broad scans or terminate unrelated processes.
- scope — 2026-08-28: Maintainer authorized `apps/local-launcher/src/main.ts` for Ticket 32 review2 remediation. The parent may capture originating Core/Runner child creation identity while it still owns the `ChildProcess` and pass it through the detached topology/handoff so rollback/shutdown revalidates that original identity. It must fail closed with zero signal and no false `reaped` record when identity is unavailable/mismatched; retain legacy `stop_requested` lifecycle evidence while adding precise graceful/grace/force/reap events.
