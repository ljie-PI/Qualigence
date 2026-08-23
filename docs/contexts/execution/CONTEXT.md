# Execution Context

## Terms

- **Core** is the deterministic authority for execution lifecycle decisions.
- **Runner** performs accepted work and reports protocol events without mutating domain aggregates.
- **Plan Snapshot** is the immutable ordered work accepted for one execution attempt.
- **Action Outcome Unknown** means an action crossed its side-effect boundary without a trustworthy result; it is terminal for automatic execution and is never replayed automatically.
- **valueRef** identifies an approved value without exposing its plaintext in a Plan, Trace, Finding, log, or public DTO.

## Ownership

`packages/core-application`, `packages/runner-kernel`, `packages/execution-application`, `apps/core-daemon`, and `apps/runner` own execution lifecycle composition. Core is the authority for Mission, Run ownership, Lease, completion, and deterministic policy. Runner executes offered work and appends protocol events; it does not write aggregates.

## Seams

- `RunnerProtocolApplication` separates transport from lifecycle authority.
- `RunnerControlStore` holds durable session, lease, and completion decisions.
- `RunnerPolicyGate` enforces immutable policy snapshots.
- `RunCompletionSink` applies an accepted completion to the corresponding durable Run.
- Mission scheduling writes durable dispatch intent; the dispatcher offers it only through the authenticated Runner application selected by the Mission binding.
- Target Runtime selection isolates Web and Desktop resources so an action cannot cross target executors.

## Invariants

- Lease, expected version, policy, budget, and terminal state are deterministic decisions.
- A Run has one authoritative owner and one terminal completion.
- An expired, lost, cancelled, or blocked Run never gains a new action permit.
- Core and Runner interact only through the versioned Runner Protocol, including Local mode.
- Scheduling atomically records Mission state, Runs, attempts, provenance, dispatch outbox, and wakeup. Idempotent replay returns the original IDs without allocating or dispatching again.
- Dispatch targets only the Mission's explicit tenant/project/Runner binding after policy and capability checks. Offline work remains durably pending; mismatch blocks explicitly and never selects another Runner.
- An accepted Plan Snapshot fixes step order and allowed action kinds. A model may select only current-observation nodes and bounded Plan parameters; it cannot invent action kinds, selectors, URLs, policy, budgets, IDs, or plaintext values.
- Step count, wall clock, provider output, and model token budgets are finite and deterministic. Missing model usage is `ModelUsageUnavailable`, not zero usage or an unlimited budget.
- `valueRef` resolution is confined to an approved root and rejects traversal, symlinks, unsafe permissions, and oversized values. Only bounded short-lived plaintext may reach an executor; audit and evidence retain references plus hashes/lengths, never the value.
- State-changing actions invalidate stale observation descriptors. `ActionOutcomeUnknown` is an error with no automatic retry; budget or policy denial is blocked, and malformed Plans are rejected before offer.

## Entrypoints

- `apps/core-daemon/src/main.ts`
- `apps/runner/src/main.ts`
- `apps/cli/src/local-run-composition-root.ts`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.5, 5.8, 7, 9.1, and 11.
- Related contexts: `docs/contexts/product/CONTEXT.md`, `docs/contexts/protocol/CONTEXT.md`, `docs/contexts/evidence/CONTEXT.md`, and `docs/contexts/windows/CONTEXT.md`.
- Tracked work: `.scratch/remaining-production-closure/issues/05-dispatch-mission-bound-runner.md`, `.scratch/remaining-production-closure/issues/20-exploration-seed-checkpoint-budget.md`, `.scratch/remaining-production-closure/issues/21-real-reference-model-benchmark.md`, and `.scratch/remaining-production-closure/issues/28-dispatch-desktop-target-runtime.md`.

## Verification

Run `corepack pnpm vitest run tests/unit/runner tests/unit/core-daemon tests/component/core-runner tests/component/web-execution tests/conformance/runner-protocol`.
