# 13 — Wire Evidence API, S3, and enterprise KMS

**What to build:** Expose authorized Self-hosted Evidence metadata/bytes while composing tenant-scoped S3 and KMS providers with fail-closed lifecycle semantics.

**Blocked by:** 12 — Deliver the real Self-hosted Compose Runner loop.

**Status:** ready-for-agent

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [ ] Evidence APIs enforce tenant/project/purpose authorization and never expose unauthorized plaintext.
- [ ] Artifact dedupe is tenant-local; keys and manifests remain project/run scoped.
- [ ] Lifecycle is `active -> revoking -> revoked -> deleting -> deleted`; revoke failure retains bytes and delete failure remains auditable/retryable.
- [ ] Clean-review E2E proves S3/KMS unavailable paths fail closed without plaintext fallback.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track the Self-hosted Evidence API, S3, and KMS closure slice.

## Migration

Migration 013 only: Evidence lifecycle. Migrations 001-012 are immutable and no later migration is authorized by this ticket.

## Affected contexts

- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/product/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`
- `docs/contexts/deployment/CONTEXT.md`

## Allowed Files

- `packages/core-modules/evidence/src/**`
- `packages/core-modules/evidence/package.json`
- `packages/core-modules/evidence/tsconfig.json`
- `packages/storage-providers/relational-kysely/src/**`
- `packages/storage-providers/relational-kysely/package.json`
- `packages/storage-providers/relational-kysely/tsconfig.json`
- `packages/storage-providers/postgres-runtime/src/**`
- `packages/storage-providers/postgres-runtime/package.json`
- `packages/storage-providers/postgres-runtime/tsconfig.json`
- `packages/storage-providers/artifact-s3/src/**`
- `packages/storage-providers/artifact-s3/package.json`
- `packages/storage-providers/artifact-s3/tsconfig.json`
- `packages/storage-providers/kms-self-hosted/src/**`
- `packages/storage-providers/kms-self-hosted/package.json`
- `packages/storage-providers/kms-self-hosted/tsconfig.json`
- `apps/server/src/routes/evidence.ts`
- `apps/server/src/server.ts`
- `apps/server/src/server-context.ts`
- `apps/server/src/main.ts`
- `apps/server/src/config.ts`
- `apps/server/package.json`
- `apps/server/tsconfig.json`
- `pnpm-lock.yaml`
- `tests/helpers/server-fixture.ts`
- `tests/contract/evidence-crypto/**`
- `tests/contract/kms-self-hosted/**`
- `tests/contract/artifact-s3/**`
- `tests/contract/public-api/**`
- `tests/component/investigation/**`
- `.scratch/remaining-production-closure/issues/13-evidence-api-s3-kms.md` (`## Comments`/`## Answer` evidence plus GitHub PR/check/artifact references only)
- Post-review acceptance only: `tests/e2e/self-hosted/evidence-api.test.ts`

## Focused non-E2E Gate

```bash
corepack pnpm vitest run tests/contract/evidence-crypto tests/contract/kms-self-hosted tests/contract/artifact-s3 tests/contract/public-api/api-v1.test.ts tests/component/investigation
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

File: `tests/e2e/self-hosted/evidence-api.test.ts`

```bash
corepack pnpm vitest run tests/e2e/self-hosted/evidence-api.test.ts
```

Run authorized S3/KMS lifecycle and unavailable-provider failure cases.

## Behavior Matrix

| Scenario/precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Authorized tenant/project/purpose requests Evidence metadata or bytes | started | Authorized metadata or bounded plaintext response | Access/decryption audit is durable; Evidence state remains active | Repeat requires fresh authorization and audit | Public response, scope checks, and audit evidence |
| Authentication, role, tenant, project, purpose, policy, TTL, or revocation validation fails | not_started | Not found/forbidden or stable policy error without disclosure | No plaintext returned and no unauthorized state change | Retry only with valid current authority | Zero-plaintext and tenant-isolation evidence |
| Tenant-local duplicate Artifact is stored | started | Canonical tenant-local object/manifest result | Deduplication remains inside tenant and project/Run references remain scoped | Exact duplicate is idempotent; cross-tenant request creates no shared logical/physical authority | S3/provider tenant-bound evidence |
| Evidence deletion is requested for active Evidence | started | Lifecycle advances through `revoking` then `revoked`, then deletion | Successful revoke and audit are durable before ciphertext deletion starts | Resume from the last durable lifecycle state | Ordered state/audit/object evidence |
| KMS revoke fails | started | Fail-closed revoke error | Ciphertext is retained; state remains retryable and not deleting/deleted | Retry revocation; never delete first | Retained-object and lifecycle evidence |
| Revocation audit persistence fails | outcome_unknown | Sensitive operation fails closed | No deletion begins; authoritative audit/lifecycle readback decides retry point | Reconcile audit and lifecycle before retry | Failure-injection and retained-object evidence |
| Ciphertext delete fails after durable revocation | started | Retryable delete failure | Record remains auditable and `revoked`; ciphertext may remain | Retry delete without restoring unwrap authority | Revoked record and object-presence evidence |
| Delete succeeds but terminal `deleted` persistence is uncertain | outcome_unknown | No false terminal success | Readback/object verification determines `deleting` versus `deleted` | Reconcile before retry; deletion remains idempotent | Object absence plus terminal lifecycle evidence |
| Duplicate lifecycle command is replayed | started | Canonical current/terminal lifecycle result | Monotonic state is unchanged or advances once | Idempotent replay; no backward transition | Stable lifecycle/audit evidence |
| Conflicting lifecycle/decryption commands race or process restarts | started | One authorized monotonic outcome; invalid operation conflicts | Optimistic concurrency preserves lifecycle order and audit | Restart resumes current durable state | Concurrency/restart evidence |
| S3 or KMS is unavailable during access | not_started | Stable unavailable error | No plaintext fallback, no false audit/success | Retry after provider recovery and reauthorization | Unavailable-provider E2E evidence |

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.6, 8, 9-11, including the fail-closed `active -> revoking -> revoked -> deleting -> deleted` lifecycle.
- `.scratch/remaining-production-closure/spec.md`, this ticket, and the tracked prerequisite tickets named in `Blocked by` for current scope, dependency, and acceptance authority.
- The affected context documents listed above, especially Evidence authorization, revoke-before-delete, audit-fail-closed behavior, tenant isolation, and public DTO boundaries.
- `packages/core-modules/evidence/src/capsule/contracts.ts` (`KeyManagementProvider`), `packages/core-modules/evidence/src/persistence-ports.ts`, and the S3/KMS provider contracts named by the Gate.
- `packages/contracts/public-api/src/v1.ts` and the Public API/investigation contracts named by the focused Gate.
