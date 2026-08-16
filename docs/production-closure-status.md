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

## Tasks 1, 2, and 4 — Runtime operations

The evidence below was produced in a clean detached worktree and is retained
separately from Task 0's release-blocking Windows quarantine.

| capability | component | production_wiring | verification | evidence | implementation commit |
|---|---|---|---|---|---|
| Admin CLI | complete | complete | passed | built-binary help, unknown-command, parsing, and fail-closed KMS checks | `f200d6d` / restacked `2f34d25` |
| Direct Node entrypoints | complete | complete | passed | all seven built binaries execute their canonical direct-entry guard; configuration-dependent daemons reject missing configuration | `603439b` / restacked `140b4ac` |
| Local Launcher process Gate | complete | complete | passed | built-binary init/start/status/doctor/backup/stop with explicit Git OpenSSL discovery on Windows | `603439b` / restacked `140b4ac` |
| Root Playwright CLI exposure | partial | partial | failed | root `pnpm exec playwright` cannot find the adapter-owned executable; Task 21 owns the corrected filtered Gate | `d07c2eb` |

### Runtime operations evidence log

- Node `v24.16.0` and Corepack pnpm `11.7.0` were used in the clean Task 4
  validation worktree; frozen install and build passed without a lock change.
- Root `corepack pnpm exec playwright --version` failed with `Command
  "playwright" not found`; this remains explicit failed evidence and is not an
  infrastructure skip. The adapter-filtered install command is owned by Task 21.
- The first Local Launcher E2E run failed because `openssl` was absent from
  `PATH`. Prepending `C:\Program Files\Git\usr\bin` made the same real E2E pass;
  no test or certificate check was skipped.
- `corepack pnpm vitest run tests/smoke/node-entrypoints.test.ts
  tests/e2e/admin-cli.test.ts tests/e2e/local-launcher.test.ts
  tests/migration/observation-v1/admin-command.test.ts` passed 4 files and 17
  tests with 0 failed and 0 skipped.
- `corepack pnpm typecheck` passed, including project, test, and Web Console
  type checking.
- A cold-worktree Runner subprocess once exceeded the original 10-second hang
  guard. Three direct launches failed closed correctly in 564–640 ms and three
  isolated smoke runs passed in 1.00 seconds each; the non-production hang guard
  was widened to 30 seconds. The 17-test focused Gate then passed again.
- Historical RED is retained: Tasks 1 and 2 originally lacked clean GREEN due
  to an incomplete shared dependency junction. The clean detached evidence
  above supersedes that environment block without rewriting product behavior.

### Restacked Product PR 1 verification (2026-08-17)

- Branch `codex/pr1-runtime-ops-restack` was created from merged P0 commit
  `7e24a9f`; `origin/main...HEAD` contains only Tasks 1, 2, and 4 source/tests
  plus this plan/status update, with no lockfile or quarantine change.
- `corepack pnpm install --frozen-lockfile` passed with pnpm `11.7.0`.
- `corepack pnpm build` and `corepack pnpm typecheck` both exited 0.
- With `C:\Program Files\Git\usr\bin` prepended to `PATH`, the four-file
  focused Gate passed 4 files and 17 tests with 0 failed and 0 skipped.
- The same environment ran `corepack pnpm test`: 137 files passed, 1 skipped;
  820 tests passed, 6 skipped, 826 total, 0 failed. The Q/P0 bounded baseline
  failure is therefore closed on the Product PR 1 tree. The six skips are the
  four documented Task 21 Windows quarantines plus two pre-existing explicit
  skips; no new skip was added.
- Task 21 and Linux evidence remain open. This Product PR 1 result closes only
  the temporary Local Launcher merge waiver; it is not release completion.
- Restacked Standards and Spec/architecture reviews passed after commit
  `19b3d8a`; both timeout-cleanup and plan-scope findings were addressed, with
  zero remaining Critical or Important findings.
