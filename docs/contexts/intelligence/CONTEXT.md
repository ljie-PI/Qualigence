# Intelligence Context

## Ownership

`packages/core-modules/intelligence`, `packages/runner-components/model-agent`, `packages/core-application/src/intelligence`, and `apps/intelligence-worker` own asynchronous model work.

## Seams

- `IntelligenceJobStore` leases durable model work.
- `IntelligenceResultInbox` accepts worker output with lease and idempotency validation.
- `IntelligenceResultApplier` is the deterministic Server-side gate for aggregate effects.

## Invariants

- Worker roles never write domain aggregates.
- A Result is bound to tenant, job, worker, lease attempt, base aggregate version, and idempotency key.
- Stale, duplicate, policy-violating, or over-budget Results are classified rather than silently applied.
- Model output is proposal data, never authority for IDs, state transitions, or policy.

## Verification

Use Worker unit/component tests, PostgreSQL queue contracts, Result inbox tests, and application-model/investigation contracts. Read Architecture sections 2, 5.3, 5.7, 9.1, and 11.
