# 13 — Wire Evidence API, S3, and enterprise KMS

**What to build:** Expose authorized Self-hosted Evidence metadata/bytes while composing tenant-scoped S3 and KMS providers with fail-closed lifecycle semantics.

**Blocked by:** 12 — Deliver the real Self-hosted Compose Runner loop.

**Status:** resolved

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [x] Evidence APIs enforce tenant/project/purpose authorization and never expose unauthorized plaintext.
- [x] Artifact dedupe is tenant-local; keys and manifests remain project/run scoped.
- [x] Lifecycle is `active -> revoking -> revoked -> deleting -> deleted`; revoke failure retains bytes and delete failure remains auditable/retryable.
- [x] Clean-review E2E proves S3/KMS unavailable paths fail closed without plaintext fallback.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track the Self-hosted Evidence API, S3, and KMS closure slice.

## Migration

Migration 015 only: Evidence lifecycle. Migrations 001-014 are immutable when this ticket starts and no later migration is authorized by this ticket.

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

## Comments

- start: base SHA `6a0a0adc0ae35359e137d89163b72bca38c65a51`; predecessor Ticket 12 evidence is merged in current base via PR `https://github.com/ljie-PI/Qualigence/pull/119`, reviewed code/test head `28eb6fb1b1ad368a3dd7431e96b6fbed7903fd46`, and Ticket 12 final focused Gate plus Compose/external Runner E2E recorded as clean in `.scratch/remaining-production-closure/issues/12-real-self-hosted-compose-runner-loop.md`. Behavior matrix applies in full because Evidence API access, S3 Artifact IO, KMS unwrap/revoke, lifecycle delete, retries, concurrency, and dependency-unavailable paths are stateful, side-effecting, authorization-sensitive, retry-sensitive, and terminal-state-sensitive. Planned Gates: `CI=true corepack pnpm vitest run tests/contract/evidence-crypto tests/contract/kms-self-hosted tests/contract/artifact-s3 tests/contract/public-api/api-v1.test.ts tests/component/investigation`, `CI=true corepack pnpm typecheck`, and `git diff --check`.
- review-fix: complete-matrix reviewed head `a5b4338ae4fcf6fad293a5bbb9d4e5ee3699f91d` reported core blockers for unaudited Evidence metadata/byte access, missing production KMS/lifecycle composition and Postgres `EvidenceLifecycleStore`, fire-and-forget `SelfHostedKms` audit writes, and stale schema-version expectations after migration 015. Fix commit `5773a6788941c35bf6303a84182e5bf2efa7cc11` wires fail-closed audited access through the Evidence API, composes Self-hosted KMS/lifecycle deps in Server, adds `PostgresEvidenceLifecycleStore` and a production lifecycle delete command path, awaits KMS audit persistence before sensitive returns, and updates schema-version/sequential/future-version tests for migration 015 only. Gates run: `CI=true corepack pnpm vitest run tests/contract/evidence-crypto tests/contract/kms-self-hosted tests/contract/artifact-s3 tests/contract/public-api/api-v1.test.ts tests/component/investigation` passed (9 files / 94 tests); `CI=true corepack pnpm vitest run tests/conformance/storage/relational-schema.test.ts tests/contract/postgres/postgres-runtime.test.ts` passed (2 files / 28 tests); `CI=true corepack pnpm typecheck` passed; `git diff --check` passed. Status remains `claimed`; no final/PR evidence is recorded in this review-fix update.
- review2-fix: complete-matrix reviewed head `03eb0f530e73228a4a933edcc637af71bcc5f345` reported core blockers for false successful plaintext-access audit when byte storage fails, missing production Compose Server S3/KMS wiring, in-memory production `SelfHostedKms` key/revocation state, lifecycle DELETE not deleting actual ArtifactStore bytes or preserving durable side-effect boundaries, and missing case/policy validation before plaintext access. Fix commit `400fce77b8aa0fe8deff72fff48bdf55084c4aaa` defers the successful `unwrap:allowed:plaintext_access` audit until after bytes are read, validates case and policy constraints from existing run/job/profile/lifecycle records, composes DELETE through short durable lifecycle/audit transactions with configured S3/local `ArtifactStore.delete`, adds durable Postgres-backed Self-hosted KMS key/revocation state in migration 015, and wires production Compose Server `SERVER_S3_*` plus `SERVER_KMS_ROOT_KEY_BASE64_FILE` secrets. Gates run: `CI=true corepack pnpm vitest run tests/contract/evidence-crypto tests/contract/kms-self-hosted tests/contract/artifact-s3 tests/contract/public-api/api-v1.test.ts tests/component/investigation --reporter=dot` passed (9 files / 98 tests); `CI=true corepack pnpm vitest run tests/conformance/storage/relational-schema.test.ts tests/contract/postgres/postgres-runtime.test.ts --reporter=dot` passed (2 files / 29 tests); `CI=true corepack pnpm typecheck` passed; `git diff --check` passed; `CI=true corepack pnpm vitest run tests/component/server/self-hosted-compose-runner-loop.test.ts --reporter=dot` passed (1 file / 11 tests); `docker compose --env-file deployments/self-hosted/compose/.env.example -f deployments/self-hosted/compose/compose.yaml config --format json` verified Server S3/KMS env and secret mounts. Docker was available, but `tests/e2e/self-hosted/evidence-api.test.ts` is absent in this worktree, so no post-review Evidence API E2E was run. Status remains `claimed`; no final/PR evidence is recorded in this review-fix update.
- post-review-acceptance-file: added `tests/e2e/self-hosted/evidence-api.test.ts` within the ticket's explicit post-review acceptance scope. The E2E provisions Docker-backed PostgreSQL plus MinIO, builds the real Public API server with `S3ArtifactStore`, `SelfHostedKms`, `PostgresSelfHostedKmsKeyStore`, and `PostgresEvidenceLifecycleStore`, and verifies authorized Evidence metadata/bytes, tenant/purpose denial, revoke-before-delete lifecycle, KMS-unavailable byte access, S3-unavailable byte access, S3-delete failure retry, and KMS-revoke failure retry without plaintext fallback or false `unwrap:allowed:plaintext_access` audit. Acceptance commands: `CI=true corepack pnpm vitest run tests/e2e/self-hosted/evidence-api.test.ts --reporter=dot` passed (1 file / 5 tests); `CI=true corepack pnpm typecheck` passed; `git diff --check` passed. Because this is a post-review test addition after clean review at `f2a274b52e35074cf9af81af1e47af7066a734f3`, status remains `claimed`; no final/PR evidence is recorded, and a fresh complete-matrix review is required before PR readiness.
- final: reviewed code/test head `9a8c9f1fbc3f7a84e82c000ccacb5520d2f02d52`. Complete-matrix review reported no core blockers: `Q:/Qualigence/.pi-subagents/artifacts/outputs/3387de74-9d58-44f4-9b30-618a4be9ad4f/ticket13-review4/standards.md` and `Q:/Qualigence/.pi-subagents/artifacts/outputs/3387de74-9d58-44f4-9b30-618a4be9ad4f/ticket13-review4/spec.md`. Final verification passed: `CI=true corepack pnpm vitest run tests/e2e/self-hosted/evidence-api.test.ts --reporter=dot` (1 file / 5 tests), `CI=true corepack pnpm vitest run tests/contract/evidence-crypto tests/contract/kms-self-hosted tests/contract/artifact-s3 tests/contract/public-api/api-v1.test.ts tests/component/investigation --reporter=dot` (9 files / 98 tests), `CI=true corepack pnpm vitest run tests/conformance/storage/relational-schema.test.ts tests/contract/postgres/postgres-runtime.test.ts --reporter=dot` (2 files / 29 tests), `CI=true corepack pnpm vitest run tests/component/server/self-hosted-compose-runner-loop.test.ts --reporter=dot` (1 file / 11 tests), `docker compose --env-file deployments/self-hosted/compose/.env.example -f deployments/self-hosted/compose/compose.yaml config --format json` Server S3/KMS env+secret assertion, `CI=true corepack pnpm typecheck`, and `git diff --check`. Pull request: pending creation.

## Answer

Implemented the Self-hosted Evidence API, S3 ArtifactStore, and Self-hosted KMS lifecycle slice. The Public API now exposes authorized Evidence metadata/bytes/delete routes with tenant/project/run/case/policy/purpose/TTL/revocation checks, S3-backed Artifact bytes, durable Postgres-backed KMS key/revocation state, migration 015 lifecycle/KMS schema, and fail-closed audit/order semantics. The Self-hosted Compose Server is wired to MinIO/S3 and KMS secrets, and the post-review Docker-backed Evidence API E2E proves authorized access, lifecycle deletion, and S3/KMS unavailable paths without plaintext fallback or false success audits.

Pull request: pending creation.

Reviewed code/test head: `9a8c9f1fbc3f7a84e82c000ccacb5520d2f02d52`

Final verification: focused Ticket 13 Gate, storage/Postgres Gate, Server/Compose component proof, self-hosted Evidence API E2E, `corepack pnpm typecheck`, and `git diff --check` passed.
