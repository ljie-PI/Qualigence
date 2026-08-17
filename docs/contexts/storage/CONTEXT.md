# Storage Context

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

## Verification

Use relational schema conformance, SQLite/PostgreSQL provider contracts, tenant isolation tests, and backup/restore E2E. Read Architecture sections 9 and 11 and LS-11 before changing this context.
