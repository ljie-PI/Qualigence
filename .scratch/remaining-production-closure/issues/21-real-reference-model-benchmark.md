# 21 — Run the real Reference Model benchmark

**What to build:** Execute Detection Benchmark v1 with the configured frozen Reference Model Profile and produce durable release-grade reports.

**Blocked by:** 20 — Restore exploration seed, checkpoint, and recovery budget.

**Status:** resolved

## Tracked scope

This ticket owns the Reference Model benchmark after ticket 20 supplies restart-safe exploration. It replaces the deterministic fixture walker as release evidence, runs every scenario/repetition through the configured frozen Reference Model Profile, and produces the hash-bound report consumed by release closure.

## Migration

- Replace `ScenarioWalkAgent` in the release path with the existing model-provider/agent contract seam configured by the manifest Reference Profile. A deterministic walker may remain only as an explicitly injected edit-time test double; it can never produce a verified Reference Profile report.
- Bind each attempt/report to manifest, actual profile/provider/model, prompt version, policy bundle, Skill pack, browser, fixture versions, scenario, repetition, Ground Truth, and attempt inputs by canonical hashes. Run every configured repetition; never select the best attempt.
- Resume the same hash-derived run from durable attempts/checkpoints supplied by ticket 20. Append missing attempts only, reject conflicting attempt bindings, and score only a complete matrix.
- Preserve BYO execution as `unverified`; only an exact frozen Reference Profile plus all five thresholds may produce `gate.status: "passed"`.
- The five frozen thresholds are exact: P0/security known-defect recall `1.0`; all-known-defect recall at least `0.8`; high-confidence Finding precision at least `0.6`; stable-defect reproduction at least `0.7`; and at most one high-confidence false positive per normal 30-minute Mission. A single P0 miss fails regardless of aggregate metrics.
- This ticket has no migration allocation and cannot edit SQLite provider source or migrations. It consumes the existing benchmark store contract; any required persistence/schema change must be completed by tracked predecessor ticket 20 or resolved by an explicit maintainer scope decision before this ticket starts.

## Affected context paths

`docs/contexts/execution/CONTEXT.md`; `docs/contexts/product/CONTEXT.md`; `docs/contexts/evidence/CONTEXT.md`; `docs/contexts/storage/CONTEXT.md`.

## Allowed Files

This is the complete edit scope. `**` means the named subtree only.

- `packages/benchmarking/detection/**`
- `apps/benchmark-runner/**`
- `benchmarks/detection-v1/**`
- `pnpm-lock.yaml`
- `tests/{unit/benchmarking/detection,contract/sqlite/benchmark-store.test.ts,e2e/detection-benchmark}`
- `.scratch/remaining-production-closure/issues/21-real-reference-model-benchmark.md`
- Post-review external LLM-provider acceptance is deferred to `46-centralized-llm-provider-acceptance.md` by explicit maintainer decision. The already allowed exact file remains `tests/e2e/detection-benchmark/reference-model-profile.test.ts`, but Ticket 21 closure records code/review readiness and does not require provider credentials in this ticket.

No root package/workspace script, model package, provider package, SQLite source, or unlisted benchmark fixture is in scope; stop and request an explicit maintainer scope decision before editing one.

## Authority

Resolve conflicts in this order: applicable security and public-contract invariants, architecture and context invariants, current domain/public interfaces and contract tests, then the umbrella spec and this ticket's migrated delta/scope.

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 10, 13.1, 14.2, and acceptance items 12 and 19. Official claims bind the Qualigence Reference Model Profile and exact thresholds; BYO/local/enterprise results remain unverified.
- Context authority: the ownership, seams, invariants, and verification surfaces in every path under **Affected context paths**.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` user stories 36, 37, 64, and 70; Implementation Decisions on exploration and Reference Model benchmark closure; Testing Decisions on real profile execution, durable restart, matrices, and closure review.
- Tracked predecessor authority: `.scratch/remaining-production-closure/issues/20-exploration-seed-checkpoint-budget.md` and its merged GitHub PR/check evidence establish the restart-safe exploration behavior inherited here.
- Current public contracts and tests: `packages/benchmarking/detection/src/{manifest,scorer,report}.ts` (`ReferenceModelProfile`, `DetectionBenchmarkManifest`, `BenchmarkAttempt`, `DetectionBenchmarkReport`); `apps/benchmark-runner/src/{run,scenario,loader,main}.ts`; `packages/storage-providers/sqlite-runtime/src/sqlite-benchmark-store.ts` (consume, do not edit); `packages/runner-components/exploration/src/exploration-controller.ts` (consume, do not edit); `packages/contracts/model-provider/src/index.ts` plus the configured model seam (consume, do not edit); and the focused benchmark/SQLite tests named here.
- Ticket-local and GitHub evidence: this ticket's `## Comments` and `## Answer`, merged predecessor and final ticket PRs, required checks, reviewed-head and merge-commit bindings, and any deferred advanced-hardening Issues in `ljie-PI/Qualigence` are the durable execution evidence.

## Execution protocol

- This ticket is the execution entrypoint for its allocated scope. Start only after every blocker is `resolved`, from the latest merged predecessor; record exact base SHA and planned matrix/Gates under `## Comments`, citing the predecessor's merged PR and merge commit as current execution-base evidence.
- Use Node.js 24 and `corepack pnpm --version` exactly `11.7.0`. In a fresh worktree run `corepack pnpm install --frozen-lockfile`; offline install is allowed only with a complete trusted store. Regenerate `pnpm-lock.yaml` only if this ticket actually adds an approved dependency.
- Begin with a failing focused test. During implementation/review fixes use only the non-E2E Gate below with the provider replaced at the existing contract seam, root typecheck, and diff check. No release result may come from that double.
- Preserve strict TypeScript and deterministic authority. Models produce proposals/results only; deterministic code validates hashes, budgets, IDs, attempt completeness, profile status, scoring, persistence, and threshold disposition. Do not weaken policy, evidence provenance, or public report contracts.
- Do not skip a required Gate. Provider/credential/network unavailability is an explicit stable failure/block, not evidence. Preserve unrelated changes and stop before editing outside **Allowed Files**.
- Record start, optional actual blocker, Gate results, and final evidence under `## Comments`, then summarize resolution under `## Answer`. Commit before each exact-head Standards and Spec `/code-review`; each round reviews the whole code/test diff and every matrix row and reports row-level `pass | finding | N/A`, N/A reasons, and reviewed head under `## Comments`.
- Critical always blocks. Important blocks only for explicit acceptance, applicable architecture/security, public/persisted contract, required Gate, or primary-workflow correctness/data integrity. Core fixes require affected non-E2E tests and a fresh complete-matrix review.
- Stop after five review rounds. If a core blocker remains, set this ticket to `needs-info`, record it here, stop dependents, and request a maintainer scope/ownership decision. Do not create recursive local remediation tickets.
- Non-Critical advanced hardening is deferred unless promoted. Create one GitHub Issue in `ljie-PI/Qualigence` with source ticket/PR or branch, fixed/reviewed heads, severity/risk, authority, affected files/Gates, and acceptance; do not implement it here or block this ticket on it.
- Run deterministic/focused acceptance after review is clean. External real model-backed acceptance is intentionally deferred to ticket 46 by explicit maintainer direction so provider credentials/network can be validated once across all LLM-provider-dependent surfaces. Any later code/test change requires focused verification and a fresh complete-matrix review.
- Create one non-draft PR only after focused Gate, typecheck, diff check, clean review, deferred-provider evidence, and final ticket evidence. A final ticket-evidence-only commit is allowed only with byte-identical reviewed code/test diff. For this ticket, the external provider Gate is tracked by ticket 46 rather than blocking PR merge.

## Focused non-E2E Gate

The model provider may be replaced only through the existing contract seam for these edit-time tests.

```text
corepack pnpm vitest run tests/unit/benchmarking/detection tests/contract/sqlite/benchmark-store.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

```text
corepack pnpm vitest run tests/e2e/detection-benchmark/reference-model-profile.test.ts
```

Deferred to `46-centralized-llm-provider-acceptance.md` by maintainer decision: run the configured frozen Reference Model Profile across every manifest scenario and repetition with real provider calls. No fixture walker, provider fake, omitted repetition, selected best run, or skip satisfies that deferred acceptance. Provider/network/credential absence is tracked there instead of blocking Ticket 21 closure.

## Comments

- start — Claimed for isolated implementation on branch `ticket-21-real-reference-model-benchmark` from base SHA `c55f377460033d9053085b5aface51b02ca12842` (current main with ticket 20 resolved via PR #99 merge commit `1995a946fc09b05425949cf53f2fe1f29a311731`, as supplied by the worktree). Matrix applicability: applicable; all rows in the Behavior Matrix below govern this stateful, side-effecting, retry/restart-sensitive release benchmark workflow. Planned focused Gates: `CI=true corepack pnpm vitest run tests/unit/benchmarking/detection tests/contract/sqlite/benchmark-store.test.ts`, `CI=true corepack pnpm typecheck`, and `git diff --check`. Post-review real Reference Model acceptance `CI=true corepack pnpm vitest run tests/e2e/detection-benchmark/reference-model-profile.test.ts` is required only after review is clean and real configured provider credentials/network are available.
- update — Maintainer explicitly changed closure authority for LLM-provider-backed acceptance: Ticket 21 may skip the external provider credential/network Gate, and all such validation is centralized in new Ticket 46. Search found current closure issue dependency on LLM provider env in Ticket 21 plus live smoke coverage in `tests/live/remote-model-smoke.test.ts`. Implementation/review remains code-complete; deterministic edit-time test-double reports remain forced to `profileStatus: unverified` / `gate.status: unverified`, and real Reference Model release evidence must be produced under Ticket 46 before final release claims. PR `https://github.com/ljie-PI/Qualigence/pull/101` merged as `219532953a4eb0601b8471a8e510508dbd2c8647`.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Exact frozen Reference Profile, valid hashes, complete fixtures/Ground Truth, all attempts meet thresholds | `started` at first provider/fixture execution | Exit 0 and `profileStatus: reference`, `gate.status: passed` | Hash-bound run, every append-only attempt/checkpoint, and one immutable report | Resume appends only missing attempts; scoring includes all attempts | Provider invocation evidence, complete attempt matrix, report hashes, and five metric numerators/denominators |
| BYO or any actual profile field/hash differs from the frozen profile | `started` only if caller intentionally runs BYO | Exit nonzero for release and `profileStatus/gate.status: unverified` | Attempts/report retain actual profile hash and unverified label | May rerun as a separate hash-derived run; never relabel existing results | Profile comparison and unverified report |
| Manifest, prompt/policy/Skill/fixture/Ground Truth hash or schema is invalid/mismatched | `not_started` | `BenchmarkManifestInvalid`, `GroundTruthMismatch`, or `ReferenceProfileMismatch` | No attempt or passed report | Retry only with corrected, versioned inputs; changed hashes identify a new run | Validation failure proves provider/fixture were not executed |
| Provider credentials, policy authority, required model capability, or fixture capability is rejected | `not_started` for fixture/action effects; provider authentication may have `started` | Stable provider/auth/policy/capability error; no fixture-walker fallback and no passed report | Failed attempt/checkpoint is recorded only when safely bound; no fabricated findings | Retry only with valid configured authority/capability and remaining budget | Rejection evidence and zero unauthorized fixture action |
| Scenario/repetition matrix is incomplete, duplicated, or mode/binding conflicts | `not_started` for scoring; an attempt may already have `started` | `BenchmarkAttemptMatrixIncomplete` or stable binding conflict; no passed report | Valid prior attempts remain append-only; report absent/failed | Resume missing exact slots; never overwrite/select attempts | Matrix inventory and conflicting slot/hash evidence |
| Provider unavailable/rejected or model usage unavailable before an action | `started` for provider, `not_started` for Target action | Stable provider error or `ModelUsageUnavailable`; release Gate fails | Attempt/checkpoint records terminal failure when safely persistable; no fabricated findings | Bounded provider retry only under existing policy/budget; no fixture walker fallback | Real provider request/error, usage evidence, and failed attempt |
| Cancel/timeout before provider dispatch | `not_started` | Stable cancellation/timeout | Existing run/attempts unchanged | Restart resumes missing slot | Cancellation evidence and zero provider call |
| Cancel/timeout after provider dispatch with known failure and no Target action | `started` | Stable model timeout/error | Known usage/failure checkpoint is persisted | Existing bounded provider policy applies; do not double-count usage | Invocation, usage/failure, and no action dispatch |
| Crash/timeout after model or Target action dispatch without authoritative outcome | `outcome_unknown` | Stable unknown-outcome/error; no scoreable successful attempt | No successful attempt is appended for the uncertain slot | Never automatically replay an unknown side effect; require explicit disposition/new attempt | Dispatch evidence, missing acknowledgement, and blocked slot |
| Restart finds a matching durable attempt/checkpoint for the same run/scenario/repetition/profile | `not_started` until continuation | Existing attempt is reused or resumed | Existing append-only attempt/checkpoint remains authoritative | Idempotent resume skips completed slots and resumes safe checkpoints | No duplicate provider/action execution for completed slot |
| Same run/attempt ID is presented with different profile, scenario, repetition, inputs, or findings | `not_started` | Stable conflict / `ReferenceProfileMismatch` | Original record remains unchanged | Never merge or overwrite; corrected changed inputs use a distinct hash-derived run/attempt | Binding comparison and unchanged original row |
| Concurrent runners claim the same missing slot | `started` | One append wins; loser gets idempotent/conflict result and cannot create a second scored slot | Exactly one authoritative attempt per slot | Loser reloads store and proceeds only to another missing slot | Store race evidence and complete unique matrix |
| Attempt persistence fails after a known execution | `started` | Stable storage error; scoring stops | Transaction leaves no partial attempt/checkpoint | Retry persistence only when the same known result is safely bound; do not rerun blindly | Execution result plus rollback/failure evidence |
| Report persistence fails after complete scoring | `started` | Exit nonzero/storage error; release is not passed | Complete attempts remain; no falsely durable release report | Deterministically recompute from the same immutable attempts and retry report write | Complete matrix, report hash, failed write, and no success claim |
| Exact Reference Profile completes but one or more frozen thresholds fail | `started` | Exit nonzero, `profileStatus: reference`, `gate.status: failed`, exact failure codes | Immutable failed report and all attempts persist | Rerun only as a complete new authorized run; never drop bad attempts | All five metrics and threshold failure codes |

- [ ] Benchmark attempts actually call the configured model/provider profile.
- [ ] Profile, prompt, Skill, fixture, attempt, and Ground Truth hashes bind the report.
- [ ] Crash/restart resumes attempts from durable checkpoints.
- [ ] Only verified Reference Profile reports can pass release thresholds.

## Answer

Implemented the real Reference Model benchmark code path and closed Ticket 21 code/spec acceptance with external LLM-provider acceptance deferred to `46-centralized-llm-provider-acceptance.md` by maintainer decision. The release path now requires an explicit model-provider agent factory, forces deterministic ScenarioWalkAgent test-double runs to unverified provenance, prevalidates manifest/Ground Truth before provider or fixture effects, binds attempts/reports to canonical hashes, persists invocation evidence when a real provider is configured, resumes missing durable attempts, rejects conflicting/incomplete matrices, and enforces the frozen thresholds including P0 recall.

Reviewed code head: `c6091d5cad8202342469b0d2f8d13df70149cf41`.

Pull request: `https://github.com/ljie-PI/Qualigence/pull/101`

Merge commit: `219532953a4eb0601b8471a8e510508dbd2c8647`

Deferred external-provider validation: `46-centralized-llm-provider-acceptance.md`.
