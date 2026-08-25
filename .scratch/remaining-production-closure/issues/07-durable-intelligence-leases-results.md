# 07 — Persist Intelligence Worker leases and Results

**What to build:** Give Intelligence Workers durable owner-bound renewable leases and an idempotent Result inbox while preserving proposal-only Worker authority.

**Blocked by:** 05 — Dispatch Mission work to its bound Runner; 06 — Deliver Skill version management loop; 20 — Restore exploration seed, checkpoint, and recovery budget schema migration `011`.

**Status:** claimed

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [ ] Lease stores worker identity, attempt, token hash, expiry, and renewal state durably.
- [ ] Worker renews before lease/3 and cannot write aggregate tables.
- [ ] Result append atomically validates tenant/job/worker/attempt/token/expiry/base version and is idempotent.
- [ ] Restart/concurrency/RLS tests prove safe re-lease and no cross-worker authority.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track durable Intelligence Worker lease and Result authority.

## Migration

Migration 012 only: durable Intelligence leases/Result inbox. Migrations 001-011 are immutable when this ticket starts, and migrations 013 onward are reserved for later tickets/out of scope for this ticket.

## Affected contexts

- `docs/contexts/intelligence/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`
- `docs/contexts/deployment/CONTEXT.md`

## Allowed Files

- `packages/core-modules/intelligence/src/**`
- `packages/core-modules/intelligence/package.json`
- `packages/core-modules/intelligence/tsconfig.json`
- `packages/storage-providers/relational-kysely/src/**`
- `packages/storage-providers/relational-kysely/package.json`
- `packages/storage-providers/relational-kysely/tsconfig.json`
- `packages/storage-providers/postgres-runtime/src/**`
- `packages/storage-providers/postgres-runtime/package.json`
- `packages/storage-providers/postgres-runtime/tsconfig.json`
- `apps/intelligence-worker/src/**`
- `apps/intelligence-worker/package.json`
- `apps/intelligence-worker/tsconfig.json`
- `pnpm-lock.yaml`
- `tests/unit/intelligence-worker/**`
- `tests/unit/core-modules/intelligence/**`
- `tests/component/intelligence-worker/**`
- `tests/contract/postgres/**`
- `.scratch/remaining-production-closure/issues/07-durable-intelligence-leases-results.md` (`## Comments`/`## Answer` evidence plus GitHub PR/check/artifact references only)
- Post-review acceptance only: `tests/e2e/self-hosted/intelligence-worker-lease.test.ts`

Maintainer-approved scope expansions during review fixes:

- `packages/core-application/src/intelligence/**` plus directly affected tests for validated inbox consumption and fenced lease release.
- `tests/unit/admin-cli/migrate.test.ts` only for updating migration target/schema-version expectations to schema `12`.

## Focused non-E2E Gate

```bash
corepack pnpm vitest run tests/unit/intelligence-worker tests/unit/core-modules/intelligence tests/component/intelligence-worker tests/contract/postgres/tenant-isolation.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

File: `tests/e2e/self-hosted/intelligence-worker-lease.test.ts`

```bash
corepack pnpm vitest run tests/e2e/self-hosted/intelligence-worker-lease.test.ts
```

Run against a real Worker/PostgreSQL path and prove lease, renewal, restart, and forced-RLS behavior.

## Behavior Matrix

| Scenario/precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Eligible Worker acquires and renews a due Job | started | Owner-bound lease/renewal result | Worker, attempt, token hash, expiry, and renewal state are durable | Same owner/token may renew; no second live owner | Lease row and renewal timing evidence |
| Tenant, Worker identity, token, attempt, expiry, or base version is invalid | not_started | Stable lease/Result rejection | Job, lease, inbox, and aggregates remain unchanged | Retry only with current authoritative lease/input | Error code and zero-write assertion |
| Worker role attempts an aggregate write | not_started | PostgreSQL authorization/RLS failure | No aggregate mutation | Never retry through Worker authority | Role/forced-RLS evidence |
| Cancel/abort occurs before model work or Result append | not_started | Cancelled/aborted | Lease remains renewable/releasable; no Result exists | Job may be retried according to lease expiry/cancellation state | Lease and zero-Result evidence |
| Result append succeeds for the live lease | started | Accepted Result identity | Inbox row is atomically bound to tenant, Job, Worker, attempt, lease, base version, and idempotency key | Exact replay returns the same Result acceptance | Inbox identity and unchanged aggregates |
| Response is lost after Result append dispatch | outcome_unknown | Outcome unknown to Worker | Result is either absent or durably complete | Replay the same idempotency key/token; never append a second semantic Result | Readback/replay evidence |
| Exact Result is replayed | started | Canonical accepted Result | One inbox record remains | Idempotent replay returns original result | Stable Result ID/hash evidence |
| Idempotency key is replayed with different Result data | not_started | Conflict | Original inbox record remains unchanged | Correct intent requires a new valid submission/key | Conflict and unchanged-row evidence |
| Worker crashes, lease expires, or two Workers claim concurrently | started | One live owner; loser receives unavailable/stale lease result | Attempt increments safely on re-lease; expired owner loses authority | New attempt may proceed only after expiry; old token/Result is rejected | Restart/concurrency and owner-fencing evidence |
| Lease or inbox terminal persistence fails | outcome_unknown | Fail-closed storage error; no accepted claim without readback | Transaction rolls back or committed state is reconciled | Retry by stable Job/attempt/idempotency identity | Failure-injection and atomicity evidence |

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.3, 5.11, 9.1, 10, and 11.
- `.scratch/remaining-production-closure/spec.md`, this ticket, and the tracked prerequisite tickets named in `Blocked by` for current scope, dependency, and acceptance authority.
- The affected context documents listed above, especially proposal-only Worker authority, owner-bound leases, Result binding, RLS, and runtime-role separation.
- `packages/core-application/src/intelligence/intelligence-queue-contracts.ts` and `packages/core-modules/intelligence/src/contracts.ts`.
- The forced-RLS and tenant-isolation contracts under `tests/contract/postgres/**`.

## Comments

- start: base SHA `c55f377460033d9053085b5aface51b02ca12842`; behavior matrix applicable as recorded above for stateful/concurrent lease and Result inbox work; planned Gates: `CI=true corepack pnpm vitest run tests/unit/intelligence-worker tests/unit/core-modules/intelligence tests/component/intelligence-worker tests/contract/postgres/tenant-isolation.test.ts`, `CI=true corepack pnpm typecheck`, and `git diff --check`.
- update: maintainer-approved scope expansions recorded above. Round-2 blocker fixes remove raw Worker `intelligence_jobs` access, switch lease claim/renew/append/abandon SECURITY DEFINER functions to database transaction time, add the required real PostgreSQL Worker lease E2E, and update admin migration schema expectations to `12`. Fix validation: `CI=true corepack pnpm vitest run tests/unit/intelligence-worker tests/unit/core-modules/intelligence tests/component/intelligence-worker tests/contract/postgres/tenant-isolation.test.ts tests/contract/postgres/postgres-runtime.test.ts tests/unit/admin-cli/migrate.test.ts` passed; `CI=true corepack pnpm vitest run tests/e2e/self-hosted/intelligence-worker-lease.test.ts` passed; `CI=true corepack pnpm typecheck` passed.
- final: reviewed head `df54a14d68c91b4cdcd696387667454f6136cf1e` against base `219532953a4eb0601b8471a8e510508dbd2c8647` after merging current `main`; Standards review and Spec review both found no blockers. Clean complete-matrix evidence: focused non-E2E Gate `CI=true corepack pnpm vitest run tests/unit/intelligence-worker tests/unit/core-modules/intelligence tests/component/intelligence-worker tests/contract/postgres/tenant-isolation.test.ts tests/contract/postgres/postgres-runtime.test.ts tests/unit/admin-cli/migrate.test.ts` passed with 11 files / 66 tests; required post-review E2E `CI=true corepack pnpm vitest run tests/e2e/self-hosted/intelligence-worker-lease.test.ts` passed with 1 file / 1 test; `CI=true corepack pnpm typecheck` passed; `git diff --check` passed.
