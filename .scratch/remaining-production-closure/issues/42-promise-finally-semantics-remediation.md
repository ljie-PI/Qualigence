# 42 - Preserve native Promise semantics with exact causal accounting

**What to build:** Starting from current `main` after Ticket 41 merges, make sensitive-epoch Promise instrumentation preserve native `then`, `catch`, `finally`, species construction, thenable assimilation, and custom method behavior exactly while accounting for each causal application registration once within the existing bound.

**Blocked by:** 41 - Close Shadow DOM, scheduler, and Runner log gaps.

**Status:** ready-for-agent

## Tracked scope

This ticket owns Promise-semantic transparency and exact bounded causal registration accounting. It must cover base promises, subclasses, `Symbol.species` returning the subclass/base/alternate constructor or invalid values, omitted/non-callable handlers, custom receiver `then`/`catch`/`finally`, handlers that return values/promises/foreign thenables, throwing getters/handlers, self-resolution, rejection propagation, and observable invocation/constructor order. Every application-visible registration created by the application is counted exactly once before its native boundary; registrations internal to the instrumentation are not charged as application registrations, and native outer assimilation is never suppressed.

The native behavior oracle is mandatory: for each matrix case, execute an uninstrumented realm and the instrumented realm and compare settlement, value/reason identity, constructor/prototype identity, accessor/method invocation order and count, and unhandled-rejection behavior where observable. Hand-written expectations alone are insufficient.

Ticket 41 is assumed complete: causal epochs, scheduler bounds, Shadow DOM handling, and safe Runner logs are inherited. This ticket may amend Promise instrumentation/accounting only and does not re-accept predecessor scope. Enumerable owner registry/revalidation belongs to Ticket 43; immutable snapshots and captured intrinsic authority belong to Ticket 44; full callback authority inventory belongs to Ticket 45.

Promise calls consume the inherited Ticket 41 registration limits: 1,024 per sensitive epoch and 4,096 per session. One direct application invocation of `then`, `catch`, or `finally` is one application registration even when native semantics internally perform additional `then` calls or thenable assimilation; a custom application method that explicitly performs another registration is charged for that additional application-visible invocation. Overflow follows the inherited `SensitiveEvidenceUnavailable` evidence latch after the native registration still runs.

## Migration

None; existing and allocated closure migrations are immutable to this ticket.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`

## Authority

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.1-6.2, 8, 10, 11, and 13. Instrumentation may protect evidence but cannot become application execution authority or change target behavior.
- Context authority: `CONTEXT-MAP.md`, `docs/contexts/execution/CONTEXT.md`, and `docs/contexts/evidence/CONTEXT.md`.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` valueRef/evidence requirements and complete-matrix review/delivery Testing Decisions.
- Predecessor authority: `.scratch/remaining-production-closure/issues/41-shadow-dom-scheduler-log-remediation.md`, its eventual merged evidence, and the inherited causal registration bound. Completion is assumed; predecessor Shadow DOM, scheduler classes, and logging acceptance are excluded here.
- Native authority: ECMAScript behavior provided by current Node.js 24 and the Playwright-bundled Chromium on the implementation head, observed through the required paired native behavior oracle. The instrumented result must match the corresponding uninstrumented realm; tests must not replace native behavior with a local Promise model.
- Current public interfaces and tests: the browser sensitive-evidence authority and exact Allowed Files as they exist on the base.
- Closed PRs #78-#83 and any local WIP are historical context only. Their branches, commits, diffs, tests, and review claims are not implementation, source, or cherry-pick authority.

## Allowed Files

This is the complete edit scope:

- `packages/target-adapters/web-playwright/src/browser-session.ts`
- `packages/target-adapters/web-playwright/src/playwright-observer.ts`
- `packages/target-adapters/web-playwright/src/sensitive-evidence-authority.ts`
- `tests/unit/target-adapters/web-playwright/browser-session.test.ts`
- `tests/component/web-execution/playwright-observation.test.ts`
- `tests/component/web-execution/promise-native-oracle.test.ts` (new)
- `tests/component/web-execution/shadow-dom-scheduler-log.test.ts`
- `tests/e2e/web-execution/value-ref.test.ts`
- `.scratch/remaining-production-closure/issues/42-promise-finally-semantics-remediation.md`

No Runner production file, owner descriptor registry/snapshot hardening, DOM geometry code, package manifest, lockfile, or unrelated root is in scope.

## Focused non-E2E Gate

Run during implementation and after every code/test review fix:

```text
corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/shadow-dom-scheduler-log.test.ts tests/component/web-execution/promise-native-oracle.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

Run only after an exact-head complete-matrix review is clean:

```text
corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts
```

The Chromium E2E must use Promise chains to causally reflect input/select values, compare an instrumented page result with a native control realm, verify exact registration accounting at/over the bound, and scan Graph/Artifact/log/Spool sinks. Chromium absence or skips fail the Gate.

## Execution, review, and delivery protocol

- Start fresh from the then-current `main` after Ticket 41 merges. Record exact base/predecessor merge evidence, matrix applicability, and planned Gates; historical PR/WIP code is not a base or source.
- Keep `claimed`; run only the focused non-E2E Gate during edits and review fixes.
- Commit before each exact-base `/code-review`. Every round reviews the whole code/test diff and all matrix rows on Standards and Spec axes with `pass | finding | N/A`, reasons, and reviewed head.
- Use at most five complete-matrix rounds. Critical always blocks; Important blocks under the umbrella criteria. A remaining core blocker sets `needs-info` and stops Ticket 43.
- Record non-Critical advanced hardening in one GitHub Issue only; do not implement it here unless promoted.
- Run exact Chromium E2E only after clean review. Any later code/test edit repeats focused Gate, complete-matrix review, and E2E.
- Do not create a PR until focused Gate, typecheck, diff check, review, Chromium E2E, and `final` evidence are clean. Then create one non-draft PR; only final evidence with a byte-identical code/test diff may follow. Resolve after merge evidence.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Base Promise `then`/`catch`/`finally` with callable handlers | `started` at native registration | Instrumented settlement, value/reason, call order, and returned Promise match native oracle | One bounded causal registration per application call; no Promise data persists | New isolated realm may repeat; never replay application callbacks to repair evidence | Paired native/instrumented oracle |
| Handler is omitted or non-callable | `started` | Native pass-through/throw-through semantics and returned constructor match oracle | One application registration | Repeatable in isolated realm | Oracle equality over all three methods |
| Promise subclass uses default, base, alternate, null, or invalid `Symbol.species` | `started` | Constructor/prototype/result or native TypeError exactly matches oracle | Exact registration count only | Repeat in fresh realm; no species normalization | Constructor/prototype/invocation transcript |
| `finally` handler returns value, same-realm Promise, foreign thenable, throwing thenable getter, or rejection | `started` | Outer assimilation and original/overriding settlement exactly match oracle | Exact application count; instrumentation-internal assimilation is not overcounted | No synthetic retry of handler/thenable | Settlement and getter/`then` count transcript |
| Receiver has custom `then`, `catch`, or `finally` method/accessor | `started` when native access/call occurs | Native accessor/method receiver, order, count, return, or throw is preserved | Only actual application registration is counted | No fallback to captured default for behavior in this ticket | Native/instrumented custom-method oracle |
| Handler throws, returns self, or causes cycle rejection | `started` | Native rejection type/reason identity and timing match oracle | Registration count remains exact | Never invoke handler twice | Rejection and invocation-count evidence |
| Application registration is exactly 1,024 for the epoch and no more than 4,096 for the session | `started`; count occurs before native registration | Native registration proceeds and evidence remains eligible | Counter equals bound | Further independent registration follows overflow row | Boundary test and callback completion |
| Application registration exceeds 1,024 for the epoch or 4,096 for the session | `started`; overflow recorded before native registration | Native registration still proceeds; evidence latches `SensitiveEvidenceUnavailable` | No accepted Graph/Artifact from epoch/session | Do not cancel/suppress Promise reaction; fresh session may retry capture | Native completion plus code-only/zero-evidence result |
| Registration attempt throws before native registration completes | `not_started` or `started` exactly as native operation indicates | Same thrown value/order as oracle; accounting follows the defined attempted-registration rule exactly once | No evidence accepted if authority is uncertain | Repeat only in fresh oracle realm | Throw transcript and exact counter |
| Policy/value/action rejection occurs before sensitive epoch | `not_started` | Existing predecessor result | No Promise causal authority | Retry under predecessor rules | Zero registration assertion |
| Cancel/timeout before Promise callback dispatch | `started` if native registration already occurred | Native callback remains unaffected; capture may fail closed | Safe terminal evidence only | Never cancel/replay application reaction | Callback completion and capture result |
| Cancel/timeout after callback begins | `outcome_unknown` for evidence | Native settlement preserved; no unsafe evidence accepted | Existing safe error/code only | Fresh observation may retry; callback/action may not | Settlement plus zero unsafe evidence |
| Concurrent chains and session restart | `started` per native registrations | Native interleaving/order matches control; new session has fresh accounting | No registry/counter crosses close | Repeat only as a new session scenario | Concurrent oracle and cleanup evidence |
| Evidence persistence fails after native chain settles | `outcome_unknown` for terminal evidence | Existing persistence failure; Promise result is not changed | No unsafe fallback Artifact/Graph | Retry persistence only; never rerun chain/action | Failure injection and sink scan |

## Acceptance

- [ ] `then`, `catch`, and `finally` match the uninstrumented native oracle for base/subclass/species/custom-method/thenable/throw/cycle cases.
- [ ] Each application-visible causal registration is counted exactly once before native registration; instrumentation internals are not charged and outer assimilation is not suppressed.
- [ ] Bound overflow poisons evidence while preserving native registration, callbacks, values, reasons, constructor identities, and invocation order.
- [ ] Ticket 41 scheduler/Shadow DOM/log behavior remains green but is not re-claimed as Ticket 42 acceptance.
- [ ] Focused Gate, typecheck, diff check, complete-matrix review, and exact Chromium E2E are clean on the final code/test head.
