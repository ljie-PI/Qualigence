# Production closure status

## Task 0 — Windows test quarantine (2026-08-16)

component: complete
production_wiring: missing
verification: blocked
introducing_pr: Q / `codex/pr-preflight-windows-quarantine`

Q is intentionally test-only and adds no production Composition Root wiring.
This `missing` value does not imply that any product wiring is complete.

### Windows RED evidence

Platform: Windows; Node `v24.16.0`; Corepack pnpm `11.7.0`.

The unquarantined four-file command was run in the disposable detached worktree
`D:\Workspace\Qualigence\.worktrees\task0-baseline-validation` at `0713b8d`.
That tree had the exact tracked `pnpm-lock.yaml` from
`D:\Workspace\Qualigence\.worktrees\pr0-lockfile-repair` copied in as an
uncommitted validation-only replacement (SHA-256
`F1467CC5C66BF09B134336AB1C223757EEC77B8E03591470BA44C4B6768954B8`), then
completed `corepack pnpm install --frozen-lockfile` and `corepack pnpm build`.
`C:\Program Files\Git\usr\bin` was prepended only for the test command so the
known Git OpenSSL executable was available.

Command:

```powershell
$env:PATH = 'C:\Program Files\Git\usr\bin;' + $env:PATH
corepack pnpm vitest run tests/component/local-launcher/start-stop.test.ts tests/component/skill-lifecycle/recording-to-replay.test.ts tests/component/web-execution/playwright-web-target.test.ts tests/contract/kms-local/skill-signing.test.ts
```

Result: `4` failed files; `4` failed, `19` passed, `23` total tests; `0` skipped.

| File | Exact test | Windows RED | Task 21 remediation | Introducing commit / PR | Windows evidence | Linux evidence | removal_state |
|---|---|---|---|---|---|---|---|
| `tests/component/local-launcher/start-stop.test.ts` | `escalates SIGTERM to SIGKILL for a process that ignores SIGTERM` | `AssertionError: expected 0 to be greater than or equal to 300` — Windows process termination makes the minimum elapsed-time assertion non-portable. | Use observable process lifecycle events for SIGTERM request, grace expiry, forced termination request, and child exit. | `6bc2857f2e45720a85abff7a8f507adef7a81a92`; PR: pending (`codex/pr-preflight-windows-quarantine`) | RED command above: one named failure; post-commit command: skipped. | `LinuxExecutorUnavailable` | pending |
| `tests/component/skill-lifecycle/recording-to-replay.test.ts` | `records, induces, compiles, verifies, signs, promotes, reopens and replays` | `EBUSY: resource busy or locked, unlink ...qualigence.db-wal` — reopened SQLite runtime remains open during Windows temporary-tree cleanup. | Deterministically close every reopened `SqliteRuntime` before cleanup. | `6bc2857f2e45720a85abff7a8f507adef7a81a92`; PR: pending (`codex/pr-preflight-windows-quarantine`) | RED command above: one named failure; post-commit command: skipped. | `LinuxExecutorUnavailable` | pending |
| `tests/component/web-execution/playwright-web-target.test.ts` | `runs observe -> resolve -> execute -> artifacts -> close and reaps the browser` | `ENOENT: no such file or directory, scandir 'D:\\proc'` — process-leak assertion enumerates Linux `/proc`. | Replace `/proc` enumeration with a cross-platform owned browser-process lifecycle seam. | `6bc2857f2e45720a85abff7a8f507adef7a81a92`; PR: pending (`codex/pr-preflight-windows-quarantine`) | RED command above: one named failure; post-commit command: skipped. | `LinuxExecutorUnavailable` | pending |
| `tests/contract/kms-local/skill-signing.test.ts` | `generates a user-only private key and a publishable keyId` | `AssertionError: expected 438 to be 384` (`0o666` received vs `0o600`) — POSIX mode bits are not a Windows ACL contract. | Assert Windows ACL protection on Windows and POSIX `0600` mode bits on POSIX. | `6bc2857f2e45720a85abff7a8f507adef7a81a92`; PR: pending (`codex/pr-preflight-windows-quarantine`) | RED command above: one named failure; post-commit command: skipped. | `LinuxExecutorUnavailable` | pending |

### Validation dependency disclosure

Q starts from the frozen-lock failure whose P0 repair is intentionally separate.
The Q branch neither changes nor stages `pnpm-lock.yaml`. Post-commit validation
uses a new disposable detached tree based on Q with the exact tracked P0 lock
copied in as an uncommitted replacement; results are recorded here after that
validation completes.

### Post-commit Windows validation

The disposable detached worktree
`D:\Workspace\Qualigence\.worktrees\task0-6bc-validation` was based on the
stable implementation commit `6bc2857f2e45720a85abff7a8f507adef7a81a92`.
Its only source diff was the uncommitted P0 lock replacement above; that lock
was never staged on Q.

With the same command and Git OpenSSL-only PATH addition as the RED command,
the focused run passed with `3` files passed, `1` file skipped; `19` tests
passed, `4` skipped, `23` total. The four skips were the four ledger entries
above; no other focused test skipped.

`corepack pnpm install --frozen-lockfile`, `corepack pnpm build`, and
`corepack pnpm typecheck` passed. `git diff --check` passed in the validation
tree; `git diff --name-only` reported only `pnpm-lock.yaml`. `corepack pnpm test`
reported `134` files passed, `1` failed, `1` skipped; `808` tests passed, `1`
failed, `6` skipped, `815` total. Its only failure was the unrelated
`tests/e2e/local-launcher.test.ts` assertion that `config.yaml` exists after
`init`; none of the four quarantined tests failed.

Linux execution is blocked as `LinuxExecutorUnavailable`; this Windows-only Q
remains release-blocking until Linux evidence and Task 21 remove the four skips.

### Review and bounded merge waiver

Standards review and Spec/architecture review passed after commit `1e0fb06`;
both reported zero remaining Critical or Important findings. On 2026-08-16 the
user approved merging Q and P0 with the one disclosed pre-existing Local
Launcher `init` E2E failure. The waiver covers no other failure or skip and does
not change `verification: blocked`. Product PR 1 must merge next after P0 and
restore the full Windows suite to zero failures; otherwise the stack stops.
