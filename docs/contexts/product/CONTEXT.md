# Product Context

## Terms

- **Expected Claim** records a sourced expectation; **Observed Fact** records execution evidence without replacing that expectation.
- **Disposition** is a scoped human or deterministic conclusion about a Conflict, not a destructive rewrite of evidence.

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

## Entrypoints

- `apps/server/src/server.ts`
- `apps/server/src/routes/`
- `apps/web-console/src/routes/router.tsx`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.1-5.5, 5.7, 5.9, and 9.1.
- Specs: `docs/superpowers/specs/2026-08-01-ls-07-prd-test-planning-design.md`, `docs/superpowers/specs/2026-08-01-ls-08-m2-recording-skill-lifecycle-design.md`, `docs/superpowers/specs/2026-08-01-ls-10-m2-investigation-review-evidence-design.md`, `docs/superpowers/specs/2026-08-01-ls-11-m2-self-hosted-runtime-deployment-design.md`.

## Verification

Run `corepack pnpm vitest run tests/unit/core-modules tests/contract/public-api tests/component/web-console tests/e2e/web-console`.
