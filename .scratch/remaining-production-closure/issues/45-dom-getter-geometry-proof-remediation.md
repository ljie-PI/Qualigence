# 45 - Eliminate mutable DOM and geometry trust

**What to build:** Starting from current `main` after Ticket 44 merges, eliminate mutable page DOM getter and geometry authority from sensitive evidence decisions, complete a static inventory of every page callback and approved intrinsic, derive mask geometry from CDP/backend-node authority, and independently prove decoded-PNG masking plus exactly one bounded recapture.

**Blocked by:** 44 - Freeze first approved Promise owner snapshots.

**Status:** claimed

## Tracked scope

This ticket owns the final page-evidence authority boundary. Inventory every function passed from Node to `page.evaluate`, `locator.evaluate`, init-script/CDP runtime registration, and equivalent page callback in the Allowed Files. A static test must enumerate all such callbacks and require each security-relevant property/method/global read to be backed by an explicitly captured native intrinsic/descriptor or be rejected. Unknown callbacks, dynamic callback construction, unresolved computed reads, and ambient/own getter fallback fail the authority Gate.

Form values, attributes, text, Shadow DOM, style/visibility, and related DOM reads used for sensitive classification must invoke captured native descriptors/functions with validated receivers. Ambient `element.value`, `textContent`, `getAttribute`, `getComputedStyle`, `getClientRects`, `getBoundingClientRect`, own-property shadowing, and page-replaced prototypes cannot authorize evidence.

Screenshot mask geometry must come from browser/CDP backend-node identity and layout data, not page JavaScript geometry. Convert document/CSS coordinates to screenshot pixels with independently validated scroll, visual viewport, clipping, and device-scale inputs. The final test oracle must construct expected rectangles from fixture literals/CDP protocol observations independent of production conversion code, decode returned PNG pixels independently, and assert only expected pixels are masked.

Capture permits at most one full recapture when authority/geometry changes between preflight and screenshot. A second race or any unresolved backend node/geometry yields `SensitiveEvidenceUnavailable` and zero Graph/Artifact bytes. Unmasked first-capture bytes never leave the local attempt or enter logs/Spool.

All authority, backend-node, geometry, decode/encode, and second-race failures use the inherited `SensitiveEvidenceUnavailable` execution error. Ticket 40's 256-region limit remains the maximum geometry/mask set. One initial capture plus one recapture means exactly two total screenshot calls; a third call is forbidden. Screenshot PNG dimensions and decoded storage are limited to Chromium's captured viewport and checked with safe-integer arithmetic before allocation.

Ticket 44 is assumed complete: immutable Promise owner snapshots and captured Promise intrinsic authority are inherited and not re-accepted. This ticket may extend the intrinsic vault/inventory to DOM and geometry callbacks; it does not claim predecessor Promise acceptance.

## Migration

None; existing and allocated closure migrations are immutable to this ticket.

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

## Comments

### start — 2026-08-26

- Fixed base: `9156a7be33f0349cf9c6e3b65167bb6cc92e1ec1` (`ticket-45-dom-getter-geometry-proof` dedicated worktree; base/main head supplied by task).
- Predecessor Ticket 44 evidence: resolved in `.scratch/remaining-production-closure/issues/44-freeze-promise-owner-snapshots.md` with reviewed code/test head `5bcbbf95c6180e00f7e0f73afece761ec6885408`, PR #121, and final focused/E2E/typecheck/diff-check evidence. Ticket 45 inherits immutable Promise owner snapshots and captured Promise intrinsic authority without re-claiming Promise acceptance.
- Behavior Matrix applicability: complete Ticket 45 matrix is applicable. Rows cover static page-callback inventory, captured native DOM descriptor authority for sensitive DOM reads, getter/style/visibility/Shadow DOM tampering, CDP/backend-node screenshot geometry including scroll/viewport/device scale/clipping, 256-region/geometry/PNG failure paths, one bounded full recapture, second-race terminal `SensitiveEvidenceUnavailable`, no pre-dispatch geometry work, cancellation/session cleanup, and persistence fail-closed behavior. Migrations, Runner production files, package/lock changes unless production PNG decoding requires them, unrelated adapters, unrelated roots, and Graph freeze are excluded.
- Planned Gates: `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/page-callback-authority.test.ts tests/component/web-execution/cdp-screenshot-masking.test.ts`, then `CI=true corepack pnpm typecheck`, then `git diff --check`. Complete-matrix review and post-review Chromium E2E (`CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts`) remain pending after implementation.

### review1 core-fix evidence — 2026-08-26

- Review1 core blockers fixed in this worktree: sensitive screenshot mask IDs are now derived from the sensitive runtime's classified element records and re-applied through captured native DOM setters immediately before capture; CDP resolves each mask attribute to a backend node and validates the found runtime object remains one of the classified elements before `DOM.getBoxModel` geometry is accepted. Missing/ambiguous/reassigned markers, invalid geometry, PNG decode failure, screenshot failure, and repeated races return `SensitiveEvidenceUnavailable` before Graph/Artifact registration.
- Sensitive classification callbacks now route form values, attributes, text, Shadow DOM traversal, target-marker writes, and marker reads used for evidence classification through the captured native DOM authority vault with receiver calls via captured `Reflect.apply`; page-owned prototype/own getters no longer provide the classification values.
- The page-callback authority Gate now inventories `page.evaluate`, `locator.evaluate`, `page.addInitScript`, `page.exposeFunction`, and the CDP `Runtime.callFunctionOn` callback, scans sensitive callback bodies for the previously cited ambient reads/dynamic handler reads, and includes a negative fixture proving those reads are rejected.
- Added local component coverage for marker removal/prototype tampering, marker reassignment to a non-sensitive backend node, screenshot throw zero-accepted-artifact behavior, CDP geometry races, and exact decoded-PNG masking/unaffected pixels. Added real Chromium E2E coverage in `tests/e2e/web-execution/value-ref.test.ts` for own/prototype getter tampering, clipped CDP rectangles, independent CDP/PNG pixel proof, one successful recapture, and second-race `SensitiveEvidenceUnavailable` with zero accepted observation artifacts and no process-log secret.
- Remaining matrix rows not expanded further in this review-fix: explicit cancel/timeout-before/after-screenshot injection and external Artifact/Spool sink-failure injection have no existing in-scope hook in the allowed web-playwright files without changing Runner production/storage seams. Existing ordering still registers Graph/Artifact only after post-screenshot sensitive authority validation; the new screenshot-throw and second-race tests cover the local zero-accepted-artifact path.
- Validation run after fixes: `corepack pnpm vitest run tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/page-callback-authority.test.ts tests/component/web-execution/cdp-screenshot-masking.test.ts` passed (6 files, 129 tests); `corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` passed (1 file, 3 tests); `corepack pnpm typecheck` passed; `git diff --check` passed.

### review2 core-fix evidence — 2026-08-26

- Review2 core blockers fixed in this worktree: `collectPageObservation` now invokes captured DOM descriptors/functions through the runtime's captured `Reflect.apply` and maps observation callback authority/getter failures to `SensitiveEvidenceUnavailable`; sensitive action epoch callbacks no longer use page-mutable ambient `Array.from` or `Set` in reflected-form and mutation classification paths.
- Static callback authority coverage was strengthened from substring/count checks to a balanced callback-body scanner with explicit inventory entries, delegated-function body extraction, rejection of `.call`, ambient `Array.from`/`Set`, dynamic callback construction, and unapproved computed reads in security-relevant callbacks.
- Added focused component coverage proving page-replaced `Function.prototype.call`, `Array.from`, and `Set` cannot suppress reflected-secret classification/masking, and added local fail-closed coverage for >256 reflected sensitive regions and invalid PNG screenshot bytes.
- Expanded the real Chromium E2E to tamper with own and prototype form values, attribute/text/style/visibility/geometry paths; it now asserts exact untouched fixture pixels for the unrelated rectangle and direct-session zero accepted Graph/Artifact bytes plus log absence for the second-race `SensitiveEvidenceUnavailable` path.
- Scope limit: the Ticket 45 second-race E2E uses the existing direct `PlaywrightBrowserSession` harness, not the Runner Spool path. Runner Spool leakage remains covered by the separate valueRef RunnerOfferRuntime E2E in the same file, while the second-race branch asserts direct graph/artifact absence because no in-scope Runner Spool hook exists for injecting that capture race without changing Runner production seams.
- Validation run after review2 fixes: `corepack pnpm vitest run tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/page-callback-authority.test.ts tests/component/web-execution/cdp-screenshot-masking.test.ts` passed (6 files, 133 tests); `corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` passed (1 file, 3 tests); `corepack pnpm typecheck` passed; `git diff --check` passed.

### review3 core-fix evidence — 2026-08-26

- Review3 core blockers fixed in this worktree: sensitive screenshot mask membership is now captured as a host-side immutable snapshot of mask IDs bound to CDP `backendNodeId` values at sensitive-action completion. Final screenshot geometry no longer trusts page-mutable `records[].classifiedElements`; CDP search results must resolve back to the stored backend node or capture returns `SensitiveEvidenceUnavailable` before Graph/Artifact registration.
- Sensitive baseline WeakMaps now come from the init-script captured native `WeakMap` constructor and are read/written through captured `WeakMap.prototype.get`/`set` via captured `Reflect.apply`; the page callback Gate rejects uncaptured `new WeakMap`, `WeakMap(...)`, and `WeakMap.prototype` runtime use.
- Style visibility checks now read `display` and `visibility` through captured `CSSStyleDeclaration.prototype.getPropertyValue` instead of ambient `style.display`/`style.visibility` access.
- Static authority Gate now rejects unresolved comma/spread computed reads and includes negative fixtures for `target[handlerName, otherName]` and `target[...handlerNames]`.
- Added component regressions for page-replaced `WeakMap`, CSS style accessor/getPropertyValue tampering, and the review3 decoy attack that mutates `records[0].classifiedElements[0]` and removes the real sensitive marker; the decoy attack now fails closed with no accepted observation artifact.
- Added real Runner/Spool E2E coverage for second-race failure: the Runner path injects two post-screenshot geometry mutations, completes with `SensitiveEvidenceUnavailable`, observes exactly two sensitive screenshot mutations, and scans Trace/Artifact/log/Spool output for absence of the valueRef plaintext.
- Remaining matrix rows not expanded further in this review-fix: explicit cancel/timeout-before/after-screenshot injection and external Artifact/Spool persistence-failure injection still lack dedicated in-scope failure hooks without changing Runner/storage seams. Existing production ordering continues to register Graph/Artifact only after post-screenshot validation, and the strengthened second-race Runner/Spool E2E plus screenshot throw tests cover the core zero-accepted-byte paths.
- Validation run after review3 fixes: `corepack pnpm vitest run tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/page-callback-authority.test.ts tests/component/web-execution/cdp-screenshot-masking.test.ts` passed (6 files, 137 tests); `corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` passed (1 file, 4 tests); `corepack pnpm typecheck` passed; `git diff --check` passed.

### review4 core-fix evidence — 2026-08-26

- Review4 Critical blockers fixed in this worktree: Graph JSON redaction now checks a host-held sensitive authority for candidate/title mask IDs and treats pending page-sensitive state mismatches as `SensitiveEvidenceUnavailable` before Graph/Artifact registration. Pending captures validate the page snapshot's marker IDs, forms, classified mask IDs, element mask attributes, and target-ID membership against the host record created at action completion, so page-side mutations of `records[].forms`, `records[].classifiedElements`, `records[].classifiedMaskIds`, or target-ID arrays fail closed instead of suppressing redaction.
- Host mask snapshot collection now fails closed on duplicate mask IDs or any per-mask CDP `DOM.getBoxModel`/backend-node failure; `SensitiveEvidenceAuthority.complete()` still rejects empty/oversized snapshots and now rejects duplicate mask IDs. Classification keeps non-rendered document metadata such as `<title>` out of screenshot mask-region membership while preserving sensitive target markers for Graph title redaction, so hidden/body-visible classified regions must be CDP-bound before any pending capture can register evidence.
- Added component regressions for pre-capture page-state/target-ID mutation, hidden classified region becoming visible before capture, and active `classifiedElements` mutation during an input event. Added Runner/Spool E2E coverage for page-state/target-ID mutation that asserts `SensitiveEvidenceUnavailable` and scans Trace, spooled events, captured artifacts, logs, and spool bytes for absence of the plaintext.
- Validation run after review4 fixes: `corepack pnpm vitest run tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/page-callback-authority.test.ts tests/component/web-execution/cdp-screenshot-masking.test.ts` passed (6 files, 140 tests); `corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` passed (1 file, 5 tests); `corepack pnpm typecheck` passed; `git diff --check` passed.

### review5 core-fix evidence — 2026-08-26

- Review5 Critical blockers fixed in this worktree: pending page-sensitive state validation now requires exactly one page record per pending host marker, exact host-authorized form sets, exact host/CDP mask ID sets, duplicate-free page-declared target memberships, and every maskable element carrying a pending marker to be backed by the host-held CDP mask snapshot. Duplicate/extra page records, duplicate mask IDs, unknown marker memberships, and forged target IDs now fail closed with `SensitiveEvidenceUnavailable` before Graph/Artifact registration.
- Scheduler retirement authority now uses init-script closure-held scheduler epoch metadata (`WeakMap` plus retained epoch list) for registration/pending/retained-callback counts. The observer's retirement callback asks the captured runtime for retirement status rather than trusting page-mutable `retainedSchedulerEpochs`, `pendingSchedulerCallbacks`, or `Array.prototype.some`, so forged early retirement leaves capture unavailable/pending instead of clearing records while delayed sensitive work remains.
- Added component regression coverage for a forged duplicate page record/target-id membership outside the host mask snapshot and for page-forged scheduler early retirement. Updated the Runner/Spool E2E page-state tamper case to forge the duplicate sensitive record/target-id attack and continue asserting `SensitiveEvidenceUnavailable` plus zero plaintext in Trace, spooled events, accepted artifacts, logs, and spool bytes.
- Validation after fixes: focused non-E2E Gate passed (6 files, 142 tests); value-ref E2E passed (1 file, 5 tests); `corepack pnpm typecheck` passed; `git diff --check` passed.
- Matrix notes unchanged for non-core rows: explicit cancel/timeout-before/after-screenshot injection and external Artifact/Spool persistence-failure injection still have no dedicated in-scope hooks and are not marked pass.

### review6 core-fix evidence — 2026-08-26

- Review6 Standards Critical fixed in this worktree: the sensitive observation callback no longer enumerates page-sensitive records/elements/memberships with `for...of` or page-dispatched `@@iterator`; it clones DOM collections and page-owned arrays through bounded index reads, records retired scheduler cleanup through index loops, and the static authority Gate now rejects `for...of`/`Symbol.iterator` in the page-state validation callbacks. Added component and Runner/Spool duplicate-record regressions where an own array iterator hides the forged duplicate record; the capture still fails closed with `SensitiveEvidenceUnavailable` and no accepted artifact/plaintext.
- Review6 Spec Critical fixed in this worktree: host-held sensitive scan records now remain active until navigation/session reset and are supplied to every authorized page observation. Retired page records are kept only as baseline support, while host records continue DOM-wide sensitive-form scanning after the first accepted capture; a later same-page untrusted reflection of a host-known valueRef form fails closed before Graph/PNG/Artifact registration. Added component and Chromium E2E regressions for a second observation after first capture retirement.
- Validation after fixes: focused non-E2E Gate passed (6 files, 143 tests); value-ref E2E passed (1 file, 6 tests); `corepack pnpm typecheck` passed; `git diff --check` passed.
- Matrix notes unchanged for non-core rows: explicit cancel/timeout-before/after-screenshot injection and external Artifact/Spool persistence-failure injection still have no dedicated in-scope hooks and are not marked pass.

## Acceptance

- [ ] Every page callback in Allowed Files is statically inventoried; unresolved callbacks/reads fail, and all sensitive DOM reads use validated captured native authority.
- [ ] Page-owned/ambient getter and geometry tampering cannot authorize Graph or screenshot evidence.
- [ ] Mask regions derive from CDP/backend-node layout authority with scroll, viewport, clipping, and device scale handled explicitly.
- [ ] Independent fixture/CDP rectangle calculations and independent PNG decoding prove exact masked and unaffected pixels without reusing production conversion/mask logic.
- [ ] One authority/geometry race causes exactly one full recapture; a second race is terminal with no third attempt and zero Graph/Artifact/log/Spool bytes.
- [ ] All authority/geometry/PNG failures use `SensitiveEvidenceUnavailable`, retain the 256-region limit, and validate dimensions/allocation with safe-integer arithmetic.
- [ ] Ticket 44 immutable Promise snapshots remain green but are not re-claimed as Ticket 45 acceptance.
- [ ] Focused Gate, typecheck, diff check, complete-matrix review, and exact Chromium E2E are clean on the final code/test/package head.

### review7 core-fix evidence — 2026-08-26

- Review7 Critical blockers fixed in this worktree: post-retirement `document.title` metadata carrying a host-known valueRef form now fails closed/redacts through host-held sensitive authority instead of being accepted as non-maskable page content without trusted marker authority. Added component coverage for a same-page post-retirement title-only reflection.
- Sensitive-form substring decisions in page callbacks now use string intrinsics captured during init (`includes`, `toLowerCase`, `trim`, `replace`, and `normalize`) and invoked through captured `Reflect.apply`; page-replaced `String.prototype` methods no longer suppress classification or observation scanning. The static page-callback authority Gate now rejects mutable string prototype calls in security-sensitive callbacks.
- Later same-page sensitive scanning no longer uses page-owned `retiredRecords`, retired `baseline`, or retired `shadowBaseline` as an allowlist. Baseline allowances remain limited to the still-pending page record; after capture retirement, new host-known plaintext without trusted marker/mask authority fails closed. Added component coverage for a forged retired-baseline visible reflection and expanded the valueRef Chromium E2E's retired-reflection case to mutate retired baseline state and title before proving no plaintext in accepted evidence/log output.
- Static authority Gate was extended to reject page-owned retired-baseline authority in `collectPageObservation` and to keep the existing iterator/dynamic/computed-read checks active for the security-sensitive callbacks touched by this fix.
- Validation after fixes: `corepack pnpm vitest run tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/page-callback-authority.test.ts tests/component/web-execution/cdp-screenshot-masking.test.ts` passed (6 files, 148 tests); `corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` passed (1 file, 6 tests); `corepack pnpm typecheck` passed; `git diff --check` passed.
- Matrix notes unchanged for non-core rows: explicit cancel/timeout-before/after-screenshot injection and external Artifact/Spool persistence-failure injection still have no dedicated in-scope hooks and are not marked pass.

### review8 core-fix evidence — 2026-08-26

- Review8 Critical blocker fixed in this worktree: non-visible maskable DOM carrying a host-known sensitive form is no longer treated as covered solely because it is hidden; it now needs a host-trusted sensitive mask ID or fails closed. Accessible-name candidate fields now use the metadata redaction path so host-known sensitive forms cannot be serialized unchanged into Graph names/descriptors when trusted target/mask authority is absent.
- Added component regression coverage for a post-retirement hidden `aria-labelledby` source naming a visible button with valueRef plaintext; the follow-up capture now returns `SensitiveEvidenceUnavailable` and registers no observation artifact.
- Added Chromium E2E coverage for the same post-retirement hidden accessible-name reflection after a successful sensitive capture retirement, asserting the accepted first Graph/artifacts are redacted and the later failed capture leaves no Graph/Artifact/log plaintext.
- Validation after fixes: `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/page-callback-authority.test.ts tests/component/web-execution/cdp-screenshot-masking.test.ts` passed (6 files, 149 tests); `CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` passed (1 file, 7 tests); `CI=true corepack pnpm typecheck` passed; `git diff --check` passed.
- Matrix notes unchanged for non-core rows: explicit cancel/timeout-before/after-screenshot injection and external Artifact/Spool persistence-failure injection still have no dedicated in-scope hooks and remain `N/A`; existing Runner/Spool terminal-failure tests still cover adjacent zero-plaintext failure paths.
