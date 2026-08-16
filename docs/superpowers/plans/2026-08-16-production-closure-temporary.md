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

## Global Constraints

- Use Node.js 24 and exactly `corepack pnpm --version` = `11.7.0`. Do not use an ambient/fallback `pnpm` binary.
- In a fresh worktree run `corepack pnpm install --frozen-lockfile`. If a trusted registry is unavailable, `corepack pnpm install --offline --frozen-lockfile` is permitted only when the pnpm store already contains every locked package. Do not regenerate the lockfile except in a task that explicitly adds a dependency or the separately reviewed P0 lock-consistency repair below.
- Preserve strict TypeScript settings and project references; no `any`, unsafe double assertions, or domain imports from Fastify/gRPC/Playwright/Win32 adapters.
- Models only produce proposals/results. Deterministic code owns authorization, budgets, state transitions, IDs, persistence, and idempotency.
- Do not weaken mTLS, OIDC, RLS, Named Pipe identity, Permit binding, Trace hashes, or expected-version checks to make a test pass.
- Do not modify historical migration files 001-005. New relational state uses migration 006 or later.
- Do not silently skip a required Gate. Report an explicit environmental block such as `ChromiumUnavailable`, `OpenSslUnavailable`, `DockerUnavailable`, `CargoUnavailable`, or `Windows11Unavailable`.
- Every implementation task begins with a failing focused test, ends with its focused tests plus `corepack pnpm typecheck`, and is committed separately. A verification-only closure task must capture the pre-existing incomplete Gate as RED/blocked evidence and must not invent a source change merely to create a diff.
- A Terra worker executes one task per fresh context. It must read every file in the task's **Files** block before editing and must not edit files outside that block without stopping for review.
- At the end of every task, update `docs/production-closure-status.md` in the same task commit with `component`, `production_wiring`, `verification`, exact command, date, and commit. Never use the ignored SDD ledger as the only completion evidence.
- Preserve unrelated user changes. Never reset, checkout, or overwrite a dirty file to match this plan.
- Do not claim Windows native completion from synthetic fixtures. Native Tasks 19-20 require Windows 11, Cargo, and the explicit Windows integration flag.
- Do not return Graph v1 status `frozen` without signed `WindowsChecklistEvidence` and passing Web/Desktop schema conformance evidence.

## Current execution state (2026-08-16)

| Task | State | Evidence and required next action |
|---|---|---|
| P0 Frozen lock consistency | complete and verified | Frozen install RED proved a missing Vite 8.1.5 peer snapshot; the exact lock-only repair passes frozen install with no manifest change. |
| 1 Admin CLI | complete and verified | Commit `f200d6d`; Task 4 clean-worktree built-binary verification passed for help, unknown command, command parsing, and fail-closed KMS behavior. |
| 2 Node entrypoints | complete and verified | Commit `603439b`; Task 4 passed all seven direct-entrypoint smoke cases and the Local Launcher E2E in a clean install. |
| 3 Review routes | complete and reviewed | Commits `3071da0` + `fd788df`; PostgreSQL route/component tests passed with Docker, and the public `actualVersion` conflict contract was restored. Task 5 now adds provider parity and two-writer contract evidence. |
| 4 Gate/status closure | complete | A clean detached worktree passed frozen install, build, typecheck, and 4 focused black-box files / 17 tests. `docs/production-closure-status.md` records the repeatable evidence and the remaining root Playwright CLI defect. |
| 5 Review provider contract | complete after PR review | One provider-neutral contract plus SQLite failure injection passed against both adapters (28 tests), including simultaneous replay, cross-task idempotency-key competition, audit rollback, and real two-transaction PostgreSQL claims; the focused regression set passes 56 tests. |
| 6 OIDC signature verification | complete | The explicit local HTTP proxy restored the trusted TLS registry path; `jose` 6.2.9 is locked. Real RS256/JWKS tests reject tampering, unknown keys, disallowed algorithms, wrong claims, expiry, and unavailable JWKS before claim mapping. |
| 7-18 | pending | Proceed in the dependency order below; Task 6 no longer blocks the dependent Console release Gate. |
| 19-20 Windows native | blocked | Cargo is absent. Windows 11 is present but portable TypeScript/Rust planning is not native completion. |
| 21-22 CI/docs | pending | Task 21 release completion now waits for Tasks 19-20 plus all platform CI artifacts; its Task 6 dependency is complete. |

## Current verified baseline

- Docker 29.6.1 and Chromium are available on the current Windows host.
- Git's OpenSSL exists at `C:\Program Files\Git\usr\bin\openssl.exe` but is not on `PATH`; Gates must resolve it explicitly or report `OpenSslUnavailable`.
- Cargo is not installed, so native Companion Tasks 19-20 cannot be completed on this host yet.
- The lockfile is synchronized through Task 6. The trusted registry was reachable through the explicit local HTTP proxy without disabling TLS; `jose` 6.2.9 is a direct Web Console dependency.
- Clean-worktree build and typecheck pass. Task 4's Admin CLI, seven-entrypoint, Local Launcher, and observation-admin focused Gate passes 17 tests without skips; broader release Gates remain separate tasks.
- `apps/admin-cli/src/main.ts` parses `argv` and Doctor awaits KMS; clean built-binary black-box verification is recorded in `docs/production-closure-status.md`.
- `apps/core-daemon/src/main.ts` only starts `GrpcRunnerProtocolServer`; it does not wire `RunnerSessionService`, `ExecutionJobService`, `RunOwnershipService`, durable Trace, or request intake.
- The gRPC server keeps an in-memory Trace cursor, ignores `complete_execution`, and reissues leases without authoritative ownership validation.
- Runner accepts and executes leases but has no renew loop; its production policy gate always returns allowed.
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

```text
Tasks 1-3 (already implemented)
    ├── Task 4 (close entrypoint Gates + create committed status ledger)
    ├── Task 5 (Review provider/concurrency contract)
    ├── Task 6 (Console ID Token verification; complete)
    └── Task 7 (Runner renew)

Task 8 (gRPC application port)
    → Task 9 (Core protocol application)
    ├── Task 10 (durable Core control state through neutral runner-control port)
    └── Task 15 (deterministic execution policy; must precede production dispatch)

Task 10
    → Task 11 (Local API + Launcher independent loop)

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

The 22 implementation tasks plus the P0 build prerequisite ship as 18
reviewable pull requests. A pull request
may contain more than one task only where the tasks form one architectural
boundary or one evidence-producing release unit. Every task still has its own
commit, focused RED/GREEN evidence, status-ledger update, and completion marker.

PRs are stacked in the order below. A stacked PR targets the immediately
preceding PR branch until that PR merges; then its base is updated to `main`
without rewriting already-reviewed task commits. Critical or Important findings
from either the Standards review or the Spec/architecture review block pushing
or merging. No PR may claim a production Gate from a skipped dependency.

| PR | Tasks | Branch | Initial base | Review unit | State |
|---|---:|---|---|---|---|
| 0 | P0 | `codex/pr0-lockfile-repair` | `main` | Frozen-lock consistency only: no manifest, runtime, or product behavior changes | ready for review |
| 1 | 1, 2, 4 | `codex/pr1-runtime-ops` | `codex/pr0-lockfile-repair` | Admin CLI execution, cross-platform binary entrypoints, and their clean black-box Gate | ready for review |
| 2 | 3, 5 | `codex/pr2-review-invariants` | `codex/pr1-runtime-ops` | Review aggregate routing plus SQLite/PostgreSQL provider and writer-concurrency parity | ready for review |
| 3 | 6 | `codex/pr3-console-oidc` | `codex/pr2-review-invariants` | Browser ID Token signature verification and transient-state security | ready for review |
| 4 | 7 | `codex/pr4-runner-renewal` | `main` | Lease renewal and stop-before-expiry behavior | pending |
| 5 | 8, 9 | `codex/pr5-core-protocol-application` | `main` | gRPC application port and the Core lifecycle composition behind it | pending |
| 6 | 10 | `codex/pr6-runner-control-persistence` | `main` | Durable sessions, leases, resume tokens, Trace acknowledgements, and completion | pending |
| 7 | 11 | `codex/pr7-local-run-intake` | `main` | Authenticated Local intake and Launcher/Runner registration proof | pending |
| 8 | 12 | `codex/pr8-self-hosted-resources` | `main` | Mission, Run, Trace, and Skill public resources | pending |
| 9 | 13 | `codex/pr9-intelligence-consumer` | `main` | Production Intelligence Result Inbox consumer | pending |
| 10 | 14 | `codex/pr10-self-hosted-runner-data-plane` | `main` | External Runner gRPC data plane and full Compose loop | pending |
| 11 | 15 | `codex/pr11-execution-policy` | `main` | Immutable deterministic Job policy snapshot | pending |
| 12 | 16 | `codex/pr12-multistep-web` | `main` | Bounded multi-step Web execution and safe `valueRef` resolution | pending |
| 13 | 17 | `codex/pr13-observation-graph-v1` | `main` | Live Graph v1 producer/consumer migration | pending |
| 14 | 18 | `codex/pr14-desktop-runner-client` | `main` | Desktop Target dispatch and TypeScript Named Pipe client | pending |
| 15 | 19 | `codex/pr15-windows-pipe-server` | `main` | Native Named Pipe identity and authenticated Companion server | blocked by `CargoUnavailable` |
| 16 | 20 | `codex/pr16-windows-uia-daemon` | `main` | Native UIA worker, Job Object host, and Companion daemon | blocked by PR 15 and `CargoUnavailable` |
| 17 | 21, 22 | `codex/pr17-release-closure` | `main` | Cross-platform release evidence, CI/SBOM/provenance, documentation reconciliation, and evidence-gated Graph freeze | pending |

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

---

### Prerequisite P0: Restore the frozen lock graph

**Execution status:** complete. This is an independently reviewable build
prerequisite, not part of Task 4 and not authority for future lock regeneration.

**Files:**
- Modify: `pnpm-lock.yaml`
- Modify: `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`

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

Commit the lock repair separately from Tasks 1, 2, and 4. PR 1 must target the
P0 branch so its three-dot diff contains no lockfile repair.

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

**Files:**
- Create: `docs/production-closure-status.md`
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

Required: Node major `24`, pnpm exactly `11.7.0`, and a successful frozen install. If the trusted registry is unavailable, retry once with `corepack pnpm install --offline --frozen-lockfile`; if the store is incomplete, stop and record `RegistryUnavailable`. Do not change registry trust, disable TLS verification, regenerate the lock, or reuse the known temporary dependency junction. A frozen-lock inconsistency belongs to P0 and blocks Task 4; Task 4 must not repair it.

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

**Execution status:** complete after PR review remediation. One provider-neutral contract now passes against SQLite and PostgreSQL, and its concurrent PostgreSQL case runs two independent tenant transactions. SQLite reserves the audit key before compare-and-set inside one transaction, replays simultaneous copies from the durable ledger, rejects cross-task key competition, and rolls the aggregate back when audit insertion fails, without changing the production repository port.

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
10. Two simultaneous copies of the same claim or resolution command/key both return the one applied aggregate and increment only once.
11. Concurrent reuse of one claim or resolution idempotency key across different tasks advances exactly one task and binds the audit to that winner.
12. SQLite-only failure injection makes claim/resolution audit insertion fail and proves that the matching aggregate transition is rolled back.

Use `ClaimReviewTaskHandler` and `ResolveReviewTaskHandler` for cases that assert public domain errors. Read the final row in a new callback after both concurrent transactions have settled. Do not serialize the race with a test mutex or reuse the same PostgreSQL transaction.

- [x] **Step 3: Prove both current implementations fail the same contract where they diverge**

Run:

```bash
corepack pnpm vitest run tests/contract/review/sqlite-review-task-repository.test.ts tests/contract/review/postgres-review-task-repository.test.ts
```

Expected RED: at minimum, the SQLite implementation treats an idempotency key previously bound to another task as a successful replay. Any PostgreSQL race/audit failure must remain a real failure; do not add retries to the contract.

- [x] **Step 4: Align both adapters without moving domain rules into storage**

For both `claim` and `resolve`, reserve the idempotency ledger key before the conditional aggregate write. If the reservation already exists, compare its stored `task_id` with `command.taskId`; replay the stored task only on a match and return `undefined` on mismatch. If compare-and-set fails after a new reservation, delete that reservation before commit. Preserve conditional writes over task ID + allowed status + expected version (+ assignee for resolve), tenant scoping, and same-transaction audit writes. SQLite may make one bounded retry after `SQLITE_BUSY` so the lock holder can commit and the retry can read its durable ledger; it must map a repeated busy error to `StorageBusy` and must never retry indefinitely. Do not catch unique violations and report success unless the stored ledger row proves it is the same command/task replay.

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

**Execution status:** complete. The trusted registry was reached through the user-provided local HTTP proxy without disabling TLS. `jose` 6.2.9 is locked, focused cryptographic tests pass, and both Web Console and root typechecks pass.

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

### Task 8: Replace gRPC's in-memory lifecycle semantics with an application port

**Files:**
- Create: `packages/core-modules/runner-control/package.json`
- Create: `packages/core-modules/runner-control/tsconfig.json`
- Create: `packages/core-modules/runner-control/src/runner-protocol-application.ts`
- Create: `packages/core-modules/runner-control/src/index.ts`
- Modify: `tsconfig.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/package.json`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/tsconfig.json`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/ports.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/server.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/index.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/mappers.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/tls-runner-identity.ts`
- Modify: `tests/helpers/grpc-harness.ts`
- Modify: `tests/conformance/runner-protocol/grpc-round-trip.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-tls.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-mappers.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Produces a required `RunnerProtocolApplication` dependency for `GrpcRunnerProtocolServer` from the neutral leaf package `@qualigence/runner-control`; the gRPC adapter depends inward on this port.
- Keeps `RunnerConnectionPort` and `RunnerClientPort` public signatures unchanged.
- Removes lease issuance, resume-token authority, Trace cursor authority, and completion authority from the transport adapter.

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

- [ ] **Step 6: Verify and commit**

Run:

```bash
corepack pnpm vitest run tests/conformance/runner-protocol/grpc-mappers.test.ts tests/conformance/runner-protocol/grpc-round-trip.test.ts tests/conformance/runner-protocol/grpc-tls.test.ts
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add packages/core-modules/runner-control packages/protocol-adapters/grpc-runner-protocol tsconfig.json pnpm-lock.yaml tests/helpers/grpc-harness.ts tests/conformance/runner-protocol docs/production-closure-status.md
git commit -m "refactor(protocol): delegate runner lifecycle to core"
```

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

Move the four transport-independent services listed in **Files** into `@qualigence/core-application`, preserve their public signatures/tests, and export them from the package root. They may depend on contracts, evidence/Trace ports, shared-kernel primitives, and `@qualigence/runner-control`; they must not import Core Daemon, Server, Fastify, gRPC, SQLite, or PostgreSQL concrete classes. Core Daemon retains only process configuration and provider composition. This is the same seam Task 14 must instantiate for Self-hosted mode; Task 14 must not import `apps/core-daemon` or copy these services.

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

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm vitest run tests/unit/core-daemon tests/conformance/runner-protocol tests/component/core-runner/core-composition.test.ts tests/component/core-runner/independent-process.test.ts
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add packages/core-application apps/core-daemon pnpm-lock.yaml tests/helpers/core-runner-harness.ts tests/component/core-runner/core-composition.test.ts tests/component/core-runner/independent-process.test.ts docs/production-closure-status.md
git commit -m "feat(core): compose authoritative runner protocol"
```

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

**Files:**
- Create: `apps/core-daemon/src/local/local-session-service.ts`
- Create: `apps/core-daemon/src/local/local-http-server.ts`
- Create: `apps/core-daemon/src/local/local-run-coordinator.ts`
- Modify: `packages/core-application/src/runner/core-runner-protocol-application.ts`
- Modify: `apps/core-daemon/src/main.ts`
- Modify: `apps/core-daemon/src/config.ts`
- Modify: `apps/local-launcher/src/main.ts`
- Modify: `apps/local-launcher/src/health-client.ts`
- Modify: `apps/local-launcher/src/runtime-state.ts`
- Modify: `packages/contracts/local-control/src/health.ts`
- Modify: `tests/e2e/local-launcher.test.ts`
- Modify: `tests/component/core-runner/independent-process.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Produces `POST /api/v1/local/session`, `POST /api/v1/local/runs`, `GET /api/v1/local/runs/:runId`, `/health/live`, and `/health/ready` on loopback only.
- Produces one-time bootstrap-token exchange and hashed short-lived local session tokens.
- Consumes `GrpcRunnerProtocolServer.waitForConnection(runnerId)` and the persistent run/Trace stores.
- Produces a completion callback that updates the same persisted Run created by the Local intake path.

- [ ] **Step 1: Add a failing true-process E2E**

Run real built Core and Runner processes, not `fake-process.mjs`. Assert Launcher:

1. generates bootstrap material before Core starts;
2. waits for Core readiness and then the configured Runner registration;
3. outputs the bootstrap token exactly once;
4. exchanges it for a local session;
5. submits a Web run and observes a terminal Run plus persisted Trace/Finding;
6. stops Runner before Core and leaves no child processes.

Use the local OpenAI-compatible mock server and real Chromium. If Chromium is absent, fail with `ChromiumUnavailable` rather than falling back to fake processes.

- [ ] **Step 2: Implement one-time bootstrap exchange**

Launcher creates 32 random bytes, writes the raw token to a restrictive temporary file under the data directory, passes `CORE_BOOTSTRAP_TOKEN_FILE`, and prints the token once. Core reads and deletes that file at startup, stores only SHA-256 plus consumed state, and exposes:

```text
POST /api/v1/local/session
Authorization: Bearer <bootstrap-token>
→ 201 { sessionToken, expiresAt }
```

Consume with constant-time hash comparison. Store only the session-token hash. A second exchange returns 401. Bind HTTP to `127.0.0.1`; reject non-loopback host configuration in Local mode.

- [ ] **Step 3: Implement Local run coordination**

`POST /api/v1/local/runs` accepts a schema-validated `{ targetUrl, objective }`, creates runId/jobId in deterministic code, inserts an `execution_runs` row, waits for the configured runner connection, and calls `connection.offer(job, ["target:web-playwright"])`. Return 202 with runId after accept; completion remains asynchronous. `GET` reads Run status and evidence refs from SQLite.

Inject the following port into `CoreRunnerProtocolApplication` and call it only after `ExecutionJobService.complete` has authoritatively accepted the completion:

```ts
export interface RunCompletionSink {
  complete(input: {
    jobId: string;
    runId: string;
    completion: ExecutionCompletion;
  }): Promise<void>;
}
```

`LocalRunCoordinator` implements this port with `SqliteRunStore` plus the Task 10 completion record. Duplicate `complete_execution` messages return the stored terminal result and do not append another terminal event or Finding. A sink failure keeps the completion inbox retryable and prevents the Run from being reported terminal.

Do not run a model or Playwright in Core. Do not use `RunnerBackedRunResourceFactory` unless its `RemoteRunnerTarget` has a real protocol implementation; the current Runner executes the full fixed pipeline after accepting an offer.

- [ ] **Step 4: Make readiness truthful**

`/health/live` checks only process/event-loop liveness. `/health/ready` checks SQLite schema/writeability, gRPC bind, and configured Runner registration. Launcher must wait for ready and must never treat an open TCP port alone as Runner-ready.

- [ ] **Step 5: Preserve tokens in runtime state safely**

Do not store raw bootstrap or session tokens in `runtime-state.json`, logs, YAML, or SQLite. Runtime state may store Core HTTP port, Core gRPC port, PIDs, runnerId, and non-secret expiry/status metadata.

- [ ] **Step 6: Verify and commit**

Run:

```bash
corepack pnpm build
corepack pnpm vitest run tests/component/core-runner/independent-process.test.ts tests/e2e/local-launcher.test.ts
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add apps/core-daemon/src/local apps/core-daemon/src/main.ts apps/core-daemon/src/config.ts apps/local-launcher/src packages/contracts/local-control/src/health.ts tests/component/core-runner/independent-process.test.ts tests/e2e/local-launcher.test.ts docs/production-closure-status.md
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

**Files:**
- Modify: `packages/contracts/runner-protocol/src/index.ts`
- Modify: `packages/contracts/runner-protocol/src/messages.ts`
- Modify: `packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/mappers.ts`
- Modify: `packages/protocol-adapters/grpc-runner-protocol/src/wire-codec.ts`
- Modify: `packages/runner-kernel/src/execution-runtime.ts`
- Create: `packages/runner-kernel/src/deterministic-policy-gate.ts`
- Modify: `packages/runner-kernel/src/index.ts`
- Modify: `apps/runner/src/main.ts`
- Modify: `packages/core-application/src/runner/core-runner-protocol-application.ts`
- Modify: `apps/cli/src/local-run-composition-root.ts`
- Modify: `packages/core-modules/mission/src/exploration-policy.ts`
- Modify: `tests/type/runner-protocol-v1.types.ts`
- Modify: `tests/conformance/runner-protocol/accepted-execution-job-plan.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-mappers.test.ts`
- Modify: `tests/conformance/runner-protocol/grpc-round-trip.test.ts`
- Modify: `tests/conformance/runner-protocol/proto-schema.test.ts`
- Modify: `tests/helpers/core-runner-harness.ts`
- Modify: `tests/unit/core-daemon/execution-job-service.test.ts`
- Modify: `tests/unit/core-daemon/run-ownership-service.test.ts`
- Modify: `tests/unit/runner/job-executor.test.ts`
- Modify: `tests/component/core-runner/disconnect-recovery.test.ts`
- Modify: `tests/component/core-runner/independent-process.test.ts`
- Modify: `tests/component/prd-planning/prd-to-run.test.ts`
- Modify: `tests/contract/sqlite/prd-mission-store.test.ts`
- Create: `tests/unit/runner-kernel/deterministic-policy-gate.test.ts`
- Modify: `tests/unit/runner-kernel/execution-runtime.test.ts`
- Modify: `tests/e2e/cli-web-cart.test.ts`
- Modify: `docs/production-closure-status.md`

**Interfaces:**
- Produces required `AcceptedExecutionJob.policy: ExecutionPolicySnapshot`.
- Produces `DeterministicRunnerPolicyGate implements RunnerPolicyGate`.
- Removes `AllowSameOriginPolicyGate` and `LocalAllowAllPolicyGate` from production composition roots.

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

Make it required on new `AcceptedExecutionJob` values and update every constructor/fixture listed in **Files**. Add explicit protobuf fields for every policy value and lossless `toWire`/`fromWire` mapper assertions; do not serialize the snapshot as unconstrained JSON. Historical serialized Jobs may be upcast only at a storage boundary with an explicit `legacy-m1-local` isolated-test policy; production network payloads without policy fail with `PolicyMissing`.

Before implementation, run `rg -n "AcceptedExecutionJob|jobId:|policy:" apps packages tests` and compare every constructing call site with the **Files** block. If a constructor is outside the block, stop and add the exact path to this plan before editing; do not make `policy` optional to reduce the migration surface.

- [ ] **Step 2: Add a policy matrix before implementation**

Test expired policy, cross-origin navigation, origin mismatch, action-kind mismatch, risk above ceiling, production exploration, production coordinate/visual fallback, and a valid isolated same-origin click. A denial must prevent `ExecutionPermit` construction and action executor invocation.

- [ ] **Step 3: Implement deterministic authorization**

The gate receives the immutable Job policy at construction and checks in this order: expiry, environment, target origin, action kind, action risk, fallback resolution. Compare risk using the fixed order `Normal < ExternalSideEffect < Destructive < ProductionForbidden`. `ProductionForbidden` is never allowed even if maximumRisk is malformed or equal. Return stable reason codes in safe messages.

- [ ] **Step 4: Construct policy in Core/CLI, enforce in Runner**

Core derives the snapshot from approved Mission/exploration policy and target. Local CLI constructs an explicit isolated-test policy limited to the target URL origin and the action kinds it supports. Runner instantiates `DeterministicRunnerPolicyGate(offer.job.policy)`; it does not widen the policy from local configuration.

- [ ] **Step 5: Verify and commit**

Run:

```bash
corepack pnpm vitest run tests/unit/runner-kernel/deterministic-policy-gate.test.ts tests/unit/runner-kernel/execution-runtime.test.ts tests/e2e/cli-web-cart.test.ts
corepack pnpm typecheck
git diff --check
```

Commit:

```bash
git add packages/contracts/runner-protocol packages/protocol-adapters/grpc-runner-protocol/src packages/runner-kernel apps/runner/src/main.ts packages/core-application/src/runner/core-runner-protocol-application.ts apps/cli/src/local-run-composition-root.ts packages/core-modules/mission/src/exploration-policy.ts tests docs/production-closure-status.md
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

- [ ] **Step 1: Fix the five known cross-platform tests**

Replace `/proc` browser-process inspection with Playwright/process APIs available on Windows and Linux; assert key-file ACL/mode per platform; use scoped process termination assertions on Windows; close every reopened SQLite handle before temp cleanup; use event-driven launcher shutdown waits. Keep the security intent of each test.

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

Terra or any other implementation agent must execute exactly one pending Task per fresh context. Before editing it must:

1. read this plan's **Status and authority**, **Global Constraints**, the chosen Task's complete **Files/Interfaces/Steps**, and the architecture sections cited by that Task;
2. read every file in the Task's **Files** block plus the nearest existing provider/composition analogue named in the steps;
3. verify `git status`, confirm prior dependency commits are present, run `node --version` and `corepack pnpm --version`, and refuse a shared/junctioned `node_modules` worktree;
4. mark the Task `already implemented`, `ready`, or `environmentally blocked` from evidence before changing code;
5. observe the focused RED (or the explicitly documented blocked baseline for verification-only Task 4), implement the smallest coherent module, run focused GREEN + typecheck + `git diff --check`, update the committed status ledger, and make one commit;
6. request a Standards review and a Spec review against this exact plan Task before the next dependent Task begins.

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
