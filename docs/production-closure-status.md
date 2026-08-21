# Production closure status

## Current authority view (2026-08-20)

This section is the current capability index. Detailed entries below are an
append-only evidence history; their historical `pending`, `not_run`, branch,
environment, and future-work statements are not current status when this table
supersedes them. Remaining implementation authority is the 2026-08-20 amendment
in `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`.

| Legacy Task/capability | component | production_wiring | verification | Current evidence or blocker |
|---|---|---|---|---|
| Tasks 1-2 Admin CLI and Node entrypoints | complete | complete | passed | PR #38; built-binary and seven-entrypoint evidence below |
| Tasks 3-5 Review routes/provider contracts | complete | complete | passed | PR #39; shared SQLite/PostgreSQL contract and public conflict envelope |
| Task 6 Console OIDC | complete | complete | passed | PR #40; 39 focused tests and final two-axis review |
| Task 7 Runner renewal | complete | complete | passed | PR #43; lease renewal focused Gate and final review |
| Tasks 8-9 Runner protocol/Core authority | complete | present | passed | PR5-R1 through PR5-R5, production activation merge `86ea179` |
| Task 10 durable Runner control | complete | present | passed | PR #60 plus follow-up evidence; provider-neutral SQLite/PostgreSQL contracts |
| Task 11 Local intake/Launcher loop | complete | present | passed | PR #66; built-process Local E2E and three final Gate groups |
| Task 15 deterministic execution policy | complete | present | passed | PR #63 and PR #65 provenance follow-up |
| Task 12 Self-hosted product/scheduling | partial | partial | blocked | Ticket 03 Target/Test Plan intake is implemented pending its dedicated PR; tickets 04-06 still own Mission scheduling/dispatch and Skill paths |
| Task 13 durable Intelligence processing | partial | missing | blocked | Remaining tickets 07-08; production durable lease/wakeup/result loop incomplete |
| Task 14 Self-hosted Runner/data plane | partial | missing | blocked | Remaining tickets 09-15; tenant application, Run/Trace/Artifact, Evidence, operations, and acceptance incomplete |
| Task 16 bounded Web execution | partial | missing | blocked | Ticket 16 contract expand complete; tickets 17-19 still own budgets, valueRef resolution, and bounded production Runtime |
| LS-09 exploration/Reference benchmark closure | partial | partial | blocked | Remaining tickets 20-21; release evidence does not yet use the configured Reference Model Profile end to end |
| Task 17 Observation Graph v1 live migration | partial | missing | blocked | Remaining tickets 22-25; Graph v1 remains `candidate` and live legacy use remains |
| Task 18 Desktop Runner path | partial | missing | blocked | Remaining tickets 26-28; production TypeScript Companion path incomplete |
| Tasks 19-20 native Windows Companion | partial | missing | blocked | Remaining tickets 29-31; native implementation and signed local-console/RDP evidence absent |
| Task 21 CI/release convergence | partial | missing | blocked | Remaining tickets 32-34; four quarantines, required CI, minimal images, SBOM/provenance/manifest incomplete |
| Task 22 status/Graph freeze | partial | missing | blocked | Remaining ticket 35; serialized release/native/migration evidence absent, so Graph remains `candidate` |

Current relational schema is version 8. Migrations 001-008 are immutable;
remaining allocations are 009 (Mission/Run/outbox and
its atomic dispatch wakeup),
010 (Intelligence leases/Result inbox), 011 (Intelligence wakeups/dispositions), 012
(Artifact upload authority), and 013 (Evidence lifecycle). No other migration is
 reserved without a reviewed plan amendment.

### Ticket 03 - Versioned Target and Test Plan product paths (2026-08-21)

component: complete
production_wiring: present
verification: passed; pending dedicated PR
pull_request: pending
implementation_commits: `a725475`, `5d9ae3a`, `804971d`, `75c2d06`, `6180d8c`

review_round_1_remediation: passed on 2026-08-21
review_round_2_remediation: passed on 2026-08-21
review_round_3_remediation: passed on 2026-08-21

- Round-3 authority adds exactly `apps/admin-cli/src/commands/migrate.ts`,
  `tests/conformance/storage/relational-schema.test.ts`,
  `tests/e2e/self-hosted/backup-restore.test.ts`, and
  `tests/unit/admin-cli/{backup,migrate}.test.ts` for dynamic/current schema 8
  expectations only. No Ticket 02 migration, backup, restore, or forward-upgrade
  behavior changes are authorized.
- Web Target construction and Mission intake require the canonical `startUrl`
  origin in `allowedOrigins`. Desktop Console revisions retain the complete
  existing `AppTarget` snapshot while changing edited fields.
- Mission create persistence atomically selects one complete idempotency-command
  winner; concurrent different commands return the winner's version and cannot
  mix Mission/Job snapshots. Shared SQLite/PostgreSQL provider coverage proves
  the race, and the real Console client/Server path proves stable replay plus the
  public `actualVersion` conflict/reload contract.
- PRD project revision allocation is serialized in provider authority, so
  concurrent distinct PRDs receive unique monotonic revisions.
- Round-3 focused non-E2E Gate passed 12 files / 102 tests with Docker
  PostgreSQL runtime, shared provider, real Public API/Console, storage
  conformance, and affected Admin compatibility coverage. Root
  `corepack pnpm typecheck` and `git diff --check` passed. No E2E was run before
  clean review.
- Exact-base Standards and Spec review of merge-base `17d9e87` through
  acceptance head `6180d8c` reported no Critical or Important findings.
  Post-review acceptance
  `corepack pnpm vitest run tests/e2e/web-console/target-test-plan.test.ts`
  passed 1 file / 1 test against the real Console client, Fastify Server, OIDC,
  and Docker PostgreSQL workflow.

- PRD identity, project revision assignment, immutable document construction,
  idempotent replay, and persistence now live in `TestPlanService`; the Fastify
  route is limited to authentication, request validation, DTO mapping, and safe
  error mapping.
- PostgreSQL schema/runtime/sequential-upgrade expectations are current through
  immutable migration 008. The shared SQLite/PostgreSQL provider contract now
  proves both Target create and update races return `TargetVersionConflict`
  carrying the current version from an authoritative head reread.
- Mission intake issues policy snapshots from the injected Clock and bounds
  expiry to the 60-second execution budget. A focused application test submits
  the resulting Job shape to `DeterministicRunnerPolicyGate` and proves Runner
  admission immediately after issuance.
- Desktop launch/reset argv now use a closed approved flag/value contract or
  opaque `ref:` values. Arbitrary plaintext values and environment fields are
  rejected while accepted `AppTarget` fields remain lossless.
- Console Target revisions use the loaded current version for updates. Target,
  Test Plan, and Mission conflict paths render safe `actualVersion` details and
  invalidate the exact queries needed to reload current state; rendered jsdom
  component tests exercise all three mutation conflicts.
- Round-2 focused non-E2E Gate passed 12 files / 96 tests with Docker PostgreSQL,
  including runtime migration and provider contracts, storage conformance,
  Public API, Admin migration/backup, and rendered Console tests. Root
  `corepack pnpm typecheck` and `git diff --check` passed. No E2E was run before
  clean review.

- Removed request-to-domain casting and direct Mission-table writes from Public
  API routes. Target, grounded Test Plan create/approve, and Mission creation now
  invoke application services; Mission creation calls `MissionCompiler` and the
  existing `PrdMissionRepository` seam and persists revision/jobs/dispatch data.
- Test Plan create/approve reloads the selected PRD content and validates its
  source hash, offsets, selector/script rejection, opaque value references, and
  claim references before deterministic server IDs or persistence.
- One provider-neutral product-intake contract runs unchanged against SQLite and
  Docker PostgreSQL. It proves immutable revisions, project consistency, PRD
  loading, and one-success/one-stable-conflict concurrent approval semantics.
- Desktop intake rejects secret-bearing launch/reset argv and environment-like
  fields while preserving every accepted `AppTarget` field. Console component
  coverage renders Web/Desktop Target, Test Plan, and Mission revision bindings.
- Round-1 focused Gate passed 8 files / 62 tests with PostgreSQL Docker and
  storage schema conformance; offline frozen install, `corepack pnpm typecheck`,
  and `git diff --check` passed. Rendered browser E2E remains intentionally
  unrun until clean review.

- Migration 008 exclusively adds immutable Target and Test Plan revision heads,
  append-only snapshots, expected-version CAS, and idempotency bindings. Historical
  migrations 001-007 remain unchanged.
- Shared domain/application ports are implemented by SQLite and PostgreSQL
  repositories. PostgreSQL uses the request-scoped transaction and forced RLS;
  the focused Docker contract proves cross-tenant invisibility.
- Public API and typed Console workflows create Web/Desktop Target revisions,
  approve Test Plan revisions with stable conflict envelopes, and create an
  approved Mission intake bound to exact Target version/hash, Test Plan version,
  project, and Runner. Ticket 04 still owns Run/attempt/outbox scheduling.
- Focused non-E2E Gate, root typecheck, and diff check passed on 2026-08-21.
  Rendered E2E was not run and remains gated on clean dedicated review.

Current execution host evidence: Windows 11; Node `v24.13.0`; Corepack pnpm
`11.7.0`; Docker client/server `29.6.2`; Cargo/rustc `1.96.1`. Cargo is no
longer unavailable, but a pinned toolchain, native Windows tests, real WPF/WinUI
scenarios, local-console/RDP execution, and two-person signed evidence remain
blocking. Git OpenSSL must be resolved explicitly from
`C:\Program Files\Git\usr\bin\openssl.exe` when it is not on `PATH`.

### Ticket 02 - PostgreSQL forward upgrades and backup guard (2026-08-20)

component: complete
production_wiring: present
verification: passed; pending dedicated PR merge
pull_request: `https://github.com/ljie-PI/Qualigence/pull/71`
remediation_ticket: `36`
remediation_pull_request: `https://github.com/ljie-PI/Qualigence/pull/74`
implementation_commits: `2c53cc2`, `b8860b5`, `1b887bc`, `338dbcf`

- PostgreSQL schema releases 001-007 now upgrade sequentially under an exclusive
  offline advisory lock, with each step transactional and failed steps resumable.
  Server, Worker, tenant transactions, and Worker queue operations take the
  shared runtime lock and refuse malformed, ahead, behind, or incomplete
  auxiliary schema state.
- Runtime roles retain forced RLS and cannot create schema objects. Worker Job
  locking uses its constrained security-definer function without granting direct
  mutation of Intelligence Job authority columns.
- Migration requires a newly verified, invocation- and target-bound durable
  backup. Backup and restore share canonical byte verification, and backup copies
  only Artifact bytes named by manifests visible in the exported PostgreSQL
  snapshot.
- Core Application no longer imports or references PostgreSQL Runtime. The
  Worker injects the storage-owned transaction guard, and the intelligence
  consumer retains a provider-neutral transaction interface.
- Round-1 blockers are fixed: Core has no advisory-lock key or fallback and
  every queue caller injects the provider-neutral transaction guard; PostgreSQL
  revokes database `TEMPORARY` from `PUBLIC` and both runtime roles while the
  owner retains it; startup and migration validate exact auxiliary tables,
  columns, primary keys, forced RLS, tenant policy, and runtime grants before a
  marker can be accepted or completed.
- Round-1 fix verification passed the amended focused Docker Gate at 6 files /
  32 tests with zero skips, plus `corepack pnpm typecheck` and
  `git diff --check`.
- Round-2 RED passed as evidence: the two Server/Worker startup files failed all
  7 tests because neither Composition Root supplied the configured Server role
  and Worker accepted no explicit Server-role configuration. Round-2 fixes make
  auxiliary policy/grant validation require that role, including a Docker case
  where both startup paths reject policy/grants reassigned to the Worker role.
  `aux-schema.ts` now uses a minimal generic Kysely/transaction constraint with
  no `any` or unsafe assertion. The three exact Worker component callers remain
  in the amended Ticket 02 scope and Gate; the Ticket 12 `compose.test.ts` diff
  was removed completely.
- Round-2 GREEN passed the full amended focused Docker Gate at 9 files / 46
  tests with zero skips, plus `corepack pnpm typecheck` and
  `git diff --check`. A fresh exact-base review and the dedicated PR remain
  pending.
- Round-4 scope adds only the existing Self-hosted `compose.yaml`, its
  non-secret `.env.example`, and a focused static Compose-rendering test. The
  migration, Server runtime, and Worker schema guard now use the same configured
  Server PostgreSQL role, including `WORKER_PG_SERVER_ROLE`; no Ticket 12
  behavior is included. `postgres-schema.ts` now uses the minimal Kysely schema
  and typed dynamic builder contracts with no `any` or assertion.
- Round-4 GREEN passed the amended Compose config Gate and the focused Docker
  Gate at 10 files / 47 tests with zero skips. No Compose or backup/restore E2E
  was run; fresh exact-base review remains required before E2E.
- Review round 5 left one Important acceptance finding: the prepared E2E starts
  from schema 7 and does not prove a persisted older schema upgrades through
  the production migrate command. Remediation Ticket 36 blocks merge.
- On Windows 11 with Docker 29.6.2, `corepack pnpm build` passed. The amended
  focused non-E2E Gate passed 6 files / 30 tests with zero skips, including real
  Docker-backed PostgreSQL upgrade, failure-resume, lock, role, and startup
  cases. `corepack pnpm typecheck` and `git diff --check` also passed.
- No E2E was run. `tests/e2e/self-hosted/backup-restore.test.ts` is prepared but
  remains gated on a clean exact-base review. No pull request exists yet, and
  component completion is not final verification until the dedicated PR merges.
- Remediation Ticket 36 now prepares that E2E from a real persisted PostgreSQL
  schema 1 created through the production role and migration primitives. It
  seeds source rows plus snapshot-visible Artifact manifests/object bytes,
  invokes production `runMigrate`, asserts exact history `[1,2,3,4,5,6,7]`, and
  restores the invocation/target-bound schema-1 backup into the wiped target for
  exact row and object-byte comparison. Restore integrity validation now checks
  only tenant tables released by the backup's recorded schema version.
- Remediation GREEN (2026-08-21): the amended Compose render passed and the
  Ticket 02 focused non-E2E Gate passed 10 files / 48 tests with zero failures
  or skips. `corepack pnpm typecheck` and `git diff --check` passed. The E2E was
  not run and evidence remains pending exact-base coordinator review, the
  post-review E2E, and the dedicated PR.
- Remediation review fixes (2026-08-21) remove the old-schema option from the
  shared PostgreSQL fixture completely and keep schema-1 role/migration setup in
  the authorized acceptance file. Independent literals now snapshot every
  column of every seeded `execution_runs` and `artifact_manifests` row, plus
  fixed object bytes, in stable order before migration, after production
  `runMigrate` reaches sequential history `[1,2,3,4,5,6,7]`, and after clean
  restore. The Compose render, focused Gate (10 files / 48 tests), typecheck,
  and diff check pass; no E2E was run before fresh review.
- The post-review E2E exposed a production migration defect: bounded
  `migratePostgres({ targetVersion: 1, roles })` reapplied catalog-wide RLS and
  grants after the step transactions and failed on future `prd_documents`.
  The PostgreSQL runtime contract now proves a partial target applies policies
  and grants only to version-1 tables and a subsequent forward upgrade applies
  them to later tables. `migratePostgres` bounds its final idempotent RLS pass
  to tables released through the target; `provisionPostgres` retains its
  compatible duplicate full-schema pass.
- Post-E2E fix verification (2026-08-21): the affected single Docker contract
  test passed 1 test, the Compose render passed, the Ticket 02 focused Gate
  passed 10 files / 49 tests with zero failures or skips, and
  `corepack pnpm typecheck` plus `git diff --check` passed. The E2E was not
  rerun after the code change; a fresh coordinator review is required first.
- The fresh remediation review reported no blocking findings. The final real
  schema-1 forward-upgrade/backup/restore E2E then passed 1 file / 3 tests with
  PostgreSQL and all expected source rows, manifests, and object bytes.
- Parent PR final verification after merging current `main` passed the focused
  Gate at 10 files / 49 tests and the separate backup/restore E2E at 1 file / 3
  tests. Compose rendering, root typecheck, and diff check passed. Final
  exact-head review reported no code/spec blocker; merge remains pending.

### Ticket 17 - Execution budget and model usage (2026-08-20)

component: complete
production_wiring: present
verification: pending dedicated remediation PR
pull_request: `https://github.com/ljie-PI/Qualigence/pull/72`
remediation_ticket: `37`
remediation_pull_request: `https://github.com/ljie-PI/Qualigence/pull/73`

- Model output limits and provider usage are preserved through the
  provider, Gateway, Model Agent, and Runner Runtime seams. Gateway transient
  retry and structured-output correction are each bounded to exactly one.
- `DeterministicExecutionBudget` enforces positive finite step, monotonic
  wall-clock, output-token, and consumed-token limits. Missing finite usage is
  classified as `ModelUsageUnavailable`; overruns retain consumed usage and
  classify as `ModelBudgetExceeded` before an action Permit is minted.
- Round-1 Spec blockers are fixed: `ModelUsageUnavailable` emits one
  infrastructure `error` Trace/completion while policy, step, wall-clock, and
  model-budget exhaustion retain the approved `blocked` classification.
- Gateway retry/correction accounting includes every attempted provider call,
  including usage attached to provider errors. Any attempted call with missing
  finite usage makes the logical invocation usage unavailable, so a later
  successful retry cannot conceal it; each attempt is charged exactly once.
- Runtime bounds observer, decision, resolver, policy, action, and verifier
  awaits by the remaining monotonic deadline and passes an abort signal through
  existing cancellation seams. It emits stable `WallClockBudgetExceeded` and
  clears per-run budget state in `finally`. Ticket 18 valueRef resolution and
  Ticket 19 bounded indexed execution remain pending and are not implemented.
- Round-1 affected single files passed: Runtime 24, Gateway 17, Model Agent 14,
  OpenAI-compatible provider 12. The exact row-17 focused Gate
  `corepack pnpm vitest run tests/unit/runner-kernel tests/unit/model-gateway tests/unit/runner-components/model-agent.test.ts tests/contract/model-providers/openai-compatible-model-provider.test.ts`
  passed 9 files / 101 tests. Root `corepack pnpm typecheck` and
  `git diff --check` also passed. Fresh exact-base review and dedicated PR merge
  evidence remain pending.
- Round-2 Important fix: abort during an in-flight retry or structured-output
  correction now throws a typed Gateway abort error carrying all known prior
  attempt usage and any usage reported by the interrupted attempt. Model Agent
  charges that aggregate exactly once before propagating wall timeout/abort;
  if the interrupted attempted call has no usage under the finite budget, it
  instead preserves `ModelUsageUnavailable`. Abort racing retains a rejection
  handler for late provider settlement, preventing unhandled late rejections.
- Round-2 affected files passed: Gateway 21 tests, Model Agent 17 tests, and
  Runtime 24 tests. The exact row-17 focused Gate above passed 9 files / 108 tests. Root
  `corepack pnpm typecheck` and `git diff --check` passed. No E2E was run per
  the ticket review-fix protocol; fresh exact-base review remains pending.
- Round-3 approved scope adds both production composition roots and their exact
  tests to Ticket 17 authority. Every attempted Gateway invocation now returns
  typed available/unavailable usage state, including parser defects and aborts;
  Model Agent charges known aggregate usage once before rethrow or stable budget
  classification.
- Aborted and failed invocation reports are emitted once with only de-identified
  context, status, safe code, and known token fields. Unknown usage stays marked
  unavailable and prompts, output, provider messages, abort reasons, and secrets
  are not copied into the report.
- Runtime bounds every Trace append by the same monotonic Run wall deadline and
  retains a rejection handler for late settlement. A deadline-exhausted terminal
  append is not falsely claimed as persisted.
- Objective-only limits no longer have Runner Kernel defaults. Standalone Runner
  composition supplies configured action timeout and required one-call token
  ceiling; Local CLI composition supplies the request action timeout and its
  required configured one-call token ceiling. The same ceiling bounds provider
  output and accumulated consumed tokens.
- Round-3 amended focused Gate:
  `corepack pnpm vitest run tests/unit/runner-kernel tests/unit/model-gateway tests/unit/runner-components/model-agent.test.ts tests/contract/model-providers/openai-compatible-model-provider.test.ts tests/unit/runner/job-executor.test.ts tests/component/web-execution/local-run-composition-root.test.ts`.
  Final verification passed 11 files / 122 tests, plus root typecheck and diff
  check. No E2E or full suite was run.
- Remediation Ticket 37 keeps reporting on the existing Gateway observer seam
  but separates the typed invocation outcome from report settlement. A success
  whose report rejects charges known usage once before propagating the report
  failure; a failed invocation whose report rejects charges known usage once
  and preserves the original model failure classification.
- Exactly one logical report is submitted per invocation. Observer settlement
  is bounded by the Runtime's existing abort signal and wall deadline, and the
  retained settlement handler prevents a late observer rejection from becoming
  unhandled after per-run budget state is cleared.
- Ticket 37 RED reproduced all three round-5 failures in
  `tests/unit/runner-components/model-agent.test.ts`: success plus observer
  rejection lost usage, success plus observer hang exceeded the test deadline,
  and failed invocation plus known usage was replaced by the observer error.
  GREEN passed the Ticket 17 focused Gate: 11 files / 125 tests. Root
  `corepack pnpm typecheck` and `git diff --check` passed. No full suite, E2E,
  or full-suite review was run per the remediation request. The scoped
  remediation Standards/Spec review reported no blocking findings; PR #73
  remains pending merge into the parent Ticket 17 branch.

### Ticket 16 - Multi-step Plan contract expand (2026-08-20)

component: complete
production_wiring: present
verification: pending dedicated PR merge
pull_request: `https://github.com/ljie-PI/Qualigence/pull/70`
implementation_commits: `3e65405`, `1578926`, `e0a722a`

- Runner Protocol accepts additive immutable indexed `navigate`, `click`,
  `input`, `select`, `scroll`, and `verify` steps while preserving existing
  objective-only Jobs and unindexed legacy plan snapshots.
- `select` carries only a Plan-owned `valueRef`; scroll is restricted to fixed
  directions and `small|page`, with an optional semantic target. Protobuf and
  gRPC mappers preserve every plan field and optional Trace `stepIndex`.
- Contract parsing and Runner Kernel admission reject malformed indices,
  unsupported actions/parameters, over-budget plans, and policy-disallowed
  indexed action kinds before execution. Production bounded execution remains
  owned by tickets 17-19.
- Focused Gate, `corepack pnpm typecheck`, and `git diff --check` passed on
  2026-08-20. No browser, product E2E, or full suite was run for this expand
  ticket.
- The expanded Files/Gate authority was explicitly approved after review proved
  Core pre-offer admission and production Trace recorders were required to
  satisfy lossless indexed-plan acceptance. Final focused verification passed
  124 tests, including the legacy SQLite Runner-control compatibility case.
- Clean-worktree verification passed 8 focused files / 112 tests after the
  required build, plus root typecheck and diff check. The final Standards and
  Spec review reported no blocking findings. Completion remains pending this
  ticket's dedicated PR and merge.

### Remaining authority reconciliation evidence

component: complete
production_wiring: not_applicable
verification: passed
pull_request: `https://github.com/ljie-PI/Qualigence/pull/69`
implementation_commit: `f3f1b82`
review_fix_commits: `23ef80b`, `6d7c9df`

- Document consistency checks cover all 35 tickets, the two dependency lanes,
  migrations 001-013, exact Files/focused Gates/post-review acceptance, current
  host facts, Evidence revoke-before-delete, and Graph set/order authority.
- `corepack pnpm typecheck` and `git diff --check` passed.
- Fresh exact-base Standards and Spec reviews reported no
  findings after the first-round authority fixes. This closure update receives
  one final exact-head review before ticket resolution.
- A supplemental final full-suite baseline was run with Git OpenSSL on `PATH` and
  `OPENSSL_CONF=C:\Program Files\Git\usr\ssl\openssl.cnf`. It reported 154
  passed files, 5 failed, and 1 skipped; 1110 tests passed, 9 failed, and 6
  skipped. The failures are outside this docs-only change: Detection Benchmark
  exploration-policy validation and SQLite cleanup, Local process timeout/reap
  tests, and the Core entrypoint's stale missing-config expectation. They are
  retained as failed baseline evidence, not counted as this ticket's Gate.
- Delivery rule: every remaining ticket uses one dedicated isolated branch,
  worktree, and pull request. Completion requires merge followed by deletion of
  the remote/local ticket branches and removal of its worktree. This tracked
  ledger records the PR URL and implementation/review heads before merge;
  GitHub PR metadata identifies the exact final head. The ignored local ticket
  records the resulting merge commit after merge without a second PR.

## Task 11 - Authenticated Local intake and Launcher loop (2026-08-19)

component: complete
production_wiring: present
verification: passed
implementation_commit: same commit as this ledger entry (`feat(local): close launcher core runner loop`)

Final Task 11 finding closure is committed separately through
`fix(local): close final task 11 lifecycle findings`. It makes post-start
publication transactional with zeroization and reverse-order rollback, keeps
unreaped process state diagnostic, derives reconciliation health from durable
SQLite blockers across restart, and records safe process lifecycle events for
foreground and detached shutdown evidence.

Final finding verification (Windows 11, Node 24, Corepack pnpm 11.7.0,
2026-08-19):

- Affected supervision/readiness set passed 5 files / 38 tests with one
  pre-existing Task 21 Windows quarantine skip.
- Task 11 Gate group 1 passed 10 files / 61 tests.
- Task 11 Gate group 2 passed 10 files / 103 tests, including the mandatory
  Docker-backed PostgreSQL Runner-control contract.
- Task 11 Gate group 3 passed 11 files / 85 tests with one pre-existing Task 21
  Windows quarantine skip. The built-process E2E passed 5 tests using real
  Launcher/Core/Runner, Chromium, model, and web fixture processes. It proved
  three post-start rollback failures, authenticated foreground shutdown
  (Windows stop-marker command; POSIX SIGINT/SIGTERM), Runner-before-Core
  reaping, detached stop order, and byte-level
  credential absence across config, every captured runtime state, logs, and
  SQLite for raw 32-byte, lowercase/uppercase hex, padded/unpadded base64, and
  base64url representations.
- `corepack pnpm build`, `corepack pnpm typecheck`, and `git diff --check`
  passed after the final source and ledger changes.
- Git OpenSSL was resolved with `C:\Program Files\Git\usr\bin` on `PATH` and
  `OPENSSL_CONF=C:\Program Files\Git\usr\ssl\openssl.cnf`; Docker and Chromium
  were available. No fake-process E2E fallback or environmental block occurred.

Final review fixes are committed separately as
`fix(local): harden intake lifecycle authority`. They preserve the Task 11
interfaces while enforcing stop-marker tuple/freshness authority, canonical
completion Job hash matching, recoverable retained reconciliation, authenticated
foreground quiesce, complete Launcher-to-Core configuration propagation,
header-first fd-3 collection, and strict HTTP target validation.

Final scoped review findings were closed by `fix(local): close final task 11
lifecycle findings`: constant-time session authorization, pre-bind bootstrap
expiry rejection, startup cleanup/zeroization, atomic no-overwrite marker claims,
platform-correct process-tree termination, private detached-supervisor helpers,
and foreground use of the same authenticated marker/quiesce lifecycle.

The exact-head scoped review fix `fix(local): close final scoped spec findings`
also makes persisted completion identity errors immediately integrity-blocking,
requires complete Local composition configuration, rejects unsafe host overrides,
and atomically claims runtime state before deleting only the matching topology.

Task 11 extends the existing `ProcessSupervisor`, `ChildProcessUnit`,
`RunnerControlStore`, Evidence read ports, Core application services,
`GrpcRunnerProtocolServer.connection`, `SqliteRuntime`, `BackupManager`, and
`MigrationGuard`. It adds no parallel lifecycle, connection registry, recovery
module, `DataDirLock`, Self-hosted composition, or automatic lease recovery.

RED evidence:

- With Git OpenSSL configured, the initial focused command failed 9 files / 1
  collected test. Eight suites failed to resolve the absent Local credential,
  session, HTTP, issuer, coordinator, and readiness modules/package exports;
  the stop-marker case failed because `parseStopRequest` did not exist.

GREEN evidence (Windows 11, Node 24, Corepack pnpm 11.7.0, 2026-08-19):

- `corepack pnpm build` passed with `npm_config_offline=true`; TypeScript and the
  Web Console Vite production build completed from the frozen installed graph.
- Task 11 Gate group 1 passed 10 files / 49 tests.
- Task 11 Gate group 2 passed 10 files / 101 tests, including Docker-backed
  PostgreSQL migration/schema and Runner-control contracts.
- Task 11 Gate group 3 passed 11 files / 68 tests with one pre-existing Task 21
  Windows quarantine skip. Its E2E used built Launcher/Core/Runner processes,
  the local OpenAI-compatible fixture, the web fixture, and real Chromium; it
  did not use `fake-process.mjs`.
- `corepack pnpm typecheck` passed, including build, test TypeScript, and Web
  Console typecheck. `git diff --check` passed.
- Git OpenSSL was resolved with `C:\Program Files\Git\usr\bin` on `PATH` and
  `OPENSSL_CONF=C:\Program Files\Git\usr\ssl\openssl.cnf`.
- No environmental block occurred. Docker PostgreSQL and Chromium both ran.

Final review-fix verification (Windows 11, Node 24, Corepack pnpm 11.7.0,
2026-08-19):

- `corepack pnpm build` passed after the final source change.
- Task 11 Gate group 1 passed 10 files / 59 tests.
- Task 11 Gate group 2 passed 10 files / 102 tests, including the mandatory
  Docker-backed PostgreSQL Runner-control provider contract.
- Task 11 Gate group 3 passed 11 files / 75 tests with one pre-existing Task 21
  Windows quarantine skip. The built-process E2E persisted Trace/Finding
  references, ignored a malformed stop marker, proved detached PID reaping,
  restarted and reconciled a durable completion, exercised nondefault session
  and retry policy values through production child env, and scanned
  config/runtime-state/logs/SQLite for raw credentials.
- `corepack pnpm typecheck` and `git diff --check` passed.
- Git OpenSSL was resolved with `C:\Program Files\Git\usr\bin` on `PATH` and
  `OPENSSL_CONF=C:\Program Files\Git\usr\ssl\openssl.cnf`; Docker 29.6.2 and
  Chromium were available. No environmental block occurred.

## SETUP-00 — Engineering context, issue tracker, and review guidance (2026-08-17)

component: complete
production_wiring: missing
verification: not_run
introducing_pr: SETUP-00 / `codex/pr-preflight-production-closure-plan`

SETUP-00 establishes repository engineering infrastructure: the ignored
project worktree location, GitHub Issue review-finding workflow, multi-context
navigation, and stabilized baseline contract fixture execution under parallel
load. It changes no product Composition Root, runtime behavior, migration,
manifest, or lockfile.

Evidence:

- `git check-ignore -v .worktrees/probe` resolves through `.gitignore`.
- `corepack pnpm test` passed with 139 passed files, 1 skipped (live), 894 passed tests, and 6 expected skips.
- `corepack pnpm typecheck` passed without error.
- `git diff --check` passed.
- The GitHub PR must record Standards and Spec/architecture review against its
  exact final head before a post-merge closure changes this row to `passed`.

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

## Tasks 3 and 5 - Review invariants

| capability | component | production_wiring | verification | evidence | implementation commit |
|---|---|---|---|---|---|
| Review HTTP mutations | complete | complete | passed | claim and resolve use aggregate handlers and preserve the safe version-conflict envelope | `7a5d4d7`, `bcdf329` |
| Review repository provider contract | complete | complete | passed | one shared contract runs against SQLite and tenant-scoped PostgreSQL with explicit tenant scope, complete-command idempotency, rollback injection, and two-writer races | `5cc3380`, `06877d6`, `d25076d`, `0a00a71`, `f4ec623` |

### Review invariants evidence log

- The initial provider-neutral contract exposed SQLite idempotency keys being
  replayed onto a different task. PostgreSQL already rejected that mismatch.
- After binding replay to the stored task and making SQLite transition plus
  audit persistence one transaction, the shared provider contract passed 28
  tests, including concurrent replay and audit-failure rollback.
- Advisory-lock trigger barriers then forced two independent PostgreSQL tenant
  transactions to overlap. Four RED cases reproduced same-command replay and
  unique-violation failures for claim and resolve.
- After merging PR #38, the dual-axis review found four blockers: repository
  tenant scope was implicit, idempotency replay was bound only to task ID,
  PostgreSQL lacked rollback injection evidence, and one required Docker E2E
  could skip silently. The follow-up made tenant ID explicit through the port,
  bound replay to every persisted command field, moved PostgreSQL persistence
  into the storage-provider package, added cross-tenant and rollback tests, and
  made Docker absence fail as `DockerUnavailable`.
- On the corrected merged tree, frozen install, build, and root typecheck passed.
  The complete focused Review command passed 6 files and 67 tests with 0 failed
  and 0 skipped, including real PostgreSQL two-writer overlap and both-provider
  complete-command replay cases.
- 2026-08-17 - host: Microsoft Windows 11 Enterprise; Node `v24.16.0`;
  Corepack pnpm `11.7.0`; implementation commit `f4ec623`.
- `corepack pnpm install --frozen-lockfile` exited 0 with no lockfile change.
- `corepack pnpm build` exited 0; root TypeScript build and Web Console Vite
  production build passed.
- `corepack pnpm typecheck` exited 0; production projects, test project, and Web
  Console typecheck passed.
- With `C:\Program Files\Git\usr\bin` prepended to the command `PATH`,
  `corepack pnpm vitest run tests/contract/review
  tests/contract/sqlite/investigation-review-store.test.ts
  tests/component/review/concurrent-claim.test.ts
  tests/e2e/web-console/review-conflict.test.ts
  tests/contract/public-api/api-v1.test.ts` exited 0: 6 files, 67 passed,
  0 failed, 0 skipped. Docker and PostgreSQL executed; no required suite skipped.

## Task 6 - Web Console OIDC ID Token verification

component: complete
production_wiring: complete
verification: passed

### OIDC evidence log

- 2026-08-16 - the initial security RED proved a signed token whose payload was
  modified after signing reached claim mapping. A second RED proved a symmetric
  `HS256` runtime allowlist was accepted.
- The cached remote-JWKS verifier and asymmetric `RS256 | ES256` allowlist then
  passed 15 focused tests covering real RSA/P-256 signatures, payload tampering,
  unknown keys, disallowed algorithms, expiry, issuer/audience/nonce, tenant
  rejection, cold-start JWKS outage, PKCE, and in-memory access-token storage.
- Post-merge dual-axis review found the production callback boundary incomplete:
  malformed transient/token responses and exchange failures did not always
  consume transient state; `sub` and token response fields were not fail-closed;
  runtime URLs/redirect binding were unvalidated; cached JWKS rotation lacked
  evidence. These findings defined the follow-up RED cases below.
- 2026-08-17 - host: Microsoft Windows 11 Enterprise; Node `v24.16.0`;
  Corepack pnpm `11.7.0`; Docker `29.6.1`; final implementation commit
  `4f9695c`.
- The follow-up required non-empty `sub`; validated access/ID token, Bearer type,
  and positive expiry; consumed transient state on every callback outcome;
  validated deployment URLs, algorithms, tenant/role mappings, and exact
  redirect binding; scrubbed callback values on failure; and proved cached JWKS
  rotation with a newly signed token.
- `corepack pnpm vitest run tests/component/web-console/oidc-flow.test.ts
  --reporter=verbose` exited 0 after review fixes: 1 file, 39 passed, 0 failed,
  0 skipped. The added cases cover JWKS network failure, OIDC error callbacks,
  exact static redirect queries, malformed roles, and bootstrap loopback policy.
- `corepack pnpm install --frozen-lockfile`, `corepack pnpm build`,
  `corepack pnpm --filter @qualigence/web-console typecheck`, and
  `corepack pnpm typecheck` all exited 0; `git diff --check` passed.
- With `C:\Program Files\Git\usr\bin` prepended to `PATH`, `corepack pnpm test`
  exited 0 on the final implementation commit: 140 files total, 139 passed and
  1 skipped; 899 tests total, 893 passed, 0 failed, and 6 expected skips. Four
  skips remain the reviewed
  Task 21 Windows quarantines; quarantined green is not release completion.
- Standards and Spec/architecture final reviews on commit `acde9f4` reported no
  findings after the final Gate counts were reconciled; the focused OIDC Gate
  was rerun and passed 39 tests.
- PR #40 merged Task 6 into `main` as merge commit `0753be7` on 2026-08-17.
  Together with PR #36 (`ceeb857`), PR #37 (`7e24a9f`), PR #38 (`0820fd5`),
  and PR #39 (`89002cc`), Tasks 1-6 are now merged. Task 21 and release closure
  remain open for the four Windows quarantines and all other pending Tasks 7-22.

## Task 7 - Runner lease renewal

component: complete
production_wiring: complete
verification: passed
implementation_commit: `a28da60`, review fixes through `634d9e8`
merged_pr: `#43`
merge_commit: `09afe8735b70a49e858fef377b41bb337567533b`

### Runner lease renewal evidence log

- 2026-08-17 - host: Microsoft Windows 11 Enterprise; Node `v24.13.0`;
  Corepack pnpm `11.7.0`.
- RED command: `corepack pnpm vitest run tests/unit/runner/job-executor.test.ts
  tests/unit/runner/lease-renewal-controller.test.ts` exited 1 before the
  controller existed: 2 failed files and 0 collected tests; the missing module
  was `apps/runner/src/lease-renewal-controller.ts`.
- Behavioral RED command after the required workspace build:
  `corepack pnpm vitest run tests/unit/runner/job-executor.test.ts` exited 1:
  1 failed and 3 passed tests. The renewal case expected the manually controlled
  `20_000` ms (`leaseDurationMs / 3`) wait but observed no wait and renew count
  remained 0, proving the existing executor never started lease renewal.
- GREEN command, with `C:\Program Files\Git\usr\bin` prepended to `PATH` and
  `OPENSSL_CONF=C:\Program Files\Git\usr\ssl\openssl.cnf`:
  `corepack pnpm vitest run tests/unit/runner/lease-window.test.ts
  tests/unit/runner/lease-renewal-controller.test.ts
  tests/unit/runner/job-executor.test.ts
  tests/component/core-runner/disconnect-recovery.test.ts` exited 0: 4 files,
  18 passed, 0 failed, 0 skipped.
- GREEN proves renewal starts after one third of the lease duration, replaces
  the current lease and action window, runs concurrently with execution, stops
  without another renew, permanently closes the action window on non-stop
  failure, prevents a new action, preserves the failure, and completes with the
  newest lease token.
- `corepack pnpm typecheck` exited 0 after the final implementation.
- `git diff --check` exited 0 after the final implementation.
- 2026-08-17 review-fix RED: `corepack pnpm vitest run
  tests/unit/runner/lease-renewal-controller.test.ts` exited 1 with 2 failed and
  3 passed tests. An in-flight `RunnerSession.renew` that never settled kept
  `run()` pending after `stop()`, and no renewal deadline wait existed.
- 2026-08-17 review-fix GREEN: with `C:\Program Files\Git\usr\bin` prepended to
  `PATH` and `OPENSSL_CONF=C:\Program Files\Git\usr\ssl\openssl.cnf`,
  `corepack pnpm vitest run tests/unit/runner/lease-window.test.ts
  tests/unit/runner/lease-renewal-controller.test.ts
  tests/unit/runner/job-executor.test.ts
  tests/component/core-runner/disconnect-recovery.test.ts` exited 0: 4 files,
  21 passed, 0 failed, 0 skipped. The added cases prove stop wins over a hung
  renew, deadline expiry fails closed with stable `LeaseRenewalTimeout`, and a
  late renew result cannot update the lease or action window.
- After the review fix, `corepack pnpm typecheck` and `git diff --check` exited 0.
- 2026-08-17 second-review RED: `corepack pnpm vitest run
  tests/unit/runner/lease-renewal-controller.test.ts
  tests/unit/runner/job-executor.test.ts` exited 1: 2 files, 3 failed and 8
  passed tests. Stop won an already-started renew and discarded its successful
  lease, renewal timeout did not close the session, and an `undefined` renew
  rejection was mistaken for fulfillment.
- 2026-08-17 second-review GREEN: with `C:\Program Files\Git\usr\bin` prepended
  to `PATH` and `OPENSSL_CONF=C:\Program Files\Git\usr\ssl\openssl.cnf`,
  `corepack pnpm vitest run tests/unit/runner/lease-window.test.ts
  tests/unit/runner/lease-renewal-controller.test.ts
  tests/unit/runner/job-executor.test.ts
  tests/component/core-runner/disconnect-recovery.test.ts` exited 0: 4 files,
  21 passed, 0 failed, 0 skipped. Stop now cancels only the interval; an active
  renew settles or reaches its deadline, successful settlement updates the
  completion lease, timeout best-effort closes the session before failing
  closed, and even an `undefined` rejection propagates.
- After the second-review fix, `corepack pnpm typecheck` and `git diff --check`
  exited 0. `verification` remains `not_run` pending final exact-head review.
- 2026-08-17 third-review RED: `corepack pnpm vitest run
  tests/unit/runner/lease-renewal-controller.test.ts` exited 1 with 1 failed and
  4 passed tests. When renew and subsequent `session.close()` both never
  settled, the renewal deadline fired but `run()` remained pending instead of
  failing closed immediately.
- 2026-08-17 third-review GREEN: with `C:\Program Files\Git\usr\bin` prepended
  to `PATH` and `OPENSSL_CONF=C:\Program Files\Git\usr\ssl\openssl.cnf`,
  `corepack pnpm vitest run tests/unit/runner/lease-window.test.ts
  tests/unit/runner/lease-renewal-controller.test.ts
  tests/unit/runner/job-executor.test.ts
  tests/component/core-runner/disconnect-recovery.test.ts` exited 0: 4 files,
  21 passed, 0 failed, 0 skipped. Timeout now closes the action window and
  aborts execution before fire-and-forget transport cleanup, then rejects with
  the same stable `LeaseRenewalTimeout`; a hanging or late-rejecting close cannot
  delay failure or create an unhandled rejection.
- After the third-review fix, `corepack pnpm typecheck` and `git diff --check`
  exited 0. `verification` remains `not_run` pending final exact-head review.
- The final exact-head Standards and Spec/architecture reviews must pass before
  a post-merge closure changes `verification` to `passed`.
- Final exact-head Standards and Spec/architecture reviews against
  `a9fd9b305db004cddc2036568afb0b30ce3f16cf...634d9e83741c025ccc030588859bd515c999f523`
  reported no findings. PR #43 merged as `09afe8735b70a49e858fef377b41bb337567533b`.

## PR5-SCOPE - Tasks 8-9 implementation scope repair

component: complete
production_wiring: missing
verification: not_run
introducing_pr: `codex/pr5-scope-prerequisite`

date: 2026-08-17
implementation_commits: `3f1fd03`, `cf72455`
merged_pr: `#44`
merge_commit: `bfd6da2977691704cb3d2e92872cada9be5bc326`

Static implementation preflight stopped before edits because Task 8's required
wrong-token renewal cannot be represented without adding the existing lease
token to the `RenewLease` protobuf message and updating client/error/type
conformance files outside its original Files block. Task 9 moves four services,
but their four direct-import unit tests were also outside its Files block.

This prerequisite changes only the temporary plan and status ledger. Its final
exact-head Standards and Spec/architecture reviews must pass before Tasks 8-9
resume.

- `git diff --check` exited 0 before commit `3f1fd03`.
- Initial exact-head review identified stale baseline text, incomplete Task 8-9
  commit file lists, and a missing commit-before-review step; review fixes must
  be committed separately and re-reviewed.
- Commit `cf72455` fixed every initial review finding and `git diff --check`
  exited 0. The follow-up Spec/architecture review reported no findings; the
  Standards review required this ledger evidence correction before final review.
- Final exact-head reviews against
  `09afe8735b70a49e858fef377b41bb337567533b...8a882c7a3c067b67c67f9329a11781c1198cf56c`
  reported no findings. PR #44 merged as `bfd6da2977691704cb3d2e92872cada9be5bc326`.

## PR5-ATOMIC - Tasks 8-9 compilable delivery boundary

component: complete
production_wiring: missing
verification: not_run
introducing_pr: `codex/pr5-atomic-scope`
date: 2026-08-17
implementation_commits: `1cd9cdb`, `d071374`

The implementation preflight proved Task 8 cannot be committed independently:
making `GrpcRunnerProtocolServer` require its application and authenticator
causes the existing production Core composition to fail typecheck, while Task 9
owns the only valid application composition. A compatibility default or fake
production application would violate Task 8.

This prerequisite changes only the plan and status ledger. It requires Tasks 8
and 9 to retain separate RED behavior but ship as one compilable commit, joint
Gate, and exact-head two-axis review.

- Task 8 focused RED command: `corepack pnpm vitest run
  tests/conformance/runner-protocol/grpc-round-trip.test.ts` failed 6 of 6 cases
  after transport
  lifecycle authority moved behind the required application seam.
- Root typecheck command: `corepack pnpm typecheck` failed with three TypeScript
  errors because production Core still supplied legacy
  `identity`/`welcome` options and its services imported the removed adapter
  identity type, proving Task 9 is required before a valid commit.
- `git diff --check` exited 0 before commit `1cd9cdb`.
- Commit `d071374` added the named global/Terra exception, closed PR5-SCOPE, and
  recorded the atomicity evidence. `git diff --check` exited 0 after that fix.
- Final exact-head reviews against
  `bfd6da2977691704cb3d2e92872cada9be5bc326...d22f1987678df03324231dcb3f9eb17185bfdace`
  reported no findings. PR #45 merged as `aba6a59ec2dbc0f92000d141563956f7e95c765e`.

## PR5-SCOPE-B - AuthenticatedRunnerContext recovery-test migration

component: complete
production_wiring: missing
verification: not_run
introducing_pr: `codex/pr5-identity-scope`
date: 2026-08-17
implementation_commits: `615fbba`, `aaaa90f`

After Task 9 restored a valid production composition, `corepack pnpm typecheck`
failed because two identities at
`tests/component/core-runner/disconnect-recovery.test.ts:270,277` lacked the new
required `AuthenticatedRunnerContext.scope`. Making scope optional would weaken
Task 8.

This prerequisite adds that shared recovery Gate to Task 8's Files, focused
Gate, and atomic union commit. It changes only the plan and status ledger.

- `git diff --check` exited 0 before commit `615fbba`.
- Initial exact-head review identified the missing Tasks 8-9 dependency node,
  stale PR5-ATOMIC body state, and incomplete scope-B evidence; fixes require a
  new commit and fresh two-axis review.
- Commit `aaaa90f` fixed every initial review finding and `git diff --check`
  exited 0.
- PR #46 merged as `d562f8d31fadaf6154f09522ad754e7e03d3eb85` from head
  `eda315d3210956eedf4ee523b524ae703cbfb244`. Shared recovery identities
  are now in Task 8's Files, focused Gate, and activation commit.

## PR5-R0 - Tasks 8-9 stacked delivery authorization

component: complete
production_wiring: missing
verification: not_run
introducing_pr: `codex/pr5-r0-protocol-authority`
date: 2026-08-17
exact_command: `git diff --check`
implementation_commits: `d591f79`, `673540d`, `ac35b12`, `21d210d`, `42f036d`

The forensic implementation branch `codex/pr5-core-protocol-application`
at `230b6cd` is 11 commits ahead of `origin/main` and remains unpushed.
Repeated review of that single product PR produced architecture-level
findings recorded as Issues `#48`, `#49`, `#50`, and `#51`. Continuing
under the PR5-ATOMIC single-commit packaging would keep mixing transport,
authority, and production composition.

This prerequisite changes only the temporary plan, the delivery document,
and this ledger. It authorizes stacked inactive PRs plus one activation
commit. It does not change Tasks 8-9 Interfaces, Files unions, required
scope, or the ban on fake production composition.

- Forensic head `230b6cd` is frozen as reference only. No cherry-pick of
  a whole commit is authorized.
- `git diff --check` exited 0 before commits `d591f79`, `ac35b12`, and
  the #49 owner fix.
- First exact-head review against
  `d562f8d31fadaf6154f09522ad754e7e03d3eb85...673540db08ecc9146157012d1b3502dffd0c65c3`
  found two Important findings: stacked PRs lacked named Gate commands,
  and typecheck was optional. Commit `ac35b12` names each Gate and
  requires `corepack pnpm typecheck` for PR5-R1 through PR5-R5.
- Second exact-head review against
  `d562f8d31fadaf6154f09522ad754e7e03d3eb85...21d210d8983bbe5a58a0978136dcd9497b986c0a`
  found one Important finding: Issue `#49` was aliased to inactive PR5-R4.
  The delivery document now assigns `#49` to PR5-R5, names the R4 Gate as
  `corepack pnpm vitest run tests/unit/core-daemon`, and renames lease
  `Prepared` to in-process `AcceptReserved`. R4 in-process tests live
  under that existing unit path; `core-composition.test.ts` remains the
  PR5-R5 activation Gate.
- Third exact-head reviews against
  `d562f8d31fadaf6154f09522ad754e7e03d3eb85...42f036d813d98df47cede3aa380e4e503ea6605a`
  reported no Critical or Important findings.
- Stop rule updated: five review rounds that still leave an Important
  finding open the GitHub PR without merge and post each remaining
  Important finding as a PR comment.

## PR5-R1 - Task 8 wire and client waiter registry

component: complete
production_wiring: missing
verification: not_run
introducing_pr: `codex/pr5-r1-wire-client`
date: 2026-08-17
exact_command: `corepack pnpm vitest run tests/conformance/runner-protocol/grpc-mappers.test.ts tests/conformance/runner-protocol/grpc-round-trip.test.ts tests/conformance/runner-protocol/proto-schema.test.ts`
implementation_commits: `7408edc`

Adds the existing domain `ExecutionJobLease.leaseToken` to `RenewLease`,
exports the renew mapper, maps application `LeaseLost` as a stable client
error code, and shares one waiter for a duplicate in-flight
`correlationId`. Production Core/gRPC composition stays pre-activation.

RED: the focused Gate failed 3 of 20 tests because `RenewLease` lacked
`lease_token`, the renew mapper was not exported, and a second renew with
the same correlation id overwrote the waiter.

GREEN: the same command passed 3 files and 20 tests. `corepack pnpm
smoke:node-imports` and `corepack pnpm typecheck` exited 0. `git
diff --check` evidence is recorded after the implementation commit.

Exact-head Standards and Spec/architecture reviews must pass before
PR5-R2 starts.

## PR5-R2 - Neutral runner-control port and lifecycle-module move

component: complete
production_wiring: missing
verification: not_run
introducing_pr: `codex/pr5-r2-neutral-authority`
date: 2026-08-17
exact_command: `corepack pnpm vitest run tests/unit/core-daemon`
implementation_commits: `eacca34`

Adds `@qualigence/runner-control` with the Task 8
`RunnerProtocolApplication` and required `AuthenticatedRunnerContext.scope`.
Moves the four Core lifecycle services into `@qualigence/core-application`
and re-exports the previous Core Daemon paths. Production `main.ts` stays
pre-activation.

RED: the four moved-service unit files failed to construct
`RunOwnershipService` / `RunnerResumeTokenService` from
`@qualigence/core-application` before the package exported them.

GREEN: `corepack pnpm vitest run tests/unit/core-daemon` passed 5 files
and 25 tests. `corepack pnpm smoke:node-imports` and
`corepack pnpm typecheck` exited 0.

Exact-head Standards and Spec/architecture reviews must pass before
PR5-R3 starts.

## PR5-R3 - gRPC stream shell

component: complete
production_wiring: missing
verification: not_run
introducing_pr: `codex/pr5-r3-grpc-stream-shell`
date: 2026-08-17
exact_command: `corepack pnpm vitest run tests/conformance/runner-protocol/grpc-mappers.test.ts tests/conformance/runner-protocol/grpc-round-trip.test.ts tests/conformance/runner-protocol/grpc-tls.test.ts tests/component/core-runner/disconnect-recovery.test.ts`
implementation_commits: `b95a7ba`, `07a8974`, `9f52a34`, `e8cdc56`

Adds a bounded handshake/frame mailbox, fail-stop overflow, connection
generation fencing, atomic same-runner admission, and a shared shutdown
Promise. Production Core still uses the pre-activation constructor.

RED: the focused Gate failed the duplicate-Hello and shared-shutdown
cases because a second Hello replaced the live connection and each
`shutdown()` created a new Promise.

GREEN: the named R3 Gate plus proto-schema passed. `corepack pnpm
smoke:node-imports` and `corepack pnpm typecheck` exited 0.

First exact-head Spec review found three Important findings: the
handshake mailbox was unreachable, generation fencing had no
deterministic test, and shutdown did not cover in-flight Trace. The
follow-up makes handshake admission asynchronous, fail-stops an
overflowed handshake mailbox with `ProtocolViolation`, ignores
old-generation frames, and fails closed an in-flight Trace submit.

Round 2 still left Important fencing, live-mailbox, and
shutdown-completion gaps. `9f52a34` made resume replace the live
generation and added mailbox/shutdown coverage. Round 3 found Important
adapter completion state and a `handleFrame` that still advanced the
shared Trace cursor after await. `e8cdc56` re-checks generation after
the yield, drops the completion store, and holds a live stale batch
across resume so the cursor stays at 1.

Round-4 exact-head Standards and Spec/architecture reviews against
`f9d47c566325d125a76628d31ff1863e014c0317...e8cdc56766bda396c989cc546e5feb6f6c7baa5c`
reported no Critical or Important findings. The remaining completion
observation gap is Minor because `complete()` is fire-and-forget and R3
must not add adapter completion authority.

Exact-head Standards and Spec/architecture reviews must pass before
PR5-R4 starts.

## PR5-R4 - Core protocol authority

component: complete
production_wiring: missing
verification: not_run
introducing_pr: `codex/pr5-r4-core-authority`
date: 2026-08-18
exact_command: `corepack pnpm vitest run tests/unit/core-daemon`
implementation_commits: `d77d810`, `7351641`

Adds `CoreRunnerProtocolApplication` and in-process authority tests for
canonical offer replay, rejected-resume ownership, live-session resume,
double accept, expired renew, completion replay, overlapping Trace
ingest, and interrupted Welcome rollback. Production `main.ts` stays
pre-activation.

RED: `new CoreRunnerProtocolApplication(...)` failed because the class
did not exist.

GREEN: `corepack pnpm vitest run tests/unit/core-daemon` passed 5 files
and 35 tests. `corepack pnpm typecheck` exited 0.

Round-1 Spec found one Important: overlapping Trace did not prove
serialization. `7351641` holds the first ingest in the store and asserts
the second batch cannot enter until the first ACK.

Round-2 exact-head Standards and Spec/architecture reviews against
`76cd8a3faee07610c3deee49f3262ce585da7c6e...73516416072306af3023b3c23acbac886c352516`
reported no Critical or Important findings.

Exact-head Standards and Spec/architecture reviews must pass before
PR5-R5 starts.

## PR5-R5 - Tasks 8-9 production activation

component: complete
production_wiring: present
verification: not_run
introducing_pr: `codex/pr5-r5-protocol-activation`
date: 2026-08-18
exact_command: `corepack pnpm vitest run tests/unit/core-daemon tests/conformance/runner-protocol tests/component/core-runner/core-composition.test.ts tests/component/core-runner/independent-process.test.ts`
implementation_commits: `1b67756`, `061f31c`

Requires `application` and `authenticator` on the gRPC server, opens
SQLite/Trace before bind, and emits readiness only after both succeed.
Adds production composition tests for durable Trace, wrong-token renew,
hash isolation, unaccepted-offer restart, and mTLS resume.

RED: `startCoreDaemon` still used the pre-activation constructor and
`core-composition.test.ts` did not exist.

GREEN: the named R5 Gate plus
`tests/component/core-runner/disconnect-recovery.test.ts` passed.
`corepack pnpm smoke:node-imports` and `corepack pnpm typecheck` exited 0.

Round-1 found Important adapter dummy-lease complete after resume and
a raw `execution_runs` insert. `061f31c` completes with
`jobs.leaseOf` and records runs through `SqliteRunStore`.

Round-2 exact-head Standards and Spec/architecture reviews against
`5e8dff4cde5b6215dbd4dc57226f847f57723cd5...061f31c`
reported no Critical or Important findings.

Exact-head Standards and Spec/architecture reviews must pass before
Task 10 starts.

## Task 10 — Persist Core Runner sessions, leases, resume tokens, and completions

component: complete
production_wiring: present
verification: passed
introducing_pr: `codex/pr6-runner-control-persistence`
date: 2026-08-18
exact_command: `corepack pnpm vitest run tests/conformance/storage/relational-schema.test.ts tests/contract/runner-control tests/unit/core-daemon tests/component/core-runner/disconnect-recovery.test.ts`

Adds additive migration 006 and a provider-neutral `RunnerControlStore`.
SQLite and PostgreSQL adapters share one contract for hashed resume
consumption, lease CAS, and canonical-equivalent completion. Production
Core opens `SqliteRunnerControlStore` before bind.

RED: schema version was 5 and the four services used in-memory maps.

Round-1 verification (2026-08-18): the focused Gate above passed 10 files
and 90 tests with the plan-documented Windows OpenSSL resolution
(`C:\Program Files\Git\usr\ssl\openssl.cnf`), plus `corepack pnpm typecheck`
and `git diff --check`. The PostgreSQL provider contract passed 12 tests
against Docker 29.6.1, including restart-preserved ownership and the
reopened-connection harness.

Round-1 fixes included in the review-round commit: resume-token rotation
with an expiry-bounded idempotent crash-replay window (`rotateResumeToken`
in all three adapters), and resumed-connection completion authority
(`RunOwnershipService.completeStored`), so a Runner that reconnects after a
disconnect or Core restart can complete the run against the persisted
lease even though no raw lease token was seen on the new connection. The
in-memory contract harness shares one store for the concurrent-caller
cases, and the postgres harness re-resolves runtimes after `reopen()`.

Round-2 exact-head Standards and Spec reviews against
`86ea1790f9019362c6d9a74fe1845d193b69c577...292fc68`
reported two Important Spec findings, both fixed in the final review
commit: resume consumption no longer burns the credential on a
mismatched or expired presentation (identity and expiry predicates now
gate the consuming UPDATE in both providers, pinned by the contract),
and the dead `"absent"` outcome was removed from the port so a
no-terminal-result rejection surfaces as `LeaseLost` without a
misleading `completion_conflict` integrity event. The SQLite rotation
insert gained the PostgreSQL `onConflict(doNothing)` parity. Two Spec
claims (postgres `completeLease` not transactional; missing index
`ifNotExists`) were checked against the code and rejected: the postgres
store is constructed with a tenant `Transaction`, and postgres DDL is
one-shot offline provisioning by design. No Critical or Important
findings remain; the final Gate passed 10 files / 90 tests, plus
`corepack pnpm typecheck` and `git diff --check`.

GREEN: focused Gate plus `corepack pnpm typecheck` and `git diff --check`.

Task 10 follow-up fix evidence (2026-08-18): `completeLease` now returns a
provider-neutral discriminated result, carrying a stored terminal completion
only for an atomically observed, valid-bound canonical conflict. The ownership
service emits `completion_conflict` from that result and makes no second
completion read. `completeStored` marks an observed expired live lease lost at
the same `nowIso` before returning `LeaseLost`. After `corepack pnpm build`,
`corepack pnpm vitest run tests/contract/runner-control tests/unit/core-daemon/run-ownership-service.test.ts`
passed 4 files / 52 tests. With Git OpenSSL on `PATH` and
`OPENSSL_CONF=C:\Program Files\Git\usr\ssl\openssl.cnf`,
`corepack pnpm vitest run tests/component/core-runner/core-composition.test.ts tests/component/core-runner/disconnect-recovery.test.ts`
passed 2 files / 10 tests. `corepack pnpm typecheck` and `git diff --check`
passed; exact-head review remains pending.

Task 10 follow-up round 2 (2026-08-18) repairs the subsequent Important review
blockers. `markLeaseLost` now atomically refuses terminal leases in every
provider. `completeStored` gives terminal replay precedence over expiry and,
after a failed expiry-loss CAS, re-reads only the lease to classify a terminal
race with the same `nowIso`; it never transitions a completed lease to lost.
`observedCompletionResult` centralizes valid-bound canonical terminal mapping in
the neutral runner-control port. The shared provider contract uses independent
primary/concurrent callers to prove one completion transition, duplicate replay,
and conflict results that carry the atomic winner. After `corepack pnpm build`,
`corepack pnpm vitest run tests/contract/runner-control tests/unit/core-daemon/run-ownership-service.test.ts`
passed 4 files / 63 tests. With Git OpenSSL on `PATH` and
`OPENSSL_CONF=C:\Program Files\Git\usr\ssl\openssl.cnf`,
`corepack pnpm vitest run tests/component/core-runner/core-composition.test.ts tests/component/core-runner/disconnect-recovery.test.ts`
passed 2 files / 10 tests.

## Task 15 — Deterministic execution policy snapshot (2026-08-18)

component: complete
production_wiring: present
verification: passed
introducing_pr: `codex/pr11-execution-policy`
date: 2026-08-18
exact_command: `corepack pnpm vitest run tests/conformance/runner-protocol/accepted-execution-job-plan.test.ts tests/conformance/runner-protocol/grpc-mappers.test.ts tests/conformance/runner-protocol/grpc-round-trip.test.ts tests/conformance/runner-protocol/proto-schema.test.ts tests/contract/runner-control/runner-control-store.contract.ts tests/contract/runner-control/sqlite-runner-control-store.test.ts tests/contract/runner-control/postgres-runner-control-store.test.ts tests/unit/core-daemon/config.test.ts tests/unit/core-daemon/legacy-m1-local-recovery.test.ts tests/unit/core-daemon/runner-backed-run-resource-factory.test.ts tests/component/core-runner/core-composition.test.ts tests/component/core-runner/disconnect-recovery.test.ts tests/component/core-runner/independent-process.test.ts tests/unit/runner/job-executor.test.ts tests/unit/runner/offer-runtime.test.ts tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/unit/core-modules/mission/execution-policy.test.ts tests/unit/core-modules/mission/mission-compiler.test.ts tests/contract/sqlite/prd-mission-store.test.ts tests/unit/execution-application/mission-execution-use-case.test.ts tests/unit/cli/config.test.ts tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/component/web-execution/run-execution-use-case.test.ts tests/component/web-execution/local-run-composition-root.test.ts tests/component/prd-planning/prd-to-run.test.ts tests/e2e/cli-web-cart.test.ts`

RED: the pre-implementation focused command failed as expected: policy was not
present on `AcceptedExecutionJob`, protobuf had no field 6 policy message,
wire jobs without policy were accepted, no deterministic gate/admission or
recovery validation seam existed, and typecheck rejected the new required
interfaces. The initial RED run also exposed the documented Windows OpenSSL
configuration requirement; subsequent component runs used Git OpenSSL on PATH.

GREEN: `AcceptedExecutionJob.policy` is required and losslessly mapped through
the frozen protobuf tags (Job policy = 6; nested fields 1-8). Core and Mission
propagate immutable approved policy, Local CLI issues explicit isolated-test
authority, and both Local and remote Runner composition construct the
deterministic Runner gate. Remote offers are admitted before target/browser
creation and denied jobs complete blocked without action execution. SQLite and
PostgreSQL reject malformed or policyless persisted lease Jobs; renewal fails
as `PolicyMissing` before expiry mutation. The only legacy upcast is the
validated, hash-bound Local SQLite recovery manifest; PostgreSQL never upcasts.
Core transport now only offers and awaits completion, without a policy gate or
target/action pipeline.

The complete focused command above passed 26 files / 145 tests using
`C:\Program Files\Git\usr\bin` on PATH for mTLS component tests. The final
policy command `corepack pnpm vitest run tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/e2e/cli-web-cart.test.ts`
passed 3 files / 12 tests. `corepack pnpm typecheck` and `git diff --check`
passed. Docker-backed PostgreSQL contract tests ran and passed; no Gate was
skipped. Task 11 source and tests remain unchanged.

Task 15 review-fix round (2026-08-18): strict policy parsing is now centralized
in the Runner Protocol contract and used by gRPC mapping, both runner-control
providers, Core request admission, legacy Local recovery parsing, and the
Runner gate. It requires canonical ISO instants with `issuedAt < expiresAt`,
canonical non-credentialed HTTP(S) origins, known enums, nonempty unique action
and origin sets, and staging's exact click/Normal/non-exploration declaration.
Malformed wire or persisted Jobs raise `PolicyMissing`; provider renewal reads
and validates the stored Job before updating expiry. The Core factory validates
the request before opening stores or offering. Direct `startCoreDaemon` tests
prove Phase A rejects before SQLite creation/listen, Phase B closes SQLite and
does not bind on mismatch, and only a hash-bound validated Local row upcasts.
Denied Runner offers prove no target/browser start, capture/decision, resolver,
permit-backed executor, or close path is invoked.

After `corepack pnpm build`, the complete Task 15 focused command passed 26
files / 164 tests with `C:\Program Files\Git\usr\bin` on PATH for component
mTLS. `corepack pnpm vitest run tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/e2e/cli-web-cart.test.ts`
passed 3 files / 14 tests. `corepack pnpm typecheck` and `git diff --check`
passed. Docker-backed PostgreSQL contract cases ran with no skips.

Task 15 review-fix round 8 (2026-08-18): one shared strict execution-target
validator now governs CLI local policy issuance, Mission dispatch construction,
and the shared execution use case. It accepts only absolute HTTP(S) URLs without
credentials and rejects `ftp`, `file`, `data`, malformed, and credentialed URLs.
CLI maps rejection to `CliConfigError(InvalidConfiguration)`; persisted Mission
dispatch maps it to `InvalidTargetUrl` with a durable failed attempt and blocked
Mission, without browser construction. The existing Playwright session validator
remains unchanged as independent adapter defense in depth.

Task 15 Critical project-provenance follow-up (2026-08-18): required immutable
`projectId` now flows from approved Mission/project source through the compiled
Mission hash and SQLite snapshot, `DispatchableMission`, `RunExecutionRequest`,
`AcceptedExecutionJob`, recovery, Runner protobuf tag 7, gRPC mapper, and
runner-control SQLite/PostgreSQL Job JSON. Local CLI explicitly issues only
`projectId: "local"`; no network or normal storage default exists. Missing or
malformed project provenance fails closed as `PolicyMissing`; renewal leaves its
expiry unchanged. The constrained Local manifest recovery may attach `local`
only to a hash-bound historical projectless record with either no policy or the
exact manifest policy. PostgreSQL never upcasts. SQLite rejects a compiled
Mission persistence scope that disagrees with its immutable project ID.

After Git OpenSSL resolution with `C:\Program Files\Git\usr\bin` on `PATH` and
`OPENSSL_CONF=C:\Program Files\Git\usr\ssl\openssl.cnf`, `corepack pnpm build`
passed and the amended Task 15 Gate passed 24 files / 229 tests, including the
Docker-backed PostgreSQL runner-control contract. `corepack pnpm typecheck` and
`git diff --check` passed. No environmental blocker occurred.

Task 15 Important provenance review fix (2026-08-18):
`SqliteRunnerControlStore` no longer has a legacy recovery option, record type,
or public upcast path. Its constructor and all normal reads strict-parse
`job_json`; policyless and projectless Jobs remain `PolicyMissing`, including
when callers pass former arbitrary or exact-shaped option values at runtime.
Only `startCoreDaemon` obtains the opaque recovery capability after exact
Local/loopback, constrained `legacy-m1-local` policy, identifier, origin, and
canonical-hash validation. Before Core service composition or listener bind, it
transactionally compare-and-swaps every attested legacy JSON row to the exact
strict Job with `projectId: "local"`; an ordinary Store then reads it without a
compatibility path. The Core remote dispatch factory now rejects a Job whose
project differs from its opened request before `connection.offer`.

With Git OpenSSL resolved as above, `corepack pnpm build`, the amended complete
Task 15 follow-up Gate, `corepack pnpm typecheck`, and `git diff --check`
passed. The Gate ran 24 files / 230 tests including Docker-backed PostgreSQL;
no environmental blocker occurred.

Task 15 final provenance review fix (2026-08-18): public Runner Protocol and
`@qualigence/runner-control` namespaces no longer export policyless/projectless
Job parsers or types. The historical shape parser is private to
`apps/core-daemon/src/legacy-m1-local-recovery.ts`; it validates only the raw
record until the same verified manifest operation proves Local/loopback
authority, exact constrained policy, identifiers, hash, and origin. Only then
does it construct the strict `projectId: "local"` Job used by the opaque
pre-listener migration capability. Public consumers have no projectless restore
path.

With Git OpenSSL resolved as above, `corepack pnpm build`, the amended complete
Task 15 follow-up Gate, `corepack pnpm typecheck`, and `git diff --check`
passed. The Gate ran 24 files / 230 tests including Docker-backed PostgreSQL;
no environmental blocker occurred.

Task 15 startup-private recovery review fix (2026-08-18):
`apps/core-daemon/src/legacy-m1-local-recovery.ts` and all Core recovery helper
exports are deleted. `startCoreDaemon` now exclusively owns the private Phase A
Local/loopback/constrained-policy validation, Phase B raw-row/hash/origin/policy
attestation, and transactional strict-Job migration before service composition
or listener bind. Component tests exercise every success and rejection case
through `startCoreDaemon` and prove the public Core module exposes no callable
recovery verifier or applier.

With Git OpenSSL resolved as above, `corepack pnpm build`, the amended complete
Task 15 follow-up Gate, `corepack pnpm typecheck`, and `git diff --check`
passed. The Gate ran 24 files / 231 tests including Docker-backed PostgreSQL;
no environmental blocker occurred.

Task 15 adapter-seam provenance review fix (2026-08-18): public
`SqliteRunnerControlStore.rawRecoveryJobJson()` is removed. The private
`startCoreDaemon` startup operation reads exact historical `job_json` through
its already-owned `SqliteRuntime.db` query/transaction seam; no
`RunnerControlStore` interface or parallel adapter seam was added. Phase A now
requires trimmed, nonempty manifest `jobId` and `runId` before `mkdir`, SQLite
open, or listener bind. Existing component composition tests prove empty and
whitespace identifiers create no database and leave the same port available for
normal startup.

With Git OpenSSL resolved as above, `corepack pnpm build`, the amended complete
Task 15 follow-up Gate, `corepack pnpm typecheck`, and `git diff --check`
passed. The Gate ran 24 files / 235 tests including Docker-backed PostgreSQL;
no environmental blocker occurred.

After `corepack pnpm build`, the complete Task 15 focused command passed 26
files / 199 tests with `C:\Program Files\Git\usr\bin` on PATH for component
mTLS. `corepack pnpm vitest run tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/e2e/cli-web-cart.test.ts`
passed 3 files / 18 tests. `corepack pnpm typecheck` and `git diff --check`
passed. Docker-backed PostgreSQL contract cases ran with no skips.

Task 15 review-fix round 7 (2026-08-18): CLI local policy construction now
converts malformed `--url` input into the stable `CliConfigError`
`InvalidConfiguration` rather than leaking `URL` parsing. Mission execution
validates persisted dispatch URLs before calling the execution use case and
converts invalid URL configuration into a durable error attempt, failed job, and
blocked Mission terminal state without an uncaught exception or browser work.

After `corepack pnpm build`, the complete Task 15 focused command passed 26
files / 191 tests with `C:\Program Files\Git\usr\bin` on PATH for component
mTLS. `corepack pnpm vitest run tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/e2e/cli-web-cart.test.ts`
passed 3 files / 18 tests. `corepack pnpm typecheck` and `git diff --check`
passed. Docker-backed PostgreSQL contract cases ran with no skips.

Task 15 review-fix round 6 (2026-08-18): the Task 15 Files block was correctly
amended to authorize the one IPv6 listener path before it changed. The gRPC
server now binds `::1` using bracketed authority notation and a real IPv6 mTLS
connection passes. Core configuration requires explicit `local` or
`self_hosted` deployment mode; absent/unknown values fail, manifest absence is
no recovery candidate, and malformed manifest JSON fails load. Wire plan parsing
now enters the strict Job parser so malformed plans fail `PolicyMissing` at the
network boundary. Runner OfferRuntime drains Trace with negotiated welcome
limits. Mission/exploration authority validation rejects malformed canonical
instants, enums, and duplicate origins/actions before compilation. The runtime
policy matrix proves action-kind, risk ceiling, and `ProductionForbidden`
denials never mint a permit or invoke an executor; Core factory legacy gate
injection remains rejected.

After `corepack pnpm build`, the complete Task 15 focused command passed 26
files / 189 tests with `C:\Program Files\Git\usr\bin` on PATH for component
mTLS. `corepack pnpm vitest run tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/e2e/cli-web-cart.test.ts`
passed 3 files / 18 tests. `corepack pnpm typecheck` and `git diff --check`
passed. Docker-backed PostgreSQL contract cases ran with no skips.

Task 15 review-fix round 5 (2026-08-18): gRPC listener binding formats IPv6
loopback as `[::1]:port` and a real mTLS IPv6 connection passes while IPv4 is
unchanged. `CORE_DEPLOYMENT_MODE` is now mandatory and accepts only `local` or
`self_hosted`; absent/unknown modes do not silently select Local, while manifest
absence remains a no-recovery candidate and malformed JSON fails config load.
Malformed plan wire payloads now fail as `PolicyMissing` before Job admission.
OfferRuntime drains Trace using negotiated welcome limits, proven with restrictive
bounds. Mission and exploration authority validation now rejects malformed
instants/enums/duplicates before compilation or dispatch. The policy matrix adds
action-kind, risk-ceiling, and `ProductionForbidden` denials before permit or
executor creation; the Core factory also rejects legacy injected policy gates.

The Task 15 Files block was amended in this fix round to add the exact
`packages/protocol-adapters/grpc-runner-protocol/src/server.ts` IPv6 listener
path before editing it. After `corepack pnpm build`, the complete Task 15
focused command passed 26 files / 186 tests with
`C:\Program Files\Git\usr\bin` on PATH for component mTLS.
`corepack pnpm vitest run tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/e2e/cli-web-cart.test.ts`
passed 3 files / 15 tests. `corepack pnpm typecheck` and `git diff --check`
passed. Docker-backed PostgreSQL contract cases ran with no skips.

Task 15 review-fix round 4 (2026-08-18): Local recovery now accepts only the
two plan-authorized exact loopback forms (`127.0.0.1` and `::1`), while absent
or other hosts fail Phase A. The neutral strict Job parser now validates and
preserves optional immutable plan snapshots through normal SQLite/PostgreSQL
lease reads and the hash-bound Local recovery upcast; malformed plan snapshots
produce `PolicyMissing`. Mission exploration conversion now maps only the
exactly representable `ReadOnly` exploration ceiling to Runner `Normal` risk,
rejecting broader/unrepresentable ceilings and any result above approved risk.

After `corepack pnpm build`, the complete Task 15 focused command passed 26
files / 180 tests with `C:\Program Files\Git\usr\bin` on PATH for component
mTLS. `corepack pnpm vitest run tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/e2e/cli-web-cart.test.ts`
passed 3 files / 14 tests. `corepack pnpm typecheck` and `git diff --check`
passed. Docker-backed PostgreSQL contract cases ran with no skips.

Task 15 review-fix round 3 (2026-08-18): the frozen `plan = 5` Job field now
maps losslessly through gRPC/protobuf alongside policy, with a non-empty plan
round-trip assertion. Legacy recovery requires explicit `127.0.0.1` exactly;
direct `startCoreDaemon` evidence now covers absent/non-loopback host,
malformed/duplicate manifests, missing row, origin and preexisting-policy
mismatch, ordinary policyless no-manifest fail-closed behavior, resource release,
and the constrained successful upcast. Strict `lease()` failures encountered by
owner lookup during application renewal translate to Core `PolicyMissing`.
Offer evidence isolates a non-expired cross-origin denial, policyless denial,
invalid staging exploration/coordinate/visual declarations, and an allowed
staging control that passes exactly the snapshot origins and same deterministic
gate into the executor.

After `corepack pnpm build`, the complete Task 15 focused command passed 26
files / 177 tests with `C:\Program Files\Git\usr\bin` on PATH for component
mTLS. `corepack pnpm vitest run tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/e2e/cli-web-cart.test.ts`
passed 3 files / 14 tests. `corepack pnpm typecheck` and `git diff --check`
passed. Docker-backed PostgreSQL contract cases ran with no skips.

Task 15 review-fix round 2 (2026-08-18): gRPC Job mapping now losslessly
preserves the existing `plan = 5` snapshot through protobuf, including steps,
claims, and budget. Legacy Local recovery now requires explicit exact
`127.0.0.1`; absent, IPv6, or any other host fails before SQLite/listen. Direct
daemon evidence covers malformed/duplicate Phase A manifests, missing Phase B
rows, hash/origin/preexisting-policy mismatch closure, ordinary policyless rows
without a manifest fail-closed, and the constrained verified upcast. Strict
lease parsing arising in owner lookup is translated to `CoreApplicationError`
`PolicyMissing` for application renewal. Runner OfferRuntime proves non-expired
cross-origin, policyless, and invalid staging exploration/coordinate/visual
offers do not construct targets; a valid staging control receives only the
snapshot's exact `allowedOrigins`.

After `corepack pnpm build`, the complete Task 15 focused command passed 26
files / 177 tests with `C:\Program Files\Git\usr\bin` on PATH for component
mTLS. `corepack pnpm vitest run tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/e2e/cli-web-cart.test.ts`
passed 3 files / 14 tests. `corepack pnpm typecheck` and `git diff --check`
passed. Docker-backed PostgreSQL contract cases ran with no skips.
