# 26 — Add Desktop Target protocol

**What to build:** Transport immutable Desktop AppTarget values through product/domain and Runner Protocol contracts without losing fields or weakening Web behavior.

**Blocked by:** 25 — Contract legacy Graph and close candidate Gate.

**Status:** claimed

## Tracked scope

This ticket owns the Desktop protocol phase: the additive Web/Desktop `TargetRef` discriminated union, immutable `AppTarget` transport shape, protobuf/mappers/round trip, malformed-oneof rejection, and provider-neutral Target domain compatibility. Ticket 27 owns the TypeScript Companion client and ticket 28 owns Runner Target Runtime composition.

## Migration

- Extend `TargetRef` from Web-only to `WebTargetRef | DesktopTargetRef`, where Desktop carries the complete validated `AppTarget` as structured protobuf fields, never arbitrary JSON. Map target ID, platform, launch executable/argv/workdir, process image/children, window selector, reset command/argv/timeout, and shutdown policy losslessly.
- Parse exactly one target kind. Reject absent, malformed, unknown, or multiple kinds and any silently defaulted/dropped Desktop field before queue/offer. Preserve existing Web bytes, admission, and round trips.
- Preserve immutable product provenance already carried outside `TargetRef`: project, approved Target revision/snapshot hash, policy, plan, and explicit Runner binding must remain unchanged through Mission scheduling and Runner admission.
- Mission scheduling's Desktop `AcceptedExecutionJob` construction is in scope for this ticket through the exact Mission scheduling service and unit tests listed below. This ticket must remove the current Web-only rejection for authorized Desktop targets at the application seam and preserve every immutable Target/provenance field losslessly into the Runner Protocol job. Server routes, Runner runtime composition, and Desktop execution remain out of scope.
- This ticket has no migration allocation and may not change package manifests, protobuf generated output outside listed source, Mission storage, Public API routes, or Runner composition.

## Affected context paths

`docs/contexts/product/CONTEXT.md`; `docs/contexts/protocol/CONTEXT.md`; `docs/contexts/execution/CONTEXT.md`; `docs/contexts/windows/CONTEXT.md`.

## Allowed Files

This is the complete edit scope.

- `packages/{core-modules/project-target,contracts/desktop,contracts/runner-protocol,protocol-adapters/grpc-runner-protocol}/src`
- `packages/core-modules/mission/src/application/mission-scheduling-service.ts`
- `packages/contracts/runner-protocol/proto`
- `packages/runner-kernel/src/deterministic-policy-gate.ts` (maintainer-authorized narrow compatibility edit for additive Desktop `TargetRef` typing only)
- `apps/core-daemon/src/main.ts` (maintainer-authorized narrow compatibility edit for additive Desktop `TargetRef` typing only)
- `apps/core-daemon/src/runner/runner-backed-run-resource-factory.ts` (maintainer-authorized narrow fail-closed compatibility edit for additive Desktop `TargetRef` typing only)
- `apps/runner/src/offer-runtime.ts` (maintainer-authorized narrow fail-closed compatibility edit for additive Desktop `TargetRef` typing only)
- Direct existing tests for the four compatibility files above may be updated only if needed to preserve their existing Web behavior or assert Desktop fail-closed/deferred behavior; no new test roots are authorized.
- `tests/{type,contract/desktop,unit/core-modules/project-target,unit/core-modules/mission,conformance/runner-protocol}`
- `.scratch/remaining-production-closure/issues/26-desktop-target-protocol.md`

## Post-review acceptance ownership

N/A. This ticket and the umbrella spec assign no external/component E2E or additive acceptance file to ticket 26. Post-review verification is ticket/PR evidence that the focused Gate covers domain validation, Mission scheduling construction, protobuf schema, mappers, and Web/Desktop round trips. It is not permission to borrow ticket 28's E2E.

Files outside **Allowed Files**, including any `packages/core-modules/mission` file not listed above, `packages/core-application`, `apps/server`, package manifests, `pnpm-lock.yaml`, and component/E2E tests, are not allowed; stop and request an explicit maintainer scope decision before editing them. The only `apps/runner` file in scope is `apps/runner/src/offer-runtime.ts` for the narrow compatibility edit listed above.

## Authority

Resolve conflicts in this order: security/public contracts, architecture and context invariants, current interfaces/contracts/tests, then the umbrella spec and this ticket's additive protocol scope.

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.5, 6.2-6.5, 7, 9.1-9.2, 12, and 14.3. Core owns immutable AppTarget configuration/provenance; Runner Protocol is lossless; capability mismatch is explicit; adapters cannot change Mission/Trace/Policy semantics.
- Context authority: all ownership, seams, dependency direction, invariants, and verification surfaces in **Affected context paths**.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` user stories 43 and 45 and existing product provenance stories 3-6; Implementation Decisions on Desktop input/identity boundaries; Testing Decisions on protobuf/mappers/round trip/malformed oneof and complete matrices.
- Tracked predecessor authority: `.scratch/remaining-production-closure/issues/25-contract-legacy-graph-candidate.md` and its merged GitHub PR/check evidence establish the candidate Graph and capability behavior inherited here.
- Current public contracts and tests: `packages/core-modules/project-target/src/domain/{target-revision,app-target}.ts`; `packages/core-modules/mission/src/application/mission-scheduling-service.ts`; `packages/contracts/desktop/src/{app-target,companion-ipc,index}.ts`; `packages/contracts/runner-protocol/src/{index,messages,capabilities}.ts`; `packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto`; `packages/protocol-adapters/grpc-runner-protocol/src/{mappers,wire-codec}.ts`; and the type/Desktop/project-target/mission/protocol tests named here.
- Ticket-local and GitHub evidence: this ticket's `## Comments` and `## Answer`, merged predecessor and final ticket PRs, required checks, reviewed-head and merge-commit bindings, and any deferred advanced-hardening Issues in `ljie-PI/Qualigence` are the durable execution evidence.

## Authority decisions

The Public Target/Mission producer acceptance is resolved by adding the exact Mission scheduling service and unit-test scope above. Ticket 26 owns the application-seam Desktop job construction and protocol mapping only; ticket 28 owns Runner runtime execution and component/E2E proof.

## Execution protocol

- Start after ticket 25 resolves, from the latest merged predecessor. Record exact base SHA, matrix pointer, planned Gate, and the Mission-scheduling scope decision under `## Comments`, citing the predecessor's merged PR and merge commit as current execution-base evidence.
- Keep Mission producer edits limited to `mission-scheduling-service.ts` and its unit tests. If authorized Desktop Job construction requires repositories, Server routes, Runner runtime, package manifests, or component/E2E tests, stop for a new scope decision rather than widening this ticket.
- Use Node.js 24 and Corepack pnpm exactly `11.7.0`; frozen install in a fresh worktree. Do not change dependencies/lockfile.
- Begin with failing type/protobuf/mapper/conformance tests. During implementation/review fixes run only the focused Gate, root typecheck, and diff check. Preserve strict TypeScript, exact protobuf field presence, immutable provenance, Web compatibility, and explicit capability/validation errors.
- Do not skip required tests. Preserve unrelated changes and stop before editing outside **Allowed Files**.
- Record start, optional actual blocker, review rounds, focused/N/A acceptance results, and final PR evidence under `## Comments`; summarize resolution under `## Answer`. Commit before each exact-head Standards/Spec review. Every round covers whole diff and every matrix row and reports row-level `pass | finding | N/A`, reasons, reviewed head, and core findings under `## Comments`.
- Critical always blocks. Important blocks only for explicit acceptance, applicable architecture/security, public/persisted contract, required Gate, or primary correctness/data integrity. Fix core findings and rerun affected non-E2E Gate plus fresh complete-matrix review.
- Stop after five rounds. A remaining core blocker sets this original ticket to `needs-info`, blocks dependents, and requests a maintainer scope/ownership decision. Do not create recursive local remediation tickets.
- Non-Critical advanced hardening is deferred to one GitHub Issue in `ljie-PI/Qualigence` with source ticket/branch/PR, fixed/reviewed heads, severity/risk, authority, affected files/Gates, and acceptance. Do not implement or add as dependency unless promoted.
- No product E2E is owned by this ticket. After clean review, record the exact N/A acceptance rationale and focused contract evidence. Any code/test change still requires focused Gate and fresh complete-matrix review.
- Create one non-draft PR only after focused Gate, typecheck, diff check, clean review, N/A acceptance evidence, and final ticket evidence are clean. A final ticket-evidence-only commit may follow only with byte-identical code/test diff. Keep `claimed` until merge; then record PR/SHA under `## Answer`, resolve, and clean branch/worktree.

## Focused non-E2E Gate

```text
corepack pnpm vitest run tests/contract/desktop tests/unit/core-modules/project-target tests/unit/core-modules/mission tests/conformance/runner-protocol
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

N/A: no post-review external/component E2E is allocated. After clean review, verify the focused Gate includes exact AppTarget domain validation, protobuf oneof/schema assertions, mapper/codec lossless Desktop round trip, malformed/multiple-kind rejection, and unchanged Web round trips. Record the Mission producer scope ambiguity under `## Comments`/`## Answer` rather than claiming end-to-end Desktop Job production.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Valid immutable Web Target/job maps to wire and back | `not_started` | Byte/field-equivalent Web target and unchanged admission | N/A: pure mapping/domain validation; scheduling persistence is outside scope | Repeated mapping is deterministic | Existing and new Web round-trip/conformance evidence |
| Valid immutable Desktop `AppTarget` maps to wire and back | `not_started` | Field-equivalent `DesktopTargetRef`/`AppTarget` | N/A: pure mapping; no process launch | Repeated mapping is deterministic | Every AppTarget field asserted in mapper/round-trip tests |
| Valid Target revision creation with project, version, hash, and Runner binding | `not_started` | Immutable Target revision with deterministic snapshot hash | Repository persistence is outside this ticket; domain value is immutable | Same exact input is deterministic; expected-version storage behavior remains existing authority | Unit evidence for Web/Desktop Target domain validation/provenance |
| Caller/session authentication is absent or invalid | `not_started` | N/A: this additive domain/wire contract owns no authentication seam; existing product/protocol admission must reject before use | N/A | Authenticate at the owning API/protocol boundary, then map the authorized immutable value | N/A reason recorded in review |
| Missing/unknown/multiple target oneof or malformed Desktop field | `not_started` | Stable parse/validation error before queue/offer | No accepted Job/Target mutation | Correct input and retry; no defaulting/dropping | Proto/mapper negative evidence and zero admission |
| Desktop AppTarget contains shell command, noncanonical path, forbidden environment/secret, bad platform, or unsafe bounds | `not_started` | Existing stable AppTarget/ProjectTarget validation error | No Target revision/Job created | Retry only with approved immutable configuration | Domain contract rejection |
| Project, policy, plan, Target revision/hash, or Runner binding is absent/altered | `not_started` | Stable policy/provenance parse conflict; no offer | No accepted Job | No inferred/default authority; producer must supply exact values | Type/conformance rejection and field round-trip assertions |
| Runner lacks Desktop/Graph/extension capability | `not_started` | `CapabilityMismatch` before Job payload | No offer payload/action state | Retry only with compatible bound Runner; no Web fallback | Missing capability evidence |
| Web target is presented as Desktop or Desktop as Web | `not_started` | Stable discriminant/oneof error | No accepted Job | Correct kind and retry; never reinterpret | Cross-kind negative tests |
| Mission producer attempts authorized Desktop Job creation | `not_started` until pure construction | Authorized Desktop `AcceptedExecutionJob` is constructed with lossless AppTarget fields; execution remains ticket 28 | Existing Mission scheduling persistence remains authoritative; no Desktop process launches | Replay follows existing Mission idempotency; malformed Desktop input remains rejected | Mission scheduling unit evidence and protocol round trip |
| Timeout/cancel before or after dispatch | `not_started` | N/A: this ticket's domain parsing/mapping is synchronous and owns no transport session or process dispatch | N/A | Pure operation may repeat | N/A reason recorded in review |
| Unknown outcome | `not_started` | N/A: no side-effect dispatch in this ticket | N/A | Pure operation may repeat | N/A reason recorded in review |
| Idempotent replay of same DTO/wire bytes | `not_started` | Same parsed/mapped value | N/A | Unlimited deterministic replay | Round-trip/property evidence |
| Same Job/Target identity with conflicting Desktop fields | `not_started` | Stable parse/provenance conflict at owning caller; mapper does not merge | No mutation in this ticket | Never overwrite or infer; caller uses correct immutable snapshot | Conflicting field tests where exposed by contract |
| Concurrent mapping/restart | `not_started` | Identical deterministic output | N/A: stateless operation | Safe to recompute | Pure/stateless review evidence |
| Terminal persistence failure | `not_started` | N/A: Target/Mission repository and queue persistence are outside scope | N/A | Owned by existing product/dispatch contracts | N/A reason recorded in review |

- [ ] Target discriminated union carries complete Web or Desktop snapshot and rejects malformed/multiple kinds.
- [ ] Project, policy, plan, Target revision/hash, and Runner binding remain lossless.
- [ ] Public Target/Mission producer can create an authorized Desktop Job.
- [ ] Existing Web round trips and admission remain unchanged.

## Comments

### start - 2026-08-25

- Fixed base: `05e05ebd762a9222b5fc031503c29612424d0105` (`ticket-26-desktop-target-protocol`, based on current `main` and including merged Ticket 25 PR #110).
- Predecessor evidence: Ticket 25 is `resolved` with PR #110; reviewed code head `d25c3d4d5c7c58777ce76f6e231c778c91591047` and final verification evidence are recorded in `.scratch/remaining-production-closure/issues/25-contract-legacy-graph-candidate.md` and are present in this worktree base.
- Behavior Matrix applicability: applicable. The frozen matrix in this ticket governs Desktop/Web TargetRef parsing, lossless AppTarget protobuf/mappers, provider-neutral Target validation, explicit capability/provenance rejection, and Mission scheduling's pure Desktop `AcceptedExecutionJob` construction. Rows for auth, timeout/cancel, unknown outcome, and terminal persistence remain N/A for implementation because this ticket owns no authentication boundary, async transport session, process dispatch, or persistence implementation.
- Planned focused non-E2E Gate: `CI=true corepack pnpm vitest run tests/contract/desktop tests/unit/core-modules/project-target tests/unit/core-modules/mission tests/conformance/runner-protocol`, then `CI=true corepack pnpm typecheck`, then `git diff --check`.
- Mission-scheduling scope decision: implementation is limited to `packages/core-modules/mission/src/application/mission-scheduling-service.ts` and unit tests; Ticket 26 owns authorized Desktop job construction and Runner Protocol mapping only. Server routes, Runner runtime composition, package manifests/lockfiles, storage migrations, component tests, and E2E proof remain out of scope.

### blocked - 2026-08-25

- In-scope implementation reached a safe point: `TargetRef` now has an additive Web/Desktop domain shape, structured Desktop `AppTarget` protobuf/wire mapping, Desktop capability tokens, mapper/oneof rejection tests, provider-neutral Target tests, and Mission scheduling Desktop `AcceptedExecutionJob` construction limited to `mission-scheduling-service.ts`.
- Focused non-E2E Vitest Gate passed after building the touched packages for local dist availability: `CI=true corepack pnpm vitest run tests/contract/desktop tests/unit/core-modules/project-target tests/unit/core-modules/mission tests/conformance/runner-protocol` (14 files / 168 tests).
- Root typecheck is blocked by required compatibility edits outside this ticket's explicit allowed scope after widening `TargetRef`:
  - `packages/runner-kernel/src/deterministic-policy-gate.ts(56,40): error TS2339: Property 'url' does not exist on type 'TargetRef'. Property 'url' does not exist on type 'DesktopTargetRef'.`
  - `packages/runner-kernel/src/deterministic-policy-gate.ts(105,31): error TS2339: Property 'url' does not exist on type 'TargetRef'. Property 'url' does not exist on type 'DesktopTargetRef'.`
  - `apps/core-daemon/src/main.ts(144,69): error TS2322: Type '"web" | "desktop"' is not assignable to type '"web" | "app"'. Type '"desktop"' is not assignable to type '"web" | "app"'.`
  - `apps/core-daemon/src/runner/runner-backed-run-resource-factory.ts(104,65): error TS2339: Property 'url' does not exist on type 'TargetRef'. Property 'url' does not exist on type 'DesktopTargetRef'.`
  - `apps/runner/src/offer-runtime.ts(81,40): error TS2339: Property 'url' does not exist on type 'TargetRef'. Property 'url' does not exist on type 'DesktopTargetRef'.`
- Minimal scope expansion needed: allow narrow fail-closed compatibility edits in the directly affected Desktop-unaware consumers listed above so each switches on `target.kind` and either preserves Web behavior or rejects/defers Desktop until Ticket 28 owns runtime execution. Without that expansion, the widened public `TargetRef` contract cannot remain type-safe under the required root `corepack pnpm typecheck`.
- No Server routes, storage migrations, package manifests/lockfile, Runner runtime composition beyond the listed blocked consumers, component tests, or E2E tests were edited.

- scope-decision: Maintainer authorized a narrow Ticket 26 scope expansion after the in-scope Desktop `TargetRef` implementation reached root typecheck blockers. The added files are limited to `packages/runner-kernel/src/deterministic-policy-gate.ts`, `apps/core-daemon/src/main.ts`, `apps/core-daemon/src/runner/runner-backed-run-resource-factory.ts`, and `apps/runner/src/offer-runtime.ts`, plus direct existing tests only if necessary. The edits must switch on `target.kind`, preserve Web behavior, and fail closed/defer Desktop runtime handling until Ticket 28; they do not authorize Server routes, Runner runtime execution, package manifests, lockfile changes, storage migrations, component/E2E tests, or broader app composition.
