# Deployment Context

## Terms

- **Readiness** means required dependencies and loops are operational; it is stronger than liveness.
- **Release evidence** is a verifiable artifact from required Gates, not a historical status claim.
- **Release manifest** is a schema-validated binding among one repository commit, immutable image digests, SBOMs, provenance attestations, required Gate artifacts, and signed platform evidence.

## Ownership

`apps/server`, `apps/intelligence-worker`, `apps/admin-cli`, `apps/local-launcher`, `deployments`, `Dockerfile`, and observability packages own operations and release composition.

## Seams

- Server owns Self-hosted public HTTP and runner gRPC composition.
- Admin CLI owns explicit migrate, doctor, backup, and restore operations.
- Launcher supervises Local processes without importing domain persistence.
- Console is a static Public API client; it never connects to storage, KMS, or Runner directly.
- The reverse proxy is the only public Compose ingress; PostgreSQL, object storage, and administrative dependencies remain private.

## Invariants

- Local binds its product API to loopback and uses bootstrap tokens only once.
- Self-hosted runtime uses least-privilege roles, file-mounted secrets, TLS, immutable images, and explicit migration.
- Liveness is cheap process health. Readiness reflects PostgreSQL, object storage, KMS, OIDC/JWKS, Runner gRPC, dispatch, Intelligence Result consumption, Console/proxy routing, and each required loop's ability to make progress.
- Compose acceptance uses real Server, Worker, Console, proxy, PostgreSQL, object storage, and an external Runner. In-process substitutes and missing-infrastructure skips are not production evidence.
- OIDC uses Authorization Code with PKCE, per-attempt state/nonce, exact redirect matching, approved algorithms, and bounded JWKS timeout/cache/rotation. Unknown issuer, audience, tenant, or role fails closed; browser tokens are not persisted.
- Backup/restore verifies database and actual object bytes before success is reported. Clean-target restore rechecks hashes/sizes and application reads; an external object store requires its own declared and exercised backup contract.
- Logs, metrics, and release metadata exclude secrets and high-cardinality evidence content.
- Metrics and traces expose queue, Lease, reconnect, projection, model usage, Finding, Artifact, KMS, Evidence, and loop health without prompt, URL query, user text, or Artifact-ID labels.
- Runtime images are minimal, non-root, immutable-digest artifacts without source, tests, development stores, or development-only dependencies. Third-party images and CI actions are immutably pinned.
- Release artifacts include SBOM and provenance. The Release manifest rejects tags and missing, duplicate, stale, unsigned, or cross-commit evidence; release Compose consumes digest-only image references.

## Entrypoints

- `apps/server/src/main.ts`
- `apps/intelligence-worker/src/main.ts`
- `apps/admin-cli/src/main.ts`
- `apps/local-launcher/src/main.ts`
- `deployments/self-hosted/compose/compose.yaml`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 3, 10, 11, and 13.
- Related contexts: `docs/contexts/product/CONTEXT.md`, `docs/contexts/intelligence/CONTEXT.md`, `docs/contexts/evidence/CONTEXT.md`, and `docs/contexts/storage/CONTEXT.md`.
- Tracked work: legacy Tickets 12 ([#142](https://github.com/ljie-PI/Qualigence/issues/142)), 14 ([#147](https://github.com/ljie-PI/Qualigence/issues/147)), 15 ([#155](https://github.com/ljie-PI/Qualigence/issues/155)), 33 ([#166](https://github.com/ljie-PI/Qualigence/issues/166)), 34 ([#169](https://github.com/ljie-PI/Qualigence/issues/169)), and 35 ([#165](https://github.com/ljie-PI/Qualigence/issues/165)); integrated human and release acceptance is Ticket 48 ([#181](https://github.com/ljie-PI/Qualigence/issues/181)).

## Verification

Run `corepack pnpm vitest run tests/e2e/local-launcher.test.ts tests/e2e/self-hosted tests/e2e/web-console tests/smoke/node-entrypoints.test.ts`.
