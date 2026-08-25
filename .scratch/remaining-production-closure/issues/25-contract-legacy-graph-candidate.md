# 25 — Contract legacy Graph and close candidate Gate

**What to build:** Remove legacy Graph use from live code, classify all historical hits, and prove Graph v1 is the sole live `candidate` contract.

**Blocked by:** 24 — Migrate live Graph consumers to v1.

**Status:** resolved

## Tracked scope

This ticket owns the contract phase and candidate migration Gate after tickets 22-24: it removes legacy Graph from live code, confines pre-v1 handling to explicit migration/decoder code and fixtures, inventories/classifies every active pre-v1 Trace/Skill, and closes candidate-only acceptance. It cannot freeze Graph v1; ticket 35 exclusively owns the serialized-evidence freeze decision.

## Migration

- Run the repository inventory and remove legacy `ObservationGraph` imports/declarations from live app/package/test paths in scope. Every remaining hit must be an explicit pre-v1 decoder/projector, immutable historical fixture, migration test, or documented false positive.
- Inventory active pre-v1 Trace and Skill assets. Verify source hashes and append immutable results classifying each as `migrated`, `deprecated`, or `needs_human`; no unexplained `failed` and no in-place historical rewrite.
- Recompile/reverify migratable Skills through existing compiler/verifier seams; preserve source event IDs/hash/compiler/migrator versions and standard promotion rules.
- Prove Web and existing Windows replay conform to the same candidate v1 schema and extension rules. Keep status/checklist exactly `candidate`; native/manual/release evidence is not yet complete.
- This ticket has no migration allocation. Use existing observation-migration stores/report paths; a required schema change is outside scope and requires an explicit maintainer scope decision before implementation.

## Affected context paths

`docs/contexts/execution/CONTEXT.md`; `docs/contexts/product/CONTEXT.md`; `docs/contexts/evidence/CONTEXT.md`; `docs/contexts/storage/CONTEXT.md`.

## Allowed Files

This is the complete edit scope.

- `packages/{runner-kernel,runner-components/model-agent,runner-components/exploration,execution-application,target-adapters/web-playwright,observation-migration}/**`
- `apps/{runner,benchmark-runner}/src`
- `tests/{conformance/observation,property,migration/observation-v1,replay}`
- `docs/testing/observation-graph-v1-freeze-checklist.md`
- `.scratch/remaining-production-closure/issues/25-contract-legacy-graph-candidate.md`
- Post-review acceptance only: `tests/e2e/observation-v1/candidate-acceptance.test.ts`

The recursive package roots are limited to the named packages. No Graph/Runner Protocol contract, app outside the two listed source roots, migration schema, other authority document, release artifact, or other checklist is allowed.

## Authority

Resolve conflicts in this order: security/public contracts, architecture and context invariants, current interfaces/contracts/tests, then the umbrella spec and this ticket's migration/contraction scope.

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.2-6.3, 9.2, 10, 13, 14.3, and acceptance item 17. Historical events remain immutable; Skills are recompiled/replayed; candidate cannot freeze before native Desktop and complete migration evidence.
- Context authority: all ownership, seams, invariants, and verification surfaces in **Affected context paths**.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` user stories 38, 40-42, and 68; Implementation Decisions on canonicalization and candidate-only status; Testing Decisions on full legacy inventory, migration outcomes, replay, matrices, and serialized freeze ownership.
- Tracked predecessor authority: `.scratch/remaining-production-closure/issues/22-expand-graph-v1-web-extension.md`, `.scratch/remaining-production-closure/issues/23-migrate-live-web-producers-v1.md`, and `.scratch/remaining-production-closure/issues/24-migrate-live-graph-consumers.md`, together with their merged GitHub PR/check evidence, establish the expanded and migrated Graph behavior contracted here.
- Current public contracts and tests: `packages/contracts/observation/src/*` (consume, do not edit); `packages/observation-migration/src/{pre-v1-projector,migration-runner,skill-recompiler,freeze-report}.ts`; existing Skill compiler/verifier contracts consumed by the recompiler; live `Observer`/consumer interfaces migrated in tickets 23-24; the conformance/property/migration/replay tests named here; and `docs/testing/observation-graph-v1-freeze-checklist.md` as candidate evidence, not freeze authority.
- Ticket-local and GitHub evidence: this ticket's `## Comments` and `## Answer`, merged predecessor and final ticket PRs, required checks, reviewed-head and merge-commit bindings, and any deferred advanced-hardening Issues in `ljie-PI/Qualigence` are the durable execution evidence.

## Execution protocol

- Start after ticket 24 resolves from the latest merged predecessor. Record exact base SHA, matrix pointer, planned Gate, and exact inventory command under `## Comments`, citing the predecessor's merged PR and merge commit as current execution-base evidence.
- Use Node.js 24 and Corepack pnpm exactly `11.7.0`; frozen install in a fresh worktree. Do not change dependencies/lockfile unless an already-listed package manifest must remove now-unused legacy dependencies without adding a package.
- Begin with failing inventory/migration/replay tests. During implementation/review fixes run only the focused Gate and inventory command, root typecheck, and diff check. Preserve source immutability, stable disposition/error semantics, v1 canonical hashes, standard Skill verification, and candidate status.
- `rg` exit 1 from no legacy hits is success only if the inventory logic explicitly treats it so; every returned hit must be classified. No required Gate or acceptance may skip.
- Record start, optional actual blocker, review rounds, Gate/inventory/acceptance results, and final PR evidence under `## Comments`; summarize resolution under `## Answer`. Commit before exact-head Standards/Spec review. Every round covers whole code/test diff and every matrix row, reports `pass | finding | N/A` with reasons and reviewed head, and is recorded under `## Comments`.
- Critical always blocks. Important blocks only for explicit acceptance, applicable architecture/security, public/persisted contract, required Gate, or primary correctness/data integrity. Fix core findings, rerun affected non-E2E Gates/inventory, and perform fresh complete-matrix review.
- Stop after five rounds. A remaining core blocker sets this ticket `needs-info`, blocks dependents, and requests maintainer scope/ownership. Do not create recursive local remediation tickets.
- Non-Critical advanced hardening is deferred to one GitHub Issue in `ljie-PI/Qualigence` with source ticket/branch/PR, fixed/reviewed heads, severity/risk, authority, affected files/Gates, and acceptance. Do not implement or add it as a dependency unless promoted.
- Run candidate acceptance only after clean review. Any later code/test change requires focused Gate/inventory, fresh complete-matrix review, then acceptance again.
- Create one non-draft PR only after all required evidence is clean. A final ticket-evidence-only commit may follow reviewed code only if code/test diff remains byte-identical. Keep `claimed` through merge; then record PR/SHA under `## Answer`, resolve, and remove branch/worktree.

## Focused non-E2E Gate

```text
corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts tests/migration/observation-v1 tests/replay
rg -l "\bObservationGraph\b" apps packages tests
corepack pnpm typecheck
git diff --check
```

Every `rg` result must be classified in review/ticket evidence as an allowed historical decoder/fixture/migration test or a finding. No live legacy hit is allowed.

## Post-review acceptance

```text
corepack pnpm vitest run tests/e2e/observation-v1/candidate-acceptance.test.ts
```

Run the complete active pre-v1 inventory/migration classification and candidate-only acceptance over Web and existing Windows replay. The report must have no unexplained failure and every active asset must be migrated, deprecated, or needs-human with source/output hashes. The checklist and status must remain `candidate`; any `frozen` result fails this ticket.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Complete inventory of valid migratable active pre-v1 assets | `started` at append of projection/new Skill/result, never source mutation | `migrated` for each asset and candidate report succeeds | Immutable source plus hash/version-linked projection/Skill/result | Same source hash+migrator/compiler returns existing result | Inventory count, source/output hashes, replay verification, candidate report |
| Readable but unsupported asset or ambiguous Skill locator | `not_started` for live use; `started` only to append disposition | `deprecated` or `needs_human` with stable reason | Immutable source and explicit result | Idempotent replay returns disposition; new source/version is a new attempt | Disposition reason and no active legacy execution |
| Corrupt source/hash mismatch or unexplained migration failure | `not_started` for projection/live use | `SourceAssetCorrupted`, `MigrationSourceChanged`, or `failed`; candidate acceptance fails | Source remains unchanged; explicit failed attempt may append | Do not retry as same valid source or hide failure; correct source/new attempt required | Failed asset identity/hash/reason and blocking report |
| Live code/import still references legacy Graph | `not_started` | Inventory finding; focused Gate/acceptance fails | No status promotion | Migrate code in this ticket if in scope; otherwise stop for scope decision | `rg` path classification and failing inventory |
| Remaining legacy hit is an explicit decoder/projector, immutable fixture, or migration test | `not_started` | Allowed classified hit | N/A for scan; historical bytes remain immutable | Keep isolated; no live import path | Path, rationale, and dependency review |
| Web or Windows replay emits invalid/incompatible v1 | `not_started` for candidate acceptance | Stable schema/extension/capability error | No passing candidate report | Fix producer/projection and rerun entire affected replay | Conformance/replay failure and candidate status |
| Unauthorized/policy-invalid asset is requested for migration/promotion | `not_started` | Existing auth/policy/Skill promotion rejection | No projection promotion or active Skill mutation | Retry only with valid authority; never bypass signature/evaluation | Rejection and unchanged Skill/source state |
| Cancel/timeout before an asset append | `not_started` | Stable cancel/timeout | Prior completed asset results remain; current asset absent | Resume inventory at current/next durable cursor | Cursor and no partial current record |
| Cancel/timeout after projection/recompile work but before atomic append | `started` | Stable cancel/timeout; no success claim for current asset | No partial current record | Recompute from immutable source or retry exact append where safely bound | Work result/hash plus absent durable result |
| Unknown external side-effect outcome | `not_started` | N/A: migration writes append-only local projection/result and executes replay only through existing controlled fixtures; no external action is authorized by this ticket | N/A | Existing replay unknown-outcome semantics remain authoritative | N/A reason recorded in review |
| Same asset/source/migrator is replayed | `not_started` until lookup | Existing result is returned | One immutable result | Idempotent; no duplicate projection/version | Same result/hash and one record |
| Same asset identity arrives with changed source hash/compiler/migrator | `not_started` | Existing result is not overwritten; new attempt/version required or stable conflict | Old and new attempts remain attributable | Never merge; classify the new source independently | Distinct hashes/versions and preserved old result |
| Concurrent migration workers process the same asset/source | `started` | One append wins; other returns existing/conflict | One authoritative result per exact binding | Loser reloads and continues | Store race evidence and no duplicate output |
| Process restarts mid-inventory | `not_started` until resume | Resume from durable per-asset results/cursor | Prior results remain authoritative | Skip completed exact bindings; process remaining inventory | Restart evidence and complete counts |
| Result/report persistence fails | `started` | Stable storage/report error; candidate acceptance fails | Per-asset atomicity prevents partial record; prior results remain | Retry exact known write/rebuild report; never claim candidate Gate without durable report | Injected failure/rollback and no passed report |
| Caller attempts to mark Graph `frozen` | `not_started` | Explicit rejection/failing assertion; status remains `candidate` | Candidate checklist/status only | Freeze is deferred to ticket 35 serialized evidence | Candidate-only status/checklist evidence |

## Comments

### start — 2026-08-25

- Fixed base: `6e8e4bdad38b934ab9f414305bb4c944a8942fd8` (`main`/worktree base supplied for `ticket-25-contract-legacy-graph-candidate`, includes merged Ticket 24 PR #107).
- Predecessor merge evidence: Ticket 22 is `resolved` with PR #90 merge commit `7ef31db708612ddc5c020e6e2bb2758d763fba85`; Ticket 23 is `resolved` with PR #97 merge commit `b7d08755b0223ec89e35b30a2ac795064a514951`; Ticket 24 is `resolved` with PR #107 and reviewed code head `178c5165b3464187ebe2fa77e9d0327c12ea127d`, present in current base per worktree assignment.
- Behavior Matrix applicability: applicable; every row in this ticket's frozen matrix governs live legacy contraction, append-only historical inventory/classification, migration/recompile verification, replay/schema checks, and candidate-only status. No rows are marked N/A for implementation planning.
- Planned focused non-E2E Gate: `CI=true corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts tests/migration/observation-v1 tests/replay`, then `rg -l "\\bObservationGraph\\b" apps packages tests`, then `CI=true corepack pnpm typecheck`, then `git diff --check`.
- Exact inventory command: `rg -l "\\bObservationGraph\\b" apps packages tests`; every returned path must be classified as an allowed historical decoder/projector, immutable fixture, migration/replay test, or finding.

### worker implementation evidence — 2026-08-25

- Implemented active pre-v1 candidate inventory in `@qualigence/observation-migration`: Trace assets still project through the explicit pre-v1 projector, and active Skill assets now recompile/reverify through the standard Skill verifier before appending a hash/version-bound migration result.
- Inventory/classification evidence from `rg -l "\\bObservationGraph\\b" apps packages tests`:
  - `packages/observation-migration/src/pre-v1-projector.ts` — explicit pre-v1 decoder/projector allowed by Ticket 25.
  - `packages/contracts/runner-protocol/src/index.ts` — hard-excluded legacy Runner Protocol contract declaration retained for pre-v1 migration/test fixture typing; no live producer or consumer imports it.
  - `tests/migration/observation-v1/candidate-inventory.test.ts` — Ticket 25 inventory test that executes and classifies the required scan.
  - `tests/component/skill-lifecycle/recording-to-replay.test.ts` — immutable historical pre-v1 Skill lifecycle fixture that projects through `PreV1TraceProjector` before live replay.
  - `tests/e2e/observation-v1/consumer-migration.test.ts` — post-review consumer-migration acceptance historical fixture that projects through `PreV1TraceProjector` before live consumers.
- Active pre-v1 fixture inventory evidence: `candidate-inventory.test.ts` classifies `m1-web-observation.json` and `m2-procedure-skill.json` as `migrated`, records 64-character source/output hashes, preserves `sourceTraceRefs`, `locatorSchemaVersion`, `skillCompilerVersion`, and keeps the report `status: "candidate"` / `gate.frozen: false`.
- Guard evidence: observation migration hash mismatch records `SourceAssetCorrupted`; Skill source mismatch records `MigrationSourceChanged`; idempotency keys include migrator/compiler version so changed versions do not overwrite prior immutable results.
- Worker Gates passed: `CI=true corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts tests/migration/observation-v1 tests/replay` (19 files / 113 tests), `rg -l "\\bObservationGraph\\b" apps packages tests`, `CI=true corepack pnpm typecheck`, and `git diff --check`.
- Post-review acceptance intentionally not run by this worker per assignment; complete-matrix review remains pending. Status remains `claimed` until PR merge.

### review2-fix — 2026-08-25

- Review2 head fixed: `1e563517a00fb02e3702fb26451750ff83822439`; fixed point remains `6e8e4bdad38b934ab9f414305bb4c944a8942fd8`.
- Fix commit: `51326ec73666dedd2ee1262df5fff388137d85b9` (`fix(observation): close ticket 25 review2 blockers`). No PR was created or merged.
- Findings fixed:
  - Stale declared source hashes no longer hide changed/corrupt Observation sources. `ObservationMigrationRunner` computes the actual source payload hash first, classifies hash mismatches as `failed` / `SourceAssetCorrupted`, records the declared hash separately as `expectedSourceHash`, and does not return prior migrated results for source-integrity failures.
  - Stale declared source hashes and stale Skill content hashes no longer hide changed/corrupt Skill inventory sources. `ObservationCandidateInventoryRunner` verifies the source Trace hash and the pre-v1 Skill content hash before durable lookup; source Trace mismatches return `SourceAssetCorrupted`, Skill content drift returns `MigrationSourceChanged`, and unchanged Skill results remain keyed by source Trace hash plus observation migrator and Skill compiler versions.
  - File-backed ledger append now recovers stale `.lock` files left by crashed processes by replacing locks owned by dead PIDs while preserving live concurrent duplicate protection through the per-ledger serializer, process lock, reload-under-lock, and same-key append check.
  - The package-level `ObservationMigrationRunner` no longer reports `kind: "skill"` assets as graph-only migrated. Direct Skill inputs are classified as `needs_human` with `SkillInventoryRunnerRequired`, so Skill assets must use `ObservationCandidateInventoryRunner`/`SkillRecompiler` to produce migrated Skill evidence. No `apps/admin-cli/**` path was edited.
- Inventory command/classification from `rg -l "\\bObservationGraph\\b" apps packages tests`:
  - `packages/contracts/runner-protocol/src/index.ts` — hard-excluded legacy public contract declaration retained for pre-v1 migration/test fixture typing; no live producer or consumer imports it.
  - `packages/observation-migration/src/pre-v1-projector.ts` — explicit pre-v1 decoder/projector allowed by Ticket 25.
  - `tests/component/skill-lifecycle/recording-to-replay.test.ts` — immutable historical pre-v1 Skill lifecycle fixture that projects through `PreV1TraceProjector` before live replay.
  - `tests/e2e/observation-v1/consumer-migration.test.ts` — post-review consumer-migration acceptance historical fixture that projects through `PreV1TraceProjector` before live consumers.
  - `tests/migration/observation-v1/candidate-inventory.test.ts` — Ticket 25 inventory test that executes and classifies the required repository scan.
- Gates/E2E run after review2 fixes:
  - `CI=true corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts tests/migration/observation-v1 tests/replay` — passed (19 files / 121 tests).
  - `rg -l "\\bObservationGraph\\b" apps packages tests` — passed with the five classified hits above.
  - `CI=true corepack pnpm vitest run tests/e2e/observation-v1/candidate-acceptance.test.ts` — passed (1 file / 3 tests).
  - `CI=true corepack pnpm typecheck` — passed (root build, test-project no-emit typecheck, and web-console typecheck).
  - `git diff --check` — passed.

- [x] Repository scan leaves legacy types only in explicit migration/decoder code.
- [x] Active pre-v1 Trace/Skill inventory is migrated, deprecated, or needs-human with hashes.
- [x] Web and existing Windows replay pass the same v1 schema.
- [x] Status/checklists state `candidate`; no freeze claim is made.

### review-fix — 2026-08-25

- Reviewed head fixed: `6a20ea9821929fe8b48aecb6318ea18d6019324f`; fixed point remains `6e8e4bdad38b934ab9f414305bb4c944a8942fd8`.
- Fix commit: `c74e7b5` (`fix(observation): harden candidate inventory replay`). No PR was created or merged.
- Findings fixed:
  - Added required post-review acceptance target `tests/e2e/observation-v1/candidate-acceptance.test.ts`. It runs active pre-v1 Trace/Skill candidate inventory, asserts every active asset is classified as `migrated`/`deprecated`/`needs_human` with 64-character source/output hashes, exercises Web projection and existing Windows UIA replay projection/resolution on the v1 candidate schema, and rejects any generated `frozen` status.
  - Skill inventory now verifies/projects the Skill asset's pre-v1 source Trace payload before reporting a Skill result. The durable lookup/result binding uses the verified source Trace hash plus `observation-migrator/v1+<skill compiler version>`, and results also carry the prior Skill content hash as `skillSourceHash` for Skill provenance.
  - Repeated Skill inventory for the same source Trace hash/compiler/migrator now performs the durable store lookup before calling the Skill recompiler/reverifier; regression coverage spies the reverifier and makes a second call throw if lookup is bypassed.
  - `FileObservationMigrationStore.append` now serializes per ledger path, reloads while holding the append boundary, and uses a file lock around check+append so concurrent same-binding calls produce one authoritative stored result and one JSONL record.
- Inventory command/classification: `rg -l "\\bObservationGraph\\b" apps packages tests` returned:
  - `packages/contracts/runner-protocol/src/index.ts` — hard-excluded legacy public contract declaration retained for pre-v1 migration/test fixture typing; no live producer or consumer imports it.
  - `packages/observation-migration/src/pre-v1-projector.ts` — explicit pre-v1 decoder/projector allowed by Ticket 25.
  - `tests/component/skill-lifecycle/recording-to-replay.test.ts` — immutable historical pre-v1 Skill lifecycle fixture that projects through `PreV1TraceProjector` before live replay.
  - `tests/e2e/observation-v1/consumer-migration.test.ts` — post-review consumer-migration acceptance historical fixture that projects through `PreV1TraceProjector` before live consumers.
  - `tests/migration/observation-v1/candidate-inventory.test.ts` — Ticket 25 inventory test that executes and classifies the required repository scan.
- Gates run:
  - `CI=true corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts tests/migration/observation-v1 tests/replay` — passed (19 files / 117 tests).
  - `rg -l "\\bObservationGraph\\b" apps packages tests` — passed with the five classified hits above.
  - `CI=true corepack pnpm vitest run tests/e2e/observation-v1/candidate-acceptance.test.ts` — passed (1 file / 3 tests).
  - `CI=true corepack pnpm typecheck` — passed.
  - `git diff --check` — passed.
- Candidate-only status: report generation and the checklist remain `candidate`; `gate.frozen` remains `false`. No release freeze claim or PR evidence was added.

### review3-fix — 2026-08-25

- Review3 head fixed: `725a7c026d3ed2ef25de73eaaf227ccf657e3f9f`; fixed point remains `6e8e4bdad38b934ab9f414305bb4c944a8942fd8`.
- Fix commit: `b65d9eb88201a470d9342c2ca72677be68c984a0` (`fix(observation): key skill inventory ledger identity`). No PR was created or merged.
- Finding fixed: Skill inventory ledger identity now includes the immutable pre-v1 Skill content hash and Skill version for Skill inventory results, while observation Trace results continue to use the existing `(assetId, sourceHash, migratorVersion)` key. Changed `previous.contentSha256` after a prior migrated Skill success now returns and durably appends a `failed` / `MigrationSourceChanged` result instead of colliding with the earlier migrated ledger row; exact replay still returns the existing row before reverifier side effects.
- Inventory command/classification from `rg -l "\\bObservationGraph\\b" apps packages tests`:
  - `packages/contracts/runner-protocol/src/index.ts` — hard-excluded legacy public contract declaration retained for pre-v1 migration/test fixture typing; no live producer or consumer imports it.
  - `packages/observation-migration/src/pre-v1-projector.ts` — explicit pre-v1 decoder/projector allowed by Ticket 25.
  - `tests/component/skill-lifecycle/recording-to-replay.test.ts` — immutable historical pre-v1 Skill lifecycle fixture that projects through `PreV1TraceProjector` before live replay.
  - `tests/e2e/observation-v1/consumer-migration.test.ts` — post-review consumer-migration acceptance historical fixture that projects through `PreV1TraceProjector` before live consumers.
  - `tests/migration/observation-v1/candidate-inventory.test.ts` — Ticket 25 inventory test that executes and classifies the required legacy-type repository scan.
- Gates/E2E run after review3 fix:
  - `CI=true corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts tests/migration/observation-v1 tests/replay` — passed (19 files / 122 tests).
  - `rg -l "\\bObservationGraph\\b" apps packages tests` — passed with the five classified hits above.
  - `CI=true corepack pnpm vitest run tests/e2e/observation-v1/candidate-acceptance.test.ts` — passed (1 file / 3 tests).
  - `CI=true corepack pnpm typecheck` — passed (root build, test-project no-emit typecheck, and web-console typecheck/build).
  - `git diff --check` — passed.
- Candidate-only status remains unchanged; no resolved status, PR evidence, storage migration, package manifest, lockfile, Graph/Runner Protocol contract, `apps/admin-cli`, or unrelated path was edited.

### review4-fix — 2026-08-25

- Review4 head fixed: `b93a02bfdc440f3a5634d10ee87f1b121a03fa27`; fixed point remains `6e8e4bdad38b934ab9f414305bb4c944a8942fd8`.
- Fix commit: `2406c09b226fb4beb5ffdbadd47bdccfd4ecb265` (`fix(observation): distinguish stale skill content drift`). No PR was created or merged.
- Finding fixed: Skill inventory ledger identity now records and keys on a `skillAssetHash` computed from the actual current Skill inventory source (`recording`, `proposal`, and `previous`) in addition to the source Trace hash, migrator/compiler version, declared Skill content hash, and Skill version. A changed recording/proposal with unchanged source Trace hash and stale `previous.contentSha256` now appends a second durable `failed` / `MigrationSourceChanged` row instead of colliding with the prior migrated row. Exact replay of the unchanged identity returns the stored result before reverification; Observation Trace keys remain unchanged.
- Regression coverage added in `tests/migration/observation-v1/candidate-inventory.test.ts`: prior migrated Skill result + changed recording with stale `previous.contentSha256` and unchanged source Trace hash appends a second failed ledger row, replay of that drift returns the same failed result without a third append, changed Skill content/version identities remain distinct, and the required legacy inventory command still returns the same five classified hits.
- Inventory command/classification from `rg -l "\\bObservationGraph\\b" apps packages tests | sort`:
  - `packages\contracts\runner-protocol\src\index.ts` — hard-excluded legacy public contract declaration retained for pre-v1 migration/test fixture typing; no live producer or consumer imports it.
  - `packages\observation-migration\src\pre-v1-projector.ts` — explicit pre-v1 decoder/projector allowed by Ticket 25.
  - `tests\component\skill-lifecycle\recording-to-replay.test.ts` — immutable historical pre-v1 Skill lifecycle fixture that projects through `PreV1TraceProjector` before live replay.
  - `tests\e2e\observation-v1\consumer-migration.test.ts` — post-review consumer-migration acceptance historical fixture that projects through `PreV1TraceProjector` before live consumers.
  - `tests\migration\observation-v1\candidate-inventory.test.ts` — Ticket 25 inventory test that executes and classifies the required legacy-type repository scan.
- Gates/E2E run after review4 fix:
  - `CI=true corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts tests/migration/observation-v1 tests/replay` — passed (19 files / 123 tests).
  - `rg -l "\\bObservationGraph\\b" apps packages tests | sort` — passed with the five classified hits above.
  - `CI=true corepack pnpm vitest run tests/e2e/observation-v1/candidate-acceptance.test.ts` — passed (1 file / 3 tests).
  - `CI=true corepack pnpm typecheck` — passed (root build, test-project no-emit typecheck, and web-console typecheck/build).
  - `git diff --check` — passed.
- Candidate-only status remains unchanged; no resolved status, PR evidence, storage migration, package manifest, lockfile, Graph/Runner Protocol contract, `apps/admin-cli`, or unrelated path was edited.
