# 41 - Close Shadow DOM, scheduler, and Runner log gaps

**What to build:** Starting from current `main` after Ticket 40 merges, extend causal sensitive-evidence coverage through open and closed Shadow DOM, bound scheduler callback registration without changing application behavior, and make Runner error logs emit only closed stable codes with unknown values mapped to `UnexpectedRunnerError`.

**Blocked by:** 40 - Redact causally reflected secret evidence.

**Status:** claimed

## Tracked scope

This ticket owns three connected fail-closed boundaries. First, causal observation traverses light DOM and open shadow roots while closed roots are tracked as opaque authority: a closed/unprovable root touched by a sensitive epoch prevents Graph/Artifact acceptance rather than leaking or pretending it was inspected. Second, timer, animation-frame, microtask, and Promise callback registrations made during a sensitive causal epoch are counted before native allocation/registration; exceeding the explicit session bound poisons evidence but still invokes the native scheduler and never cancels already registered application work. Third, Runner reconnect/fatal logging emits event plus a closed safe error code only; arbitrary error names/messages/stacks/details are never serialized, and every unknown maps to `UnexpectedRunnerError`.

Ticket 40 is assumed complete: bounded light-DOM action-to-capture provenance and targeted Graph/screenshot handling are inherited. This ticket may extend that authority into Shadow DOM and scheduler propagation but does not re-accept Ticket 40 masking or Ticket 39 normalization.

Exact `Promise.then`/`catch`/`finally`, species, and thenable semantics with exact causal accounting belong to Ticket 42. Promise owner registry/snapshots belong to Tickets 43-44. Mutable DOM getter, page-callback inventory, CDP geometry, and independent PNG proof belong to Ticket 45. This ticket does not cancel timers, rAF callbacks, microtasks, or Promise reactions to protect evidence.

The fixed additions are at most 128 observed shadow roots per session, 1,024 timer/rAF/microtask/Promise registrations per sensitive epoch, and 4,096 such registrations per session. Counts increment before calling the captured native registration function; overflow latches `SensitiveEvidenceUnavailable` for evidence while the native call still proceeds. The only Runner error log codes are `CapabilityMismatch`, `LeaseExpired`, `LeaseWindowUnsafe`, `SpoolUnavailable`, `PolicyMissing`, `PolicyDenied`, `TransportError`, and `UnexpectedRunnerError`; only an actual `RunnerAppError` carrying one of the first seven is preserved, and every other thrown value/code maps to `UnexpectedRunnerError`.

## Migration

None; existing and allocated closure migrations are immutable to this ticket.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/deployment/CONTEXT.md` for Runner log output

## Authority

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.1-6.2, 8, 10, 11, and 13. Application behavior remains owned by the target; unsafe evidence fails closed; logs exclude sensitive content.
- Context authority: `CONTEXT-MAP.md` and every context under **Affected contexts**, including evidence redaction and deployment log invariants.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` user stories 29-35 and 70; valueRef/evidence decisions; review, Chromium, and primary sink Testing Decisions.
- Predecessor authority: `.scratch/remaining-production-closure/issues/40-reflected-secret-evidence-remediation.md`, its eventual merged evidence, and inherited causal epoch interface. Completion is assumed; predecessor Graph/screenshot acceptance is not owned here.
- Current public interfaces and tests: browser session/action/observer interfaces, Runner `main` error paths, `RunnerAppError` stable codes, and the exact Allowed Files on the implementation base.
- Closed PRs #78-#83 and any local WIP are historical context only. Their branches, commits, diffs, tests, and review claims are not implementation, source, or cherry-pick authority.

## Allowed Files

This is the complete edit scope:

- `packages/target-adapters/web-playwright/src/browser-session.ts`
- `packages/target-adapters/web-playwright/src/playwright-action-executor.ts`
- `packages/target-adapters/web-playwright/src/playwright-observer.ts`
- `packages/target-adapters/web-playwright/src/sensitive-evidence-authority.ts`
- `apps/runner/src/errors.ts`
- `apps/runner/src/main.ts`
- `apps/runner/src/safe-runner-log.ts` (new)
- `tests/unit/target-adapters/web-playwright/browser-session.test.ts`
- `tests/component/web-execution/playwright-click.test.ts`
- `tests/component/web-execution/playwright-observation.test.ts`
- `tests/component/web-execution/shadow-dom-scheduler-log.test.ts` (new)
- `tests/e2e/web-execution/value-ref.test.ts`
- `.scratch/remaining-production-closure/issues/41-shadow-dom-scheduler-log-remediation.md`

No other Runner source/test, package manifest, lockfile, Promise-oracle/owner hardening, DOM geometry hardening, or unrelated root is in scope.

## Focused non-E2E Gate

Run during implementation and after every code/test review fix:

```text
corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/shadow-dom-scheduler-log.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

Run only after an exact-head complete-matrix review is clean:

```text
corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts
```

The real Chromium case must exercise causal reflection in open and closed roots, timer/rAF/microtask/Promise scheduling at and over bounds, unchanged application callback completion/order, masked/redacted evidence or fail-closed zero-byte behavior, and Runner reconnect/fatal log capture containing only allowed codes. Chromium absence or skips fail the Gate.

## Execution, review, and delivery protocol

- Start fresh from the then-current `main` only after Ticket 40 merges. Record exact base SHA, predecessor merge evidence, matrix applicability, and Gates in `start` evidence; never base work on historical PRs/WIP.
- Keep `claimed`; run only the focused non-E2E Gate during edits and review fixes.
- Commit before every exact-base `/code-review`. Each round covers the whole code/test diff and all matrix rows on Standards and Spec axes, recording row-level `pass | finding | N/A`, reasons, and reviewed head.
- Use at most five complete-matrix rounds. Critical always blocks; Important blocks under the umbrella criteria. A remaining core blocker sets `needs-info` and stops Ticket 42.
- Record non-Critical advanced hardening in one GitHub Issue only; do not implement or block on it unless promoted.
- Run exact Chromium E2E only after clean review. Any subsequent code/test change repeats focused Gate, complete-matrix review, and E2E.
- Do not create a PR until focused Gate, typecheck, diff check, review, Chromium E2E, and `final` evidence are clean. Then create one non-draft PR; only final evidence with unchanged code/test diff may follow review. Resolve after merge evidence is recorded.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Sensitive causal reflection enters an open shadow root | `started` at action dispatch | Open-root Graph node is redacted and its visible screenshot region masked | Redacted/masked evidence plus existing provenance only | Capture may repeat without replaying action | Open-root Graph and PNG evidence |
| Sensitive causal activity touches a closed or otherwise unprovable shadow root | `started` | `SensitiveEvidenceUnavailable` | No Graph/Artifact from that capture is accepted | Fresh observation may retry; action is never automatically replayed | Closed-root code-only/zero-evidence assertion |
| Non-sensitive open/closed root is present outside a sensitive causal epoch | `not_started` for sensitivity tracking | Existing ordinary observation behavior; closed root is not falsely claimed inspected | Existing ordinary evidence only | Repeatable under current observer behavior | Negative fixture proving no global poison |
| Timer/rAF/microtask/Promise callback registration is below bound | `started` when native registration is requested | Native registration/callback result and ordering are preserved; causal epoch propagates | Bounded in-memory registration record only | Native application behavior is not replayed or synthesized | Callback result/order/count evidence |
| Scheduler registration exceeds 1,024 for the epoch or 4,096 for the session, or shadow-root discovery exceeds 128 | `started`; count increments before native allocation/registration | Native scheduler still receives the registration; evidence latches `SensitiveEvidenceUnavailable` | No accepted Graph/Artifact for the poisoned epoch/session | Do not cancel callbacks; a new session may capture after fresh authorization | Native callback completion plus code-only/zero-evidence result |
| Callback throws/rejects or target cancels its own timer/rAF | `started` | Native throw/rejection/cancellation semantics remain observable to the application | Evidence registry records only safe causal status | Never replace with agent cancellation/retry | Application oracle assertions |
| Policy/capability/value/target rejection before sensitive dispatch | `not_started` | Existing stable rejection | No causal scheduler/root authority | Retry only under predecessor rules | Zero instrumentation epoch assertion |
| Cancel/timeout before scheduler registration | `not_started` | Existing cancellation/timeout | No registration by the adapter | Safe retry under existing rules | Zero native registration assertion |
| Cancel/timeout after action/scheduler dispatch | `outcome_unknown` | Existing unknown outcome or fail-closed evidence result | Safe terminal code only; no unsafe evidence bytes | Never replay action/callback automatically | Unknown-outcome and callback completion evidence |
| Runner receives a known safe application/target/transport error | `not_started` for product side effects | Log JSON contains event and allowlisted stable code only | Operational log has no message/stack/details/plaintext | Repeated logging is deterministic by code | Exact serialized log assertion |
| Runner receives unknown, hostile, or plaintext-bearing thrown value | `not_started` | Log JSON code is `UnexpectedRunnerError` and contains no attacker text | Safe generic log record only | No message-based classification or retry decision | Hostile error matrix and byte scan |
| Session closes/restarts with pending scheduler/root records | `started` if callbacks already registered | Application callbacks remain governed by native lifecycle; evidence authority is cleared | No sensitive registry crosses session | New session requires new authorized action | Cleanup/restart and no-cancellation evidence |
| Log write or Graph/Artifact/Spool persistence fails | `outcome_unknown` for terminal evidence | Existing terminal failure; no success/evidence claim | No unsafe fallback record | Retry only the owned persistence operation; never replay page action | Injected sink failure and byte scan |

## Acceptance

- [ ] Open shadow roots participate in causal Graph/screenshot protection; sensitive closed/unprovable roots fail evidence closed.
- [ ] Exact 128-root, 1,024-registration-per-epoch, and 4,096-registration-per-session bounds increment before native registration and overflow as `SensitiveEvidenceUnavailable`.
- [ ] Timer, rAF, microtask, and Promise registrations are bounded and counted before native registration without cancelling or altering application callbacks.
- [ ] Bound overflow poisons evidence only; callbacks still allocate/register/run according to native behavior.
- [ ] Runner reconnect/fatal logs contain only closed allowlisted codes, with every unknown mapped to `UnexpectedRunnerError` and no arbitrary message/stack/details.
- [ ] The Runner log allowlist is exactly the seven existing `RunnerAppError` codes plus `UnexpectedRunnerError`; no structural lookalike or arbitrary string preserves its code.
- [ ] Ticket 40 causal masking remains green but is not re-claimed as Ticket 41 acceptance.
- [ ] Focused Gate, typecheck, diff check, complete-matrix review, and exact Chromium E2E are clean on the final code/test head.

## Comments

### start — 2026-08-25

- Fixed base: `3e46233f6acf7733b9b0f77c871b2994ba2c0d67` (`main`, includes Ticket 40 PR #108).
- Predecessor merge evidence: Ticket 40 is `resolved` with PR #108 and reviewed code head `5183d7916b94e55ec1d89ada0047243b6ecf338e` recorded in `.scratch/remaining-production-closure/issues/40-reflected-secret-evidence-remediation.md`; current base includes that merge.
- Behavior Matrix applicability: complete matrix in this ticket is applicable. Stateful/side-effecting sensitive evidence, scheduler propagation/accounting, Shadow DOM fail-closed/success boundaries, and Runner logging rows are in scope; Ticket 42 Promise exact semantics/owner hardening, Ticket 45 DOM getter/CDP/PNG hardening, and package/dependency changes remain excluded.
- Planned Gates: `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/shadow-dom-scheduler-log.test.ts`, then `CI=true corepack pnpm typecheck`, then `git diff --check`. Post-review Chromium E2E remains deferred to the parent/review protocol.

### review-fix — 2026-08-25

- Reviewed head fixed: `1f1f65871555859d82fed592dfc10ee3d6af7339`.
- Fix commit: `bde8ac9ceb5005a762d7162941a7e11027c95b56` (`Fix Ticket 41 review blockers`).
- Standards blocker fixed: normalized `tests/component/web-execution/shadow-dom-scheduler-log.test.ts` to LF/no trailing whitespace so `git diff --check` is clean.
- Spec blocker fixed: shadow-root retention and discovery now fail closed at the 128-root session bound before retaining or observing more than the bounded roots; focused coverage asserts 129 roots retain/observe only 128 and still fail evidence closed after the native input callback runs.
- Spec blocker fixed: below-bound timer and Promise callbacks registered during the sensitive epoch keep their causal epoch processing after the fixed settle wait, preserving native callback execution/order while allowing delayed open-shadow reflections to be redacted and masked; overflow remains evidence-only poison.
- Spec blocker fixed: closed/unprovable shadow-root mutation during a sensitive epoch poisons evidence even when the closed root does not expose the registered sensitive form; pre-sensitive closed roots remain ordinary until touched by the sensitive epoch.
- Gates run/pass on the fix: `corepack pnpm exec tsc -b packages/target-adapters/web-playwright/tsconfig.json apps/runner/tsconfig.json --force`; `CI=true corepack pnpm vitest run tests/component/web-execution/shadow-dom-scheduler-log.test.ts` (9 tests); `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts tests/component/web-execution/shadow-dom-scheduler-log.test.ts` (4 files / 66 tests); `CI=true corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts` (1 file / 1 test); `CI=true corepack pnpm typecheck`; `git diff --check`.
- Status remains `claimed`; no PR evidence is added pending a fresh complete-matrix review.
