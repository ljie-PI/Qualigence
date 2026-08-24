# 44 - Freeze first approved Promise owner snapshots

**What to build:** Starting from current `main` after Ticket 43 merges, make the first approved post-instrumentation descriptor/prototype snapshot for every Promise owner immutable for the session, so any later assignment, deletion, accessor change, or prototype change permanently poisons sensitive evidence and can never be re-approved.

**Blocked by:** 43 - Revalidate bounded Promise owner descriptors.

**Status:** ready-for-agent

## Tracked scope

This ticket owns one-way owner approval. Complete controlled Promise instrumentation using captured native intrinsics, then record exactly one first approved snapshot for each owner discovered through Ticket 43. That snapshot includes owner/prototype identity and complete exact `then`/`catch`/`finally` descriptor state. No later observation, re-instrumentation, method delegation, or apparent restoration may replace, refresh, or bless that snapshot.

Any later own/inherited descriptor assignment, deletion, defineProperty change, accessor replacement, method replacement, or prototype identity change permanently marks the owner/session unsafe for sensitive Graph/Artifact return, even if the original bytes/functions/descriptors are restored before capture. Validation and snapshot operations themselves must use captured native intrinsic authority rather than mutable page methods.

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
| Data descriptor value or flags are assigned/changed after approval | `started` | Native assignment behavior remains; every later sensitive capture returns `SensitiveEvidenceUnavailable` | Unsafe latch retained for session; snapshot unchanged | Restoration or re-registration cannot clear latch | Mutate/restore/recapture test |
| Accessor getter/setter or descriptor shape changes after approval | `started` | Native property behavior remains; evidence permanently poisoned | Same one-way unsafe latch | No reapproval | Accessor mutation matrix |
| Method/own property is deleted then inherited or restored | `started` | Native lookup behavior remains; evidence permanently poisoned | Original owner/method snapshot retained | Delete/restore cannot recover evidence authority | Delete/inherit/restore tests |
| Owner prototype changes and later returns to original identity | `started` | Native prototype mutation behavior remains; evidence permanently poisoned | Prototype-change latch retained | No reapproval after restoration | Prototype round-trip test |
| Controlled instrumentation itself changes descriptors before first approval | `started` | Instrumentation completes with native behavior; only final controlled state is first-approved | One snapshot after controlled setup, none before | Instrumentation cannot run again to refresh approval | Order transcript and one-snapshot assertion |
| Page attempts re-instrumentation or owner re-registration after mutation | `started` | Application call proceeds/fails natively; unsafe latch remains | No new approved snapshot | Never replace first snapshot | Re-registration attack test |
| Ambient `Object`/`Reflect` descriptor or prototype helpers are replaced | `started` | Snapshot/validation uses captured intrinsic authority or fails closed | No approval based on ambient helper | Restoration does not erase any unsafe latch | Intrinsic-tamper tests |
| Owner bound is exceeded | `started` | Native Promise behavior proceeds; evidence poisoned | No accepted Graph/Artifact | New session may retry; no callback cancellation | Overflow plus native oracle |
| Policy/value/action rejection occurs before sensitive epoch | `not_started` | Existing predecessor result | No owner snapshot created solely by rejected action | Existing retry rules | Zero relevant snapshot assertion |
| Cancel/timeout before/after owner mutation | `started` if mutation/application behavior occurred | Native behavior remains; evidence stays unsafe when mutation occurred | Unsafe latch survives until close | Never replay action/callback or clear latch | Cancellation and latch evidence |
| Session closes/restarts | `started` if snapshots existed | Session-local snapshots/latches clear after close; new session recaptures fresh native authority | No owner references cross session | New authorization/action required | Cleanup/restart evidence |
| Evidence persistence fails after valid snapshot checks | `outcome_unknown` for terminal evidence | Existing persistence failure; snapshot authority is not weakened | No unsafe fallback evidence | Retry persistence only | Sink failure and unchanged snapshot evidence |

## Acceptance

- [ ] Controlled instrumentation completes before exactly one immutable first-approved snapshot is stored per owner.
- [ ] Later assignment, deletion, descriptor/accessor/method replacement, or prototype change permanently poisons sensitive evidence for the session, even after exact restoration or re-registration.
- [ ] Snapshot and validation use captured native intrinsic authority and preserve native Promise/application behavior.
- [ ] Ticket 43 enumerable registry/revalidation remains green but is not re-claimed as Ticket 44 acceptance.
- [ ] Focused Gate, typecheck, diff check, complete-matrix review, and exact Chromium E2E are clean on the final code/test head.
