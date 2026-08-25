# 40 - Redact causally reflected secret evidence

**What to build:** Starting from current `main` after Ticket 39 merges, track a bounded causal action-to-capture epoch for authorized sensitive input/select actions, classify only Graph nodes and screenshot regions produced by that epoch, and redact or mask them before evidence return without globally replacing unrelated equal text.

**Blocked by:** 39 - Redact browser-normalized input and select forms.

**Status:** needs-info

## Tracked scope

This ticket owns light-DOM causal reflection from a sensitive action through the next accepted evidence capture. A permitted input/select dispatch opens an action epoch; synchronous action/event-listener work and its mutation records may classify nodes or regions only when they expose a Ticket 39 source/canonical form. Async timer/rAF/microtask/Promise propagation is not claimed here: if the epoch observes a matching mutation without synchronous attribution, capture fails `SensitiveEvidenceUnavailable`; Ticket 41 owns scheduler propagation and bounds. The epoch retains bounded action, node, and region records, closes deterministically after capture or terminal failure, and poisons evidence rather than broadening redaction when a bound is exceeded.

Ticket 39 is assumed complete: target-bound source/browser forms and primary target-field sink protection are inherited. This ticket may amend that implementation to attach causal node/region provenance, but it does not re-accept browser normalization or Ticket 18 behavior.

Global document-string matching, masking every region with equal text, OCR-based global replacement, and unrelated equal-node redaction are forbidden. Open/closed Shadow DOM and scheduler registration accounting belong to Ticket 41. Exact native Promise behavior, Promise owner integrity, mutable DOM getter authority, CDP geometry, and independent PNG proof belong to Tickets 42-45.

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

No Runner production file, Shadow DOM/scheduler wrapper, Promise hardening, package manifest, lockfile, or unrelated test root is in scope.

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

- blocked: Ticket 40 implementation reached repeated complete-matrix review blockers around async/scheduler-adjacent reflected writes. Maintainer decision: do **not** pull Ticket 41 scheduler/Promise propagation into Ticket 40. Remaining core blocker: strictly distinguishing all synchronous light-DOM reflected `valueRef` exposures from timer/rAF/microtask/Promise/delegated propagation without scheduler/Promise hooks is not safely resolvable within the current Ticket 40 scope. Current experimental branch `closure/ticket-40-reflected-secret-evidence` is intentionally unmerged; Ticket 41 remains stopped until this scope/ownership boundary is re-authorized or Ticket 40 is re-cut.
