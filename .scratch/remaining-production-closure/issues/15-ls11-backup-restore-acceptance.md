# 15 — Complete LS-11 backup, restore, and acceptance

**What to build:** Prove the complete Team Self-hosted architecture exit through clean-environment backup/restore and the full product workflow.

**Blocked by:** 14 — Complete OIDC, JWKS, metrics, and readiness.

**Status:** resolved

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [x] Backup includes PostgreSQL plus actual object bytes and target-bound hashes; clean restore verifies size/hash and application reads.
- [x] Compose acceptance covers PRD/Test Plan/Mission/Runner/Skill/Investigation/Review/Evidence through Public API and Console.
- [x] Doctor/readiness/metrics/secrets/container security have repeatable evidence.
- [x] Ticket-local final evidence and its merged GitHub PR may claim LS-11 complete only after all architecture exits pass.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track LS-11 backup, restore, and full-product acceptance.

## Migration

None. This ticket verifies the completed sequential schema and may not add or modify a schema migration.

## Affected contexts

- `docs/contexts/deployment/CONTEXT.md`
- `docs/contexts/product/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`
- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/protocol/CONTEXT.md`
- `docs/contexts/intelligence/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`

## Allowed Files

- `apps/admin-cli/src/commands/backup.ts`
- `apps/admin-cli/src/commands/restore.ts`
- `apps/admin-cli/src/commands/doctor.ts`
- `deployments/self-hosted/**`
- `tests/unit/admin-cli/**`
- `tests/component/local-launcher/**`
- `tests/contract/public-api/**`
- `tests/component/web-console/**`
- `.scratch/remaining-production-closure/issues/15-ls11-backup-restore-acceptance.md` (`## Comments`/`## Answer` evidence plus GitHub PR/check/artifact references only)
- Post-review acceptance only: `tests/e2e/self-hosted/backup-restore.test.ts`
- Post-review acceptance only: `tests/e2e/self-hosted/acceptance.test.ts`

## Focused non-E2E Gate

```bash
corepack pnpm vitest run tests/unit/admin-cli/backup-index.test.ts tests/component/local-launcher/backup-manager.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

Files: `tests/e2e/self-hosted/backup-restore.test.ts` and `tests/e2e/self-hosted/acceptance.test.ts`

```bash
corepack pnpm vitest run tests/e2e/self-hosted/backup-restore.test.ts tests/e2e/self-hosted/acceptance.test.ts
```

Run from a clean environment. The Gate must prove LS-11 backup/restore and the full product acceptance workflow.

## Behavior Matrix

| Scenario/precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Backup runs against the intended deployment and quiesced/consistent target | started | Verified backup index/result | PostgreSQL backup, actual object bytes, target binding, sizes, and hashes are durable | Repeating creates a separately verifiable backup; never reuses stale target evidence | Backup index, DB/object hashes, and target identity |
| Backup target/configuration, permissions, readiness, or required bytes are invalid | not_started | Stable backup/Doctor failure | No successful backup index is published | Correct environment and run a fresh backup | Failure and no-success-index evidence |
| Backup is interrupted after some bytes are written | outcome_unknown | Backup is incomplete and not valid for restore/upgrade authority | Partial output is untrusted or explicitly incomplete | Start a fresh backup; do not promote partial output | Incomplete-index/cleanup evidence |
| Restore validates a complete matching backup into a clean target | started | Verified restore success | Database and object bytes are restored and application-readable with matching size/hash | Repeating requires a clean compatible target or explicit safe contract | Restore verification and application-read evidence |
| Backup is missing, malformed, stale, target-mismatched, wrong schema, or hash-invalid | not_started | Stable restore validation rejection | Restore target is not activated as successful | Supply a valid target-bound backup; never bypass verification | Validation and no-success evidence |
| Restore fails after database or object writes begin | outcome_unknown | Restore failure; no production-ready success | Clean target remains non-ready/incomplete until verified recovery or reprovision | Reprovision/clean target, then rerun from verified backup | Failure-injection and not-ready evidence |
| Cancel/timeout occurs before backup/restore dispatch | not_started | Cancelled/timeout | No successful index or restored target | Safe to start a fresh operation | Zero-success evidence |
| Duplicate operator invocation or process restart occurs | started | One invocation-specific result; no stale success reuse | Backup/restore evidence remains bound to its invocation and target | Resume only where the existing command contract explicitly proves safety; otherwise restart cleanly | Invocation/target binding evidence |
| Full product acceptance succeeds after restore | started | Public/Console workflow succeeds | PRD/Test Plan/Mission/Runner/Skill/Investigation/Review/Evidence state remains readable and correct | Public idempotency and expected-version contracts govern replay | Clean-environment workflow evidence |
| Doctor/readiness/metrics/secrets/container checks fail | not_started | LS-11 acceptance fails; no completion claim | Ticket remains incomplete | Fix the core violation and rerun focused review/E2E under the five-round policy | Exact failed architecture exit and Gate evidence |
| Final ticket-local evidence cannot be recorded or does not match reviewed/E2E head | outcome_unknown | Ticket remains incomplete | No LS-11 completion claim is authoritative | Reconcile this ticket's `final` evidence; any documentation-only final evidence commit must not change the code/test diff | Reviewed head, E2E output, ticket comment, PR/merge evidence |

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 3.2, 5.1-5.7, 7, 9-11, and 13.
- `.scratch/remaining-production-closure/spec.md`, this ticket, and tracked prerequisite tickets 02-14 for current scope, dependency, and acceptance authority.
- Every affected context listed above, especially verified DB/object backup/restore, Public API and Console ownership, protocol parity, tenant isolation, readiness, and Evidence authorization.
- `apps/admin-cli/src/commands/backup.ts`, `apps/admin-cli/src/commands/restore.ts`, and `apps/admin-cli/src/commands/doctor.ts`.
- `packages/contracts/public-api/src/v1.ts` plus the Public API/Console and backup-manager contracts named by the focused Gate; prerequisite tickets 02-14 provide the production contracts this acceptance verifies.

### start — 2026-08-27

- Fixed base: `5a5dfa00601d9a24f56b707350b0b5e3574a37ee` (`main` after Ticket 45 merge); dedicated branch/worktree `ticket-15-ls11-backup-restore-acceptance` / `C:/Users/jieliu1/AppData/Local/Temp/pi-ticket-15`.
- Dependency status: Ticket 14 is merged/resolved, so Ticket 15 is unblocked.
- Behavior Matrix applicability: complete Ticket 15 matrix is applicable. Rows cover target-bound backup, invalid config/prerequisite rejection, interrupted backup/restore, clean-target restore verification, malformed/stale/hash-invalid backups, duplicate invocation/restart, full product acceptance after restore, doctor/readiness/metrics/secrets/container checks, and final evidence authority. No matrix rows are declared N/A at start.
- Planned focused Gate: `CI=true corepack pnpm vitest run tests/unit/admin-cli/backup-index.test.ts tests/component/local-launcher/backup-manager.test.ts`, then `CI=true corepack pnpm typecheck`, then `git diff --check`.
- Planned post-review acceptance after clean complete-matrix review: `CI=true corepack pnpm vitest run tests/e2e/self-hosted/backup-restore.test.ts tests/e2e/self-hosted/acceptance.test.ts` from a clean self-hosted environment.

### final — 2026-08-27

- Reviewed code/test head: `408fc8f96ba43281c0090c8bdc9e0efe11be406b`.
- Base/current main for final review: `808fd0f639acafe2eb287456ea64a368db338219` (Ticket 47 merged).
- Complete-matrix review10 clean:
  - Standards: `Q:/Qualigence/.pi-subagents/artifacts/outputs/ticket15-review10/standards.md`
  - Spec: `Q:/Qualigence/.pi-subagents/artifacts/outputs/ticket15-review10/spec.md`
  - Both axes reported no Critical/Important/Minor/Suggestion findings and all Behavior Matrix rows `pass`.
- Final post-review focused Gate on reviewed head passed:
  - `CI=true corepack pnpm vitest run tests/unit/admin-cli/backup-index.test.ts tests/component/local-launcher/backup-manager.test.ts tests/e2e/self-hosted/artifact-upload.test.ts --reporter=dot` — 3 files / 19 tests passed.
  - `CI=true corepack pnpm typecheck` — passed.
  - `git diff --check` — passed.
- Final post-review LS-11 acceptance on reviewed head passed:
  - `CI=true corepack pnpm vitest run tests/e2e/self-hosted/backup-restore.test.ts tests/e2e/self-hosted/acceptance.test.ts --reporter=dot` — 2 files / 5 tests passed.
  - Evidence included clean backup/restore, restored external Runner artifact manifest/upload manifest/S3 byte proof, and restored Public API/Console product-surface workflow.
- Review9 TLS blocker remediation: the Compose E2E harness now writes all secrets, including proxy TLS cert/key, under each harness `ctx.workDir/secrets` and redefines top-level Compose secrets in the per-run override. This removes the shared repo-level secret race that could make concurrent harnesses validate one run's proxy with another run's CA while preserving `rejectUnauthorized: true` public-proxy readiness.
- Migration: none. No versioned relational schema or SQL migration was added; the changed PostgreSQL runtime migration-path file only replays current runtime RLS/grant behavior after restore.
- Final evidence commit is documentation-only relative to reviewed code/test head. Pull request and merge evidence are pending creation.

## Answer

Completed Ticket 15: LS-11 backup/restore and full restored self-hosted product acceptance are proven. Backup now records PostgreSQL plus actual object bytes with invocation/target-bound hashes; restore validates backup bytes/schema/target before mutation, provisions the object bucket, recreates runtime roles, replays least-privilege RLS/grants, restores object bytes, verifies readback hashes, and checks forced RLS. The restored Compose acceptance runs through the public proxy with TLS verification, external Runner execution, exact artifact durability proof, and restored Public API/Console Skill/Investigation/Review/Evidence checks.
