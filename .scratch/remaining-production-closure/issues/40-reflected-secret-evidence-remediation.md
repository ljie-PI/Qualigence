# 40 - Redact causally reflected secret evidence

**What to build:** Starting from current `main` after Ticket 39 merges, track a bounded causal action-to-capture epoch for authorized sensitive input/select actions, classify only Graph nodes and screenshot regions produced by that epoch, and redact or mask them before evidence return without globally replacing unrelated equal text.

**Blocked by:** 39 - Redact browser-normalized input and select forms.

**Status:** claimed

## Tracked scope

This ticket owns light-DOM causal reflection from a sensitive action through the next accepted evidence capture. A permitted input/select dispatch opens an action epoch; synchronous action/event-listener work and its mutation records may classify nodes or regions only when they expose a Ticket 39 source/canonical form. Async timer/rAF/microtask/Promise propagation is not claimed here: if the epoch observes a matching mutation without synchronous attribution, capture fails `SensitiveEvidenceUnavailable`; Ticket 41 owns scheduler propagation and bounds. The epoch retains bounded action, node, and region records, closes deterministically after capture or terminal failure, and poisons evidence rather than broadening redaction when a bound is exceeded.

Maintainer scope decision: Ticket 40 is re-cut as **synchronous light-DOM causal reflected-evidence only**. It must not implement timer, rAF, microtask, Promise, scheduler propagation, Shadow DOM success propagation, Promise owner, DOM getter, CDP geometry, or independent PNG hardening. Sensitive forms observed through unattributed, delegated, or scheduler-adjacent mutation in Ticket 40 fail evidence closed with `SensitiveEvidenceUnavailable` and return zero accepted Graph/Artifact bytes; successful propagation through those mechanisms belongs to Ticket 41 and later tickets. Existing experimental branch `closure/ticket-40-reflected-secret-evidence` is not implementation authority; new work starts from current `main`, though that branch may be inspected only as non-authoritative background.

Maintainer follow-up scope decision: Ticket 40 may include the minimum production Shadow DOM detector/wrapper needed to fail evidence closed when a sensitive epoch touches or exposes forms inside open, closed, or otherwise unprovable shadow roots. This authorization is limited to fail-closed detection in the existing Ticket 40 allowed production files; it does not authorize successful Shadow DOM traversal, propagation, redaction, masking, scheduler/Promise propagation, or any Ticket 41+ hardening.

Ticket 39 is assumed complete: target-bound source/browser forms and primary target-field sink protection are inherited. This ticket may amend that implementation to attach causal node/region provenance, but it does not re-accept browser normalization or Ticket 18 behavior.

Global document-string matching, masking every region with equal text, OCR-based global replacement, and unrelated equal-node redaction are forbidden. Successful open/closed Shadow DOM traversal/redaction and scheduler registration accounting belong to Ticket 41; Ticket 40 may only use a minimal Shadow DOM detector/wrapper to return `SensitiveEvidenceUnavailable` with zero accepted evidence when shadow-root safety cannot be proven. Exact native Promise behavior, Promise owner integrity, mutable DOM getter authority, CDP geometry, and independent PNG proof belong to Tickets 42-45.

Reflected Graph fields use Ticket 39's `[redacted]`; every screenshot pixel inside a classified region becomes opaque black RGBA `(0, 0, 0, 255)`, with image dimensions and all outside pixels preserved. The fixed action-to-capture bound is one active sensitive epoch, 1,024 observed mutation records, 256 unique causally classified nodes, and 256 unique mask regions. Records deduplicate by `(action identity, node identity, mutation ordinal)` and regions by `(action identity, node identity)`. Exceeding a bound, losing attribution, observing an unattributed matching mutation, or reaching capture with an open/unsettled epoch returns the Ticket 39 `SensitiveEvidenceUnavailable` execution error and zero accepted Graph/Artifact bytes; it never broadens classification.

## Migration

None; existing and allocated closure migrations are immutable to this ticket.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`

## Authority

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.1-6.2, 8, 10, 11, and 13. Semantic observations and screenshot Artifacts are sensitive Runner-owned evidence and must be redacted before return/persistence.
- Context authority: `CONTEXT-MAP.md`, `docs/contexts/execution/CONTEXT.md`, and `docs/contexts/evidence/CONTEXT.md`.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` user stories 29-35 and 70; valueRef/evidence Implementation Decisions; Chromium sink and complete-matrix Testing Decisions.
- Predecessor authority: `.scratch/remaining-production-closure/issues/39-browser-normalized-secret-redaction-remediation.md`, its eventual merged PR/check evidence, and its public target-bound forms. Predecessor completion is assumed and is not acceptance owned here.
- Current public interfaces and tests: `PlaywrightBrowserSession`, `PlaywrightActionExecutor`, `PlaywrightObserver`, `CapturedArtifact`, Graph/Trace serialization, and the exact Allowed Files on the implementation base.
- Closed PRs #78-#83 and any local WIP are historical context only. Their branches, commits, diffs, tests, and review claims are not implementation, source, or cherry-pick authority.

## Allowed Files

This is the complete edit scope:

- `packages/target-adapters/web-playwright/src/browser-session.ts`
- `packages/target-adapters/web-playwright/src/playwright-action-executor.ts`
- `packages/target-adapters/web-playwright/src/playwright-observer.ts`
- `packages/target-adapters/web-playwright/src/sensitive-evidence-authority.ts`
- `tests/unit/target-adapters/web-playwright/browser-session.test.ts`
- `tests/component/web-execution/playwright-click.test.ts`
- `tests/component/web-execution/playwright-observation.test.ts`
- `tests/component/web-execution/reflected-secret-evidence.test.ts` (new)
- `tests/e2e/web-execution/value-ref.test.ts`
- `.scratch/remaining-production-closure/issues/40-reflected-secret-evidence-remediation.md`

No Runner production file, Shadow DOM success-propagation implementation, scheduler wrapper, Promise hardening, package manifest, lockfile, or unrelated test root is in scope. A minimal Shadow DOM fail-closed detector/wrapper in the listed web-playwright files is in scope only for rejecting unsafe evidence, not for successful Shadow DOM observation/redaction.

## Focused non-E2E Gate

Run during implementation and after every code/test review fix:

```text
corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/reflected-secret-evidence.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

Run only after an exact-head complete-matrix review is clean:

```text
corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts
```

The real Chromium case must cause input and select handlers to reflect sensitive forms into distinct light-DOM nodes and visible screenshot regions, retain unrelated equal text outside the causal epoch, and inspect decoded Graph/Trace plus Artifact bytes and existing log/Spool sinks. Chromium absence or a skipped case is a failure.

## Execution, review, and delivery protocol

- Start from the then-current `main` only after Ticket 39 is merged and resolved. Record exact base/predecessor merge evidence and matrix/Gate applicability in ticket-local `start` evidence; historical PR branches and WIP are not bases.
- Keep `claimed` during implementation. Run only the focused non-E2E Gate during edits and review fixes.
- Commit before each exact-base `/code-review`. Every round reviews the whole code/test diff and every matrix row on both axes, with row-level `pass | finding | N/A`, reasons, and reviewed head.
- Use at most five complete-matrix rounds. Critical findings always block; Important findings block only under the umbrella protocol. A remaining core blocker sets this ticket to `needs-info` and stops Ticket 41.
- Record non-Critical advanced hardening in one GitHub Issue only; do not implement or depend on it here unless promoted.
- Run the exact Chromium E2E only after clean review. Any later code/test change restarts focused verification, complete-matrix review, and E2E.
- Do not create a PR until focused Gate, typecheck, diff check, review, Chromium E2E, and `final` evidence are clean. Then create one non-draft PR; only a byte-identical final-evidence commit may follow review. Resolve only after merge evidence is recorded.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Sensitive input/select event causally writes a normalized form to a light-DOM node before capture | `started` at permitted action dispatch | Action succeeds; reflected Graph node is redacted | Redacted node plus existing valueRef/action provenance only | Repeated capture in the same closed epoch remains redacted without replaying action | Causal mutation/component and Chromium Graph evidence |
| Causally reflected node occupies a visible screenshot region | `started` | Screenshot bytes mask only the classified region before Artifact return | Only masked PNG bytes may enter Artifact/Spool paths | Capture may retry under the bounded capture policy; never persist the unmasked first result | Pixel/byte evidence and Artifact sink scan |
| Equal text exists before the action or changes outside its causal epoch | `not_started` for that node/region | Node and screenshot region remain unchanged | Ordinary non-causal evidence may persist | Equality alone never changes classification on replay | Paired equal-text Graph and image assertions |
| Causal callback produces content that does not contain a registered Ticket 39 form | `started` | Ordinary evidence is returned | No sensitive classification retained for that node | Repeated capture remains ordinary unless a later authorized action causally exposes a form | Negative causal-content test |
| The one-epoch, 1,024-mutation, 256-node, or 256-region bound is exceeded, attribution is lost, or capture finds an unsettled epoch | `started` | `SensitiveEvidenceUnavailable`; page action is not cancelled | No Graph/Artifact from the poisoned epoch is accepted | New session may retry; do not replay the action automatically | Boundary/overflow tests with code-only failure and zero returned evidence |
| Value/policy/capability/target rejection occurs before dispatch | `not_started` | Existing stable rejection | No causal epoch or durable record | Retry only after correcting the existing rejection | Zero epoch/mutation registration assertion |
| Cancel/timeout before dispatch | `not_started` | Existing cancellation/timeout | No action effect or epoch | Existing safe retry rules apply | Permit and registration assertions |
| Cancel/timeout after dispatch but before causal capture completes | `outcome_unknown` | `ActionOutcomeUnknown` or stable evidence-capture failure; no automatic action replay | Terminal code/valueRef may persist; unclassified/unmasked evidence does not | A separately authorized observation may retry; action may not | Unknown-outcome and zero-unmasked-byte evidence |
| Duplicate observer notification for the same action/node/region | `started` | One semantic classification and mask | Bounded registry cardinality is unchanged | Idempotent within epoch | Deduplication/count assertions |
| A second authorized sensitive action begins after the first epoch closes | `started` | Distinct action epoch and target provenance | Only bounded current/session history needed for safe capture | Never merge epochs solely by equal value | Sequential action/capture evidence |
| Concurrent capture/action or session restart | `not_started` for rejected concurrency; fresh state after restart | Existing serialized-session result; no cross-session causal authority | Registry is cleared on close | Retry through a new authorized action/session | Concurrency and cleanup tests |
| Graph/Artifact/Spool persistence fails after masked capture | `outcome_unknown` for terminal evidence | Existing terminal persistence failure; no successful evidence claim | Unmasked bytes are never retained as fallback | Retry persistence under existing semantics; never rerun action to reconstruct evidence | Failure injection and serialized byte scan |

## Acceptance

- [ ] Bounded action-to-capture provenance classifies only light-DOM nodes and screenshot regions causally exposing Ticket 39 forms.
- [ ] One active epoch and the exact 1,024-mutation/256-node/256-region limits deduplicate by the declared identities and fail with `SensitiveEvidenceUnavailable` on overflow or uncertain attribution.
- [ ] Classified Graph fields are redacted and screenshot regions are masked before evidence return or persistence.
- [ ] Graph uses `[redacted]`; masked pixels are opaque black RGBA `(0, 0, 0, 255)` while image dimensions and all pixels outside classified regions remain exact.
- [ ] Unrelated equal text and pixels remain unchanged; global string/region replacement is absent.
- [ ] Overflow, incomplete attribution, timeout, and capture failure fail evidence closed without cancelling or replaying the application action.
- [ ] Ticket 39 normalization remains green but is not re-claimed as Ticket 40 acceptance.
- [ ] Focused Gate, typecheck, diff check, complete-matrix review, and exact Chromium E2E are clean on the final code/test head.

## Comments

- needs-info resolution: Maintainer re-authorized Ticket 40 as synchronous light-DOM causal reflected-evidence only. Timer/rAF/microtask/Promise/scheduler propagation, Shadow DOM, Promise owner, DOM getter, CDP geometry, and independent PNG hardening stay out of Ticket 40 and remain owned by Ticket 41+ as already tracked. Ticket 40 may proceed by succeeding on synchronously attributed light-DOM reflections and by failing evidence closed with `SensitiveEvidenceUnavailable` plus zero accepted Graph/Artifact bytes for unattributed, delegated, scheduler-adjacent, or still-open/unsettled sensitive epochs.
- continuation base: The historical experimental branch `closure/ticket-40-reflected-secret-evidence` remains intentionally unmerged and is not implementation/cherry-pick authority. Continue from current `main`; the branch may be inspected only as non-authoritative background.

### start — 2026-08-25

- Fixed base: `f34e7547c8208dd85425f64992553d4b8d290afc` (`main`, includes PR #105 merge `f34e754` reauthorizing Ticket 40 scope after PR #104 touchpoint guidance).
- Predecessor merge evidence: Ticket 39 is `resolved` with PR #94 merge commit `8fd56808dea9fc8b202e0d4833a0e8f5606e6001` recorded in `.scratch/remaining-production-closure/issues/39-browser-normalized-secret-redaction-remediation.md` and present in current history.
- Behavior Matrix applicability: complete matrix in this ticket is applicable for synchronous light-DOM causal reflected evidence. Scheduler, Shadow DOM, Promise-owner, DOM-getter, CDP geometry, independent PNG hardening, and Runner log rows remain out of scope here and are boundary-owned by Ticket 41+.
- Planned Gates: `corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/reflected-secret-evidence.test.ts`, then `corepack pnpm typecheck`, then `git diff --check`. Post-review Chromium E2E remains deferred per ticket protocol.

### review-fix — 2026-08-25

- Reviewed head: `1592b0e1d8b428ae2c102dab6c498bce7a6d0fa1`.
- Core blockers addressed: Shadow DOM sensitive forms now fail closed without accepted Graph/Artifact bytes; delegated/unattributed matching mutations no longer become successful classifications; capture rechecks sensitive evidence before and after screenshot registration points to close the DOM-collection-to-screenshot race; E2E select redaction assertions and decoded PNG Artifact sampling were updated.
- Fix commit: pending in this review-fix commit.
- Gates run: `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/reflected-secret-evidence.test.ts` (passed: 4 files / 66 tests); `CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` (passed: 1 file / 1 test); `CI=true corepack pnpm typecheck` (passed); `git diff --check` (passed).

### scope-decision — 2026-08-25

- Maintainer authorized a narrow Ticket 40 scope amendment after review head `e5af77d2fb8cf56dfac1eed9efbc82fa0af4bf86`: a minimal Shadow DOM fail-closed detector/wrapper may remain in the listed web-playwright files solely to prevent accepted Graph/Artifact evidence when sensitive forms enter open, closed, or otherwise unprovable shadow roots during a Ticket 40 sensitive epoch. This does not authorize Shadow DOM success propagation/redaction/masking, scheduler/Promise propagation, or Ticket 41+ hardening.
- Remaining core fixes to implement after this decision: DOM0/property delegated handlers such as `document.body.oninput` must fail closed with `SensitiveEvidenceUnavailable` and zero accepted evidence, and equal text introduced after a closed sensitive epoch must remain ordinary instead of causing global fail-closed behavior.

### review-fix 2 — 2026-08-25

- Reviewed head: `e5af77d2fb8cf56dfac1eed9efbc82fa0af4bf86`.
- Scope decision: `9d87f36188b93219e9c755f30069ef654e759523` authorized only minimal Shadow DOM fail-closed detection/wrapping for Ticket 40, with no Shadow DOM success propagation/redaction/masking, scheduler/Promise propagation, or Ticket 41+ hardening.
- Core blockers fixed: DOM0/property delegated `input`/`change` handlers now fail closed with `SensitiveEvidenceUnavailable` and no accepted observation artifacts; page-side sensitive form scan records are retired after the successful closed-epoch capture so later unrelated equal text remains ordinary instead of globally poisoning evidence.
- Fix commit: `3479354a7ead0304d5b23c4111fa8b8dbce50617`.
- Gates run: `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/reflected-secret-evidence.test.ts` (passed: 4 files / 71 tests); `CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` (passed: 1 file / 1 test); `CI=true corepack pnpm typecheck` (passed); `git diff --check` (passed).

### review-fix 3 — 2026-08-25

- Reviewed head: `83813d860ef48acf4b77a7a973a0086f40d01f1d`.
- Core blockers fixed: nested light-DOM observed ancestors now receive the same sensitive marker/redaction when a descendant synchronously reflects a registered form, preventing ancestor `textContent` Graph/Artifact leaks without global string replacement; direct-target `Promise.resolve().then(...)` and `queueMicrotask(...)` reflected forms now poison the Ticket 40 epoch and fail closed with `SensitiveEvidenceUnavailable` and no accepted observation artifacts rather than becoming synchronous success propagation.
- Fix commit: `bbcd71707731ae42008acca55feaf32f481c9431`.
- Gates run: `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/reflected-secret-evidence.test.ts` (passed: 4 files / 74 tests); `CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` (passed: 1 file / 1 test); `CI=true corepack pnpm typecheck` (passed); `git diff --check` (passed).

### review-fix 4 — 2026-08-25

- Reviewed head: `74f24073e63e85b4ad453fcd98b20d2229225834`.
- Core blockers fixed: causally reflected `document.title` now redacts to `[redacted]` before `web/v1` metadata, legacy graph title, Graph JSON Artifact, Trace/Spool/log/public evidence serialization; direct ShadowRoot text-node reflections now fail closed with `SensitiveEvidenceUnavailable` and no accepted observation artifacts; Ticket 40 production code no longer wraps `queueMicrotask` or `Promise.prototype.then` while preserving fail-closed Promise/queueMicrotask reflected-form behavior; input/select page epoch setup now completes before `ExecutionPermit.assertAuthorizedForDispatch(...)`, leaving no awaited page instrumentation between the permit dispatch point and `locator.fill`/`locator.selectOption`.
- Fix commit: `097cfbc7c522d48796dbe7e8c0a0101f9da2ea0a`.
- Gates run: `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/reflected-secret-evidence.test.ts` (passed: 4 files / 78 tests); `CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` (passed: 1 file / 1 test); `CI=true corepack pnpm typecheck` (passed); `git diff --check` (passed).

### review-fix 5 — 2026-08-25

- Reviewed head: `17fa1d7edec26e16df638f2693a31c8307374805`.
- Core blockers fixed: repeated captures after a causally reflected `document.title` now reuse the persisted title sensitivity marker/form binding and keep matching title metadata redacted in `web/v1`, the legacy title field, JSON Artifact, Trace/Spool/log/public graph serialization; unknown title marker bindings fail closed with `SensitiveEvidenceUnavailable`. Delegated `input`/`change` listeners or DOM0/property handlers registered dynamically on an ancestor/document/window during focus or target dispatch are re-checked during mutation processing and poison matching reflected evidence instead of being accepted as successful classification.
- Fix commit: `0a1154a52656e3fe93fd98a2d0e4a6bc8ea5937d`.
- Gates run: `corepack pnpm exec tsc -b packages/target-adapters/web-playwright/tsconfig.json` (passed; refreshed local dist used by package self-tests); `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/reflected-secret-evidence.test.ts` (passed: 4 files / 80 tests); `CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` (passed: 1 file / 1 test); `CI=true corepack pnpm typecheck` (passed); `git diff --check` (passed).
