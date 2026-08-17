# Deployment Context

## Terms

- **Readiness** means required dependencies and loops are operational; it is stronger than liveness.
- **Release evidence** is a verifiable artifact from required Gates, not a historical status claim.

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

## Entrypoints

- `apps/server/src/main.ts`
- `apps/intelligence-worker/src/main.ts`
- `apps/admin-cli/src/main.ts`
- `apps/local-launcher/src/main.ts`
- `deployments/self-hosted/compose/compose.yaml`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 3, 10, 11, and 13.
- Specs: `docs/superpowers/specs/2026-08-01-ls-06-m1-local-operations-visual-input-design.md`, `docs/superpowers/specs/2026-08-01-ls-11-m2-self-hosted-runtime-deployment-design.md`.

## Verification

Use Local Launcher E2E, Self-hosted Compose/backup tests, Node entrypoint smoke, browser E2E, and release Gate scripts.
