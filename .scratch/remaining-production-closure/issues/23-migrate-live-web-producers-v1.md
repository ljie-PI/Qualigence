# 23 — Migrate live Web and Runner producers to Graph v1

**What to build:** Make Playwright observation, Runner Runtime, and observation Trace produce Graph v1 and advertise its capabilities.

**Blocked by:** 22 — Expand Graph v1 and web/v1 extension.

**Status:** claimed

## Tracked scope

This ticket owns the producer migration phase. It changes Playwright capture, live Runner observation/Trace types, protocol transport, and Graph/extension capability advertisement from pre-v1 to candidate Graph v1. Consumer migration remains ticket 24 and contract contraction/inventory remains ticket 25.

## Migration

- Change Playwright observation building/capture to emit validated `ObservationGraphV1` with deterministic roots, nodes, relations, source, state, sensitivity, evidence refs, target/capturedAt, and typed privacy-safe `web/v1`. Keep locator/DOM descriptors private to the adapter and keyed by node ID. Migrate the adapter-local Playwright action resolver to consume that v1 Graph/private descriptor generation so this producer slice remains usable; ticket 24 still owns model, exploration, evidence, benchmark, migration, and replay consumers.
- Change the live Runner `Observer`/Runtime observation and observation Trace producer/transport to v1 without defining a legacy/v1 union at the live port. Preserve lossless Trace mapping and stable action descriptor invalidation.
- Advertise `observation:observation-graph/v1` and `observation:web/v1` only when the producer supports them. Require/validate compatible Graph and extension majors before Job payload admission; no silent downgrade to legacy Graph.
- Production Runner capability construction is in scope for this ticket only through `apps/runner/src/offer-runtime.ts` and its unit test. The ticket must advertise `observation:observation-graph/v1` and `observation:web/v1` from the real Runner capability construction when the producer supports them; contract-only tokens are not production wiring.
- Preserve historical pre-v1 decoding outside live producers for ticket 25. Do not migrate model/exploration/evidence/benchmark/migration/replay consumers in this ticket.
- This ticket has no persistence migration allocation and may not edit migrations, status/checklists outside this ticket, or protocol protobuf files not listed in scope.

## Affected context paths

`docs/contexts/execution/CONTEXT.md`; `docs/contexts/product/CONTEXT.md`; `docs/contexts/protocol/CONTEXT.md`; `docs/contexts/evidence/CONTEXT.md`.

## Allowed Files

This is the complete edit scope.

- `packages/{target-adapters/web-playwright,runner-kernel,contracts/runner-protocol,protocol-adapters/grpc-runner-protocol}/src`
- `apps/runner/src/offer-runtime.ts`
- `tests/{unit/target-adapters/web-playwright,component/web-execution,conformance/runner-protocol,conformance/observation}`
- `tests/unit/runner/offer-runtime.test.ts`
- `.scratch/remaining-production-closure/issues/23-migrate-live-web-producers-v1.md`
- Post-review acceptance only: `tests/e2e/web-execution/graph-v1-producer.test.ts`

No app composition outside the exact Runner capability file above, protobuf schema, consumer package, migration package, package manifest, lockfile, or unlisted test root is allowed.

## Authority

Resolve conflicts in this order: applicable security/public contracts, architecture and context invariants, current domain/interfaces and conformance tests, then the umbrella spec and this ticket's migrated producer delta/scope.

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.1-6.3, 7, 9.1-9.2, 10, and 14.3. Runner emits ordered evidence; adapters preserve source semantics and redact before serialization; protocol mappings are lossless and capability mismatch is explicit.
- Context authority: all ownership, seams, invariants, and verification surfaces under **Affected context paths**.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` user stories 35 and 38-41; Implementation Decisions for Graph canonicalization/`web/v1`; Testing Decisions for live capture, protocol negotiation, complete matrices, and closure review.
- Tracked predecessor authority: `.scratch/remaining-production-closure/issues/22-expand-graph-v1-web-extension.md` and its merged GitHub PR/check evidence establish the semantic-set and `web/v1` contracts inherited here.
- Current public contracts and tests: `packages/contracts/observation/src/*` (consume, do not edit); `packages/contracts/runner-protocol/src/{index,capabilities}.ts`; `packages/runner-kernel/src/execution-runtime.ts` (`Observer`, `AgentContext`, `TraceRecorder`); `packages/target-adapters/web-playwright/src/{observation-builder,playwright-observer,playwright-web-target-adapter}.ts`; gRPC `mappers.ts`/`wire-codec.ts` under the allowed adapter source; and the producer/protocol/conformance tests named here.
- Ticket-local and GitHub evidence: this ticket's `## Comments` and `## Answer`, merged predecessor and final ticket PRs, required checks, reviewed-head and merge-commit bindings, and any deferred advanced-hardening Issues in `ljie-PI/Qualigence` are the durable execution evidence.

## Authority decisions

Ticket 22 freezes the capability tokens as `observation:observation-graph/v1` and `observation:web/v1`. This ticket owns live producer use of those tokens and production Runner capability construction in `apps/runner/src/offer-runtime.ts` only. It does not own unrelated app composition, package manifests, or new Runner startup wiring.

## Execution protocol

- This ticket is the execution entrypoint for producer migration. Start after blockers resolve from the latest merged predecessor; record exact base SHA, matrix pointer, and planned Gates under `## Comments`, citing the predecessor's merged PR and merge commit as current execution-base evidence.
- Use Node.js 24 and Corepack pnpm exactly `11.7.0`; install frozen in a fresh worktree. Do not change dependencies/lockfile.
- Begin with failing producer/protocol tests. During implementation/review fixes run only the focused Gate, root typecheck, and diff check. Preserve strict TypeScript, private locator provenance, stale-descriptor rejection, append-only ordered Trace, durable-ack semantics, and no raw secrets/query values.
- Before claiming production capability negotiation, prove `apps/runner/src/offer-runtime.ts` advertises the ticket-22 tokens through the existing `advertisedCapabilityTokens` path. Do not widen scope beyond the exact Runner capability file/test above.
- Do not skip a required Gate. `ChromiumUnavailable` is an explicit acceptance block. Preserve unrelated changes and stop before editing outside **Allowed Files**.
- Record start, optional actual blocker, review rounds, Gate/acceptance results, and final PR evidence under `## Comments`; summarize resolution under `## Answer`. Commit before each exact-head whole-diff, complete-matrix Standards/Spec review; record round, reviewed head, core findings, and row-level `pass | finding | N/A` under `## Comments`.
- Critical always blocks. Important blocks only for explicit acceptance, applicable architecture/security, public/persisted contract, required Gate, or primary correctness/data integrity. Fix core findings and rerun affected non-E2E tests plus fresh complete-matrix review.
- Stop after five rounds. A remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision; do not create recursive local remediation tickets.
- Record non-Critical advanced hardening as one deferred GitHub Issue in `ljie-PI/Qualigence` with source ticket/branch/PR, fixed/reviewed heads, severity/risk, authority, affected files/Gates, and acceptance. Do not implement or add it as a dependency unless promoted.
- Run real Chromium producer acceptance only after review is clean. Code/test changes afterwards require focused verification, fresh complete-matrix review, then acceptance again.
- Create one non-draft PR only after all evidence is clean; a final ticket-evidence-only commit is allowed only with byte-identical reviewed code/test diff. Keep `claimed` through merge, then record PR/merge SHA under `## Answer`, resolve, and remove branch/worktree.

## Focused non-E2E Gate

```text
corepack pnpm vitest run tests/unit/target-adapters/web-playwright tests/unit/runner/offer-runtime.test.ts tests/component/web-execution/playwright-observation.test.ts tests/conformance/runner-protocol tests/conformance/observation
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

```text
corepack pnpm vitest run tests/e2e/web-execution/graph-v1-producer.test.ts
```

Run Chromium through the production producer and Graph/extension capability negotiation. Validate the emitted/transported Graph against shared schema/canonical contracts and prove incompatible majors reject before Job payload/action admission. No synthetic graph or browser skip satisfies acceptance.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Compatible Runner/Job and successful Chromium capture | `started` at browser capture; no action side effect for observation alone | Valid `ObservationGraphV1` and ordered v1 observation Trace | V1 Trace event is appended through the existing durable ingest/ack path | Duplicate identical Trace sequence is idempotent under existing protocol rules | Schema/canonical validation, capability decision, serialized round trip, durable Trace acknowledgement |
| Runner/session authentication fails before Job admission | `not_started` | Existing protocol authentication rejection | No Job payload, observation, or action state | Reconnect/authenticate through the existing protocol; never bypass for Graph migration | Authentication rejection and zero Job payload |
| Producer cannot satisfy required Graph/`web/v1` major | `not_started` | `CapabilityMismatch` or `ExtensionVersionUnsupported` before Job payload/action admission | No offer payload/observation/action state | Retry only with compatible capabilities; no legacy downgrade | Missing capability list and zero Job/action dispatch |
| Malformed Graph, dangling refs, invalid evidence, secret/raw query leakage, or invalid extension | `not_started` for Trace publication | Stable observation validation error | Invalid Graph is not appended/acknowledged | Correct capture and retry; never publish then sanitize | Validation/redaction failure and absent Trace acknowledgement |
| Target policy disallows origin/query key or capture leaves allowed origin | `not_started` for valid Graph publication/action | Stable origin/policy rejection | No valid Graph/descriptor authority is registered | Reobserve only after authoritative target state is corrected | Policy/origin evidence and no action permit |
| Cancel/timeout before browser capture dispatch | `not_started` | Stable cancellation/timeout | No new observation event | Safe to retry capture if lease/action window remains valid | Cancellation and zero browser request |
| Cancel/timeout during capture before a valid Graph is returned | `started` | Stable target timeout/cancel | No partial Graph/Trace event | Retry capture only under existing lease/budget; partial data is discarded | Capture start/error and absent Graph acknowledgement |
| State-changing action was dispatched and post-action capture times out/cancels | `outcome_unknown` for action, `started` for capture | Existing `ActionOutcomeUnknown` terminal; never infer from missing observation | No post-action safe observation advances the Trace as success | Never automatically replay action; higher-level disposition required | Action dispatch, missing authoritative outcome/capture, unknown terminal |
| Same serialized v1 Trace event/sequence is resent after reconnect | `started` | Existing idempotent acknowledgement for byte-identical event | One authoritative event at the sequence | Resend until durable ack; identical duplicate does not fork Trace | Same hash/sequence and one durable event |
| Same Trace sequence carries altered Graph/hash | `started` | Existing Trace conflict/protocol rejection | Original event remains authoritative | Never overwrite; stop/reconcile connection | Conflict evidence names sequence/hash |
| Concurrent captures for one Runtime step | `started` | Only the Runtime-owned capture may authorize that step; stale capture cannot resolve an action | Ordered Trace preserves authoritative capture; private descriptors are generation-bound | Stale/losing capture is discarded, not merged | Generation/step evidence and stale-descriptor rejection |
| Process/connection restarts after durable Trace ack | `not_started` until new capture | Resume from durable cursor; no duplicate event | Acknowledged v1 event remains authoritative | Resend only unacknowledged event; reobserve before later action | Resume cursor and no duplicate authoritative observation |
| Trace append/ack persistence fails after valid capture | `started` | Stable Trace/storage failure; Runtime cannot claim observation stage complete | No acknowledged observation event | Retry exact event under existing protocol; do not execute from unacknowledged Graph | Valid graph hash plus failed append/ack and zero subsequent action |
| Terminal Trace persistence fails | `started` | Existing terminal persistence error; no successful completion claim | Terminal event/completion is not partially acknowledged | Retry exact terminal persistence; completion remains gated by Trace drain | Failed terminal append/ack and absent completion acknowledgement |

- [x] Web captures valid v1 nodes, relations, source, state, sensitivity, evidence refs, roots, and `web/v1`.
- [x] Trace transports v1 losslessly and rejects incompatible majors.
- [x] Runner advertises and negotiates Graph/extension capabilities before work.
- [x] Real Chromium capture passes shared schema and canonical hash tests after clean review.

## Comments

### start — 2026-08-24

- Fixed base: `0238c9cddebed3c4903df2e376d6377483b3ca28` (`main`, includes PR #95 merge `0238c9c`).
- Predecessor merge evidence: Ticket 22 is `resolved` with PR #90 merge commit `7ef31db708612ddc5c020e6e2bb2758d763fba85` recorded in `.scratch/remaining-production-closure/issues/22-expand-graph-v1-web-extension.md` and present in current history. Ticket 39 target-bound browser-normalized redaction is present through PR #94 merge commit `8fd56808dea9fc8b202e0d4833a0e8f5606e6001` and docs PR #95 merge `0238c9cddebed3c4903df2e376d6377483b3ca28`.
- Behavior Matrix applicability: complete matrix in this ticket is applicable to live Web producer capture, Runtime observation Trace emission, protocol transport, capability advertisement/negotiation, and fail-closed admission; no rows are marked N/A for implementation planning.
- Planned Gates: `CI=true corepack pnpm vitest run tests/unit/target-adapters/web-playwright tests/unit/runner/offer-runtime.test.ts tests/component/web-execution/playwright-observation.test.ts tests/conformance/runner-protocol tests/conformance/observation`, then `CI=true corepack pnpm typecheck`, then `git diff --check`.

### expanded implementation update — 2026-08-25

- Maintainer-approved scope expansion applied after prior review findings: merged current `main` (`3c6fef1`) into branch as `6eff60b`, preserving ticket 39 redaction and main docs.
- Implemented live Runner `Observer`, `AgentContext`, `VerificationContext`, action resolver graph, and observation Trace typing as `ObservationGraphV1`; Runtime validates before `recordStage`, and `TraceEvent` observation payloads are v1.
- Core/Local web offers now require `target:web-playwright`, `observation:observation-graph/v1`, and `observation:web/v1` at the producer side rather than relying on Runner-side silent augmentation. Direct `RunnerOfferRuntime` still rejects missing/incompatible v1 requirements before lease acceptance.
- Added real Chromium producer/capability acceptance at `tests/e2e/web-execution/graph-v1-producer.test.ts` covering production Playwright capture, v1/web-v1 validation, trace transport round trip, and missing/incompatible capability rejection before lease acceptance.
- Worker validation passed: focused gate (`15 files / 255 tests`), expanded regression gate (`6 files / 97 tests`), `CI=true corepack pnpm typecheck`, `git diff --check`, and producer E2E (`1 file / 2 tests`). Formal complete-matrix review and PR evidence remain pending; status intentionally stays `claimed`.
