# 15 — Complete LS-11 backup, restore, and acceptance

**What to build:** Prove the complete Team Self-hosted architecture exit through clean-environment backup/restore and the full product workflow.

**Blocked by:** 14 — Complete OIDC, JWKS, metrics, and readiness.

**Status:** ready-for-agent

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [ ] Backup includes PostgreSQL plus actual object bytes and target-bound hashes; clean restore verifies size/hash and application reads.
- [ ] Compose acceptance covers PRD/Test Plan/Mission/Runner/Skill/Investigation/Review/Evidence through Public API and Console.
- [ ] Doctor/readiness/metrics/secrets/container security have repeatable evidence.
- [ ] Ticket-local final evidence and its merged GitHub PR may claim LS-11 complete only after all architecture exits pass.

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
