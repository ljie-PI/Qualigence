# Evidence Context

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

## Verification

Use Trace/Artifact contracts, Evidence crypto tests, offline capsule restoration, and S3/KMS tests. Read Architecture sections 5.6, 7.3, 8, 9, and 11.
