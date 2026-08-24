# 05 — Dispatch Mission work to its bound Runner

**What to build:** Run a bounded durable dispatch loop that offers each scheduled Runner Job only to its explicitly bound authenticated Runner after tenant, project, policy, and capability checks.

**Blocked by:** 04 — Atomically schedule Mission, Run, and dispatch outbox.

**Status:** ready-for-agent

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [ ] Offline or temporarily unavailable bound Runner leaves work durably pending with bounded backoff.
- [ ] Capability mismatch blocks explicitly and never selects another Runner.
- [ ] Accept/receipt CAS is crash-safe and cannot mint a second lease after uncertain commit.
- [ ] Clean-review component/E2E proves exact Runner selection and stable replay receipt.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track the bound-Runner dispatch slice.

This ticket owns an injectable, startable dispatch loop over existing Mission dispatch outbox and Runner-control seams. The loop may be constructed and exercised directly by tests. Server process boot wiring, Self-hosted gRPC listener composition, tenant-bound Runner registry, and durable `next_attempt`/claim schema are not owned by this ticket; tickets 09 and 12 compose those production paths. Offline bound Runner handling therefore leaves the existing outbox row durably `pending` and applies bounded loop-local backoff without adding schema.

## Migration

None. This ticket may not add or modify a schema migration.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/product/CONTEXT.md`
- `docs/contexts/protocol/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`
- `docs/contexts/deployment/CONTEXT.md`

## Allowed Files

- `apps/server/src/mission-dispatch-loop.ts`
- `apps/server/package.json`
- `apps/server/tsconfig.json`
- `packages/core-application/src/runner/**`
- `packages/core-application/package.json`
- `packages/core-application/tsconfig.json`
- `packages/core-modules/runner-control/src/**`
- `packages/core-modules/runner-control/package.json`
- `packages/core-modules/runner-control/tsconfig.json`
- `pnpm-lock.yaml`
- `tests/unit/core-daemon/**`
- `tests/contract/runner-control/**`
- `tests/component/core-runner/**`
- `.scratch/remaining-production-closure/issues/05-dispatch-mission-bound-runner.md` (`## Comments`/`## Answer` evidence plus GitHub PR/check/artifact references only)
- Post-review acceptance only: `tests/e2e/self-hosted/bound-runner-dispatch.test.ts`

## Focused non-E2E Gate

```bash
corepack pnpm vitest run tests/contract/runner-control tests/unit/core-daemon tests/component/core-runner
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

File: `tests/e2e/self-hosted/bound-runner-dispatch.test.ts`

```bash
corepack pnpm vitest run tests/e2e/self-hosted/bound-runner-dispatch.test.ts
```

The cases must exercise the exact bound Runner, an offline bound Runner, and a capability-mismatched bound Runner.

## Behavior Matrix

| Scenario/precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Eligible bound Runner accepts the offer | started | Stable accepted receipt | One outbox delivery and one lease bind the scheduled Job to that Runner | Duplicate dispatch/accept returns the same receipt and never mints another lease | Job, Runner, lease, and receipt identities in contract/component evidence |
| Bound Runner is offline or temporarily unavailable | not_started | Pending with bounded backoff | Outbox remains pending with next-attempt metadata; no lease exists | Retry only the same bound Runner | Pending row and bounded backoff evidence |
| Tenant, project, policy, or authenticated Runner binding is invalid | not_started | Structured rejection | No offer, receipt, or lease is written | Retry only after authoritative input changes | Rejection code plus zero-write assertion |
| Bound Runner lacks a required capability | not_started | Explicit capability rejection/blocked result | Work is durably blocked or remains non-dispatchable; no alternate Runner is selected | No implicit downgrade or reassignment | Required/actual capability evidence and no alternate offer |
| Cancel or timeout occurs before offer dispatch | not_started | Cancelled or retryable pending result | No lease or receipt; cancellation/backoff state is durable as applicable | Replay observes cancellation or retries the same Runner | Outbox/Job state and zero-offer assertion |
| Offer was sent but accept persistence is not observable | outcome_unknown | Outcome unknown; never report a new acceptance | Authoritative receipt/lease CAS decides whether acceptance committed | Reconcile/replay the same offer identity before any retry; never mint a second lease | CAS readback and single-lease assertion |
| Duplicate or conflicting accept is received | started | Canonical receipt for duplicate; conflict for altered identity/payload | Original acceptance remains unchanged | Exact duplicate is idempotent; conflict writes nothing | Original receipt and conflict evidence |
| Concurrent dispatchers or process restart race the same outbox row | started | One dispatcher wins; others observe pending/accepted state | Claim, receipt, and lease remain singular and recoverable | Restart resumes durable pending work; losers do not offer independently | Concurrency/restart contract evidence |
| Terminal receipt/lease persistence fails | outcome_unknown | No success is reported until authoritative readback | Transaction rolls back, or committed state is reconciled without a second lease | Retry by stable dispatch identity only | Failure-injection evidence for rollback/readback and one-lease invariant |

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.5, 7.3, 9.1, and 11.
- `.scratch/remaining-production-closure/spec.md`, this ticket, and the tracked prerequisite tickets named in `Blocked by` for current scope, dependency, and acceptance authority.
- The affected context documents listed above, especially Core-only lifecycle authority, bound leases, durable ownership, and readiness invariants.
- `packages/core-modules/runner-control/src/runner-control-store.ts` and `packages/core-modules/runner-control/src/runner-protocol-application.ts`.
- `packages/core-application/src/runner/execution-job-service.ts` and the unchanged shared contracts under `tests/contract/runner-control/**`.
