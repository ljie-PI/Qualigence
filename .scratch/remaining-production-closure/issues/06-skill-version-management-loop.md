# 06 — Deliver Skill version management loop

**What to build:** Let Self-hosted users inspect Skill versions and promote or deprecate them through the Public API and Console using the established domain lifecycle.

**Blocked by:** 03 — Deliver versioned Target and Test Plan product paths.

**Status:** ready-for-agent

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [ ] PostgreSQL persistence has behavioral parity with the existing Skill repository contract.
- [ ] Promotion requires valid signature and completed evaluation; deprecation follows domain transition rules.
- [ ] Mutations use expected-version/idempotency and cannot update state through SQL shortcuts.
- [ ] Clean-review Console/API E2E proves version read, promotion conflict, and deprecation.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track the Skill version-management slice.

## Migration

None. Use the existing Skill schema; this ticket may not add or modify a schema migration.

## Affected contexts

- `docs/contexts/product/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`
- `docs/contexts/deployment/CONTEXT.md`

## Allowed Files

- `packages/core-modules/skill/src/**`
- `packages/core-modules/skill/package.json`
- `packages/core-modules/skill/tsconfig.json`
- `packages/contracts/public-api/src/**`
- `packages/contracts/public-api/package.json`
- `packages/contracts/public-api/tsconfig.json`
- `packages/storage-providers/sqlite-runtime/src/**`
- `packages/storage-providers/sqlite-runtime/package.json`
- `packages/storage-providers/sqlite-runtime/tsconfig.json`
- `packages/storage-providers/postgres-runtime/src/**`
- `packages/storage-providers/postgres-runtime/package.json`
- `packages/storage-providers/postgres-runtime/tsconfig.json`
- `apps/server/src/routes/skills.ts`
- `apps/server/src/server.ts`
- `apps/server/src/server-context.ts`
- `apps/server/src/main.ts`
- `apps/server/src/config.ts`
- `apps/server/package.json`
- `apps/server/tsconfig.json`
- `apps/web-console/src/**`
- `apps/web-console/package.json`
- `apps/web-console/tsconfig.json`
- `pnpm-lock.yaml`
- `tests/helpers/server-fixture.ts`
- `tests/unit/core-modules/skill/**`
- `tests/contract/sqlite/**`
- `tests/contract/postgres/**`
- `tests/contract/public-api/**`
- `tests/component/web-console/**`
- `.scratch/remaining-production-closure/issues/06-skill-version-management-loop.md` (`## Comments`/`## Answer` evidence plus GitHub PR/check/artifact references only)
- Post-review acceptance only: `tests/e2e/web-console/skill-lifecycle.test.ts`

## Focused non-E2E Gate

```bash
corepack pnpm vitest run tests/unit/core-modules/skill tests/contract/sqlite/skill-store.test.ts tests/contract/postgres/skill-store.test.ts tests/contract/public-api/api-v1.test.ts tests/component/web-console/workflow.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

File: `tests/e2e/web-console/skill-lifecycle.test.ts`

```bash
corepack pnpm vitest run tests/e2e/web-console/skill-lifecycle.test.ts
```

The rendered workflow must prove version read, promotion conflict, and deprecation.

## Behavior Matrix

| Scenario/precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Authorized version read | not_started | Versioned Skill DTO | No mutation | Safe to repeat | HTTP DTO and provider parity evidence |
| Valid evaluated, signed Skill is promoted | started | Promoted Skill version DTO | Domain transition, version, idempotency record, and audit commit atomically | Exact replay returns the original result | Public response, aggregate version, and audit evidence |
| Valid promoted Skill is deprecated | started | Deprecated Skill version DTO | Domain deprecation transition commits through the repository | Exact replay is idempotent | Public response and persisted lifecycle state |
| Authentication, role, tenant, signature, or evaluation validation fails | not_started | Stable authorization/validation error | No Skill mutation or idempotency success | Retry only with corrected authority/input | Error envelope and zero-write assertion |
| Expected version is stale or two writers race | not_started | Stable conflict with actual version | Winning transition only | Refresh and issue a new command; stale replay remains conflict | Concurrent provider/API evidence |
| Same idempotency key and same command is replayed | started | Original response | Original transition remains singular | Return the recorded result without re-running transition effects | Stable response/version evidence |
| Same idempotency key is reused with different command data | not_started | Idempotency conflict | Original reservation/result remains unchanged | Caller must use a new key after correcting intent | Conflict envelope and unchanged aggregate |
| Timeout/cancel occurs before command dispatch | not_started | Cancelled/timeout | No mutation | Safe to retry with the same key | Zero-write assertion |
| Response is lost after command dispatch | outcome_unknown | Outcome unknown to caller | Transaction is either absent or fully committed | Replay the same idempotency key to recover the canonical result | Readback/replay evidence |
| Persistence or audit commit fails | outcome_unknown | Fail-closed storage error; no success | Aggregate, idempotency, and audit writes roll back together | Retry by the same key after availability returns | Failure-injection rollback evidence |

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.4, 9.1, 10, and 11.
- `.scratch/remaining-production-closure/spec.md`, this ticket, and the tracked prerequisite tickets named in `Blocked by` for current scope, dependency, and acceptance authority.
- The affected context documents listed above, especially domain-owned transitions, role/tenant/idempotency checks, and SQLite/PostgreSQL provider parity.
- `packages/core-modules/skill/src/public.ts` and `packages/core-modules/skill/src/ports/skill-repository.ts`.
- `packages/contracts/public-api/src/v1.ts` and the public/provider contracts named by the focused Gate.
