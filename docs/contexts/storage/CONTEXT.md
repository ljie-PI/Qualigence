# Storage Context

## Terms

- **Provider contract** is one behavior suite run unchanged against SQLite and PostgreSQL adapters.
- **RLS** constrains PostgreSQL application queries to an explicitly bound tenant.

## Ownership

`packages/storage-providers/relational-kysely` owns logical schema and catalog. SQLite and PostgreSQL runtime packages implement provider-specific connections, locks, and stores. Domain modules depend on provider-neutral ports.

## Seams

- Provider contracts run unchanged against SQLite and PostgreSQL adapters.
- `TenantTransactionProvider` exposes only transactions with tenant context set.
- Migration code is offline-only; runtime roles do not receive owner or migration privileges.

## Invariants

- Historical migrations 001-005 are immutable.
- New schema is additive and versioned; upgrades require verified backup evidence.
- PostgreSQL tenant tables use forced RLS and tenant-inclusive keys or references.
- Every persistence decision that protects ownership, idempotency, or completion is atomic.
- SQLite and PostgreSQL behavior agrees through shared contracts, not duplicated domain code.

## Entrypoints

- `packages/storage-providers/relational-kysely/src/migrations.ts`
- `packages/storage-providers/sqlite-runtime/src/database.ts`
- `packages/storage-providers/postgres-runtime/src/postgres-runtime.ts`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 9 and 11.
- Specs: `docs/superpowers/specs/2026-08-01-ls-01-m1-local-persistence-design.md`, `docs/superpowers/specs/2026-08-01-ls-11-m2-self-hosted-runtime-deployment-design.md`.

## Verification

Use relational schema conformance, SQLite/PostgreSQL provider contracts, tenant isolation tests, and backup/restore E2E.
