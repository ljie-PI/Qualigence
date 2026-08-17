# Evidence Context

## Terms

- **Artifact** is content-addressed evidence bytes stored outside Trace events.
- **Capsule** is a bounded, encrypted evidence subset with scoped decryption policy.

## Ownership

`packages/core-modules/evidence`, `packages/execution-application`, Artifact providers, `packages/runner-components/evidence-capsule`, and KMS providers own Trace, Artifact, Finding, and Capsule behavior.

## Seams

- `TraceIngestor` owns ordered, idempotent Trace persistence.
- Artifact stores persist bytes and manifests separately from domain decisions.
- `KeyManagementProvider` owns wrapping, unwrapping, rotation, revocation, and audit.

## Invariants

- Trace is append-only and events reference content-addressed evidence.
- Large bytes stay out of protocol event payloads.
- Raw secrets and resolved `valueRef` content never enter Trace, Finding, logs, or public DTOs.
- Decryption validates tenant, case, purpose, policy, TTL, and revocation before plaintext is returned.
- Revoke precedes ciphertext deletion; audit failure fails sensitive operations closed.

## Entrypoints

- `packages/core-modules/evidence/src/trace-ingestor.ts`
- `packages/execution-application/src/artifact-recording-observer.ts`
- `packages/runner-components/evidence-capsule/src/capsule-builder.ts`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.6, 7.3, 8, 9, and 11.
- Specs: `docs/superpowers/specs/2026-08-01-ls-01-m1-local-persistence-design.md`, `docs/superpowers/specs/2026-08-01-ls-10-m2-investigation-review-evidence-design.md`.

## Verification

Run `corepack pnpm vitest run tests/contract/artifact-fs tests/contract/artifact-s3 tests/contract/evidence-crypto tests/contract/kms-self-hosted tests/component/investigation`.
