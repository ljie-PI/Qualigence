# 14 — Complete OIDC, JWKS, metrics, and readiness

**What to build:** Make Self-hosted authentication, observability, and readiness production-truthful across Server, Worker, Console, proxy, and dependent loops.

**Blocked by:** 13 — Wire Evidence API, S3, and enterprise KMS.

**Status:** resolved

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [x] Remote JWKS uses bounded timeout/cache/rotation and approved algorithms with fail-closed issuer/audience/tenant/role mapping.
- [x] Metrics/OTLP exclude secrets and high-cardinality evidence content.
- [x] Live/ready endpoints reflect constructed dependencies and loop health, not static proxy responses.
- [x] Clean-review deployment tests prove dependency failures and recovery transitions.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track the Self-hosted authentication, observability, and readiness closure slice.

## Migration

None. This ticket may not add or modify a schema migration.

## Affected contexts

- `docs/contexts/deployment/CONTEXT.md`
- `docs/contexts/product/CONTEXT.md`
- `docs/contexts/intelligence/CONTEXT.md`
- `docs/contexts/protocol/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`

## Allowed Files

- `packages/auth/oidc/src/**`
- `packages/auth/oidc/package.json`
- `packages/auth/oidc/tsconfig.json`
- `packages/observability/src/**`
- `packages/observability/package.json`
- `packages/observability/tsconfig.json`
- `apps/server/src/**`
- `apps/server/package.json`
- `apps/server/tsconfig.json`
- `apps/intelligence-worker/src/**`
- `apps/intelligence-worker/package.json`
- `apps/intelligence-worker/tsconfig.json`
- `apps/web-console/src/**`
- `apps/web-console/package.json`
- `apps/web-console/tsconfig.json`
- `deployments/self-hosted/compose/**`
- `pnpm-lock.yaml`
- `tests/contract/auth/**`
- `tests/unit/observability/**`
- `tests/component/server/**`
- `tests/component/intelligence-worker/**`
- `tests/component/web-console/**`
- `.scratch/remaining-production-closure/issues/14-oidc-jwks-metrics-readiness.md` (`## Comments`/`## Answer` evidence plus GitHub PR/check/artifact references only)
- Post-review acceptance only: `tests/e2e/self-hosted/readiness.test.ts`

## Focused non-E2E Gate

```bash
corepack pnpm vitest run tests/contract/auth/oidc.test.ts tests/unit/observability tests/component/server tests/component/intelligence-worker tests/component/web-console/oidc-flow.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

File: `tests/e2e/self-hosted/readiness.test.ts`

```bash
corepack pnpm vitest run tests/e2e/self-hosted/readiness.test.ts
```

Prove dependency failure and recovery transitions through Server, Worker, Console, and proxy.

## Behavior Matrix

| Scenario/precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Valid token verifies through current JWKS and mapped claims | not_started | Authenticated tenant/role context | No business mutation; bounded JWKS cache may update | Repeat verification uses only valid cached/current keys | RS256/ES256, issuer/audience/tenant/role evidence |
| Token signature, algorithm, issuer, audience, tenant, role, or claim validation fails | not_started | Stable authentication rejection | No authenticated context or business mutation | Retry only with a valid token/configuration | Contract rejection and zero-admission evidence |
| Unknown key triggers bounded JWKS refresh/rotation | started | Authentication succeeds with valid rotated key or fails closed | Cache updates atomically within configured timeout/TTL | Bounded retry only; no stale-key acceptance beyond policy | Rotation/cache/timeout evidence |
| JWKS request times out, is cancelled, or is unavailable | outcome_unknown | Stable authentication dependency error | No unverified claims are admitted; cache remains valid or unavailable by policy | Retry within bounded policy; never bypass signature verification | Timeout/unavailable evidence |
| Metrics/log/OTLP records an operation | started | Bounded metric/log export or non-fatal exporter result as configured | No secret, plaintext Evidence, token, or high-cardinality identifier is retained/exported | Export retry must preserve redaction and bounded labels | Observability contract evidence |
| Telemetry exporter fails or times out | outcome_unknown | Product result follows existing semantics; observability health reflects failure where required | No secret fallback/buffer; health state is truthful | Bounded exporter retry; no busy spin | Failure/readiness and redaction evidence |
| All required Server/Worker/Console/proxy dependencies and loops are healthy | started | Ready response | Current dependency/loop health is represented truthfully | Repeated probes are side-effect bounded and stable | Ready endpoint and component evidence |
| Required dependency or loop fails after startup | started | Live may remain healthy; ready becomes unhealthy with stable reason | No static proxy readiness masks failure | Probe/recovery observes current dependency state | Failure transition evidence |
| Dependency recovers or process restarts | started | Ready returns only after dependency and loop reconstruction | No stale healthy state survives restart | Reprobe with bounded backoff until constructed dependency is healthy | Recovery transition evidence |
| Readiness state persistence/observation is uncertain | outcome_unknown | Fail not-ready rather than claim success | No production-ready claim without current evidence | Re-evaluate all required dependencies | Fail-closed readiness evidence |

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 3.2, 5.10, 10, 11, and 13.
- `.scratch/remaining-production-closure/spec.md`, this ticket, and the tracked prerequisite tickets named in `Blocked by` for current scope, dependency, and acceptance authority.
- The affected context documents listed above, especially authenticated Public API mapping, mTLS/loop dependencies, readiness stronger than liveness, and secret-free bounded observability.
- `packages/auth/oidc/src/oidc-authenticator.ts`, `packages/auth/oidc/src/claim-mapper.ts`, and `packages/observability/src/{logger,metrics}.ts`.
- The OIDC, observability, Server, Worker, and Console contracts named by the focused Gate.

## Comments

### start — 2026-08-26

- Base SHA: `9156a7be33f0349cf9c6e3b65167bb6cc92e1ec1`.
- Status: claimed for Ticket 14 implementation in dedicated worktree `ticket-14-oidc-jwks-metrics-readiness`.
- Behavior matrix applicability: applicable; using the ticket-local matrix above for OIDC/JWKS timeout/cache/rotation fail-closed behavior, redacted bounded observability, and dependency/loop readiness transitions.
- Planned focused non-E2E Gates:
  - `corepack pnpm vitest run tests/contract/auth/oidc.test.ts tests/unit/observability tests/component/server tests/component/intelligence-worker tests/component/web-console/oidc-flow.test.ts`
  - `corepack pnpm typecheck`
  - `git diff --check`

### final — 2026-08-26

- Reviewed code/test head: `1a0835e01b3287355b29e6c08fad3ef3bb149bbf`.
- Complete-matrix review6 clean:
  - Standards: `Q:/Qualigence/.pi-subagents/artifacts/outputs/0fcd6879-b061-4009-83ba-566cc44dfe6f/ticket14-review6/standards.md`
  - Spec: `Q:/Qualigence/.pi-subagents/artifacts/outputs/0fcd6879-b061-4009-83ba-566cc44dfe6f/ticket14-review6/spec.md`
- Final focused non-E2E Gate on the reviewed head passed: `CI=true corepack pnpm vitest run tests/contract/auth/oidc.test.ts tests/unit/observability tests/component/server tests/component/intelligence-worker tests/component/web-console/oidc-flow.test.ts` — 9 files / 123 tests.
- Required post-review acceptance passed on the reviewed head: `CI=true corepack pnpm vitest run tests/e2e/self-hosted/readiness.test.ts` — 1 file / 1 Docker Compose readiness failure/recovery test. The E2E proves Server, Worker, Console, and public proxy healthy readiness; MinIO failure causes Server/Worker object-storage and proxy not-ready; recovery returns all surfaces to ready/healthy. HTTPS verification remains enabled with per-run test CA material.
- `CI=true corepack pnpm typecheck` passed on the reviewed head.
- `git diff --check` passed on the reviewed head and before this documentation-only evidence commit.
- Final evidence commit is documentation-only relative to the reviewed code/test head. Pull request: pending creation.

## Answer

Completed Ticket 14: Self-hosted OIDC/JWKS, observability, and readiness now use bounded remote JWKS resolution, fail-closed issuer/audience/tenant/role mapping, redacted/bounded telemetry surfaces, and dependency-backed readiness for Server, Worker, Console, and proxy. Production Compose no longer silently relies on static JWKS, object-storage readiness probes the constructed S3 data plane with bounded deadlines, and required loops only report ready after current progress evidence. The self-hosted readiness E2E now exercises healthy, failure, and recovery transitions through the real Docker Compose topology.

Reviewed code/test head: `1a0835e01b3287355b29e6c08fad3ef3bb149bbf`.

Final validation: focused non-E2E Gate, readiness Docker E2E, `corepack pnpm typecheck`, and `git diff --check` passed. Complete-matrix review6 has no Critical or Important core blockers.
