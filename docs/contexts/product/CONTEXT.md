# Product Context

## Terms

- **Expected Claim** records a sourced expectation; **Observed Fact** records execution evidence without replacing that expectation.
- **Disposition** is a scoped human or deterministic conclusion about a Conflict, not a destructive rewrite of evidence.
- **Target Revision** is an immutable, tenant/project-scoped Target snapshot.
- **Test Plan Revision** is an immutable reviewed plan bound to one PRD revision.
- **Mission Revision** binds one approved Test Plan revision, Target revision and snapshot hash, Project, policy, and explicit Runner.

## Ownership

`packages/core-modules/{context-intake,application-model,project-target,mission,investigation,review,skill}`, `packages/contracts/public-api`, `apps/server/src/routes`, and `apps/web-console` own user-visible product workflow.

## Seams

- Public API exposes DTOs, command envelopes, idempotency keys, and expected-version commands; it never exposes aggregates.
- Application modules own state transitions; Fastify routes map authentication, schema, DTOs, and safe errors.
- Local and Self-hosted use the same product application interfaces and Console workflow.
- The Console uses only Public API v1; it never reaches domain stores, Runner control, Artifact storage, or KMS directly.

## Invariants

- A PRD, Target, Plan, Mission, Finding, Investigation, Review, and Skill remain attributable to tenant, project, source revision, and causal evidence.
- Approved Target and Test Plan revisions are immutable. Starting a Mission snapshots their exact revisions; later edits create new revisions and never alter scheduled Jobs or Runs.
- A Mission is dispatched only to its explicit Runner binding. HTTP callers cannot supply executable policy, selectors, generated execution IDs, or mutable Plan content.
- Models submit proposals only. Deterministic application code assigns IDs, authorizes transitions, and persists aggregates.
- Expected Claims, Observed Facts, Conflicts, and Dispositions remain distinct.
- Role, tenant, idempotency, and optimistic-concurrency checks happen before mutation.
- Public routes remain under `/api/v1`; routes authenticate and map DTOs to application commands but do not implement transitions, write storage directly, or serialize domain objects.
- Published method/path, DTO, list, command, and error envelopes are versioned contracts across Project/Target, PRD/Test Plan, Mission/Run/Trace, Skill, Investigation/Review, Evidence, and Runner enrollment resources. Mutations carry idempotency and expected version where applicable; lists expose projection freshness.
- Community Local supplies the implicit `local` tenant at composition. Self-hosted requests and store operations carry explicit tenant scope; tenant/project references cannot cross scope or depend on a global current tenant.
- Skill promotion requires a valid signature and completed passing evaluation. Promotion and deprecation use expected-version, idempotent domain transitions, never route or SQL shortcuts.

## Entrypoints

- `apps/server/src/server.ts`
- `apps/server/src/routes/`
- `apps/web-console/src/routes/router.tsx`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.1-5.5, 5.7, 5.9, and 9.1.
- Related contexts: `docs/contexts/execution/CONTEXT.md`, `docs/contexts/protocol/CONTEXT.md`, `docs/contexts/storage/CONTEXT.md`, and `docs/contexts/deployment/CONTEXT.md`.
- Tracked work: legacy Tickets 05 ([#139](https://github.com/ljie-PI/Qualigence/issues/139)), 06 ([#138](https://github.com/ljie-PI/Qualigence/issues/138)), 12 ([#142](https://github.com/ljie-PI/Qualigence/issues/142)), and 15 ([#155](https://github.com/ljie-PI/Qualigence/issues/155)).

## Verification

Run `corepack pnpm vitest run tests/unit/core-modules tests/contract/public-api tests/component/web-console tests/e2e/web-console`.
