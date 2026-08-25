# 10 — Persist Self-hosted Run, Trace, and completion

**What to build:** Store Self-hosted Runs and Trace through provider-neutral PostgreSQL adapters and atomically apply accepted Runner completion to Run, attempt, logical Job, and Mission.

**Blocked by:** 09 — Resolve tenant-bound Runner applications.

**Status:** claimed

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [ ] PostgreSQL Run/Trace/Finding-reference behavior matches SQLite contracts under forced RLS.
- [ ] Completion requires exact tenant/project/run/logical-job/attempt/Runner-job/hash provenance.
- [ ] Canonical duplicate is stable; conflicting or nonvisible provenance writes nothing.
- [ ] Failure injection proves all linked terminal projections commit or roll back together.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track Self-hosted Run/Trace persistence, reads, and completion.

## Migration

None. This ticket uses the Mission/Run/attempt/provenance state reserved to migration 009 and may not add or modify a schema migration.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/product/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`
- `docs/contexts/deployment/CONTEXT.md`

## Allowed Files

- `packages/core-modules/evidence/src/**`
- `packages/core-modules/evidence/package.json`
- `packages/core-modules/evidence/tsconfig.json`
- `packages/core-modules/mission/src/**`
- `packages/core-modules/mission/package.json`
- `packages/core-modules/mission/tsconfig.json`
- `packages/core-modules/runner-control/src/**`
- `packages/core-modules/runner-control/package.json`
- `packages/core-modules/runner-control/tsconfig.json`
- `packages/core-application/src/runner/**`
- `packages/core-application/package.json`
- `packages/core-application/tsconfig.json`
- `packages/contracts/public-api/src/**`
- `packages/contracts/public-api/package.json`
- `packages/contracts/public-api/tsconfig.json`
- `packages/storage-providers/postgres-runtime/src/**`
- `packages/storage-providers/postgres-runtime/package.json`
- `packages/storage-providers/postgres-runtime/tsconfig.json`
- `packages/storage-providers/sqlite-runtime/src/**`
- `packages/storage-providers/sqlite-runtime/package.json`
- `packages/storage-providers/sqlite-runtime/tsconfig.json`
- `apps/server/src/routes/runs.ts`
- `apps/server/src/server.ts`
- `apps/server/src/server-context.ts`
- `apps/server/package.json`
- `apps/server/tsconfig.json`
- `apps/web-console/src/api/client.ts`
- `pnpm-lock.yaml`
- `tests/contract/sqlite/**`
- `tests/contract/postgres/**`
- `tests/contract/runner-control/**`
- `tests/contract/public-api/**`
- `.scratch/remaining-production-closure/issues/10-self-hosted-run-trace-completion.md` (`## Comments`/`## Answer` evidence plus GitHub PR/check/artifact references only)
- Post-review acceptance only: `tests/e2e/self-hosted/run-trace-completion.test.ts`

## Focused non-E2E Gate

```bash
corepack pnpm vitest run tests/contract/runner-control tests/contract/sqlite/sqlite-trace-store.test.ts tests/contract/sqlite/sqlite-record-stores.test.ts tests/contract/postgres/postgres-trace-store.test.ts tests/contract/postgres/postgres-run-store.test.ts tests/contract/postgres/self-hosted-completion.test.ts tests/contract/public-api/api-v1.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

File: `tests/e2e/self-hosted/run-trace-completion.test.ts`

```bash
corepack pnpm vitest run tests/e2e/self-hosted/run-trace-completion.test.ts
```

Prove the atomic terminal Run, attempt, logical Job, and Mission projection.

## Behavior Matrix

| Scenario/precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Ordered Trace batch is valid and durable | started | Durable Trace acknowledgement/read DTO | Append-only events and next sequence commit under tenant scope | Exact duplicate returns the same acknowledgement; next batch resumes from durable sequence | SQLite/PostgreSQL parity and sequence evidence |
| Trace has wrong tenant/provenance, a gap, or altered duplicate | not_started | Structured rejection/conflict | Existing Trace remains unchanged | Caller resumes from last durable ACK; altered data is never accepted | Rejection and unchanged-store evidence |
| Valid accepted Runner completion arrives | started | Canonical terminal completion/Run DTO | Run, attempt, logical Job, and Mission terminal projections commit atomically | Exact replay returns canonical completion | All linked terminal identities and states |
| Completion tenant/project/run/Job/attempt/hash provenance is invalid or nonvisible | not_started | Not found, authorization error, or provenance conflict without disclosure | No terminal projection changes | Retry only with authoritative matching completion | Zero-write and tenant-visibility evidence |
| Cancel/timeout occurs before Trace/completion dispatch | not_started | Cancelled/timeout | No new Trace or terminal state | Safe to retry with the same sequence/completion identity | Zero-write assertion |
| Connection/response fails after dispatch | outcome_unknown | Outcome unknown to Runner | Trace/completion is either absent or fully committed | Read durable ACK/completion before replay; never infer failure from transport loss | Readback and canonical replay evidence |
| Exact completion is replayed | started | Original terminal result | One terminal completion remains | Idempotent replay | Stable completion hash/result evidence |
| Conflicting completion is replayed after terminal state | not_started | Stable terminal conflict | Original terminal state remains unchanged | No automatic retry with altered data | Conflict and unchanged projection evidence |
| Concurrent terminal completions or restart race | started | One canonical completion; losers see duplicate/conflict | Single terminal Run/attempt/Job/Mission outcome survives restart | Replay resolves against durable terminal truth | Concurrency/restart contract evidence |
| Any linked terminal write or terminal audit/persistence step fails | outcome_unknown | No success until authoritative state is known | All linked projections roll back together, or committed transaction is read back as canonical | Retry by stable completion identity after readback | Failure-injection atomicity evidence |

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.5, 5.6, 7.3, 9.1, and 11.
- `.scratch/remaining-production-closure/spec.md`, this ticket, and the tracked prerequisite tickets named in `Blocked by` for current scope, dependency, and acceptance authority.
- The affected context documents listed above, especially one terminal completion, append-only Trace, durable ACK, atomic persisted ownership, and provider parity.
- `packages/core-application/src/runner/core-runner-protocol-application.ts`, including `RunCompletionSink`; `packages/core-modules/evidence/src/trace-ingestor.ts`; and `packages/core-modules/runner-control/src/runner-control-store.ts`.
- The unchanged SQLite/PostgreSQL/Runner-control/Public API contracts named by the focused Gate.

## Comments

- start: base SHA `5cdc7452b118b37354ead7643e0ba604a37161e2`; behavior matrix applies in full because Self-hosted Trace ingestion and terminal Run completion are stateful, side-effecting, retrying, concurrent, timeout/unknown-outcome-sensitive, and terminal-persistence-sensitive; planned Gates: `CI=true corepack pnpm vitest run tests/contract/runner-control tests/contract/sqlite/sqlite-trace-store.test.ts tests/contract/sqlite/sqlite-record-stores.test.ts tests/contract/postgres/postgres-trace-store.test.ts tests/contract/postgres/postgres-run-store.test.ts tests/contract/postgres/self-hosted-completion.test.ts tests/contract/public-api/api-v1.test.ts`, `CI=true corepack pnpm typecheck`, and `git diff --check`.
- review-fix: reviewed head `d48026ad65513af6cd88c876a20bc937eab59ce4`; fixed Ticket 10 core blockers for exact Self-hosted completion provenance validation (tenant/project/run/logical-job/attempt/Runner-job/Runner/hash identities), stale Console Run-route workflow expectations, and missing post-review Run Trace completion E2E. Fix commit `64be4d80a4798c1672853d22d360e3a92e6993f1`. Verification run before the fix commit: `corepack pnpm build` passed; `CI=true corepack pnpm vitest run tests/contract/postgres/self-hosted-completion.test.ts` passed (15 tests); `CI=true corepack pnpm vitest run tests/component/web-console/workflow.test.ts` passed (2 tests); `CI=true corepack pnpm vitest run tests/e2e/self-hosted/run-trace-completion.test.ts` passed (2 tests); `CI=true corepack pnpm vitest run tests/contract/runner-control tests/contract/sqlite/sqlite-trace-store.test.ts tests/contract/sqlite/sqlite-record-stores.test.ts tests/contract/postgres/postgres-trace-store.test.ts tests/contract/postgres/postgres-run-store.test.ts tests/contract/postgres/self-hosted-completion.test.ts tests/contract/public-api/api-v1.test.ts` passed (10 files / 121 tests); `CI=true corepack pnpm typecheck` passed; `git diff --check` passed. Not resolved; no PR evidence added.
