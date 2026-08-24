# 06 — Deliver Skill version management loop

**What to build:** Let Self-hosted users inspect Skill versions and promote or deprecate them through the Public API and Console using the established domain lifecycle.

**Blocked by:** 03 — Deliver versioned Target and Test Plan product paths.

**Status:** resolved

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [ ] SQLite and PostgreSQL persistence have behavioral parity with the Skill lifecycle command contract and existing Skill repository reads.
- [ ] Promotion requires valid signature and completed evaluation; deprecation follows domain transition rules.
- [ ] Mutations use expected-version, durable idempotency, and atomic audit; they cannot update state through SQL shortcuts.
- [ ] Clean-review Console/API E2E proves version read, promotion conflict, and deprecation.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track the Skill version-management slice.

## Migration

This ticket owns one new additive Skill lifecycle migration because the existing migration-003 Skill tables do not persist mutation idempotency, command replay results, or lifecycle audit. Migrations 001-009 remain immutable; do not edit historical migration files. Use the next sequential migration at the implementation base, currently `010-skill-lifecycle-commands`.

The migration must keep `skills` as the aggregate head. Do not encode command history with `last_*` fields on `skills`; a Skill can receive multiple commands and replays. Add dedicated tables for lifecycle command idempotency and audit evidence.

Required persistent command shape:

- `skill_lifecycle_commands`: primary key `idempotency_key`; stable `command_hash`; `command_type` (`promote` or `deprecate`); `skill_id`; `expected_version`; committed `result_version`; safe `result_json`; `created_at`.
- `skill_lifecycle_audit_events`: primary key `audit_id`; `skill_id`; `skill_version`; `operation` (`promote` or `deprecate`); `decision` (`allowed` or `rejected`); safe actor/tenant/role context available at the application seam; safe reason/metadata; `created_at`.

The mutation transaction must reserve/check the idempotency key, run the domain transition and policy checks, persist the updated Skill head/version (and deprecation evidence where applicable), write the command result, and write the audit event atomically. A replay with the same key and command hash returns the stored result without re-running transition effects. Reusing the same key with different command data returns an idempotency conflict and leaves the original command/result unchanged. If aggregate, command, or audit persistence fails, the whole transaction rolls back and no success is reported.

Rejected validation or authorization must not create an idempotency success record. Rejection audit may be emitted only if it preserves the zero-mutation invariant and does not make a corrected retry with the same key impossible.

Schema sequencing: this ticket claims migration `010` ahead of ticket 20's allocated exploration progress migration `011`; tickets 07, 08, 11, and 13 follow as migrations `012`-`015`. Ticket 20 must not claim or merge its schema migration before this ticket merges, and all tickets must serialize changes to shared relational schema/catalog files. If another merged ticket has already claimed `010` at the implementation base, stop and update the global migration allocation before coding.

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
- `packages/storage-providers/relational-kysely/src/migrations/010-skill-lifecycle-commands.ts` (new; or the next sequential migration file if `010` is already claimed at implementation base)
- `packages/storage-providers/relational-kysely/src/migrations.ts`
- `packages/storage-providers/relational-kysely/src/schema.ts`
- `packages/storage-providers/relational-kysely/src/catalog.ts`
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
| Valid evaluated, signed Skill is promoted | started | Promoted Skill version DTO | Domain transition, version, `skill_lifecycle_commands` result, and lifecycle audit commit atomically | Exact replay returns the original stored result without re-running transition effects | Public response, aggregate version, idempotency row, and audit evidence |
| Valid promoted Skill is deprecated | started | Deprecated Skill version DTO | Domain deprecation transition, deprecation evidence, `skill_lifecycle_commands` result, and lifecycle audit commit atomically | Exact replay returns the original stored result without appending another transition/audit effect | Public response, persisted lifecycle state, idempotency row, and audit evidence |
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

## Comments

- start: Claimed on branch `closure-06-skill-lifecycle` at base SHA `6f930940b490b11dc0345f6393f811e272c06a21`. Behavior matrix applicable: stateful Skill lifecycle mutations with idempotency, expected-version concurrency, audit, replay, rollback, and Public API/Console reads. Planned Gates: `corepack pnpm vitest run tests/unit/core-modules/skill tests/contract/sqlite/skill-store.test.ts tests/contract/postgres/skill-store.test.ts tests/contract/public-api/api-v1.test.ts tests/component/web-console/workflow.test.ts`; `corepack pnpm typecheck`; `git diff --check`.
- final: Reviewed code/test head `1d345c430449cb8016f97e2c358c229e233de876` with complete matrix coverage; Standards findings 0 and Spec findings 0. Clean focused Gate: `OPENSSL_CONF='C:\Program Files\Git\usr\ssl\openssl.cnf' corepack pnpm vitest run tests/unit/core-modules/skill tests/contract/sqlite/skill-store.test.ts tests/contract/postgres/skill-store.test.ts tests/contract/public-api/api-v1.test.ts tests/component/web-console/workflow.test.ts`. Clean storage conformance: `corepack pnpm vitest run tests/conformance/storage/relational-schema.test.ts`. Clean post-review acceptance: `OPENSSL_CONF='C:\Program Files\Git\usr\ssl\openssl.cnf' corepack pnpm vitest run tests/e2e/web-console/skill-lifecycle.test.ts`. `corepack pnpm typecheck` and `git diff --check` passed. PR `https://github.com/ljie-PI/Qualigence/pull/91` merged as `0334508d245981fb84f36e36368f9bbd08928062`.

## Answer

Implemented Skill lifecycle version inspection, promotion, and deprecation through core Skill application service, Public API, Console, SQLite/PostgreSQL parity, migration `010-skill-lifecycle-commands`, durable idempotency/audit, command replay/conflict handling, signature/evaluation checks, rollback evidence, rendered Console acceptance, and storage conformance.

Pull request: `https://github.com/ljie-PI/Qualigence/pull/91`

Merge commit: `0334508d245981fb84f36e36368f9bbd08928062`
