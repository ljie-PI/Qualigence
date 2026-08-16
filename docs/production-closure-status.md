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
| Web Console OIDC ID Token | complete | complete | passed | real RS256 signatures and a local JWKS endpoint prove verification happens before claims are trusted; failure paths clear transient callback state | this commit |
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
- 2026-08-16 — PR 2 Standards and Spec/architecture review both found the
  SQLite Review adapter advanced the aggregate and wrote its idempotency audit
  in separate autocommit statements. New shared concurrent replay/key-reuse
  cases and SQLite audit-failure injection reproduced 3 claim failures and,
  after reverting the provisional resolution change, 3 equivalent resolution
  failures. The observed defects were duplicate task transitions, missing
  concurrent replay, and an aggregate left advanced after a rejected audit.
- 2026-08-16 — after reserving the idempotency key before compare-and-set in one
  SQLite transaction, deleting a losing reservation, and making one bounded
  `SQLITE_BUSY` replay attempt, the provider contract exited 0: 2 files,
  28 passed, 0 failed, 0 skipped. PostgreSQL passed the same shared cases without
  an adapter change because its repository is already transaction-bound.
- 2026-08-16 — the complete Task 5 regression command exited 0: 6 files,
  56 passed, 0 failed, 0 skipped. `corepack pnpm typecheck` then exited 0,
  including TypeScript project build, test-project checking, and Web Console
  production/type builds.
- 2026-08-16 — Task 6 dependency precondition: direct registry access did not
  complete in the diagnostic window. With the user-provided local HTTP proxy,
  an HTTPS registry request returned 200 and `corepack pnpm view jose version
  --json` exited 0 with `6.2.9`. `corepack pnpm --filter
  @qualigence/web-console add jose` then exited 0. TLS verification remained
  enabled and no permanent proxy or registry setting was written.
- 2026-08-16 — Task 6 security RED: the focused OIDC suite accepted an ID
  Token whose payload was changed after signing and returned subject
  `attacker` (1 failed, 6 passed). A second RED proved the verifier constructor
  initially accepted a runtime `HS256` allowlist (1 failed, 13 passed).
- 2026-08-16 — after adding the cached remote-JWKS verifier and runtime
  asymmetric-algorithm allowlist, `corepack pnpm vitest run
  tests/component/web-console/oidc-flow.test.ts --reporter=verbose` exited 0:
  1 file, 15 passed, 0 failed. The cases cover valid RS256 and ES256, payload tampering,
  unknown `kid`, disallowed ES256, rejected HS256 configuration, expiry,
  unavailable JWKS, wrong issuer/audience/nonce, tenant rejection, PKCE, and
  in-memory token/logout behavior.
- 2026-08-16 — `corepack pnpm --filter @qualigence/web-console typecheck`
  exited 0. `corepack pnpm typecheck` also exited 0, including the TypeScript
  project build, production Vite bundle, test project, and Web Console checks.
- 2026-08-16 — PR 3 Spec/architecture review confirmed the fail-closed verifier
  boundary but found the advertised ES256 success path untested. A real P-256
  issuer/JWKS callback case was added with `allowedAlgorithms: ["ES256"]`;
  production verification code was unchanged.
- 2026-08-16 — PR 1 isolation RED: `corepack pnpm install
  --frozen-lockfile` exited 1 because the main-branch lockfile referenced Vite
  8.1.5 without its exact peer-dependency snapshot. `corepack pnpm install
  --lockfile-only --fix-lockfile --ignore-scripts` through the explicit local
  proxy repaired only the locked peer graph; no manifest changed and TLS
  verification remained enabled. A subsequent `corepack pnpm install
  --frozen-lockfile` exited 0 and installed 326 locked packages.
- 2026-08-16 — PR 1 final focused Gate initially exited 1 with 16 passed and
  one Runner entrypoint timeout at the 10-second hang guard. Three direct
  Runner launches then failed closed correctly in 564–640 ms, and three
  isolated smoke cases passed in 1.00 seconds each. The deadline was therefore
  documented and widened to a 30-second hang guard for cold Windows worktrees;
  no production startup logic changed. The original four-file Gate then exited
  0 with 4 files and 17 tests passed, 0 failed, 0 skipped.
