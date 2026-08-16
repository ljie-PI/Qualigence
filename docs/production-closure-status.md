# Production Closure Status Ledger

This committed ledger records independently repeatable closure evidence. A
passing component test alone never upgrades `production_wiring`; the named
composition root and its black-box Gate must both be evidenced. Commands below
were run without credentials, tokens, or connection strings.

## Current capability status

| capability | component | production_wiring | verification | evidence | commit |
|---|---|---|---|---|---|
| Admin CLI | complete | complete | passed | clean built-binary help, unknown-command, parsing, and fail-closed KMS checks | `f200d6d` |
| Direct Node entrypoints | complete | complete | passed | all seven built binaries execute their direct-entry guard; configuration-dependent daemons reject missing configuration | `603439b` |
| Local Launcher process gate | complete | complete | passed | clean built-binary init/start/status/doctor/backup/stop path with explicit Git OpenSSL discovery on Windows | `603439b` |
| Review task repository | complete | complete | passed | one shared contract passed against SQLite and tenant-scoped PostgreSQL, including idempotency-key binding and two-writer claim races | `3071da0` |
| Root Playwright CLI exposure | partial | partial | failed | `corepack pnpm exec playwright --version` cannot find the root executable; use the filtered adapter command until Task 21 defines root Gates | `d07c2eb` |

## Append-only evidence log

- 2026-08-16 — host: Microsoft Windows 11 Enterprise 10.0.26200 (build
  26200); clean detached worktree
  `D:\Workspace\Qualigence\.worktrees\production-closure-task4-gate`;
  `node --version` exited 0 (`v24.16.0`); `corepack pnpm --version` exited 0
  (`11.7.0`).
- 2026-08-16 — `corepack pnpm install --frozen-lockfile` exited 0; 326
  packages installed from the locked store; no lockfile change. This is the
  clean-install baseline, not the historical shared `node_modules` Junction.
- 2026-08-16 — `corepack pnpm exec playwright --version` exited 1 with
  `Command "playwright" not found`. The adapter owns `playwright`; the root
  package does not expose that executable. This is a documented root-Gate
  defect for Task 21, not a skipped browser check.
- 2026-08-16 — `corepack pnpm build` exited 0; TypeScript project build and
  Web Console Vite build both passed.
- 2026-08-16 — initial `tests/e2e/local-launcher.test.ts` run exited 1: 0
  passed, 1 failed. Root cause was `spawnSync openssl ENOENT` during local
  certificate creation. Git OpenSSL was present at
  `C:\Program Files\Git\usr\bin\openssl.exe` but absent from `PATH`.
- 2026-08-16 — after explicitly prepending
  `C:\Program Files\Git\usr\bin` to the Windows Gate `PATH`, the same Local
  Launcher E2E exited 0: 1 passed, 0 failed, 0 skipped. This follows the
  plan's required Windows OpenSSL resolution; it is not an infrastructure
  skip.
- 2026-08-16 — with that explicit Gate environment,
  `corepack pnpm vitest run tests/smoke/node-entrypoints.test.ts
  tests/e2e/admin-cli.test.ts tests/e2e/local-launcher.test.ts
  tests/migration/observation-v1/admin-command.test.ts` exited 0: 4 files,
  17 passed, 0 failed, 0 skipped. The smoke file covered Admin CLI, Local
  Launcher, Core Daemon, Runner, Server, Intelligence Worker, and Benchmark
  Runner.
- 2026-08-16 — `corepack pnpm typecheck` exited 0; `tsc -b`, test-project
  checking, and Web Console typecheck passed.
- 2026-08-16 — final focused repeat with the same four files exited 0: 4
  files, 17 passed, 0 failed, 0 skipped.
- Historical RED evidence retained: Task 1 (`f200d6d`) had no clean focused
  GREEN because the original worktree dependency Junction was incomplete;
  Task 2 (`603439b`) had only 5 of 7 smoke cases GREEN for the same reason.
  The clean-worktree results above supersede those verification blocks without
  rewriting their implementation commits.
- 2026-08-16 — Task 5 RED: the provider-neutral contract showed that SQLite
  returned the second task's aggregate when a claim or resolution idempotency
  key had already been bound to a different task. PostgreSQL already rejected
  those mismatches. The Windows Gate explicitly resolved Git OpenSSL and used
  Docker; no PostgreSQL case was skipped.
- 2026-08-16 — after SQLite bound replay to the stored `task_id`,
  `corepack pnpm vitest run tests/contract/review/sqlite-review-task-repository.test.ts
  tests/contract/review/postgres-review-task-repository.test.ts` exited 0:
  2 files, 18 passed, 0 failed, 0 skipped. Each PostgreSQL runner constructed
  its repository inside a separate `withTenant("tenant-a", ...)` callback;
  the concurrent claim assertion therefore used two real pool transactions.
- 2026-08-16 — with the same Docker and explicit OpenSSL Gate environment,
  `corepack pnpm vitest run tests/contract/review
  tests/contract/sqlite/investigation-review-store.test.ts
  tests/component/review/concurrent-claim.test.ts
  tests/e2e/web-console/review-conflict.test.ts
  tests/contract/public-api/api-v1.test.ts` exited 0: 6 files, 46 passed,
  0 failed, 0 skipped.
- 2026-08-16 — `corepack pnpm typecheck` exited 0 after the provider contract
  and adapter update.
