# 11 — Add resumable Artifact upload to Runner Protocol

**What to build:** Let Runner upload large Artifact manifests and chunks resumably, with Core durability/hash authority and Spool recovery, before Trace may reference them.

**Blocked by:** 10 — Persist Self-hosted Run, Trace, and completion; 16 — Expand multi-step Plan and action contracts.

**Status:** ready-for-agent

**Execution protocol:** Run the focused non-E2E Gate for implementation and review fixes, then complete-matrix scoped review before E2E. After at most five review rounds, a remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create remediation tickets. Record only non-Critical advanced hardening as a GitHub Issue and do not implement it here. Under `## Comments`, record ticket-local `start` evidence (exact base SHA, matrix applicability, and planned Gates), `blocked` evidence only if work actually stops, and `final` evidence (reviewed head and clean Gate/E2E results); link the dedicated GitHub PR, merge commit, and any deferred GitHub Issues when available.

- [ ] Manifest binds tenant, project, Run, Artifact ID, size, SHA-256, media type, sensitivity, and fixed 256 KiB chunking.
- [ ] Core returns missing ranges; chunks are offset-idempotent; ACK follows durable bytes+manifest verification.
- [ ] Trace referencing unacknowledged Artifact is rejected or held without durable acknowledgement.
- [ ] Lost owner may finish only previously registered manifests; restart/reconnect resumes from Spool safely.

## Tracked scope

`.scratch/remaining-production-closure/spec.md` and this ticket track the resumable Artifact data plane.

## Migration

Migration 014 only: Artifact manifests/chunks/ACK state. Migrations 001-013 are immutable when this ticket starts, and migration 015 onward is reserved for later tickets/out of scope for this ticket.

## Affected contexts

- `docs/contexts/protocol/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`
- `docs/contexts/deployment/CONTEXT.md`

## Allowed Files

- `packages/contracts/runner-protocol/src/**`
- `packages/contracts/runner-protocol/proto/**`
- `packages/contracts/runner-protocol/package.json`
- `packages/contracts/runner-protocol/tsconfig.json`
- `packages/protocol-adapters/grpc-runner-protocol/src/**`
- `packages/protocol-adapters/grpc-runner-protocol/package.json`
- `packages/protocol-adapters/grpc-runner-protocol/tsconfig.json`
- `packages/core-modules/evidence/src/**`
- `packages/core-modules/evidence/package.json`
- `packages/core-modules/evidence/tsconfig.json`
- `packages/core-modules/runner-control/src/**`
- `packages/core-modules/runner-control/package.json`
- `packages/core-modules/runner-control/tsconfig.json`
- `packages/storage-providers/relational-kysely/src/**`
- `packages/storage-providers/relational-kysely/package.json`
- `packages/storage-providers/relational-kysely/tsconfig.json`
- `packages/storage-providers/postgres-runtime/src/**`
- `packages/storage-providers/postgres-runtime/package.json`
- `packages/storage-providers/postgres-runtime/tsconfig.json`
- `packages/storage-providers/artifact-fs/src/**`
- `packages/storage-providers/artifact-fs/package.json`
- `packages/storage-providers/artifact-fs/tsconfig.json`
- `packages/storage-providers/artifact-s3/src/**`
- `packages/storage-providers/artifact-s3/package.json`
- `packages/storage-providers/artifact-s3/tsconfig.json`
- `packages/runner-components/runner-spool/src/**`
- `packages/runner-components/runner-spool/package.json`
- `packages/runner-components/runner-spool/tsconfig.json`
- `apps/runner/src/**`
- `apps/runner/package.json`
- `apps/runner/tsconfig.json`
- `apps/server/src/**`
- `apps/server/package.json`
- `apps/server/tsconfig.json`
- `pnpm-lock.yaml`
- `tests/conformance/runner-protocol/**`
- `tests/contract/runner-spool/**`
- `tests/contract/artifact-fs/**`
- `tests/contract/artifact-s3/**`
- `tests/contract/postgres/**`
- `tests/unit/runner/**`
- `.scratch/remaining-production-closure/issues/11-resumable-artifact-upload.md` (`## Comments`/`## Answer` evidence plus GitHub PR/check/artifact references only)
- Post-review acceptance only: `tests/e2e/self-hosted/artifact-upload.test.ts`

## Focused non-E2E Gate

```bash
corepack pnpm vitest run tests/conformance/runner-protocol tests/contract/runner-spool tests/contract/artifact-fs tests/contract/artifact-s3 tests/contract/postgres/artifact-upload.test.ts tests/unit/runner/trace-upload-pump.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

File: `tests/e2e/self-hosted/artifact-upload.test.ts`

```bash
corepack pnpm vitest run tests/e2e/self-hosted/artifact-upload.test.ts
```

Run reconnect/resume against real object storage.

## Behavior Matrix

| Scenario/precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Live owner registers a valid manifest | started | Manifest accepted with missing ranges | Tenant/project/Run-bound manifest and fixed chunk geometry are durable | Exact replay returns current missing ranges | Manifest binding and range evidence |
| Manifest identity, size, hash, media type, sensitivity, chunking, tenant, project, or Run is invalid | not_started | Structured validation/authorization rejection | No manifest or object authority is created | Retry only with corrected authoritative metadata | Rejection and zero-write evidence |
| Valid missing chunk is uploaded | started | Chunk/range acknowledgement | Chunk bytes/range state are durable but Artifact is not final until full verification | Same bytes at the same offset are idempotent | Range map and byte/hash evidence |
| Chunk offset is duplicate with altered bytes, out of bounds, or oversized | not_started | Conflict/validation rejection | Existing bytes and range state remain unchanged | Exact duplicate may replay; altered duplicate never overwrites | Conflict and unchanged-object evidence |
| Upload cancels/times out before manifest registration | not_started | Cancelled/timeout | No new Artifact authority | Fresh valid registration is required | Zero-manifest evidence |
| Upload cancels/times out after manifest/chunk dispatch | outcome_unknown | Outcome unknown; no final ACK inferred | Registered manifest and any durably accepted chunks remain resumable | Query missing ranges and resume from Spool | Spool/range reconciliation evidence |
| Full bytes and manifest verify | started | Durable Artifact ACK | Verified manifest/object/ACK commit; only then may Trace reference it | ACK replay is stable | Object size/SHA-256 plus durable ACK evidence |
| Trace references an unacknowledged Artifact | not_started | Rejected or held without Trace durable ACK | Trace acknowledgement does not advance past the unresolved reference | Retry after Artifact ACK | Trace/Artifact ordering evidence |
| Lease is lost after manifest registration | started | Previously registered upload may resume; new manifest is rejected | Existing manifest authority remains bounded; no action/new-manifest authority | Resume only registered ranges under the original identity | Lost-owner boundary evidence |
| Restart/reconnect or concurrent uploaders race | started | Canonical missing ranges/ACK | Spool and Server reconcile to one Artifact object and ACK | Resume idempotently; no cross-tenant physical/logical dedupe | Restart/concurrency and tenant-isolation evidence |
| Object/manifests/ACK terminal persistence fails | outcome_unknown | No final ACK | Partial durable state remains resumable or transaction rolls back; Trace remains unacknowledged | Reconcile object, manifest, and ranges before retry | Failure-injection and no-premature-ACK evidence |

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.6, 7, 8, 9, and 11.
- `.scratch/remaining-production-closure/spec.md`, this ticket, and the tracked prerequisite tickets named in `Blocked by` for current scope, dependency, and acceptance authority.
- The affected context documents listed above, especially separate large-object transfer, hash verification, durable ACK, append-only Trace, lost-lease bounds, and tenant isolation.
- `packages/contracts/runner-protocol/src/**`, its protobuf schema, `packages/core-modules/evidence/src/persistence-ports.ts`, and `packages/runner-components/runner-spool/src/**`.
- The protocol, Spool, Artifact provider, PostgreSQL, and Runner tests named by the focused Gate.
