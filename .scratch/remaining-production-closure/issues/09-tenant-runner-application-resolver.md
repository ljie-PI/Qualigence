# 09 — Resolve tenant-bound Runner applications

**What to build:** Resolve each authenticated Self-hosted Runner connection to a tenant-bound application graph whose stores open operation-scoped tenant transactions.

**Blocked by:** 08 — Wire the production Intelligence Result consumer.

**Status:** claimed

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [ ] Registry identity is keyed by tenant ID and Runner ID and retains project/capability scope.
- [ ] No application connection holds a completed transaction or exposes unscoped storage.
- [ ] Payload admission rejects wrong tenant, project, certificate, Runner ID, or capability before Job serialization.
- [ ] Multi-tenant component test proves same Runner IDs cannot collide or supersede each other.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track tenant-bound Runner application composition.

## Migration

None. This ticket may not add or modify a schema migration.

## Affected contexts

- `docs/contexts/protocol/CONTEXT.md`
- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`
- `docs/contexts/deployment/CONTEXT.md`

## Allowed Files

- `apps/server/src/self-hosted-runner-protocol.ts`
- `apps/server/package.json`
- `apps/server/tsconfig.json`
- `packages/core-application/src/**`
- `packages/core-application/package.json`
- `packages/core-application/tsconfig.json`
- `packages/core-modules/runner-control/src/**`
- `packages/core-modules/runner-control/package.json`
- `packages/core-modules/runner-control/tsconfig.json`
- `packages/protocol-adapters/grpc-runner-protocol/src/**`
- `packages/protocol-adapters/grpc-runner-protocol/package.json`
- `packages/protocol-adapters/grpc-runner-protocol/tsconfig.json`
- `packages/storage-providers/postgres-runtime/src/**`
- `packages/storage-providers/postgres-runtime/package.json`
- `packages/storage-providers/postgres-runtime/tsconfig.json`
- `pnpm-lock.yaml`
- `tests/contract/runner-identity/**`
- `tests/contract/postgres/**`
- `tests/conformance/runner-protocol/**`
- `tests/component/core-runner/**`
- `.scratch/remaining-production-closure/issues/09-tenant-runner-application-resolver.md` (`## Comments`/`## Answer` evidence plus GitHub PR/check/artifact references only)
- Post-review acceptance only: `tests/e2e/self-hosted/tenant-runner-isolation.test.ts`

## Focused non-E2E Gate

```bash
corepack pnpm vitest run tests/contract/runner-identity tests/contract/postgres/tenant-isolation.test.ts tests/conformance/runner-protocol tests/component/core-runner
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

File: `tests/e2e/self-hosted/tenant-runner-isolation.test.ts`

```bash
corepack pnpm vitest run tests/e2e/self-hosted/tenant-runner-isolation.test.ts
```

Run the two-tenant, same-Runner-ID admission and isolation cases.

## Behavior Matrix

| Scenario/precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Valid mTLS peer and hello resolve a tenant-bound application | started | Authenticated Runner session | Registry entry is keyed by tenant ID and Runner ID with project/capability scope | Same authenticated identity may reconnect through protocol resume rules | Identity, registry key, and tenant-store evidence |
| Certificate, tenant, Runner ID, project, or capability scope is invalid | not_started | Structured authentication/admission rejection | No registry entry, transaction-backed application, or Job payload is admitted | Retry only with valid enrolled identity/scope | Rejection and pre-serialization zero-admission evidence |
| Two tenants connect using the same Runner ID | started | Two independent authenticated sessions | Distinct `(tenantId, runnerId)` registry entries and isolated stores | Reconnect affects only the matching compound identity | Two-tenant registry/RLS evidence |
| Capability mismatch is discovered before Job serialization | not_started | Explicit capability rejection | No payload or lease is exposed to the Runner | No implicit downgrade; retry after capability or Job changes | Pre-serialization rejection evidence |
| Connection cancels/times out before authentication completes | not_started | Connection closed/timeout | No application graph or registry entry survives | Fresh authentication is required | Cleanup and zero-registration evidence |
| Connection drops after registration or during an operation | started | Protocol disconnect; operation result follows its own authoritative store | Registry generation is closed/fenced; operation-scoped transaction commits or rolls back | Resume/reconnect must reauthenticate and cannot reuse an expired transaction | Disconnect cleanup and transaction-lifetime evidence |
| Registration outcome is uncertain during connection failure | outcome_unknown | No Job admission until registry ownership is reconciled | At most one current generation for the compound identity | Reconnect fences the old generation before admission | Generation-fencing evidence |
| Duplicate hello/resume is replayed | started | Canonical resumed/current session or stable rejection | One current registry owner remains | Exact valid replay follows resume semantics; altered replay conflicts | Protocol conformance evidence |
| Concurrent connections race for the same tenant/Runner identity | started | One current generation; stale connection is fenced | Registry replacement/supersession is tenant-local and atomic | Loser cannot admit or acknowledge Jobs | Concurrency and same-ID isolation evidence |
| Tenant transaction/store operation fails | outcome_unknown | Fail-closed protocol/storage error | Transaction closes; no unscoped or completed transaction escapes | Retry opens a new tenant-scoped transaction | RLS, rollback, and no-long-lived-transaction evidence |

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 3.2, 5.5, 7, 9.1, and 10.
- `.scratch/remaining-production-closure/spec.md`, this ticket, and the tracked prerequisite tickets named in `Blocked by` for current scope, dependency, and acceptance authority.
- The affected context documents listed above, especially mTLS-before-payload, thin transport, operation-scoped tenant storage, forced RLS, and compound Runner identity.
- `packages/core-modules/runner-control/src/runner-protocol-application.ts` and `packages/protocol-adapters/grpc-runner-protocol/src/server.ts`.
- The Runner identity, protocol conformance, and tenant-isolation contracts named by the focused Gate.

## Comments

- start: base SHA `6e8e4bdad38b934ab9f414305bb4c944a8942fd8`; behavior matrix applies in full because tenant-bound Runner session resolution, registry ownership, payload admission, operation-scoped storage, reconnect/fencing, concurrency and failure outcomes are stateful, side-effecting, retrying, timeout-sensitive, and terminal-sensitive; planned Gates: `CI=true corepack pnpm vitest run tests/contract/runner-identity tests/contract/postgres/tenant-isolation.test.ts tests/conformance/runner-protocol tests/component/core-runner`, `CI=true corepack pnpm typecheck`, and `git diff --check`.
- review-fix: complete-matrix review head `7918627bd97b5bd754e0506a8ec7b3ba2506ca1d` reported the Important core blocker that stale/superseded Runner connection objects could admit and serialize new Job offers after resume/supersession. Fixed by commit `03f3ec31be6322e2a4e1afeaa2e9cb615837137e`, which disposes the released connection on successful supersession and fences `ServerRunnerConnection.offer()` against current registry ownership before admission and again after `createOffer(...)` before `call.write(...)`. Gates run after the fix commit: `CI=true corepack pnpm vitest run tests/contract/runner-identity tests/contract/postgres/tenant-isolation.test.ts tests/conformance/runner-protocol tests/component/core-runner` (passed, 12 files / 131 tests), `CI=true corepack pnpm typecheck` (passed), and `git diff --check` (passed). Not marking resolved and no PR evidence added pending fresh complete-matrix review.
- review2-fix: complete-matrix review head `e0bc41ebdd973a8422e47b4f037e6f9837fb16f9` reported an Important core blocker that PostgreSQL Mission scheduling initialized `execution_runs.next_sequence_number` to `0` while Runner Trace events start at sequence `1`, causing the first valid Self-hosted Runner event to be rejected as `sequence_gap`; it also noted the required post-review E2E file was absent. Fixed by commit `46388cf53e1b90bcd59fc9246df30e0a98fb8f6c`, which initializes PostgreSQL Mission-scheduled runs at sequence `1`, adds PostgreSQL coverage proving first Runner event sequence `1` is accepted and later gaps reject, and adds `tests/e2e/self-hosted/tenant-runner-isolation.test.ts` for two-tenant same Runner ID admission/isolation plus project/capability rejection. Gates run after the fix commit: `CI=true corepack pnpm vitest run tests/contract/runner-identity tests/contract/postgres/tenant-isolation.test.ts tests/conformance/runner-protocol tests/component/core-runner` (passed, 12 files / 132 tests), `CI=true corepack pnpm vitest run tests/e2e/self-hosted/tenant-runner-isolation.test.ts` (passed, 1 file / 1 test), `CI=true corepack pnpm typecheck` (passed), and `git diff --check` (passed). Not marking resolved and no PR evidence added pending fresh complete-matrix review.
