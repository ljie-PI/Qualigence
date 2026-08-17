# Deployment Context

## Ownership

`apps/server`, `apps/intelligence-worker`, `apps/admin-cli`, `apps/local-launcher`, `deployments`, `Dockerfile`, and observability packages own operations and release composition.

## Seams

- Server owns Self-hosted public HTTP and runner gRPC composition.
- Admin CLI owns explicit migrate, doctor, backup, and restore operations.
- Launcher supervises Local processes without importing domain persistence.
- Console is a static Public API client; it never connects to storage, KMS, or Runner directly.

## Invariants

- Local binds its product API to loopback and uses bootstrap tokens only once.
- Self-hosted runtime uses least-privilege roles, file-mounted secrets, TLS, immutable images, and explicit migration.
- Health readiness reflects required dependencies, not merely an open port.
- Backup/restore verifies database and object bytes before success is reported.
- Logs, metrics, and release metadata exclude secrets and high-cardinality evidence content.

## Verification

Use Local Launcher E2E, Self-hosted Compose/backup tests, Node entrypoint smoke, browser E2E, and release Gate scripts. Read Architecture sections 3, 10, 11, and 13.
