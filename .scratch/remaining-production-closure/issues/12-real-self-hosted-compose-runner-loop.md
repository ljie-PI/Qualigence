# 12 — Deliver the real Self-hosted Compose Runner loop

**What to build:** Run the complete Self-hosted Mission-to-external-Runner loop in real Compose with truthful readiness and private infrastructure boundaries.

**Blocked by:** 11 — Add resumable Artifact upload to Runner Protocol.

**Status:** ready-for-agent

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
