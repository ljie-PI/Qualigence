# 45 - Eliminate mutable DOM and geometry trust

**What to build:** Starting from current `main` after Ticket 44 merges, eliminate mutable page DOM getter and geometry authority from sensitive evidence decisions, complete a static inventory of every page callback and approved intrinsic, derive mask geometry from CDP/backend-node authority, and independently prove decoded-PNG masking plus exactly one bounded recapture.

**Blocked by:** 44 - Freeze first approved Promise owner snapshots.

**Status:** ready-for-agent

## Tracked scope

This ticket owns the final page-evidence authority boundary. Inventory every function passed from Node to `page.evaluate`, `locator.evaluate`, init-script/CDP runtime registration, and equivalent page callback in the Allowed Files. A static test must enumerate all such callbacks and require each security-relevant property/method/global read to be backed by an explicitly captured native intrinsic/descriptor or be rejected. Unknown callbacks, dynamic callback construction, unresolved computed reads, and ambient/own getter fallback fail the authority Gate.

Form values, attributes, text, Shadow DOM, style/visibility, and related DOM reads used for sensitive classification must invoke captured native descriptors/functions with validated receivers. Ambient `element.value`, `textContent`, `getAttribute`, `getComputedStyle`, `getClientRects`, `getBoundingClientRect`, own-property shadowing, and page-replaced prototypes cannot authorize evidence.

Screenshot mask geometry must come from browser/CDP backend-node identity and layout data, not page JavaScript geometry. Convert document/CSS coordinates to screenshot pixels with independently validated scroll, visual viewport, clipping, and device-scale inputs. The final test oracle must construct expected rectangles from fixture literals/CDP protocol observations independent of production conversion code, decode returned PNG pixels independently, and assert only expected pixels are masked.

Capture permits at most one full recapture when authority/geometry changes between preflight and screenshot. A second race or any unresolved backend node/geometry yields `SensitiveEvidenceUnavailable` and zero Graph/Artifact bytes. Unmasked first-capture bytes never leave the local attempt or enter logs/Spool.

All authority, backend-node, geometry, decode/encode, and second-race failures use the inherited `SensitiveEvidenceUnavailable` execution error. Ticket 40's 256-region limit remains the maximum geometry/mask set. One initial capture plus one recapture means exactly two total screenshot calls; a third call is forbidden. Screenshot PNG dimensions and decoded storage are limited to Chromium's captured viewport and checked with safe-integer arithmetic before allocation.

Ticket 44 is assumed complete: immutable Promise owner snapshots and captured Promise intrinsic authority are inherited and not re-accepted. This ticket may extend the intrinsic vault/inventory to DOM and geometry callbacks; it does not claim predecessor Promise acceptance.

## Migration

None; migrations 001-013 are immutable.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`

## Authority

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.1-6.3, 8, 10, 11, and 13. The adapter owns platform observation; evidence is Runner-redacted before persistence; mutable page behavior is not security authority.
- Context authority: `CONTEXT-MAP.md`, `docs/contexts/execution/CONTEXT.md`, and `docs/contexts/evidence/CONTEXT.md`.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` valueRef/evidence requirements, real Chromium acceptance, and complete-matrix review/delivery protocol.
- Predecessor authority: `.scratch/remaining-production-closure/issues/44-freeze-promise-owner-snapshots.md`, its eventual merged evidence, immutable owner snapshots, and captured intrinsic-vault interface. Completion is assumed; Promise owner acceptance is excluded here.
- Browser authority: Playwright's pinned Chromium/CDP protocol on the implementation head for backend-node identity, layout metrics, and screenshot bytes. Page JavaScript geometry/getter results are adversarial input, not authority.
- Current public interfaces and tests: browser session/action/observer/artifact interfaces and exact Allowed Files on the base.
- Closed PRs #78-#83 and abandoned local WIP, including the prior Ticket 45 attempt, are historical context only. Their branches, commits, diffs, tests, and review claims are not implementation, source, or cherry-pick authority.

## Allowed Files

This is the complete edit scope:

- `packages/target-adapters/web-playwright/src/browser-session.ts`
- `packages/target-adapters/web-playwright/src/playwright-action-executor.ts`
- `packages/target-adapters/web-playwright/src/playwright-observer.ts`
- `packages/target-adapters/web-playwright/src/sensitive-evidence-authority.ts`
- `packages/target-adapters/web-playwright/src/types.ts`
- `packages/target-adapters/web-playwright/package.json` only if an independently maintained PNG decoder is required for production masking; do not add a dependency for test convenience
- `pnpm-lock.yaml` only if and exactly when the allowed package manifest changes
- `tests/unit/target-adapters/web-playwright/action-resolution.test.ts`
- `tests/unit/target-adapters/web-playwright/browser-session.test.ts`
- `tests/component/web-execution/playwright-click.test.ts`
- `tests/component/web-execution/playwright-observation.test.ts`
- `tests/component/web-execution/page-callback-authority.test.ts` (new)
- `tests/component/web-execution/cdp-screenshot-masking.test.ts` (new)
- `tests/e2e/web-execution/value-ref.test.ts`
- `.scratch/remaining-production-closure/issues/45-dom-getter-geometry-proof-remediation.md`

No Runner production file, broad package/lock update, other adapter, unrelated test root, or documentation/status file is in scope.

## Focused non-E2E Gate

Run during implementation and after every code/test review fix:

```text
corepack pnpm vitest run tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/page-callback-authority.test.ts tests/component/web-execution/cdp-screenshot-masking.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

Run only after an exact-head complete-matrix review is clean:

```text
corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts
```

The real Chromium E2E must tamper with own/prototype form, attribute, text, style, visibility, and geometry getters; use scrolled and device-scaled fixtures; derive independent expected rectangles; decode PNG pixels independently of production mask code; prove opaque-black masked pixels and exact unaffected pixels; force one geometry race that succeeds after exactly one recapture; and force a second race that returns `SensitiveEvidenceUnavailable` with zero Graph/Artifact/log/Spool bytes. Chromium absence or skips fail the Gate.

## Execution, review, and delivery protocol

- Start fresh from then-current `main` after Ticket 44 merges; record exact base/predecessor merge evidence, matrix applicability, and Gates. Historical PRs and abandoned WIP are not source/cherry-pick authority.
- Keep `claimed`; run only focused non-E2E verification during edits and review fixes. Add package/lock changes only if implementation genuinely needs the allowed production PNG dependency and keep the lock diff limited to it.
- Commit before each exact-base `/code-review`; each round covers the entire code/test/package diff and every matrix row on both axes with `pass | finding | N/A`, reasons, and reviewed head.
- Use at most five complete-matrix rounds. Critical always blocks; Important follows umbrella criteria. A remaining core blocker sets this ticket to `needs-info` and records the exact ownership/scope decision needed.
- Record non-Critical advanced hardening in one GitHub Issue only; do not implement it unless promoted.
- Run exact Chromium E2E only after clean review. Any code/test/package change repeats focused Gate, complete-matrix review, and E2E.
- Do not create a PR until focused Gate, typecheck, diff check, review, Chromium E2E, and `final` evidence are clean. Then create one non-draft PR; only final evidence with a byte-identical code/test/package diff may follow. Resolve after merge evidence.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Every page callback is statically inventoried and uses only approved captured authorities | `not_started` for application effects | Static authority Gate passes; runtime capture uses the approved callback set | Inventory is test/source truth; no dynamic authority cache persists | Any callback edit must update inventory and rerun full Gate | Complete callback list and zero unresolved reads |
| New/unresolved/dynamically constructed callback or computed security-relevant read appears | `not_started` | Static Gate fails; implementation cannot deliver | No accepted new authority | Fix by explicit reviewed authority, not ignore/allow-all | Failing AST/static inventory fixture |
| Page replaces own/prototype form value, attribute, text, style, visibility, or Shadow DOM getters | `started` if page mutation occurred | Capture uses validated captured native descriptor or fails closed; attacker return never authorizes evidence | No unsafe Graph/Artifact | Restoration does not authorize a previously poisoned session where predecessor latch applies | Getter-tamper matrix and sink scan |
| Native descriptor receiver/owner validation fails or getter throws | `started` | `SensitiveEvidenceUnavailable` | Zero accepted Graph/Artifact bytes | Fresh session may retry; no page action replay | Invalid receiver/throw tests |
| Backend node resolves and CDP layout/viewport/device scale are stable | `started` at CDP geometry/screenshot capture | Sensitive region alone is masked; Graph and PNG return | Only final masked PNG and redacted Graph may persist | Repeated stable capture is deterministic | Independent rectangle and decoded-pixel oracle |
| Page JS geometry lies while CDP backend geometry is valid | `started` | Mask follows CDP geometry, not page getter | Masked Artifact only | No fallback to JS geometry | Contradictory geometry fixture |
| Page is scrolled, clipped, zoomed/device-scaled, or region crosses viewport edge | `started` | Coordinate conversion clips/masks exact screenshot pixels | Final masked PNG only | Stable repeated capture yields same pixel region | Independent fixture literals/CDP metrics and PNG decode |
| Backend node is missing/detached/ambiguous, region count exceeds 256, or CDP/PNG geometry is invalid/non-finite/unsafe to allocate | `started` | `SensitiveEvidenceUnavailable` | Zero Graph/Artifact accepted | Fresh capture may retry; no global/full-image guess | Negative CDP/PNG cases |
| Geometry/authority changes during first capture | `started` | First bytes are discarded locally; exactly one full recapture is attempted | Only validated second masked capture may persist | One recapture maximum; no action replay | Call count two and absence of first bytes from sinks |
| Geometry/authority changes again during recapture | `outcome_unknown` for capture | `SensitiveEvidenceUnavailable` | Zero Graph/Artifact/log/Spool bytes from either attempt | No third capture; new external observation/session required | Call count exactly two, code-only failure, byte scan |
| Screenshot operation throws before returning bytes | `started` | Existing stable capture failure; retry follows the one-recapture policy only when authority permits | No partial bytes persist | At most the specified single recapture | Injected screenshot failure/count evidence |
| Equal non-causal text/pixels lie outside classified backend-node regions | `started` | They remain byte-for-byte unchanged | Ordinary evidence persists | Equality never broadens mask | Unaffected-pixel and Graph assertions |
| Policy/value/action rejection before sensitive dispatch | `not_started` | Existing predecessor result | No sensitive geometry authority | Existing retry rules | Zero CDP mask work assertion |
| Cancel/timeout before CDP/screenshot dispatch | `not_started` | Existing cancellation/timeout | No screenshot bytes | Safe observation retry | Zero screenshot/CDP dispatch |
| Cancel/timeout after screenshot dispatch | `outcome_unknown` | No Artifact accepted without complete post-capture authority validation | Zero or fully validated masked bytes only | Apply one-recapture bound; never replay action | Cancellation race and sink scan |
| Session close/restart | `started` if CDP session existed | CDP/intrinsic/owner authority is released; fresh session recaptures | No page/backend references cross session | New authorized action/capture required | Cleanup/restart evidence |
| Artifact/Spool persistence fails after validated masking | `outcome_unknown` for terminal evidence | Existing persistence failure; never fall back to unmasked bytes | No unsafe durable bytes | Retry only validated masked bytes under existing persistence rules | Sink failure and raw-byte scan |

## Acceptance

- [ ] Every page callback in Allowed Files is statically inventoried; unresolved callbacks/reads fail, and all sensitive DOM reads use validated captured native authority.
- [ ] Page-owned/ambient getter and geometry tampering cannot authorize Graph or screenshot evidence.
- [ ] Mask regions derive from CDP/backend-node layout authority with scroll, viewport, clipping, and device scale handled explicitly.
- [ ] Independent fixture/CDP rectangle calculations and independent PNG decoding prove exact masked and unaffected pixels without reusing production conversion/mask logic.
- [ ] One authority/geometry race causes exactly one full recapture; a second race is terminal with no third attempt and zero Graph/Artifact/log/Spool bytes.
- [ ] All authority/geometry/PNG failures use `SensitiveEvidenceUnavailable`, retain the 256-region limit, and validate dimensions/allocation with safe-integer arithmetic.
- [ ] Ticket 44 immutable Promise snapshots remain green but are not re-claimed as Ticket 45 acceptance.
- [ ] Focused Gate, typecheck, diff check, complete-matrix review, and exact Chromium E2E are clean on the final code/test/package head.
