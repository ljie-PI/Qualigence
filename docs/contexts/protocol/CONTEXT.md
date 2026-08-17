# Protocol Context

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

## Verification

Use `tests/conformance/runner-protocol`, `tests/contract/runner-spool`, and `tests/component/core-runner`. Read Architecture sections 7 and 10, LS-05, and the exact closure Task before changing protocol fields.
