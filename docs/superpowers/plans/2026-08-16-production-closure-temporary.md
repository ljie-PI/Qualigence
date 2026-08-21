# Qualigence Production Closure Temporary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Local/Self-hosted/M3 component set into an honestly reported, independently testable production loop without adding Cloud, Mobile, macOS Desktop, or Linux Desktop scope.

**Architecture:** Keep the existing domain modules and deterministic state machines as the only business-state writers. Repair application entrypoints first, then wire Core/Runner transport through explicit application ports, add durable control state and product intake, complete Self-hosted API/Worker/Runner composition, migrate the live observation path to Graph v1, and finally replace Windows test seams with native implementations. Transport adapters remain thin; Runner and Worker submit events/results rather than writing aggregates.

**Tech Stack:** Node.js 24, Corepack pnpm 11.7.0, TypeScript, Vitest, Fastify, Kysely, SQLite/PostgreSQL 17, gRPC + mutual TLS, React 19, Playwright, Rust 2021, Windows UI Automation/Win32 Named Pipes/Job Objects.

## Status and authority

This is a temporary execution document dated 2026-08-16. It records the observed repository state after reading the tracked code and documentation. During execution, resolve conflicts in this order:

1. Security invariants and public contracts in `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` and the LS design specs.
2. Existing domain types, public interfaces, and contract/conformance tests.
3. This plan's current-state delta and task boundaries.
4. Older LS implementation plans.
5. `docs/superpowers/implementation-status.md`, which is not evidence that production wiring exists.

The word `implemented` in the status ledger means only that some planned files or component tests exist. A capability is complete only when its production Composition Root uses it and the task's black-box Gate passes.

Operational engineering-skill configuration, including the active issue-tracker backend and triage vocabulary, is owned by `AGENTS.md` and `docs/agents/*.md`. Reconfiguring that backend does not change this plan's task authority or rewrite historical GitHub Issue references.

## Global Constraints

- Use Node.js 24 and exactly `corepack pnpm --version` = `11.7.0`. Do not use an ambient/fallback `pnpm` binary.
- In a fresh worktree run `corepack pnpm install --frozen-lockfile`. If a trusted registry is unavailable, `corepack pnpm install --offline --frozen-lockfile` is permitted only when the pnpm store already contains every locked package. Do not regenerate the lockfile except in a task that explicitly adds a dependency or the separately reviewed P0 lock-consistency repair below.
- Preserve strict TypeScript settings and project references; no `any`, unsafe double assertions, or domain imports from Fastify/gRPC/Playwright/Win32 adapters.
- Models only produce proposals/results. Deterministic code owns authorization, budgets, state transitions, IDs, persistence, and idempotency.
- Do not weaken mTLS, OIDC, RLS, Named Pipe identity, Permit binding, Trace hashes, or expected-version checks to make a test pass.
- Do not modify historical migration files 001-005. New relational state uses migration 006 or later.
- Do not silently skip a required Gate. Report an explicit environmental block such as `ChromiumUnavailable`, `OpenSslUnavailable`, `DockerUnavailable`, `CargoUnavailable`, or `Windows11Unavailable`. The only temporary exception is Prerequisite Q: exactly four named individual tests may use Windows-only `it.skipIf`; each skip must carry the exact Task 21 removal marker and remains release-blocking.
- Every implementation task begins with a failing focused test, ends with its focused tests plus `corepack pnpm typecheck`, and is committed separately. PR5-ATOMIC remains the production-composition rule: no compatibility default, insecure fallback, or fake may enter a production Composition Root, and production Core may require `application`/`authenticator` only in the activation commit. PR5-R0 replaces the single-commit packaging: Tasks 8-9 retain separate RED evidence and ship as the stacked inactive PRs plus one activation commit defined in `docs/superpowers/plans/2026-08-17-pr5-protocol-authority-refactor.md`. Each product stacked PR (PR5-R1 through PR5-R5) ends with that document's named focused Gate plus `corepack pnpm typecheck`. A verification-only closure task must capture the pre-existing incomplete Gate as RED/blocked evidence and must not invent a source change merely to create a diff.
- A Terra worker executes one task per fresh context. It must read every file in the task's **Files** block before editing and must not edit files outside that block without stopping for review.
- At the end of every task, update `docs/production-closure-status.md` in the same task commit with `component`, `production_wiring`, `verification`, exact command, date, and commit. Never use the ignored SDD ledger as the only completion evidence.
- Preserve unrelated user changes. Never reset, checkout, or overwrite a dirty file to match this plan.
- Do not claim Windows native completion from synthetic fixtures. Native Tasks 19-20 require Windows 11, Cargo, and the explicit Windows integration flag.
- Do not return Graph v1 status `frozen` without signed `WindowsChecklistEvidence` and passing Web/Desktop schema conformance evidence.

## Current execution state (2026-08-16)

| Task | State | Evidence and required next action |
|---|---|---|
| Q Windows test quarantine | merged as PR #36; Linux verification blocked | Merge commit `ceeb857`; Windows focused validation passed 19 tests with exactly 4 Task 0 skips and both review axes passed. `LinuxExecutorUnavailable` remains release-blocking until Task 21 removes every marker. |
| P0 Frozen lock consistency | merged as PR #37 | Merge commit `7e24a9f`; frozen install RED proved a missing Vite 8.1.5 peer snapshot and the lock-only repair passed two clean frozen installs with no manifest change. |
| 1 Admin CLI | complete and verified | Commit `f200d6d`; Task 4 clean-worktree built-binary verification passed for help, unknown command, command parsing, and fail-closed KMS behavior. |
| 2 Node entrypoints | complete and verified | Commit `603439b`; Task 4 passed all seven direct-entrypoint smoke cases and the Local Launcher E2E in a clean install. |
| 3 Review routes | complete and reviewed | Commits `3071da0` + `fd788df`; PostgreSQL route/component tests passed with Docker, and the public `actualVersion` conflict contract was restored. Task 5 now adds provider parity and two-writer contract evidence. |
| 4 Gate/status closure | complete | A clean detached worktree passed frozen install, build, typecheck, and 4 focused black-box files / 17 tests. `docs/production-closure-status.md` records the repeatable evidence and the remaining root Playwright CLI defect. |
| 5 Review provider contract | complete after PR review fixes | Shared provider cases plus SQLite/PostgreSQL failure injection and advisory-lock barriers pass with explicit tenant scope and complete-command replay; the focused regression set passes 67 tests. |
| 6 OIDC signature verification | merged as PR #40 | Merge commit `0753be7`; `jose` 6.2.9, real RS256/ES256 verification, complete callback cleanup, token/config validation, exact redirect binding, cached JWKS rotation, network/error callbacks, malformed-role rejection, and bootstrap loopback policy passed 39 focused tests and both final review axes; the final Windows Gate passed 893 tests with 6 expected skips. |
| SETUP-00 Engineering context and review guidance | merged as PR #42 | Merge commit `a9fd9b3`; engineering contexts, review guidance, and the stabilized baseline Gate merged after both review axes passed. |
| 7 Runner renewal | merged as PR #43 | Merge commit `09afe87`; the final focused Gate passed 21 tests and both exact-head review axes reported no findings. |
| PR5-SCOPE Tasks 8-9 scope repair | merged as PR #44 | Merge commit `bfd6da2`; declared required protocol and moved-service test files. |
| PR5-ATOMIC Tasks 8-9 delivery boundary | merged as PR #45 | Merge commit `aba6a59`; Tasks 8-9 are one compilable implementation/review unit. |
| PR5-SCOPE-B AuthenticatedRunnerContext test migration | merged as PR #46 | Merge commit `d562f8d`; shared recovery identities are in Task 8's Files, focused Gate, and activation commit. |
| 8-10 Runner protocol/control | merged | Tasks 8-9 activated in merge `86ea179`; Task 10 durable Runner control merged in PR #60 (`06becdb`) with completion follow-ups in PR #61 (`114affa`). |
| 15 deterministic execution policy | merged | Task 15 merged in PR #63 (`5120c1f`) with strict project provenance follow-up in PR #65 (`923cfa7`). Required immutable policy and nonempty Job project provenance are now on `main`. |
| 11 Local intake/Launcher loop | documentation authority in progress | This Task 11 rewrite is the sole implementation authority. After its one plan review, implement the complete Task 11 Files block and Gate, then request one final implementation review; do not interleave rolling downstream reviews. |
| 12-14 Self-hosted follow-ons | pending and non-blocking for Task 11 | Findings or migration reservations in Tasks 12-14 do not block Task 11. Their sections remain unchanged and must resolve the migration-007 reservation conflict when each later task is executed. |
| 16-18 | pending | Proceed only through their documented dependencies; they are not part of Task 11. |
| 19-20 Windows native | blocked | Cargo is absent. Windows 11 is present but portable TypeScript/Rust planning is not native completion. |
| 21-22 CI/docs | pending with Windows RED captured | The reviewed-stack full Gate passes 862 tests, skips 2, and fails the four known Windows baseline cases assigned to Task 21. Prerequisite Q may quarantine only these cases for integration; release completion still waits for their restoration, Tasks 19-20, and all platform CI artifacts. |

## Current verified baseline

- Docker 29.6.1 and Chromium are available on the current Windows host.
- Git's OpenSSL exists at `C:\Program Files\Git\usr\bin\openssl.exe` but is not on `PATH`; Gates must resolve it explicitly or report `OpenSslUnavailable`.
- Cargo is not installed, so native Companion Tasks 19-20 cannot be completed on this host yet.
- The lockfile is synchronized through Task 6. The trusted registry was reachable through the explicit local HTTP proxy without disabling TLS; `jose` 6.2.9 is a direct Web Console dependency.
- Clean-worktree build and typecheck pass. Task 4's Admin CLI, seven-entrypoint, Local Launcher, and observation-admin focused Gate passes 17 tests without skips; broader release Gates remain separate tasks.
- Historical pre-quarantine Task 1-6 evidence reported four Windows baseline
  failures. The current Task 6 full Windows Gate supersedes that run: 140 files,
  139 passed and 1 skipped; 899 tests, 893 passed, 0 failed, and 6 expected
  skips. Four skips remain owned by Task 21 and are not release completion.
- `apps/admin-cli/src/main.ts` parses `argv` and Doctor awaits KMS; clean built-binary black-box verification is recorded in `docs/production-closure-status.md`.
- `apps/core-daemon/src/main.ts` only starts `GrpcRunnerProtocolServer`; it does not wire `RunnerSessionService`, `ExecutionJobService`, `RunOwnershipService`, durable Trace, or request intake.
- The gRPC server keeps an in-memory Trace cursor, ignores `complete_execution`, and reissues leases without authoritative ownership validation.
- Runner accepts and executes leases and Task 7 added bounded renewal; its production policy gate still always returns allowed.
- Server does not register Mission/Run/Trace/Skill routes, does not start a Runner gRPC endpoint, and does not run `ServerIntelligenceResultConsumer`.
- Review HTTP mutations use the aggregate handlers and preserve the public conflict envelope. Task 5's shared SQLite/PostgreSQL contract proves idempotency-key binding, audit persistence, and true two-writer claim behavior.
- Web Console verifies ID Token signatures against its deployment-pinned remote JWKS and an RS256/ES256 allowlist before nonce, tenant, role, or subject processing.
- Live Web/Runner code uses the pre-v1 `ObservationGraph`; Windows adapter code uses `ObservationGraphV1`.
- `TargetRef` is Web-only and Runner always constructs `PlaywrightWebTargetAdapter`.
- Windows `NamedPipePeer`, `WindowsUiaCapture`, `WindowsDesktopProcessHost`, and Companion binary entrypoint are non-functional production seams.

## Scope exclusions

- Qualigence Cloud implementation.
- Android/iOS M4 adapters.
- macOS AX and Linux AT-SPI adapters.
- Interactive Windows VM automation. Real Windows 11 manual evidence remains an explicit release action.
- New model vendors or a redesign of the Model Gateway.
- New domain features unrelated to closing the documented Local/Self-hosted/M3 path.

## File and responsibility map

| Area | Existing responsibility | Closure direction |
|---|---|---|
| `apps/admin-cli` | Self-hosted operations | Make the binary execute and fail closed |
| `packages/protocol-adapters/grpc-runner-protocol` | Wire codec and mTLS transport | Delegate lifecycle semantics to an application port |
| `apps/core-daemon/src/runner` | Session, ownership, jobs, remote target | Compose these services and persist their state |
| `apps/runner` | Offer loop, execution, Spool upload | Renew safely and dispatch Web/Desktop adapters |
| `apps/local-launcher` | Process supervision | Use real readiness/intake/bootstrap state |
| `apps/server` | Public API/OIDC/Runner enrollment | Add missing resources, Result consumer, Runner endpoint |
| `packages/core-application/src/intelligence` | Durable job/result semantics | Run the existing Server-only consumer in production |
| `packages/contracts/observation` | Graph v1 source of truth | Make it the live runtime observation type |
| `packages/target-adapters/desktop-windows-uia` | Typed Companion IPC client seam | Add a real Named Pipe client and Runner composition |
| `apps/companion` | Security state machines and native seams | Implement Named Pipe/UIA/Job Object daemon on Windows |

## Dependency order

## Remaining closure authority amendment (2026-08-20)

This amendment is the execution entrypoint for all work after completed Tasks
1-11 and 15. It supersedes the stale current-state rows, dependency graph, PR
packaging rows, migration reservations, and implementation instructions for
Tasks 12-14 and 16-22 below. Those older sections remain unchanged as historical
evidence; agents must not execute them directly when they conflict with this
amendment. Product source fixed point is
`dbc2db8a8854a5559624fa7a7434d75c654f6b82`; this documentation amendment is
reviewed from merge commit `609ab3d0bc85bcf1916534989cda33c8df03fd72`.

### Current state and environment

| Legacy Task | Current state | Authority |
|---|---|---|
| 1-7 | complete, wired, verified | Merged evidence in `docs/production-closure-status.md` |
| 8-9 | complete, wired, verified | PR5-R1 through PR5-R5, activated by merge `86ea179` |
| 10 | complete, wired, verified | PR #60 and follow-up evidence |
| 11 | complete, wired, verified | PR #66 and the Task 11 status entry |
| 15 | complete, wired, verified | PR #63 plus PR #65 provenance follow-up |
| 12-14, 16-22 | pending | Tickets 02-35 below; ticket 01 is this docs-only authority prerequisite |

Current host: Windows 11; Node `v24.13.0`; Corepack pnpm `11.7.0`;
Docker client/server `29.6.2`; Cargo/rustc `1.96.1`. Cargo is available, but
native Tasks still require the committed pinned toolchain, Windows-only native
tests, real WPF/WinUI scenarios, local-console/RDP evidence, and the signed
checklist. Git OpenSSL is at
`C:\Program Files\Git\usr\bin\openssl.exe` and is not assumed to be on `PATH`.

### Frozen cross-cutting decisions

- Migrations 001-007 are immutable. PostgreSQL upgrades are offline,
  owner-role, backup-gated, and sequential; runtime roles have no DDL authority.
- Remaining migration ownership is exact: 008 Target/Test Plan revisions
  (ticket 03); 009 Mission/Run/attempt/provenance/outbox and its atomic dispatch
  wakeup (04); 010 durable
  Intelligence leases/Result inbox (07); 011 tenant wakeups/dispositions (08);
  012 Artifact manifests/chunks/ACK state (11); 013 Evidence lifecycle (13).
  No other ticket owns a migration without a reviewed plan amendment.
- Evidence lifecycle is
  `active -> revoking -> revoked -> deleting -> deleted`. Successful revocation
  and audit precede deletion; revoke failure retains ciphertext, delete failure
  retains an auditable retryable revoked record, and audit failure fails closed.
- Graph canonicalization sorts semantic sets (`nodes`, each node's `relations`,
  `rootNodeIds`, and Graph `evidenceRefs`) by stable keys. Business-order
  arrays retain order. Extension arrays sort only when their schema explicitly
  declares set semantics; unspecified arrays retain order. Exact v1 sort keys
  are: nodes by NFC-normalized `id`; relations by NFC-normalized
  `(type, targetNodeId)` tuple; root IDs and Graph evidence refs by their
  NFC-normalized string value. Equal keys require byte-identical entries or
  validation fails, so no input-order tie-breaker enters the hash.
- The typed `web/v1` extension contains canonical origin, pathname, title, and
  viewport plus only Target-policy-allowlisted query keys. Every retained query
  value is the fixed redaction marker, fragments are omitted, and Graph hashing
  covers exactly that redacted representation. Normalized text and private
  locator/DOM provenance are not substitutes for these required fields.
- `select` uses a Plan-owned `valueRef`; the model never supplies option text.
  Runner mTLS identity is reused for Companion proof with ECDSA P-256/SHA-256
  or RSA-PSS/SHA-256 according to the certificate key.
- Graph v1 remains `candidate` until ticket 35 validates serialized migration,
  Web/Desktop schema, native/manual Windows, CI, and release-manifest evidence.

### Delivery graph

```text
01 -> 02 -> 03 -> 04 -> 05
                  \-> 06
05 + 06 -> 07 -> 08 -> 09 -> 10
10 + 16 -> 11 -> 12 -> 13 -> 14 -> 15

01 -> 16 -> 17 -> 18 -> 19 -> 20 -> 21
                         \-> 22 -> 23
21 + 23 -> 24 -> 25 -> 26 -> 27 -> 28 -> 29 -> 30 -> 31

15 + 21 + 31 -> 32 -> 33 -> 34 -> 35
```

The Self-hosted and Runtime/Windows lanes may proceed in parallel. Changes to a
shared contract or protocol merge serially. A dependent ticket may start only
when every listed predecessor is resolved.

### Review and Gate protocol

Every ticket is delivered from its own isolated branch/worktree through exactly
one dedicated pull request. Never combine multiple tickets in one PR. Parallel
implementation is permitted only when branches/worktrees and Files scopes are
isolated; changes to shared contracts, protocols, authority, or status merge
serially. A local commit, clean review, or passing E2E does not complete a
ticket. Before merge, production status records the PR URL, implementation and
review heads, Gates, review, and applicable E2E. GitHub PR metadata plus the
final exact-head review identify the final head without a self-referential
status commit. The ticket remains `claimed` until its PR is merged.
After merge, record the PR URL and merge commit in the ignored local ticket,
set it to `resolved`, delete the remote and local ticket branches, and remove
the ticket worktree before starting dependent work. Do not create a second
closure PR solely to record the merge SHA.

For every ticket, implementation and review fixes run only the focused
non-E2E Gate in the table, `corepack pnpm typecheck`, and `git diff --check`.
Commit before a scoped exact-base Standards and Spec review. Provision external
E2E only after that review reports no Critical or Important findings. A code
change after E2E requires affected focused tests and a fresh review before E2E
is rerun. Stop after five review rounds; unresolved Critical/Important findings
create a ready-for-agent remediation ticket, block dependents, set the original
ticket to `needs-info`, and move to another independent frontier. Ticket 01 is
docs-only and runs no product E2E.

### Ticket Files and focused Gates

Each listed Files entry is the complete allowed scope root for that ticket;
files outside it require a reviewed amendment before editing. Tests may be
created only under the listed test roots. Every Gate is followed by root
typecheck and diff check. External/browser/native/manual/release E2E described
by the ticket runs only after clean review. In the table, `status` means the
exact file `docs/production-closure-status.md`; brace notation expands only the
literal comma-separated paths shown and is not an open-ended glob.

Ticket 02 scope amendment (approved 2026-08-20): the original row was too
narrow to implement and test the offline lock, durable backup binding, runtime
schema guards, and provider-neutral dependency direction. Its amended row below
is the complete approved scope. In particular,
`packages/core-application/src/index.ts` and
`packages/core-application/src/intelligence/server-result-consumer.ts`, together
with that package's manifest and project references, may change only to remove
the pre-existing PostgreSQL runtime dependency; this does not transfer later
Intelligence consumer behavior into Ticket 02.
Round-2 review additionally approved `apps/intelligence-worker/src/config.ts`
for the explicit Server-role startup guard and the three exact Worker component
tests below as required constructor-caller updates. No other Ticket 07 Worker
behavior transfers into Ticket 02.
Round-4 review additionally approved
`deployments/self-hosted/compose/{compose.yaml,.env.example}` and the focused
Worker Compose configuration test below solely to provide the required
`WORKER_PG_SERVER_ROLE` from the same configured role used by Server and
migration. No Ticket 12 Compose-loop behavior transfers into Ticket 02.

| Ticket | Legacy allocation | Files | Focused non-E2E Gate |
|---:|---|---|---|
| 01 | Authority prerequisite | `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md`; this plan; `docs/production-closure-status.md`; `docs/contexts/storage/CONTEXT.md`; LS-12 design/plan | document consistency plus `git diff --check` |
| 02 | Task 12 prerequisite | `apps/admin-cli/src/{commands/migrate.ts,commands/backup.ts,commands/restore.ts,backup/backup-index.ts,main.ts,index.ts,errors.ts}`; `apps/admin-cli/{package.json,tsconfig.json}`; `apps/server/src/main.ts`; `apps/server/{package.json,tsconfig.json}`; `apps/intelligence-worker/src/{main.ts,config.ts}`; `apps/intelligence-worker/{package.json,tsconfig.json}`; `packages/core-application/src/{index.ts,intelligence/postgres-intelligence-queue.ts,intelligence/server-result-consumer.ts}`; `packages/core-application/{package.json,tsconfig.json}`; `packages/storage-providers/{relational-kysely,postgres-runtime}/{src,package.json,tsconfig.json}`; `deployments/self-hosted/compose/{compose.yaml,.env.example}`; `pnpm-lock.yaml`; `tests/{conformance/storage,contract/postgres,unit/admin-cli,unit/server,unit/intelligence-worker}`; `tests/component/intelligence-worker/{lease-recovery.test.ts,result-inbox.test.ts,worker-loop.test.ts}`; status | `docker compose --env-file deployments/self-hosted/compose/.env.example -f deployments/self-hosted/compose/compose.yaml config --quiet` and `corepack pnpm vitest run tests/conformance/storage/relational-schema.test.ts tests/contract/postgres/postgres-runtime.test.ts tests/unit/admin-cli/backup.test.ts tests/unit/admin-cli/migrate.test.ts tests/unit/server/schema-startup.test.ts tests/unit/intelligence-worker/schema-startup.test.ts tests/unit/intelligence-worker/compose-config.test.ts tests/component/intelligence-worker/lease-recovery.test.ts tests/component/intelligence-worker/result-inbox.test.ts tests/component/intelligence-worker/worker-loop.test.ts` |
| 03 | Task 12 product intake | `packages/core-modules/{project-target,mission}/{src,package.json,tsconfig.json}`; `packages/contracts/public-api/{src,package.json,tsconfig.json}`; `packages/storage-providers/{relational-kysely,sqlite-runtime,postgres-runtime}/{src,package.json,tsconfig.json}`; `apps/server/src/{routes,server.ts,server-context.ts,main.ts,config.ts}`; `apps/server/{package.json,tsconfig.json}`; `apps/web-console/src`; `apps/web-console/{package.json,tsconfig.json}`; `pnpm-lock.yaml`; `tests/{unit/core-modules,contract/public-api,contract/sqlite,contract/postgres,component/web-console}`; status | `corepack pnpm vitest run tests/unit/core-modules/project-target tests/unit/core-modules/mission/test-plan-approval.test.ts tests/contract/public-api/api-v1.test.ts tests/component/web-console/workflow.test.ts` |
| 04 | Task 12 scheduling/Mission start | `packages/core-modules/{mission,runner-control}/{src,package.json,tsconfig.json}`; `packages/contracts/public-api/{src,package.json,tsconfig.json}`; `packages/storage-providers/{relational-kysely,sqlite-runtime,postgres-runtime}/{src,package.json,tsconfig.json}`; `apps/server/src/{mission-dispatch-service.ts,routes/missions.ts,server.ts,server-context.ts}`; `apps/server/{package.json,tsconfig.json}`; `apps/web-console/src/api/client.ts`; `pnpm-lock.yaml`; `tests/{unit/core-modules/mission,contract/mission,contract/sqlite,contract/postgres,contract/public-api,component/prd-planning}`; status | `corepack pnpm vitest run tests/contract/mission tests/contract/sqlite/prd-mission-store.test.ts tests/contract/postgres/prd-mission-store.test.ts tests/contract/public-api/api-v1.test.ts tests/component/prd-planning/prd-to-run.test.ts` |
| 05 | Task 12 dispatch | `apps/server/src/mission-dispatch-loop.ts`; `apps/server/{package.json,tsconfig.json}`; `packages/core-application/{src/runner,package.json,tsconfig.json}`; `packages/core-modules/runner-control/{src,package.json,tsconfig.json}`; `pnpm-lock.yaml`; `tests/{unit/core-daemon,contract/runner-control,component/core-runner}`; status | `corepack pnpm vitest run tests/contract/runner-control tests/unit/core-daemon tests/component/core-runner` |
| 06 | Task 12 Skill paths | `packages/core-modules/skill/{src,package.json,tsconfig.json}`; `packages/contracts/public-api/{src,package.json,tsconfig.json}`; `packages/storage-providers/{sqlite-runtime,postgres-runtime}/{src,package.json,tsconfig.json}`; `apps/server/src/{routes/skills.ts,server.ts,server-context.ts,main.ts,config.ts}`; `apps/server/{package.json,tsconfig.json}`; `apps/web-console/src`; `apps/web-console/{package.json,tsconfig.json}`; `pnpm-lock.yaml`; `tests/helpers/server-fixture.ts`; `tests/{unit/core-modules/skill,contract/sqlite,contract/postgres,contract/public-api,component/web-console}`; status | `corepack pnpm vitest run tests/unit/core-modules/skill tests/contract/sqlite/skill-store.test.ts tests/contract/postgres/skill-store.test.ts tests/contract/public-api/api-v1.test.ts tests/component/web-console/workflow.test.ts` |
| 07 | Task 13 durable Worker authority | `packages/core-modules/intelligence/{src,package.json,tsconfig.json}`; `packages/storage-providers/{relational-kysely,postgres-runtime}/{src,package.json,tsconfig.json}`; `apps/intelligence-worker/{src,package.json,tsconfig.json}`; `pnpm-lock.yaml`; `tests/{unit/intelligence-worker,unit/core-modules/intelligence,component/intelligence-worker,contract/postgres}`; status | `corepack pnpm vitest run tests/unit/intelligence-worker tests/unit/core-modules/intelligence tests/component/intelligence-worker tests/contract/postgres/tenant-isolation.test.ts` |
| 08 | Task 13 Server consumer | `packages/core-modules/intelligence/{src,package.json,tsconfig.json}`; `packages/core-application/{src/intelligence,package.json,tsconfig.json}`; `packages/storage-providers/{relational-kysely,postgres-runtime}/{src,package.json,tsconfig.json}`; `apps/server/src/{intelligence-result-consumer-loop,main,config}.ts`; `apps/server/{package.json,tsconfig.json}`; `pnpm-lock.yaml`; `tests/{unit/core-modules/intelligence,component/intelligence-worker,contract/postgres}`; status | `corepack pnpm vitest run tests/unit/core-modules/intelligence/result-applier.test.ts tests/component/intelligence-worker/result-inbox.test.ts tests/component/intelligence-worker/server-consumer-loop.test.ts tests/contract/postgres/intelligence-result-wakeup-store.test.ts` |
| 09 | Task 14 tenant composition | `apps/server/src/self-hosted-runner-protocol.ts`; `apps/server/{package.json,tsconfig.json}`; `packages/core-application/{src,package.json,tsconfig.json}`; `packages/core-modules/runner-control/{src,package.json,tsconfig.json}`; `packages/protocol-adapters/grpc-runner-protocol/{src,package.json,tsconfig.json}`; `packages/storage-providers/postgres-runtime/{src,package.json,tsconfig.json}`; `pnpm-lock.yaml`; `tests/{contract/runner-identity,contract/postgres,conformance/runner-protocol,component/core-runner}`; status | `corepack pnpm vitest run tests/contract/runner-identity tests/contract/postgres/tenant-isolation.test.ts tests/conformance/runner-protocol tests/component/core-runner` |
| 10 | Task 14 persistence/completion and Run/Trace reads | `packages/core-modules/{evidence,mission,runner-control}/{src,package.json,tsconfig.json}`; `packages/core-application/{src/runner,package.json,tsconfig.json}`; `packages/contracts/public-api/{src,package.json,tsconfig.json}`; `packages/storage-providers/{postgres-runtime,sqlite-runtime}/{src,package.json,tsconfig.json}`; `apps/server/src/{routes/runs.ts,server.ts,server-context.ts}`; `apps/server/{package.json,tsconfig.json}`; `apps/web-console/src/api/client.ts`; `pnpm-lock.yaml`; `tests/{contract/sqlite,contract/postgres,contract/runner-control,contract/public-api}`; status | `corepack pnpm vitest run tests/contract/runner-control tests/contract/sqlite/sqlite-trace-store.test.ts tests/contract/sqlite/sqlite-record-stores.test.ts tests/contract/postgres/postgres-trace-store.test.ts tests/contract/postgres/postgres-run-store.test.ts tests/contract/postgres/self-hosted-completion.test.ts tests/contract/public-api/api-v1.test.ts` |
| 11 | Task 14 Artifact data plane | `packages/{contracts/runner-protocol,protocol-adapters/grpc-runner-protocol,core-modules/evidence,core-modules/runner-control,storage-providers/relational-kysely,storage-providers/postgres-runtime,storage-providers/artifact-fs,storage-providers/artifact-s3,runner-components/runner-spool}/{src,package.json,tsconfig.json}`; `packages/contracts/runner-protocol/proto`; `apps/{runner,server}/{src,package.json,tsconfig.json}`; `pnpm-lock.yaml`; `tests/{conformance/runner-protocol,contract/runner-spool,contract/artifact-fs,contract/artifact-s3,contract/postgres,unit/runner}`; status | `corepack pnpm vitest run tests/conformance/runner-protocol tests/contract/runner-spool tests/contract/artifact-fs tests/contract/artifact-s3 tests/contract/postgres/artifact-upload.test.ts tests/unit/runner/trace-upload-pump.test.ts` |
| 12 | Task 14 Compose loop | `apps/server/**`; `deployments/self-hosted/compose/**`; `tests/component/server/**`; status | `docker compose --env-file deployments/self-hosted/compose/.env.example -f deployments/self-hosted/compose/compose.yaml config --quiet` and `corepack pnpm vitest run tests/component/server` |
| 13 | LS-11 Evidence closure | `packages/core-modules/evidence/{src,package.json,tsconfig.json}`; `packages/storage-providers/{relational-kysely,postgres-runtime,artifact-s3,kms-self-hosted}/{src,package.json,tsconfig.json}`; `apps/server/src/{routes/evidence.ts,server.ts,server-context.ts,main.ts,config.ts}`; `apps/server/{package.json,tsconfig.json}`; `pnpm-lock.yaml`; `tests/helpers/server-fixture.ts`; `tests/{contract/evidence-crypto,contract/kms-self-hosted,contract/artifact-s3,contract/public-api,component/investigation}`; status | `corepack pnpm vitest run tests/contract/evidence-crypto tests/contract/kms-self-hosted tests/contract/artifact-s3 tests/contract/public-api/api-v1.test.ts tests/component/investigation` |
| 14 | LS-11 auth/operations closure | `packages/{auth/oidc,observability}/{src,package.json,tsconfig.json}`; `apps/{server,intelligence-worker}/{src,package.json,tsconfig.json}`; `apps/web-console/{src,package.json,tsconfig.json}`; `deployments/self-hosted/compose/**`; `pnpm-lock.yaml`; `tests/{contract/auth,unit/observability,component/server,component/intelligence-worker,component/web-console}`; status | `corepack pnpm vitest run tests/contract/auth/oidc.test.ts tests/unit/observability tests/component/server tests/component/intelligence-worker tests/component/web-console/oidc-flow.test.ts` |
| 15 | LS-11 acceptance | `apps/admin-cli/src/commands/{backup,restore,doctor}.ts`; `deployments/self-hosted/**`; `tests/{unit/admin-cli,component/local-launcher,contract/public-api,component/web-console}`; status | `corepack pnpm vitest run tests/unit/admin-cli/backup-index.test.ts tests/component/local-launcher/backup-manager.test.ts`; the clean backup/restore acceptance waits for clean review |
| 16 | Task 16 contract expand | `packages/contracts/runner-protocol/{src,proto}`; `packages/runner-kernel/src`; `packages/core-application/src/runner/execution-job-service.ts`; `packages/protocol-adapters/{grpc-runner-protocol/src/mappers.ts,in-memory-runner-protocol/src/index.ts}`; `packages/testkit/src/index.ts`; `apps/runner/src/{offer-runtime.ts,spooling-trace-recorder.ts}`; `tests/{type,conformance/runner-protocol,unit/runner-kernel,unit/core-daemon/execution-job-service.test.ts,unit/runner/offer-runtime.test.ts,unit/runner/trace-upload-pump.test.ts}`; status | `corepack pnpm vitest run tests/conformance/runner-protocol/accepted-execution-job-plan.test.ts tests/conformance/runner-protocol/proto-schema.test.ts tests/conformance/runner-protocol/grpc-mappers.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/unit/core-daemon/execution-job-service.test.ts tests/unit/runner/offer-runtime.test.ts tests/unit/runner/trace-upload-pump.test.ts tests/contract/runner-control/sqlite-runner-control-store.test.ts` |
| 17 | Task 16 budget/usage | `packages/{contracts/model-provider,model-gateway,model-providers/openai-compatible,runner-components/model-agent,runner-kernel}/src`; `apps/runner/src/{config.ts,offer-runtime.ts,job-executor.ts}`; `apps/cli/src/{config.ts,local-run-composition-root.ts}`; `tests/{unit/model-gateway,unit/runner-components,unit/runner-kernel,contract/model-providers}`; `tests/unit/runner/job-executor.test.ts`; `tests/component/web-execution/local-run-composition-root.test.ts`; status | `corepack pnpm vitest run tests/unit/runner-kernel tests/unit/model-gateway tests/unit/runner-components/model-agent.test.ts tests/contract/model-providers/openai-compatible-model-provider.test.ts tests/unit/runner/job-executor.test.ts tests/component/web-execution/local-run-composition-root.test.ts` |
| 18 | Task 16 valueRef | `apps/runner/src/{action-value-provider,config,main,index,offer-runtime}.ts`; `packages/target-adapters/web-playwright/src`; `tests/{unit/runner,unit/target-adapters/web-playwright,component/web-execution}`; status | `corepack pnpm vitest run tests/unit/runner/action-value-provider.test.ts tests/unit/runner/offer-runtime.test.ts tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/component/web-execution` |
| 19 | Task 16 bounded Runtime | `packages/{runner-kernel,runner-components/model-agent,target-adapters/web-playwright,execution-application}/src`; `apps/runner/src`; `tests/{unit/runner-kernel,unit/runner-components,unit/target-adapters/web-playwright,component/web-execution}`; status | `corepack pnpm vitest run tests/unit/runner-kernel/execution-runtime.test.ts tests/unit/runner-components/model-agent.test.ts tests/unit/target-adapters/web-playwright tests/component/web-execution` |
| 20 | LS-09 closure | `packages/{runner-components/exploration,core-modules/mission,storage-providers/sqlite-runtime}/src`; `tests/{unit/runner-components/exploration,replay/exploration,contract/sqlite}`; status | `corepack pnpm vitest run tests/unit/runner-components/exploration tests/replay/exploration/bounded-exploration.test.ts tests/contract/sqlite/exploration-checkpoint-store.test.ts` |
| 21 | LS-09 Reference benchmark | `packages/benchmarking/detection/**`; `apps/benchmark-runner/**`; `benchmarks/detection-v1/**`; `pnpm-lock.yaml`; `tests/{unit/benchmarking/detection,contract/sqlite/benchmark-store.test.ts,e2e/detection-benchmark}`; status | `corepack pnpm vitest run tests/unit/benchmarking/detection tests/contract/sqlite/benchmark-store.test.ts` with the model provider replaced only by the existing contract seam during edit-time tests |
| 22 | Task 17 Graph expand | `packages/contracts/observation/**`; `packages/contracts/runner-protocol/src`; `tests/{conformance/observation,property/observation-graph.test.ts}`; `docs/superpowers/specs/2026-08-01-ls-12-m3-observation-graph-v1-migration-design.md`; `docs/superpowers/plans/2026-08-01-ls-12-m3-observation-graph-v1-migration.md`; status | `corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts` |
| 23 | Task 17 producer migration | `packages/{target-adapters/web-playwright,runner-kernel,contracts/runner-protocol,protocol-adapters/grpc-runner-protocol}/src`; `tests/{unit/target-adapters/web-playwright,component/web-execution,conformance/runner-protocol,conformance/observation}`; status | `corepack pnpm vitest run tests/unit/target-adapters/web-playwright tests/component/web-execution/playwright-observation.test.ts tests/conformance/runner-protocol tests/conformance/observation` |
| 24 | Task 17 consumer migration | `packages/{runner-components/model-agent,runner-components/exploration,execution-application,observation-migration}/src`; `apps/benchmark-runner/src`; `tests/{unit/runner-components,unit/execution-application,replay,property}`; status | `corepack pnpm vitest run tests/unit/runner-components/model-agent.test.ts tests/unit/runner-components/exploration tests/unit/execution-application/artifact-recording-observer.test.ts tests/replay` |
| 25 | Task 17 contract phase | `packages/{runner-kernel,runner-components/model-agent,runner-components/exploration,execution-application,target-adapters/web-playwright,observation-migration}/**`; `apps/{runner,benchmark-runner}/src`; `tests/{conformance/observation,property,migration/observation-v1,replay}`; `docs/testing/observation-graph-v1-freeze-checklist.md`; status | `corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts tests/migration/observation-v1 tests/replay` and `rg -l "\bObservationGraph\b" apps packages tests` |
| 26 | Task 18 Desktop protocol | `packages/{core-modules/project-target,contracts/desktop,contracts/runner-protocol,protocol-adapters/grpc-runner-protocol}/src`; `packages/contracts/runner-protocol/proto`; `tests/{type,contract/desktop,unit/core-modules/project-target,conformance/runner-protocol}`; status | `corepack pnpm vitest run tests/contract/desktop tests/unit/core-modules/project-target tests/conformance/runner-protocol` |
| 27 | Task 18 TypeScript client | `packages/{contracts/desktop,target-adapters/desktop-windows-uia}/src`; `tests/contract/desktop/**`; status | `corepack pnpm vitest run tests/contract/desktop` |
| 28 | Task 18 Runner composition | `apps/runner/{src,package.json,tsconfig.json}`; `packages/{runner-kernel,target-adapters/desktop-windows-uia,target-adapters/web-playwright}/{src,package.json,tsconfig.json}`; `pnpm-lock.yaml`; `tests/{unit/runner-kernel,contract/desktop,component/windows-uia,component/web-execution}`; status | `corepack pnpm vitest run tests/unit/runner-kernel/target-kind-discriminator.test.ts tests/contract/desktop/companion-action.test.ts tests/component/windows-uia/reference-app-pipeline.test.ts tests/component/web-execution/playwright-web-target.test.ts` |
| 29 | Task 19 | `rust-toolchain.toml`; `Cargo.lock`; `apps/companion/{Cargo.toml,src/ipc/**}`; `tests/rust/companion/{ipc_acl,handshake,windows_named_pipe}.rs`; status | `cargo fmt --check`; `cargo build --workspace`; `cargo test --workspace`; `corepack pnpm vitest run tests/contract/desktop/named-pipe-client.test.ts` |
| 30 | Task 20 implementation | `Cargo.lock`; `apps/companion/{Cargo.toml,src/uia/**,src/process/**,src/tray.rs,src/main.rs}`; `tests/{rust/companion,component/windows-uia,replay/windows-uia,conformance/observation/windows-uia.test.ts}`; `docs/testing/windows-m3-manual-checklist.md`; status | `cargo fmt --check`; `cargo build --workspace`; `cargo test --workspace`; `corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts` |
| 31 | Task 20 native acceptance | `docs/testing/windows-m3-manual-checklist.md`; `artifacts/manual-acceptance/**`; status | `cargo fmt --check`; `cargo build --workspace`; `cargo test --workspace`; `corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts` before local-console/RDP manual execution |
| 32 | Task 21 quarantines | `tests/component/{local-launcher/start-stop.test.ts,skill-lifecycle/recording-to-replay.test.ts,web-execution/playwright-web-target.test.ts}`; `tests/contract/kms-local/skill-signing.test.ts`; `apps/local-launcher/src/child-process-unit.ts`; `packages/target-adapters/web-playwright/src/browser-session.ts`; `packages/storage-providers/kms-local/src/local-skill-signer.ts`; `tests/helpers/windows-file-acl.ts`; status | `corepack pnpm vitest run tests/component/local-launcher/start-stop.test.ts tests/component/skill-lifecycle/recording-to-replay.test.ts tests/component/web-execution/playwright-web-target.test.ts tests/contract/kms-local/skill-signing.test.ts` and `rg -n 'TODO\(Task 21\)' tests` |
| 33 | Task 21 CI/browser | `.github/workflows/{ci,windows-companion,self-hosted}.yml`; `package.json`; `tests/e2e/web-console/browser-workflow.test.ts`; `tests/helpers/{server-fixture,oidc-jwt,infrastructure-preflight}.ts`; status | `corepack pnpm vitest run tests/component/web-console/workflow.test.ts`; rendered-browser and CI-equivalent platform Gates wait for clean review |
| 34 | Task 21 release | `.github/workflows/release.yml`; `Dockerfile`; `pnpm-workspace.yaml`; `pnpm-lock.yaml`; `deployments/self-hosted/docker/**`; `deployments/self-hosted/compose/{compose.release.yaml,release-manifest.schema.json}`; `scripts/verify-release-manifest.mjs`; `tests/release/{image-contents,release-manifest}.test.ts`; `README.md`; status | `corepack pnpm vitest run tests/release/image-contents.test.ts tests/release/release-manifest.test.ts` without publishing images |
| 35 | Task 22 | `docs/production-closure-status.md`; `docs/superpowers/implementation-status.md`; `docs/superpowers/plans/{2026-08-01-ls-02-m1-playwright-web-target.md,2026-08-01-ls-05-m1-core-runner-transport-hardening.md,2026-08-01-ls-11-m2-self-hosted-runtime-deployment.md,2026-08-01-ls-13-m3-windows-desktop-target.md}`; `docs/superpowers/roadmaps/2026-08-01-local-self-hosted-through-m3.md`; `docs/testing/{observation-graph-v1-freeze-checklist.md,windows-m3-manual-checklist.md}`; `README.md`; `packages/observation-migration/src/freeze-gate.ts`; `tests/migration/observation-v1/{freeze-decision,freeze-gate-report}.test.ts` | `corepack pnpm vitest run tests/migration/observation-v1/freeze-decision.test.ts tests/migration/observation-v1/freeze-gate-report.test.ts` |

### Post-review acceptance ownership

The following files are additive to the Files column only for the named
post-review acceptance. They may be created during implementation, but the
commands are not run until scoped review is clean. No unlisted acceptance file
is in scope.

| Ticket | Exact acceptance files | Post-review command/evidence |
|---:|---|---|
| 02 | `tests/e2e/self-hosted/backup-restore.test.ts` | Run the file against sequentially upgraded PostgreSQL and a clean restore target |
| 03 | `tests/e2e/web-console/target-test-plan.test.ts` | Run the rendered/API Target -> Test Plan -> Mission creation workflow |
| 05 | `tests/e2e/self-hosted/bound-runner-dispatch.test.ts` | Run exact bound/offline/mismatched Runner dispatch cases |
| 06 | `tests/e2e/web-console/skill-lifecycle.test.ts` | Run rendered version read, promotion conflict, and deprecation |
| 07 | `tests/e2e/self-hosted/intelligence-worker-lease.test.ts` | Run real Worker lease/renew/restart/RLS cases |
| 08 | `tests/e2e/self-hosted/intelligence-result-loop.test.ts` | Run Server/Worker restart, retry, readiness, and shutdown |
| 09 | `tests/e2e/self-hosted/tenant-runner-isolation.test.ts` | Run two-tenant same-Runner-ID admission and isolation |
| 10 | `tests/e2e/self-hosted/run-trace-completion.test.ts` | Run atomic terminal Run/attempt/Job/Mission projection |
| 11 | `tests/e2e/self-hosted/artifact-upload.test.ts` | Run reconnect/resume against real object storage |
| 12 | `tests/e2e/self-hosted/{compose,external-runner}.test.ts` | Run real Compose with an external Runner; Docker absence is `DockerUnavailable` |
| 13 | `tests/e2e/self-hosted/evidence-api.test.ts` | Run authorized S3/KMS lifecycle and unavailable-provider failures |
| 14 | `tests/e2e/self-hosted/readiness.test.ts` | Run dependency failure/recovery transitions through Server/Worker/Console/proxy |
| 15 | `tests/e2e/self-hosted/{backup-restore,acceptance}.test.ts` | Run clean-environment LS-11 backup/restore and full product acceptance |
| 18 | `tests/e2e/web-execution/value-ref.test.ts` | Run real Chromium input/select redaction workflow |
| 19 | `tests/e2e/web-execution/multi-step-plan.test.ts` | Run the complete bounded multi-step Chromium workflow |
| 20 | `tests/e2e/exploration/restart-resume.test.ts` | Interrupt the process and resume from the last safe checkpoint |
| 21 | `tests/e2e/detection-benchmark/reference-model-profile.test.ts` | Run configured frozen Reference Model Profile; no fixture walker satisfies it |
| 22 | `tests/e2e/web-execution/graph-v1-canonical.test.ts` | Run real Web capture against canonical/schema properties |
| 23 | `tests/e2e/web-execution/graph-v1-producer.test.ts` | Run Chromium producer plus Graph/extension capability negotiation |
| 24 | `tests/e2e/observation-v1/consumer-migration.test.ts` | Run model/resolver/exploration/evidence/benchmark/replay consumers together |
| 25 | `tests/e2e/observation-v1/candidate-acceptance.test.ts` | Run migration inventory and candidate-only acceptance |
| 27 | `tests/e2e/windows/companion-client.test.ts` | Run the built TypeScript client against a separate-process authenticated Named Pipe contract fixture; this is not native Companion evidence |
| 28 | `tests/e2e/windows/desktop-runner.test.ts` | Run built Runner Target Runtime through the same contract fixture without Web fallback; native Companion remains owned by tickets 29-30 |
| 29 | `tests/rust/companion/windows_named_pipe.rs`; `tests/e2e/windows/named-pipe-authority.test.ts` | Run Windows 11 native identity/replay process E2E |
| 30 | `tests/rust/companion/reference_app_scenario.rs`; `tests/e2e/windows/companion-daemon.test.ts` | Run WPF/WinUI native daemon integration after clean review |
| 31 | `artifacts/manual-acceptance/<version>/<date>-windows-m3.md` | Execute and independently sign the local-console/RDP checklist |
| 32 | the four ticket-32 test files; `.github/workflows/{ci,windows-companion}.yml` | Run both Windows and Linux platform jobs with zero quarantine skips |
| 33 | `tests/e2e/web-console/browser-workflow.test.ts`; `.github/workflows/{ci,windows-companion,self-hosted}.yml` | Run rendered browser E2E and mandatory named CI jobs |
| 34 | `.github/workflows/release.yml`; `artifacts/release/<version>/{release-manifest.json,sbom.spdx.json}` | Run BuildKit/SBOM/attestation and manifest verification against immutable digests |
| 35 | `artifacts/release/<version>/{release-manifest.json,graph-freeze-decision.json}` | Run `gate:fast`, `gate:self-hosted`, `benchmark:detection`, and `gate:release`; validate serialized evidence |

Absence of required infrastructure is a stable failure code, never a skip
counted as evidence.
- Ticket 31 remains `ready-for-human`; automated preparation does not replace
  the independent Windows 11 checklist executor and reviewer.
- Ticket 35 may record `frozen` only when every serialized evidence input and
  release artifact validates. Otherwise it deterministically records
  `candidate` and exact blockers.

```text
Tasks 1-3 (already implemented)
    ├── Task 4 (close entrypoint Gates + create committed status ledger)
    ├── Task 5 (Review provider/concurrency contract)
    ├── Task 6 (Console ID Token verification; complete)
    └── Task 7 (Runner renew)

PR5-SCOPE (repair Tasks 8-9 exact implementation scope)
    → PR5-ATOMIC (Tasks 8 and 9 as one compilable delivery unit)
    → PR5-SCOPE-B (migrate shared recovery identities)
    → PR5-R0 (authorize stacked inactive delivery)
    → PR5-R1 (client waiter + exact leaseToken wire)
    → PR5-R2 (neutral port + moved lifecycle modules)
    → PR5-R3 (gRPC stream shell)
    → PR5-R4 (Core authority, production inactive)
    → PR5-R5 (Tasks 8-9 activation commit)
    ├── Task 10 (durable Core control state through neutral runner-control port)
    └── Task 15 (deterministic execution policy; must precede production dispatch)

Task 10 + Task 15 (merged on current main)
    → Task 11 documentation authority commit and one plan review
    → complete Task 11 implementation, RED/Gate/commit, and Local dispatch activation
    → one final Task 11 implementation review (no rolling Task 12-14 review)

Tasks 9-11 + Task 15
    → Task 12 (Self-hosted Mission/Run/Skill API and matching Console client)
    → Task 13 (tenant-discoverable Server Result consumer)
    → Task 14 (Self-hosted Runner gRPC + Compose)

Task 15
    → Task 16 (bounded multi-step Web execution and valueRef handling)
    → Task 17 (live Graph v1 across all observers/consumers)
    → Task 18 (desktop Runner wiring + lossless gRPC mapping)
    → Tasks 19-20 (native Windows Companion)
    → Task 21 (browser/CI/SBOM/provenance/release Gate)
    → Task 22 (status reconciliation and Graph freeze decision)
```

## Pull request delivery plan

The 22 implementation tasks plus Prerequisite Q, the P0 build prerequisite,
SETUP-00, PR5-SCOPE, PR5-ATOMIC, PR5-SCOPE-B, and PR5-R0 ship as 28
reviewable pull requests: seven independently reviewed prerequisites and
21 product/release PRs. Each implementation Task has its own commit except
the PR5-R0 stacked packaging of Tasks 8-9. “Three PRs through Task 6”
means Product PRs 1-3; the ordered merge queue through Task 6 contains
five GitHub PRs because Q and P0 may not be absorbed into a product diff.
A pull request may contain more than one task only where the tasks form
one architectural boundary or one evidence-producing release unit. Except
for the PR5 stacked PRs, every task has its own commit, focused
RED/GREEN evidence, status-ledger update, and completion marker.

PRs are stacked in the order below. A stacked PR targets the immediately
preceding PR branch until that PR merges; then its base is updated to `main`
without rewriting already-reviewed task commits. Critical or Important findings
from either the Standards review or the Spec/architecture review block pushing
or merging. No PR may claim a production Gate from a skipped dependency.

| PR | Tasks | Branch | Initial base | Review unit | State |
|---|---:|---|---|---|---|
| Q | Prerequisite Q | `codex/pr-preflight-windows-quarantine` | `main` | Exactly four Windows-only individual test quarantines plus Task 21 removal ledger; no product/lock/manifest change | merged as PR #36 (`ceeb857`); Linux/Task 21 release block remains |
| 0 | P0 | `codex/pr0-lockfile-repair` | `codex/pr-preflight-windows-quarantine` | Frozen-lock consistency only: no manifest, runtime, or product behavior changes | merged as PR #37 (`7e24a9f`) |
| 1 | 1, 2, 4 | `codex/pr1-runtime-ops` | `codex/pr0-lockfile-repair` | Admin CLI execution, cross-platform binary entrypoints, and their clean black-box Gate | merged as PR #38 (`0820fd5`) |
| 2 | 3, 5 | `codex/pr2-review-invariants` | `codex/pr1-runtime-ops` | Review aggregate routing plus SQLite/PostgreSQL provider and writer-concurrency parity | merged as PR #39 (`89002cc`) |
| 3 | 6 | `codex/pr3-console-oidc` | `codex/pr2-review-invariants` | Browser ID Token signature verification and transient-state security | merged as PR #40 (`0753be7`) |
| SETUP-00 | SETUP-00 | `codex/pr-preflight-production-closure-plan` | `main` | Engineering context, GitHub Issues review finding tracker, and multi-context documentation | merged as PR #42 (`a9fd9b3`) |
| 4 | 7 | `codex/pr4-runner-renewal` | `main` | Lease renewal and stop-before-expiry behavior | merged as PR #43 (`09afe87`) |
| PR5-SCOPE | Tasks 8-9 scope repair | `codex/pr5-scope-prerequisite` | `main` | Declare the protocol wire/error and moved-service test files required by Tasks 8-9 | merged as PR #44 (`bfd6da2`) |
| PR5-ATOMIC | Tasks 8-9 delivery boundary | `codex/pr5-atomic-scope` | `main` | Require one compilable transport + Core composition commit and joint Gate | merged as PR #45 (`aba6a59`) |
| PR5-SCOPE-B | Task 8 identity test migration | `codex/pr5-identity-scope` | `main` | Add shared disconnect/recovery identities to the required scope migration | merged as PR #46 (`d562f8d`) |
| PR5-R0 | Tasks 8-9 delivery packaging | `codex/pr5-r0-protocol-authority` | `main` | Authorize stacked inactive PRs plus one activation commit; freeze forensic `230b6cd`; change no product Interfaces or Files | merged as PR #52 (`54ff198`) |
| PR5-R1 | Task 8 wire/client subset | `codex/pr5-r1-wire-client` | `main` | Exact `leaseToken` wire/error/type mapping and client waiter registry; production composition unchanged | merged as PR #53 (`9761fad`) |
| PR5-R2 | Tasks 8-9 module move | `codex/pr5-r2-neutral-authority` | `main` | Neutral `@qualigence/runner-control` port and four lifecycle-module moves; Core Daemon re-exports previous paths | merged as PR #54 (`f9d47c5`) |
| PR5-R3 | Task 8 stream shell | `codex/pr5-r3-grpc-stream-shell` | `main` | Bounded mailbox, fail-stop queue, generation fencing; existing production constructor remains valid | merged as PR #55 (`76cd8a3`) |
| PR5-R4 | Task 9 authority | `codex/pr5-r4-core-authority` | `main` | `CoreRunnerProtocolApplication` and in-process tests; `apps/core-daemon/src/main.ts` stays pre-activation | merged as PR #56 (`5e8dff4`) |
| 5 / PR5-R5 | 8, 9 | `codex/pr5-r5-protocol-activation` | `main` | Required application/authenticator, real SQLite/Trace composition, joint Gate, and the union commit | merged as PR #57 (`86ea179`) |
| 6 | 10 | `codex/pr6-runner-control-persistence` | `main` | Durable sessions, leases, resume tokens, Trace acknowledgements, and completion | merged as PR #60 (`06becdb`) plus PR #61 follow-ups (`114affa`) |
| 7 | 11 | `codex/task11-local-intake-loop` | `main` at `923cfa7` | Authenticated durable Local intake, authoritative completion reconciliation, truthful Runner-capability readiness, and detached Launcher supervision | documentation authority only; implementation not started |
| 8 | 12 | `codex/pr8-self-hosted-resources` | `main` | Mission, Run, Trace, and Skill public resources | pending |
| 9 | 13 | `codex/pr9-intelligence-consumer` | `main` | Production Intelligence Result Inbox consumer | pending |
| 10 | 14 | `codex/pr10-self-hosted-runner-data-plane` | `main` | External Runner gRPC data plane and full Compose loop | pending |
| 11 | 15 | `codex/pr11-execution-policy` | `main` | Immutable deterministic Job policy snapshot | merged as PR #63 (`5120c1f`) plus PR #65 provenance follow-up (`923cfa7`) |
| 12 | 16 | `codex/pr12-multistep-web` | `main` | Bounded multi-step Web execution and safe `valueRef` resolution | pending |
| 13 | 17 | `codex/pr13-observation-graph-v1` | `main` | Live Graph v1 producer/consumer migration | pending |
| 14 | 18 | `codex/pr14-desktop-runner-client` | `main` | Desktop Target dispatch and TypeScript Named Pipe client | pending |
| 15 | 19 | `codex/pr15-windows-pipe-server` | `main` | Native Named Pipe identity and authenticated Companion server | blocked by `CargoUnavailable` |
| 16 | 20 | `codex/pr16-windows-uia-daemon` | `main` | Native UIA worker, Job Object host, and Companion daemon | blocked by PR 15 and `CargoUnavailable` |
| 17 | 21, 22 | `codex/pr17-release-closure` | `main` | Cross-platform release evidence, CI/SBOM/provenance, documentation reconciliation, and evidence-gated Graph freeze | pending |

Merge Q, P0, Product PR 1, Product PR 2, and Product PR 3 in exactly that order.
After each merge, rebase/restack the next branch onto updated `main`, rerun all
required Gates, inspect its three-dot diff, and repeat both review axes whenever
the diff changes. A green Windows run while Q is active proves only that no
additional Windows regression was introduced; it does not satisfy Task 21 or
the release Gate.

For PRs 4-17, `Initial base: main` means the branch is created from the latest
merged prerequisite, not today's `main`. The dependency graph above remains
authoritative; the table is a packaging plan, not permission to bypass an
unfinished prerequisite.

Each PR description must include:

1. the covered Task numbers and exact plan section;
2. architectural boundaries changed and boundaries intentionally unchanged;
3. RED evidence followed by focused GREEN commands and counts;
4. full typecheck/build status plus every explicit environmental block;
5. Standards and Spec/architecture review results and the commits that resolve
   any blocking findings;
6. deployment, migration, security, rollback, and compatibility impact;
7. the next stacked PR and whether reviewers should review it before the base
   PR merges.

While Q is active, every affected PR description must also list the four exact
Windows skips, their Task 21 ownership, the latest platform counts, and the
statement “quarantined green is not release completion.” No new failure may be
added to Q without a new reviewed plan change.

**User-approved bounded baseline waiver (2026-08-16):** Q and P0 may merge while
the sole full-suite failure is the pre-existing Local Launcher `init` E2E that
Product PR 1 already fixes. The waiver does not cover any second failure, any
additional skip, a focused/typecheck/build/frozen-install failure, or a change
to the four Task 21 quarantine cases. Product PR 1 must be the next product
merge after Q and P0 and must restore the full Windows suite to zero failures;
otherwise stop the stack and reopen this checkpoint. This waiver is integration
authority only and does not convert the failing Gate into passed evidence.

### Through-Task-6 review and merge checkpoint

- [x] **Merge checkpoint 1: Q**

Create `codex/pr-preflight-windows-quarantine` from current `origin/main`, apply
Prerequisite Q, push it, and open it against `main`. Verify the three-dot diff
contains only Q's six authorized files. Run Q's Windows/focused/typecheck Gates,
complete Standards and Spec/architecture review, resolve every Critical or
Important finding, rerun affected Gates, and merge Q. Record the remote PR URL,
merge commit, counts, active skips, and Linux evidence/block in the ledger.

- [x] **Merge checkpoint 2: P0**

Restack `codex/pr0-lockfile-repair` on the merged Q commit. Verify
`main...codex/pr0-lockfile-repair` changes only `pnpm-lock.yaml`, run frozen
install twice from a clean worktree, complete both review axes, and merge P0.
Any manifest, plan, runtime, generated-file, or selected direct-version diff
blocks the merge.

- [x] **Merge checkpoint 3: Product PR 1 — Tasks 1, 2, and 4**

Restack `codex/pr1-runtime-ops` on merged P0. Run the 17-test focused black-box
Gate, build, typecheck, and the full Windows suite with exactly Q's four skips.
Inspect `main...codex/pr1-runtime-ops`, complete both review axes, resolve and
reverify blocking findings, then merge. Confirm Admin CLI command parsing,
Doctor fail-closed behavior, seven direct-entrypoint cases, and Launcher E2E
remain in the final diff/evidence.

Completed as PR #38 with merge commit `0820fd5` after focused, full Windows,
build, typecheck, and both review axes passed.

- [x] **Merge checkpoint 4: Product PR 2 — Tasks 3 and 5**

Restack `codex/pr2-review-invariants` on merged Product PR 1. With Docker
running, execute the focused 60-test Review set, server typecheck, root
typecheck, and full Windows suite with no skip beyond Q. Inspect the three-dot
diff, complete both review axes, and merge only after SQLite and PostgreSQL both
prove reservation-first idempotency, transaction-bound CAS/audit rollback, and
the public `actualVersion` conflict contract.

Completed as PR #39 with merge commit `89002cc` after the 67-test focused Review
Gate, full Windows Gate, build, typecheck, and both review axes passed.

- [x] **Merge checkpoint 5: Product PR 3 — Task 6**

Restack `codex/pr3-console-oidc` on merged Product PR 2. Run its 15 focused OIDC
tests, Web Console/root typecheck, build, and full Windows suite with no skip
beyond Q. Inspect the three-dot diff, complete both review axes, and merge only
after RS256 and ES256 success plus tampered token, unknown key, disallowed
algorithm, wrong issuer/audience, expiry, and unavailable JWKS failure paths all
prove verification precedes nonce/claim use and clears transient state on error.

Completed as PR #40 with merge commit `0753be7` after the 39-test focused OIDC
Gate, full Windows Gate, frozen install, build, typecheck, and both final review
axes passed. Tasks 1-6 are merged into `main`; Task 21 and the release Gate stay
open until all four Windows quarantines are removed and verified on Windows and
Linux.

The ledger now records Tasks 1-6 as merged. Task 21 and the release Gate remain
open; Q stays visible until Task 21 restores all four tests on Windows and Linux.

---

### Task 00: Prerequisite SETUP-00 — Engineering context, issue tracker, and review guidance

**Execution status:** in_progress.

**Files:**
- Create: `AGENTS.md`
- Create: `CONTEXT-MAP.md`
- Create: `docs/agents/domain.md`
- Create: `docs/agents/issue-tracker.md`
- Create: `docs/contexts/deployment/CONTEXT.md`
- Create: `docs/contexts/evidence/CONTEXT.md`
- Create: `docs/contexts/execution/CONTEXT.md`
- Create: `docs/contexts/intelligence/CONTEXT.md`
- Create: `docs/contexts/product/CONTEXT.md`
- Create: `docs/contexts/protocol/CONTEXT.md`
- Create: `docs/contexts/storage/CONTEXT.md`
- Create: `docs/contexts/windows/CONTEXT.md`
- Modify: `.gitignore`
- Modify: `vitest.config.ts`
- Modify: `tests/contract/review/postgres-review-task-repository.test.ts`
- Modify: `tests/component/local-launcher/start-stop.test.ts`
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Produces `AGENTS.md` describing agent skills, issue-tracker usage, multi-context reading rules, and plan boundary constraints.
- Produces `docs/agents/issue-tracker.md`; SETUP-00 initially configured GitHub Issues in `ljie-PI/Qualigence`, while later operational configuration may select another supported backend without changing closure task authority.
- Produces `CONTEXT-MAP.md` routing execution, product, protocol, intelligence, evidence, storage, deployment, and windows domains to `docs/contexts/*/CONTEXT.md`.
- Produces eight domain `CONTEXT.md` files defining stable terms, ownership, seams, invariants, entrypoints, cited architecture/spec references, and verification commands.
- Ignores `.worktrees/` in `.gitignore` without altering build manifests, runtime packages, lockfiles, or product code.
- Stabilizes parallel test baseline execution by reusing provisioned PostgreSQL test fixtures across contract test runs and aligning supervisor test timeouts under full suite concurrency.

- [ ] **Step 1: Write context, tracker, and ignore definitions**

Create `.gitignore` entry `.worktrees/`, `AGENTS.md`, `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, `CONTEXT-MAP.md`, and eight `docs/contexts/*/CONTEXT.md` files.

- [ ] **Step 2: Verify documentation consistency and Git checks**

Run `git diff --check` and verify `git check-ignore -v .worktrees/probe`.

- [ ] **Step 3: Stabilize and verify the required baseline Gate**

Capture the failing full-suite hook/timeout behavior before changing the test
harness. Reuse one provisioned PostgreSQL fixture across the Review provider
contract while truncating only its three Review tables between cases. Keep
trigger and race tests on isolated fixtures. Align the full-suite Vitest ceiling
and the local supervisor exhaustion wait without weakening their behavior.

Run:

```powershell
$env:PATH = 'C:\Program Files\Git\usr\bin;' + $env:PATH
$env:OPENSSL_CONF = 'C:\Program Files\Git\usr\ssl\openssl.cnf'
corepack pnpm vitest run tests/contract/review/postgres-review-task-repository.test.ts tests/component/local-launcher/start-stop.test.ts tests/e2e/admin-cli.test.ts
corepack pnpm test
corepack pnpm typecheck
git diff --check
```

- [ ] **Step 4: Run two-axis `/code-review`**

Execute `/code-review` for Standards and Spec/architecture axes against the exact merge-base SHA. Resolve any Critical or Important findings with dedicated fix commits and re-review before merge.

---

### Task 0: Prerequisite Q — quarantine four known Windows baseline tests

**Execution status:** implementation and dual PR review complete; merge approved
under the bounded baseline waiver above; Linux verification blocked. This is a
temporary integration prerequisite and remains release-blocking until Task 21
removes it.

**Files:**
- Modify: `tests/component/local-launcher/start-stop.test.ts`
- Modify: `tests/component/skill-lifecycle/recording-to-replay.test.ts`
- Modify: `tests/component/web-execution/playwright-web-target.test.ts`
- Modify: `tests/contract/kms-local/skill-signing.test.ts`
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Produces exactly four individual `it.skipIf(process.platform === "win32")`
  declarations; no `describe.skipIf`, file-level guard, environment probe, or
  non-Windows skip is allowed.
- Preserves every original test body and assertion for Linux/POSIX execution.
- Produces one source marker per skip in the exact form
  `TODO(Task 21): remove this Windows quarantine after ...` with the remediation
  text defined below.
- Does not change production code, package manifests, TypeScript configuration,
  dependency versions, migrations, generated output, or `pnpm-lock.yaml`.

- [x] **Step 1: Capture the four-case Windows RED without editing tests**

Run from a clean worktree on Windows:

```bash
corepack pnpm vitest run tests/component/local-launcher/start-stop.test.ts tests/component/skill-lifecycle/recording-to-replay.test.ts tests/component/web-execution/playwright-web-target.test.ts tests/contract/kms-local/skill-signing.test.ts
```

Record the exact four failing test names, error messages, command, platform,
Node/pnpm versions, and counts in `docs/production-closure-status.md`. Qualifying
RED is limited to:

- `escalates SIGTERM to SIGKILL for a process that ignores SIGTERM`: portable
  lifecycle behavior cannot be inferred from an elapsed-time minimum on Windows;
- `records, induces, compiles, verifies, signs, promotes, reopens and replays`:
  the reopened SQLite runtime remains open when Windows removes the temp tree;
- `runs observe -> resolve -> execute -> artifacts -> close and reaps the browser`:
  the process-leak assertion enumerates Linux `/proc`;
- `generates a user-only private key and a publishable keyId`: the assertion
  treats POSIX `0600` mode bits as a Windows ACL contract.

Any fifth failure, different exception, missing dependency, or infrastructure
failure is outside this prerequisite and stops the task for review.

- [x] **Step 2: Add four individual Windows-only quarantine markers**

Change only the four named cases. Keep their callbacks unchanged and place the
specific marker immediately above each declaration:

```ts
// TODO(Task 21): remove this Windows quarantine after lifecycle assertions use observable process events instead of minimum elapsed time.
it.skipIf(process.platform === "win32")(
  "escalates SIGTERM to SIGKILL for a process that ignores SIGTERM",
  async () => {
    // Existing test body remains byte-for-byte unchanged.
  },
);

// TODO(Task 21): remove this Windows quarantine after every reopened SQLite runtime closes before temporary-directory cleanup.
it.skipIf(process.platform === "win32")(
  "records, induces, compiles, verifies, signs, promotes, reopens and replays",
  async () => {
    // Existing test body remains byte-for-byte unchanged.
  },
);

// TODO(Task 21): remove this Windows quarantine after browser-process leak checks use a cross-platform lifecycle seam instead of /proc.
it.skipIf(process.platform === "win32")(
  "runs observe -> resolve -> execute -> artifacts -> close and reaps the browser",
  async () => {
    // Existing test body remains byte-for-byte unchanged.
  },
);

// TODO(Task 21): remove this Windows quarantine after key protection is asserted with Windows ACLs and POSIX mode bits per platform.
it.skipIf(process.platform === "win32")(
  "generates a user-only private key and a publishable keyId",
  () => {
    // Existing test body remains byte-for-byte unchanged.
  },
);
```

The comments inside the callbacks above are plan notation only: the implementer
must retain the existing callback bodies, not replace them with comments.

- [x] **Step 3: Prove the quarantine is exact on Windows**

Run the four-file command from Step 1 and then the full suite:

```bash
corepack pnpm vitest run tests/component/local-launcher/start-stop.test.ts tests/component/skill-lifecycle/recording-to-replay.test.ts tests/component/web-execution/playwright-web-target.test.ts tests/contract/kms-local/skill-signing.test.ts
corepack pnpm test
corepack pnpm typecheck
git diff --check
```

Expected: the four named cases are reported as skips only on Windows; no other
test becomes skipped; the full suite has no failure previously attributed to
the four cases. Record actual counts rather than assuming the previous total.

- [x] **Step 4: Prove non-Windows coverage remains active**

On a Linux executor, run the Step 1 four-file command. Expected: all four named
cases execute rather than skip. If Linux execution is unavailable, record
`LinuxExecutorUnavailable`; Q may be merged for Windows integration only after
both reviews explicitly accept that block, but it cannot claim cross-platform
or release completion.

Execution result: `LinuxExecutorUnavailable`; no Linux test execution or pass
is claimed.

- [x] **Step 5: Record debt ownership and commit only the authorized scope**

Add four ledger rows to `docs/production-closure-status.md`, each containing the
file, exact test name, Windows reason, Task 21 remediation, introducing commit/
PR, Windows evidence, Linux evidence, and `removal_state: pending`.

Run:

```bash
git diff --name-only
git diff --check
```

Expected changed files are exactly the six paths in **Files**. Commit:

```bash
git add tests/component/local-launcher/start-stop.test.ts tests/component/skill-lifecycle/recording-to-replay.test.ts tests/component/web-execution/playwright-web-target.test.ts tests/contract/kms-local/skill-signing.test.ts docs/superpowers/plans/2026-08-16-production-closure-temporary.md docs/production-closure-status.md
git commit -m "test(windows): quarantine four task 21 portability cases"
```

- [x] **Step 6: Review Q before restacking P0**

Run Standards review and Spec/architecture review against `main...Q`. Critical
or Important findings block merge. The review must explicitly confirm four and
only four individual Windows skips, unchanged test bodies, Linux execution or
its named block, no product/manifest/lockfile diff, and Task 21 removal coverage.

---

### Prerequisite P0: Restore the frozen lock graph

**Execution status:** complete. This is an independently reviewable build
prerequisite, not part of Task 4 and not authority for future lock regeneration.

**Files:**
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Preserves every package manifest and selected direct dependency version.
- Restores the exact peer-dependency snapshot already referenced by importers.
- Does not change runtime code, migrations, public contracts, or deployment configuration.

- [x] **Step 1: Capture the isolated frozen-install RED**

In a fresh worktree run `corepack pnpm install --frozen-lockfile`. The qualifying
RED is `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY` naming the already-referenced Vite
8.1.5 peer snapshot. Any registry, manifest, integrity, or platform error is not
authority to edit the lockfile.

- [x] **Step 2: Repair only the inconsistent graph**

With TLS verification enabled and the trusted local HTTP proxy set only for the
command environment, run:

```bash
corepack pnpm install --lockfile-only --fix-lockfile --ignore-scripts
```

Review the exact diff. It may add only the missing Vite/Rolldown transitive peer
graph; it must not change a manifest, select a different direct dependency, or
run package scripts.

- [x] **Step 3: Prove the repaired lock is consumable**

Run:

```bash
corepack pnpm install --frozen-lockfile
git diff --check
```

Commit the lock repair separately from Tasks 1, 2, and 4. Product PR 1 must
target the P0 branch so its three-dot diff contains no lockfile repair.

---

### Task 1: Make Admin CLI commands execute and Doctor fail closed

**Execution status:** implementation committed as `f200d6d`; do not reimplement. Focused clean-worktree verification is owned by Task 4.

**Files:**
- Modify: `apps/admin-cli/src/main.ts`
- Modify: `apps/admin-cli/src/commands/doctor.ts`
- Modify: `tests/migration/observation-v1/admin-command.test.ts`
- Create: `tests/e2e/admin-cli.test.ts`

**Interfaces:**
- Consumes: `run(argv: readonly string[], io?: AdminIo, env?: NodeJS.ProcessEnv): Promise<void>`.
- Produces: the same public signature; `argv` is interpreted as user arguments, not a full Node argv vector.
- Produces: `checkKms(...)` as an async fail-closed check used only inside `runDoctor`.

- [ ] **Step 1: Add failing command-parser tests**

Add focused tests that inject `AdminIo`, call `await run(["--help"], io, {})`, and assert help contains `migrate`, `doctor`, `backup`, and `restore`. Add `await run(["unknown-command"], io, {})` and assert a non-zero exit was requested. Preserve the existing migration-command tests.

```ts
const lines: string[] = [];
const exits: number[] = [];
await run(["--help"], {
  out: (line) => lines.push(line),
  err: (line) => lines.push(line),
  exit: (code) => exits.push(code),
}, {});
expect(lines.join("\n")).toContain("migrate");
expect(lines.join("\n")).toContain("doctor");
```

- [ ] **Step 2: Add a failing Doctor KMS test**

Use the existing valid admin configuration fixture and call `runDoctor(config, { kmsAvailable: false, httpProbe: async () => ({ ok: true, status: 200 }) })`. Stub only PostgreSQL/S3 at their existing seams; assert the returned KMS check is `fail` with code `KmsUnavailable` and overall status is `unhealthy`.

- [ ] **Step 3: Run the focused tests and confirm the current failures**

Run: `corepack pnpm vitest run tests/migration/observation-v1/admin-command.test.ts tests/e2e/admin-cli.test.ts`

Expected before implementation: help/unknown-command tests show that no parse occurs; the unavailable KMS path is incorrectly reported or produces an unhandled rejection.

- [ ] **Step 4: Parse user argv and route Commander output through AdminIo**

Configure Commander output, then await parsing inside the existing try/catch:

```ts
program.configureOutput({
  writeOut: (value) => io.out(value.trimEnd()),
  writeErr: (value) => io.err(value.trimEnd()),
});

try {
  await program.parseAsync([...argv], { from: "user" });
} catch (error) {
  const code = (error as { exitCode?: number }).exitCode ?? 1;
  if (code !== 0) io.exit(code);
}
```

Do not call `process.exit()`; retain injected `AdminIo` and `process.exitCode` behavior.

- [ ] **Step 5: Await the KMS operation**

Change `checkKms` to `async function checkKms(...): Promise<DoctorCheck>`, await `kms.encryptionProfile(...)`, and change the caller to `checks.push(await checkKms(...))`. Keep the safe messages and stable error code unchanged.

- [ ] **Step 6: Add a binary black-box assertion**

In `tests/e2e/admin-cli.test.ts`, spawn `node apps/admin-cli/dist/main.js --help` after build and assert exit 0 plus visible command names. Spawn `node apps/admin-cli/dist/main.js definitely-unknown` and assert non-zero. Do not invoke real backup, restore, PostgreSQL, or S3 in this black-box test.

- [ ] **Step 7: Verify and commit**

Run:

```bash
corepack pnpm build
corepack pnpm vitest run tests/migration/observation-v1/admin-command.test.ts tests/e2e/admin-cli.test.ts
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add apps/admin-cli/src/main.ts apps/admin-cli/src/commands/doctor.ts tests/migration/observation-v1/admin-command.test.ts tests/e2e/admin-cli.test.ts
git commit -m "fix(admin): execute operator commands fail closed"
```

---

### Task 2: Normalize direct-entrypoint detection on Windows and POSIX

**Execution status:** implementation committed as `603439b`; do not reimplement. The clean seven-binary/Launcher Gate is owned by Task 4.

**Files:**
- Modify: `apps/admin-cli/src/main.ts`
- Modify: `apps/core-daemon/src/main.ts`
- Modify: `apps/runner/src/main.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/intelligence-worker/src/main.ts`
- Modify: `apps/local-launcher/src/main.ts`
- Modify: `apps/benchmark-runner/src/main.ts`
- Create: `tests/smoke/node-entrypoints.test.ts`

**Interfaces:**
- Consumes: `pathToFileURL(path: string).href` from `node:url`.
- Produces: no new public package API; only correct binary activation.

- [ ] **Step 1: Add failing spawned-entrypoint smoke tests**

Spawn each built binary with an argument/environment that proves its main function ran:

```ts
const cases = [
  { file: "apps/admin-cli/dist/main.js", args: ["--help"], expected: /migrate/ },
  { file: "apps/local-launcher/dist/main.js", args: ["--help"], expected: /init|start/ },
];
```

For Core, Runner, Server, and Worker, remove their required environment variables and assert they exit non-zero with a missing-configuration message rather than silent exit 0. For benchmark runner, use its help or invalid-profile path and assert visible output/non-zero. Sanitize only the variables required by that child; inherit `PATH` and system variables.

- [ ] **Step 2: Verify the smoke test fails on Windows before the fix**

Run: `corepack pnpm build && corepack pnpm vitest run tests/smoke/node-entrypoints.test.ts`

Expected on Windows before implementation: at least Local Launcher/Core/Runner exits silently because `file://${process.argv[1]}` is not a canonical file URL.

- [ ] **Step 3: Replace every raw file URL comparison**

In each file import `pathToFileURL` and use this exact pattern:

```ts
import { pathToFileURL } from "node:url";

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
```

Do not use `new URL("file://...")`, string replacement, slash normalization, or platform branches.

- [ ] **Step 4: Verify and commit**

Run:

```bash
corepack pnpm build
corepack pnpm vitest run tests/smoke/node-entrypoints.test.ts tests/e2e/local-launcher.test.ts
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add apps/admin-cli/src/main.ts apps/core-daemon/src/main.ts apps/runner/src/main.ts apps/server/src/main.ts apps/intelligence-worker/src/main.ts apps/local-launcher/src/main.ts apps/benchmark-runner/src/main.ts tests/smoke/node-entrypoints.test.ts
git commit -m "fix(runtime): invoke node binaries cross platform"
```

---

### Task 3: Route Review mutations through the aggregate application handlers

**Execution status:** complete in `3071da0` + contract-preservation fix `fd788df`. Focused PostgreSQL tests passed with Docker. Task 5 adds provider parity and true two-writer coverage; do not reopen HTTP route composition here.

**Files:**
- Create: `apps/server/src/postgres-review-task-repository.ts`
- Modify: `apps/server/package.json`
- Modify: `apps/server/tsconfig.json`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/server-context.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/routes/review-tasks.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `tests/helpers/server-fixture.ts`
- Modify: `tests/e2e/web-console/review-conflict.test.ts`
- Modify: `tests/contract/public-api/api-v1.test.ts`
- Modify: `tests/component/web-console/api-client.contract.test.ts`

**Interfaces:**
- Consumes: `ReviewTaskRepository`, `ClaimReviewTaskHandler`, `ResolveReviewTaskHandler` from `@qualigence/review`.
- Produces: `PostgresReviewTaskRepository implements ReviewTaskRepository`, constructed with the request's tenant-scoped `Kysely<PostgresDatabase>`.
- Produces: `ServerDeps.reviewRepository(stores: TenantStores): ReviewTaskRepository`.

- [ ] **Step 1: Add failing public API invariant tests**

Add all four cases through the real Fastify route and PostgreSQL fixture:

1. Claiming an already claimed task with a new expected version returns 409 and does not replace the assignee.
2. Resolving an open task returns 409.
3. Resolving a claimed task as a non-assignee returns 409 and preserves status/assignee/version.
4. Replaying the same idempotency key returns the already-applied aggregate without another version increment.

Assert the database row after every rejected mutation; response status alone is insufficient.

- [ ] **Step 2: Confirm current direct-SQL routes violate at least one invariant**

Run: `corepack pnpm vitest run tests/e2e/web-console/review-conflict.test.ts tests/contract/public-api/api-v1.test.ts`

Expected before implementation: resolve-open or resolve-by-non-assignee succeeds incorrectly.

- [ ] **Step 3: Implement the tenant-scoped repository adapter**

Model it on `SqliteReviewStore`, but use the request transaction. Every conditional update must include status, version, and assignee where applicable:

```ts
const updated = await this.db
  .updateTable("review_tasks")
  .set({ status: "claimed", assignee_id: command.reviewerId, version: command.expectedVersion + 1 })
  .where("task_id", "=", command.taskId)
  .where("status", "=", "open")
  .where("version", "=", command.expectedVersion)
  .executeTakeFirst();
```

Resolve must additionally use `.where("status", "=", "claimed")` and `.where("assignee_id", "=", command.reviewerId)`. Check the idempotency table before the conditional update. Insert claim/resolution audit rows in the same tenant transaction. Return `undefined` when the compare-and-set did not update exactly one row.

- [ ] **Step 4: Wire handlers into the HTTP routes**

Add `reviewRepository` to `ServerDeps`, construct it in `main.ts`, and in each mutation route create the corresponding handler and call `handle(command)`. Remove duplicated transition SQL from the route. Keep DTO mapping, authentication, RBAC, tenant transaction, idempotency header, and safe 409 envelope behavior.

- [ ] **Step 5: Map domain errors without leaking internal SQL**

Map `ReviewTaskVersionConflict`, `ReviewTaskNotOpen`, `ReviewTaskNotClaimed`, `ReviewTaskNotAssignee`, and `ReviewTaskAlreadyResolved` to 409. Preserve the existing public envelope keys `expectedVersion` and `actualVersion`; the Console reads `details.actualVersion`. Include `assigneeId` only when the existing API envelope permits it. Never expose SQL/library messages.

- [ ] **Step 6: Verify and commit**

Run:

```bash
corepack pnpm vitest run tests/unit/core-modules/review tests/component/review/concurrent-claim.test.ts tests/e2e/web-console/review-conflict.test.ts tests/contract/public-api/api-v1.test.ts
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add apps/server/package.json apps/server/tsconfig.json apps/server/src pnpm-lock.yaml tests/helpers/server-fixture.ts tests/e2e/web-console/review-conflict.test.ts tests/contract/public-api/api-v1.test.ts tests/component/web-console/api-client.contract.test.ts
git commit -m "fix(server): enforce review aggregate invariants"
```

---

### Task 4: Close Tasks 1-2 black-box Gates and create the committed evidence ledger

**Execution status:** complete. This verification closure passed in a clean detached worktree; the committed evidence ledger records the exact commands, Windows OpenSSL resolution, and the remaining root Playwright CLI defect. Commits `f200d6d` and `603439b` remain the implementation sources; do not reopen them without a new behavior regression.

**Scope approval (2026-08-17):** The user approved updating this plan after every Task/PR, limited to checkbox, PR-state, and verification-evidence updates only; this does not authorize behavior or specification expansion.

**Files:**
- Create: `docs/production-closure-status.md`
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`
- Modify only if a Gate proves the corresponding behavior is wrong: `apps/admin-cli/src/main.ts`
- Modify only if a Gate proves the corresponding behavior is wrong: `apps/admin-cli/src/commands/doctor.ts`
- Modify only if a Gate proves the corresponding behavior is wrong: `apps/core-daemon/src/main.ts`
- Modify only if a Gate proves the corresponding behavior is wrong: `apps/runner/src/main.ts`
- Modify only if a Gate proves the corresponding behavior is wrong: `apps/server/src/main.ts`
- Modify only if a Gate proves the corresponding behavior is wrong: `apps/intelligence-worker/src/main.ts`
- Modify only if a Gate proves the corresponding behavior is wrong: `apps/local-launcher/src/main.ts`
- Modify only if a Gate proves the corresponding behavior is wrong: `apps/benchmark-runner/src/main.ts`
- Modify: `tests/e2e/admin-cli.test.ts`
- Modify: `tests/smoke/node-entrypoints.test.ts`
- Modify: `tests/e2e/local-launcher.test.ts`
- Modify: `tests/migration/observation-v1/admin-command.test.ts`

**Interfaces:**
- Produces the first committed `docs/production-closure-status.md` ledger with independent `component`, `production_wiring`, and `verification` dimensions.
- Preserves the public Admin `run(argv, io, env)` API and all application entrypoint APIs.
- Establishes a clean-worktree black-box baseline for the exact built JavaScript binaries, not TypeScript source imports.

- [x] **Step 1: Establish a clean, reproducible toolchain before testing**

Use a fresh isolated worktree with no shared or junctioned `node_modules`. Record all four preflight results in the status ledger:

```bash
node --version
corepack pnpm --version
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright --version
```

Required: Node major `24`, pnpm exactly `11.7.0`, and a successful frozen install. If the trusted registry is unavailable, retry once with `corepack pnpm install --offline --frozen-lockfile`; if the store is incomplete, stop and record `RegistryUnavailable`. Do not change registry trust, disable TLS verification, regenerate the lock, or reuse the known temporary dependency junction.

- [x] **Step 2: Preserve the earlier incomplete verification as RED evidence**

In `docs/production-closure-status.md`, record that Task 1 had no focused GREEN in the original worktree and Task 2 reached only 5/7 smoke cases. This is the RED/blocked starting evidence for this verification-only task. Do not manufacture a failing source test when the implemented behavior already passes in the clean environment.

Create the ledger with this exact schema:

```md
| capability | component | production_wiring | verification | evidence | commit |
|---|---|---|---|---|---|
| Admin CLI | complete | complete | blocked | `command` — reason | `f200d6d` |
```

Allowed values are `missing | partial | complete` for the first two dimensions and `not_run | blocked | failed | passed` for verification. Add an append-only evidence log containing date, host OS, command, exit code, pass/fail/skip counts, and environmental block. Never place secrets, tokens, or connection strings in this file.

- [x] **Step 3: Build and run every direct binary as a child process**

Run:

```bash
corepack pnpm build
corepack pnpm vitest run tests/smoke/node-entrypoints.test.ts tests/e2e/admin-cli.test.ts tests/e2e/local-launcher.test.ts tests/migration/observation-v1/admin-command.test.ts
```

The smoke suite must cover all seven direct-entrypoint guards: Admin CLI, Local Launcher, Core Daemon, Runner, Server, Intelligence Worker, and Benchmark Runner. Admin/Launcher help must print their command surface. Core/Runner/Server/Worker must run their real `main` and fail non-zero on deliberately missing configuration. Benchmark must show help or a stable invalid-profile error. No case may accept silent exit 0 as success.

- [x] **Step 4: Diagnose only real behavior failures**

If a child cannot resolve a package, return to Step 1; that is not an entrypoint code defect. If a built child silently exits or Doctor reports KMS healthy after an awaited rejection, first add or tighten the failing case in the listed test file, then make the smallest correction in the matching listed source file. Preserve the canonical direct invocation predicate:

```ts
process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
```

Do not broaden the source scope to unrelated applications.

- [x] **Step 5: Verify and commit the baseline evidence**

Run:

```bash
corepack pnpm typecheck
corepack pnpm vitest run tests/migration/observation-v1/admin-command.test.ts tests/smoke/node-entrypoints.test.ts tests/e2e/admin-cli.test.ts tests/e2e/local-launcher.test.ts
git diff --check
```

Update the Admin CLI and Node entrypoint ledger rows to `verification: passed` only when these commands exit 0 without infrastructure skips. Keep unrelated full-suite failures as separate evidence rather than changing these two rows.

Path correction recorded during execution: `tests/unit/admin-cli` does not
exist in this repository. The actual Admin CLI parsing and Doctor unit boundary
is `tests/migration/observation-v1/admin-command.test.ts`, which is the focused
file run above.

Commit:

```bash
git add docs/production-closure-status.md apps/admin-cli/src apps/core-daemon/src/main.ts apps/runner/src/main.ts apps/server/src/main.ts apps/intelligence-worker/src/main.ts apps/local-launcher/src/main.ts apps/benchmark-runner/src/main.ts tests/e2e/admin-cli.test.ts tests/smoke/node-entrypoints.test.ts tests/e2e/local-launcher.test.ts tests/migration/observation-v1/admin-command.test.ts
git commit -m "test(runtime): close entrypoint production gates"
```

---

### Task 5: Add one Review repository contract and true PostgreSQL writer concurrency

**Execution status:** complete after post-merge dual-axis review fixes. One provider-neutral contract passes against SQLite and PostgreSQL, its concurrent PostgreSQL case runs two independent tenant transactions, tenant scope is explicit at the persistence port, and idempotency replay requires the complete persisted command to match.

**Files:**
- Create: `tests/contract/review/review-task-repository.contract.ts`
- Create: `tests/contract/review/sqlite-review-task-repository.test.ts`
- Create: `tests/contract/review/postgres-review-task-repository.test.ts`
- Modify: `tests/contract/sqlite/investigation-review-store.test.ts`
- Read: `tests/helpers/server-fixture.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/sqlite-review-store.ts`
- Modify: `apps/server/src/postgres-review-task-repository.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Produces one exported `reviewTaskRepositoryContract(name, createHarness)` suite executed unchanged against SQLite and PostgreSQL.
- The test-only harness exposes repository operations as callbacks so a PostgreSQL repository never escapes its tenant transaction.
- Preserves the production `ReviewTaskRepository` interface and its documented atomic compare-and-set/idempotent-replay semantics.

- [x] **Step 1: Define the provider-neutral harness and shared cases**

In `tests/contract/review/review-task-repository.contract.ts`, define:

```ts
export interface ReviewRepositoryContractHarness {
  runPrimary<T>(operation: (repository: ReviewTaskRepository) => Promise<T>): Promise<T>;
  runConcurrent<T>(operation: (repository: ReviewTaskRepository) => Promise<T>): Promise<T>;
  readClaimAudit(idempotencyKey: string): Promise<{
    readonly taskId: string;
    readonly reviewerId: string;
    readonly claimedVersion: number;
  } | undefined>;
  readResolutionAudit(idempotencyKey: string): Promise<{
    readonly taskId: string;
    readonly reviewerId: string;
    readonly disposition: string;
    readonly evidenceRefs: readonly string[];
    readonly resolvedVersion: number;
  } | undefined>;
  close(): Promise<void>;
}

export function reviewTaskRepositoryContract(
  name: string,
  createHarness: () => Promise<ReviewRepositoryContractHarness>,
): void;
```

Both runners must be usable at the same time. For PostgreSQL, each runner calls `provider.withTenant("tenant-a", ...)` and constructs `PostgresReviewTaskRepository` inside that callback; two concurrent calls therefore hold two independent pool connections/transactions. For SQLite, open two `SqliteRuntime` instances on the same temporary database file.

- [x] **Step 2: Add the complete shared RED suite**

The suite must execute these cases against both providers:

1. `create` then `find` round-trips every aggregate field.
2. Claim with `status=open` and the current version returns `claimed`, sets only the requested assignee, and increments exactly once.
3. Replaying the same claim idempotency key returns the previously applied aggregate without another version increment.
4. Reusing a claim idempotency key for a different task returns `undefined` and leaves that second task open.
5. Resolve succeeds only for `status=claimed`, the current version, and the current assignee; it increments exactly once and preserves disposition/evidence audit data.
6. Replaying the same resolution idempotency key returns the previously applied aggregate without another version increment.
7. Reusing a resolution idempotency key for a different task returns `undefined` and leaves that second task claimed.
8. Stale version, open-task resolve, and non-assignee resolve return `undefined` and do not modify the persisted row.
9. Two same-version claims from `runPrimary` and `runConcurrent`, started by the same `Promise.allSettled`, yield exactly one fulfilled handler result and one `ReviewTaskVersionConflict`; the persisted version is 2 and the assignee is the winner.

Use `ClaimReviewTaskHandler` and `ResolveReviewTaskHandler` for cases that assert public domain errors. Read the final row in a new callback after both concurrent transactions have settled. Do not serialize the race with a test mutex or reuse the same PostgreSQL transaction.

- [x] **Step 3: Prove both current implementations fail the same contract where they diverge**

Run:

```bash
corepack pnpm vitest run tests/contract/review/sqlite-review-task-repository.test.ts tests/contract/review/postgres-review-task-repository.test.ts
```

Expected RED: at minimum, the SQLite implementation treats an idempotency key previously bound to another task as a successful replay. Any PostgreSQL race/audit failure must remain a real failure; do not add retries to the contract.

- [x] **Step 4: Align both adapters without moving domain rules into storage**

For both `claim` and `resolve`, when the idempotency ledger contains the key, compare its stored `task_id` with `command.taskId`; return `undefined` on mismatch. Preserve conditional writes over task ID + allowed status + expected version (+ assignee for resolve). Preserve tenant scoping and same-transaction audit writes. Do not catch unique violations and report success unless the stored ledger row proves it is the same command/task replay.

Move the Review-specific SQLite cases out of `tests/contract/sqlite/investigation-review-store.test.ts` once the shared suite covers them; leave Investigation and Intelligence provider cases in that file.

- [x] **Step 5: Verify and commit provider parity evidence**

Run with Docker available:

```bash
corepack pnpm vitest run tests/contract/review tests/contract/sqlite/investigation-review-store.test.ts tests/component/review/concurrent-claim.test.ts tests/e2e/web-console/review-conflict.test.ts tests/contract/public-api/api-v1.test.ts
corepack pnpm typecheck
git diff --check
```

No PostgreSQL contract test may use `skipIf(!dockerAvailable)`: Docker absence is `DockerUnavailable` and blocks this task. Update the Review row in `docs/production-closure-status.md` with both provider commands, total counts, and the PostgreSQL race evidence.

Commit:

```bash
git add tests/contract/review tests/contract/sqlite/investigation-review-store.test.ts packages/storage-providers/sqlite-runtime/src/sqlite-review-store.ts apps/server/src/postgres-review-task-repository.ts docs/production-closure-status.md
git commit -m "test(review): enforce provider and concurrency contract"
```

---

### Task 6: Verify Web Console ID Token signatures before using claims

**Execution status:** merged as PR #40 with merge commit `0753be7` after both final review axes passed. `jose` 6.2.9 is locked. Real RS256/ES256 signatures, complete callback cleanup, fail-closed token/config validation, exact redirect binding, and cached JWKS rotation pass the focused Gate. The full Windows suite has no failures beyond the six expected explicit skips.

**Files:**
- Modify: `apps/web-console/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web-console/src/auth/id-token-verifier.ts`
- Modify: `apps/web-console/src/auth/oidc-session.ts`
- Modify: `apps/web-console/src/auth/browser-oidc.ts`
- Modify: `apps/web-console/src/config.ts`
- Modify: `tests/helpers/oidc-jwt.ts`
- Modify: `tests/component/web-console/oidc-flow.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Adds browser-compatible `jose` as a direct Web Console dependency.
- Produces `IdTokenVerifier.verify(token, expected): Promise<Record<string, unknown>>`.
- Extends `OidcClientConfig` with `jwksUri` and `allowedAlgorithms: readonly ("RS256" | "ES256")[]`.

- [x] **Step 1: Add failing cryptographic validation tests**

Extend the test IdP/JWT fixture with a JWKS endpoint. Add cases for:

- valid RS256 ID Token succeeds;
- one payload byte changed after signing fails;
- unknown `kid` fails;
- disallowed algorithm fails;
- expired token fails even when token endpoint returns HTTP 200;
- valid signature with wrong issuer/audience/nonce still fails.

Use real signing keys from `tests/helpers/oidc-jwt.ts`; do not mock the verifier in these contract cases.

- [x] **Step 2: Confirm tampered tokens currently pass signature validation**

Run: `corepack pnpm vitest run tests/component/web-console/oidc-flow.test.ts`

Expected before implementation: a token with a valid-looking payload and tampered signature reaches claim mapping.

- [x] **Step 3: Add the browser-compatible verifier**

After the registry precondition is satisfied, install with `corepack pnpm --filter @qualigence/web-console add jose` and review the exact manifest/lock diff before proceeding. Implement:

```ts
export interface IdTokenVerifier {
  verify(
    token: string,
    expected: { readonly issuer: string; readonly audience: string },
  ): Promise<Record<string, unknown>>;
}
```

`RemoteJwksIdTokenVerifier` must construct one cached `createRemoteJWKSet(new URL(jwksUri), { timeoutDuration, cooldownDuration, cacheMaxAge })` and call `jwtVerify` with exact issuer, audience, and the configured `RS256 | ES256` allowlist. Do not accept `none`, symmetric algorithms, token-supplied JWKS URLs, or arbitrary algorithms.

- [x] **Step 4: Replace payload decoding with verified claims**

Inject an `IdTokenVerifier` into `OidcSession` or construct it from config in `BrowserOidcController`. In `completeAuthorization`, await verification before nonce, tenant, role, or subject processing. Convert signature/key/algorithm/JWKS errors to stable `OidcSessionError` reasons `TokenSignatureInvalid` or `JwksUnavailable`; do not expose library error text to the UI.

- [x] **Step 5: Preserve transient and in-memory-token guarantees**

Keep state/nonce/verifier in TTL-bounded session storage and access tokens only in `MemoryTokenStore`. On any verification failure, remove the used transient record so an invalid callback cannot be replayed.

- [x] **Step 6: Verify and commit**

Run:

```bash
corepack pnpm vitest run tests/component/web-console/oidc-flow.test.ts
corepack pnpm --filter @qualigence/web-console typecheck
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add apps/web-console/package.json pnpm-lock.yaml apps/web-console/src/auth/id-token-verifier.ts apps/web-console/src/auth/oidc-session.ts apps/web-console/src/auth/browser-oidc.ts apps/web-console/src/config.ts tests/helpers/oidc-jwt.ts tests/component/web-console/oidc-flow.test.ts docs/production-closure-status.md
git commit -m "fix(console): verify oidc id token signatures"
```

---

### Task 7: Add Runner lease renewal and stop-before-expiry behavior

**Files:**
- Create: `apps/runner/src/lease-renewal-controller.ts`
- Modify: `apps/runner/src/job-executor.ts`
- Modify: `apps/runner/src/runner-client.ts`
- Modify: `apps/runner/src/index.ts`
- Modify: `tests/unit/runner/job-executor.test.ts`
- Create: `tests/unit/runner/lease-renewal-controller.test.ts`
- Modify: `tests/component/core-runner/disconnect-recovery.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Consumes: `RunnerSession.renew(lease): Promise<ExecutionJobLease>` and `LeaseWindow.renew(lease)`.
- Produces: `LeaseRenewalController`, with injected abortable delay for deterministic tests.
- `LeasedJobResult.lease` must be the most recently renewed lease, never the initial stale token.

- [ ] **Step 1: Add deterministic failing renewal tests**

Use a fake session and a manually released delay seam. Assert:

1. first renew is requested after `leaseDurationMs / 3`;
2. successful renew replaces the token returned in `LeasedJobResult` and resets the window;
3. wrong-token/transport/timeout failure permanently closes the window;
4. no new action reaches the wrapped executor after failure;
5. stopping after runtime completion prevents another renew;
6. the Runner calls `complete` with the newest lease.

- [ ] **Step 2: Confirm the current executor never calls renew**

Run: `corepack pnpm vitest run tests/unit/runner/job-executor.test.ts tests/unit/runner/lease-renewal-controller.test.ts`

Expected before implementation: renew call count remains zero.

- [ ] **Step 3: Implement an abortable renewal controller**

Use this public shape:

```ts
export interface RenewalDelay {
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

export class LeaseRenewalController {
  currentLease(): ExecutionJobLease;
  run(signal: AbortSignal): Promise<void>;
  stop(): void;
}
```

The controller owns the current lease, waits `Math.max(1, Math.floor(leaseDurationMs / 3))`, calls `session.renew(current)`, replaces the current lease, and calls `window.renew(newLease)`. On any non-stop error it calls `window.close()` and aborts the execution signal. A normal `stop()` must not be reported as a lease failure.

- [ ] **Step 4: Run renewal concurrently with the runtime**

In `LeasedJobExecutor.execute`, create an internal `AbortController`, combine it with the caller signal for the guarded executor, start the controller before `runtime.run`, and stop/await it in `finally`. Return the controller's latest lease. Ensure rejected capability negotiation occurs before accept and before starting renewal.

- [ ] **Step 5: Make completion use the latest lease**

Keep `RunnerClient.serveNextOffer` and production `runOffer` calling `session.complete(result.lease, result.completion)`. Add assertions that the lease token passed to complete is the last renewed token.

- [ ] **Step 6: Verify and commit**

Run:

```bash
corepack pnpm vitest run tests/unit/runner/lease-window.test.ts tests/unit/runner/lease-renewal-controller.test.ts tests/unit/runner/job-executor.test.ts tests/component/core-runner/disconnect-recovery.test.ts
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add apps/runner/src/lease-renewal-controller.ts apps/runner/src/job-executor.ts apps/runner/src/runner-client.ts apps/runner/src/index.ts tests/unit/runner/job-executor.test.ts tests/unit/runner/lease-renewal-controller.test.ts tests/component/core-runner/disconnect-recovery.test.ts docs/production-closure-status.md
git commit -m "feat(runner): renew execution leases safely"
```

---

### Task PR5-SCOPE: Repair Tasks 8-9 implementation scope

**Execution status:** complete and merged as PR #44 (`bfd6da2`). Static preflight stopped before product edits.

**Files:**
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Adds only the protocol wire/error/type files required to make Task 8's existing wrong-token renew requirement implementable.
- Adds only the direct-import unit tests required to preserve Task 9's moved-service behavior.
- Changes no runtime code, protocol schema, package manifest, lockfile, migration, or product Composition Root.

- [x] **Step 1: Record the blocked implementation preflight**

Document that `RenewLease` lacks the domain lease token required by Task 8, the client lacks stable `LeaseLost` mapping, and four unit tests import services Task 9 moves.

- [x] **Step 2: Amend Tasks 8-9 exact Files and verification**

Add the required protocol contract/proto/client/error/type/smoke files to Task 8 and the four direct-import service tests to Task 9. Preserve existing public interfaces and scope exclusions.

- [x] **Step 3: Verify and commit**

Run `git diff --check`, update `docs/production-closure-status.md` with the date,
exact command result, and commit, then commit both declared Files:

```bash
git add docs/superpowers/plans/2026-08-16-production-closure-temporary.md docs/production-closure-status.md
git commit -m "docs(plan): repair tasks 8 and 9 implementation scope"
```

- [x] **Step 4: Review the committed fixed point**

Run Standards and Spec/architecture `/code-review` against the exact merge-base
and committed head. Critical or Important findings block Tasks 8-9; each fix is
a new commit followed by `git diff --check` and a fresh two-axis review.

---

### Task PR5-ATOMIC: Make Tasks 8-9 one compilable delivery unit

**Execution status:** complete and merged as PR #45 (`aba6a59`). The preflight
proved Task 8 could not compile until Task 9 supplied the production caller.
PR5-R0 keeps this production-composition rule and replaces only the
single-commit packaging.

**Files:**
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Defined the production-composition rule: Tasks 8-9 keep separate RED evidence and no fake production caller. PR5-R0 replaces the original single-commit packaging with stacked inactive PRs plus one activation commit.
- Forbids a compatibility default, insecure fallback, or temporary fake in the production Core composition.
- Changes no runtime code, protocol schema, package manifest, lockfile, migration, or product Composition Root.

- [x] **Step 1: Record the atomicity RED**

Record Task 8's valid transport RED and the root typecheck errors showing that
required `application` and `authenticator` have no production caller until Task
9. Confirm no Task 8 product commit exists.

- [x] **Step 2: Amend global and local delivery rules**

Add the single named exception to Global Constraints and the PR delivery plan.
Update Tasks 8-9 to require one union commit and joint Gate while retaining each
Task's Files and RED behavior.

- [x] **Step 3: Verify and commit**

Run `git diff --check`, update the status ledger with date, commands, and commit,
then commit both declared Files:

```bash
git add docs/superpowers/plans/2026-08-16-production-closure-temporary.md docs/production-closure-status.md
git commit -m "docs(plan): make tasks 8 and 9 one compilable unit"
```

- [x] **Step 4: Review the committed fixed point**

Run both review axes against the exact merge-base and committed head. Critical
or Important findings require a new fix commit, `git diff --check`, and a fresh
two-axis review before Tasks 8-9 resume.

---

### Task PR5-SCOPE-B: Migrate shared recovery identities

**Execution status:** complete and merged as PR #46 (`d562f8d`).

**Files:**
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Adds `tests/component/core-runner/disconnect-recovery.test.ts` to Task 8's identity-contract migration, focused Gate, and PR5-ATOMIC union commit.
- Keeps `AuthenticatedRunnerContext.scope` required; no compatibility fallback or optional field is introduced.
- Changes no runtime code, protocol schema, package manifest, lockfile, migration, or product Composition Root.

- [x] **Step 1: Record the typecheck RED**

Record the two exact type errors where recovery-test identities lack the required
scope after Task 8 introduces `AuthenticatedRunnerContext`.

- [x] **Step 2: Amend Task 8 and the atomic union Gate**

Add the shared recovery file to Task 8 Files, its focused Gate, and the PR5 union
commit command.

- [x] **Step 3: Verify, commit, and review**

Run `git diff --check`, commit both declared Files, and run both review axes
against the exact merge-base/head. Critical or Important findings block PR5.

---

### Task PR5-R0: Authorize stacked Tasks 8-9 delivery

**Execution status:** in_progress. Product Interfaces and Files remain unchanged.

**Files:**
- Create: `docs/superpowers/plans/2026-08-17-pr5-protocol-authority-refactor.md`
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Replaces only the single-commit packaging of Tasks 8-9. The public
  `RunnerProtocolApplication`, `RunnerConnectionPort`, `RunnerClientPort`,
  required `AuthenticatedRunnerContext.scope`, and both Files unions stay
  identical.
- Keeps PR5-ATOMIC's production-composition rule: no compatibility default,
  insecure fallback, or fake may enter a production Composition Root.
- Freezes forensic branch `codex/pr5-core-protocol-application` at `230b6cd`
  as reference only.
- Changes no runtime code, protocol schema, package manifest, lockfile,
  migration, or product Composition Root.

- [x] **Step 1: Record the packaging RED**

Record that the forensic 11-commit branch cannot merge under the current
single-commit rule, and that Issues `#48`-`#51` are architecture-level
admission/ownership/waiter defects rather than local patches.

- [x] **Step 2: Publish the delivery document and amend packaging only**

Add `docs/superpowers/plans/2026-08-17-pr5-protocol-authority-refactor.md`
as the stacked-delivery authority. Update this plan's execution table,
dependency order, PR table, Task 8-9 delivery steps, and Terra protocol
without editing either Files union or public interface block.

- [x] **Step 3: Verify, commit, and review**

Run `git diff --check`, update the status ledger, commit the three
declared Files, and run both review axes against the exact merge-base and
head. Critical or Important findings block PR5-R1. Five review rounds
that still leave an Important finding open the GitHub PR without merge
and post each remaining Important finding as a PR comment.

```bash
git add docs/superpowers/plans/2026-08-17-pr5-protocol-authority-refactor.md docs/superpowers/plans/2026-08-16-production-closure-temporary.md docs/production-closure-status.md
git commit -m "docs(plan): authorize stacked runner protocol delivery"
```

---

### Task 8: Replace gRPC's in-memory lifecycle semantics with an application port

**Atomic delivery constraint:** Task 8 and Task 9 remain one product unit.
Their Interfaces and Files unions are unchanged. PR5-R0 packages them as
stacked inactive PRs plus one activation commit in
`docs/superpowers/plans/2026-08-17-pr5-protocol-authority-refactor.md`.
Task 8 observes its focused RED first. Production Core must not require
`application` and `authenticator` until PR5-R5. No compatibility default,
insecure fallback, or temporary fake may enter a production Composition Root.

**Files:**
- Create: `packages/core-modules/runner-control/package.json`
- Create: `packages/core-modules/runner-control/tsconfig.json`
- Create: `packages/core-modules/runner-control/src/runner-protocol-application.ts`
- Create: `packages/core-modules/runner-control/src/index.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `tsconfig.test.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/package.json`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/tsconfig.json`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/client.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/errors.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/ports.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/proto.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/server.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/index.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/mappers.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/tls-runner-identity.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/wire-codec.ts`
- Modify: `tests/helpers/grpc-harness.ts`
- Modify: `tests/conformance/runner-protocol/grpc-round-trip.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-tls.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-mappers.test.ts`
- Modify: `tests/conformance/runner-protocol/proto-schema.test.ts`
- Modify: `tests/component/core-runner/disconnect-recovery.test.ts`
- Modify: `tests/type/runner-protocol-v1.types.ts`
- Modify: `tests/smoke/node-package-imports.mjs`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Produces a required `RunnerProtocolApplication` dependency for `GrpcRunnerProtocolServer` from the neutral leaf package `@qualigence/runner-control`; the gRPC adapter depends inward on this port.
- Keeps `RunnerConnectionPort` and `RunnerClientPort` public signatures unchanged.
- Removes lease issuance, resume-token authority, Trace cursor authority, and completion authority from the transport adapter.
- Adds the existing domain `ExecutionJobLease.leaseToken` to the v1 `RenewLease` wire message so the application authority can validate the exact token; the adapter must not mint or replace it.
- Surfaces application `LeaseLost` through the client as a stable `RunnerProtocolError`, without string matching or transport fallback.

- [ ] **Step 1: Add a fake application authority to conformance tests**

The fake must record every call and intentionally delay Trace persistence. Add tests proving:

1. no `event_ack` is sent until `application.ingest` resolves;
2. a rejected wrong-token renew is surfaced to the Runner and no new lease is minted;
3. `complete_execution` reaches the application with the exact lease and completion;
4. application-provided Welcome/resume behavior is used rather than an adapter-local token store;
5. frames from one stream are processed in arrival order.

- [ ] **Step 2: Define the application port**

Add the exact interface to `packages/core-modules/runner-control/src/runner-protocol-application.ts`; `ports.ts` imports/re-exports it only for compatibility:

```ts
export interface RunnerProtocolApplication {
  openSession(
    hello: RunnerHello,
    identity: AuthenticatedRunnerContext,
  ): Promise<RunnerWelcome>;
  createOffer(
    sessionId: string,
    job: AcceptedExecutionJob,
    requirements: readonly string[],
  ): Promise<ExecutionJobOffer>;
  accept(sessionId: string, offerId: string): Promise<ExecutionJobLease>;
  renew(sessionId: string, lease: ExecutionJobLease): Promise<ExecutionJobLease>;
  ingest(sessionId: string, batch: ExecutionEventBatch): Promise<ExecutionEventAck>;
  complete(
    sessionId: string,
    lease: ExecutionJobLease,
    completion: ExecutionCompletion,
  ): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}
```

Define a transport-neutral `AuthenticatedRunnerContext` beside the port with `runnerId`, `certificateFingerprint`, and authorization scope `{ kind: "local" } | { kind: "tenant"; tenantId: string; projectIds: readonly string[] }`. Change the adapter-owned identity seam to `RunnerPeerAuthenticator.authenticate(peer, hello): Promise<AuthenticatedRunnerContext>` so the persisted Self-hosted principal lookup can be asynchronous; adapt `CertificateRunnerIdentity` by returning a resolved Promise with `scope: { kind: "local" }`. Task 14 wraps `SelfHostedRunnerAuthenticator`, maps its `RunnerPrincipal` to the tenant scope DTO, and keeps project authorization in application/dispatch code. The neutral package must not import gRPC, Node TLS, Kysely, a storage runtime, or `apps/*`. Make `application` and `authenticator` required in `GrpcRunnerProtocolServerOptions`; do not retain an insecure default.

- [ ] **Step 3: Make session establishment application-owned**

Keep peer-certificate extraction and authentication invocation inside the adapter. Await `authenticator.authenticate(peer, hello)`, then call `await application.openSession(hello, authenticatedContext)` and send only the returned Welcome. Remove protocol negotiation and resume-token issuance from `server.ts`; those already belong to `RunnerSessionService`.

- [ ] **Step 4: Delegate every lifecycle frame**

`ServerRunnerConnection.offer` calls `application.createOffer`, sends that exact offer, and awaits a later accept. Accept, renew, event batch, and complete call the matching application method. Parse completion using the existing `completionFromWire` mapper. Remove `issueLease`, `traceCursors`, and the comment that unknown completion frames are accepted.

- [ ] **Step 5: Serialize asynchronous frame handling**

Maintain a per-connection promise chain so two event batches cannot race persistence:

```ts
private processing: Promise<void> = Promise.resolve();

enqueue(frame: RunnerFrameWire): void {
  this.processing = this.processing
    .then(() => this.handleFrame(frame))
    .catch((error) => this.dispose(error));
}
```

`handleFrame` becomes async. A malformed or rejected frame closes only the offending session with a stable protocol error; it must not crash the gRPC server process.

- [ ] **Step 6: Verify the current stacked PR, then stop if production would activate**

Run the exact focused Gate named for the current stacked PR in
`docs/superpowers/plans/2026-08-17-pr5-protocol-authority-refactor.md`
**Focused Gates**, then `corepack pnpm typecheck` and `git diff --check`.
Do not require `application` or `authenticator` in production `main.ts`
before PR5-R5. Do not widen either Files block.

---

### Task 9: Compose Core session, ownership, jobs, and durable Trace behind gRPC

**Files:**
- Move: `apps/core-daemon/src/runner/runner-session-service.ts` → `packages/core-application/src/runner/runner-session-service.ts`
- Move: `apps/core-daemon/src/runner/runner-resume-token-service.ts` → `packages/core-application/src/runner/runner-resume-token-service.ts`
- Move: `apps/core-daemon/src/runner/run-ownership-service.ts` → `packages/core-application/src/runner/run-ownership-service.ts`
- Move: `apps/core-daemon/src/runner/execution-job-service.ts` → `packages/core-application/src/runner/execution-job-service.ts`
- Create: `packages/core-application/src/runner/core-runner-protocol-application.ts`
- Modify: `packages/core-application/src/index.ts`
- Modify: `packages/core-application/package.json`
- Modify: `packages/core-application/tsconfig.json`
- Modify: `apps/core-daemon/src/main.ts`
- Modify: `apps/core-daemon/src/config.ts`
- Modify: `apps/core-daemon/src/index.ts`
- Modify: `apps/core-daemon/package.json`
- Modify: `apps/core-daemon/tsconfig.json`
- Modify: `pnpm-lock.yaml`
- Modify: `tests/helpers/core-runner-harness.ts`
- Create: `tests/component/core-runner/core-composition.test.ts`
- Modify: `tests/component/core-runner/independent-process.test.ts`
- Modify: `tests/unit/core-daemon/execution-job-service.test.ts`
- Modify: `tests/unit/core-daemon/run-ownership-service.test.ts`
- Modify: `tests/unit/core-daemon/runner-resume-token-service.test.ts`
- Modify: `tests/unit/core-daemon/runner-session-service.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Produces reusable `CoreRunnerProtocolApplication implements RunnerProtocolApplication` plus the four protocol application services from `@qualigence/core-application`.
- Consumes existing `RunnerSessionService`, `ExecutionJobService`, `RunOwnershipService`, `RunnerResumeTokenService`, `TraceIngestor`, `SqliteRuntime`, and `SqliteTraceStore`.
- Keeps `startCoreDaemon(config)` but extends `StartedCoreDaemon` with a test-visible `application` and closes SQLite during shutdown.

- [ ] **Step 1: Add a failing production-composition component test**

Start Core with a temporary data directory and real SQLite, connect a real gRPC client, offer/accept a job, submit one valid Trace batch, renew, and complete. Assert:

- Trace exists in `SqliteTraceStore` before ACK is observed;
- duplicate batch returns the same next sequence;
- same sequence/different hash closes the session;
- wrong-token renew returns `LeaseLost`;
- completion is recorded by `ExecutionJobService`;
- shutdown closes the database and port.

- [ ] **Step 2: Extract one reusable Core protocol application seam**

Move the four transport-independent services listed in **Files** into `@qualigence/core-application`, preserve their public signatures/tests, update the four listed unit tests to import the public `@qualigence/core-application` exports, and export them from the package root. They may depend on contracts, evidence/Trace ports, shared-kernel primitives, and `@qualigence/runner-control`; they must not import Core Daemon, Server, Fastify, gRPC, SQLite, or PostgreSQL concrete classes. Core Daemon retains only process configuration and provider composition. This is the same seam Task 14 must instantiate for Self-hosted mode; Task 14 must not import `apps/core-daemon` or copy these services.

Implement the Core protocol application adapter in that shared package with these delegation rules:

Use the following delegation rules:

```ts
openSession(hello, identity) => sessions.register(hello, identity)
createOffer(sessionId, job, requirements) =>
  jobs.offer({
    owner: { runnerId: session.identity.runnerId, sessionId },
    capabilities: session.capabilities,
    job,
    requiredCapabilities: requirements,
  })
accept(sessionId, offerId) => jobs.accept(offerId)
ingest(sessionId, batch) => sessions.ingest(sessionId, batch)
```

Before renew and complete, read `ownership.ownerOf(lease.runId)` and require both runnerId and sessionId to match the calling session. Then call `jobs.renew` or `jobs.complete`. `closeSession` removes only protocol-session state; it must not silently renew or reassign a run.

`createOffer` is idempotent for `{ jobId, runId }` within a live Core process: an exact canonical Job/requirements replay returns the existing offer, while different content for either identity throws `RunIdentityMismatch` and sends no second frame. Add this case to `core-composition.test.ts`. After a process crash an unaccepted offer may be recreated because no lease/action authority existed; an accepted run is recovered from Task 10's persistent lease instead.

- [ ] **Step 3: Open Core SQLite stores at startup**

Create `config.dataDir`, open `join(config.dataDir, "qualigence.db")` through `SqliteRuntime`, create `SqliteTraceStore` and `TraceIngestor`, and instantiate services exactly once. Inject the resulting `CoreRunnerProtocolApplication` into `GrpcRunnerProtocolServer`.

Do not instantiate `InMemoryTraceStore`, `InMemoryResumeTokenStore`, or adapter-local lease issuance in production.

- [ ] **Step 4: Make readiness reflect real composition**

Emit `core-daemon.ready` only after SQLite migration/open and gRPC bind succeed. On shutdown, stop accepting sessions, close gRPC, then close SQLite. If SQLite fails, do not bind a gRPC port.

- [ ] **Step 5: Activate production composition only in PR5-R5**

PR5-R4 may add `CoreRunnerProtocolApplication` and its in-process tests
while `apps/core-daemon/src/main.ts` keeps the pre-activation constructor.
PR5-R5 is the only commit that injects the required application and
authenticator, opens SQLite/Trace, and emits readiness after both succeed.

Run the joint Gate only on the activation commit:

```bash
corepack pnpm vitest run tests/unit/core-daemon tests/conformance/runner-protocol tests/component/core-runner/core-composition.test.ts tests/component/core-runner/independent-process.test.ts
corepack pnpm smoke:node-imports
corepack pnpm typecheck
git diff --check
```

Commit the union of both Files blocks only in PR5-R5:

```bash
git add package.json tsconfig.json tsconfig.test.json pnpm-lock.yaml packages/core-modules/runner-control packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto packages/protocol-adapters/grpc-runner-protocol packages/core-application apps/core-daemon tests/helpers/grpc-harness.ts tests/helpers/core-runner-harness.ts tests/conformance/runner-protocol tests/type/runner-protocol-v1.types.ts tests/smoke/node-package-imports.mjs tests/component/core-runner/core-composition.test.ts tests/component/core-runner/independent-process.test.ts tests/component/core-runner/disconnect-recovery.test.ts tests/unit/core-daemon/execution-job-service.test.ts tests/unit/core-daemon/run-ownership-service.test.ts tests/unit/core-daemon/runner-resume-token-service.test.ts tests/unit/core-daemon/runner-session-service.test.ts docs/production-closure-status.md
git commit -m "feat(core): delegate and compose authoritative runner protocol"
```

Run Standards and Spec/architecture review against the exact merge-base and
the activation head. Any fix commit reruns the joint Gate and both review
axes. Five review rounds that still leave an Important finding open the
GitHub PR without merge and post each remaining Important finding as a
PR comment.

---

### Task 10: Persist Core Runner sessions, leases, resume tokens, and completions

**Files:**
- Modify: `packages/storage-providers/relational-kysely/src/schema.ts`
- Modify: `packages/storage-providers/relational-kysely/src/catalog.ts`
- Modify: `packages/storage-providers/relational-kysely/src/migrations.ts`
- Create: `packages/storage-providers/relational-kysely/src/migrations/006-runner-control.ts`
- Modify: `packages/core-modules/runner-control/package.json`
- Modify: `packages/core-modules/runner-control/tsconfig.json`
- Create: `packages/core-modules/runner-control/src/runner-control-store.ts`
- Modify: `packages/core-modules/runner-control/src/index.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/core-daemon/package.json`
- Modify: `apps/core-daemon/tsconfig.json`
- Modify: `packages/storage-providers/sqlite-runtime/package.json`
- Modify: `packages/storage-providers/sqlite-runtime/tsconfig.json`
- Create: `packages/storage-providers/sqlite-runtime/src/sqlite-runner-control-store.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/index.ts`
- Modify: `packages/storage-providers/postgres-runtime/package.json`
- Modify: `packages/storage-providers/postgres-runtime/tsconfig.json`
- Create: `packages/storage-providers/postgres-runtime/src/postgres-runner-control-store.ts`
- Modify: `packages/storage-providers/postgres-runtime/src/index.ts`
- Modify: `packages/core-application/src/runner/run-ownership-service.ts`
- Modify: `packages/core-application/src/runner/runner-resume-token-service.ts`
- Modify: `packages/core-application/src/runner/runner-session-service.ts`
- Modify: `packages/core-application/src/runner/execution-job-service.ts`
- Modify: `packages/core-application/package.json`
- Modify: `packages/core-application/tsconfig.json`
- Create: `tests/contract/runner-control/runner-control-store.contract.ts`
- Create: `tests/contract/runner-control/sqlite-runner-control-store.test.ts`
- Create: `tests/contract/runner-control/postgres-runner-control-store.test.ts`
- Modify: `docs/production-closure-status.md`
- Modify: `tests/component/core-runner/disconnect-recovery.test.ts`

**Follow-up scope (2026-08-18 review fixes):**
- Modify source: `packages/core-modules/runner-control/src/runner-control-store.ts`, `packages/core-modules/runner-control/src/index.ts`, `packages/core-application/src/runner/run-ownership-service.ts`, `packages/storage-providers/sqlite-runtime/src/sqlite-runner-control-store.ts`, and `packages/storage-providers/postgres-runtime/src/postgres-runner-control-store.ts`.
- Modify tests: `tests/contract/runner-control/runner-control-store.contract.ts`, `tests/helpers/in-memory-runner-control-store.ts`, and `tests/unit/core-daemon/run-ownership-service.test.ts`.
- Modify evidence docs: this plan and `docs/production-closure-status.md`.
- Verify: `corepack pnpm build`; `corepack pnpm vitest run tests/contract/runner-control tests/unit/core-daemon/run-ownership-service.test.ts`; `corepack pnpm vitest run tests/component/core-runner/core-composition.test.ts tests/component/core-runner/disconnect-recovery.test.ts`; `corepack pnpm typecheck`; and `git diff --check`.

**Interfaces:**
- Produces provider-neutral async `RunnerControlStore` from a new leaf package `@qualigence/runner-control`.
- `@qualigence/runner-control` depends only on `@qualigence/runner-protocol`; Core Daemon and the two storage runtimes depend on it. It must not depend on `@qualigence/core-application`, Kysely, SQLite, PostgreSQL, or any `apps/*` package.
- Makes the persistent store, not an application `Map`, authoritative for token consumption, lease CAS, and completion.
- Changes session/job/ownership service mutations to async; update callers rather than hiding writes with `void`.

- [ ] **Step 1: Freeze migration-006 tables in contract tests**

Add schema/contract assertions for:

```text
runner_sessions(
  session_id PK, runner_id, certificate_fingerprint, capabilities_json,
  protocol_major, created_at, closed_at
)
runner_resume_tokens(
  token_hash PK, runner_id, certificate_fingerprint, previous_session_id,
  protocol_major, expires_at, consumed_at
)
execution_leases(
  run_id PK, job_id, runner_id, session_id, lease_epoch,
  job_json, lease_token_hash, expires_at, lost_at, completed_at,
  recovery_of_run_id
)
execution_completions(
  run_id PK, job_id, completion_json, completed_at
)
```

No raw lease or resume token may appear in any row. Add indexes on active session runnerId and unconsumed token expiry. Migration 006 must be additive and idempotently applied by both SQLite and PostgreSQL runtimes.

- [ ] **Step 2: Define the store port**

`RunnerControlStore` must expose explicit atomic operations rather than generic CRUD:

```ts
export interface PersistedRunnerSession {
  sessionId: string;
  runnerId: string;
  certificateFingerprint: string;
  capabilities: readonly string[];
  protocolMajor: number;
  createdAt: string;
}

export interface PersistedLeaseOwner {
  runnerId: string;
  sessionId: string;
}

export interface HashedResumeTokenRecord {
  tokenHash: string;
  binding: ResumeTokenBinding;
  expiresAt: string;
}

export interface PersistedExecutionLease {
  job: AcceptedExecutionJob;
  owner: PersistedLeaseOwner;
  leaseEpoch: number;
  leaseTokenHash: string;
  expiresAt: string;
  lostAt?: string;
  completedAt?: string;
  recoveryOfRunId?: string;
}

export interface RunnerControlStore {
  saveSession(record: PersistedRunnerSession): Promise<void>;
  closeSession(sessionId: string, closedAt: string): Promise<void>;
  issueResumeToken(record: HashedResumeTokenRecord): Promise<void>;
  consumeResumeToken(input: {
    tokenHash: string;
    presented: ResumePresentedIdentity;
    consumedAt: string;
  }): Promise<ResumeTokenBinding | undefined>;
  grantLease(input: PersistedExecutionLease): Promise<"granted" | "already_exists">;
  renewLease(input: {
    runId: string;
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    newExpiresAt: string;
  }): Promise<boolean>;
  completeLease(input: {
    runId: string;
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    completion: ExecutionCompletion;
  }): Promise<"completed" | "duplicate" | "rejected">;
  markLeaseLost(runId: string, lostAt: string): Promise<boolean>;
  lease(runId: string): Promise<PersistedExecutionLease | undefined>;
  completion(runId: string): Promise<ExecutionCompletion | undefined>;
}
```

Define every record/input type in `packages/core-modules/runner-control`, using only Runner Protocol contract primitives and ISO timestamps; the storage port must not import an application service, storage provider, or `apps/*` type. Add the leaf package to the root project references and add explicit workspace dependencies/project references to Core Daemon, SQLite runtime, and PostgreSQL runtime. This avoids the existing `core-application -> postgres-runtime` dependency becoming a cycle. Application services map their live session records to these persistence DTOs. Raw tokens exist only at application-service boundaries and are hashed before calling the store. Renew/complete SQL must compare token hash, runnerId, sessionId, epoch, not-lost/not-completed status, and expiry in one transaction. `duplicate` is legal only when the stored completion is byte-for-byte canonical-equivalent; a different second completion is `rejected` and raises an integrity event.

Offers remain live-session messages rather than durable authority. If Core crashes after committing a lease but before returning the accept response, the Runner cannot invent the undisclosed raw token: recovery marks that run lost and creates a new runId. Never persist a raw lease token merely to make accept replayable across a process crash.

- [ ] **Step 3: Write SQLite and PostgreSQL contract tests first**

Export one `runnerControlStoreContract(name, createHarness)` from `tests/contract/runner-control/runner-control-store.contract.ts` and run it unchanged against both providers. The harness must support two concurrent independent connections/transactions. Assert wrong token/session/runner/epoch cannot renew or complete, resume consumption is one-time under two concurrent callers, restart preserves active ownership/Trace upload authority, expired lease is marked lost, and recovery creates a new runId without transferring the old run.

- [ ] **Step 4: Refactor services to use the async store**

Inject `RunnerControlStore` into the four services now located in `packages/core-application/src/runner`. In-memory maps may cache immutable capabilities and pending offers for a live connection, but every security decision must read/conditionally update the store. Convert `register`, `offer`, `accept`, `renew`, and `complete` to Promise-returning methods and update `CoreRunnerProtocolApplication`.

- [ ] **Step 5: Verify restart recovery**

In the component test, start Core, establish a lease, submit Trace, shut Core down, restart with the same database, reconnect with the rotating resume token, upload already-spooled Trace, and assert no new action is authorized under the old lease unless a valid unexpired stored lease permits it. A lost run is never offered to another runnerId.

- [ ] **Step 6: Verify and commit**

Run:

```bash
corepack pnpm vitest run tests/conformance/storage/relational-schema.test.ts tests/contract/runner-control tests/unit/core-daemon tests/component/core-runner/disconnect-recovery.test.ts
corepack pnpm typecheck
git diff --check
```

If Docker/PostgreSQL is unavailable, stop this task after the SQLite tests and report `DockerUnavailable`; do not commit a provider contract that has never run against PostgreSQL.

Commit:

```bash
git add packages/storage-providers/relational-kysely packages/core-modules/runner-control packages/core-application packages/storage-providers/sqlite-runtime packages/storage-providers/postgres-runtime apps/core-daemon/package.json apps/core-daemon/tsconfig.json tests/contract/runner-control tests/component/core-runner/disconnect-recovery.test.ts pnpm-lock.yaml docs/production-closure-status.md
git commit -m "feat(core): persist runner ownership state"
```

---

### Task 11: Add authenticated Local run intake and make Launcher prove Runner registration

**Execution precondition and authority:** Task 10 and final Task 15 are merged on current `main` at `923cfa7`. This Task 11 section is the sole implementation authority. The separate dossier is explanatory and non-blocking; it is not staged with this plan or implementation. Review this plan once, implement the complete Task 11 scope, run the Gate and commit, then perform one final implementation review. Do not use rolling reviews of Task 12-14 and do not let their findings block Task 11.

**Exact boundary:** Task 11 owns Local HTTP/session, `LocalRunPolicyIssuer`, durable atomic Local intake/dispatch, configured Runner capability readiness, authoritative completion sink with startup reconciliation, and Launcher lifecycle. It excludes automatic lease-loss recovery claims or child Runs, Self-hosted provenance/composition, and every Task 12-14 source/test change. Migrations 001-006 are immutable. Task 11 exclusively allocates migration 007 to `local-run-intake`; the unchanged Task 12/13 sections still reserve 007/008 and must resolve that conflict when those later tasks execute. Do not renumber or edit those sections in Task 11.

**Files:**
- Create: `apps/core-daemon/src/local/local-session-service.ts`
- Create: `apps/core-daemon/src/local/local-http-server.ts`
- Create: `apps/core-daemon/src/local/local-run-coordinator.ts`
- Create: `apps/core-daemon/src/local/local-run-policy-issuer.ts`
- Create: `apps/core-daemon/src/local/local-readiness-service.ts`
- Create: `apps/core-daemon/src/local/bootstrap-credential-handoff.ts`
- Modify: `packages/core-application/src/runner/core-runner-protocol-application.ts`
- Modify: `packages/core-application/src/runner/run-ownership-service.ts`
- Modify: `packages/core-application/src/runner/execution-job-service.ts`
- Modify: `packages/core-application/src/index.ts`
- Modify: `packages/core-modules/evidence/src/persistence-ports.ts`
- Modify: `packages/core-modules/evidence/src/trace-ingestor.ts`
- Modify: `packages/core-modules/evidence/src/index.ts`
- Modify: `packages/core-modules/runner-control/src/runner-control-store.ts`
- Modify: `packages/core-modules/runner-control/src/index.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/ports.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/server.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/index.ts`
- Modify: `packages/storage-providers/relational-kysely/src/schema.ts`
- Modify: `packages/storage-providers/relational-kysely/src/catalog.ts`
- Modify: `packages/storage-providers/relational-kysely/src/migrations.ts`
- Create: `packages/storage-providers/relational-kysely/src/migrations/007-local-run-intake.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/database.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/sqlite-local-run-intake-store.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/sqlite-local-readiness-probe.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/index.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/sqlite-runner-control-store.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/sqlite-trace-store.ts`
- Modify: `packages/storage-providers/postgres-runtime/src/postgres-runner-control-store.ts`
- Modify: `packages/storage-providers/artifact-fs/src/local-artifact-store.ts`
- Modify: `tests/helpers/in-memory-runner-control-store.ts`
- Modify: `apps/core-daemon/src/main.ts`
- Modify: `apps/core-daemon/src/config.ts`
- Modify: `apps/core-daemon/src/index.ts`
- Modify: `apps/core-daemon/package.json`
- Modify: `apps/core-daemon/tsconfig.json`
- Create: `apps/local-launcher/src/bootstrap-credential-handoff.ts`
- Modify: `apps/local-launcher/src/main.ts`
- Modify: `apps/local-launcher/src/child-process-unit.ts`
- Modify: `apps/local-launcher/src/process-supervisor.ts`
- Modify: `apps/local-launcher/src/health-client.ts`
- Modify: `apps/local-launcher/src/runtime-state.ts`
- Modify: `apps/local-launcher/src/config.ts`
- Modify: `apps/local-launcher/src/errors.ts`
- Modify: `apps/local-launcher/src/index.ts`
- Modify: `packages/contracts/local-control/src/config.ts`
- Modify: `packages/contracts/local-control/src/health.ts`
- Create: `packages/contracts/local-control/src/bootstrap-credentials.ts`
- Create: `packages/contracts/local-control/src/local-session.ts`
- Create: `packages/contracts/local-control/src/quiesce.ts`
- Modify: `packages/contracts/local-control/src/index.ts`
- Modify: `deployments/local/config.example.yaml`
- Modify: `pnpm-lock.yaml`
- Create: `tests/unit/core-daemon/bootstrap-credential-handoff.test.ts`
- Create: `tests/unit/core-daemon/local-session-service.test.ts`
- Create: `tests/unit/core-daemon/local-http-server.test.ts`
- Modify: `tests/e2e/local-launcher.test.ts`
- Modify: `tests/component/core-runner/independent-process.test.ts`
- Create: `tests/unit/core-daemon/local-run-policy-issuer.test.ts`
- Create: `tests/unit/core-daemon/local-run-coordinator.test.ts`
- Create: `tests/unit/core-daemon/local-readiness-service.test.ts`
- Modify: `tests/unit/core-daemon/config.test.ts`
- Modify: `tests/unit/core-daemon/execution-job-service.test.ts`
- Modify: `tests/unit/core-daemon/run-ownership-service.test.ts`
- Modify: `tests/unit/core-daemon/runner-backed-run-resource-factory.test.ts`
- Modify: `tests/unit/local-launcher/config.test.ts`
- Create: `tests/unit/local-launcher/bootstrap-credential-handoff.test.ts`
- Create: `tests/unit/local-launcher/health-client.test.ts`
- Create: `tests/unit/local-launcher/quiesce.test.ts`
- Modify: `tests/unit/local-launcher/process-supervisor.test.ts`
- Modify: `tests/component/core-runner/core-composition.test.ts`
- Modify: `tests/component/core-runner/disconnect-recovery.test.ts`
- Modify: `tests/component/local-launcher/start-stop.test.ts`
- Create: `tests/contract/runner-control/local-run-intake-store.contract.ts`
- Create: `tests/contract/runner-control/sqlite-local-run-intake-store.test.ts`
- Create: `tests/contract/sqlite/local-readiness-probe.test.ts`
- Modify: `tests/contract/sqlite/sqlite-runtime.test.ts`
- Modify: `tests/contract/sqlite/sqlite-trace-store.test.ts`
- Modify: `tests/contract/artifact-fs/local-artifact-store.test.ts`
- Modify: `tests/contract/postgres/postgres-runtime.test.ts`
- Modify: `tests/contract/runner-control/runner-control-store.contract.ts`
- Modify: `tests/contract/runner-control/sqlite-runner-control-store.test.ts`
- Modify: `tests/contract/runner-control/postgres-runner-control-store.test.ts`
- Modify: `tests/contract/runner-control/in-memory-runner-control-store.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-tls.test.ts`
- Modify: `tests/conformance/storage/relational-schema.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Produces loopback-only `POST /api/v1/local/session`, `POST /api/v1/local/runs`, `GET /api/v1/local/runs/:runId`, `POST /api/v1/local/quiesce`, `GET /health/live`, `GET /health/internal-ready`, and `GET /health/ready`. HTTP and gRPC use separately configured ports and bind exactly `127.0.0.1`; Local config rejects `localhost`, wildcard/IPv6 hosts, forwarded-host trust, CORS, cookies, query credentials, unknown request fields, and any HTTP policy/project/config input.
- `POST /api/v1/local/runs` accepts exactly `{ targetUrl, objective }` and returns exactly `202 { runId, status: "pending_runner" }` after the atomic commit, never after Runner acceptance. Authenticated `GET` exposes only public status `pending_runner | offer_outcome_unknown | running | passed | finding | blocked | error`, in this precedence order: completion `applied` returns the persisted terminal Run status; completion `integrity_blocked` returns `error` with safe `CompletionIdentityMismatch` or `CompletionConflict`; otherwise internal dispatch `pending_runner | dispatching` returns `pending_runner`, `offer_outcome_unknown` returns unchanged, and `offered` + `awaiting` returns `running`. No internal state string other than the intentionally public `pending_runner`/`offer_outcome_unknown` can appear. It may return safe optional public `errorCode` and ordered safe evidence references, but never internal attempts, expected attempt/version, `nextAttemptAt`, CAS outcome, claim timestamps, target URL, objective, Job/policy JSON, hashes, paths, media metadata, or credential data. Extend existing `TraceStore` only with `findingReferences(runId)`; use existing `ArtifactManifestStore.listForRun` and project both to ID/kind/created-at references.
- Credential Bearer text is exactly unpadded base64url of the corresponding 32 raw bytes: URL-safe alphabet only, no `=`, and exactly 43 ASCII characters. Launcher prints the user-bootstrap encoding once after final ready; raw bytes remain the fd-3 frame representation. `POST /api/v1/local/session` requires exactly `Authorization: Bearer <bootstrap>`, no body bytes, no query, and no `Content-Type`; it returns exactly status `201` with `{ sessionToken, expiresAt }`, where `sessionToken` is the unpadded base64url encoding of a fresh 32-byte user session. Core decodes to exactly 32 bytes, stores SHA-256 hashes and metadata only in memory, compares fixed-size digests in constant time, and atomically permits one bootstrap exchange. Missing/malformed/wrong/expired/consumed credential and wrong credential kind return the same safe `401`; body/query/content-type return safe `400`; wrong method returns `405`. User credentials authorize run POST/GET only; the supervisor credential authorizes quiesce only. A Core restart invalidates both user sessions and supervisor authority, so only a fresh Launcher start may establish a new controllable topology.
- Launcher generates exactly two independent 32-byte credentials in memory before Core spawn. `packages/contracts/local-control/src/bootstrap-credentials.ts` owns the only fd-3 contract: one fixed 100-byte binary `QLGBOOT1` v1 frame, never JSON/base64. Offsets `0..7` are exact ASCII `QLGBOOT1`; `8..9` are unsigned u16be version `1`; `10..11` are u16be header length `20`; `12..15` are u32be total length `100`; `16..19` are u32be body length `80`; `20..51` are raw user-bootstrap bytes; `52..83` are raw supervisor bytes; `84..91` are signed int64be `createdAtEpochMs`; and `92..99` are signed int64be `userExpiresAtEpochMs`. Epochs must be nonnegative safe integers, exactly representable, and satisfy `createdAtEpochMs < userExpiresAtEpochMs`. The only accepted header/body/total sizes are `20/80/100`; no credential length/tag/string or supervisor expiry is encoded.
- Shared parser safe codes are exactly `BootstrapFrameMagicMismatch`, `BootstrapFrameVersionUnsupported`, `BootstrapFrameHeaderLengthInvalid`, `BootstrapFrameTotalLengthInvalid`, `BootstrapFrameBodyLengthInvalid`, and `BootstrapFrameTimestampInvalid`. Parse failure zeroes the supplied mutable 100-byte frame before throwing; success returns credential views into that frame plus epoch values and mandatory `destroy()` that zeroes the whole backing buffer. The Core collector reads the 20-byte header first, rejects declared lengths before body allocation/read, reads exactly 80 body bytes, and requires EOF under the same bounded deadline. Collector-only safe codes are exactly `BootstrapFrameMissing`, `BootstrapFrameTruncated`, `BootstrapFrameTrailingBytes`, `BootstrapFrameTimedOut`, and `BootstrapFrameIoFailed`; parser codes pass through. `ChildProcessUnit` writes exactly one frame to inherited fd 3 and closes/destroys the parent writer. Core reads fd 3 once before SQLite/listeners, hashes both credential views, closes/destroys fd 3, and zeroes every header/frame/chunk/credential copy in `finally` on success and failure. Errors contain no bytes or timestamps.
- Local auth config has exact positive-safe-integer defaults/maxima: `auth.bootstrapTtlMs` default `600_000`, maximum `86_400_000`; `auth.userSessionTtlMs` default `900_000`, maximum `86_400_000`. Launcher reads its injected clock exactly once at credential creation and derives `userExpiresAtEpochMs = createdAtEpochMs + bootstrapTtlMs` with checked safe-integer addition; those exact epochs enter the frame. Core uses the frame expiry without recomputing it. A successful bootstrap exchange reads the injected Core clock exactly once and returns `expiresAt` exactly `sessionCreatedAt + userSessionTtlMs` as canonical ISO-8601. Overflow, nonpositive/fractional/unsafe/over-maximum TTL, expired frame, or noncanonical timestamp fails before listener readiness. External bootstrap/session/supervisor Bearers remain exactly 43-character unpadded base64url of their 32 raw bytes. No secret enters file, environment, argv, log, state, YAML, or database; only non-secret `CORE_BOOTSTRAP_CREDENTIAL_FD=3` is configured.
- Produces `LocalRunPolicyIssuer.issue({ kind: "web", url })`, the only Local issuance root. Validated Local/exact-loopback construction, injected clock, positive TTL, and issuer version produce exact `projectId: "local"` plus a frozen `isolated_test` snapshot with canonical origin, `['click']`, `Normal`, no exploration, one issued-at clock read, checked expiry, and deterministic lowercase SHA-256 `policyId`. It never emits staging/production or accepts policy/project from HTTP.
- `@qualigence/runner-control` owns provider-neutral `LocalRunIntakeStore` and all Local dispatch/completion marker DTOs beside the existing `RunnerControlStore`; do not place them in Evidence or create a new package/ADR-level ownership seam. The leaf continues to depend only on Runner Protocol: `create({ job, createdAt })` derives the initial Run fields from `AcceptedExecutionJob` and does not import Evidence, Core application, Kysely, SQLite, PostgreSQL, or `apps/*`. Migration 007 adds `local_run_intakes` with Run PK/FK, unique Job, immutable canonical Job JSON/hash, exact dispatch states `pending_runner | dispatching | offer_outcome_unknown | offered`, dispatch attempt/error/timestamps, and completion state `awaiting | applied | integrity_blocked` with attempt/error/timestamps. The SQLite implementation atomically inserts the initial `execution_runs` row and intake marker in one immediate transaction before any network call. The stored Job is the retry authority and is never returned or logged.
- `LocalRunIntakeStore` exposes only bounded authority operations: `create`, `pendingDispatches(limit)`, `beginOffer`, `markOffered`, `markOfferOutcomeUnknown`, `quarantineInterruptedDispatches`, `run`, `pendingCompletions({ now, limit })`, `recordCompletionFailure({ runId, expectedAttempt, errorCode, failedAt })`, `applyCompletion({ runId, expectedAttempt, jobId, jobSha256, completion, completedAt })`, and `markIntegrityBlocked({ runId, expectedAttempt, errorCode, blockedAt })`. Selectors validate canonical database-comparable `now` and positive safe bounded limit, return only `offered | offer_outcome_unknown` + `awaiting` rows with `completion_next_attempt_at <= now`, and use stable `completion_next_attempt_at, updated_at, run_id` order. Dispatch transitions retain their expected-state/attempt CAS. Evidence remains responsible only for Trace/Finding/Artifact reference reads used by GET/readiness. No method accepts caller-computed delay/`nextAttemptAt`, creates recovery intent, claims a lost lease, or creates a child Run.
- `SqliteLocalRunIntakeStore` follows the existing adapter-constructor pattern: construct it with the open `SqliteRuntime` and one immutable validated `{ retryBaseMs, retryMaximumMs, maximumAttempts }` policy. Core config and the adapter constructor both reject zero, negative, fractional, unsafe, or over-maximum values and require `retryBaseMs <= retryMaximumMs`; the port DTO contains no retry-policy fields. Exact config paths/defaults/hard maxima are `completionReconciliationRetryBaseMs` `1_000`/`60_000`, `completionReconciliationRetryMaximumMs` `60_000`/`300_000`, and `completionReconciliationMaximumAttempts` `8`/`64`. The unchanged poll/batch settings are `completionReconciliationPollIntervalMs` `250`/`60_000` and `completionReconciliationBatchSize` `64`/`256`; require `completionReconciliationPollIntervalMs <= completionReconciliationRetryBaseMs <= completionReconciliationRetryMaximumMs`. Launcher passes these non-secret values to Core and Core validates before store/loop construction.
- Migration 007 completion columns are exact: `completion_state` constrained to `awaiting | applied | integrity_blocked | retry_exhausted`; `completion_attempt` nonnegative integer default `0`; nullable `completion_last_attempt_at`; nonnull `completion_next_attempt_at` initialized to `created_at`; nullable `completion_error_code`; nullable lowercase-hex `completion_sha256`; nullable `completion_applied_at`; and nullable `completion_blocked_at`. `recordCompletionFailure` accepts only safe `CompletionPending | CompletionAuthorityUnavailable | CompletionApplyFailed`; in one immediate transaction it CASes exact `awaiting` + `expectedAttempt`, computes `attempt = expectedAttempt + 1`, and uses the caller's one canonical `failedAt` only as the time origin. For `attempt < maximumAttempts`, delay is exactly `min(retryMaximumMs, retryBaseMs * 2 ** (attempt - 1))`, computed with cap-before-multiply checked safe-integer arithmetic; `nextAttemptAt` is exactly `failedAt + delay` as canonical ISO. It atomically stores attempt/last-attempt/error/next-attempt and returns `{ status: "scheduled", attempt, nextAttemptAt }`. If `attempt >= maximumAttempts`, it atomically stores the final attempt/error, changes state to `retry_exhausted`, sets `completion_blocked_at = failedAt`, leaves the Run nonterminal, and returns `{ status: "blocked" }`. Missing row, non-`awaiting` applied row, or expected-attempt mismatch returns `{ status: "stale" }` without mutation; an already `integrity_blocked | retry_exhausted` row returns `{ status: "blocked" }` without mutation. Exact replay of a previously scheduled input is therefore `stale` and cannot increment twice; two concurrent callers produce one `scheduled | blocked` winner and one `stale` loser.
- `applyCompletion` CASes exact `awaiting` + `expectedAttempt` and revalidates stored jobId/canonical Job SHA-256, completion jobId/runId, and canonical completion hash. It atomically writes existing Run terminal status/completedAt/errorCode, stores `completion_sha256`, and changes marker to `applied`. Its result is exactly `applied | duplicate | stale | identity_mismatch | completion_conflict`: `duplicate` requires already-`applied`, identical job/hash, canonical completion hash, terminal status/completedAt/errorCode, and makes no write; an altered replay is never duplicate. Coordinator maps either mismatch result to `markIntegrityBlocked`, which CASes exact `awaiting` + expected attempt to `integrity_blocked`, stores only `CompletionIdentityMismatch | CompletionConflict`, sets `completion_blocked_at`, and leaves the Run nonterminal. Exact replay against the blocked row returns blocked/no mutation. Store/provider contracts prove constructor-policy validation, every exponential/cap/overflow boundary, maximum-attempt exhaustion, returned disposition as sole due-time authority, concurrent/stale/replay CAS, crash-due retry, safe-error persistence, exact duplicate, mismatch block, close/reopen, schema constraints, and no internal state in public projection.
- One serialized `LocalRunCoordinator` dispatcher uses those operations. No configured authenticated connection/capability, or any failure proven to occur before `connection.offer` starts, leaves durable `pending_runner` retryable. Immediately before invoking `offer`, `beginOffer` CASes `dispatching`; a returned Lease CASes `offered`. Any throw after invocation begins CASes `offer_outcome_unknown`. On startup, bounded `quarantineInterruptedDispatches` moves every surviving `dispatching` record to `offer_outcome_unknown`, because the new process cannot prove whether the prior process began the write. Neither unknown state is automatically re-offered, converted into a recovery child, or reported terminal. Dispatch always requires exact `target:web-playwright` and never runs model/Playwright in Core or uses `RunnerBackedRunResourceFactory`.
- Extend existing `RunnerConnectionPort` minimally with `authenticatedRunner: { runnerId, scope, capabilities: readonly string[] }`. `GrpcRunnerProtocolServer.connection(configuredRunnerId)` remains the connection registry; no second registry, dispatch port, or readiness Job is added. The snapshot is captured from the authenticated session/advertised capability tokens, not caller configuration. Local dispatch/readiness require `scope.kind === "local"`, the configured runnerId, and `target:web-playwright`.
- Export application-level `RunCompletionSink.complete({ identity, jobId, runId, completion })`. Change `RunOwnershipService`/`ExecutionJobService` completion to return authoritative `completed | duplicate`; `CoreRunnerProtocolApplication` invokes the sink only after that Task 10 decision and with the canonical stored completion. Lease loss, conflict, or completion-store failure never invokes it. Local sink accepts only Local identity and a matching marked intake.
- Add only the smallest restart read to `RunnerControlStore`: `completionRecord(runId): Promise<RunnerCompletionRecord | undefined>`, returning exactly runId, jobId, lowercase canonical `jobSha256` derived from the immutable stored lease Job, canonical stored completion, and committed completedAt. The read fails closed if lease/completion identity is inconsistent. Keep existing `completion()` for callers. SQLite, PostgreSQL, and the in-memory helper plus shared/provider contracts are all in scope; no completion-table schema change is required. This is Task 10 authority observation only and adds no Self-hosted composition/provenance behavior.
- Every created intake begins with durable completion state `awaiting`, so no sink failure can erase retry intent. The Local sink and loop use the same serialized pass: point-read authoritative `completionRecord(runId)`, validate identity/hash, and call `applyCompletion` against the selected `expectedAttempt`; any transient read/apply error calls `recordCompletionFailure` with that same expected attempt and one injected `failedAt`. The reconciler never calculates, persists, compares, or sleeps to a caller-derived due time: it branches only on the store result. `scheduled` uses the returned `attempt`/`nextAttemptAt` for observability and waits no longer than the normal poll before re-querying due rows; `stale` reloads on a later pass; `blocked` stops retrying that row and makes readiness unhealthy. `LocalRunCoordinator` owns one retained reconciliation promise under Core lifecycle: one bounded startup pass before ready, then repeated bounded live passes. Empty/successful pass waits poll interval; a pass with transient failures records each store-owned schedule and continues other rows; no pass overlaps dispatch/reconciliation mutation. An authoritative completion eventually terminalizes `offered` or resolves `offer_outcome_unknown` without re-offer; no completion leaves unknown quarantined. Job/hash/completion mismatch calls `markIntegrityBlocked` and never retries or terminalizes. Core shutdown/quiesce aborts delay, prevents a new pass, and awaits the retained promise before SQLite close; no fire-and-forget retry survives shutdown.
- `LocalReadinessService` is the single readiness decision module. Internal ready requires schema exactly 7, SQLite and Run/Trace/manifest rollback write probes, real Artifact-store byte write/read/hash/delete, healthy startup completion reconciliation, and both HTTP/gRPC bound. Final ready additionally requires the configured authenticated Local Runner snapshot with `target:web-playwright`. Live checks only process/event-loop liveness. Quiesce atomically consumes the supervisor credential, rejects new session/run intake, stops dispatcher claims, makes final readiness false, and allows bounded in-flight completion/reconciliation drain; replay returns safe `401`.
- Preserve `SqliteRuntime` migration behavior for existing callers by adding `openMode?: "migrate" | "require-current"`; omitted remains current migrate behavior. Launcher uses existing `BackupManager` and `MigrationGuard`: first-use DB creation migrates directly to 007; an existing older DB gets a verified backup before migration, then a `require-current` reopen; current skips migration; malformed/newer fails before credentials or process spawn. Local Core always opens `require-current` and never migrates. Migrations 001-006 remain byte-for-byte unchanged.
- Extend the existing `ProcessSupervisor`; do not create/export a second launcher-supervisor class, module, or lifecycle interface. `main.ts` constructs one `ProcessSupervisor` over the existing Core/Runner `ChildProcessUnit`s for both modes. `start --foreground` preserves the current foreground contract: the Launcher process retains the supervisor and credentials, handles SIGINT/SIGTERM, quiesces, stops Runner then Core, clears runtime state, and exits only after cleanup. Detached mode may spawn a child process only through a private adapter implemented in `process-supervisor.ts`: after final ready it forwards the supervisor credential exactly once over inherited Node IPC with non-secret Core/Runner PID topology, waits for acknowledgement, publishes runtime state, prints the bootstrap once, detaches child units, and exits. The private child runs the same `ProcessSupervisor` stop/quiesce ordering by PID; no new public `ProcessUnit`, supervisor type, package export, or parallel lifecycle path is introduced. Live `ChildProcess`/`ChildProcessUnit` objects are not transferred across processes. `DataDirLock` exists only as the current optional interface and has no production implementation, so Task 11 adds no lock module, acquisition, handoff, reservation, or native helper. Single-instance checking remains the existing runtime-state/port startup flow.
- Detached stop uses only existing runtime-state/data-dir file and `ProcessSupervisor` seams; add no lock module or lock method. The canonical marker filename is exactly `local-stop-request.json` and strict schema is exactly `{ version: "local-stop-request/v1", supervisorPid, corePid, runnerPid, startedAt, requestedAt }`. Unknown/missing fields, unsafe/nonpositive PIDs, noncanonical timestamps, or any other value are invalid. The marker carries no authority, credential, port, endpoint, reason, command, or user data. `commandStop` snapshots one valid live runtime tuple, writes an exclusive unique same-directory temporary file, writes/flushes/closes it, then atomically renames it to the canonical filename; concurrent exact-tuple requests are idempotent and wait for the same outcome. A preexisting malformed/mismatched marker is first atomically renamed to a caller-owned stale name, validated/deleted, and only then replaced; no caller deletes another tuple's marker. It never signals as wakeup or opens another IPC channel.
- The detached private supervisor polls for its entire lifetime and atomically claims the canonical marker by renaming it to `local-stop-request.<supervisorPid>.claim` before reading. It validates the marker tuple byte-for-byte against both immutable in-memory topology and current runtime state, and freshness exactly as `requestedAt <= now && now - requestedAt <= stopRequestMaximumAgeMs`. Malformed, stale, future, mismatched, replayed, or wrong-start claims are deleted without quiesce. One valid claim causes exactly one authenticated quiesce with the in-memory supervisor credential; duplicate matching claims during stop are atomically claimed/deleted as no-op replays. In `finally`, supervisor removes canonical/owned claim remnants only after Runner/Core reaping, clears runtime state last, and deletes no marker for a different tuple.
- Shutdown config exact paths/defaults/maxima are: `shutdown.stopRequestPollIntervalMs` `250`/`5_000`; `shutdown.stopRequestMaximumAgeMs` `30_000`/`300_000`; `shutdown.stopRequestWaitTimeoutMs` `60_000`/`600_000`; and `shutdown.drainTimeoutMs` `30_000`/`300_000`. All are positive safe integers and must satisfy `poll <= maximumAge <= waitTimeout` and `waitTimeout >= drainTimeout + 2 * SHUTDOWN_GRACE_MS + 2 * REAP_TIMEOUT_MS`, using existing exact `SHUTDOWN_GRACE_MS = 5_000` and `REAP_TIMEOUT_MS = 3_000` with checked arithmetic. `commandStop` polls until matching runtime-state removal and all three PIDs are reaped, or bounded wait expires; another exact stop winner is success, tuple change returns `StopTopologyChanged`, absent/dead supervisor returns `SupervisorUnavailable`, malformed marker returns `StopRequestInvalid`, and timeout returns `StopTimedOut`, all with safe messages and runtime state preserved for diagnosis. Quiesce drains at most `drainTimeoutMs`; success or deadline/503/transport failure then uses existing `terminateProcess` for bounded Runner-before-Core SIGTERM/grace/escalation/reap. No indefinite wait, surviving PID, new process killer, signal wakeup, named pipe, native IPC, file credential, or foreground regression is allowed.

- [ ] **Step 1: Add focused RED tests at the existing seams**

Add issuer/session/HTTP/coordinator/readiness/bootstrap tests first. Prove strict schemas/auth kinds; exact 43-character unpadded base64url; checked bootstrap/session expiry derivations and TTL bounds; exact `201 { sessionToken, expiresAt }`; body/query/content-type rejection; every fixed-frame offset/endian/parser/collector error and success/failure zeroization; deterministic isolated-only issuance; atomic Run+marker rollback; one dispatcher claim; known pre-offer retry; post-start uncertainty quarantine; no automatic lease recovery; exact public GET projection with no internal state/CAS leakage; completion attempt/failure due-time persistence, safe errors, stale/concurrent CAS, exact duplicate, identity/hash/conflict block, serialized startup/live retry and eventual terminalization, close/reopen, abort/await shutdown; and exact Runner identity/capability readiness. Extend all Runner-control adapters/helper/contracts for `completionRecord` in the same RED change. Extend existing `ProcessSupervisor`/runtime-state/config tests for unchanged foreground handling plus exact stop marker schema, atomic create/claim/replay cleanup, tuple/freshness checks, every timing bound/relationship, detached acknowledgement/quiesce, reverse-order bounded force/reap, timeout, and cleanup; do not create a parallel supervisor test surface.

- [ ] **Step 2: Implement migration 007 and migration ownership**

Create only `007-local-run-intake.ts`; define the intake port/types in `@qualigence/runner-control`, then update schema/catalog/version conformance and its SQLite implementation. Evidence changes remain limited to Finding/Trace/Artifact references and readiness probes. Add `SqliteRuntime` `migrate`/`require-current` open modes without changing default callers. Preserve Launcher `BackupManager`/`MigrationGuard` and prove existing schema-6 backup-before-upgrade, first-use direct creation, Core refusal to migrate, and failure-before-spawn. Do not edit migrations 001-006 or Task 12-14.

- [ ] **Step 3: Implement Local credentials, HTTP, and policy intake**

Implement the exact 100-byte shared binary frame and parser/collector errors, thin Launcher/Core fd-3 handoff modules, checked TTL expiry derivations, exact unpadded base64url Bearers, then hash-only bootstrap/session/quiesce authorization. Bind strict Fastify Local routes to exact `127.0.0.1`; session has no body/query/content-type and returns only exact status/body. Validate `{ targetUrl, objective }` before issuer invocation, create IDs/project/policy deterministically, atomically persist Run+marker, and immediately return durable `202 pending_runner`; request handling never waits for Runner acceptance. GET applies only the explicit public projection and never serializes an intake-store DTO directly.

- [ ] **Step 4: Implement serialized dispatch and authoritative completion**

Run one abortable dispatcher over the runner-control-owned intake store. Retry only states/failures known not to have started `offer`; quarantine all post-start uncertainty. Extend the existing connection object with its authenticated capability snapshot rather than adding a registry. Return Task 10 completion disposition, invoke `RunCompletionSink` only after authority commits, then use exact `recordCompletionFailure`/`applyCompletion`/`markIntegrityBlocked` transitions in the configured serialized startup/live reconciliation loop. Abort and await both loops before storage shutdown. Do not call or extend automatic lease recovery APIs.

- [ ] **Step 5: Implement truthful readiness and Launcher supervision**

Compose SQLite/Run/Trace/manifest and Artifact-byte probes, listener flags, live reconciliation health, and configured Runner identity/capability into one readiness service. Both modes use the existing `ProcessSupervisor`: migration preflight; generate two credentials; start Core with one fd-3 frame; wait internal ready; start Runner; wait final ready. Foreground retains the supervisor and existing signal lifetime. Detached mode starts only the supervisor's private child adapter, sends the supervisor credential once over inherited Node IPC, waits acknowledgement, atomically writes runtime state, prints the unpadded bootstrap once, zeroes retained buffers, detaches, and exits. Detached stop uses exact atomic `local-stop-request.json` creation/claim, tuple/freshness validation, bounded wait/drain, authenticated quiesce, existing Runner-before-Core termination/escalation/reap, marker cleanup, and runtime-state removal last. Add no public lifecycle interface, second supervisor module, `DataDirLock` implementation, or handoff.

- [ ] **Step 6: Run the real built-process Gate and commit once**

The E2E must run built Launcher, Core, Runner, local OpenAI-compatible mock, Web fixture, and real Chromium; do not use `fake-process.mjs`. It exchanges the once-printed bootstrap, submits through HTTP, observes `pending_runner` through terminal Run plus persisted Trace/Finding references, verifies configured Runner capability readiness, stops through the detached supervisor, proves Runner-before-Core/no surviving PIDs, and scans config/state/logs/database rows for forbidden credential bytes. The SQLite intake/Runner-control contracts separately close/reopen the same database to prove startup completion reconciliation. If Chromium is unavailable, fail explicitly with `ChromiumUnavailable`.

Run:

```bash
corepack pnpm build
corepack pnpm vitest run tests/unit/core-daemon/bootstrap-credential-handoff.test.ts tests/unit/core-daemon/local-session-service.test.ts tests/unit/core-daemon/local-http-server.test.ts tests/unit/core-daemon/local-run-policy-issuer.test.ts tests/unit/core-daemon/local-run-coordinator.test.ts tests/unit/core-daemon/local-readiness-service.test.ts tests/unit/core-daemon/config.test.ts tests/unit/core-daemon/execution-job-service.test.ts tests/unit/core-daemon/run-ownership-service.test.ts tests/unit/core-daemon/runner-backed-run-resource-factory.test.ts
corepack pnpm vitest run tests/contract/runner-control/local-run-intake-store.contract.ts tests/contract/runner-control/sqlite-local-run-intake-store.test.ts tests/contract/sqlite/local-readiness-probe.test.ts tests/contract/sqlite/sqlite-runtime.test.ts tests/contract/sqlite/sqlite-trace-store.test.ts tests/contract/artifact-fs/local-artifact-store.test.ts tests/conformance/storage/relational-schema.test.ts tests/contract/postgres/postgres-runtime.test.ts tests/contract/runner-control/runner-control-store.contract.ts tests/contract/runner-control/sqlite-runner-control-store.test.ts tests/contract/runner-control/postgres-runner-control-store.test.ts tests/contract/runner-control/in-memory-runner-control-store.test.ts
corepack pnpm vitest run tests/conformance/runner-protocol/grpc-tls.test.ts tests/component/core-runner/core-composition.test.ts tests/component/core-runner/disconnect-recovery.test.ts tests/component/core-runner/independent-process.test.ts tests/unit/local-launcher/config.test.ts tests/unit/local-launcher/bootstrap-credential-handoff.test.ts tests/unit/local-launcher/process-supervisor.test.ts tests/unit/local-launcher/health-client.test.ts tests/unit/local-launcher/quiesce.test.ts tests/component/local-launcher/start-stop.test.ts tests/e2e/local-launcher.test.ts
corepack pnpm typecheck
git diff --check
```

The PostgreSQL Runner-control contract is mandatory because Task 11 changes `RunnerControlStore`; report `DockerUnavailable` only when Docker actually blocks it. Run one final Standards and Spec/architecture review against the exact merge-base after the complete implementation commit. Any Critical or Important finding requires a fix commit, affected Gate rerun, and fresh final review; Task 12-14 review remains later-task work.

**Exact staging parity:** Stage exactly every path in **Files** and no other path. The explicit command below is intentionally identical to that inventory; if implementation requires another path, stop for architectural review before editing or staging it.

Commit:

```bash
git add apps/core-daemon/src/local/local-session-service.ts apps/core-daemon/src/local/local-http-server.ts apps/core-daemon/src/local/local-run-coordinator.ts apps/core-daemon/src/local/local-run-policy-issuer.ts apps/core-daemon/src/local/local-readiness-service.ts apps/core-daemon/src/local/bootstrap-credential-handoff.ts apps/core-daemon/src/main.ts apps/core-daemon/src/config.ts apps/core-daemon/src/index.ts apps/core-daemon/package.json apps/core-daemon/tsconfig.json packages/core-application/src/runner/core-runner-protocol-application.ts packages/core-application/src/runner/run-ownership-service.ts packages/core-application/src/runner/execution-job-service.ts packages/core-application/src/index.ts packages/core-modules/evidence/src/persistence-ports.ts packages/core-modules/evidence/src/trace-ingestor.ts packages/core-modules/evidence/src/index.ts packages/core-modules/runner-control/src/runner-control-store.ts packages/core-modules/runner-control/src/index.ts packages/protocol-adapters/grpc-runner-protocol/src/ports.ts packages/protocol-adapters/grpc-runner-protocol/src/server.ts packages/protocol-adapters/grpc-runner-protocol/src/index.ts packages/storage-providers/relational-kysely/src/schema.ts packages/storage-providers/relational-kysely/src/catalog.ts packages/storage-providers/relational-kysely/src/migrations.ts packages/storage-providers/relational-kysely/src/migrations/007-local-run-intake.ts packages/storage-providers/sqlite-runtime/src/database.ts packages/storage-providers/sqlite-runtime/src/sqlite-local-run-intake-store.ts packages/storage-providers/sqlite-runtime/src/sqlite-local-readiness-probe.ts packages/storage-providers/sqlite-runtime/src/index.ts packages/storage-providers/sqlite-runtime/src/sqlite-runner-control-store.ts packages/storage-providers/sqlite-runtime/src/sqlite-trace-store.ts packages/storage-providers/postgres-runtime/src/postgres-runner-control-store.ts packages/storage-providers/artifact-fs/src/local-artifact-store.ts apps/local-launcher/src/bootstrap-credential-handoff.ts apps/local-launcher/src/main.ts apps/local-launcher/src/child-process-unit.ts apps/local-launcher/src/process-supervisor.ts apps/local-launcher/src/health-client.ts apps/local-launcher/src/runtime-state.ts apps/local-launcher/src/config.ts apps/local-launcher/src/errors.ts apps/local-launcher/src/index.ts packages/contracts/local-control/src/config.ts packages/contracts/local-control/src/health.ts packages/contracts/local-control/src/bootstrap-credentials.ts packages/contracts/local-control/src/local-session.ts packages/contracts/local-control/src/quiesce.ts packages/contracts/local-control/src/index.ts deployments/local/config.example.yaml pnpm-lock.yaml tests/helpers/in-memory-runner-control-store.ts tests/unit/core-daemon/bootstrap-credential-handoff.test.ts tests/unit/core-daemon/local-session-service.test.ts tests/unit/core-daemon/local-http-server.test.ts tests/unit/core-daemon/local-run-policy-issuer.test.ts tests/unit/core-daemon/local-run-coordinator.test.ts tests/unit/core-daemon/local-readiness-service.test.ts tests/unit/core-daemon/config.test.ts tests/unit/core-daemon/execution-job-service.test.ts tests/unit/core-daemon/run-ownership-service.test.ts tests/unit/core-daemon/runner-backed-run-resource-factory.test.ts tests/unit/local-launcher/config.test.ts tests/unit/local-launcher/bootstrap-credential-handoff.test.ts tests/unit/local-launcher/process-supervisor.test.ts tests/unit/local-launcher/health-client.test.ts tests/unit/local-launcher/quiesce.test.ts tests/component/core-runner/core-composition.test.ts tests/component/core-runner/disconnect-recovery.test.ts tests/component/core-runner/independent-process.test.ts tests/component/local-launcher/start-stop.test.ts tests/contract/runner-control/local-run-intake-store.contract.ts tests/contract/runner-control/sqlite-local-run-intake-store.test.ts tests/contract/sqlite/local-readiness-probe.test.ts tests/contract/sqlite/sqlite-runtime.test.ts tests/contract/sqlite/sqlite-trace-store.test.ts tests/contract/artifact-fs/local-artifact-store.test.ts tests/contract/postgres/postgres-runtime.test.ts tests/contract/runner-control/runner-control-store.contract.ts tests/contract/runner-control/sqlite-runner-control-store.test.ts tests/contract/runner-control/postgres-runner-control-store.test.ts tests/contract/runner-control/in-memory-runner-control-store.test.ts tests/conformance/storage/relational-schema.test.ts tests/conformance/runner-protocol/grpc-tls.test.ts tests/e2e/local-launcher.test.ts docs/production-closure-status.md
git commit -m "feat(local): close launcher core runner loop"
```

---

### Task 12: Add missing Self-hosted Mission, Run, Trace, and Skill API resources

**Execution precondition:** Tasks 9, 10, 11, and 15 are complete. In particular, every scheduled `AcceptedExecutionJob` must already carry Task 15's required immutable policy; do not temporarily dispatch through an allow-all Gate.

**Files:**
- Create: `apps/server/src/routes/missions.ts`
- Create: `apps/server/src/routes/runs.ts`
- Create: `apps/server/src/routes/skills.ts`
- Create: `apps/server/src/postgres-prd-mission-repository.ts`
- Create: `apps/server/src/postgres-skill-query.ts`
- Create: `apps/server/src/mission-dispatch-service.ts`
- Create: `apps/server/src/mission-dispatch-loop.ts`
- Modify: `apps/server/src/server-context.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/package.json`
- Modify: `apps/server/tsconfig.json`
- Modify: `packages/contracts/public-api/src/index.ts`
- Modify: `packages/contracts/public-api/src/v1.ts`
- Modify: `packages/core-modules/mission/src/application/prd-mission-repository.ts`
- Modify: `packages/core-modules/mission/src/public.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/sqlite-prd-mission-store.ts`
- Modify: `packages/storage-providers/relational-kysely/src/schema.ts`
- Modify: `packages/storage-providers/relational-kysely/src/catalog.ts`
- Modify: `packages/storage-providers/relational-kysely/src/migrations.ts`
- Create: `packages/storage-providers/relational-kysely/src/migrations/007-mission-dispatch-outbox.ts`
- Modify: `apps/web-console/src/api/client.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `tests/contract/public-api/api-v1.test.ts`
- Create: `tests/contract/mission/prd-mission-repository.contract.ts`
- Modify: `tests/contract/sqlite/prd-mission-store.test.ts`
- Create: `tests/contract/postgres/prd-mission-store.test.ts`
- Modify: `tests/component/web-console/workflow.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Produces the application routes `GET/POST /v1/missions`, `POST /v1/missions/:missionId/start`, `GET /v1/runs/:runId`, `GET /v1/runs/:runId/trace`, `GET /v1/skills/:skillId/versions`, promote, and deprecate. The Self-hosted reverse proxy may expose these under `/api`, but direct Server and Console contracts remain `/v1` to match the existing `PublicApiClient`.
- Consumes `PrdMissionRepository`, Mission domain types, Skill repository/query data, expected-version/idempotency headers, and a transport-neutral `RunnerDispatchPort`.
- Produces `RunnerDispatchPort` as the seam Task 14 will bind to the real Self-hosted Runner registry; API tests use an explicit fake.

```ts
export interface RunnerDispatchPort {
  dispatch(input: {
    tenantId: string;
    projectId: string;
    job: AcceptedExecutionJob;
    requiredCapabilities: readonly string[];
  }): Promise<{
    readonly status: "accepted" | "already_active";
    readonly jobId: string;
    readonly runId: string;
    readonly acceptedAt: string;
  }>;
}
```

- [ ] **Step 1: Add failing API contract cases for every route**

For each endpoint assert schema, role, tenant isolation, not-found behavior, and idempotency/expected-version behavior. At minimum:

- viewer may read Mission/Run/Trace/Skill;
- tester may create/start Mission and promote/deprecate a valid Skill;
- viewer cannot mutate;
- tenant A IDs are 404 to tenant B;
- duplicate start/promote/deprecate does not create another attempt/version;
- start rejects Mission not in approved state;
- promotion rejects invalid/revoked signature or failed evaluation.

- [ ] **Step 2: Extend and contract-test atomic Mission scheduling**

Extend `PrdMissionRepository` with provider-neutral atomic operations `scheduleMission(input)`, `pendingDispatches(limit)`, and `markDispatchAccepted(attemptId, receipt, expectedVersion)`. `scheduleMission` accepts mission ID/revision, expected Mission status/version, idempotency key, and pre-generated attempt/run IDs; in one transaction it changes approved → running and inserts one dispatch-outbox row per pending Job. The same key returns the same records, while a different command at a stale version returns a conflict. No external network call occurs inside the database transaction.

Migration 007 adds `mission_dispatch_outbox(tenant_id, attempt_id primary key, mission_id, job_id, run_id, idempotency_key, job_json, required_capabilities_json, status, version, accepted_at, created_at)` plus tenant/status ordering and unique tenant/idempotency/job indexes. It never stores a raw lease token. Export one repository contract and run it unchanged against `SqlitePrdMissionStore` and the new PostgreSQL adapter. Cover immutable snapshots/source refs, atomic schedule, replay, stale version, partial failure rollback, bounded pending order, and accepted CAS. Do not modify migrations 001-006.

Port the remaining behavior of `SqlitePrdMissionStore` to the request's tenant-scoped Kysely transaction. Preserve immutable snapshots, source refs, required capabilities, job attempts, and Mission/job status. Do not deserialize a Domain class directly into a public DTO.

- [ ] **Step 3: Implement Mission dispatch as an application service**

`MissionDispatchService.start(tenantId, missionId, expectedVersion, idempotencyKey)` validates the approved dispatchable Mission, deterministically constructs the immutable Job/policy snapshot, generates one attempt/run ID per pending job, and calls only `repository.scheduleMission`. Return HTTP 202 with the scheduled Run IDs. If no compatible Runner is connected, the durable dispatch remains pending; the Mission is never reported completed and a repeated start returns the same Run IDs.

`MissionDispatchLoop` polls bounded pending rows with abortable delay and injected clock, calls `RunnerDispatchPort.dispatch`, then records the token-free receipt using expected-version CAS. Task 14's production port first queries authoritative Runner control state by `runId`: an exact active job returns `already_active`, while a different job for that run is an integrity error; only a missing run is offered to a compatible connection. Therefore a crash after Runner accept but before outbox CAS does not mint a second lease or repeat the action. A capability-unavailable error leaves the row pending with bounded backoff; a permanent policy/shape error marks it blocked through the Mission application rule. Start/stop this loop with Server readiness. Do not import the gRPC adapter into routes or domain code.

- [ ] **Step 4: Implement Skill query and mutation paths without SQL state shortcuts**

Read versions/evaluations/bundles/revocations into a query DTO. Promotion must run `SkillPromotionPolicy` and expected-version CAS before changing state. Deprecation must use the domain transition rules and append revocation/audit information where required. Do not update `skill_versions.state` based only on a request body.

- [ ] **Step 5: Register routes and update Console workflow**

Add dependencies to `ServerDeps`, register the three route modules, define the request/response DTOs and route constants in `packages/contracts/public-api/src/v1.ts`, export them from `index.ts`, and add matching typed methods to `apps/web-console/src/api/client.ts`. Extend the component workflow to exercise Project → PRD → Mission → Run → Skill/Investigation → Review through those client methods. Do not hard-code a second `/api/v1` prefix in either Server or Console.

- [ ] **Step 6: Verify and commit**

Run:

```bash
corepack pnpm vitest run tests/contract/mission tests/contract/sqlite/prd-mission-store.test.ts tests/contract/postgres/prd-mission-store.test.ts tests/contract/public-api/api-v1.test.ts tests/component/web-console/workflow.test.ts tests/unit/core-modules/mission tests/unit/core-modules/skill
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add apps/server/src apps/server/package.json apps/server/tsconfig.json packages/contracts/public-api/src packages/core-modules/mission/src packages/storage-providers/sqlite-runtime/src/sqlite-prd-mission-store.ts packages/storage-providers/relational-kysely apps/web-console/src/api/client.ts pnpm-lock.yaml tests/contract/mission tests/contract/sqlite/prd-mission-store.test.ts tests/contract/postgres/prd-mission-store.test.ts tests/contract/public-api/api-v1.test.ts tests/component/web-console/workflow.test.ts docs/production-closure-status.md
git commit -m "feat(server): expose mission run and skill resources"
```

---

### Task 13: Run the Server Intelligence Result Inbox consumer in production

**Files:**
- Create: `apps/server/src/intelligence-result-consumer-loop.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/package.json`
- Modify: `apps/server/tsconfig.json`
- Modify: `packages/core-application/src/intelligence/server-result-consumer.ts`
- Create: `packages/core-modules/intelligence/src/pending-tenant-source.ts`
- Modify: `packages/core-modules/intelligence/src/index.ts`
- Modify: `packages/storage-providers/relational-kysely/src/schema.ts`
- Modify: `packages/storage-providers/relational-kysely/src/catalog.ts`
- Modify: `packages/storage-providers/relational-kysely/src/migrations.ts`
- Create: `packages/storage-providers/relational-kysely/src/migrations/008-intelligence-result-wakeups.ts`
- Create: `packages/storage-providers/postgres-runtime/src/postgres-intelligence-wakeup-store.ts`
- Modify: `packages/storage-providers/postgres-runtime/src/migrations/row-level-security.ts`
- Modify: `packages/storage-providers/postgres-runtime/src/index.ts`
- Modify: `packages/storage-providers/postgres-runtime/package.json`
- Modify: `packages/storage-providers/postgres-runtime/tsconfig.json`
- Modify: `pnpm-lock.yaml`
- Modify: `tests/component/intelligence-worker/result-inbox.test.ts`
- Create: `tests/component/intelligence-worker/server-consumer-loop.test.ts`
- Create: `tests/contract/postgres/intelligence-result-wakeup-store.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Consumes existing `ServerIntelligenceResultConsumer.consumeForTenant(tenantId)`.
- Produces an abortable polling loop with bounded batch/tenant enumeration and injected clock/delay.
- Produces a provider-neutral `PendingIntelligenceTenantSource` in `@qualigence/intelligence` and a PostgreSQL implementation that exposes only opaque tenant wakeups, never a generic unscoped database handle.
- Keeps Worker unable to write aggregate tables.

- [ ] **Step 1: Add failing process-level consumer tests**

Append a valid Result through the Worker role, start Server, and assert the aggregate version changes exactly once and the applied ledger is recorded. Add duplicate, stale base version, policy rejection, Server restart, and graceful shutdown cases.

- [ ] **Step 2: Add a least-privilege, race-safe tenant wakeup outbox**

Migration 008 adds only (Migration 007 is the Mission dispatch outbox from Task 12):

```text
intelligence_result_wakeups(
  tenant_id primary key,
  generation bigint not null,
  available_at timestamp not null
)
```

In PostgreSQL bootstrap/RLS setup, create a database trigger on `intelligence_results` that upserts the row and increments `generation` in the same transaction as Result insertion. The Worker role receives no direct `SELECT`, `UPDATE`, or `DELETE` grant on this table. The Server role receives only the grants required by the focused wakeup adapter. The table contains no Job, Result, model, project, aggregate, or payload data.

Define in `packages/core-modules/intelligence/src/pending-tenant-source.ts`:

```ts
export interface PendingIntelligenceTenant {
  readonly tenantId: string;
  readonly generation: bigint;
}

export interface PendingIntelligenceTenantSource {
  list(limit: number): Promise<readonly PendingIntelligenceTenant[]>;
  acknowledge(wakeup: PendingIntelligenceTenant): Promise<boolean>;
  close(): Promise<void>;
}
```

`PostgresIntelligenceWakeupStore` owns a dedicated restricted pool/factory and exposes only these methods. `acknowledge` deletes with both `tenant_id` and `generation`; a Result inserted during consumption increments the generation, makes the stale delete affect zero rows, and leaves the tenant scheduled for the next pass. Do not add `listTenantsWithPendingResults` to `TenantTransactionProvider` and do not expose its unscoped Kysely handle.

- [ ] **Step 3: Make consumption bounded and observable**

The loop accepts `{ consumer, pendingTenants, idleBackoffMs, maximumTenantsPerPass, maximumResultsPerTenant, clock, onError }`. Extend `consumeForTenant` with the explicit result limit. For each wakeup, consume inside the existing RLS-scoped application path and acknowledge the exact generation only after successful completion. One failure for a tenant is logged with correlation/job IDs and does not expose payloads or stop other tenants. Do not busy-spin.

- [ ] **Step 4: Test the wakeup race and production lifecycle**

The PostgreSQL contract must prove: Result insert creates/increments one wakeup; list is bounded; no payload column is exposed; stale-generation acknowledge cannot delete a newer wakeup; current-generation acknowledge deletes it; a Server restart processes the surviving wakeup exactly once. Run this against two independent connections with a Result committed between consume and acknowledge.

Create an AbortController in `main.ts`, start the consumer after database/OIDC initialization and before readiness becomes healthy, abort it during shutdown, await loop completion, close the wakeup store, then close Fastify/provider. Avoid `void consumer.consume...` fire-and-forget calls.

- [ ] **Step 5: Keep transaction/application semantics intact**

The loop may select tenants with pending results, but only `ServerIntelligenceResultConsumer` may call `IntelligenceResultApplier`. Worker code and role grants remain unchanged. Add metrics for applied/duplicate/recompute/rejected counts without tenant IDs as labels.

- [ ] **Step 6: Verify and commit**

Run:

```bash
corepack pnpm vitest run tests/contract/postgres/intelligence-result-wakeup-store.test.ts tests/component/intelligence-worker/result-inbox.test.ts tests/component/intelligence-worker/server-consumer-loop.test.ts tests/unit/core-modules/intelligence/result-applier.test.ts
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add apps/server/src/intelligence-result-consumer-loop.ts apps/server/src/main.ts apps/server/src/config.ts apps/server/package.json apps/server/tsconfig.json packages/core-application/src/intelligence/server-result-consumer.ts packages/core-modules/intelligence/src packages/storage-providers/relational-kysely packages/storage-providers/postgres-runtime pnpm-lock.yaml tests/component/intelligence-worker tests/contract/postgres/intelligence-result-wakeup-store.test.ts docs/production-closure-status.md
git commit -m "feat(server): consume intelligence results deterministically"
```

---

### Task 14: Expose the Self-hosted Runner gRPC data plane and full Compose loop

**Files:**
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/package.json`
- Modify: `apps/server/tsconfig.json`
- Create: `apps/server/src/self-hosted-runner-protocol.ts`
- Create: `apps/server/src/routes/health.ts`
- Modify: `pnpm-lock.yaml`
- Create: `packages/storage-providers/postgres-runtime/src/postgres-trace-store.ts`
- Create: `packages/storage-providers/postgres-runtime/src/postgres-run-store.ts`
- Modify: `packages/storage-providers/postgres-runtime/src/index.ts`
- Modify: `deployments/self-hosted/compose/compose.yaml`
- Modify: `docs/production-closure-status.md`
- Modify: `deployments/self-hosted/compose/Caddyfile`
- Modify: `deployments/self-hosted/compose/.env.example`
- Create: `deployments/self-hosted/compose/secrets/README.md`
- Modify: `deployments/self-hosted/compose/README.md`
- Modify: `tests/e2e/self-hosted/compose.test.ts`
- Create: `tests/e2e/self-hosted/external-runner.test.ts`
- Create: `tests/contract/postgres/postgres-trace-store.test.ts`
- Create: `tests/contract/postgres/postgres-run-store.test.ts`
- Create: `tests/component/server/server-readiness.test.ts`

**Interfaces:**
- Produces an enrollment-bound mTLS `GrpcRunnerProtocolServer` using `SelfHostedRunnerAuthenticator`, the shared `@qualigence/core-application` protocol services from Task 9, and PostgreSQL `RunnerControlStore`.
- Runner gRPC is reachable through a dedicated configured TCP port; it is never authenticated with a human OIDC token.
- Public HTTPS remains the only browser entrypoint.

- [ ] **Step 1: Add a failing Compose topology and external Runner test**

Assert rendered Compose contains a Server gRPC listener and required certificate secrets. Start the stack, enroll a Runner, issue its certificate, connect a real external Runner, start a Mission through Public API, and wait for terminal Run/Trace/Finding. Revoke the Runner and assert reconnect fails before any Job payload.

- [ ] **Step 2: Implement the missing PostgreSQL Run and Trace stores**

Implement `PostgresRunStore implements RunStore` from `packages/core-modules/evidence/src/persistence-ports.ts` and `PostgresTraceStore implements TraceStore` from `packages/core-modules/evidence/src/trace-ingestor.ts`. Reuse the relational schema and transaction provider; do not copy SQLite-specific SQL. Port the SQLite behavioral contract: run status transitions use expected-version CAS, Trace append is ordered/idempotent, duplicate event IDs do not advance the cursor, and an ACK is returned only after the transaction commits. Run both new suites against a real PostgreSQL container.

- [ ] **Step 3: Compose the Self-hosted Runner application**

Reuse Tasks 8-10: `GrpcRunnerProtocolServer` + `CoreRunnerProtocolApplication` and its services imported from `@qualigence/core-application` + `PostgresRunnerControlStore` + `PostgresTraceStore` + `PostgresRunStore`. Add explicit Server package dependencies/project references for `@qualigence/core-application`, `@qualigence/grpc-runner-protocol`, and `@qualigence/runner-control`. Inject `SelfHostedRunnerAuthenticator`; implement Task 12's `RunnerDispatchPort` with the authenticated connection registry and authorize tenant/project before serializing an Offer. Before offering, look up the authoritative lease by run ID: return a token-free `already_active` receipt only when the canonical stored Job equals the request; reject a different Job as `RunIdentityMismatch`. On a new accept, strip the raw lease token before returning the receipt. `apps/server` must not import `apps/core-daemon`, and it must not copy session/ownership/lease logic.

- [ ] **Step 4: Configure network exposure safely**

Publish the Runner gRPC port only when explicitly configured, with mTLS mandatory. PostgreSQL/MinIO remain unexposed. Document firewall requirements and certificate enrollment. Do not route gRPC through the browser OIDC path or Caddy HTTP API handlers unless Caddy is explicitly configured for HTTP/2 gRPC pass-through with client certificate preservation and tests prove peer identity reaches Server.

- [ ] **Step 5: Add missing operational material**

Create `secrets/README.md` with commands for generating every required secret file, restrictive permission expectations, rotation notes, and a statement that example values are non-production. Add Server `/health/live` and `/health/ready`: live proves the event loop accepts requests; ready is 200 only after PostgreSQL, OIDC config, Result consumer loop, and Runner gRPC listener are ready, and becomes 503 during shutdown or a failed required dependency. Task 21 owns container-level Worker/Console/proxy healthchecks and must reuse this Server endpoint rather than add a second Server health implementation.

- [ ] **Step 6: Verify and commit**

Run:

```bash
docker compose --env-file deployments/self-hosted/compose/.env.example -f deployments/self-hosted/compose/compose.yaml config --quiet
corepack pnpm vitest run tests/contract/postgres/postgres-trace-store.test.ts tests/contract/postgres/postgres-run-store.test.ts tests/component/server/server-readiness.test.ts tests/e2e/self-hosted/compose.test.ts tests/e2e/self-hosted/external-runner.test.ts
corepack pnpm typecheck
git diff --check
```

If Docker daemon is unavailable, stop and report `DockerUnavailable`; a static `compose config` result alone is not sufficient for this task.

Commit:

```bash
git add apps/server packages/storage-providers/postgres-runtime pnpm-lock.yaml tests/contract/postgres/postgres-trace-store.test.ts tests/contract/postgres/postgres-run-store.test.ts tests/component/server/server-readiness.test.ts deployments/self-hosted/compose tests/e2e/self-hosted docs/production-closure-status.md
git commit -m "feat(self-hosted): connect external runner data plane"
```

---

### Task 15: Replace allow-all execution policy with a deterministic Job policy snapshot

**Execution precondition:** Task 9 is complete. Execute this Task before Tasks 12 and 14 even though its number is higher, so no production Mission dispatch path is ever composed with an allow-all policy.

**Critical project-provenance follow-up authority (2026-08-18):** A post-review
audit at `5120c1f` found that the completed policy snapshot work preserved
`projectId` only through Mission persistence, then dropped it at
`DispatchableMission -> RunExecutionRequest -> AcceptedExecutionJob`. This
additive remediation does not revise the historical Task 15 Files block or
claim that its prior implementation changed the paths below. It closes the
blocking immutable project-provenance transport contract required before Task
11 Local authorization and Tasks 12/14 Self-hosted dispatch authorization can
be implemented.

**Follow-up Files (additive authority only):**
- Modify: `packages/contracts/runner-protocol/src/index.ts`
- Modify: `packages/core-modules/runner-control/src/runner-control-store.ts`
- Modify: `packages/core-modules/runner-control/src/index.ts`
- Modify: `packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/mappers.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/sqlite-runner-control-store.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/sqlite-prd-mission-store.ts`
- Modify: `packages/core-application/src/runner/run-ownership-service.ts`
- Modify: `apps/core-daemon/src/runner/runner-backed-run-resource-factory.ts`
- Modify: `packages/core-modules/mission/src/domain/test-mission.ts`
- Modify: `packages/core-modules/mission/src/domain/test-plan-revision.ts`
- Modify: `packages/core-modules/mission/src/application/mission-compiler.ts`
- Modify: `packages/execution-application/src/contracts.ts`
- Modify: `packages/execution-application/src/run-execution-use-case.ts`
- Modify: `packages/execution-application/src/mission-execution-use-case.ts`
- Modify: `apps/cli/src/config.ts`
- Modify: `apps/core-daemon/src/legacy-m1-local-recovery.ts`
- Modify: `apps/core-daemon/src/main.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/index.ts`
- Modify: `tests/type/runner-protocol-v1.types.ts`
- Modify: `tests/type/run-execution-use-case.types.ts`
- Modify: `tests/conformance/runner-protocol/accepted-execution-job-plan.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-mappers.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-round-trip.test.ts`
- Modify: `tests/conformance/runner-protocol/proto-schema.test.ts`
- Modify: `tests/contract/runner-control/runner-control-store.contract.ts`
- Modify: `tests/contract/runner-control/sqlite-runner-control-store.test.ts`
- Modify: `tests/contract/runner-control/postgres-runner-control-store.test.ts`
- Modify: `tests/contract/sqlite/prd-mission-store.test.ts`
- Modify: `tests/helpers/core-runner-harness.ts`
- Modify: `tests/unit/cli/config.test.ts`
- Modify: `tests/unit/core-daemon/execution-job-service.test.ts`
- Modify: `tests/unit/core-daemon/run-ownership-service.test.ts`
- Modify: `tests/unit/core-daemon/runner-backed-run-resource-factory.test.ts`
- Modify: `tests/unit/core-daemon/runner-session-service.test.ts`
- Modify: `tests/unit/core-daemon/legacy-m1-local-recovery.test.ts`
- Modify: `tests/unit/core-modules/mission/mission-compiler.test.ts`
- Modify: `tests/unit/execution-application/artifact-recording-observer.test.ts`
- Modify: `tests/unit/execution-application/mission-execution-use-case.test.ts`
- Modify: `tests/unit/runner-components/model-agent.test.ts`
- Modify: `tests/unit/runner-kernel/deterministic-policy-gate.test.ts`
- Modify: `tests/unit/runner-kernel/execution-runtime.test.ts`
- Modify: `tests/unit/runner/job-executor.test.ts`
- Modify: `tests/unit/runner/offer-runtime.test.ts`
- Modify: `tests/component/core-runner/core-composition.test.ts`
- Modify: `tests/component/core-runner/disconnect-recovery.test.ts`
- Modify: `tests/component/investigation/offline-capsule-restoration.test.ts`
- Modify: `tests/component/m1-web-walking-skeleton.test.ts`
- Modify: `tests/component/web-execution/local-run-composition-root.test.ts`
- Modify: `tests/component/web-execution/playwright-click.test.ts`
- Modify: `tests/component/web-execution/playwright-observation.test.ts`
- Modify: `tests/component/web-execution/playwright-web-target.test.ts`
- Modify: `tests/component/web-execution/run-execution-use-case.test.ts`
- Modify: `docs/production-closure-status.md`
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`

**Follow-up Interfaces and invariants:**
- `AcceptedExecutionJob.projectId` and `RunExecutionRequest.projectId` are
  required nonempty immutable provenance. The Runner v1 `AcceptedExecutionJob`
  wire message allocates exactly `string project_id = 7`; tags 1-6 remain
  unchanged. Mappers and the protobuf codec must round-trip it losslessly.
- Strict network and production-storage parsing rejects an absent or malformed
  project ID as `PolicyMissing`; no transport, Runner, Core, or provider default
  is allowed.
- `TestMission.projectId` flows through `CompiledMission`, its canonical hash,
  the persisted compiled snapshot, `DispatchableMission`, Mission execution,
  `RunExecutionRequest`, Job construction, and recovery. The compiler rejects
  an approved Plan/Mission project mismatch; SQLite rejects a
  `SaveCompiledMissionInput.projectId` that disagrees with the compiled Mission
  before persistence. Recovery copies the stored immutable value.
- The CLI is an explicit Local policy issuance root and constructs
  `projectId: "local"`. Future Task 11 Local issuance may do the same only at
  its documented Local issuer root; it must not add an implicit request or
  storage default.
- SQLite and PostgreSQL serialize and strict-parse the field in `job_json` on
  lease, renewal, and recovery. The existing constrained Local legacy recovery
  may attach exactly `projectId: "local"` only when its already verified
  historical record is projectless and either policyless or carries the exact
  constrained manifest policy; every other projectless persisted or network Job
  fails closed. Canonical Job hashes include project provenance.

**Follow-up Steps:**
- [ ] Add RED type, mapper/protobuf, storage/recovery, compiler/Mission, shared
  execution, Core recovery, and CLI assertions for required project provenance
  before changing the production contract.
- [ ] Add the required contract field, frozen protobuf tag 7, strict parser,
  lossless mapper, durable Job JSON parsing, and constrained legacy Local
  upcast; do not add an optional or default production value.
- [ ] Propagate the approved Mission project through compiler/hash/persistence,
  Mission request construction, shared Job construction, and recovery. Limit
  explicit `"local"` construction to the existing CLI issuer and the verified
  legacy Local storage read.
- [ ] Update every audited direct Job/request fixture, run provider parity and
  focused Core/Mission/component evidence, then append actual follow-up evidence
  to the Task 15 status ledger.

**Follow-up Gate:** Build first, then with Git OpenSSL explicitly resolved:

```powershell
$env:PATH = 'C:\Program Files\Git\usr\bin;' + $env:PATH
$env:OPENSSL_CONF = 'C:\Program Files\Git\usr\ssl\openssl.cnf'
corepack pnpm build
corepack pnpm vitest run tests/conformance/runner-protocol/accepted-execution-job-plan.test.ts tests/conformance/runner-protocol/grpc-mappers.test.ts tests/conformance/runner-protocol/grpc-round-trip.test.ts tests/conformance/runner-protocol/proto-schema.test.ts tests/contract/runner-control/runner-control-store.contract.ts tests/contract/runner-control/sqlite-runner-control-store.test.ts tests/contract/runner-control/postgres-runner-control-store.test.ts tests/contract/sqlite/prd-mission-store.test.ts tests/unit/core-modules/mission/mission-compiler.test.ts tests/unit/execution-application/mission-execution-use-case.test.ts tests/unit/core-daemon/execution-job-service.test.ts tests/unit/core-daemon/run-ownership-service.test.ts tests/unit/core-daemon/runner-backed-run-resource-factory.test.ts tests/unit/core-daemon/runner-session-service.test.ts tests/unit/cli/config.test.ts tests/unit/runner/job-executor.test.ts tests/unit/runner/offer-runtime.test.ts tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/component/core-runner/core-composition.test.ts tests/component/core-runner/disconnect-recovery.test.ts tests/component/core-runner/independent-process.test.ts tests/component/prd-planning/prd-to-run.test.ts tests/component/web-execution/run-execution-use-case.test.ts tests/component/web-execution/local-run-composition-root.test.ts
corepack pnpm typecheck
git diff --check
```

Run the Docker-backed PostgreSQL contract in that Gate. Report
`DockerUnavailable` only if the Docker daemon actually blocks it.

**Follow-up staging:** Stage only the exact paths in **Follow-up Files**. The
follow-up commit is exactly `fix(policy): preserve immutable job project provenance`.

**Important review-fix authority (2026-08-18):** Standards review of follow-up
commit `f143f8f` found two Important defects. This amendment is additive to the
historical Task 15 scope and the preceding Critical follow-up authority: it does
not claim either prior implementation used the paths below for this fix. It
authorizes no new product capability.

**Review-fix Files (all paths):**
- Modify: `apps/core-daemon/src/legacy-m1-local-recovery.ts`
- Modify: `apps/core-daemon/src/main.ts`
- Modify: `apps/core-daemon/src/runner/runner-backed-run-resource-factory.ts`
- Modify: `docs/production-closure-status.md`
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`
- Modify: `packages/core-modules/runner-control/src/index.ts`
- Modify: `packages/core-modules/runner-control/src/runner-control-store.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/index.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/sqlite-runner-control-store.ts`
- Modify: `tests/component/core-runner/core-composition.test.ts`
- Modify: `tests/contract/runner-control/sqlite-runner-control-store.test.ts`
- Modify: `tests/unit/core-daemon/legacy-m1-local-recovery.test.ts`
- Modify: `tests/unit/core-daemon/runner-backed-run-resource-factory.test.ts`

**Review-fix Interfaces and invariants:**
- `SqliteRunnerControlStore` has no public legacy-upcast constructor option,
  public recovery record, or alternate parse path. All ordinary `lease`,
  renewal, completion, and recovery reads strict-parse `job_json`; missing
  `projectId` throws `PolicyMissing`.
- Only `startCoreDaemon`, after Phase A Local/loopback manifest validation and
  Phase B hash/identity/origin/exact-policy validation, may obtain an opaque
  `VerifiedLegacyM1LocalRecovery`. Before Core composes services or binds a
  listener, that capability atomically replaces each attested historical JSON
  row with the exact immutable Job carrying manifest policy and
  `projectId: "local"`. A raw row change, malformed row, unconstrained policy,
  or failed compare-and-set aborts startup. The public Store then uses its sole
  strict parser; no legacy capability survives into its constructor.
- `RunnerBackedRunResourceFactory.execute` rejects an accepted Job whose
  `projectId` differs from the opened `RunExecutionRequest.projectId` before
  recording an offered Job or calling `connection.offer`. It preserves the
  existing exact-policy, run, and target checks.

**Review-fix Steps:**
- [ ] Add RED proof that passing an arbitrary legacy policy/record to the public
  SQLite Store cannot upcast a projectless row, while only startup with the
  exact constrained manifest migrates the persisted JSON and then permits a
  normal strict Store read.
- [ ] Remove the public Store option/exports and apply the opaque verified
  recovery migration transactionally from the Core startup seam before listener
  bind. Cover policy/hash rejection and successful strict post-migration read.
- [ ] Add a Core factory test that executes a valid-shape Job with a different
  project ID and proves `connection.offer` is never called.
- [ ] Record actual review-fix verification in the Task 15 ledger.

**Review-fix Gate and staging:** Run the full **Follow-up Gate** above with its
explicit Git OpenSSL environment, including `corepack pnpm build`, all 24
listed Vitest files, `corepack pnpm typecheck`, and `git diff --check`. Stage
only **Review-fix Files** and commit exactly
`fix(policy): harden legacy provenance recovery`.

**Final review-fix authority (2026-08-18):** Final review of `b868f78` found
that `@qualigence/runner-control` still exported a reusable
`parseProjectlessExecutionJobForRecovery` parser and type. This narrow repair
does not alter prior implementation history. It removes every public
policyless/projectless recovery parser from contracts and Core modules, keeping
the historical-shape parser private to the verified Core startup operation.

**Final review-fix Files (all paths):**
- Modify: `apps/core-daemon/src/legacy-m1-local-recovery.ts`
- Modify: `docs/production-closure-status.md`
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`
- Modify: `packages/contracts/runner-protocol/src/index.ts`
- Modify: `packages/core-modules/runner-control/src/index.ts`
- Modify: `packages/core-modules/runner-control/src/runner-control-store.ts`
- Modify: `tests/unit/core-daemon/legacy-m1-local-recovery.test.ts`

**Final review-fix Interfaces and steps:**
- Delete public `PolicylessExecutionJob`, `ProjectlessExecutionJob`,
  `parsePolicylessExecutionJob`, and
  `parseProjectlessExecutionJobForRecovery` exports. No contract or Core module
  exposes a parser that accepts a Job without immutable project provenance.
- `apps/core-daemon/src/legacy-m1-local-recovery.ts` privately parses the
  historical shape only inside `verifyLegacyM1LocalRecoveryRows`, verifies its
  manifest identity/hash/origin and exact constrained policy in the same
  operation, then and only then constructs the strict `projectId: "local"` Job
  consumed by its opaque migration capability.
- Update the existing unit test to prove the public Runner Protocol and
  runner-control module namespaces expose no projectless recovery parser while
  the verified Local manifest path still succeeds and policy mismatch fails.
- Record actual evidence in the Task 15 ledger.

**Final review-fix Gate and staging:** Run the full **Follow-up Gate** above
with explicit Git OpenSSL, build, all 24 Vitest files, typecheck, and diff
check. Stage only **Final review-fix Files** and commit exactly
`fix(policy): restrict legacy provenance parser`.

**Startup-private recovery review-fix authority (2026-08-18):** Exact review
of `54fe823` found that `apps/core-daemon/src/legacy-m1-local-recovery.ts`
still exported verifier and applier functions which could be invoked directly
outside `startCoreDaemon`. This narrow repair does not alter prior scope or
implementation history. It makes phase-A validation, phase-B attestation, and
the pre-listener migration one private startup operation with no exported
recovery value or callable verifier/applier.

**Startup-private recovery Files (all paths):**
- Modify: `apps/core-daemon/src/index.ts`
- Modify: `apps/core-daemon/src/main.ts`
- Delete: `apps/core-daemon/src/legacy-m1-local-recovery.ts`
- Modify: `docs/production-closure-status.md`
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`
- Modify: `tests/component/core-runner/core-composition.test.ts`
- Delete: `tests/unit/core-daemon/legacy-m1-local-recovery.test.ts`

**Startup-private recovery Interfaces and steps:**
- `startCoreDaemon` is the only callable recovery operation. Private functions
  in `main.ts` perform Phase A Local/loopback/constrained-policy validation,
  load and verify all Phase-B persisted rows, and atomically migrate the strict
  `projectId: "local"` Jobs before service composition or listener bind.
- Delete all public Core barrel exports and standalone module exports for
  recovery validation, verification, capability, or application. Delete the
  unit test that directly invoked those helper functions; retain and extend
  `startCoreDaemon` component coverage for success and failed phase checks.
- The Core public namespace must expose no legacy recovery helper. No direct
  source module remains from which a consumer can invoke an attestation or
  migration separately from the startup sequence.
- Record actual evidence in the Task 15 ledger.

**Startup-private recovery Gate and staging:** Run the full **Follow-up Gate**
above with explicit Git OpenSSL, build, all 24 Vitest files, typecheck, and diff
check. Stage only **Startup-private recovery Files** and commit exactly
`fix(policy): privatize legacy recovery startup`.

**Adapter-seam review-fix authority (2026-08-18):** Final review of `26a2573`
found that `SqliteRunnerControlStore.rawRecoveryJobJson()` remained a public,
adapter-specific recovery helper and Phase A accepted empty/whitespace Job and
Run identifiers. This narrow repair preserves the existing composition: it uses
the `SqliteRuntime.db` transaction/query seam already owned by
`startCoreDaemon`, changes no `RunnerControlStore` interface, and adds no new
public or parallel seam.

**Adapter-seam review-fix Files (all paths):**
- Modify: `apps/core-daemon/src/main.ts`
- Modify: `docs/production-closure-status.md`
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`
- Modify: `packages/storage-providers/sqlite-runtime/src/sqlite-runner-control-store.ts`
- Modify: `tests/component/core-runner/core-composition.test.ts`

**Adapter-seam review-fix Interfaces and steps:**
- Remove public `SqliteRunnerControlStore.rawRecoveryJobJson()`. Private startup
  recovery reads exact `execution_leases.job_json` through `SqliteRuntime.db`
  inside `startCoreDaemon`; `RunnerControlStore` remains unchanged.
- Phase A requires trimmed, nonempty `jobId` and `runId` before `mkdir`, SQLite
  open, or listener bind. Existing component composition tests cover empty and
  whitespace values, assert no database side effect, and then bind the same port
  normally to prove no listener side effect.
- Preserve all existing Local/loopback/constrained-policy and Phase B
  row/identity/hash/origin checks before migration. Record actual evidence in
  the Task 15 ledger.

**Adapter-seam review-fix Gate and staging:** Run the full **Follow-up Gate**
above with explicit Git OpenSSL, build, all 24 Vitest files, typecheck, and diff
check. Stage only **Adapter-seam review-fix Files** and commit exactly
`fix(policy): close legacy recovery adapter seam`.

**Files:**
- Modify: `packages/contracts/runner-protocol/src/index.ts`
- Modify: `packages/contracts/runner-protocol/src/messages.ts`
- Modify: `packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/mappers.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/wire-codec.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/errors.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/client.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/server.ts`
- Modify: `packages/runner-kernel/src/execution-runtime.ts`
- Create: `packages/runner-kernel/src/deterministic-policy-gate.ts`
- Modify: `packages/runner-kernel/src/index.ts`
- Modify: `apps/runner/src/main.ts`
- Create: `apps/runner/src/offer-runtime.ts`
- Modify: `apps/runner/src/errors.ts`
- Modify: `packages/core-application/src/runner/core-runner-protocol-application.ts`
- Modify: `packages/core-application/src/runner/run-ownership-service.ts`
- Modify: `packages/core-modules/runner-control/src/runner-control-store.ts`
- Modify: `packages/core-modules/runner-control/src/index.ts`
- Modify: `packages/core-modules/mission/src/domain/test-mission.ts`
- Modify: `packages/core-modules/mission/src/application/mission-compiler.ts`
- Modify: `packages/core-modules/mission/src/application/prd-mission-repository.ts`
- Modify: `packages/core-modules/mission/src/public.ts`
- Modify: `packages/execution-application/src/run-execution-use-case.ts`
- Modify: `packages/execution-application/src/contracts.ts`
- Modify: `packages/execution-application/src/index.ts`
- Modify: `packages/execution-application/src/mission-execution-use-case.ts`
- Modify: `apps/core-daemon/src/runner/runner-backed-run-resource-factory.ts`
- Delete: `apps/core-daemon/src/runner/remote-runner-target.ts`
- Modify: `apps/core-daemon/src/index.ts`
- Modify: `apps/core-daemon/src/config.ts`
- Modify: `apps/core-daemon/src/main.ts`
- Create: `apps/core-daemon/src/legacy-m1-local-recovery.ts`
- Modify: `apps/core-daemon/package.json`
- Modify: `apps/core-daemon/tsconfig.json`
- Modify: `apps/cli/src/config.ts`
- Modify: `apps/cli/src/local-run-composition-root.ts`
- Modify: `packages/core-modules/mission/src/exploration-policy.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/index.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/sqlite-prd-mission-store.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/sqlite-runner-control-store.ts`
- Modify: `packages/storage-providers/postgres-runtime/src/postgres-runner-control-store.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `tests/type/runner-protocol-v1.types.ts`
- Modify: `tests/type/run-execution-use-case.types.ts`
- Modify: `tests/conformance/runner-protocol/accepted-execution-job-plan.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-mappers.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-round-trip.test.ts`
- Modify: `tests/conformance/runner-protocol/proto-schema.test.ts`
- Modify: `tests/contract/runner-control/runner-control-store.contract.ts`
- Modify: `tests/contract/runner-control/sqlite-runner-control-store.test.ts`
- Modify: `tests/contract/runner-control/postgres-runner-control-store.test.ts`
- Modify: `tests/helpers/core-runner-harness.ts`
- Modify: `tests/helpers/in-memory-runner-control-store.ts`
- Modify: `tests/unit/core-daemon/execution-job-service.test.ts`
- Modify: `tests/unit/core-daemon/run-ownership-service.test.ts`
- Modify: `tests/unit/core-daemon/runner-backed-run-resource-factory.test.ts`
- Modify: `tests/unit/core-daemon/runner-session-service.test.ts`
- Create: `tests/unit/core-daemon/config.test.ts`
- Create: `tests/unit/core-daemon/legacy-m1-local-recovery.test.ts`
- Modify: `tests/unit/runner/job-executor.test.ts`
- Create: `tests/unit/runner/offer-runtime.test.ts`
- Modify: `tests/unit/runner-components/model-agent.test.ts`
- Create: `tests/unit/core-modules/mission/execution-policy.test.ts`
- Modify: `tests/unit/core-modules/mission/mission-compiler.test.ts`
- Modify: `tests/unit/execution-application/mission-execution-use-case.test.ts`
- Modify: `tests/unit/cli/config.test.ts`
- Modify: `tests/component/core-runner/disconnect-recovery.test.ts`
- Modify: `tests/component/core-runner/independent-process.test.ts`
- Modify: `tests/component/core-runner/core-composition.test.ts`
- Modify: `tests/component/prd-planning/prd-to-run.test.ts`
- Modify: `tests/contract/sqlite/prd-mission-store.test.ts`
- Modify: `tests/component/web-execution/playwright-click.test.ts`
- Modify: `tests/component/web-execution/playwright-observation.test.ts`
- Modify: `tests/component/web-execution/playwright-web-target.test.ts`
- Modify: `tests/unit/target-adapters/web-playwright/browser-session.test.ts`
- Modify: `tests/component/web-execution/run-execution-use-case.test.ts`
- Modify: `tests/component/web-execution/local-run-composition-root.test.ts`
- Modify: `tests/component/investigation/offline-capsule-restoration.test.ts`
- Modify: `tests/component/m1-web-walking-skeleton.test.ts`
- Modify: `tests/unit/execution-application/artifact-recording-observer.test.ts`
- Create: `tests/unit/runner-kernel/deterministic-policy-gate.test.ts`
- Modify: `tests/unit/runner-kernel/execution-runtime.test.ts`
- Modify: `tests/e2e/cli-web-cart.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Produces required `AcceptedExecutionJob.policy: ExecutionPolicySnapshot`.
- Produces `DeterministicRunnerPolicyGate implements RunnerPolicyGate`.
- Removes `AllowSameOriginPolicyGate` and `LocalAllowAllPolicyGate` from production composition roots.

- [ ] **Step 0: Audit scope and capture policy RED evidence before implementation**

Run the mandatory audit before modifying any production source:

```bash
rg -n "AcceptedExecutionJob|jobId:|policy:" apps packages tests
rg -n "AllowSameOriginPolicyGate|LocalAllowAllPolicyGate|AcceptedExecutionJob" apps packages tests
```

Compare every `AcceptedExecutionJob` object construction, nested `ExecutionJobOffer.job` fixture, recovery copy, and persisted-Job deserialization with **Files**. The audit as of `main` `06becdb` requires the Core recovery and Runner-backed producers, the shared execution-application producer, both Runner-control storage boundaries, and all direct Job fixtures: `tests/contract/runner-control/runner-control-store.contract.ts`, `tests/helpers/core-runner-harness.ts`, `tests/type/runner-protocol-v1.types.ts`, `tests/conformance/runner-protocol/accepted-execution-job-plan.test.ts`, `tests/conformance/runner-protocol/grpc-mappers.test.ts`, `tests/conformance/runner-protocol/grpc-round-trip.test.ts`, `tests/conformance/runner-protocol/proto-schema.test.ts`, `tests/unit/core-daemon/execution-job-service.test.ts`, `tests/unit/core-daemon/run-ownership-service.test.ts`, `tests/unit/core-daemon/runner-backed-run-resource-factory.test.ts`, `tests/unit/core-daemon/runner-session-service.test.ts`, `tests/unit/runner/job-executor.test.ts`, `tests/unit/runner-components/model-agent.test.ts`, `tests/unit/runner-kernel/execution-runtime.test.ts`, `tests/component/core-runner/disconnect-recovery.test.ts`, `tests/component/web-execution/playwright-click.test.ts`, `tests/component/web-execution/playwright-observation.test.ts`, `tests/component/web-execution/playwright-web-target.test.ts`, `tests/component/web-execution/run-execution-use-case.test.ts`, `tests/component/investigation/offline-capsule-restoration.test.ts`, `tests/component/m1-web-walking-skeleton.test.ts`, and `tests/unit/execution-application/artifact-recording-observer.test.ts`. The `RunExecutionRequest` producers that must supply this required policy are `apps/cli/src/config.ts`, `packages/execution-application/src/mission-execution-use-case.ts`, and their listed tests/type fixtures. If a later audit finds another Job constructor or request producer, add its exact path to this plan before editing it; do not make `policy` optional.

First add the RED assertions and fixtures, then run the focused command below before implementing the DTO, mapper, gate, or composition changes. Record the expected nonzero Vitest and typecheck results separately; do not collapse them with `&&`. RED evidence must show: a missing TypeScript `policy` is rejected; wire Jobs without policy fail as `PolicyMissing`; protobuf and mapper round trips preserve each policy field; PostgreSQL and unconfigured SQLite Runner-control reads reject a policyless persisted Job as `PolicyMissing`; policyless persisted leases cannot renew and leave expiry unchanged; only a hash-bound Local SQLite recovery manifest can upcast an identified Local M1 Job to `legacy-m1-local`; recovery preserves the original immutable policy; a cross-origin offered Job is denied before browser launch or `page.goto`, permit construction, or action execution; the Core Runner-backed factory rejects a `policyGate` option and passes the exact already-derived policy unchanged to the offered Job; and the policy matrix denies expired, cross-origin, action-kind, risk, production-exploration, and production coordinate/visual-fallback cases before permit construction or executor invocation. A valid isolated same-origin click remains the positive control.

```bash
corepack pnpm vitest run tests/conformance/runner-protocol/accepted-execution-job-plan.test.ts tests/conformance/runner-protocol/grpc-mappers.test.ts tests/conformance/runner-protocol/grpc-round-trip.test.ts tests/conformance/runner-protocol/proto-schema.test.ts tests/contract/runner-control/runner-control-store.contract.ts tests/contract/runner-control/sqlite-runner-control-store.test.ts tests/contract/runner-control/postgres-runner-control-store.test.ts tests/unit/core-daemon/config.test.ts tests/unit/core-daemon/legacy-m1-local-recovery.test.ts tests/unit/core-daemon/runner-backed-run-resource-factory.test.ts tests/component/core-runner/core-composition.test.ts tests/component/core-runner/disconnect-recovery.test.ts tests/component/core-runner/independent-process.test.ts tests/unit/runner/job-executor.test.ts tests/unit/runner/offer-runtime.test.ts tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/unit/core-modules/mission/execution-policy.test.ts tests/unit/core-modules/mission/mission-compiler.test.ts tests/contract/sqlite/prd-mission-store.test.ts tests/unit/execution-application/mission-execution-use-case.test.ts tests/unit/cli/config.test.ts tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/component/web-execution/run-execution-use-case.test.ts tests/component/web-execution/local-run-composition-root.test.ts tests/component/prd-planning/prd-to-run.test.ts tests/e2e/cli-web-cart.test.ts
corepack pnpm typecheck
```

Do not change production composition or add a compatibility default to make this command green. `AcceptedExecutionJob.policy` remains required end-to-end; only the exact Local SQLite manifest-bound storage read below may supply the legacy isolated-test policy, and no network payload, PostgreSQL row, unconfigured SQLite row, or unknown persisted Job may be upcast or accepted.

- [ ] **Step 1: Freeze the policy DTO with type tests**

Add this transport-safe snapshot:

```ts
export interface ExecutionPolicySnapshot {
  readonly policyId: string;
  readonly environment: "isolated_test" | "staging" | "production";
  readonly allowedOrigins: readonly string[];
  readonly allowedActionKinds: readonly ("navigate" | "click" | "input" | "select" | "scroll" | "window")[];
  readonly maximumRisk: "Normal" | "ExternalSideEffect" | "Destructive" | "ProductionForbidden";
  readonly explorationAllowed: boolean;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
```

Make it required on new `AcceptedExecutionJob` values and update every constructor/fixture listed in **Files**. Add explicit protobuf fields for every policy value and lossless `toWire`/`fromWire` mapper assertions; do not serialize the snapshot as unconstrained JSON. Production network payloads without policy fail with `PolicyMissing`; policy is never optional in a domain, factory, or transport type.

**Staging authority and admission:** Keep `staging` as a distinct `ExecutionPolicySnapshot.environment`, never an alias or fallthrough for `isolated_test` or `production`. Only the Core/Mission path may issue it: `packages/core-modules/mission/src/exploration-policy.ts` defines the approved staging declaration, `packages/core-modules/mission/src/domain/test-mission.ts` carries it on the approved Mission, and `packages/core-modules/mission/src/application/mission-compiler.ts` rejects any staging snapshot not explicitly declared and persisted in the immutable compiled Mission. No target URL, deployment setting, Local issuer, or Runner configuration may infer staging.

For Task 15's current single-action execution, an approved staging declaration is valid only with a nonempty explicit set of canonical HTTP(S) origins, exact `allowedActionKinds: ["click"]`, `maximumRisk: "Normal"`, `explorationAllowed: false`, and `issuedAt < expiresAt <= issuedAt + mission.executionBudget.maximumWallClockMs`. The selected Web target origin must be a member of that explicit set. It cannot inherit an isolated-test or production policy field, include a wildcard or credentialed origin, allow `ProductionForbidden`, or expand action/risk authority. `packages/core-modules/mission/src/application/prd-mission-repository.ts` and `packages/storage-providers/sqlite-runtime/src/sqlite-prd-mission-store.ts` retain the exact staging declaration through the compiled-Mission snapshot; `packages/execution-application/src/mission-execution-use-case.ts` passes it unchanged into the required Job policy.

`DeterministicRunnerPolicyGate` handles `"staging"` in an explicit environment branch. An allowed staging action must satisfy the snapshot expiry, exact target origin, `click` allowlist, and `Normal` risk ceiling. Exploration is denied because `explorationAllowed` is false. Coordinate, visual, or any other fallback is denied because it is neither an approved action kind nor represented by a staging fallback permission; it must not fall through to an isolated-test behavior. `tests/unit/core-modules/mission/execution-policy.test.ts` and `tests/unit/core-modules/mission/mission-compiler.test.ts` add a valid explicit staging declaration plus a rejected inherited/wildcard/over-broad declaration. `tests/contract/sqlite/prd-mission-store.test.ts` proves the staging snapshot round trip. `tests/unit/runner-kernel/deterministic-policy-gate.test.ts` adds a valid bounded staging same-origin click and denied staging exploration/coordinate-or-visual fallback cases, proving no permit or executor invocation. These exact paths are already in Task 15's **Files** block and `Step 5` staging recipe; they are required focused RED/GREEN evidence, not a Task 16 deferral.

Freeze the v1 protobuf allocation from the existing `AcceptedExecutionJob` numbering: `job_id = 1`, `run_id = 2`, `target = 3`, `objective = 4`, and existing `plan = 5` remain unchanged; the required field is exactly `ExecutionPolicySnapshot policy = 6`. Define the new nested message with exactly these wire fields: `string policy_id = 1`, `string environment = 2`, `repeated string allowed_origins = 3`, `repeated string allowed_action_kinds = 4`, `string maximum_risk = 5`, `bool exploration_allowed = 6`, `string issued_at = 7`, and `string expires_at = 8`. These tags follow the already-occupied Job tags 1-5 and the new message's first sequential field range; neither names nor tags may be repurposed. `tests/conformance/runner-protocol/proto-schema.test.ts` must assert every one of these field/tag pairs, in addition to preserving `plan = 5`; mapper and protobuf round-trip tests must assert every policy value. Add `PolicyMissing` to the stable gRPC adapter error vocabulary in `packages/protocol-adapters/grpc-runner-protocol/src/errors.ts`; `jobFromWire` rejects an absent or malformed `policy` with that exact code, and `packages/protocol-adapters/grpc-runner-protocol/src/client.ts` fails the offer queue with the same error before any malformed `ExecutionJobOffer` reaches `RunnerSession.nextOffer`.

**Storage-only legacy read:** Add a shared `RunnerControlStoreError` with code `PolicyMissing` in `packages/core-modules/runner-control/src/runner-control-store.ts` and export it from `packages/core-modules/runner-control/src/index.ts`. Both `SqliteRunnerControlStore` and `PostgresRunnerControlStore` parse `execution_leases.job_json` through that strict seam. `PostgresRunnerControlStore` has no upcast option: every policyless or malformed persisted Job, including every Self-hosted/tenant-scoped row, throws `PolicyMissing` and is never offered, renewed, recovered, or executed.

`SqliteRunnerControlStore` is fail-closed by default. Its only exception is an explicit `SqliteRunnerControlStoreOptions.legacyM1LocalRecovery` supplied for a Local SQLite migration/recovery. Export that option from `packages/storage-providers/sqlite-runtime/src/index.ts`; it is not a boolean and has no default. `apps/core-daemon/src/legacy-m1-local-recovery.ts` owns the recovery-manifest interface and both validation phases, giving `startCoreDaemon` a small, deep seam rather than exposing raw manifest parsing across composition. **Superseded by the 2026-08-18 Important review fix above:** the option and export are removed; only Phase B's opaque verified capability atomically migrates the exact attested JSON before Core constructs the normal strict Store.

**Phase A, before SQLite opens:** `apps/core-daemon/src/config.ts` reads the optional explicitly named `CORE_LEGACY_M1_LOCAL_RECOVERY_MANIFEST` file and passes an opaque parsed candidate, not an enabled store option. `startCoreDaemon(config)` repeats the pure validation before `SqliteRuntime.open`: the candidate requires `deploymentMode: "local"`, an exact loopback host (`127.0.0.1` or `::1`), manifest format `legacy-m1-local-recovery/v1`, nonempty structurally valid records, unique `{ jobId, runId, canonicalJobSha256}` identity, valid SHA-256 format, and a constrained policy shape. Any non-Local mode, non-loopback host, unknown format/version, malformed or duplicate record, or malformed policy fails startup before SQLite opens. The candidate policy must be exactly `policyId: "legacy-m1-local"`, `environment: "isolated_test"`, `allowedActionKinds: ["click"]`, `maximumRisk: "Normal"`, `explorationAllowed: false`, one syntactically valid origin, and valid `issuedAt`/`expiresAt` with `issuedAt < expiresAt`. No candidate enables an upcast during Phase A.

**Phase B, after SQLite opens and before any listener or offer:** `startCoreDaemon` uses a read-only raw recovery lookup supplied by `SqliteRunnerControlStore` to load each manifest record's persisted `execution_leases.job_json`; this lookup returns no lease/runner capability and cannot authorize an offer. It verifies the row exists, parses the policyless Job only to read its target and identifiers, and checks its run/job IDs, `canonicalPayloadHash(policylessJob)`, target origin, and constrained manifest policy exactly match the manifest record. Only after every record passes does Phase B create the immutable `legacyM1LocalRecovery` store option. Any missing row, preexisting policy, parse failure, identifier/hash/origin/policy mismatch, or additional unverified manifest record fails startup; `startCoreDaemon` closes SQLite and binds neither gRPC nor HTTP listeners. The fully verified option is the only value passed to `SqliteRunnerControlStore`; no unvalidated manifest path reaches a store read that can upcast or a `connection.offer` call. PostgreSQL never receives this option. **Superseded by the 2026-08-18 Important review fix above:** Phase B instead creates an opaque verified capability and atomically compare-and-swaps every attested row to its exact strict `projectId: "local"` Job before Core constructs the Store; no option reaches the Store and all subsequent reads use its ordinary strict parser.

`tests/unit/core-daemon/legacy-m1-local-recovery.test.ts` covers Phase A structure/mode/host/version/policy constraints and Phase B raw-row identity/hash/origin/policy checks. `tests/contract/runner-control/sqlite-runner-control-store.test.ts` seeds raw policyless `execution_leases.job_json` and proves default rejection, then proves only the fully verified store option yields the exact configured `legacy-m1-local` snapshot. `tests/contract/runner-control/postgres-runner-control-store.test.ts` seeds the same raw shape and proves unconditional `PolicyMissing`; `tests/unit/core-daemon/config.test.ts` covers manifest absence/file parsing; `tests/component/core-runner/core-composition.test.ts` calls exported `startCoreDaemon` directly with non-loopback/non-Local/malformed/duplicate Phase A inputs and missing-row/hash/origin/policy-mismatch Phase B inputs, proving each rejects before listeners bind, then proves ordinary composition has no recovery manifest and cannot offer a policyless persisted Job. `tests/component/core-runner/disconnect-recovery.test.ts` proves `RunOwnershipService.recoveryJob` only copies a prevalidated stored policy, never constructs `legacy-m1-local`. These are storage reads only: wire payloads, newly persisted Jobs, and unknown/recovered production Jobs never receive an upcast.

**Renewal is also a storage read:** Change `RunnerControlStore.renewLease` in `packages/core-modules/runner-control/src/runner-control-store.ts` from `Promise<boolean>` to `Promise<"renewed" | "rejected">`; `rejected` remains only the ordinary live-lease CAS result. Before either provider updates `expires_at`, it must select and strict-parse the existing `job_json` through the same policy-migration seam used by `lease()`. A policyless row therefore throws `RunnerControlStoreError("PolicyMissing")` and never reaches the update statement. Add `PolicyMissing` to `CoreApplicationErrorCode` in `packages/core-application/src/runner/core-runner-protocol-application.ts`; `RunOwnershipService.renew` catches only `RunnerControlStoreError`, translates it to `CoreApplicationError("PolicyMissing", safeMessage)` without JSON details, and otherwise preserves the error. The existing `ExecutionJobService.renew` forwarder then remains transparent. Add `PolicyMissing` to the gRPC `RunnerProtocolErrorCode` and client application-error set in `packages/protocol-adapters/grpc-runner-protocol/src/errors.ts` and `client.ts`, so `CoreRunnerProtocolApplication` surfaces that exact code rather than `LeaseLost`, `rejected`, `TransportError`, or raw JSON. The lease expiry remains unchanged. Update `tests/helpers/in-memory-runner-control-store.ts` to the new discriminated result so its CAS fake stays conformant; it has no raw persisted JSON and never supplies a legacy upcast.

Extend the provider tests above with raw-row renewal cases: seed a live, token/owner/epoch-matching lease whose `job_json` lacks policy; call `renewLease` with a later expiry; assert exact `PolicyMissing` in SQLite and PostgreSQL and reread the row to prove its original expiry is unchanged. Add a `RunOwnershipService.renew` case in `tests/unit/core-daemon/run-ownership-service.test.ts` and a gRPC renewal assertion in `tests/component/core-runner/core-composition.test.ts`, each proving the typed policy failure is not converted to `LeaseLost` or `TransportError`. This preserves one clear error mode for corrupted persisted policy while retaining `rejected` for a genuine conditional-update race or stale lease.

Step 0's audit is a release-blocking precondition for this migration. If a constructor is outside the block, stop and add the exact path to this plan before editing; do not make `policy` optional to reduce the migration surface.

- [ ] **Step 2: Add a policy matrix before implementation**

Test expired policy, cross-origin navigation, origin mismatch, action-kind mismatch, risk above ceiling, production exploration, production coordinate/visual fallback, and a valid isolated same-origin click. A denial must prevent `ExecutionPermit` construction and action executor invocation.

- [ ] **Step 3: Implement deterministic authorization**

The gate receives the immutable Job policy at construction and checks in this order: expiry, environment, target origin, action kind, action risk, fallback resolution. Compare risk using the fixed order `Normal < ExternalSideEffect < Destructive < ProductionForbidden`. `ProductionForbidden` is never allowed even if maximumRisk is malformed or equal. Return stable reason codes in safe messages.

- [ ] **Step 4: Construct policy in Core/CLI, enforce in Runner**

Core must propagate an approved policy source without synthesizing an allow-all or target-derived default. Add a Mission-owned `ApprovedExecutionPolicy` and its Exploration narrowing conversion in `packages/core-modules/mission/src/exploration-policy.ts`. Its required inputs are exactly `policyId`, `environment`, `allowedOrigins`, `allowedActionKinds`, `maximumRisk`, `explorationAllowed`, `issuedAt`, and `expiresAt`; the conversion accepts a validated `ExplorationPolicy` only to narrow this approved source, never to widen it. It rejects an exploration policy that would require an unrepresentable or broader action/risk/origin authority, and produces an exploration-enabled policy only when the approved environment is non-production and the Mission source permits exploration. `tests/unit/core-modules/mission/execution-policy.test.ts` is the direct RED/GREEN proof for this conversion.

`packages/core-modules/mission/src/domain/test-mission.ts` carries `ApprovedExecutionPolicy` on the approved Mission; `packages/core-modules/mission/src/application/mission-compiler.ts` validates, freezes, and carries it in the immutable compiled Mission; and `packages/core-modules/mission/src/application/prd-mission-repository.ts` exposes it on `DispatchableMission`. `packages/storage-providers/sqlite-runtime/src/sqlite-prd-mission-store.ts` persists it in the existing immutable `mission_revisions.compiled_json` snapshot and reloads that snapshot when constructing `DispatchableMission`, without modifying historical migrations. The target URL is only checked against the approved allowed-origins set; it must never manufacture a broader origin list or other policy default.

`packages/execution-application/src/contracts.ts` makes the immutable snapshot required on `RunExecutionRequest`. `packages/execution-application/src/mission-execution-use-case.ts` maps the loaded approved Mission/exploration policy and selected target into that request, rejecting a target outside the approved origins. `packages/execution-application/src/run-execution-use-case.ts` copies `request.policy` unchanged into the new `AcceptedExecutionJob`; `apps/cli/src/config.ts` is the sole non-Mission producer and constructs the explicit isolated-test policy for the requested URL and its supported action kinds.

`apps/cli/src/local-run-composition-root.ts` is a local Runner-side composition root: before its local `ExecutionRuntime` can observe, decide, resolve, execute, or verify, it constructs `DeterministicRunnerPolicyGate(request.policy)` and passes that gate to the runtime in place of `LocalAllowAllPolicyGate`. It gives the Playwright adapter exactly `request.policy.allowedOrigins`, never `[new URL(request.target.url).origin]`. The remote Runner independently constructs its own gate in `apps/runner/src/offer-runtime.ts` from `offer.job.policy`. Core derives and transports immutable policy but neither `apps/core-daemon` nor `packages/core-application` imports, constructs, injects, or calls `RunnerPolicyGate`.

`apps/core-daemon/src/runner/runner-backed-run-resource-factory.ts` is a Core-side transport bridge, not a Runner execution runtime. Replace `RunResourceScope.runtime: ExecutionRuntime` in `packages/execution-application/src/contracts.ts` with `execute(job: AcceptedExecutionJob): Promise<ExecutionCompletion>`; export the changed contract from `packages/execution-application/src/index.ts`. `packages/execution-application/src/run-execution-use-case.ts` calls `scope.execute(job)`. The Local factory adapts its local `ExecutionRuntime.run(job)` to that scope method; the Core factory implements it by `connection.offer(job, requiredCapabilities)` and then awaiting an injected token-free `awaitCompletion(lease)` port.

Remove `RunnerPolicyGate`, `ExecutionRuntime`, `InMemoryProtocolTraceRecorder`, `TraceIngestor`, and `RemoteRunnerTarget` from the Core factory's options, state, and construction. Its `execute` path requires the already-derived Job policy, copies that exact immutable Job to `connection.offer`, and only awaits completion. It neither authorizes, resolves, observes, nor executes actions in Core. It must reject a supplied legacy `policyGate` option at the public constructor boundary rather than ignoring it, so neither `AllowAllRunnerPolicyGate` nor any arbitrary Core gate can affect remote dispatch. Delete the obsolete `apps/core-daemon/src/runner/remote-runner-target.ts` and remove its export from `apps/core-daemon/src/index.ts`; remove the now-unused Runner Kernel and in-memory Runner Protocol dependencies/references from `apps/core-daemon/package.json`, `apps/core-daemon/tsconfig.json`, and `pnpm-lock.yaml`.

`apps/runner/src/main.ts` delegates remote gate construction to `apps/runner/src/offer-runtime.ts`; that runtime owns remote action authorization and does not accept a Core-supplied gate. `tests/unit/core-daemon/runner-backed-run-resource-factory.test.ts` starts RED by asserting that the constructor type/runtime rejects `policyGate`, that a request without policy cannot be dispatched, that `connection.offer` receives the same policy value, and that no Core target action or permit is invoked. `tests/component/core-runner/core-composition.test.ts` and `tests/component/core-runner/independent-process.test.ts` prove a remotely offered Job is enforced only by the Runner-side deterministic gate, including a denial with no action execution. `tests/component/web-execution/local-run-composition-root.test.ts` and `tests/e2e/cli-web-cart.test.ts` prove the local root uses `DeterministicRunnerPolicyGate(request.policy)` and cannot widen its adapter origin allowlist. Do not move either local or remote `DeterministicRunnerPolicyGate` construction into Core.

**Runner target admission:** Create `apps/runner/src/offer-runtime.ts` as the single Runner composition module for one offered Job. Its small interface accepts `{ offer, session, spool, config, createTarget }`, and calls the new static `DeterministicRunnerPolicyGate.admitJob(job: AcceptedExecutionJob): TargetAdmission` before `createTarget`, `PlaywrightWebTargetAdapter` construction, `adapter.start`, browser launch, context/page creation, or `page.goto`. `TargetAdmission` is a small allowed/denied result. It validates required policy, expiry, HTTP(S) target origin, and membership in `policy.allowedOrigins`, returning stable `PolicyMissing` or `PolicyDenied` codes with safe messages. The allowed result carries the constructed `DeterministicRunnerPolicyGate`; denied results construct neither a gate nor an `ExecutionPermit`. This lets policyless untrusted offer input fail explicitly before any `offer.job.policy` property is consumed.

On admission denial, `RunnerOfferRuntime` calls `session.accept(offer.offerId)` only to obtain the lease required to send one blocked `ExecutionCompletion` carrying that stable code, then completes it. It does not start a browser, invoke a model/decision provider, invoke an action executor, or drain a fabricated Trace. This resolves the offered lease deterministically rather than treating policy denial as a transport failure. Only an allowed admission may construct the adapter with `allowedOrigins: offer.job.policy.allowedOrigins`, compose `LeasedJobExecutor` with the same deterministic gate, drain Trace, and complete the lease.

`apps/runner/src/main.ts` delegates `runOffer` to this module and removes its target-origin-derived `allowedOrigins` and `AllowSameOriginPolicyGate`. `apps/runner/src/errors.ts` adds the two stable Runner error codes. Keep `packages/target-adapters/web-playwright/src/browser-session.ts` and `PlaywrightWebTargetAdapter` unchanged as the deep adapter defense in depth: `PlaywrightBrowserSession.validateTarget()` still rejects any adapter input origin not in its explicit allowlist before `BrowserLauncher.launch` or `page.goto`; it must never infer an allowlist from the URL. The policy admission seam remains in `apps/runner`, where the offered Job and deterministic policy belong; neither the target adapter nor Core receives a `RunnerPolicyGate`.

`tests/unit/runner/offer-runtime.test.ts` starts RED using an injected `createTarget` spy: a cross-origin or policyless offer produces the corresponding blocked completion after exactly one lease accept, while `createTarget`, browser launch, `page.goto`, permit construction, decision, and executor calls are all zero. Its allowed control proves `createTarget` receives only `policy.allowedOrigins` and the executor uses the same gate. Extend `tests/unit/target-adapters/web-playwright/browser-session.test.ts` with an injected `BrowserLauncher`/page spy proving a non-allowlisted adapter URL invokes neither `launch` nor `goto`; extend `tests/unit/runner/job-executor.test.ts` and `tests/component/core-runner/independent-process.test.ts` to prove Runner-side denial produces no action execution. These tests prove initial navigation is protected before Playwright, while the existing action-executor origin checks remain a second defense.

Cover this path in `tests/unit/core-modules/mission/execution-policy.test.ts`, `tests/unit/core-modules/mission/mission-compiler.test.ts`, `tests/contract/sqlite/prd-mission-store.test.ts`, `tests/unit/execution-application/mission-execution-use-case.test.ts`, `tests/component/prd-planning/prd-to-run.test.ts`, `tests/unit/cli/config.test.ts`, `tests/component/web-execution/local-run-composition-root.test.ts`, and `tests/type/run-execution-use-case.types.ts`: changing a target must not widen the approved policy; the Mission/SQLite round trip retains it; required request policy cannot be omitted; and CLI produces only its explicit isolated-test policy. The runner, not Core, instantiates `DeterministicRunnerPolicyGate(offer.job.policy)` and does not widen policy from local configuration.

- [ ] **Step 5: Verify and commit**

Rerun the Step 0 focused command after implementation and require it to pass, then run:

```bash
corepack pnpm vitest run tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/e2e/cli-web-cart.test.ts
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add packages/core-modules/runner-control/src/runner-control-store.ts packages/core-modules/runner-control/src/index.ts packages/execution-application/src/index.ts apps/core-daemon/src/runner/remote-runner-target.ts apps/core-daemon/src/index.ts apps/core-daemon/src/config.ts apps/core-daemon/src/main.ts apps/core-daemon/src/legacy-m1-local-recovery.ts apps/core-daemon/package.json apps/core-daemon/tsconfig.json packages/storage-providers/sqlite-runtime/src/index.ts pnpm-lock.yaml tests/contract/runner-control/sqlite-runner-control-store.test.ts tests/contract/runner-control/postgres-runner-control-store.test.ts tests/helpers/in-memory-runner-control-store.ts tests/unit/core-daemon/config.test.ts tests/unit/core-daemon/legacy-m1-local-recovery.test.ts tests/unit/core-daemon/run-ownership-service.test.ts tests/component/core-runner/core-composition.test.ts
git add apps/runner/src/offer-runtime.ts apps/runner/src/errors.ts tests/unit/runner/offer-runtime.test.ts tests/unit/target-adapters/web-playwright/browser-session.test.ts
git add packages/contracts/runner-protocol/src/index.ts packages/contracts/runner-protocol/src/messages.ts packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto packages/protocol-adapters/grpc-runner-protocol/src/mappers.ts packages/protocol-adapters/grpc-runner-protocol/src/wire-codec.ts packages/protocol-adapters/grpc-runner-protocol/src/errors.ts packages/protocol-adapters/grpc-runner-protocol/src/client.ts packages/runner-kernel/src/execution-runtime.ts packages/runner-kernel/src/deterministic-policy-gate.ts packages/runner-kernel/src/index.ts apps/runner/src/main.ts packages/core-application/src/runner/core-runner-protocol-application.ts packages/core-application/src/runner/run-ownership-service.ts packages/core-modules/mission/src/domain/test-mission.ts packages/core-modules/mission/src/application/mission-compiler.ts packages/core-modules/mission/src/application/prd-mission-repository.ts packages/core-modules/mission/src/public.ts packages/core-modules/mission/src/exploration-policy.ts packages/execution-application/src/contracts.ts packages/execution-application/src/mission-execution-use-case.ts packages/execution-application/src/run-execution-use-case.ts apps/core-daemon/src/runner/runner-backed-run-resource-factory.ts apps/cli/src/config.ts apps/cli/src/local-run-composition-root.ts packages/storage-providers/sqlite-runtime/src/sqlite-prd-mission-store.ts packages/storage-providers/sqlite-runtime/src/sqlite-runner-control-store.ts packages/storage-providers/postgres-runtime/src/postgres-runner-control-store.ts tests/type/runner-protocol-v1.types.ts tests/type/run-execution-use-case.types.ts tests/conformance/runner-protocol/accepted-execution-job-plan.test.ts tests/conformance/runner-protocol/grpc-mappers.test.ts tests/conformance/runner-protocol/grpc-round-trip.test.ts tests/conformance/runner-protocol/proto-schema.test.ts tests/contract/runner-control/runner-control-store.contract.ts tests/helpers/core-runner-harness.ts tests/unit/core-daemon/execution-job-service.test.ts tests/unit/core-daemon/run-ownership-service.test.ts tests/unit/core-daemon/runner-backed-run-resource-factory.test.ts tests/unit/core-daemon/runner-session-service.test.ts tests/unit/runner/job-executor.test.ts tests/unit/runner-components/model-agent.test.ts tests/unit/core-modules/mission/execution-policy.test.ts tests/unit/core-modules/mission/mission-compiler.test.ts tests/unit/execution-application/mission-execution-use-case.test.ts tests/unit/execution-application/artifact-recording-observer.test.ts tests/unit/cli/config.test.ts tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/component/core-runner/disconnect-recovery.test.ts tests/component/core-runner/independent-process.test.ts tests/component/prd-planning/prd-to-run.test.ts tests/contract/sqlite/prd-mission-store.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/playwright-web-target.test.ts tests/component/web-execution/run-execution-use-case.test.ts tests/component/web-execution/local-run-composition-root.test.ts tests/component/investigation/offline-capsule-restoration.test.ts tests/component/m1-web-walking-skeleton.test.ts tests/e2e/cli-web-cart.test.ts docs/production-closure-status.md
git commit -m "feat(policy): enforce deterministic execution snapshots"
```

---

### Task 16: Execute bounded multi-step Web plans and resolve input valueRefs safely

**Files:**
- Modify: `packages/contracts/model-provider/src/index.ts`
- Modify: `packages/contracts/runner-protocol/src/index.ts`
- Create: `packages/runner-kernel/src/execution-budget.ts`
- Modify: `packages/runner-kernel/src/execution-runtime.ts`
- Modify: `packages/runner-kernel/src/index.ts`
- Modify: `packages/model-gateway/src/model-gateway.ts`
- Modify: `packages/runner-components/model-agent/src/model-agent.ts`
- Modify: `packages/runner-components/model-agent/src/index.ts`
- Modify: `packages/model-providers/openai-compatible/src/openai-compatible-model-provider.ts`
- Modify: `packages/target-adapters/web-playwright/src/playwright-action-resolver.ts`
- Modify: `packages/target-adapters/web-playwright/src/playwright-action-executor.ts`
- Modify: `packages/target-adapters/web-playwright/src/playwright-web-target-adapter.ts`
- Modify: `packages/target-adapters/web-playwright/src/index.ts`
- Create: `apps/runner/src/action-value-provider.ts`
- Modify: `apps/runner/src/config.ts`
- Modify: `apps/runner/src/main.ts`
- Modify: `apps/runner/src/index.ts`
- Modify: `tests/type/runner-protocol-v1.types.ts`
- Modify: `tests/conformance/runner-protocol/accepted-execution-job-plan.test.ts`
- Modify: `tests/unit/runner-kernel/execution-runtime.test.ts`
- Modify: `tests/unit/runner-components/model-agent.test.ts`
- Modify: `tests/unit/model-gateway/model-gateway.test.ts`
- Modify: `tests/contract/model-providers/openai-compatible-model-provider.test.ts`
- Modify: `tests/unit/target-adapters/web-playwright/action-resolution.test.ts`
- Modify: `tests/component/web-execution/fixtures.ts`
- Modify: `tests/component/web-execution/run-execution-use-case.test.ts`
- Create: `tests/component/web-execution/playwright-multi-step.test.ts`
- Create: `tests/unit/runner/action-value-provider.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Extends `ProposedAction`, `ResolvedWebAction`, decision/resolution Trace payloads, and policy action kinds to `navigate | click | input | select | scroll` for Web while retaining the Desktop `window` variant.
- Produces `ExecutionBudget`, shared by Runtime, decision provider, and verifier to enforce step, wall-clock, and model-token limits in deterministic code.
- Produces `ActionValueProvider.resolve(valueRef): Promise<string>` and a production `FileActionValueProvider`; Jobs, plans, model prompts, Trace, and Findings continue to carry only `valueRef`, never the resolved value.
- Preserves the legacy objective-only CLI behavior as an explicit one-action plan, not an unbounded loop.

- [ ] **Step 1: Freeze action unions, step semantics, and budget RED tests**

Update the Runner Kernel action union to:

```ts
export type ProposedAction =
  | { readonly kind: "navigate"; readonly path: string; readonly reason: string }
  | { readonly kind: "click"; readonly target: { readonly nodeId: string }; readonly reason: string }
  | { readonly kind: "input"; readonly target: { readonly nodeId: string }; readonly valueRef: string; readonly reason: string }
  | { readonly kind: "select"; readonly target: { readonly nodeId: string }; readonly option: string; readonly reason: string }
  | { readonly kind: "scroll"; readonly target: { readonly nodeId: string }; readonly direction: "up" | "down" | "left" | "right"; readonly amount: "page" | "small"; readonly reason: string }
  | { readonly kind: "window"; readonly target: { readonly nodeId: string }; readonly operation: "focus" | "minimize" | "restore" | "close"; readonly reason: string };
```

Make `ResolvedWebAction` a discriminated union for the first five kinds; navigation carries a canonical same-origin URL and no node, while every element action carries graph/node locator provenance. Make decision/resolution Trace payloads losslessly discriminated and add `stepIndex`; never map a non-click action to a fake click. Update `resolvedActionNodeId` to return `string | undefined` so navigation is represented honestly.

Add RED cases for: a 4-step `navigate → input → click → verify` plan; fresh observation before every element resolution; a failed intermediate action stops later steps; `maximumStepsPerJob`; injected wall clock expiry; model-token exhaustion before action; missing usage; input without a configured value provider; raw resolved input absent from every Trace/error; and objective-only Jobs executing at most one action.

- [ ] **Step 2: Implement one deterministic execution budget**

Create:

```ts
export interface ExecutionBudget {
  begin(job: AcceptedExecutionJob): void;
  beforeStep(runId: string, stepIndex: number): void;
  maximumOutputTokens(runId: string): number;
  consumeModelUsage(runId: string, usage: ModelUsage | undefined): void;
  finish(runId: string): void;
}
```

The implementation uses an injected monotonic clock. It derives limits from `job.plan.budget`; an objective-only Job gets `{ maximumStepsPerJob: 1, maximumWallClockMs: configured action timeout, maximumModelTokens: configured one-call ceiling }`. Reject zero/negative/unsafe bounds before observing the target. Count `usage.totalTokens` or `inputTokens + outputTokens`; when usage is absent under a finite budget, fail `ModelUsageUnavailable`. An invocation that crosses the remaining budget records usage then throws `ModelBudgetExceeded` before an action Permit is minted. Always clear per-run state in `finally`.

Add optional required-for-model-calls `maximumOutputTokens` to `StructuredModelRequest`/`ModelProviderRequest`; `ModelGateway` validates a positive integer and forwards it. The OpenAI-compatible provider maps it to the provider's supported output-token field and its contract test asserts the outgoing body. It must never silently omit a caller-supplied limit.

- [ ] **Step 3: Make model decisions match the immutable current plan step**

Extend `AgentContext` with `step`, `stepIndex`, and the current observation. For a planned Job, the structured-output schema is discriminated by the current step: `navigate.path` and `input.valueRef` must exactly equal the immutable snapshot; click/input/select/scroll node IDs must exist in the current graph; verify steps never call the decision provider. The model chooses semantic grounding only and cannot add, reorder, skip, or alter steps. Include no resolved input value in prompts.

Return model usage to the shared budget after every decision and verification call. For legacy objective-only Jobs, retain the current click-only schema and one decision; do not infer an unbounded autonomous loop from model output.

- [ ] **Step 4: Execute each plan step with re-observation and deterministic stopping**

Refactor `ExecutionRuntime.runUntilCompletion` into a bounded indexed loop:

1. call `budget.beforeStep`;
2. capture and persist the current observation;
3. for an action step, obtain the matching proposal, resolve, authorize, execute, and persist each stage;
4. for a verify step, call the verifier with exactly its `claimIds`, persist verification, and create a Finding/stop on failure;
5. after a successful state-changing action, discard its descriptor map and re-observe before the next step.

If a plan contains no explicit verify step, run one final verification against `expectedClaimIds`. One denied/failed/timed-out action terminates as blocked and no later action/verification runs. Navigation must pass the Task 15 origin/policy gate before `page.goto`. Completion is emitted exactly once.

- [ ] **Step 5: Add Web resolvers/executors without selector or secret leakage**

Resolver rules: navigation canonicalizes `path` against the Job Web target and rejects another origin; click/input/select/scroll resolve only the current graph's private descriptor; Desktop window always returns `UnsupportedTargetKind`. Executor rules: click uses `locator.click`; input resolves `valueRef` at the last moment then uses `locator.fill`; select uses `locator.selectOption`; scroll uses a bounded semantic element/page scroll; navigation uses `page.goto` with the configured timeout. Recheck visibility/enabled/origin before/after as applicable. Outcomes and thrown errors contain only stable codes and valueRef, never resolved bytes.

`FileActionValueProvider` reads a configuration file whose JSON values are relative filenames under an explicit `RUNNER_ACTION_VALUE_ROOT`; resolved paths must stay under that canonical root, be regular files, and be at most 64 KiB. Reject inline values, absolute/parent paths, symlinks escaping the root, duplicate refs, and permissive POSIX secret-file modes. Advertise `action:input` only when this provider initializes successfully. Do not load or log all secret values at startup.

- [ ] **Step 6: Prove a real multi-step browser workflow**

Drive Chromium through a fixture requiring navigation, a valueRef-backed input, a click, and a verification. Assert multiple ordered observations/action stages, the final page state, exact one terminal event, and that the resolved test value is absent from serialized Trace, Finding, error output, and runner logs. Add failure variants for stale descriptor after DOM change, cross-origin navigation, disabled input, missing valueRef, step budget, wall budget, and model budget.

- [ ] **Step 7: Verify and commit**

Run:

```bash
corepack pnpm vitest run tests/unit/runner-kernel/execution-runtime.test.ts tests/unit/runner-components/model-agent.test.ts tests/unit/model-gateway/model-gateway.test.ts tests/contract/model-providers/openai-compatible-model-provider.test.ts tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/unit/runner/action-value-provider.test.ts tests/component/web-execution/run-execution-use-case.test.ts tests/component/web-execution/playwright-multi-step.test.ts
corepack pnpm typecheck
git diff --check
```

Update the Web execution row in `docs/production-closure-status.md` from `single_action` to `bounded_plan` only when the real Chromium test passes without a browser skip.

Commit:

```bash
git add packages/contracts/model-provider/src/index.ts packages/contracts/runner-protocol/src/index.ts packages/runner-kernel packages/model-gateway/src/model-gateway.ts packages/runner-components/model-agent packages/model-providers/openai-compatible/src/openai-compatible-model-provider.ts packages/target-adapters/web-playwright apps/runner/src tests/type/runner-protocol-v1.types.ts tests/conformance/runner-protocol/accepted-execution-job-plan.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/unit/runner-components/model-agent.test.ts tests/unit/model-gateway/model-gateway.test.ts tests/contract/model-providers/openai-compatible-model-provider.test.ts tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/unit/runner/action-value-provider.test.ts tests/component/web-execution docs/production-closure-status.md
git commit -m "feat(runner): execute bounded multi-step web plans"
```

---

### Task 17: Migrate every live observation producer and consumer to Graph v1

**Files:**
- Create: `packages/contracts/observation/src/web-extension.ts`
- Modify: `packages/contracts/observation/src/index.ts`
- Modify: `packages/contracts/runner-protocol/src/index.ts`
- Modify: `packages/runner-kernel/src/execution-runtime.ts`
- Modify: `packages/runner-components/model-agent/src/model-agent.ts`
- Modify: `packages/runner-components/exploration/src/exploration-controller.ts`
- Modify: `packages/runner-components/exploration/src/state-visit-tracker.ts`
- Modify: `packages/execution-application/src/artifact-recording-observer.ts`
- Modify: `apps/benchmark-runner/src/scenario.ts`
- Modify: `packages/target-adapters/web-playwright/src/observation-builder.ts`
- Modify: `packages/target-adapters/web-playwright/src/playwright-observer.ts`
- Modify: `packages/target-adapters/web-playwright/src/playwright-web-target-adapter.ts`
- Modify: `packages/target-adapters/web-playwright/src/playwright-action-resolver.ts`
- Modify: `tests/unit/target-adapters/web-playwright/observation-builder.test.ts`
- Modify: `tests/component/web-execution/playwright-observation.test.ts`
- Modify: `tests/component/web-execution/playwright-click.test.ts`
- Modify: `tests/component/web-execution/playwright-web-target.test.ts`
- Modify: `tests/component/web-execution/run-execution-use-case.test.ts`
- Modify: `tests/conformance/observation/json-schema.test.ts`
- Modify: `tests/conformance/observation/canonical.test.ts`
- Modify: `tests/conformance/observation/extensions.test.ts`
- Modify: `tests/conformance/observation/windows-uia.test.ts`
- Modify: `tests/property/observation-graph.test.ts`
- Modify: `tests/replay/observation-v1/recompiled-skill.test.ts`
- Modify: `tests/replay/exploration/bounded-exploration.test.ts`
- Modify: `tests/replay/windows-uia/action-resolution.test.ts`
- Modify: `tests/replay/windows-uia/uia-payload-mapping.test.ts`
- Modify: `tests/unit/execution-application/artifact-recording-observer.test.ts`
- Modify: `tests/unit/runner-components/exploration/exploration-controller.test.ts`
- Modify: `tests/unit/runner-components/exploration/state-visit-tracker.test.ts`
- Modify: `tests/unit/target-adapters/web-playwright/action-resolution.test.ts`
- Modify: `tests/live/remote-model-smoke.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Makes `ObservationGraphV1` the return type of the live `Observer.capture` port and the input type for live decision/resolution/verification.
- Keeps the old `ObservationGraph` type only for decoding historical pre-v1 assets and migration fixtures.
- New Trace observation events carry v1; historical readers use the existing migration projector.

- [ ] **Step 1: Add failing Web v1 conformance tests**

Capture the Web cart and validate the returned graph with `validateObservationGraphV1`. Assert schema, target, capturedAt, rootNodeIds, source, state, sensitivity, relations, evidence refs, stable node IDs, and a `web/v1` extension containing normalized visible text/disabled semantics needed by Web consumers. Confirm no CSS/XPath selector is stored in the Graph.

- [ ] **Step 2: Define and validate the Web extension**

Add a typed extension with `type: "web"`, `version: "web/v1"`, and bounded payload fields for normalized text and DOM/accessibility provenance. Locator descriptors remain in the adapter's private map keyed by nodeId and are not serialized into observation evidence.

- [ ] **Step 3: Change the live runtime port types**

Update `Observer`, decision provider, resolver, verifier, exploration fingerprinting, model context, execution-application recording observers, Benchmark scenario, and all affected tests in **Files** to `ObservationGraphV1`. Adapt node access from legacy `text/disabled` fields to v1 `state`, `value`, `name`, and `web/v1` extension. Keep unknown extensions round-trippable and ignore unknown minor versions; fail closed only when a consumer requires an unsupported major.

- [ ] **Step 4: Emit v1 from Playwright**

`buildObservationGraph` returns `ObservationGraphV1` plus the private descriptor map. Use `{ kind: "web", targetId: canonical URL/or configured target ID }`, deterministic root IDs, sensitivity classification, and canonical evidence refs. Preserve current stable semantic node-ID behavior so existing action-resolution tests remain meaningful.

- [ ] **Step 5: Separate historical compatibility from live types**

Do not define a union on the live `Observer` port. Historical pre-v1 JSON enters through `@qualigence/observation-migration`, produces a v1 projection, and only then reaches live consumers. `packages/observation-migration/src/pre-v1-projector.ts` remains the only intentional legacy-graph import. At the end run `rg -l "\\bObservationGraph\\b" apps packages tests`; every other hit must either be migrated in this task or documented as a historical decoder fixture in the status ledger.

- [ ] **Step 6: Verify and commit**

Run:

```bash
corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts tests/unit/target-adapters/web-playwright tests/component/web-execution/playwright-observation.test.ts tests/replay/observation-v1/recompiled-skill.test.ts tests/replay/windows-uia
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add packages/contracts/observation packages/contracts/runner-protocol/src/index.ts packages/runner-kernel packages/runner-components/model-agent packages/runner-components/exploration packages/execution-application/src/artifact-recording-observer.ts packages/target-adapters/web-playwright apps/benchmark-runner/src/scenario.ts tests docs/production-closure-status.md
git commit -m "feat(observation): migrate live web runtime to graph v1"
```

---

### Task 18: Wire desktop Targets and a real TypeScript Named Pipe Companion client into Runner

**Files:**
- Modify: `packages/contracts/desktop/src/companion-ipc.ts`
- Modify: `packages/contracts/desktop/src/index.ts`
- Modify: `packages/contracts/runner-protocol/src/index.ts`
- Modify: `packages/contracts/runner-protocol/src/messages.ts`
- Modify: `packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/mappers.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/wire-codec.ts`
- Create: `packages/target-adapters/desktop-windows-uia/src/named-pipe-companion-client.ts`
- Modify: `packages/target-adapters/desktop-windows-uia/src/index.ts`
- Modify: `packages/target-adapters/desktop-windows-uia/package.json`
- Modify: `packages/target-adapters/desktop-windows-uia/tsconfig.json`
- Modify: `apps/runner/src/config.ts`
- Modify: `apps/runner/src/main.ts`
- Modify: `apps/runner/package.json`
- Modify: `apps/runner/tsconfig.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/runner/src/target-runtime-factory.ts`
- Modify: `tests/type/runner-protocol-v1.types.ts`
- Modify: `tests/conformance/runner-protocol/accepted-execution-job-plan.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-mappers.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-round-trip.test.ts`
- Modify: `tests/conformance/runner-protocol/proto-schema.test.ts`
- Create: `tests/contract/desktop/named-pipe-client.test.ts`
- Modify: `tests/component/windows-uia/reference-app-pipeline.test.ts`
- Modify: `tests/unit/runner-kernel/target-kind-discriminator.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Extends `TargetRef` to `WebTargetRef | DesktopTargetRef`, where `DesktopTargetRef` is `{ kind: "desktop"; app: AppTarget }`.
- Produces a bounded `CompanionResponse` discriminated union and parser in desktop contracts.
- Produces `NamedPipeCompanionClient implements CompanionClient`.
- Produces `TargetRuntimeFactory.open(job)` returning a closeable set of Observer/Resolver/ActionExecutor/Verifier resources for Web or Desktop.

- [ ] **Step 1: Freeze Desktop Target wire mapping and response DTOs**

Add a protobuf `TargetRef` `oneof` with explicit `WebTargetRef` and structured `DesktopTargetRef/AppTarget` messages. Map every AppTarget field (target ID, platform, launch executable/argv/working directory, process image allowlist, window selector, reset argv/timeout, shutdown policy). Add mapper/round-trip cases proving Web and Desktop survive `toWire → fromWire` byte-for-byte, malformed/multiple oneof kinds fail closed, and no Desktop field is silently defaulted or dropped. Do not encode AppTarget as arbitrary JSON.

Define response variants for handshake challenge/accepted, session/app lifecycle, UIA capture, approval decision, action outcome, and stable error. Every response carries `requestId`; reject unknown types, oversized declared lengths, wrong request correlation, truncated bodies, and invalid DTOs before resolving a client Promise.

- [ ] **Step 2: Add a fake Named Pipe server contract test**

Use `node:net` with a temporary pipe name. Exercise 32-bit big-endian framing, maximum frame size, request correlation, connection close, timeout, concurrent bounded requests, and handshake order. No method may send app/capture/permit/action before authentication succeeds.

- [ ] **Step 3: Implement the Companion client**

Connect only to the configured local Named Pipe path. Validate every outbound request with `parseCompanionRequest`, frame it, and validate every response. Perform challenge-response using the Runner's existing client certificate key; bind proof to `{ protocolMajor, companionInstanceId, nonce, runnerId }`. Reject a Companion certificate/instance mismatch and never log certificates, tokens, action values, or Permit material.

- [ ] **Step 4: Add target-discriminated Runner composition**

Move target construction out of `runOffer` into `TargetRuntimeFactory`. Web retains Playwright. Desktop requires Windows, an authenticated Companion, `AppEnvironmentProvider`, `WindowsDesktopAdapter`, `UiaActionResolver`, and `UiaActionExecutor`. Launch before capture; shutdown in `finally`. Advertise `desktop-windows-uia` only after Companion authentication and a capability probe succeeds.

- [ ] **Step 5: Preserve fail-closed target dispatch**

A Web action is never accepted by `UiaActionExecutor`; a Desktop action is never accepted by Playwright. Unsupported platform/adapter/Companion produces `CapabilityMismatch` or `CompanionUnavailable` before executing a Job. Do not silently run a desktop job as Web or synthetic UIA.

- [ ] **Step 6: Verify and commit**

Run:

```bash
corepack pnpm vitest run tests/contract/desktop tests/unit/runner-kernel/target-kind-discriminator.test.ts tests/component/windows-uia/reference-app-pipeline.test.ts
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add packages/contracts/desktop packages/contracts/runner-protocol packages/protocol-adapters/grpc-runner-protocol/src packages/target-adapters/desktop-windows-uia apps/runner pnpm-lock.yaml tests/type/runner-protocol-v1.types.ts tests/conformance/runner-protocol tests/contract/desktop tests/component/windows-uia/reference-app-pipeline.test.ts tests/unit/runner-kernel/target-kind-discriminator.test.ts docs/production-closure-status.md
git commit -m "feat(runner): dispatch desktop jobs through companion"
```

---

### Task 19: Implement native Windows Named Pipe identity and authenticated Companion server

**Execution status:** blocked on this host by `CargoUnavailable`. TypeScript framing tests may prepare this task but do not satisfy its native Gate.

**Files:**
- Create: `rust-toolchain.toml`
- Modify: `apps/companion/Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `apps/companion/src/ipc/security.rs`
- Modify: `apps/companion/src/ipc/server.rs`
- Create: `apps/companion/src/ipc/windows_pipe.rs`
- Modify: `apps/companion/src/ipc/mod.rs`
- Modify: `tests/rust/companion/ipc_acl.rs`
- Modify: `tests/rust/companion/handshake.rs`
- Create: `tests/rust/companion/windows_named_pipe.rs`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Replaces `NamedPipePeer`'s unconditional `Unsupported` result with verified `PeerIdentity`.
- Produces a local-only Windows Named Pipe listener with bounded framing/admission and authenticated session state.
- Keeps portable frame/security state tests intact.

- [ ] **Step 1: Add the Windows crate and only required Win32 features**

Create the deterministic toolchain file before adding dependencies:

```toml
[toolchain]
channel = "1.88.0"
components = ["rustfmt", "clippy"]
profile = "minimal"
```

If that compiler cannot build the resolved `windows` crate, capture the compiler error and update this exact pin to the minimum version that does; never use floating `stable` in CI.

From the workspace root, run:

```bash
cargo add --package companion windows --target 'cfg(windows)' --features Win32_Foundation,Win32_Security,Win32_Security_Authorization,Win32_Storage_FileSystem,Win32_System_IO,Win32_System_Pipes,Win32_System_RemoteDesktop,Win32_System_Threading
```

Let Cargo lock the resolved version. Add a Win32 feature later only at the first compiling call site that requires it; do not enable the complete feature set. Certificate-chain and Ed25519 challenge validation continue to use the existing portable cryptography dependencies unless a test proves a Windows API is required.

- [ ] **Step 2: Write Windows-only negative integration tests first**

With `#[cfg(windows)]`, assert remote clients, anonymous/network identities, another logon SID, wrong interactive session, wrong client PID/image/signature allowlist, invalid certificate proof, replayed challenge, and oversized frame are rejected before dispatch. A valid same-logon Runner reaches `handshake.accepted`.

- [ ] **Step 3: Create the pipe with a restrictive security descriptor**

Use `FILE_FLAG_FIRST_PIPE_INSTANCE`, overlapped I/O, and `PIPE_REJECT_REMOTE_CLIENTS`. Build an explicit DACL granting only the current logon SID and LocalSystem. Include the current logon SID in the pipe name. Do not rely on default inherited ACLs.

- [ ] **Step 4: Verify the connected process identity**

Use `GetNamedPipeClientProcessId`, open the process token, and compare user SID and interactive session ID. Validate image path and configured signature/allowlist. Return stable `CompanionIdentityRejected` without revealing the expected SID/path.

- [ ] **Step 5: Complete challenge-response before request admission**

After OS identity passes, issue one 256-bit nonce and validate the exact domain-separated challenge bytes already used by the portable handshake state. Check chain/expiry/client-auth EKU/fingerprint/runnerId. Mark each challenge one-time and expiring. Only then admit application requests.

- [ ] **Step 6: Verify and commit native transport**

Run on Windows 11:

```bash
cargo fmt --check
cargo build --workspace
cargo test --workspace
corepack pnpm vitest run tests/contract/desktop/named-pipe-client.test.ts
git diff --check
```

If not on Windows 11 with Cargo, stop and report `Windows11Unavailable` or `CargoUnavailable`; portable tests alone do not complete this task.

Commit:

```bash
git add rust-toolchain.toml apps/companion/Cargo.toml Cargo.lock apps/companion/src/ipc tests/rust/companion docs/production-closure-status.md
git commit -m "feat(companion): secure windows named pipe transport"
```

---

### Task 20: Implement native Windows UIA worker, Job Object host, and Companion daemon

**Execution status:** blocked on this host by `CargoUnavailable` and depends on Task 19. Do not replace native acceptance with fixtures.

**Files:**
- Modify: `apps/companion/Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `apps/companion/src/uia/worker.rs`
- Create: `apps/companion/src/uia/windows_worker_process.rs`
- Modify: `apps/companion/src/uia/worker_supervisor.rs`
- Modify: `apps/companion/src/process/job_object.rs`
- Modify: `apps/companion/src/process/app_session.rs`
- Modify: `apps/companion/src/tray.rs`
- Modify: `apps/companion/src/main.rs`
- Modify: `tests/rust/companion/uia_worker_protocol.rs`
- Modify: `tests/rust/companion/uia_action_timeout.rs`
- Modify: `tests/rust/companion/job_object_lifecycle.rs`
- Modify: `tests/rust/companion/reference_app_scenario.rs`
- Modify: `tests/component/windows-uia/reference-app-pipeline.test.ts`
- Modify: `docs/testing/windows-m3-manual-checklist.md`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Replaces `WindowsUiaCapture` and `WindowsDesktopProcessHost` error-only seams.
- Wires `companion --uia-worker` to the bounded worker protocol and default binary mode to the authenticated IPC daemon/tray.
- Keeps Companion as the only process that holds UIA, HWND/PID, Job Object, and local Permit state.

- [ ] **Step 1: Add native Reference App assertions before implementation**

Under `QUALIGENCE_WINDOWS_UIA_TEST=true`, build/run both WPF and WinUI fixtures and assert capture of Button/Edit/Password/List/Dialog, secret masking, AutomationId/Pattern/framework preservation, click/input/select/scroll/window actions, crash Finding signal, reset, and clean shutdown. Add forced worker hang/exit/corrupt-response cases.

- [ ] **Step 2: Implement the hidden MTA UIA worker**

Add only the native features required by this task:

```bash
cargo add --package companion windows --target 'cfg(windows)' --features Win32_System_Com,Win32_System_JobObjects,Win32_System_Threading,Win32_UI_Accessibility,Win32_UI_WindowsAndMessaging
```

Initialize COM MTA and `IUIAutomation` inside the child only. Capture from the verified session root window, enforce request deadline and node/property bounds, map through existing `uia::mapping`, and redact password values before serialization. Execute only the supported Invoke/Value/Selection/Scroll/Window patterns; unsupported pattern returns `UiaPatternUnsupported`.

- [ ] **Step 3: Implement real worker spawning and recycling**

Spawn the same binary with `--uia-worker`, connect bounded stdio framing, place the worker in its own kill-on-close Job, and implement `WorkerHandle`. Timeout/corruption/exit kills only that child. Capture timeout returns `TargetUnresponsive`; action timeout returns `ActionOutcomeUnknown` and is never automatically retried.

- [ ] **Step 4: Implement `WindowsDesktopProcessHost`**

Use `CreateProcessW` suspended, `CreateJobObjectW`, kill-on-close limits, `AssignProcessToJobObject`, then `ResumeThread` in that order. Record PID plus creation time. Shutdown terminates only verified Job members; never kill by image name. If a packaged/protected/elevated process cannot join, return `AppLifecycleUnsupported` or `UiaAccessDenied` without fallback.

- [ ] **Step 5: Wire daemon request dispatch and control UI**

Default `main` creates the authenticated pipe, Companion security core, AppSessionManager, UiaWorkerSupervisor, and tray/control channel. Route launch/reset/shutdown/capture/permit/action/pause/resume/stop/close. `action.execute` must call `Companion::authorize_action` and atomically consume the bound Permit before worker dispatch. Emergency Stop cancels the worker request and denies every subsequent action until a new explicit Session.

- [ ] **Step 6: Execute the Windows manual checklist**

Run elevated-target, lock screen, RDP/other session, approval allow/deny/timeout, emergency stop, unrelated same-name process, worker hang, secret log scan, and cleanup sections. Save evidence under `artifacts/manual-acceptance/<version>/<date>-windows-m3.md`. A failing security veto blocks Task 22 freeze.

- [ ] **Step 7: Verify and commit**

Run on Windows 11:

```bash
cargo fmt --check
cargo build --workspace
cargo test --workspace
corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts
corepack pnpm typecheck
git diff --check
```

Commit only when native tests and the non-veto portions of the checklist have real evidence:

```bash
git add apps/companion Cargo.lock tests/rust/companion tests/component/windows-uia docs/testing/windows-m3-manual-checklist.md docs/production-closure-status.md
git commit -m "feat(companion): run native windows desktop target"
```

---

### Task 21: Add real browser E2E, cross-platform CI, SBOM/provenance, and non-skippable release Gates

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/windows-companion.yml`
- Create: `.github/workflows/self-hosted.yml`
- Create: `.github/workflows/release.yml`
- Create: `scripts/verify-release-manifest.mjs`
- Create: `deployments/self-hosted/release-manifest.schema.json`
- Create: `deployments/self-hosted/compose/compose.release.yaml`
- Create: `tests/e2e/web-console/browser-workflow.test.ts`
- Modify: `tests/component/web-execution/playwright-web-target.test.ts`
- Modify: `tests/contract/kms-local/skill-signing.test.ts`
- Modify: `tests/component/local-launcher/start-stop.test.ts`
- Modify: `tests/component/skill-lifecycle/recording-to-replay.test.ts`
- Modify: `tests/helpers/docker-container.ts`
- Create: `apps/intelligence-worker/src/health-server.ts`
- Modify: `apps/intelligence-worker/src/config.ts`
- Modify: `apps/intelligence-worker/src/main.ts`
- Modify: `apps/intelligence-worker/src/index.ts`
- Create: `tests/component/intelligence-worker/worker-health.test.ts`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `README.md`
- Modify: `Dockerfile`
- Modify: `deployments/self-hosted/docker/entrypoint.sh`
- Modify: `deployments/self-hosted/docker/console.Dockerfile`
- Modify: `deployments/self-hosted/compose/compose.yaml`
- Modify: `deployments/self-hosted/compose/Caddyfile`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Produces root scripts `gate:fast`, `gate:linux`, `gate:windows`, `gate:self-hosted`, and `gate:release`; every script invokes tools through Corepack and missing infrastructure exits non-zero with a stable block code.
- Produces a browser-rendered Console E2E rather than a PublicApiClient-only test.
- CI jobs install and prove required dependencies instead of using availability-based skips.
- Removes all four Prerequisite Q `it.skipIf` declarations and exact Task 21
  quarantine markers; no release artifact is valid while one remains.

- [ ] **Step 1: Restore the four quarantined cross-platform tests**

Use TDD independently for each file: temporarily remove its `it.skipIf`, run the
named case on Windows to reproduce the original RED, implement only that case's
portable seam, rerun it GREEN on Windows, and then run the same case on Linux.

1. In `tests/component/local-launcher/start-stop.test.ts`, replace the 300 ms
   elapsed-time assertion with observable process lifecycle events from
   `ChildProcessUnit`: prove SIGTERM was requested, the grace timer expired,
   SIGKILL/forced termination was requested, and the child is no longer alive.
   Do not accept “process exited quickly on Windows” as proof of escalation.
2. In `tests/component/skill-lifecycle/recording-to-replay.test.ts`, put the
   reopened `SqliteRuntime` under deterministic `try/finally` ownership and
   `await runtime.close()` after replay assertions and on every thrown path.
   Prove `afterEach` can immediately delete the temporary directory on Windows.
3. In `tests/component/web-execution/playwright-web-target.test.ts`, replace
   `/proc` enumeration with a repository-owned adapter/process lifecycle seam
   available on Windows and Linux. Capture the launched browser identity through
   that seam, call `adapter.close()`, and prove the owned browser exits; do not
   scan or terminate unrelated system processes.
4. In `tests/contract/kms-local/skill-signing.test.ts`, retain the POSIX `0600`
   assertion on POSIX and add a Windows assertion that the key file's ACL grants
   read/write only to the current user plus required system/administrator
   principals and grants no broad Users/Everyone access. Put the platform probe
   behind a small test helper with a stable failure message; never make Windows
   key protection a no-op.

After each remediation, remove its adjacent marker and convert its declaration
back to ordinary `it(...)`. When all four are GREEN, run:

```bash
rg -n 'TODO\(Task 21\): remove this Windows quarantine' tests
corepack pnpm vitest run tests/component/local-launcher/start-stop.test.ts tests/component/skill-lifecycle/recording-to-replay.test.ts tests/component/web-execution/playwright-web-target.test.ts tests/contract/kms-local/skill-signing.test.ts
```

Expected: `rg` returns no matches and exits 1; all four cases execute rather
than skip. Update their status-ledger rows to `removal_state: complete` with
separate Windows and Linux command evidence. The full release Gate remains
blocked if either platform evidence is absent.

- [ ] **Step 2: Add a real Console browser workflow**

Build/serve the React app, run a test OIDC provider and real Fastify API, and drive Chromium through login callback, project/PRD, Mission start, Run status, Review concurrent conflict, Skill status, and Artifact authorization. Assert visible UI and navigation, not only network responses.

- [ ] **Step 3: Define explicit root Gates**

Use the filtered browser install command:

```bash
corepack pnpm --filter @qualigence/web-playwright exec playwright install chromium
```

`gate:fast` runs build/typecheck/pure unit/replay/migration/property/smoke. `gate:linux` adds Chromium/OpenSSL and Web E2E. `gate:windows` adds Windows Node tests plus `gate:companion`. `gate:self-hosted` requires Docker daemon and runs PostgreSQL/MinIO/Compose/backup/external Runner. `gate:release` validates downloaded Linux, Windows/Rust, Self-hosted, browser, SBOM, provenance, immutable image digest, and signed Windows manual-evidence records; it never converts a missing artifact/infrastructure item into success. On Windows, resolve Git OpenSSL explicitly from `C:\Program Files\Git\usr\bin\openssl.exe` when present and otherwise return `OpenSslUnavailable`.

- [ ] **Step 4: Add CI jobs with pinned setup**

Linux and Windows use Node 24, activate Corepack, assert pnpm `11.7.0`, and run a frozen install. Rust job installs the toolchain pinned by `rust-toolchain.toml` (created in Task 19) and runs fmt/build/test. Self-hosted job starts Docker dependencies. Cache pnpm/Cargo/Playwright by lock hashes. Pin every third-party GitHub Action to a full commit SHA and add a comment with the reviewed release tag. Upload JUnit/Gate reports and completed Windows manual-evidence records as artifacts; absence of signed manual evidence keeps M3 candidate.

- [ ] **Step 5: Harden release artifacts**

After `corepack pnpm build`, use `corepack pnpm deploy --prod` to create isolated deploy trees for Server, Intelligence Worker, and Admin CLI; copy only those trees plus the entrypoint into the runtime image. Do not copy the source workspace, pnpm store, test files, or root development `node_modules` into the runtime stage. Update `entrypoint.sh` to invoke the three deployed roots and add an image-contents test that rejects TypeScript/test/dev-only packages.

Use these exact deploy roots in the Docker build stage:

```bash
corepack pnpm --filter @qualigence/server deploy --prod /out/server
corepack pnpm --filter @qualigence/intelligence-worker deploy --prod /out/worker
corepack pnpm --filter @qualigence/admin-cli deploy --prod /out/admin
```

Set `injectWorkspacePackages: true` in `pnpm-workspace.yaml`, synchronize the lockfile with Corepack pnpm 11.7.0, and prove a subsequent frozen install before building the image. This is the only Task 21 lockfile change; do not fall back to copying the workspace.

The release workflow uses BuildKit with `--provenance=mode=max --sbom=true`, pushes the application and Console images, captures their `sha256:` digests from the build metadata, and emits a separate SPDX JSON file. Attest both image digest and SBOM with the repository's official artifact-attestation workflow. Generate `artifacts/release/<version>/release-manifest.json` conforming to the committed schema with: schema version, Git commit, repository, application digest, Console digest, SBOM path+SHA-256, provenance/attestation identifier, Gate artifact names+SHA-256, and Windows evidence path+SHA-256. `scripts/verify-release-manifest.mjs` rejects mutable tags, non-`sha256:` image references, missing files, digest mismatches, wrong commit, duplicate/missing Gate names, and unsigned Windows evidence. `compose.release.yaml` accepts only `${QUALIGENCE_APP_IMAGE}@${QUALIGENCE_APP_DIGEST}` and `${QUALIGENCE_CONSOLE_IMAGE}@${QUALIGENCE_CONSOLE_DIGEST}`; release documentation must not instruct operators to deploy a mutable tag.

Reuse Task 14's Server readiness route. Add a loop-owned Worker health server: live while the process event loop is serving, ready only after PostgreSQL queue/model configuration is constructed and until shutdown begins. Compose healthchecks must probe Server and Worker endpoints, Console static HTTP, and proxy `/health/ready`; proxy readiness must reverse-proxy Server readiness so it fails when Server is down. Add timeout/start-period/retry values and component tests that force each dependency unhealthy. Do not add a second Server health state machine here.

- [ ] **Step 6: Verify and commit**

Run `gate:fast` plus the current host's platform Gate before commit:

```bash
corepack pnpm gate:fast
# Linux executor: corepack pnpm gate:linux
# Windows executor: corepack pnpm gate:windows
git diff --check
```

The merge requires successful CI results from Linux, Windows/Rust, Self-hosted, and release-metadata validation jobs. Task 21 may be implemented before native/manual evidence exists, but its status remains `verification: blocked` and no release manifest is accepted until those artifacts are supplied.

Commit:

```bash
git add .github scripts/verify-release-manifest.mjs deployments/self-hosted apps/intelligence-worker/src tests package.json pnpm-workspace.yaml pnpm-lock.yaml README.md Dockerfile docs/production-closure-status.md
git commit -m "ci: enforce production release gates"
```

---

### Task 22: Correct implementation status and freeze Graph v1 only with evidence

**Files:**
- Modify: `docs/superpowers/implementation-status.md`
- Modify: `docs/superpowers/plans/2026-08-01-ls-02-m1-playwright-web-target.md`
- Modify: `docs/superpowers/plans/2026-08-01-ls-05-m1-core-runner-transport-hardening.md`
- Modify: `docs/superpowers/plans/2026-08-01-ls-11-m2-self-hosted-runtime-deployment.md`
- Modify: `docs/superpowers/plans/2026-08-01-ls-13-m3-windows-desktop-target.md`
- Modify: `docs/superpowers/roadmaps/2026-08-01-local-self-hosted-through-m3.md`
- Modify: `docs/testing/observation-graph-v1-freeze-checklist.md`
- Modify: `docs/testing/windows-m3-manual-checklist.md`
- Modify: `README.md`
- Modify: `docs/production-closure-status.md`
- Modify: `packages/observation-migration/src/freeze-gate.ts`
- Modify: `tests/migration/observation-v1/freeze-decision.test.ts`
- Modify: `tests/migration/observation-v1/freeze-gate-report.test.ts`

**Interfaces:**
- Produces three independent status dimensions for every capability: `component`, `production_wiring`, and `verification`.
- Keeps Graph lifecycle `candidate | frozen`; the decision remains deterministic from evidence inputs.

- [ ] **Step 1: Add an evidence-backed status table**

For Admin CLI, Local Core/Runner, Self-hosted API, Worker consumer, Runner data plane, Review, OIDC, Graph v1, and Windows Companion, record:

```text
component: missing | partial | complete
production_wiring: missing | partial | complete
verification: not_run | blocked | failed | passed
evidence: exact test/Gate/artifact paths
```

Do not use `implemented` as a terminal status. Every `passed` row must cite a current command result or committed signed artifact.

- [ ] **Step 2: Reconcile old LS documents**

Add a dated `Implementation delta (2026-08-16)` section to each exact historical plan listed in **Files**. Mark historical step lists as design history where their create/modify instructions no longer match the tree. Correct LS-02 Playwright status, LS-05 independent-process status, LS-11 full-loop status, and LS-13 native-boundary status. Preserve original design decisions and text; do not rewrite prior decisions invisibly.

- [ ] **Step 3: Evaluate the freeze decision with real inputs**

Feed candidate migration report, signed Windows checklist evidence, and Web/Desktop schema conformance evidence to `decideGraphFreeze`. Add a test reading the serialized evidence records. Missing signature, any security veto, unexplained migration failure, or schema mismatch must produce `candidate` plus a concrete blocking reason.

- [ ] **Step 4: Freeze only after all conditions pass**

When and only when the evidence set is valid, write the frozen decision artifact, update the checklist, and change public documentation to Graph v1 frozen. Do not change historical pre-v1 payloads; keep their immutable projection/provenance and recompiled Skill records.

- [ ] **Step 5: Run the final release evidence set**

Run host-appropriate verification and validate the cross-platform artifacts rather than pretending one host executed every platform:

```bash
corepack pnpm gate:fast
corepack pnpm gate:self-hosted
corepack pnpm benchmark:detection
corepack pnpm gate:release -- --manifest artifacts/release/<version>/release-manifest.json
git diff --check
```

The release manifest must reference successful CI artifacts named `gate-linux`, `gate-windows-rust`, `gate-self-hosted`, and `browser-e2e`, plus the signed Windows 11 manual acceptance record. Recompute each artifact SHA-256 before the freeze decision. If any command/evidence is absent, document the exact blocked dimension and leave the milestone and Graph state open/candidate.

- [ ] **Step 6: Verify and commit documentation**

```bash
git add docs README.md packages/observation-migration/src/freeze-gate.ts tests/migration/observation-v1
git commit -m "docs: report production closure with evidence"
```

---

## Terra execution protocol

Terra or any other implementation agent must execute exactly one pending Task per fresh context. The PR5 stacked PRs are the sole exception: one fresh context executes one stacked PR from `docs/superpowers/plans/2026-08-17-pr5-protocol-authority-refactor.md`. Production Core may require `application` and `authenticator` only in PR5-R5. Before editing it must:

1. read this plan's **Status and authority**, **Global Constraints**, the chosen Task's complete **Files/Interfaces/Steps**, and the architecture sections cited by that Task;
2. read every file in the Task's **Files** block plus the nearest existing provider/composition analogue named in the steps;
3. verify `git status`, confirm prior dependency commits are present, run `node --version` and `corepack pnpm --version`, and refuse a shared/junctioned `node_modules` worktree;
4. mark the Task `already implemented`, `ready`, or `environmentally blocked` from evidence before changing code;
5. observe the focused RED (or the explicitly documented blocked baseline for verification-only Task 4), implement the smallest coherent module, run focused GREEN + typecheck + `git diff --check`, update the committed status ledger, and make one commit; each PR5 stacked PR observes its own RED and commits only its Files subset; PR5-R5 observes both Task REDs and makes the activation commit only after the joint Gate passes;
6. request a Standards review and a Spec review against this exact plan Task before the next dependent Task begins; each PR5 stacked PR reviews its subset; PR5-R5 reviews the union of Tasks 8-9 against both Task bodies.

For low-cost workers, the coordinator should disclose only this document's authority/constraints, current execution table, dependency order, and the selected Task body. Later Task bodies are post-completion context and should remain outside that worker's context; the coordinator/reviewer owns cross-task sequencing and updates this single source-of-truth plan when a dependency changes.

The worker must not silently expand its file scope. If compilation reveals a necessary file absent from **Files**, it stops, reports the exact import/type reason, and updates this plan only after review approval. It must not weaken a required type, make a security field optional, add a fake provider to a production Composition Root, or turn a missing Docker/Chromium/OpenSSL/Cargo/Windows Gate into a skip.

For each Task, the executing worker must return this compact handoff before a reviewer starts the next Task:

```text
Task:
Files changed:
New/changed public interfaces:
Focused failing test observed before implementation:
Focused tests after implementation:
Typecheck result:
Environmental blocks:
Status-ledger row/evidence added:
Security invariants rechecked:
Commit:
Residual risks:
```

The reviewer rejects the Task if the worker did not observe a relevant failure first, edited outside the task file list without approval, weakened a fail-closed path, omitted the committed evidence update, or reported a skipped environmental Gate as passed. Any `REQUEST CHANGES` finding must receive its own RED/GREEN fix commit and a full two-axis re-review; it is not enough to state that the reviewer was acknowledged.

## Final product acceptance

The temporary plan is complete only when all of the following are evidenced:

1. Admin operations execute from the built binary and fail closed.
2. Windows and POSIX Node binaries invoke their main functions.
3. Local Launcher starts real Core/Runner, accepts a run, persists Trace/Finding, and shuts down cleanly.
4. Core is authoritative for session, resume, ownership, renew, Trace ACK, and completion across restart.
5. Self-hosted Public API, Worker Result consumer, external Runner gRPC, PostgreSQL/S3/KMS/OIDC, backup/restore, and Console form one live loop.
6. Review and Skill mutations use deterministic aggregate/application rules.
7. Web Console verifies ID Token signatures and a real browser workflow passes.
8. Runner renews leases and enforces an explicit immutable policy snapshot.
9. Web executes bounded multi-step plans with re-observation, deterministic budgets, and valueRef-only secret handling; it is not limited to one click.
10. Web and Windows emit/consume the same Observation Graph v1 schema.
11. Windows Named Pipe/UIA/Job Object/Companion paths are native, not synthetic, and have signed Windows 11 evidence.
12. CI makes Linux, Windows/Rust, and Self-hosted failures visible and non-skippable and emits verified SBOM/provenance/digest release metadata.
13. Documentation reports component, wiring, and verification status separately; Graph v1 remains candidate until all freeze evidence passes.

## Plan self-review checklist

- [x] Every current production gap listed in the baseline maps to a numbered Task.
- [x] Every Task names exact files, interfaces, failing behavior, verification commands, stop conditions, and commit scope.
- [x] Public type names used by dependent Tasks are identical to the producing Task.
- [x] Local and Self-hosted reuse Runner lifecycle semantics rather than forking them.
- [x] No Task treats a test fake, synthetic UIA source, or open TCP port as production evidence.
- [x] No Task expands Cloud/Mobile/macOS/Linux Desktop scope.
- [x] Native Windows and Graph freeze claims require their explicit external evidence.
- [x] The Runner protocol/application port and persistence port live in a neutral leaf package; no `core-application ↔ postgres-runtime` cycle is introduced.
- [x] Direct Server/Console Public API paths use the existing `/v1` contract; `/api` remains only a reverse-proxy concern.
- [x] Policy, Desktop Target, and AppTarget fields have explicit protobuf mapper/round-trip tasks, so transport cannot silently drop additive fields.
- [x] Review and Runner-control local/external providers run shared contracts with real independent PostgreSQL transactions.
- [x] Existing multi-step Mission plans reach a bounded Web execution loop with model/step/wall budgets and valueRef-only input handling.
- [x] Every pending Task can update the committed production status ledger without leaving its declared file scope.
