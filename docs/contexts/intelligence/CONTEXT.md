# Intelligence Context

## Terms

- **IntelligenceJob** is durable model work leased to a Worker.
- **IntelligenceResult** is model output that requires deterministic Server-side application.

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

## Entrypoints

- `apps/intelligence-worker/src/main.ts`
- `apps/intelligence-worker/src/worker-loop.ts`
- `packages/core-application/src/intelligence/server-result-consumer.ts`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 2, 5.3, 5.7, 9.1, and 11.
- Specs: `docs/superpowers/specs/2026-08-01-ls-10-m2-investigation-review-evidence-design.md`, `docs/superpowers/specs/2026-08-01-ls-11-m2-self-hosted-runtime-deployment-design.md`.

## Verification

Use Worker unit/component tests, PostgreSQL queue contracts, Result inbox tests, and application-model/investigation contracts.
