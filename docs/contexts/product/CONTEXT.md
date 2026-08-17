# Product Context

## Ownership

`packages/core-modules/{context-intake,application-model,project-target,mission,investigation,review,skill}`, `packages/contracts/public-api`, `apps/server/src/routes`, and `apps/web-console` own user-visible product workflow.

## Seams

- Public API exposes DTOs, command envelopes, idempotency keys, and expected-version commands; it never exposes aggregates.
- Application modules own state transitions; Fastify routes map authentication, schema, DTOs, and safe errors.
- Local and Self-hosted use the same product application interfaces and Console workflow.

## Invariants

- A PRD, Target, Plan, Mission, Finding, Investigation, Review, and Skill remain attributable to tenant, project, source revision, and causal evidence.
- Models submit proposals only. Deterministic application code assigns IDs, authorizes transitions, and persists aggregates.
- Expected Claims, Observed Facts, Conflicts, and Dispositions remain distinct.
- Role, tenant, idempotency, and optimistic-concurrency checks happen before mutation.

## Verification

Use domain unit tests, public API contracts, Web Console components, browser E2E, and product workflow tests. Read Architecture sections 5.1-5.5, 5.7, 5.9, and LS-07 through LS-10 before changing this context.
