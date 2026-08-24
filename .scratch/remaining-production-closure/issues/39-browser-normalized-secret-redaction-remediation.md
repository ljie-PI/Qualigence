# 39 - Redact browser-normalized input and select forms

**What to build:** Starting from current `main`, extend the resolved Ticket 18 valueRef path so an authorized input/select action records the browser-observed canonical forms of its resolved value, including LF, CRLF, and trailing-newline transformations, and redacts only the sensitive target fields that carry those forms before Graph, Trace, Runner log, or Spool serialization.

**Blocked by:** 18 - Deliver safe valueRef input (resolved).

**Status:** ready-for-agent

## Tracked scope

This ticket owns target-bound browser normalization for input and select actions and the primary Graph/Trace/log/Spool proof. Registration starts from the Plan-authorized action target and exact resolved source value, records only browser-observed forms for that target, and applies before any owned sink serializes the target field. It must cover LF, CRLF, trailing LF/CRLF, textarea/input behavior, and selected option value/text forms that Chromium exposes.

Ticket 18 is assumed complete: valueRef confinement, capability health, exact source-value handling, action dispatch, and the existing primary sink workflow are inherited and are not acceptance owned here. This ticket may amend that path only for browser-normalized target forms.

Equal text elsewhere in the page is not sensitive merely because its bytes match a registered source or canonical form. Global string replacement across a Graph, document, screenshot, log payload, or Spool record is forbidden. Causally reflected nodes and screenshot regions belong to Ticket 40; Shadow DOM/scheduler behavior and closed Runner log codes belong to Ticket 41; Promise and mutable browser-authority hardening belong to Tickets 42-45.

The fixed Graph redaction marker is the existing literal `[redacted]`. The fixed contract is at most 100 sensitive action records per browser session and at most four distinct forms per record: the exact resolved source, the post-dispatch target value, and for select the selected option value and visible text. Each form is at most the inherited 64 KiB UTF-8 value limit. Identity is `(navigation generation, action dispatch ordinal, graph node ID)`; duplicate forms within that record do not consume another slot. Missing/oversized forms, record/form overflow, or inability to prove the post-dispatch target identity throws `WebTargetError` code `SensitiveEvidenceUnavailable`, classified as an execution `error`, before evidence return. That code and no plaintext message is the inherited evidence-authority failure contract for Tickets 40-45.

## Migration

None; existing and allocated closure migrations are immutable to this ticket.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/deployment/CONTEXT.md` for verification that normalized forms do not enter current Runner logs

## Authority

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.1-6.2, 8, 10, 11, and 13. Runner-side redaction precedes evidence serialization, while raw resolved values remain outside Trace, Artifact, Finding, and logs.
- Context authority: `CONTEXT-MAP.md` and every context under **Affected contexts**, especially the `valueRef`, sensitive evidence, and log invariants.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` user stories 29-35 and 70; Implementation Decisions for Plan-owned input/select and Runner-resolved values; Testing Decisions for Ticket 18 Chromium sink coverage and the current review/delivery protocol.
- Predecessor authority: `.scratch/remaining-production-closure/issues/18-safe-valueref-input.md`, its merged PR, current public behavior, and tests. Its completion is assumed; this ticket does not re-accept its value-provider, capability, or exact-source workflow.
- Current public interfaces and tests: `PlaywrightBrowserSession`, `PlaywrightActionExecutor`, `PlaywrightObserver`, `ActionValueProvider`, `ObservationGraph`, `SpoolingTraceRecorder`, and the exact Allowed Files below as they exist on the implementation base.
- Closed PRs #78-#83 and any local WIP are historical context only. Their branches, commits, diffs, tests, and review claims are not implementation, source, or cherry-pick authority.

## Allowed Files

This is the complete edit scope:

- `packages/target-adapters/web-playwright/src/browser-session.ts`
- `packages/target-adapters/web-playwright/src/playwright-action-executor.ts`
- `packages/target-adapters/web-playwright/src/playwright-observer.ts`
- `packages/target-adapters/web-playwright/src/sensitive-evidence-authority.ts` (new)
- `tests/unit/target-adapters/web-playwright/action-resolution.test.ts`
- `tests/unit/target-adapters/web-playwright/browser-session.test.ts`
- `tests/component/web-execution/playwright-click.test.ts`
- `tests/component/web-execution/playwright-observation.test.ts`
- `tests/e2e/web-execution/value-ref.test.ts`
- `.scratch/remaining-production-closure/issues/39-browser-normalized-secret-redaction-remediation.md`

No Runner production file, package manifest, lockfile, reflected-node/screenshot implementation, scheduler instrumentation, or unrelated root is in scope.

## Focused non-E2E Gate

Run during implementation and after every code/test review fix:

```text
corepack pnpm vitest run tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/unit/target-adapters/web-playwright/browser-session.test.ts tests/component/web-execution/playwright-click.test.ts tests/component/web-execution/playwright-observation.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

Run only after an exact-head complete-matrix review is clean:

```text
corepack pnpm vitest run tests/e2e/web-execution/value-ref.test.ts
```

The real Chromium case must execute separate immutable input and select Jobs with LF, CRLF, and trailing-newline fixtures; inspect target-bound Graph/Trace data plus current Runner logs, pre-ACK events, and raw Spool bytes; and prove an unrelated equal-text node remains unchanged. Chromium absence or a skipped case is a failed Gate, not evidence.

## Execution, review, and delivery protocol

- Implement fresh from the then-current `main` only after Ticket 18's merge is present. Record ticket-local `start` evidence with exact base SHA, predecessor merge evidence, complete matrix applicability, and planned Gates; do not use a historical PR branch or WIP as a base.
- Keep the ticket `claimed` while implementing. Run the focused non-E2E Gate during edits and after every review fix; do not provision E2E during routine edits.
- Commit the complete code/test diff before each exact-base `/code-review`. Every round reviews the whole code/test diff and every Behavior Matrix row on Standards and Spec axes, reports each row as `pass | finding | N/A` with reasons, and records the reviewed head.
- Use at most five complete-matrix review rounds. Critical findings always block. Important findings block only under the umbrella protocol. If a core blocker remains after round five, set this ticket to `needs-info`, record it here, and stop Ticket 40.
- Record non-Critical advanced hardening in one GitHub Issue only, linked to this ticket and reviewed head. Do not implement it in this ticket or make it a dependency unless the user promotes it.
- After clean review, run the exact Chromium E2E. Any code/test change after review or E2E requires the focused Gate, a fresh complete-matrix review, and then E2E again.
- Do not create a PR until focused Gate, typecheck, diff check, review, Chromium E2E, and ticket-local `final` evidence are clean. Then create one non-draft PR. The only allowed post-review commit is final ticket evidence with a byte-identical code/test diff; keep `claimed` until merge, then record PR/merge evidence and set `resolved`.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Authorized input source has LF/CRLF/trailing-newline forms and Chromium accepts the action | `started` at permitted `fill` dispatch | Action succeeds; sensitive target value is redacted in the next Graph and owned serialized sinks | Only redacted target fields, valueRef, and existing action/Trace metadata may persist | Repeating the immutable Job/session produces the same target-bound classifications; no plaintext registry is persisted across sessions | Unit/component form table plus Chromium Graph/Trace/log/Spool evidence |
| Authorized select source maps to browser option value and visible option text | `started` at permitted `selectOption` dispatch | Action succeeds; selected target value/text forms are redacted | Redacted target fields and existing metadata only | Same valueRef/option replay is idempotent for registration; a different option is a distinct action | Real select case and serialized sink scan |
| Unrelated node contains bytes equal to a source or canonical form | `not_started` for that unrelated node | Unrelated node remains observable and unchanged | Its ordinary non-causal evidence may persist | Repeated captures do not promote equality into sensitivity | Equal-text negative assertion in Graph/Trace and E2E |
| ValueRef resolution fails, target is invalid/stale, or policy/capability rejects before dispatch | `not_started` | Existing stable blocked/error code; no normalization claim | Existing redacted terminal metadata only; no source/browser form retained | Retry only under existing corrected-value/current-graph/policy rules | Zero target dispatch and zero normalized registration |
| Browser cannot read/bind the post-action target form, a form exceeds 64 KiB, or the 100-record/four-form bound is exceeded | `started` | `SensitiveEvidenceUnavailable`; action result is not rewritten | No Graph or Artifact from the unclassified target is accepted | A fresh capture may retry; the action is never automatically replayed | Failure injection proving code-only failure and no accepted sensitive evidence bytes |
| Cancel/timeout before action dispatch | `not_started` | Existing cancellation/timeout result | No action effect and no durable canonical-form state | Safe under existing pre-dispatch retry rules | Permit and target-dispatch assertions |
| Cancel/timeout after input/select dispatch | `outcome_unknown` | `ActionOutcomeUnknown`; no automatic action replay | Existing terminal Trace may persist with code/valueRef only; unsafe evidence is not returned | Never replay the action automatically; a separately authorized observation may retry | Unknown-outcome Trace and sink scan |
| Duplicate registration of the same target/source/browser form | `started` if action already dispatched | No duplicate public output and no changed redaction result | Bounded in-memory set remains semantically idempotent | Safe to observe repeatedly within the same session | Cardinality and deterministic redaction assertions |
| A later action assigns a different source/form to the same target | `started` | Later target-sensitive forms are classified without making equal text elsewhere sensitive | Session retains only the bounded target history required for safe capture | Replay is action/target scoped; conflicting action is not collapsed into the first | Sequential action component evidence |
| Concurrent capture/action request or browser-session restart | `not_started` for rejected concurrency; fresh state after restart | Existing serialized-session result; fresh session has no inherited plaintext | No registry crosses session close/restart | Retry through a new authorized action in the new session | Concurrency rejection and close/reopen assertions |
| Trace/Spool persistence or log write fails after action | `outcome_unknown` for terminal evidence | Existing terminal persistence failure; no success claim | No reconstructed or manually sanitized success record | Retry persistence only under existing Spool semantics; never replay action to recreate evidence | Injected sink failure and absence of plaintext in emitted bytes |

## Acceptance

- [ ] Input and select register exact source plus Chromium-observed LF, CRLF, and trailing-newline forms against only the authorized target.
- [ ] The exact 100-record/four-form/64-KiB limits and `(navigation generation, dispatch ordinal, node ID)` identity fail with `SensitiveEvidenceUnavailable` rather than widening redaction.
- [ ] Target value/name/text fields carrying a registered form are redacted before Graph, Trace, current Runner log, pre-ACK event, or raw Spool serialization.
- [ ] Unrelated equal text remains unchanged; no global `replaceAll`-style document/evidence redaction remains in this path.
- [ ] Existing Ticket 18 value-provider, capability, dispatch, and exact-source acceptance remains green without being re-claimed.
- [ ] Focused Gate, typecheck, diff check, complete-matrix review, and exact Chromium E2E are clean on the final code/test head.
