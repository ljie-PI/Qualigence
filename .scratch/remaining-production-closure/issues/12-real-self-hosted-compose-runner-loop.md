# 12 — Deliver the real Self-hosted Compose Runner loop

**What to build:** Run the complete Self-hosted Mission-to-external-Runner loop in real Compose with truthful readiness and private infrastructure boundaries.

**Blocked by:** 11 — Add resumable Artifact upload to Runner Protocol.

**Status:** claimed

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [ ] Server exposes authenticated Runner gRPC while PostgreSQL/MinIO remain private.
- [ ] Server, Worker, Console, proxy, dispatch, Result consumer, and Runner data-plane readiness reflect dependencies.
- [ ] External Runner completes Mission -> Run -> Trace/Artifact -> completion without in-process substitution.
- [ ] Required Docker absence fails explicitly rather than skipping the Gate.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track the real Self-hosted Compose Runner loop.

## Migration

None. This ticket composes schemas delivered by prerequisite tickets and may not add or modify a schema migration.

## Affected contexts

- `docs/contexts/deployment/CONTEXT.md`
- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/protocol/CONTEXT.md`
- `docs/contexts/intelligence/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/product/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`

## Allowed Files

- `apps/server/**`
- `deployments/self-hosted/compose/**`
- `tests/component/server/**`
- `.scratch/remaining-production-closure/issues/12-real-self-hosted-compose-runner-loop.md` (`## Comments`/`## Answer` evidence plus GitHub PR/check/artifact references only)
- Post-review acceptance only: `tests/e2e/self-hosted/compose.test.ts`
- Post-review acceptance only: `tests/e2e/self-hosted/external-runner.test.ts`

## Focused non-E2E Gate

```bash
docker compose --env-file deployments/self-hosted/compose/.env.example -f deployments/self-hosted/compose/compose.yaml config --quiet
corepack pnpm vitest run tests/component/server
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

Files: `tests/e2e/self-hosted/compose.test.ts` and `tests/e2e/self-hosted/external-runner.test.ts`

```bash
corepack pnpm vitest run tests/e2e/self-hosted/compose.test.ts tests/e2e/self-hosted/external-runner.test.ts
```

Run real Compose with a separate external Runner and no in-process substitute. Required Docker absence is the stable failure `DockerUnavailable`, never a skip.

## Behavior Matrix

| Scenario/precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| All Compose dependencies and loops become operational | started | Live and ready endpoints are healthy | Existing PostgreSQL, object, dispatch, Result, Runner, and readiness state is available | Restart resumes from durable component state | Compose service health and readiness evidence |
| Configuration, secret mount, TLS, role, or dependency validation fails before startup | not_started | Stable startup/configuration failure | No falsely ready service or partial workflow claim | Correct configuration/dependency, then restart | Compose config/component rejection evidence |
| Mission runs through external Runner successfully | started | Public Mission/Run/Trace/Artifact completion | Prerequisite-ticket states persist through production processes | Public idempotency/protocol replay rules remain authoritative | External-process Mission-to-completion evidence |
| Auth, policy, tenant, project, or capability admission fails | not_started | Existing structured API/protocol rejection | No unauthorized Job, Trace, Artifact, or Result mutation | Retry only after authority/input changes | Cross-service zero-write and rejection evidence |
| Shutdown/cancel occurs before dispatch | not_started | Orderly stopped/unready result | Scheduled work remains durable and undispatched | Restart resumes the bound workflow | Pending-work and shutdown evidence |
| Process/network failure occurs after external dispatch | outcome_unknown | Readiness degrades; terminal outcome is not guessed | Durable outbox, lease, Spool, Result, and Artifact states remain reconcilable | Restart/reconnect through existing idempotent protocols | Failure/recovery and no-duplicate-completion evidence |
| Duplicate public/protocol requests cross process restarts | started | Canonical existing result/ACK | One semantic Mission, lease, Artifact ACK, Result disposition, and completion remain | Stable keys/sequence identities recover original outcomes | Full-loop replay evidence |
| Conflicting replay crosses service boundaries | not_started | Existing conflict/rejection envelope | Original state remains unchanged | Caller must correct intent/use new authority as contract permits | Conflict and unchanged-state evidence |
| Server, Worker, proxy, Console, or external Runner restarts | started | Temporary not-ready followed by recovery | No in-memory substitute is required; durable work resumes | Bounded retry/backoff; no busy spin | Restart/readiness transition evidence |
| Required terminal persistence or dependency fails | outcome_unknown | No successful readiness/completion claim | Prerequisite atomicity rules preserve or roll back durable state | Recover dependency and reconcile before replay | Dependency failure and fail-closed readiness evidence |

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 3.2, 5.5-5.6, 7, 9-11, and 13.
- `.scratch/remaining-production-closure/spec.md`, this ticket, and the tracked prerequisite tickets named in `Blocked by` for current scope, dependency, and acceptance authority.
- Every affected context listed above, especially real Self-hosted composition, thin adapters, private infrastructure, readiness stronger than liveness, and external Runner protocol parity.
- `apps/server/src/main.ts`, `apps/server/src/server.ts`, and `deployments/self-hosted/compose/compose.yaml`.
- Public API, Runner Protocol, storage, Intelligence, and Evidence contracts delivered by prerequisite tickets, plus the current component/E2E tests named by this ticket's Gates; this ticket composes them without redefining them.

## Comments

- start: base SHA `34aeb423ef655ca04f8c69736e0a4d8b1ac9621e`; predecessor Ticket 11 evidence is merged in current base via PR `https://github.com/ljie-PI/Qualigence/pull/115`, merge commit `bd5155e`, reviewed code/test head `abc350bfe86678dbb87c80fe4ee8e8cc47dffeaf`, and final Ticket 11 Gates/E2E recorded as clean in `.scratch/remaining-production-closure/issues/11-resumable-artifact-upload.md`. Behavior matrix applies in full because the real Self-hosted Compose Runner loop is stateful, side-effecting, authenticated, dependency/readiness-sensitive, retry/reconnect-sensitive, restart-sensitive, timeout/unknown-outcome-sensitive, and terminal-completion-sensitive. Planned Gates: `docker compose --env-file deployments/self-hosted/compose/.env.example -f deployments/self-hosted/compose/compose.yaml config --quiet`, `CI=true corepack pnpm vitest run tests/component/server`, `CI=true corepack pnpm typecheck`, and `git diff --check`. Maintainer-approved ingress exception for this ticket: publish one dedicated authenticated Runner gRPC host port to preserve end-to-end mTLS peer-certificate authentication; PostgreSQL and MinIO remain private/internal-only and no additional public infrastructure ports are in scope. Maintainer-approved lockfile scope expansion: update only the `apps/server` importer in `pnpm-lock.yaml` for the existing workspace dependency `@qualigence/grpc-runner-protocol`, required by the Server-owned Runner gRPC composition and frozen Docker installs.
- review-fix: complete-matrix review head `bc1b34224e38fb559e2648d4e4993731a1b8b364` reported core blockers for read-only Compose skill-signing state, non-durable `/tmp` Runner Artifact ACK bytes plus misleading MinIO readiness, partial startup cleanup after HTTP bind, and stale/missing post-review acceptance topology. Fix commit `74168aefa7d9635746b0e1fc15f9fc11b2899f50` sets explicit durable Server state paths and named volumes (`artifactdata`, `skill_signing_data`), keeps Runner Artifact readiness aligned with the actual configured local data-plane store, closes already-open listeners/resources on startup failure, allows exactly proxy `443` plus Server Runner gRPC `50555` while PostgreSQL/MinIO remain private, adds `QUALIGENCE_SERVER_PG_ROLE` to Compose acceptance env, removes in-process full-loop substitution from Compose acceptance, and adds `tests/e2e/self-hosted/external-runner.test.ts` as an external Runner acceptance guard. Review-fix Gates run before the ticket evidence update: `docker compose --env-file deployments/self-hosted/compose/.env.example -f deployments/self-hosted/compose/compose.yaml config --quiet` passed; `CI=true corepack pnpm vitest run tests/component/server` passed (1 file / 7 tests); `CI=true corepack pnpm typecheck` passed; `git diff --check` passed. Targeted post-review acceptance checks run: `CI=true corepack pnpm vitest run tests/e2e/self-hosted/compose.test.ts` passed (1 file / 8 tests); `CI=true corepack pnpm vitest run tests/e2e/self-hosted/external-runner.test.ts` failed with stable `ExternalRunnerUnavailable` because no real external Runner harness command was configured, so no final E2E/PR evidence is claimed. Ticket status remains `claimed`; fresh complete-matrix review is required before post-review full-loop E2E/PR work.
- review2-fix: complete-matrix Standards review head `daa3731019da44c1fa6be50e3ed28f91e2136101` reported an Important core blocker that fresh `artifactdata` and `skill_signing_data` named volumes mounted at `/var/lib/qualigence/artifacts` and `/var/lib/qualigence/skill-signing` are root-owned and unwritable by the non-root read-only Server runtime. Fix commit `0b27ddb774d70a0c25e3e83f9688df0b00f62622` adds the one-shot root `server-volume-permissions` Compose service with no network, no secrets, no public ports, only `CHOWN` capability, and only the two Server state volume mounts; it creates/chmods/chowns both state directories to uid/gid `1000:1000`, and Server now depends on `service_completed_successfully` before startup while remaining non-root/read-only. Compose README and secrets notes document the permission-prep dependency and private boundary. Tests now assert the service topology/dependency and verify fresh Docker named volumes become writable by uid/gid `1000` under a read-only, non-root runtime after the init command. Gates run for this review2 fix before the evidence update: `docker compose --env-file deployments/self-hosted/compose/.env.example -f deployments/self-hosted/compose/compose.yaml config --quiet` passed; `CI=true corepack pnpm vitest run tests/component/server` passed (1 file / 8 tests); `CI=true corepack pnpm vitest run tests/e2e/self-hosted/compose.test.ts` passed (1 file / 10 tests, including the permission probe); `CI=true corepack pnpm typecheck` passed; `git diff --check` passed. Guard check `CI=true corepack pnpm vitest run tests/e2e/self-hosted/external-runner.test.ts` still fails closed with stable `ExternalRunnerUnavailable` because no real external Runner harness command is configured, so no final full-loop E2E/PR evidence is claimed. Ticket status remains `claimed`; fresh complete-matrix review is required at the new head before post-review full-loop E2E/PR work.
