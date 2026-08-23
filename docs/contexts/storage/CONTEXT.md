# Storage Context

## Terms

- **Provider contract** is one behavior suite run unchanged against SQLite and PostgreSQL adapters.
- **RLS** constrains PostgreSQL application queries to an explicitly bound tenant.
- **Target-bound backup** is a fresh, verified backup tied to one database identity, migration invocation, source schema version, and intended target version.

## Ownership

`packages/storage-providers/relational-kysely` owns logical schema and catalog. SQLite and PostgreSQL runtime packages implement provider-specific connections, locks, and stores. Domain modules depend on provider-neutral ports.

## Seams

- Provider contracts run unchanged against SQLite and PostgreSQL adapters.
- `TenantTransactionProvider` exposes only transactions with tenant context set.
- Migration code is offline-only; runtime roles do not receive owner or migration privileges.
- Schema and provider-neutral query behavior live in the relational storage module; dialect, connection, lock, and tenant-transaction mechanics remain in runtime providers.

## Invariants

- Every released or applied migration is immutable. New schema appends the next version; binaries reject databases newer than their supported version.
- Persisted schemas upgrade strictly one version at a time with no skipped transformation. Migration is offline, owner-role, lock-protected, and preceded by a fresh verified target-bound backup for that invocation.
- Runtime Server and Worker roles have no DDL, owner, or `BYPASSRLS` authority; failed migration preserves the source and backup rather than attempting schema downgrade.
- PostgreSQL tenant tables use forced RLS and tenant-inclusive keys or references.
- Every tenant-owned operation runs in a short transaction with explicit tenant context. Runtime roles are non-owner; missing tenant context returns no rows or rejects writes, and no long-lived transaction-backed store escapes its operation.
- Worker cross-tenant access is limited to authenticated Intelligence lease/result/wakeup operations and grants no other tenant-table access.
- Every persistence decision that protects ownership, idempotency, or completion is atomic.
- SQLite and PostgreSQL behavior agrees through shared contracts, not duplicated domain code.
- Backup/restore includes database state and every referenced object byte; success requires target-bound hashes, clean-target restore, byte verification, and application-level reads.

## Entrypoints

- `packages/storage-providers/relational-kysely/src/migrations.ts`
- `packages/storage-providers/sqlite-runtime/src/database.ts`
- `packages/storage-providers/postgres-runtime/src/postgres-runtime.ts`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 9 and 11.
- Related contexts: `docs/contexts/product/CONTEXT.md`, `docs/contexts/intelligence/CONTEXT.md`, `docs/contexts/evidence/CONTEXT.md`, and `docs/contexts/deployment/CONTEXT.md`.
- Tracked work: `.scratch/remaining-production-closure/issues/06-skill-version-management-loop.md`, `.scratch/remaining-production-closure/issues/07-durable-intelligence-leases-results.md`, `.scratch/remaining-production-closure/issues/10-self-hosted-run-trace-completion.md`, and `.scratch/remaining-production-closure/issues/15-ls11-backup-restore-acceptance.md`.

## Verification

Run `corepack pnpm vitest run tests/conformance/storage tests/contract/sqlite tests/contract/postgres tests/e2e/self-hosted/backup-restore.test.ts`.
