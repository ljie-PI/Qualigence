# Protocol Context

## Terms

- **Lease** is an expiring, owner-bound authorization for one accepted Run.
- **Trace acknowledgement** confirms durable ordered ingestion, not mere frame receipt.

## Ownership

`packages/contracts/runner-protocol` owns transport-safe messages. `packages/protocol-adapters/grpc-runner-protocol` owns wire codecs, gRPC, TLS extraction, and protocol error mapping. Application lifecycle semantics belong inward of this adapter.

## Seams

- `RunnerPeerAuthenticator` turns a peer certificate and hello into authenticated runner scope.
- `RunnerProtocolApplication` owns session, offers, leases, ingest, completion, and closure.
- `RunnerConnectionPort` and `RunnerSession` are the application-facing connection interfaces.

## Invariants

- mTLS verifies runner identity before Job payload admission.
- Wire mappings are lossless for every required protocol field.
- Transport never issues authoritative leases, resume tokens, Trace acknowledgements, or completion decisions.
- Trace acknowledgement follows durable ingest; duplicate/altered sequence data is detected.
- Capability mismatch fails explicitly; no target or policy downgrade is implicit.

## Entrypoints

- `packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto`
- `packages/protocol-adapters/grpc-runner-protocol/src/server.ts`
- `packages/protocol-adapters/grpc-runner-protocol/src/client.ts`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 7 and 10.
- Spec: `docs/superpowers/specs/2026-08-01-ls-05-m1-core-runner-transport-hardening-design.md`.

## Verification

Run `corepack pnpm vitest run tests/conformance/runner-protocol tests/contract/runner-spool tests/component/core-runner`.
