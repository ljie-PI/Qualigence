# 08 — Wire the production Intelligence Result consumer

**What to build:** Start a bounded Server Result loop that discovers due tenants, applies Results through deterministic aggregate handlers, and durably records every disposition.

**Blocked by:** 07 — Persist Intelligence Worker leases and Results.

**Status:** claimed

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [ ] Payload-free tenant wakeups use leased claims, generation/epoch fencing, bounded batches, and abortable backoff.
- [ ] Applied, duplicate, rejected, and recompute dispositions become non-ambiguous durable state.
- [ ] Worker proposals reach existing aggregate application handlers; no direct version bump or SQL domain mutation remains.
- [ ] Clean-review process E2E proves restart, failure retry, readiness, and orderly shutdown.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track the production Intelligence Result-consumer slice.

## Migration

Migration 013 only: tenant wakeups/dispositions. Migrations 001-012 are immutable when this ticket starts, and migrations 014 onward are reserved for later tickets/out of scope for this ticket.

## Affected contexts

- `docs/contexts/intelligence/CONTEXT.md`
- `docs/contexts/product/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`
- `docs/contexts/deployment/CONTEXT.md`

## Allowed Files

- `packages/core-modules/intelligence/src/**`
- `packages/core-modules/intelligence/package.json`
- `packages/core-modules/intelligence/tsconfig.json`
- `packages/core-application/src/intelligence/**`
- `packages/core-application/package.json`
- `packages/core-application/tsconfig.json`
- `packages/storage-providers/relational-kysely/src/**`
- `packages/storage-providers/relational-kysely/package.json`
- `packages/storage-providers/relational-kysely/tsconfig.json`
- `packages/storage-providers/postgres-runtime/src/**`
- `packages/storage-providers/postgres-runtime/package.json`
- `packages/storage-providers/postgres-runtime/tsconfig.json`
- `apps/server/src/intelligence-result-consumer-loop.ts`
- `apps/server/src/main.ts`
- `apps/server/src/config.ts`
- `apps/server/package.json`
- `apps/server/tsconfig.json`
- `pnpm-lock.yaml`
- `tests/unit/core-modules/intelligence/**`
- `tests/component/intelligence-worker/**`
- `tests/contract/postgres/**`
- `.scratch/remaining-production-closure/issues/08-production-intelligence-consumer.md` (`## Comments`/`## Answer` evidence plus GitHub PR/check/artifact references only)
- Post-review acceptance only: `tests/e2e/self-hosted/intelligence-result-loop.test.ts`

## Focused non-E2E Gate

```bash
corepack pnpm vitest run tests/unit/core-modules/intelligence/result-applier.test.ts tests/component/intelligence-worker/result-inbox.test.ts tests/component/intelligence-worker/server-consumer-loop.test.ts tests/contract/postgres/intelligence-result-wakeup-store.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

File: `tests/e2e/self-hosted/intelligence-result-loop.test.ts`

```bash
corepack pnpm vitest run tests/e2e/self-hosted/intelligence-result-loop.test.ts
```

The process E2E must prove Server/Worker restart, retry, readiness, and orderly shutdown.

## Behavior Matrix

| Scenario/precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Due tenant wakeup is claimed and a valid Result applies | started | Applied disposition | Aggregate handler effects and terminal disposition commit with authoritative versions | Wakeup replay observes terminal disposition and does not reapply | Aggregate version, disposition, and wakeup evidence |
| Result is duplicate, stale, malformed, policy-invalid, or over budget | started | Durable duplicate, rejected, or recompute disposition | No unauthorized aggregate mutation; classified disposition is terminal or explicitly reschedulable | Duplicate stays stable; recompute creates only the authorized follow-up | Disposition code and aggregate zero/expected-write evidence |
| Tenant wakeup generation/epoch or lease is stale | not_started | Fenced/stale claim result | Current wakeup ownership remains unchanged | Rediscover and claim the current generation only | Generation/lease evidence |
| Shutdown/cancel occurs before tenant claim | not_started | Orderly stopped result/readiness transition | No claim or Result mutation | Restart rediscovers due tenants | Loop lifecycle and zero-claim evidence |
| Shutdown/cancel occurs after claim but before aggregate dispatch | started | Work remains retryable | Claim expires/releases without a terminal Result disposition | Retry after lease/backoff using the same Result identity | Claim and retry scheduling evidence |
| Aggregate/disposition commit outcome is not observable | outcome_unknown | Outcome unknown; readiness degrades if necessary | Authoritative transaction/readback determines whether effects and disposition committed | Reconcile before retry; never blindly reapply | Failure-injection readback and single-application evidence |
| Same Result is delivered repeatedly | started | Canonical existing disposition | One aggregate effect and one disposition remain | Return/observe existing disposition | Idempotency evidence |
| Conflicting Result identity/payload is replayed | not_started | Conflict/rejection | Original Result/disposition remains unchanged | No automatic correction; a newly authorized Result is required | Conflict and unchanged state evidence |
| Multiple loops/processes claim tenants or restart | started | Fenced single claimant per lease/generation | Payload-free wakeup remains durable; bounded batches and attempts progress fairly | Losers back off; restart resumes due work | Concurrency, bounded-batch, and restart evidence |
| Terminal disposition persistence fails | outcome_unknown | No successful application is reported | Aggregate effects and disposition roll back together or are reconciled atomically | Retry only after authoritative readback | Transaction failure-injection evidence |

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.3, 5.11, 9.1, and 11.
- `.scratch/remaining-production-closure/spec.md`, this ticket, and the tracked prerequisite tickets named in `Blocked by` for current scope, dependency, and acceptance authority.
- The affected context documents listed above, especially deterministic Server application, proposal-only Worker authority, durable dispositions, and tenant-scoped storage.
- `packages/core-application/src/intelligence/server-result-consumer.ts`, `packages/core-application/src/intelligence/intelligence-queue-contracts.ts`, and `packages/core-modules/intelligence/src/contracts.ts`.
- The Result inbox, wakeup-store, and Result applier tests named by the focused Gate.

## Comments

- start: base SHA `f34e7547c8208dd85425f64992553d4b8d290afc`; behavior matrix applicable as recorded above for stateful/concurrent Result consumption, tenant wakeup leasing/fencing, retry, shutdown, and terminal disposition persistence; planned Gates: `corepack pnpm vitest run tests/unit/core-modules/intelligence/result-applier.test.ts tests/component/intelligence-worker/result-inbox.test.ts tests/component/intelligence-worker/server-consumer-loop.test.ts tests/contract/postgres/intelligence-result-wakeup-store.test.ts`, `corepack pnpm typecheck`, and `git diff --check`.
- review-fix: reviewed head `1960f2f8e69071c22d243e0324768919c0bb1e97`; core blockers fixed in `51c68c319b90c7129a776562bd67945b1a96da50`: production `ServerIntelligenceResultConsumer` now supplies a deterministic policy gate to `IntelligenceResultApplier`, stale/base-version `recompute` results remain on an explicit reschedulable wakeup path instead of being silently terminalized, shutdown cancellation is propagated after tenant claim and retries the claim before aggregate dispatch, `/readyz` reports the Result consumer loop readiness, the post-review process E2E exists, and bug-analysis application ignores model-authored `episodeId` while checking deterministic BugEpisode ownership/collisions. Gates run before this evidence comment: `CI=true corepack pnpm vitest run tests/unit/core-modules/intelligence/result-applier.test.ts tests/component/intelligence-worker/result-inbox.test.ts tests/component/intelligence-worker/server-consumer-loop.test.ts tests/contract/postgres/intelligence-result-wakeup-store.test.ts` (passed, 4 files / 26 tests), `CI=true corepack pnpm vitest run tests/e2e/self-hosted/intelligence-result-loop.test.ts` (passed, 1 file / 1 test), `CI=true corepack pnpm typecheck` (passed), and `git diff --check` (passed). Not marked resolved; final PR/E2E evidence is not added.
- review-fix: reviewed head `bd5f37a66d5a4dbde3b96cf22651bfdfc96926a3`; remaining core blockers fixed in `fca4855c9876791355c79a66ed7514d7f6898323`: stale/base-version `recompute` dispositions are no longer reselected as pending Results and loop recompute wakeups use bounded backoff instead of immediate busy-spin, and `IntelligenceResultApplier.apply()` now observes abort signals after async ledger/version reads and immediately before aggregate executor dispatch so aborted work leaves no terminal disposition. Gates run before this evidence comment: `CI=true corepack pnpm vitest run tests/unit/core-modules/intelligence/result-applier.test.ts tests/component/intelligence-worker/result-inbox.test.ts tests/component/intelligence-worker/server-consumer-loop.test.ts tests/contract/postgres/intelligence-result-wakeup-store.test.ts` (passed, 4 files / 28 tests), `CI=true corepack pnpm vitest run tests/e2e/self-hosted/intelligence-result-loop.test.ts` (passed, 1 file / 1 test), `CI=true corepack pnpm typecheck` (passed), and `git diff --check` (passed). Not marked resolved; PR evidence is not added.
- review-fix: reviewed head `df5e4f171f9b0c846c144a719144397464022c23`; remaining core blocker fixed in `45230deb1e27304edf5088a8f667c0f3b2505aa3`: stale/base-version `recompute` Results now atomically create a deterministic replacement `IntelligenceJob` at the current aggregate version and persist `follow_up_job_id` on the recompute disposition, so the stale inbox row is terminally dispositioned while the Worker queue has durable follow-up authority. Gates run before this evidence comment: `CI=true corepack pnpm vitest run tests/unit/core-modules/intelligence/result-applier.test.ts tests/component/intelligence-worker/result-inbox.test.ts tests/component/intelligence-worker/server-consumer-loop.test.ts tests/contract/postgres/intelligence-result-wakeup-store.test.ts` (passed, 4 files / 28 tests), `CI=true corepack pnpm vitest run tests/e2e/self-hosted/intelligence-result-loop.test.ts` (passed, 1 file / 1 test), `CI=true corepack pnpm typecheck` (passed), `git diff --check` (passed), and additional schema consistency check `CI=true corepack pnpm vitest run tests/conformance/storage/relational-schema.test.ts` (passed, 1 file / 13 tests). Not marked resolved; PR evidence is not added.
- review-fix: reviewed head `f615305b02398d598d8c16bf3868911b5d6fef3e`; remaining core blocker fixed in `f6a48ad17e92746874dfca3646490a89bb2c714b`: PostgreSQL migration 013 now backfills payload-free `intelligence_result_wakeups` from already-accepted v12 `intelligence_result_inbox` rows, grouped by tenant with pending generations and no Result/proposal payload columns; the new PostgreSQL runtime contract covers v12-to-v13 upgrade, tenant scoping, payload absence, and replay no-op. Gates run before this evidence comment: `CI=true corepack pnpm vitest run tests/unit/core-modules/intelligence/result-applier.test.ts tests/component/intelligence-worker/result-inbox.test.ts tests/component/intelligence-worker/server-consumer-loop.test.ts tests/contract/postgres/intelligence-result-wakeup-store.test.ts` (passed, 4 files / 28 tests), `CI=true corepack pnpm vitest run tests/e2e/self-hosted/intelligence-result-loop.test.ts` (passed, 1 file / 1 test), `CI=true corepack pnpm vitest run tests/conformance/storage/relational-schema.test.ts tests/contract/postgres/postgres-runtime.test.ts tests/unit/admin-cli/migrate.test.ts tests/unit/server/schema-startup.test.ts` (passed, 4 files / 36 tests), `CI=true corepack pnpm typecheck` (passed), and `git diff --check` (passed). Not marked resolved; PR evidence is not added.
- blocked: Review round 5 at reviewed head `247c528da568fc123d93aaa15a14de493fde26ad` still reported core blockers, so this ticket was set to `needs-info` per the execution protocol and dependent Ticket 09 was stopped pending maintainer scope/ownership decision. Remaining blockers: malformed accepted inbox Results can throw before durable rejected disposition, and an expired wakeup lease may let a second consumer overwrite a first terminal disposition for the same Result. Review artifacts: `Q:/Qualigence/.pi-subagents/artifacts/outputs/8da7bb9f-91ff-4060-9527-2b1c0ee7c903/ticket08-review5/standards.md` and `Q:/Qualigence/.pi-subagents/artifacts/outputs/8da7bb9f-91ff-4060-9527-2b1c0ee7c903/ticket08-review5/spec.md`.
- scope-decision: Maintainer authorized continued Ticket 08 fix and complete-matrix review beyond the five-round cap, and broadly authorized continued fix/review beyond five rounds for active and future closure tickets when remaining core blockers are finite, ticket-scoped, and do not require a new architecture decision. Ticket 08 returns to `claimed`; dependents remain blocked until this ticket is actually resolved and merged.
