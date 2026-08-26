# 43 - Revalidate bounded Promise owner descriptors

**What to build:** Starting from current `main` after Ticket 42 merges, retain a bounded enumerable registry of every Promise receiver/prototype owner observed by causal instrumentation and revalidate each owner's exact descriptor and prototype identities immediately before every Graph or Artifact return.

**Blocked by:** 42 - Preserve native Promise semantics with exact causal accounting.

**Status:** claimed

## Tracked scope

This ticket owns owner discovery, enumerable bounded retention, and return-time integrity checks. For every observed `then`, `catch`, or `finally` resolution, register the receiver and each traversed owner/prototype needed to establish method authority. The registry must be explicitly enumerable for complete validation, have a fixed session bound, deduplicate by object identity, and poison evidence without altering application behavior on overflow.

Immediately before returning a Graph and immediately before returning each Artifact set, synchronously enumerate the full registry and compare exact owner identity, prototype identity, own-descriptor presence, data/accessor shape, flags, getter/setter/value function identity, and the resolved method owner for `then`, `catch`, and `finally` against the approved current record. Mutation after DOM collection, after screenshot capture, or between Graph and Artifact preparation must be detected; no stale earlier validation authorizes return.

Ticket 42 is assumed complete: native Promise semantics and exact causal registration accounting are inherited and not re-accepted. Ticket 43 allows a currently valid owner record to be updated only through the controlled predecessor instrumentation path before return; immutable first-snapshot/no-reapproval policy belongs exclusively to Ticket 44. DOM getter/geometry authority belongs to Ticket 45.

The fixed registry limit is 256 distinct owner objects per browser session. Registration deduplicates by object identity; each entry stores the exact prototype identity and complete own-descriptor state for `then`, `catch`, and `finally`, including absence. The immediate full-registry checks occur after final Graph assembly and before returning/registering the Graph, then after final Artifact assembly and before returning/registering any Artifact. Overflow or any failed check returns inherited `SensitiveEvidenceUnavailable` and zero newly accepted Graph/Artifact bytes.

## Migration

None; existing and allocated closure migrations are immutable to this ticket.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`

## Authority

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.1-6.2, 8, 10, 11, and 13. Evidence authority must fail closed without changing target application execution.
- Context authority: `CONTEXT-MAP.md`, `docs/contexts/execution/CONTEXT.md`, and `docs/contexts/evidence/CONTEXT.md`.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` evidence/valueRef invariants and complete-matrix review/delivery protocol.
- Predecessor authority: `.scratch/remaining-production-closure/issues/42-promise-finally-semantics-remediation.md`, its eventual merged evidence, native behavior oracle, and Promise instrumentation interface. Completion is assumed; semantic/accounting acceptance is excluded here.
- Current public interfaces and tests: sensitive evidence authority, browser observer return seams, and exact Allowed Files on the base.
- Closed PRs #78-#83 and any local WIP are historical context only. Their branches, commits, diffs, tests, and review claims are not implementation, source, or cherry-pick authority.

## Allowed Files

This is the complete edit scope:

- `packages/target-adapters/web-playwright/src/browser-session.ts`
- `packages/target-adapters/web-playwright/src/playwright-observer.ts`
- `packages/target-adapters/web-playwright/src/sensitive-evidence-authority.ts`
- `tests/unit/target-adapters/web-playwright/browser-session.test.ts`
- `tests/component/web-execution/playwright-observation.test.ts`
- `tests/component/web-execution/promise-native-oracle.test.ts`
- `tests/component/web-execution/promise-owner-integrity.test.ts` (new)
- `tests/e2e/web-execution/value-ref.test.ts`
- `.scratch/remaining-production-closure/issues/43-revalidate-promise-owner-descriptors.md`

No Runner production file, immutable first-snapshot rule, DOM getter/geometry implementation, package manifest, lockfile, or unrelated root is in scope.

## Focused non-E2E Gate

Run during implementation and after every code/test review fix:

```text
corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/promise-native-oracle.test.ts tests/component/web-execution/promise-owner-integrity.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

Run only after an exact-head complete-matrix review is clean:

```text
corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts
```

The Chromium E2E must register multiple receiver/prototype owners, mutate descriptors/prototypes at each capture boundary, prove native page behavior continues, and prove no Graph/Artifact/log/Spool evidence is accepted after failed immediate revalidation. Chromium absence or skips fail the Gate.

## Execution, review, and delivery protocol

- Start fresh from current `main` after Ticket 42 merges; record exact base/predecessor merge evidence, matrix applicability, and Gates. Historical branches/WIP are not source authority.
- Keep `claimed`; run only focused non-E2E verification during edits and review fixes.
- Commit before each exact-base `/code-review`; every round covers the whole diff and all matrix rows on both axes with `pass | finding | N/A`, reasons, and reviewed head.
- Use at most five complete-matrix rounds. Critical always blocks; Important follows umbrella criteria. A remaining core blocker sets `needs-info` and stops Ticket 44.
- Record non-Critical advanced hardening in one GitHub Issue only; do not implement it unless promoted.
- Run exact Chromium E2E only after clean review. Any code/test change repeats focused Gate, review, and E2E.
- Do not create a PR until all focused/typecheck/diff/review/E2E/final evidence is clean. Then create one non-draft PR; only a byte-identical final-evidence commit may follow review. Resolve after merge evidence.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Base, subclass, custom receiver, and traversed prototype owners are observed within bound | `started` at native property resolution/registration | Native Promise behavior from Ticket 42 is preserved; owner is registered once by identity | Enumerable in-memory owner/descriptor/prototype record only | Re-observation deduplicates by identity and remains fully enumerable | Registry contents/cardinality and native oracle |
| Same owner is observed repeatedly through `then`/`catch`/`finally` | `started` | No duplicate owner entry; all applicable method records remain validated | Stable bounded registry cardinality | Idempotent within session | Count and exact method-owner assertions |
| A 257th distinct owner would be registered | `started` | Native operation proceeds; evidence latches `SensitiveEvidenceUnavailable` | No Graph/Artifact accepted from poisoned session/epoch | Do not cancel Promise behavior; new session may retry | Native completion and code-only/zero-evidence result |
| Descriptor value/getter/setter/flags/shape changes before Graph return | `started` | `SensitiveEvidenceUnavailable` | No Graph or JSON Artifact is accepted | Fresh session/capture after legitimate setup only; no action replay | Mutation-at-boundary tests |
| Owner prototype or resolved method owner changes before Graph return | `started` | `SensitiveEvidenceUnavailable` | No Graph/Artifact accepted | Same as descriptor mutation | Prototype/owner identity test |
| Mutation occurs after Graph assembly but immediately before Artifact return | `started` | Artifact set is not returned or registered; Graph is not published as accepted observation | No screenshot/JSON Artifact bytes persist | Full new capture may retry; no partial acceptance | Hooked race proving final revalidation |
| Descriptor is deleted then restored to exact approved shape before immediate validation | `started` | Ticket 43 accepts only if exact current record matches; Ticket 44 will prohibit reapproval/history erasure | Current in-memory record only | No historical mutation claim in this ticket | Explicit test documenting Ticket 43 boundary |
| Getter/descriptor inspection throws or registry enumeration is incomplete | `started` | `SensitiveEvidenceUnavailable` | No accepted Graph/Artifact | New session may retry; never silently skip owner | Throw/incomplete-enumeration tests |
| No Promise owner is observed in a capture | `not_started` for registry mutation | Existing capture behavior | Empty registry | Freely repeatable | Empty-registry capture test |
| Policy/value/action rejection before sensitive epoch | `not_started` | Existing predecessor result | No owner authority created | Existing retry rules | Zero registry assertion |
| Cancel/timeout before evidence return | `started` if page action/Promise ran | Existing cancellation/fail-closed capture result | No unsafe evidence accepted | Observation may retry; action/Promise callbacks may not | Cancellation and zero evidence |
| Concurrent owner registration and capture validation | `started` | Serialized observer either validates one complete snapshot or fails closed | No partially validated accepted evidence | Retry capture after quiescence; never drop an owner | Race/concurrency test |
| Session close/restart | `started` if registry existed | Registry is cleared; native pending behavior is not cancelled by cleanup | No owner references cross session | New session starts empty | Cleanup/GC-observable cardinality test |
| Evidence persistence fails after successful revalidation | `outcome_unknown` for terminal evidence | Existing persistence failure; no weakened revalidation | No unsafe fallback | Retry persistence only under existing semantics | Sink failure and exact pre-return validation evidence |

## Comments

### start — 2026-08-26

- Fixed base: `34aeb423ef655ca04f8c69736e0a4d8b1ac9621e` (`main`, after Ticket 42 PR #114, Ticket 11 PR #115, and Ticket 27 PR #116 merge commits present in history).
- Predecessor merge evidence: Ticket 42 is `resolved` with PR #114 (`https://github.com/ljie-PI/Qualigence/pull/114`), reviewed code/test head `2bd9b04eeb796373cd50386bba4ca10b8dae9337`, documentation evidence commit `a6db2f1`, and merge commit `6123350` in the current base history.
- Behavior Matrix applicability: complete Ticket 43 matrix is applicable. Bounded enumerable Promise owner/prototype descriptor retention, identity de-duplication, exact revalidation before Graph/Artifact acceptance, overflow/inspection/enumeration fail-closed behavior, current-state restoration boundary, concurrent validation serialization, and session cleanup are in scope. Ticket 42 native Promise semantics/accounting must remain green but is not re-accepted. Immutable first-snapshot/no-reapproval, DOM getter/geometry authority, Runner production files, package manifests/lockfile, and unrelated roots are excluded.
- Planned Gates: `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/promise-native-oracle.test.ts tests/component/web-execution/promise-owner-integrity.test.ts`, then `CI=true corepack pnpm typecheck`, then `git diff --check`. Complete-matrix review and post-review Chromium E2E remain pending after implementation.

### review-fix — 2026-08-26

- Reviewed head fixed: `a5ed05b48c09b22bba7554c6e0293bb62ea38c94` against fixed base `34aeb423ef655ca04f8c69736e0a4d8b1ac9621e`.
- Core findings fixed: diff hygiene for `tests/component/web-execution/promise-owner-integrity.test.ts`; Critical mutable page-visible Promise owner registry/record snapshots; compacting/truncating/removing page-visible owner entries; and descriptor/prototype/resolved-method-owner page-visible record rewrite attempts after owner mutation.
- Fix commit: `5669473ffaf32c666b3eb32a9a8940ad42909575` (`Fix Ticket 43 Promise owner registry tamper`).
- Gates run for the fix: `CI=true corepack pnpm typecheck` (passed), `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/promise-native-oracle.test.ts tests/component/web-execution/promise-owner-integrity.test.ts` (passed, 4 files / 35 tests), and `git diff --check` (passed).
- Status remains `claimed`; complete-matrix review and post-review Chromium E2E remain pending. No PR/final evidence was created.


### post-review-e2e — 2026-08-26

- Clean complete-matrix review authority for the acceptance start point: reviewed head `d4b2fb8d53003d4114bdb7b2ce12f32ad98d8d9c`, fixed point/base `34aeb423ef655ca04f8c69736e0a4d8b1ac9621e`, with no core blockers in review2 Standards/Spec artifacts.
- Post-review Chromium E2E initially failed because the inherited Runner Spool now requires encrypted lease storage. The E2E was updated only to open `SqliteRunnerSpool` with `AesGcmSpoolCrypto(randomBytes(32))`, matching the production/recent test harness requirement without changing product code.
- Acceptance and regression validation passed after the E2E harness fix: `CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` (1 file / 1 test), `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/promise-native-oracle.test.ts tests/component/web-execution/promise-owner-integrity.test.ts` (4 files / 35 tests), `CI=true corepack pnpm typecheck`, and `git diff --check`.
- Status remains `claimed`; no final/PR evidence is added yet. A fresh complete-matrix review remains required because the post-review E2E file changed after the clean review head.

### review3-fix — 2026-08-26

- Reviewed head fixed: `e8c5f417949b2a00ba0463f9d481fc0aaaaadb83` against fixed base `34aeb423ef655ca04f8c69736e0a4d8b1ac9621e`.
- Core finding fixed: Important Spec blocker that the post-review Chromium E2E passed but did not exercise Ticket 43 Promise owner registry/revalidation acceptance.
- Fix commit: `788639e5a3015879989235b9e88a5b7b503b60c2` (`test(ticket-43): cover promise owner e2e revalidation`).
- E2E coverage added in `tests/e2e/web-execution/value-ref.test.ts`: actual `RunnerOfferRuntime` valueRef input jobs register multiple Promise receiver/prototype/custom owners during sensitive epochs, mutate descriptor and prototype identities at both Graph and Artifact capture boundaries, verify native callbacks/page behavior complete, and assert `SensitiveEvidenceUnavailable` with no final observation/artifact/log/Spool plaintext or accepted post-failure evidence.
- Gates run for the fix: `CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` (passed, 1 file / 2 tests), `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/promise-native-oracle.test.ts tests/component/web-execution/promise-owner-integrity.test.ts` (passed, 4 files / 35 tests), `CI=true corepack pnpm typecheck` (passed), and `git diff --check` (passed).
- Status remains `claimed`; no PR or final merge evidence was created. Fresh complete-matrix review is required on the new head.

## Acceptance

- [ ] Every observed Promise receiver/traversed owner is retained in a fixed-bound, identity-deduplicated, completely enumerable registry.
- [ ] The registry holds at most 256 distinct owners, stores exact prototype and all three complete own-descriptor states including absence, and overflows as `SensitiveEvidenceUnavailable`.
- [ ] Exact `then`/`catch`/`finally` descriptors, owner identities, and prototype identities are revalidated immediately before Graph return and immediately before Artifact return.
- [ ] Mutation, inspection failure, incomplete enumeration, and overflow fail evidence closed without altering native Promise/application behavior.
- [ ] Ticket 42 native Promise semantics/accounting remains green but is not re-claimed as Ticket 43 acceptance.
- [ ] Focused Gate, typecheck, diff check, complete-matrix review, and exact Chromium E2E are clean on the final code/test head.
