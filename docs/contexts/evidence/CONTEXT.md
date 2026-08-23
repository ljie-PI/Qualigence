# Evidence Context

## Terms

- **Artifact** is content-addressed evidence bytes stored outside Trace events.
- **Capsule** is a bounded, encrypted evidence subset with scoped decryption policy.
- **Artifact Manifest** is the immutable tenant/project/Run-scoped identity, hash, size, media type, sensitivity, location, and retention metadata for Artifact bytes.

## Ownership

`packages/core-modules/evidence`, `packages/execution-application`, Artifact providers, `packages/runner-components/evidence-capsule`, and KMS providers own Trace, Artifact, Finding, and Capsule behavior.

## Seams

- `TraceIngestor` owns ordered, idempotent Trace persistence.
- Artifact stores persist bytes and manifests separately from domain decisions.
- `KeyManagementProvider` owns wrapping, unwrapping, rotation, revocation, and audit.
- Evidence authorization maps Public API requests to tenant/project/purpose-scoped metadata or bytes without exposing storage or KMS credentials.

## Invariants

- Trace is append-only and events reference content-addressed evidence.
- Large bytes stay out of protocol event payloads.
- Raw secrets and resolved `valueRef` content never enter Trace, Finding, logs, or public DTOs.
- An Artifact is referenceable only after its bytes and Manifest are durable and size/hash-verified. Upload interruption remains resumable; unregistered bytes are reconciled as orphans, never returned as evidence.
- Artifact deduplication is tenant-local. Logical references and object keys remain tenant/project/Run scoped; no cross-tenant physical or logical deduplication is permitted.
- A Capsule contains only policy-allowed, bounded, Runner-redacted bytes and immutable provenance. `local_only` is a distinct disposition and never creates ciphertext, a wrapped DEK, or a remote upload record.
- Decryption validates tenant, case, purpose, policy, TTL, and revocation before plaintext is returned.
- Capsule lifecycle is `active -> revoking -> revoked -> deleting -> deleted`. Revocation and its durable audit succeed before ciphertext deletion starts.
- Revoke failure retains ciphertext; delete failure retains an auditable, retryable `revoked` record. Audit failure fails sensitive operations closed, and KMS or storage failure never falls back to plaintext.

## Entrypoints

- `packages/core-modules/evidence/src/trace-ingestor.ts`
- `packages/execution-application/src/artifact-recording-observer.ts`
- `packages/runner-components/evidence-capsule/src/capsule-builder.ts`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.6, 7.3, 8, 9, and 11.
- Related contexts: `docs/contexts/protocol/CONTEXT.md`, `docs/contexts/storage/CONTEXT.md`, and `docs/contexts/deployment/CONTEXT.md`.
- Tracked work: `.scratch/remaining-production-closure/issues/11-resumable-artifact-upload.md`, `.scratch/remaining-production-closure/issues/13-evidence-api-s3-kms.md`, and `.scratch/remaining-production-closure/issues/15-ls11-backup-restore-acceptance.md`.

## Verification

Run `corepack pnpm vitest run tests/contract/artifact-fs tests/contract/artifact-s3 tests/contract/evidence-crypto tests/contract/kms-self-hosted tests/component/investigation`.
