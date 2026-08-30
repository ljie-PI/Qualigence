# Intelligence Context

## Terms

- **IntelligenceJob** is durable model work leased to a Worker.
- **IntelligenceResult** is model output that requires deterministic Server-side application.
- **Tenant Wakeup** is a payload-free durable signal that a tenant may have Results ready for deterministic consumption; it carries no proposal or mutation authority.

## Ownership

`packages/core-modules/intelligence`, `packages/core-application/src/intelligence`, and `apps/intelligence-worker` own Server Intelligence work. `packages/runner-components/model-agent` supplies model adapters to both this context and the Runner Execution Agent; execution-time decisions belong to the Execution context.

## Seams

- `IntelligenceJobStore` leases durable model work.
- `IntelligenceResultInbox` accepts worker output with lease and idempotency validation.
- `IntelligenceResultApplier` is the deterministic Server-side gate for aggregate effects.
- The Server Result consumer claims tenant wakeups, reads bounded inbox batches, and invokes existing aggregate application handlers.

## Invariants

- Worker roles never write domain aggregates.
- A Result is bound to tenant, job, worker, lease attempt, base aggregate version, and idempotency key.
- Stale, duplicate, policy-violating, or over-budget Results are classified rather than silently applied.
- Model output is proposal data, never authority for IDs, state transitions, or policy.
- Job leases durably bind worker identity, attempt, token hash, expiry, and renewal state. Renewal occurs before the conservative lease window closes; expiry permits safe re-lease but never duplicate aggregate effects.
- Result append atomically validates tenant, Job, Worker, attempt, lease token and expiry, base aggregate version, schema, usage, and idempotency before accepting inbox data.
- Applied, duplicate, rejected, and recompute dispositions are durable and unambiguous; restart never loses accepted Results or processes a terminal Result forever.
- Tenant wakeups use leased claims, generation/epoch fencing, bounded fair batches, abortable backoff, and durable retry state. Stale wakeup owners cannot clear newer work.
- Only the Server's deterministic application handlers may change aggregates after policy, budget, idempotency, evidence, and expected-version checks; neither Worker nor consumer SQL may bump domain versions directly.

## Entrypoints

- `apps/intelligence-worker/src/main.ts`
- `apps/intelligence-worker/src/worker-loop.ts`
- `packages/core-application/src/intelligence/server-result-consumer.ts`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 2, 5.3, 5.7, 5.11, 6.1, 9.1, and 11.
- Related contexts: `docs/contexts/product/CONTEXT.md`, `docs/contexts/storage/CONTEXT.md`, and `docs/contexts/deployment/CONTEXT.md`.
- Tracked work: legacy Tickets 07 ([#141](https://github.com/ljie-PI/Qualigence/issues/141)), 08 ([#135](https://github.com/ljie-PI/Qualigence/issues/135)), and 12 ([#142](https://github.com/ljie-PI/Qualigence/issues/142)).

## Verification

Run `corepack pnpm vitest run tests/unit/intelligence-worker tests/unit/core-modules/intelligence tests/component/intelligence-worker tests/component/investigation`.
