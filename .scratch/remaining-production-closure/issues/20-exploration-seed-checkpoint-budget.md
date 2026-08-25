# 20 — Restore exploration seed, checkpoint, and recovery budget

**What to build:** Make exploration replay its seed Skill, checkpoint after safe progress, resume after crash, and enforce state/recovery/model budgets.

**Blocked by:** 19 — Complete bounded multi-step Web Runtime; 06 — Deliver Skill version management loop schema migration `010`.

**Status:** resolved

## Tracked scope

This ticket owns the remaining deterministic Exploration Controller, Verified Skill seed replay, safe-checkpoint persistence/resume, state-visit/recovery limits, and model-usage terminal semantics. It follows ticket 19's completed bounded Runtime work; ticket 21 separately owns the Reference Model benchmark.

## Migration

- Replace the controller's fixed one-visit cap with `ExplorationPolicy.maximumStateVisits`, execute every configured Verified seed Skill before novel exploration, and consume `maximumRecoveries` only for deterministic environment recovery.
- Persist each last-safe `ExplorationCheckpoint` and its budget snapshot atomically through the current SQLite benchmark store boundary. Resume the same attempt from that checkpoint after process restart; do not repeat an acknowledged action or infer success for an unknown action outcome.
- Use the established model-usage seam and actual usage. Missing usage under a finite budget is `ModelUsageUnavailable`, not zero; exhaustion stops before another model call or action.
- This ticket owns one additive exploration progress migration, allocated after ticket 06's Skill lifecycle migration. Migrations 001-010 are immutable once 06 merges; do not edit historical migration files. Use `011-exploration-attempt-progress` at the implementation base. If another merged ticket has already claimed `011`, stop and update this ticket's allocation before coding.
- Keep `exploration_checkpoints` as append-only safe checkpoint history, but do not rely on the terminal `benchmark_attempts` append path for live resume state. Add a dedicated live-attempt progress table that can be written before the terminal benchmark attempt exists and that records the current side-effect boundary.
- Required live progress shape: `exploration_attempt_progress` with primary key `attempt_id`; `run_id`; stable source/policy/seed binding hashes; `phase` (`seed_replay`, `exploring`, `action_in_flight`, or `terminal`); `seed_cursor_json`; `last_safe_step`; nullable `last_safe_graph_fingerprint`; complete remaining-budget `remaining_json`; nullable `in_flight_action_json`; nullable `terminal_reason`; integer `version` for CAS; `created_at`; and `updated_at`.
- Persist seed replay progress and each last-safe checkpoint through the SQLite benchmark store boundary in an immediate transaction. Before dispatching an action to the Target, atomically CAS the progress row to `action_in_flight` with the action digest/payload required for terminal evidence. Only after the action outcome is known safe may the controller advance `last_safe_step`, clear `in_flight_action_json`, append the checkpoint history row, and update the remaining budget.
- On restart, load the progress row by `attempt_id` and verify the run/source/policy/seed bindings before continuing. If bindings conflict, reject without mutation. If the phase is `action_in_flight`, terminate with `ActionOutcomeUnknown`/`error` and never automatically replay that action. If the phase is `seed_replay` or `exploring`, resume from the recorded seed cursor, last-safe graph fingerprint, and remaining-budget snapshot without repeating acknowledged seed or action work.
- Preserve pre-v1 observation compatibility until tickets 22-25 migrate and contract the live Graph. Do not pull the Reference Model runner or Graph v1 migration into this ticket.

## Affected context paths

`docs/contexts/execution/CONTEXT.md`; `docs/contexts/product/CONTEXT.md`; `docs/contexts/storage/CONTEXT.md`.

## Allowed Files

This is the complete edit scope. Brace notation expands only the literal listed paths; no package manifest, unallocated migration, model-provider, Skill replay, or Graph contract file is implied.

- `packages/{runner-components/exploration,core-modules/mission,storage-providers/sqlite-runtime}/src`
- `packages/storage-providers/relational-kysely/src/migrations/011-exploration-attempt-progress.ts` (new; or the updated allocated migration file if this ticket is explicitly re-sequenced before implementation)
- `packages/storage-providers/relational-kysely/src/migrations.ts`
- `packages/storage-providers/relational-kysely/src/schema.ts`
- `packages/storage-providers/relational-kysely/src/catalog.ts`
- `tests/{unit/runner-components/exploration,replay/exploration,contract/sqlite}`
- `.scratch/remaining-production-closure/issues/20-exploration-seed-checkpoint-budget.md`
- Post-review acceptance only: `tests/e2e/exploration/restart-resume.test.ts`

Files outside this list are not allowed; stop and request an explicit maintainer scope decision before editing them.

## Authority

Resolve conflicts in this order: applicable security and public-contract invariants, architecture and context invariants, current domain/public interfaces and contract tests, then the umbrella spec and this ticket's migrated delta/scope.

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.1-6.3, 9.1, 11, 13.1, and 14.2. Deterministic code owns policy/budgets/checkpoints; Core restart resumes long workflows from durable state; official benchmark effectiveness is separate from the controller.
- Context authority: the ownership, seams, invariants, and verification surfaces in every path under **Affected context paths**.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` user stories 31, 32, 36, and 70; Implementation Decisions on budget/model usage and exploration closure; Testing Decisions on matrices, exploration restart/seed/recovery coverage, and closure review.
- Tracked predecessor authority: `.scratch/remaining-production-closure/issues/19-bounded-multistep-web-runtime.md` and its merged GitHub PR/check evidence establish the bounded Runtime behavior inherited here.
- Current public contracts and tests: `packages/core-modules/mission/src/exploration-policy.ts` (`ExplorationPolicy`, `ExplorationBudgetSnapshot`, `ExplorationCheckpoint`, `ExplorationTerminalReason`); `packages/runner-components/exploration/src/{exploration-controller,exploration-budget,regression-job,state-visit-tracker}.ts`; `packages/runner-components/skill-replay/src/skill-replay-controller.ts` (consume, do not edit); `packages/storage-providers/sqlite-runtime/src/sqlite-benchmark-store.ts`; and the focused unit/replay/SQLite contracts named in this ticket.
- Ticket-local and GitHub evidence: this ticket's `## Comments` and `## Answer`, merged predecessor and final ticket PRs, required checks, reviewed-head and merge-commit bindings, and any deferred advanced-hardening Issues in `ljie-PI/Qualigence` are the durable execution evidence.

## Execution protocol

- This ticket is the execution entrypoint for its allocated scope. Start only after every blocker is `resolved`, from the latest merged predecessor; record the exact base SHA and planned matrix/Gates under `## Comments`, citing the predecessor's merged PR and merge commit as current execution-base evidence.
- Use Node.js 24 and `corepack pnpm --version` exactly `11.7.0`. In a fresh worktree run `corepack pnpm install --frozen-lockfile`; offline install is allowed only with a complete trusted store. Do not regenerate the lockfile.
- Begin with a failing focused test. During implementation and review fixes run only the focused non-E2E Gate below, root typecheck, and diff check. Preserve strict TypeScript, deterministic authority, and existing policy/security/error semantics; no `any`, unsafe double assertion, compatibility default, insecure fallback, production fake, or unallocated migration.
- Do not skip a required Gate. Report unavailable infrastructure with a stable code. Preserve unrelated worktree changes and stop before editing outside **Allowed Files**.
- Record start, optional actual blocker, review rounds, verification commands/results, matrix disposition, exact base/reviewed heads, and final PR evidence under `## Comments`; summarize the resolution under `## Answer`.
- Commit implementation or a review fix before `/code-review`. Each round is one exact-head Standards and Spec review of the whole code/test diff and every matrix row, reporting each row as `pass | finding | N/A`, every N/A reason, and the reviewed head. Append round/head/core findings under `## Comments`.
- Critical findings always block. Important findings block only for explicit acceptance, an applicable architecture/security invariant, a public/persisted contract, a required Gate, or primary-workflow correctness/data integrity. Fix core blockers, rerun affected non-E2E Gates, and perform a fresh complete-matrix review.
- Stop after five review rounds. If a core blocker remains, set this original ticket to `needs-info`, record the blocker, stop dependents, and request a maintainer scope/ownership decision. Do not create recursive local remediation tickets.
- Non-Critical advanced hardening beyond current authority is non-blocking unless the user promotes it. Create one deferred GitHub Issue in `ljie-PI/Qualigence` with source ticket, branch/PR, fixed and reviewed heads, severity/risk, authority, affected files/Gates, and acceptance; do not implement it here or add it as a dependency.
- Run post-review acceptance only after no core Critical/Important finding remains. A code/test change after review or E2E requires focused verification, a fresh complete-matrix review, and then E2E again.
- Create one non-draft PR only after focused Gate, typecheck, diff check, clean review, acceptance, and final ticket evidence are clean. The PR may add one final ticket-evidence-only commit if the code/test diff is byte-identical to the reviewed diff. Keep `claimed` until merge; then record PR URL/merge SHA under `## Answer`, set `resolved`, and remove the ticket branch/worktree.

## Focused non-E2E Gate

```text
corepack pnpm vitest run tests/unit/runner-components/exploration tests/replay/exploration/bounded-exploration.test.ts tests/contract/sqlite/exploration-checkpoint-store.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

```text
corepack pnpm vitest run tests/e2e/exploration/restart-resume.test.ts
```

Interrupt the process after acknowledged safe progress and resume from the last atomically persisted checkpoint. The resumed run must preserve seed completion and all remaining budgets and must not replay an acknowledged or unknown-outcome action. No in-process restart substitute or skip satisfies acceptance.

## Comments

- start — Claimed for isolated implementation on branch `ticket-20-exploration-seed-checkpoint-budget` from base SHA `992804b95183973b5f0ddd76f32c676808fc2ac3` (current main including PR #93 as supplied by worktree). Matrix applicability: applicable; all rows in the Behavior Matrix below govern this stateful, side-effecting, retry/restart-sensitive workflow. Planned focused Gates: `corepack pnpm vitest run tests/unit/runner-components/exploration tests/replay/exploration/bounded-exploration.test.ts tests/contract/sqlite/exploration-checkpoint-store.test.ts`, `corepack pnpm typecheck`, and `git diff --check`. Post-review E2E/PR/merge are intentionally out of scope for this worker run.
- update — Maintainer expanded scope after blocker review to include `packages/runner-components/model-agent/src/exploration-agent.ts`, `apps/benchmark-runner/src/run.ts`, and directly affected tests/helpers. Merged current `main` at `4e6cc92a5df84892d636ca109b14b97f18583a41` into this branch as merge commit `ab6532d`. Repair targets completed: no missing-usage-to-zero conversion in the real exploration model agent, no non-durable benchmark/exploration production path, stable attempt/source/policy/seed live-progress bindings, durable resume from SQLite progress, and no success claim when terminal progress persistence conflicts. Worker validation passed: `corepack pnpm --version` = `11.7.0`; focused Gate `CI=true corepack pnpm vitest run tests/unit/runner-components/exploration tests/replay/exploration/bounded-exploration.test.ts tests/contract/sqlite/exploration-checkpoint-store.test.ts`; expanded tests `CI=true corepack pnpm vitest run tests/unit/runner-components/model-agent/exploration-agent.test.ts tests/unit/benchmark-runner/run.test.ts tests/e2e/detection-benchmark/reference-profile.test.ts tests/e2e/detection-benchmark/unverified-profile.test.ts`; `CI=true corepack pnpm typecheck`; `git diff --check`; benchmark CLI `CI=true corepack pnpm benchmark:detection`. Review/PR/merge remain pending; status stays `claimed`.
- review round 1: reviewed head `1ca8aac7cafca875510b2d9be2ecde3db59ddc30`; Standards found Important blockers for origin enforcement, benchmark error scoring, and stable timeout/recovery handling; Spec found Critical benchmark scoring after exploration error plus Important blockers for missing restart-resume E2E, origin ordering, and model timeout/cancel mapping. Behavior matrix rows 4, 6, 7, 8, 11, 12, and 13 had findings across the two axes; auth row N/A.
- final: reviewed code/test head `a70fd868c93af11371fde012fcbbeb09eb1816e7` with complete matrix coverage; Standards findings 0 and Spec findings 0. Clean focused and expanded Gates: `CI=true corepack pnpm vitest run tests/unit/runner-components/exploration tests/replay/exploration/bounded-exploration.test.ts tests/contract/sqlite/exploration-checkpoint-store.test.ts tests/unit/runner-components/model-agent/exploration-agent.test.ts tests/unit/benchmark-runner/run.test.ts tests/e2e/detection-benchmark/reference-profile.test.ts tests/e2e/detection-benchmark/unverified-profile.test.ts tests/e2e/exploration/restart-resume.test.ts tests/conformance/storage/relational-schema.test.ts tests/contract/sqlite/sqlite-runtime.test.ts` passed with 13 files / 75 tests. Clean post-review acceptance: `CI=true corepack pnpm vitest run tests/e2e/exploration/restart-resume.test.ts` passed with 1 file / 1 test and uses a separate Node child process plus reopened SQLite store. `CI=true corepack pnpm typecheck`, `git diff --check`, and `CI=true corepack pnpm benchmark:detection` passed. PR `https://github.com/ljie-PI/Qualigence/pull/99` merged as `1995a946fc09b05425949cf53f2fe1f29a311731`.

## Answer

Implemented durable exploration progress and resume through migration `011-exploration-attempt-progress`, SQLite live progress/checkpoint storage, and the real benchmark-runner path. Exploration now requires explicit attempt/source bindings and a progress store, persists seed and action side-effect boundaries, resumes from last safe progress, terminalizes unknown in-flight seed/action outcomes without replay, enforces origin/risk/state/recovery/model budgets, propagates missing model usage as `ModelUsageUnavailable`, blocks benchmark scoring on exploration errors, and proves restart/resume with a separate process and durable SQLite database.

Pull request: `https://github.com/ljie-PI/Qualigence/pull/99`

Merge commit: `1995a946fc09b05425949cf53f2fe1f29a311731`

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Valid non-production policy, verified configured seed, and sufficient budgets | `started` only when seed/action dispatch begins | Seed replay precedes bounded exploration; terminal reason is the deterministic observed outcome | Seed completion, last-safe graph fingerprint, complete remaining-budget snapshot, and terminal reason are atomically checkpointed | Continue only from the last safe checkpoint | Ordered seed/replay/action evidence plus persisted checkpoint and terminal reason |
| Malformed policy, missing/unverified seed, invalid seed binding, or production environment | `not_started` | Stable validation/signature error or `ExplorationNotAllowed` / `policy_denied` | No new checkpoint or action state | Retry only with corrected immutable input/authority | Rejection record proves model and Target were not called |
| Caller/session authentication is absent or invalid | `not_started` | N/A: this Runner component receives an already accepted local exploration job and owns no authentication seam | N/A | Upstream admission must authenticate before constructing the job | N/A reason recorded in review |
| Action kind/origin/node/risk exceeds policy or capability | `not_started` | `UnsafeExplorationAction`, `PolicyDenied`, or deterministic capability rejection; terminal `no_safe_action`/`policy_denied` | Terminal checkpoint may record the observed graph and rejection; no action acknowledgement | Same input replays the same rejection; no downgrade or alternate action | Policy/capability decision and zero action-dispatch evidence |
| Step/state/time/token/recovery budget is exhausted, or finite model usage is absent | `not_started` for the next prohibited call/action | `ExplorationBudgetExceeded`, `RepeatedState`, or `ModelUsageUnavailable`; terminal `budget_exhausted`/`state_repeated`/`error` | Exhausted dimension and terminal reason are checkpointed without underflow | No automatic budget reset; a new authorized run is required | Before-dispatch budget snapshot and zero later-action evidence |
| Cancel/timeout before model or Target dispatch | `not_started` | Stable cancellation/timeout terminal | Last prior safe checkpoint remains authoritative | Resume from that checkpoint within remaining policy; do not charge an unstarted effect | Cancellation point and unchanged checkpoint |
| Cancel/timeout after model dispatch but before action dispatch | `started` for the model, `not_started` for the action | Stable model timeout/cancel; no action result | Actual known model usage is charged before terminal checkpoint; no action acknowledgement | Provider retry follows the existing bounded model policy; action is not replayed as completed | Model invocation/usage evidence and zero action-dispatch evidence |
| Cancel/timeout or crash after action dispatch without a known outcome | `outcome_unknown` | Stable `ActionOutcomeUnknown`/`error` terminal | No safe-success checkpoint is advanced past the action | Never automatically replay the action; recovery requires explicit higher-level disposition | Dispatch evidence, absent acknowledgement, and unknown-outcome terminal |
| Same attempt restarts with the same seed, policy, and source binding | `not_started` until resume continues | Existing checkpoint is loaded and execution resumes deterministically | Existing acknowledged checkpoint is unchanged; new checkpoints append/advance atomically | Idempotent resume skips acknowledged seed/actions | Loaded checkpoint identity and no duplicate acknowledged action |
| Restart input conflicts with checkpoint source, seed, policy, or budget binding | `not_started` | Stable conflict/corruption rejection | Existing checkpoint remains unchanged | Never merge conflicting state; require a new authorized attempt | Compared hashes/bindings and rejection |
| Concurrent workers/processes attempt the same checkpoint advance | `started` | One atomic advance wins; loser receives stable conflict/idempotent result | No torn budget/checkpoint and no two authorities for one next step | Loser reloads authoritative state; it does not repeat a started action | Store contract race evidence and one durable next checkpoint |
| Checkpoint/terminal persistence fails before an action | `not_started` | Stable storage error; exploration stops | Prior checkpoint remains authoritative | Retry persistence or restart from prior checkpoint; no action may start | Injected rollback evidence and zero action dispatch |
| Checkpoint/terminal persistence fails after a known action outcome | `started` | Storage error; workflow stops rather than claiming safe progress | No partially advanced checkpoint; outcome is not silently converted to unstarted | Do not automatically replay the action; classify through recovery authority | Known action outcome, failed atomic write, and stopped terminal evidence |

- [ ] Seed Skill executes before bounded exploration.
- [ ] Checkpoints persist atomically and restore the last safe state after process restart.
- [ ] Maximum state visits and recovery budget are enforced from policy rather than hard-coded.
- [ ] Missing model usage and exhausted budgets fail with stable dispositions.
