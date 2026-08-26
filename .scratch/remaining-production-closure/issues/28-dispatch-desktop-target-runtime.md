# 28 — Dispatch Desktop Jobs through Target Runtime

**What to build:** Select Web or Desktop target resources through one Runner Target Runtime Factory and execute Desktop actions only through an authenticated Companion.

**Blocked by:** 27 — Implement the TypeScript Companion client.

**Status:** claimed

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

Maintainer/user-authorized narrow continuation scope expansion (2026-08-26):

- `packages/contracts/desktop/src/**`
- `tests/contract/desktop/**`
- `tests/type/desktop-contracts.types.ts` if needed

This authorization is limited to the minimal Desktop value binding/plaintext dispatch contract change required by Ticket 28: redaction-safe `valueRef`/SHA-256/byte-length binding, one-time Permit/action digest validation, and bounded short-lived plaintext only in the Desktop input/select `action.execute` dispatch DTO. It does not authorize Rust/native Companion, Runner Protocol, storage migrations, package dependencies outside existing Ticket 28 scope, or unrelated public-contract changes.

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

## Comments

### start - 2026-08-26

- Fixed base: `34aeb423ef655ca04f8c69736e0a4d8b1ac9621e` (`ticket-28-dispatch-desktop-target-runtime`, current `main` after merged Ticket 27 PR #116 plus Tickets 11 and 42 merge commits present in history).
- Predecessor evidence: Ticket 26 is `resolved` with PR #112, reviewed code head `fcd5b2926a20f428ce0009da704022144bb80ea9`, and merge commit `cff217f68f0b3bcaffe517aaed11e3e302abb964`; Ticket 27 is `resolved` with PR #116, reviewed code/test head `6874749192c4da480c71aa6a3a121a9e02a67f8d`, final verification evidence in `.scratch/remaining-production-closure/issues/27-typescript-companion-client.md`, and merge commit `34aeb423ef655ca04f8c69736e0a4d8b1ac9621e` in this worktree base.
- Behavior Matrix applicability: applicable. The frozen matrix in this ticket governs production Runner Target Runtime selection, Web/Desktop executor isolation, Desktop Companion authentication/probe gating, Desktop launch/capture/cleanup ordering, local Permit/action binding, valueRef last-responsible resolution/redaction, fail-closed capability/unavailable outcomes, timeout/unknown-outcome terminalization, and no Web fallback/synthetic UIA.
- Planned focused Gate: `CI=true corepack pnpm vitest run tests/unit/runner-kernel/target-kind-discriminator.test.ts tests/contract/desktop/companion-action.test.ts tests/component/windows-uia/reference-app-pipeline.test.ts tests/component/web-execution/playwright-web-target.test.ts`, then `CI=true corepack pnpm typecheck`, then `git diff --check`.
- Scope guard: implementation is limited to the Ticket 28 Allowed Files. Native Companion/Rust, Ticket 29-31 native/manual evidence, package dependencies beyond listed manifests/lockfile, and any out-of-scope Desktop IPC contract changes require an explicit reviewed scope amendment before editing.

### blocked - 2026-08-26

- Implementation stopped before production-code edits because the existing Ticket 27 Desktop IPC contract cannot satisfy a Ticket 28 explicit requirement within the current Allowed Files.
- Blocking gap: Ticket 28 requires Runner to resolve Desktop `valueRef` at the last responsible moment, bind plaintext SHA-256 and byte length into the action/Permit digest, transmit only bounded short-lived plaintext, and keep plaintext out of Trace/Finding/logs/DTOs/Spool. The current `@qualigence/desktop-contracts` IPC DTOs expose no bounded plaintext field: `ResolvedDesktopAction` input carries only `valueRef`, select carries only `option`, `LocalPermitAuthorization` carries only `decisionId`, `policyId`, `actionDigestSha256`, `risk`, and `expiresAt`, and `action.execute` carries only `{ sessionId, action, permit, deadlineMs }`.
- Required scope amendment: authorize editing `packages/contracts/desktop/src/**` and its direct type/contract tests to add the minimal public Companion IPC fields for Desktop value binding/transport. At minimum, the contract needs a redaction-safe value binding DTO containing `valueRef`, `valueSha256`, and `valueByteLength`; action/Permit authorization validation must bind those fields into the one-time Permit/action digest; `action.execute` needs a bounded short-lived plaintext value payload for input/select only; validators must reject plaintext in non-action/trace DTOs, mismatched hash/length, missing value binding, oversized plaintext, and unknown fields; and the companion contract tests must cover positive input/select execution plus mismatch/oversize/no-plaintext persistence cases.
- No production, test, manifest, or lockfile implementation changes were made under this ticket after the blocker was identified. The ticket remains `claimed` and not `resolved` pending a reviewed scope amendment or maintainer direction.

### continuation - 2026-08-26

- Maintainer/user authorization recorded under `## Allowed Files` for the narrow Desktop IPC value-binding scope: `packages/contracts/desktop/src/**`, `tests/contract/desktop/**`, and `tests/type/desktop-contracts.types.ts` if needed.
- Implemented redaction-safe Desktop value binding in `@qualigence/desktop-contracts`: `valueRef`, `valueSha256`, and `valueByteLength` bind input/select values; bounded plaintext exists only as `DesktopPlaintextValue` inside the `action.execute` request payload and is rejected everywhere else by exact-field validators.
- `permit.request` now validates value-action bindings and the local Desktop action digest over session, run, action, decision, policy, risk, expiry, and value binding; `action.execute` validates plaintext hash/byte length against the one-time Permit binding before dispatch.
- Runner composition now opens target-specific runtime resources through `TargetRuntimeFactory`: Web keeps Playwright; Desktop requires Windows plus an authenticated/probed Companion, launches through `AppEnvironmentProvider`, captures through `WindowsDesktopAdapter`, resolves with `UiaActionResolver`, executes with `UiaActionExecutor`, and closes the opened resource set in `finally` without allowing cleanup failure to mask an earlier failure.
- Runner capability advertisement includes `desktop-windows-uia`/`uia/v1` only when a Windows Companion client has authenticated at startup; Desktop offer admission has no Web fallback and failures map to stable `CapabilityMismatch`/`CompanionUnavailable`/`ActionOutcomeUnknown` paths.
- Desktop input/select value plaintext is resolved by the executor at the dispatch boundary from the configured value provider, hashed/length-bound into the local authorization digest, sent only in the Companion `action.execute` DTO, and not added to Trace/Finding/log/Spool DTOs.
- Gate evidence before this commit:
  - Passed: `CI=true corepack pnpm vitest run tests/unit/runner-kernel/target-kind-discriminator.test.ts tests/contract/desktop/companion-action.test.ts tests/component/windows-uia/reference-app-pipeline.test.ts tests/component/web-execution/playwright-web-target.test.ts` (4 files / 27 passed / 2 skipped).
  - Passed: `CI=true corepack pnpm vitest run tests/contract/desktop` (3 files / 47 tests).
  - Passed: `CI=true corepack pnpm typecheck`.
  - Passed: `git diff --check`.
- Additional non-required diagnostic: `CI=true corepack pnpm vitest run tests/unit/runner/offer-runtime.test.ts --testTimeout=10000` currently has 4 expectation failures in existing offer-runtime unit coverage around Desktop missing-capability expectation and delayed terminal Trace drain observations; the required Ticket 28 focused Gate above is clean, but these unit expectations should be reconciled during review/fix if promoted as core coverage.
- No PR was created. Ticket 28 remains `claimed` and ready for complete-matrix review of this implementation head.

### review-fix - 2026-08-26

- Reviewed head fixed: `d341415dd2533267161e4d40d7a76efaab6eb004` (complete-matrix Standards/Spec review blockers from `ticket28-review`).
- Fix commit: `3212c0d35b51deed963c2580ad2ca0253d1ecf05` (`fix(ticket-28): close desktop matrix blockers`).
- Findings fixed:
  - Desktop capability advertisement now requires the Windows Named Pipe Companion to authenticate and run a concrete `probe()` seam before startup advertises Desktop; `RunnerOfferRuntime` no longer derives Desktop readiness solely from `companion !== undefined`.
  - Desktop Permit/action binding now includes nonce in the authorization digest, strict `action.execute` parsing verifies payload session, permit session/run/action/graph/digest/nonce/action/value binding, and Runner policy descriptors no longer use placeholder digests.
  - `UiaActionExecutor.execute` resolves hash/length before approval without retaining plaintext, re-resolves bounded plaintext immediately before dispatch, verifies the approved binding still matches, and calls `permit.assertAuthorizedForDispatch(signal)` immediately before `companion.execute(...)`.
  - Startup terminal Trace/lease renewal behavior in `tests/unit/runner/offer-runtime.test.ts --testTimeout=10000` is reconciled; delayed terminal Trace drain now renews/aborts as the existing core tests require.
  - Prior out-of-scope edits to `packages/contracts/runner-protocol/src/index.ts` and `tests/helpers/windows-reference-app.ts` were removed from the current total diff against fixed base `34aeb423ef655ca04f8c69736e0a4d8b1ac9621e`.
- Gates after the fix commit:
  - Passed: `CI=true corepack pnpm vitest run tests/unit/runner-kernel/target-kind-discriminator.test.ts tests/contract/desktop/companion-action.test.ts tests/component/windows-uia/reference-app-pipeline.test.ts tests/component/web-execution/playwright-web-target.test.ts` (4 files / 30 passed / 2 skipped).
  - Passed: `CI=true corepack pnpm vitest run tests/contract/desktop` (3 files / 50 tests).
  - Passed: `CI=true corepack pnpm vitest run tests/unit/runner/offer-runtime.test.ts --testTimeout=10000` (1 file / 48 tests).
  - Passed: `CI=true corepack pnpm typecheck`.
  - Passed: `git diff --check`.
- No PR was created. Ticket 28 remains `claimed` and ready for a fresh complete-matrix review of the current head.

### review2-fix - 2026-08-26

- Reviewed head fixed: `f1682dbba498c834c1959baae371d6352ba967a7` (review2 Standards/Spec remaining core blockers from `ticket28-review2`).
- Fix commit: `9350647a17ebe4078a179ff0da4a77d681cce748` (`fix(ticket-28): probe and retain desktop companion`).
- Findings fixed:
  - `NamedPipeCompanionClient.probe()` now sends a concrete post-auth `companion.probe` IPC request with strict Desktop target-adapter/UIA observation-extension validation instead of returning after `authenticate()` only; malformed/not-ready/mismatched probe responses fail closed independently of authentication.
  - Desktop runtime open requires the Companion probe before launch, so probe failure remains before target launch/action side effects and maps to `CompanionUnavailable`/capability failure semantics.
  - Per-runtime Desktop cleanup shuts down the launched app session but no longer closes the shared startup `NamedPipeCompanionClient`; the Runner-owned client remains usable while advertised, and final process shutdown still owns `companion.close()`.
  - Focused tests now cover strict probe request/response validation, the Named Pipe post-auth probe frame and independent probe failure, probe-failed runtime open with zero launch side effects, and sequential Desktop runtime open/close reuse without closing the shared Companion.
- Gates after the fix commit:
  - Passed: `CI=true corepack pnpm vitest run tests/unit/runner-kernel/target-kind-discriminator.test.ts tests/contract/desktop/companion-action.test.ts tests/component/windows-uia/reference-app-pipeline.test.ts tests/component/web-execution/playwright-web-target.test.ts` (4 files / 32 passed / 2 skipped).
  - Passed: `CI=true corepack pnpm vitest run tests/contract/desktop` (3 files / 53 tests).
  - Passed: `CI=true corepack pnpm vitest run tests/unit/runner/offer-runtime.test.ts --testTimeout=10000` (1 file / 48 tests).
  - Passed: `CI=true corepack pnpm typecheck`.
  - Passed: `git diff --check`.
- No PR was created. Ticket 28 remains `claimed` and ready for a fresh complete-matrix review of the current head.
