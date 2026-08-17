# Execution Context

## Ownership

`packages/core-application`, `packages/runner-kernel`, `packages/execution-application`, `apps/core-daemon`, and `apps/runner` own execution lifecycle composition. Core is the authority for Mission, Run ownership, Lease, completion, and deterministic policy. Runner executes offered work and appends protocol events; it does not write aggregates.

## Seams

- `RunnerProtocolApplication` separates transport from lifecycle authority.
- `RunnerControlStore` holds durable session, lease, and completion decisions.
- `RunnerPolicyGate` enforces immutable policy snapshots.
- `RunCompletionSink` applies an accepted completion to the corresponding durable Run.

## Invariants

- Lease, expected version, policy, budget, and terminal state are deterministic decisions.
- A Run has one authoritative owner and one terminal completion.
- An expired, lost, cancelled, or blocked Run never gains a new action permit.
- Core and Runner interact only through the versioned Runner Protocol, including Local mode.

## Verification

Use `tests/unit/runner`, `tests/unit/core-daemon`, `tests/component/core-runner`, `tests/component/web-execution`, and Runner Protocol conformance tests. Read Architecture sections 5.5, 7, 9.1, and 11 before changing this context.
