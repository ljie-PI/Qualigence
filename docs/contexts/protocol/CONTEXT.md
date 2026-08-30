# Protocol Context

## Terms

- **Lease** is an expiring, owner-bound authorization for one accepted Run.
- **Trace acknowledgement** confirms durable ordered ingestion, not mere frame receipt.
- **Artifact acknowledgement** confirms that bounded content and its manifest are durable and hash-verified.

## Ownership

`packages/contracts/runner-protocol` owns transport-safe messages. `packages/protocol-adapters/grpc-runner-protocol` owns wire codecs, gRPC, TLS extraction, and protocol error mapping. Application lifecycle semantics belong inward of this adapter.

## Seams

- `RunnerPeerAuthenticator` turns a peer certificate and hello into authenticated runner scope.
- `RunnerProtocolApplication` owns session, offers, leases, ingest, completion, and closure.
- `RunnerConnectionPort` and `RunnerSession` are the application-facing connection interfaces.
- Artifact manifest/chunk transfer is independent of Trace framing; protocol adapters map it losslessly but do not decide durability or authorization.

## Invariants

- mTLS verifies runner identity before Job payload admission.
- Authenticated Runner scope includes tenant, allowed projects, Runner ID, certificate, and negotiated capabilities. The connection registry is keyed by tenant and Runner ID.
- Tenant, project, Target snapshot, Plan/policy revision, Runner binding, capability, causation, idempotency, and sequence fields map losslessly across contracts and wire frames.
- Transport never issues authoritative leases, resume tokens, Trace acknowledgements, or completion decisions.
- Trace acknowledgement follows durable ingest; duplicate/altered sequence data is detected.
- Capability and scope mismatch fail before Job payload serialization; no target, project, policy, Graph, extension, or action downgrade is implicit.
- Local and Self-hosted use the same protocol semantics; only endpoint and enrolled certificate differ.
- Frames, queues, in-flight batches, and deadlines are bounded and correlated. Unknown or malformed variants fail closed.
- Artifact manifests bind tenant, project, Run, Artifact ID, media type, sensitivity, byte size, SHA-256, and fixed 256 KiB chunking. Chunks are offset-idempotent and resumable from Core-reported missing ranges.
- Artifact acknowledgement follows durable bytes, manifest, size, and hash verification. Trace cannot receive durable acknowledgement while referencing an unacknowledged Artifact.
- After Lease loss, the authenticated former owner may finish only manifests registered while ownership was live; it cannot register new evidence, execute actions, or gain new Run authority.

## Entrypoints

- `packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto`
- `packages/protocol-adapters/grpc-runner-protocol/src/server.ts`
- `packages/protocol-adapters/grpc-runner-protocol/src/client.ts`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 7 and 10.
- Related contexts: `docs/contexts/execution/CONTEXT.md`, `docs/contexts/evidence/CONTEXT.md`, `docs/contexts/storage/CONTEXT.md`, and `docs/contexts/windows/CONTEXT.md`.
- Tracked work: legacy Tickets 05 ([#139](https://github.com/ljie-PI/Qualigence/issues/139)), 09 ([#137](https://github.com/ljie-PI/Qualigence/issues/137)), 11 ([#134](https://github.com/ljie-PI/Qualigence/issues/134)), 23 ([#146](https://github.com/ljie-PI/Qualigence/issues/146)), 26 ([#159](https://github.com/ljie-PI/Qualigence/issues/159)), and 27 ([#160](https://github.com/ljie-PI/Qualigence/issues/160)).

## Verification

Run `corepack pnpm vitest run tests/conformance/runner-protocol tests/contract/runner-spool tests/component/core-runner`.
