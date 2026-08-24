# 28 — Dispatch Desktop Jobs through Target Runtime

**What to build:** Select Web or Desktop target resources through one Runner Target Runtime Factory and execute Desktop actions only through an authenticated Companion.

**Blocked by:** 27 — Implement the TypeScript Companion client.

**Status:** ready-for-agent

## Tracked scope

Tickets 26 and 27 own the Desktop Target protocol and TypeScript Companion client; this ticket owns their production Runner composition and no native Companion implementation.

## Migration

No relational migration is allocated. Existing and allocated closure migrations and historical Observation payloads are immutable in this ticket. This is an in-place production-composition migration from the Web-only constructor to `TargetRuntimeFactory`; no compatibility fallback or synthetic Desktop production path is permitted.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/windows/CONTEXT.md`

## Authority

Implementation and review are governed by these durable references:

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 3.1, 4, 6.3-6.5, 7, 10, 11, 13, 14.3, and 15.
- `CONTEXT-MAP.md` and every context listed above.
- The public contracts in `packages/runner-kernel/src/**` and `packages/target-adapters/desktop-windows-uia/src/**` as amended by this ticket.
- The security acceptance in `docs/testing/windows-m3-manual-checklist.md` sections 6, 9, 12, 13, and 16. Ticket 28 proves the TypeScript boundary only; tickets 29-31 prove native behavior.

## Allowed Files

This is the complete edit scope, including the post-review acceptance file. A required edit outside it stops work for a reviewed scope amendment.

- `.scratch/remaining-production-closure/issues/28-dispatch-desktop-target-runtime.md` for ticket-local final evidence only
- `apps/runner/src/**`
- `apps/runner/package.json`
- `apps/runner/tsconfig.json`
- `packages/runner-kernel/src/**`
- `packages/runner-kernel/package.json`
- `packages/runner-kernel/tsconfig.json`
- `packages/target-adapters/desktop-windows-uia/src/**`
- `packages/target-adapters/desktop-windows-uia/package.json`
- `packages/target-adapters/desktop-windows-uia/tsconfig.json`
- `packages/target-adapters/web-playwright/src/**`
- `packages/target-adapters/web-playwright/package.json`
- `packages/target-adapters/web-playwright/tsconfig.json`
- `pnpm-lock.yaml`
- `tests/unit/runner-kernel/**`
- `tests/contract/desktop/**`
- `tests/component/windows-uia/**`
- `tests/component/web-execution/**`
- `tests/e2e/windows/desktop-runner.test.ts`

## Requirements

- [ ] Runner advertises Desktop capability only after Companion authentication and capability probe.
- [ ] Web/Desktop actions cannot cross target executors.
- [ ] Desktop Permit binds action, decision, policy, session, run, valueRef/hash/length, expiry, and nonce.
- [ ] Companion failure yields stable capability/unavailable outcomes before side effects.
- [ ] `TargetRuntimeFactory.open(job)` returns one closeable Observer/Resolver/ActionExecutor/Verifier resource set selected exhaustively by Target kind.
- [ ] Web retains Playwright behavior; Desktop requires Windows, the authenticated Companion, `AppEnvironmentProvider`, `WindowsDesktopAdapter`, `UiaActionResolver`, and `UiaActionExecutor`.
- [ ] Desktop launch completes before capture; every partial or successful open is closed in `finally`, and cleanup failure cannot turn a failed execution into success.
- [ ] Runner resolves Desktop `valueRef` only at the last responsible moment, binds SHA-256 and byte length into the action/Permit digest, sends only bounded short-lived plaintext, and never records plaintext in Trace, Finding, logs, DTOs, or durable Spool.
- [ ] Unsupported platform, missing adapter, failed capability probe, unauthenticated/disconnected Companion, and incompatible action kind fail as `CapabilityMismatch` or `CompanionUnavailable`; none falls back to Web or synthetic UIA.
- [ ] Timeout after action dispatch is `ActionOutcomeUnknown`, terminal for that action, and never automatically replayed with a new Permit.

## Focused Gate

Run during implementation and after every code/test review fix:

```bash
corepack pnpm vitest run tests/unit/runner-kernel/target-kind-discriminator.test.ts tests/contract/desktop/companion-action.test.ts tests/component/windows-uia/reference-app-pipeline.test.ts tests/component/web-execution/playwright-web-target.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

Only after an exact-base complete-matrix review has no core Critical or Important finding:

- Automated E2E: run `corepack pnpm vitest run tests/e2e/windows/desktop-runner.test.ts` against the separate-process authenticated Companion contract fixture. It must drive the built Runner Target Runtime, prove no Web fallback, and is not native Companion evidence.
- Manual acceptance: N/A. Native local-console/RDP execution is owned by ticket 31.
- Release acceptance: record the reviewed head, E2E result, and exact artifact/log references under this ticket's `## Comments`. This ticket does not publish a release or claim native Windows completion.

## Delivery and review

Record the base SHA before editing and every reviewed head under `## Comments`. Review the whole ticket diff and every Behavior Matrix row on both Standards and Spec axes. Fix core findings on this ticket, rerun affected focused tests, and request a fresh complete-matrix review. After five review rounds with a remaining core blocker, set this same ticket to `needs-info`, record the blocker, block dependents, and request a maintainer scope/ownership decision. Do not create recursive remediation tickets. Record only non-Critical advanced hardening as a linked GitHub Issue and do not implement it here unless promoted.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary | Public result | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Valid Web Job and Web runtime opens | `not_started` until Playwright resource creation | Existing Web execution result | Existing ordered Trace/Spool semantics | Existing bounded Job retry rules only | Web component Trace and close evidence |
| Valid Desktop Job; authenticated capability probe and launch succeed | `started` only after authoritative Job acceptance and target launch | Desktop execution result | Ordered Trace records Target kind, observations, decisions, action outcomes, and terminal completion | Retry only before action dispatch under existing Job authority | Runtime-open/close record, Trace, and Companion request correlation |
| Malformed/unsupported Target or action kind | `not_started` | `CapabilityMismatch` | Stable rejection/terminal Trace; no target process or action | Identical replay returns the same rejection | Zero target-open/action calls in contract tests |
| Companion absent, unauthenticated, probe-failed, or unsupported platform | `not_started` | `CompanionUnavailable` or `CapabilityMismatch` | No Desktop capability advertisement and no target side effect | Retry may re-probe only before Job/action admission | Capability snapshot and zero-dispatch assertion |
| Policy/Permit/valueRef validation rejects | `not_started` | Stable policy, Permit, or value-provider error | Redacted rejection Trace only | Conflicting replay remains rejected; no new local Permit | Zero Companion action dispatch and plaintext scan |
| Cancel/timeout before Desktop launch or action dispatch | `not_started` | Stable cancelled/timed-out result | One terminal Trace result; opened resources are closed | Safe retry requires fresh Job/action authority | Abort propagation and cleanup evidence |
| Cancel/timeout after target launch but before action dispatch | `started` | Stable cancelled/timed-out result | Target cleanup plus one terminal Trace result | No action replay occurred; a later attempt reopens a fresh runtime | Launch/shutdown ordering and zero action dispatch |
| Cancel/timeout/disconnect after action dispatch | `outcome_unknown` | `ActionOutcomeUnknown` | One terminal unknown outcome; no fabricated verification success | Never automatically replay; requires human/new authoritative action | One consumed Permit, one dispatch, unknown terminal Trace |
| Duplicate identical action/Permit replay | `not_started` for duplicate | Consumed/duplicate Permit rejection | Original outcome remains authoritative | Duplicate never executes | Exactly-one Companion dispatch assertion |
| Conflicting action, graph, value hash/length, session, or run replay | `not_started` | Binding rejection | Rejection Trace contains stable code and no plaintext | Never retry as the original action | Digest/binding mismatch evidence |
| Concurrent Web/Desktop Jobs | `started` per accepted Job | Independently scoped outcomes | Runtime resources and Trace remain Job/session scoped | No resource or Permit sharing across Jobs | Concurrency test with distinct runtime/session IDs |
| Runner restart or cleanup failure | `started` or `outcome_unknown` according to last dispatch | Stable startup/cleanup failure; never false success | Existing Spool retains accepted Trace; Desktop capability is re-probed | No prior action replay after restart | Spool/close evidence and fresh authentication/probe |
| Terminal Trace/Spool persistence fails | `started` or `outcome_unknown` | Fail closed; no success completion | Existing durable prefix remains; terminal success is absent | Retry only through existing Trace drain/recovery, never action replay | Injected recorder failure and absent completion |
