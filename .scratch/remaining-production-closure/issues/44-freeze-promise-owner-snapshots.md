# 44 - Freeze first approved Promise owner snapshots

**What to build:** Starting from current `main` after Ticket 43 merges, make the first approved post-instrumentation descriptor/prototype snapshot for every Promise owner immutable for the session, so any later assignment, deletion, accessor change, or prototype change permanently poisons sensitive evidence and can never be re-approved.

**Blocked by:** 43 - Revalidate bounded Promise owner descriptors.

**Status:** resolved

## Tracked scope

This ticket owns one-way owner approval. Complete controlled Promise instrumentation using captured native intrinsics, then record exactly one first approved snapshot for each owner discovered through Ticket 43. That snapshot includes owner/prototype identity and complete exact `then`/`catch`/`finally` descriptor state. No later observation, re-instrumentation, method delegation, or apparent restoration may replace, refresh, or bless that snapshot.

Any later own/inherited descriptor assignment, deletion, defineProperty change, accessor replacement, method replacement, or prototype identity change that is observed through controlled/captured intrinsic Object/Reflect APIs, through instrumented Promise owner re-observation while changed, through capture-boundary validation mismatch, inspection failure, incomplete enumeration, overflow, or another observable owner/prototype/descriptor authority failure permanently marks the owner/session unsafe for sensitive Graph/Artifact return, even if the original bytes/functions/descriptors are restored before capture. Validation and snapshot operations themselves must use captured native intrinsic authority rather than mutable page methods.

Maintainer decision for Ticket 44 Option A: this ticket does not claim detection of direct assignment/delete plus exact restoration on ordinary page objects when the entire changed-state history occurs between observation points, with no guarded Object/Reflect API call, instrumented Promise owner re-observation, capture-time validation mismatch, inspection failure, incomplete enumeration, overflow, or other observable owner/prototype/descriptor authority failure while the state is changed. Preserving native Promise/application behavior is required; intrusive descriptor wrapping, freezing, sealing, proxying, or equivalent behavioral interposition is excluded when used only to observe that otherwise unobservable history.

The first snapshot uses Ticket 43's 256-owner bound and complete three-method descriptor shape. A mutation or intrinsic-authority failure latches the inherited `SensitiveEvidenceUnavailable` result for every later sensitive Graph/Artifact capture in that session; only session close clears the in-memory latch, and no API may clear or replace it earlier.

Ticket 43 is assumed complete: bounded enumerable owner discovery and immediate pre-return revalidation are inherited. This ticket may tighten Ticket 43's approved-record lifecycle but does not re-accept its registry completeness. Full DOM/page-callback intrinsic inventory and geometry authority belong to Ticket 45.

## Migration

None; existing and allocated closure migrations are immutable to this ticket.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`

## Authority

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.1-6.2, 8, 10, 11, and 13. Security decisions fail closed while application behavior remains native.
- Context authority: `CONTEXT-MAP.md`, `docs/contexts/execution/CONTEXT.md`, and `docs/contexts/evidence/CONTEXT.md`.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` evidence/valueRef invariants and complete-matrix review/delivery protocol.
- Predecessor authority: `.scratch/remaining-production-closure/issues/43-revalidate-promise-owner-descriptors.md`, its eventual merged evidence, and the owner registry/revalidation interface. Completion is assumed; predecessor owner-enumeration acceptance is excluded here.
- Native intrinsic authority: native ECMAScript intrinsic functions captured in the isolated page realm before page code can mutate the methods used for descriptor/prototype inspection and controlled instrumentation. Ambient page helpers are not security authority.
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
- `tests/component/web-execution/promise-owner-integrity.test.ts`
- `tests/component/web-execution/promise-owner-snapshot.test.ts` (new)
- `tests/e2e/web-execution/value-ref.test.ts`
- `.scratch/remaining-production-closure/issues/44-freeze-promise-owner-snapshots.md`

No Runner production file, DOM getter/geometry inventory, package manifest, lockfile, or unrelated root is in scope.

## Focused non-E2E Gate

Run during implementation and after every code/test review fix:

```text
corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/promise-native-oracle.test.ts tests/component/web-execution/promise-owner-integrity.test.ts tests/component/web-execution/promise-owner-snapshot.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

Run only after an exact-head complete-matrix review is clean:

```text
corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts
```

The Chromium E2E must mutate and restore descriptors/prototypes after first approval, attempt re-instrumentation/re-registration, prove native page behavior continues, and prove sensitive Graph/Artifact/log/Spool evidence remains permanently unavailable in that session. Chromium absence or skips fail the Gate.

## Execution, review, and delivery protocol

- Start fresh from then-current `main` after Ticket 43 merges; record exact base/predecessor merge evidence, matrix applicability, and Gates. Do not source/cherry-pick historical PR/WIP code.
- Keep `claimed`; run only focused non-E2E verification during edits and review fixes.
- Commit before each exact-base `/code-review`; each round covers the entire code/test diff and every matrix row on both axes with `pass | finding | N/A`, reasons, and reviewed head.
- Use at most five complete-matrix rounds. Critical always blocks; Important follows umbrella criteria. A remaining core blocker sets `needs-info` and stops Ticket 45.
- Record non-Critical advanced hardening in one GitHub Issue only; do not implement it unless promoted.
- Run exact Chromium E2E only after clean review. Any code/test change repeats focused Gate, review, and E2E.
- Do not create a PR until focused Gate, typecheck, diff check, review, Chromium E2E, and `final` evidence are clean. Then create one non-draft PR; only final evidence with a byte-identical code/test diff may follow. Resolve after merge evidence.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Controlled instrumentation completes and a new owner is first observed | `started` at instrumentation/owner observation | Native behavior preserved; first approved exact snapshot is frozen once | Immutable in-memory owner snapshot for session | Re-observation compares; it never rewrites snapshot | Snapshot content/identity and native oracle |
| Owner remains byte/identity-exact through repeated observations | `started` | Graph/Artifact eligibility follows predecessor rules | Original snapshot unchanged | Unlimited comparisons within bound | Snapshot object/version unchanged assertion |
| Data descriptor value or flags are assigned/changed after approval and observed through a guarded Object/Reflect mutation, Promise owner re-observation while changed, or capture-boundary mismatch | `started` | Native assignment behavior remains; every later sensitive capture returns `SensitiveEvidenceUnavailable` | Unsafe latch retained for session; snapshot unchanged | Restoration or re-registration cannot clear latch | Mutate/restore/recapture test |
| Accessor getter/setter or descriptor shape changes after approval and is observed through an approved observation point | `started` | Native property behavior remains; evidence permanently poisoned | Same one-way unsafe latch | No reapproval | Accessor mutation matrix |
| Method/own property is deleted then inherited or restored after an observed guarded mutation or while changed at re-observation/validation | `started` | Native lookup behavior remains; evidence permanently poisoned | Original owner/method snapshot retained | Delete/restore cannot recover evidence authority once observed | Delete/inherit/restore tests |
| Owner prototype changes and later returns to original identity after an observed guarded mutation or while changed at re-observation/validation | `started` | Native prototype mutation behavior remains; evidence permanently poisoned | Prototype-change latch retained | No reapproval after restoration once observed | Prototype round-trip test |
| Direct assignment/delete plus exact restoration occurs entirely between observation points on an ordinary page object | `started` | Native behavior preserved; current exact state may pass because no changed state was observable | Original snapshot unchanged; no history claim is created | Not a Ticket 44 detection guarantee; new observable mutation still poisons | Boundary documentation/native-preservation test |
| Controlled instrumentation itself changes descriptors before first approval | `started` | Instrumentation completes with native behavior; only final controlled state is first-approved | One snapshot after controlled setup, none before | Instrumentation cannot run again to refresh approval | Order transcript and one-snapshot assertion |
| Page attempts re-instrumentation or owner re-registration after mutation | `started` | Application call proceeds/fails natively; unsafe latch remains | No new approved snapshot | Never replace first snapshot | Re-registration attack test |
| Ambient `Object`/`Reflect` descriptor or prototype helpers are replaced | `started` | Snapshot/validation uses captured intrinsic authority or fails closed | No approval based on ambient helper | Restoration does not erase any unsafe latch | Intrinsic-tamper tests |
| Owner bound is exceeded | `started` | Native Promise behavior proceeds; evidence poisoned | No accepted Graph/Artifact | New session may retry; no callback cancellation | Overflow plus native oracle |
| Policy/value/action rejection occurs before sensitive epoch | `not_started` | Existing predecessor result | No owner snapshot created solely by rejected action | Existing retry rules | Zero relevant snapshot assertion |
| Cancel/timeout before/after owner mutation | `started` if mutation/application behavior occurred | Native behavior remains; evidence stays unsafe when mutation occurred | Unsafe latch survives until close | Never replay action/callback or clear latch | Cancellation and latch evidence |
| Session closes/restarts | `started` if snapshots existed | Session-local snapshots/latches clear after close; new session recaptures fresh native authority | No owner references cross session | New authorization/action required | Cleanup/restart evidence |
| Evidence persistence fails after valid snapshot checks | `outcome_unknown` for terminal evidence | Existing persistence failure; snapshot authority is not weakened | No unsafe fallback evidence | Retry persistence only | Sink failure and unchanged snapshot evidence |

## Comments

### start — 2026-08-26

- Fixed base: `5f6ee13e8cb9bfcd8e0f401e9d3bccd3a1782199` (`main` after Ticket 43 and Ticket 28 merge commits; current branch `ticket-44-freeze-promise-owner-snapshots`).
- Predecessor Ticket 43 evidence: resolved with PR #117 (`https://github.com/ljie-PI/Qualigence/pull/117`), reviewed code/test head `57547dce98cae1b43788856a8573dbcf0c14e6a6`, final evidence commit `de3873eef4f9268144d450d5adf02f7d53bbd0c1`, PR evidence commit `6fbc2c4d78dab248187bda30d8da8a709b7afd96`, and merge commit `6579bbbaedb1f0cb1361701d4778081d5c7db73b` present in the current base history.
- Behavior Matrix applicability: complete Ticket 44 matrix is applicable. In-scope rows cover controlled instrumentation and first immutable owner snapshot creation, repeated exact observations without snapshot rewrite, data/accessor/method/descriptor/prototype mutation latching, delete/restore and re-registration attacks, captured-native-intrinsic descriptor/prototype authority, 256-owner overflow, no snapshot creation for pre-sensitive rejections, cancellation/timeout persistence of unsafe latches when mutation occurred, session-close cleanup, and evidence persistence fail-closed behavior. Ticket 45 DOM getter/geometry inventory, Runner production files, package manifests/lockfile, migrations, and unrelated roots are excluded.
- Planned Gates: `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/promise-native-oracle.test.ts tests/component/web-execution/promise-owner-integrity.test.ts tests/component/web-execution/promise-owner-snapshot.test.ts`, then `CI=true corepack pnpm typecheck`, then `git diff --check`. Complete-matrix review and post-review Chromium E2E (`CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts`) remain pending after implementation.

### blocked — 2026-08-26

- Blocker: the Ticket 44 matrix rows for direct assignment/deletion followed by exact restoration before capture cannot be satisfied non-intrusively for ordinary page objects/Promise owners. ECMAScript exposes no hook for `owner.then = replacement` or `delete owner.then` on a plain object when the page restores the original descriptor/prototype before any instrumented Promise method, guarded `Object`/`Reflect` helper, or capture-time validation observes the changed state.
- Implemented prototype in the worktree can latch guarded `Object.defineProperty`/`Object.defineProperties`/`Object.assign`/`Object.setPrototypeOf` and `Reflect.*` mutations, and can latch direct assignment when a sensitive epoch re-observes the owner while it is still changed; it cannot prove an unobserved direct set/delete+restore history.
- Intrusive alternatives would require wrapping/freezing/redefining approved owner descriptors, interposing proxies, or otherwise changing object/prototype semantics. Those options would alter observable descriptor state or assignment/delete behavior and violate the native Promise/application behavior requirement.
- Historical blocker note: initial implementation hit an authority conflict and was paused for maintainer decision. Maintainer selected Option A; implementation continued under the revised acceptance boundary.

### maintainer-decision — 2026-08-26

- Maintainer selected Option A and narrowed Ticket 44 acceptance: Ticket 44 does not claim detection of direct assignment/delete plus exact restoration on ordinary page objects when the entire mutation/restore history occurs between observation points, with no guarded Object/Reflect API call, instrumented Promise owner re-observation, capture-time validation mismatch, inspection failure, incomplete enumeration, overflow, or other observable owner/prototype/descriptor authority failure while the state is changed.
- Ticket 44 must preserve native Promise/application behavior and must not use intrusive descriptor wrapping, freezing, sealing, proxying, or equivalent behavioral interposition merely to observe otherwise unobservable mutation history.
- Ticket 44 still requires first-approved immutable owner/session snapshots and one-way unsafe latching for mutations observed through controlled/captured intrinsic Object/Reflect APIs, through instrumented Promise owner re-observation while changed, through capture-boundary validation mismatch, inspection failure, incomplete enumeration, overflow, or other observable owner/prototype/descriptor authority failure. Re-instrumentation/re-registration after an observed mutation cannot replace the first snapshot or clear the unsafe latch.

### review-fix — 2026-08-26

- Reviewed head fixed: `d8e1a082ea21641155bdffdd306c89b00e37bb59`.
- Fix commit: `96be27df699fd3014a4b3aa41383bd8cd1c5d1d0` (`fix(ticket-44): close promise owner review blockers`).
- Findings fixed:
  - Captured-intrinsic authority now uses captured native Array and Set prototype operations for owner discovery/storage/enumeration/validation and related controlled runtime arrays; added coverage for page tampering of `Array.prototype.push` and `Set.prototype.has`/`add`/`size` before sensitive Promise use and validation.
  - Guarded `Object.assign` and `Object.defineProperties` now latch an already approved Promise owner when the native API reaches a partial-mutation boundary and then throws, without changing native thrown/result behavior; added direct-restore tests for both APIs.
  - Observed Promise owner mutation latches now notify the host session so the one-way `SensitiveEvidenceUnavailable` state survives same-session navigation until session close; added navigation/restart coverage.
- Gates run on the fix worktree before the fix commit: `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/promise-native-oracle.test.ts tests/component/web-execution/promise-owner-integrity.test.ts tests/component/web-execution/promise-owner-snapshot.test.ts` (pass, 5 files / 45 tests), `CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` (pass, 1 file / 2 tests), `CI=true corepack pnpm typecheck` (pass), and `git diff --check` (pass).
- Status remains `claimed`; this is not final/PR evidence and no PR was created or merged.

## Acceptance

- [x] Controlled instrumentation completes before exactly one immutable first-approved snapshot is stored per owner.
- [ ] Later assignment, deletion, descriptor/accessor/method replacement, or prototype change that is observed through a controlled/captured Object/Reflect API, instrumented Promise owner re-observation while changed, capture-boundary validation mismatch, inspection failure, incomplete enumeration, overflow, or another observable owner/prototype/descriptor authority failure permanently poisons sensitive evidence for the session, even after exact restoration or re-registration. Direct assignment/delete plus exact restoration entirely between observation points is explicitly out of claim.
- [x] Snapshot and validation use captured native intrinsic authority and preserve native Promise/application behavior.
- [x] Ticket 43 enumerable registry/revalidation remains green but is not re-claimed as Ticket 44 acceptance.
- [x] Focused Gate, typecheck, diff check, complete-matrix review, and exact Chromium E2E are clean on the final code/test head.

### final — 2026-08-26

- Reviewed code/test head: `5bcbbf95c6180e00f7e0f73afece761ec6885408`.
- Complete-matrix review: Standards and Spec review reported no core blockers (`Q:/Qualigence/.pi-subagents/artifacts/outputs/38db09e8-5a9a-41c0-85bf-a2e50e49921b/ticket44-review2/standards.md`, `Q:/Qualigence/.pi-subagents/artifacts/outputs/38db09e8-5a9a-41c0-85bf-a2e50e49921b/ticket44-review2/spec.md`).
- Final verification: `CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` (1 file / 2 tests), `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/promise-native-oracle.test.ts tests/component/web-execution/promise-owner-integrity.test.ts tests/component/web-execution/promise-owner-snapshot.test.ts` (5 files / 45 tests), `CI=true corepack pnpm typecheck`, and `git diff --check` passed.
- Pull request: `https://github.com/ljie-PI/Qualigence/pull/121`.

## Answer

Implemented Ticket 44 under the maintainer-approved Option A boundary. Promise owner authority now records immutable first-approved snapshots, uses captured native intrinsic authority for snapshot/validation and guarded mutation APIs, never refreshes approved owner records, permanently poisons sensitive evidence for observed owner descriptor/prototype/method changes even after restoration or re-registration, preserves native Promise/application behavior, and keeps the unobservable direct mutation plus exact-restore history outside the ticket's claim. Focused component coverage and Chromium valueRef E2E prove fail-closed evidence behavior.

Pull request: `https://github.com/ljie-PI/Qualigence/pull/121`

Reviewed code/test head: `5bcbbf95c6180e00f7e0f73afece761ec6885408`

Final verification: focused Ticket 44 Gate, Chromium valueRef E2E, `corepack pnpm typecheck`, and `git diff --check` passed.
