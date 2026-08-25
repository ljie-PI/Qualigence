# 24 — Migrate live Graph consumers to v1

**What to build:** Move model decisions, resolution, verification, exploration, evidence decoration, benchmark, and replay consumers to Graph v1.

**Blocked by:** 21 — Run the real Reference Model benchmark; 23 — Migrate live Web and Runner producers to Graph v1.

**Status:** claimed

## Tracked scope

This ticket owns the consumer migration phase. It moves all listed live model, exploration, execution-evidence, benchmark, and replay consumers from the legacy Graph shape to candidate `ObservationGraphV1` after both the real benchmark baseline and v1 producers exist. Ticket 25 owns repository-wide legacy contraction and migration inventory.

## Migration

- Change model decision/verification contexts, resolver-facing model semantics, exploration fingerprinting/controller state, artifact recording/decorating, benchmark scenario/runner state, and active replay paths in scope to `ObservationGraphV1` and typed extension readers.
- Read common semantics from v1 `role/name/value/state/relations/source/sensitivity/evidenceRefs` and require a supported extension major only where that consumer depends on extension fields. Unknown optional extensions/minor fields remain round-trippable and ignorable.
- Preserve Graph-level and node-level evidence provenance in Artifact decoration. Never copy raw Artifact bytes, private Web descriptors, plaintext secrets, or query values into model prompts/Trace/Finding/report fields.
- Make exploration fingerprints and benchmark state deterministic over the ticket 22 canonical/redacted representation without converting business-order arrays into sets.
- Historical pre-v1 decoding must enter through `@qualigence/observation-migration`, produce a validated v1 projection, and only then reach live consumers. Do not remove all legacy declarations or perform the complete historical inventory here.
- This ticket has no persistence migration allocation; historical source remains immutable.

## Affected context paths

`docs/contexts/execution/CONTEXT.md`; `docs/contexts/product/CONTEXT.md`; `docs/contexts/evidence/CONTEXT.md`; `docs/contexts/storage/CONTEXT.md`.

## Allowed Files

This is the complete edit scope.

- `packages/{runner-components/model-agent,runner-components/exploration,execution-application,observation-migration}/src`
- `packages/runner-components/skill-replay/src/**` (maintainer-authorized scope expansion for active Skill replay consumer migration only)
- `apps/benchmark-runner/src`
- `tests/{unit/runner-components,unit/execution-application,replay,property}`
- `tests/helpers/skill-reverifier.ts` and `tests/helpers/windows-reference-app.ts` (maintainer-authorized support fixtures for v1 replay/recompiler/reference-app coverage only)
- `tests/component/skill-lifecycle/recording-to-replay.test.ts` (maintainer-authorized stale Skill lifecycle replay fixture update only)
- `.scratch/remaining-production-closure/issues/24-migrate-live-graph-consumers.md`
- Post-review acceptance only: `tests/e2e/observation-v1/consumer-migration.test.ts`

No Runner Kernel/public Graph contract, Web producer, model provider/gateway, benchmark package, package manifest, migration file, or unlisted test root is in scope.

## Authority

Resolve conflicts in this order: security/public-contract invariants, architecture and context invariants, current interfaces/contracts/tests, then the umbrella spec and this ticket's migrated consumer delta/scope.

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.1-6.3, 8, 9.2, 10, 13, and 14.2-14.3. Generic planners consume understood core/extension semantics; historical events remain immutable; replay re-resolves at checkpoints; evidence provenance and redaction are preserved.
- Context authority: all ownership, seams, invariants, and verification surfaces in **Affected context paths**.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` user stories 35, 38-42, and 68; Implementation Decisions on canonicalization/`web/v1`/candidate status; Testing Decisions on combined model/resolver/exploration/evidence/benchmark/replay coverage and complete matrices.
- Tracked predecessor authority: `.scratch/remaining-production-closure/issues/21-real-reference-model-benchmark.md` and `.scratch/remaining-production-closure/issues/23-migrate-live-web-producers-v1.md`, together with their merged GitHub PR/check evidence, establish the benchmark and producer behavior inherited here.
- Current public contracts and tests: `packages/contracts/observation/src/*` and `packages/runner-kernel/src/execution-runtime.ts` (consume, do not edit); `packages/runner-components/model-agent/src/model-agent.ts`; `packages/runner-components/exploration/src/{exploration-controller,state-visit-tracker}.ts`; `packages/runner-components/skill-replay/src/skill-replay-controller.ts`; `packages/execution-application/src/artifact-recording-observer.ts`; `packages/observation-migration/src/{pre-v1-projector,migration-runner,skill-recompiler}.ts`; `apps/benchmark-runner/src/{run,scenario}.ts`; and the consumer/replay tests named here.
- Ticket-local and GitHub evidence: this ticket's `## Comments` and `## Answer`, merged predecessor and final ticket PRs, required checks, reviewed-head and merge-commit bindings, and any deferred advanced-hardening Issues in `ljie-PI/Qualigence` are the durable execution evidence.

## Execution protocol

- Start only after both blockers are `resolved`, from the latest merged predecessor. Record exact base SHA, matrix pointer, and planned Gates under `## Comments`, citing the predecessors' merged PRs and merge commits as current execution-base evidence.
- Use Node.js 24 and Corepack pnpm exactly `11.7.0`; frozen install in a fresh worktree. Do not change dependencies or lockfile.
- Begin with failing consumer/replay tests. During implementation/review fixes run only the focused Gate, root typecheck, and diff check. Preserve strict TypeScript, deterministic model-proposal boundaries, v1 validation before use, source immutability, evidence redaction, and existing stable terminal/error semantics.
- Do not skip required tests. Acceptance infrastructure absence is explicit, not pass evidence. Preserve unrelated changes and stop before any file outside **Allowed Files**.
- Record start, optional actual blocker, review rounds, Gate/acceptance results, and final PR evidence under `## Comments`; summarize resolution under `## Answer`. Commit before exact-head Standards/Spec review. Every round covers whole diff and every matrix row and records row-level `pass | finding | N/A`, reasons, reviewed head, and core findings under `## Comments`.
- Critical always blocks. Important blocks only for explicit acceptance, applicable architecture/security, public/persisted contract, required Gate, or primary correctness/data integrity. Core fixes require affected non-E2E tests and fresh complete-matrix review.
- Stop after five rounds. If a core blocker remains, set this ticket `needs-info`, record it here, stop dependents, and request a maintainer scope/ownership decision. Do not create recursive local remediation tickets.
- Non-Critical advanced hardening is deferred unless promoted. Create one GitHub Issue in `ljie-PI/Qualigence` with source ticket/branch/PR, fixed/reviewed heads, severity/risk, authority, affected files/Gates, and acceptance; do not implement or block here.
- Run combined cross-consumer acceptance only after clean review. Any later code/test edit requires focused verification, fresh complete-matrix review, then acceptance again.
- Create one non-draft PR only after all required evidence is clean; a final ticket-evidence-only commit may follow reviewed code only if code/test diff is byte-identical. Keep `claimed` until merge; then record PR/SHA under `## Answer`, resolve, and remove branch/worktree.

## Focused non-E2E Gate

```text
corepack pnpm vitest run tests/unit/runner-components/model-agent.test.ts tests/unit/runner-components/exploration tests/unit/execution-application/artifact-recording-observer.test.ts tests/replay
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

```text
corepack pnpm vitest run tests/e2e/observation-v1/consumer-migration.test.ts
```

Run model, resolver-facing decisions, exploration, evidence decoration, the real benchmark path, and replay together over v1 producer output and projected historical input. Prove deterministic fingerprints/results, preserved evidence provenance, extension-major rejection, and no direct legacy Graph input to a live consumer.

## Comments

### start — 2026-08-25

- Fixed base: `f34e7547c8208dd85425f64992553d4b8d290afc` (`main`/`origin/main` at isolated worktree start).
- Predecessor merge evidence: Ticket 21 is `resolved` with PR #101 merge commit `219532953a4eb0601b8471a8e510508dbd2c8647` present in current history; Ticket 23 is `resolved` with PR #97 merge commit `b7d087526be47c86950ae0ff1714f68043445a6d` present in current history and PR #98 docs resolution `4e6cc92` on the base branch.
- Behavior Matrix applicability: applicable; every row in this ticket's matrix governs the stateful/side-effecting consumer migration across model decisions, exploration, evidence decoration, benchmark state, and replay/migration paths. No rows are marked N/A for implementation planning.
- Planned Gates: `CI=true corepack pnpm vitest run tests/unit/runner-components/model-agent.test.ts tests/unit/runner-components/exploration tests/unit/execution-application/artifact-recording-observer.test.ts tests/replay`, then `CI=true corepack pnpm typecheck`, then `git diff --check`. Post-review acceptance `CI=true corepack pnpm vitest run tests/e2e/observation-v1/consumer-migration.test.ts` is intentionally left for the parent after complete-matrix review.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Valid v1 producer Graph with supported required extensions | `started` only when consumer invokes model/action/evidence persistence; pure reads are `not_started` | Existing consumer result over v1 semantics | Existing Trace/Artifact/checkpoint/attempt stores retain v1 hash/provenance as applicable | Replay of same canonical Graph is deterministic and idempotent at each existing store seam | Cross-consumer output, graph hash, and provenance references |
| Valid v1 Graph carries unknown optional extension/minor fields | `not_started` unless normal consumer work follows | Consumer ignores unknown optional semantics and preserves round trip | Existing output retains required source refs; no destructive rewrite | Same input replays identically | Extension round-trip plus unchanged consumer result |
| Required extension is absent or unsupported major | `not_started` | `ExtensionVersionUnsupported` or stable capability rejection | No action/model-dependent result that claims unsupported semantics | No downgrade; retry only with compatible producer/capability | Rejection before dependent decision/action |
| Invalid v1 schema, dangling relation, bad evidence ref, or secret/raw query value | `not_started` | Stable observation/evidence validation error | No derived checkpoint/report/evidence decoration is committed | Correct projection/producer and retry; never sanitize after consumption | Validation failure and zero downstream effect |
| Caller authentication, immutable policy, budget, or negotiated capability rejects the work | `not_started` | Existing stable auth/policy/budget/capability rejection | No model/action/evidence/benchmark side effect is committed | Retry only with valid authority/capability; never downgrade or infer permission | Rejection evidence and zero downstream dispatch |
| Direct legacy Graph reaches a live consumer | `not_started` | Compile-time exclusion or stable runtime schema rejection | Historical asset remains unchanged | Route through migration projector, then retry as validated v1 | Test proves only migration package accepts legacy input |
| Historical source is valid and projects to v1 | `started` at append of a new projection/result, never source rewrite | Existing `migrated`/consumer result | Immutable source plus hash-linked v1 projection/result | Same source hash+migrator returns existing result | Source hash, migrator version, v1 hash, and consumer evidence |
| Historical source is corrupted/unsupported/ambiguous | `not_started` for live consumption | `SourceAssetCorrupted`, `ProjectionUnsupported`, `needs_human`, or stable classified result | Immutable source and explicit migration disposition | Never feed failed projection to live consumer; corrected/new source is a new attempt | Classified migration record and no live effect |
| Cancel/timeout before model/action/evidence dispatch | `not_started` | Existing stable cancellation/timeout | No new derived durable state | Retry from existing checkpoint under remaining budget/lease | Cancellation and zero dispatched effect |
| Cancel/timeout after model dispatch but before action/evidence write | `started` | Existing model timeout/error with known usage where available | Usage/checkpoint follows existing atomic rules; no fabricated consumer result | Existing bounded provider retry; no duplicate usage/action | Model invocation/usage and absent later effect |
| Action was dispatched and outcome cannot be established | `outcome_unknown` | Existing `ActionOutcomeUnknown`; no automatic retry | No post-action consumer checkpoint/finding claims known success | Never replay action automatically | Dispatch evidence and unknown terminal |
| Same Graph/checkpoint/attempt is replayed | `not_started` until next effect | Same fingerprint/decision/report input and idempotent store result | One authoritative record at existing idempotency key | Skip completed work or return existing result | Stable hash/fingerprint and no duplicate record |
| Same identity is replayed with changed Graph/source/evidence/profile hash | `not_started` | Stable conflict/source-changed/profile mismatch | Existing durable record remains authoritative | New source/profile uses a distinct attempt; never merge | Binding/hash comparison and unchanged record |
| Concurrent consumers process the same migration/attempt/checkpoint | `started` | One append/application wins; other is idempotent/conflict | No duplicate authoritative projection/checkpoint/attempt | Loser reloads authoritative result | Store race evidence and one result |
| Consumer process restarts after durable checkpoint/projection/attempt | `not_started` until resume | Resume from durable state | Acknowledged records remain authoritative | Skip completed state; continue only from safe checkpoint | Restart/resume evidence |
| Terminal persistence fails for checkpoint, projection, evidence decoration, or benchmark attempt | `started` | Stable store error; no success claim | Atomic rollback/no partial record at the owning seam | Retry exact known write only when safe; never rerun unknown action | Injected failure, rollback, and stopped workflow |

### review-fix — 2026-08-25

- Reviewed head fixed: `3895e54e70b6b1a00c90e3e638377681f701d3b7`; fixed point remains `f34e7547c8208dd85425f64992553d4b8d290afc`.
- Core findings addressed in scope: v1 exploration fingerprints previously hashed secret node value/state, and benchmark `inputSha256`/run identity previously hashed raw `ScenarioDefinition[]` including raw URL query values instead of the existing canonical/redacted `scenarioDefinitionBinding()`/v1 graph-hash path.
- Fix commit evidence: `6e04ac094f088cd27dfaad919ba88c40d24119db` (`fix(graph): redact v1 fingerprints and benchmark input binding`) updates the fingerprint projection, benchmark input binding, and focused regression tests.
- Gates run before fix commit: `CI=true corepack pnpm vitest run tests/unit/runner-components/model-agent.test.ts tests/unit/runner-components/exploration tests/unit/execution-application/artifact-recording-observer.test.ts tests/replay` passed (13 files / 96 tests); `CI=true corepack pnpm typecheck` passed; `git diff --check` passed.
- Remaining active blocker at this reviewed head: Skill replay migration still requires implementation. Maintainer authorization has now expanded this ticket's complete edit scope to `packages/runner-components/skill-replay/src/**` for active Skill replay consumer migration, with directly related `tests/unit/runner-components/skill-replay/**` and `tests/replay/procedure-skill/**` already covered by the existing test-root allowance. The expansion is limited to migrating active Skill replay to `ObservationGraphV1`; it does not authorize Runner Kernel/public Graph contract changes, Web producer changes, repository-wide legacy contraction, package manifests, migrations, or unrelated test roots.

### scope-decision — 2026-08-25

- Maintainer further authorized Ticket 24 to update `tests/helpers/skill-reverifier.ts`, `tests/helpers/windows-reference-app.ts`, and `tests/component/skill-lifecycle/recording-to-replay.test.ts` only as directly affected v1 replay/recompiler/reference-app/Skill lifecycle fixtures. This closes the strict-scope ambiguity raised during review of head `a07278b332b22722f7457c77d2c8886f126bfba0`; it does not authorize additional `tests/helpers/**`, unrelated component tests, package manifests, public Graph contracts, Web producers, migrations, or repository-wide legacy contraction.
- Remaining acceptance blocker after head `a07278b332b22722f7457c77d2c8886f126bfba0`: add the required post-review acceptance test file `tests/e2e/observation-v1/consumer-migration.test.ts` and update the stale Skill lifecycle component replay fixture to produce validated `ObservationGraphV1` before live replay.


### scope-decision implementation - 2026-08-25

- Maintainer scope decision applied at head `b6a20778da50f82a43faf9629fa59b4134ad61e0`; fixed point remains `f34e7547c8208dd85425f64992553d4b8d290afc`. Prior reviewed/fix heads remain `3895e54e70b6b1a00c90e3e638377681f701d3b7`, `6e04ac094f088cd27dfaad919ba88c40d24119db`, and `a30cfc4bad92db595a9f7bae976fe9c37334252f`.
- New in-scope fix commit: `2f49dcb7701d78e99e492ec0610e167b0081c784` (`fix(skill-replay): consume observation graph v1`). Active Skill replay now validates every captured payload as `ObservationGraphV1`, requires typed `web/v1` semantics for web/path replay, reads `claim_satisfied` through a typed `skill-replay/v1` extension, and rejects direct legacy `ReplayObservation` before execution.
- Gates run before the fix commit: `CI=true corepack pnpm vitest run tests/unit/runner-components/model-agent.test.ts tests/unit/runner-components/exploration tests/unit/execution-application/artifact-recording-observer.test.ts tests/replay` passed (13 files / 101 tests); `CI=true corepack pnpm typecheck` passed; `git diff --check` passed. Additional affected check `CI=true corepack pnpm vitest run tests/component/windows-uia/reference-app-pipeline.test.ts` passed (1 file / 10 tests passed, 1 skipped) after updating the shared replay test target to return v1.
- Remaining risks: no PR has been created or merged; post-review acceptance remains pending after a fresh complete-matrix review; deprecated `ReplayObservation` export remains only as a stale-caller compatibility type and is covered by runtime rejection.

### review2 acceptance fix — 2026-08-25

- Review2 head: `a07278b332b22722f7457c77d2c8886f126bfba0`; fixed point remains `f34e7547c8208dd85425f64992553d4b8d290afc`.
- Scope decision commit: `6b5db2f6d1e696a96f0dfb6ada1f606ee7e225c9` authorized only `tests/helpers/skill-reverifier.ts`, `tests/helpers/windows-reference-app.ts`, `tests/component/skill-lifecycle/recording-to-replay.test.ts`, and post-review acceptance `tests/e2e/observation-v1/consumer-migration.test.ts` as directly affected fixtures/acceptance.
- New fix commit: `0693d6f9781d558b3ee566189bbeee447c035752` (`test(graph): add consumer migration acceptance`). It adds the required consumer-migration acceptance file and updates the stale Skill lifecycle component fixture so replay captures project pre-v1 recording input through `PreV1TraceProjector` into validated `ObservationGraphV1` before `SkillReplayController` consumes them.
- Fix coverage: acceptance now exercises model and verifier prompt consumers, resolver-facing node decisions, artifact evidence decoration/provenance preservation, exploration fingerprint/result determinism over projected historical v1 input, benchmark redacted input binding determinism, active Skill replay over projected historical input, unsupported extension-major rejection, and direct legacy replay rejection before side effects.
- Gates run: `CI=true corepack pnpm vitest run tests/unit/runner-components/model-agent.test.ts tests/unit/runner-components/exploration tests/unit/execution-application/artifact-recording-observer.test.ts tests/replay` passed (13 files / 101 tests); `CI=true corepack pnpm vitest run tests/e2e/observation-v1/consumer-migration.test.ts` passed (1 file / 2 tests); `CI=true corepack pnpm vitest run tests/component/skill-lifecycle/recording-to-replay.test.ts` completed with 1 skipped file / 1 skipped test on Windows due the existing `it.skipIf(process.platform === "win32")` quarantine; `CI=true corepack pnpm typecheck` passed; `git diff --check` passed.
- Remaining risks: no PR has been created or merged; fresh complete-matrix review is still required; the Skill lifecycle component scenario remains skipped on Windows, so non-Windows execution is represented by typecheck and the migrated fixture source rather than local runtime execution on this host.

- [ ] All live consumers use v1 fields and typed extension readers.
- [ ] Artifact decorators use evidence references without losing provenance.
- [ ] Exploration fingerprints and benchmark state remain deterministic.
- [ ] Historical pre-v1 decoding remains isolated to migration paths.
