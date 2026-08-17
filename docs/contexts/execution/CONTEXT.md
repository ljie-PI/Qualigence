# Execution Context

## Terms

- **Core** is the deterministic authority for execution lifecycle decisions.
- **Runner** performs accepted work and reports protocol events without mutating domain aggregates.

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

## Entrypoints

- `apps/core-daemon/src/main.ts`
- `apps/runner/src/main.ts`
- `apps/cli/src/local-run-composition-root.ts`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.5, 5.8, 7, 9.1, and 11.
- Specs: `docs/superpowers/specs/2026-08-01-ls-03-m1-execution-application-cli-design.md`, `docs/superpowers/specs/2026-08-01-ls-05-m1-core-runner-transport-hardening-design.md`.

## Verification

Use `tests/unit/runner`, `tests/unit/core-daemon`, `tests/component/core-runner`, `tests/component/web-execution`, and Runner Protocol conformance tests.
