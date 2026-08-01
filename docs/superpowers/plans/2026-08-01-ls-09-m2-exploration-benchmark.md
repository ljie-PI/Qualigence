# [LS-09] M2 Exploration and Detection Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Verified Skill regression plus bounded exploration and score Detection Benchmark v1 against frozen Ground Truth thresholds.

**Architecture:** A deterministic Exploration Controller owns state visits, risk and budgets; the model only proposes schema-valid actions. Benchmark Manifest/Scorer are model-independent and version/hash every input.

**Tech Stack:** TypeScript, Model Gateway/Zod, Vitest/fast-check, JSON manifests, existing Runner/Mission/Skill packages.

**Direct Dependencies:** LS-08.

## Global Constraints

- Exploration is forbidden in production and cannot exceed RecoverableMutation in M2.
- Any one budget reaching zero stops before the next action.
- Benchmark uses all configured repetitions; no best-run selection.
- Reference thresholds exactly match the Design Spec.
- Tests remain under top-level `tests/`.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

### Task 1: Implement budgets, fingerprints and visit tracking

**Files:**

- Create: `packages/runner-components/exploration/package.json`
- Create: `packages/runner-components/exploration/tsconfig.json`
- Create: `packages/runner-components/exploration/src/exploration-budget.ts`
- Create: `packages/runner-components/exploration/src/state-visit-tracker.ts`
- Create: `packages/runner-components/exploration/src/index.ts`
- Test: `tests/unit/runner-components/exploration/exploration-budget.test.ts`
- Test: `tests/unit/runner-components/exploration/state-visit-tracker.test.ts`

**Interfaces:** Produces `ExplorationPolicy`, `ExplorationBudgetSnapshot`, `ExplorationTerminalReason`, `ExplorationCheckpoint`, stable graph fingerprint.

- [ ] **Step 1: Write boundary/property tests**

At maximumSteps=2, consume twice then third returns `budget_exhausted`; normalize volatile timestamp/random IDs to same fingerprint; semantic/state change produces different fingerprint; maximumStateVisits stops at exact threshold.

```ts
const budget = ExplorationBudget.from(policy({ maximumSteps: 2 }));
expect(budget.reserveStep().ok).toBe(true);
expect(budget.reserveStep().ok).toBe(true);
expect(budget.reserveStep()).toMatchObject({ ok: false, reason: "budget_exhausted" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/runner-components/exploration/exploration-budget.test.ts tests/unit/runner-components/exploration/state-visit-tracker.test.ts`

Expected: package missing.

- [ ] **Step 3: Implement pure deterministic values**

Use injected monotonic clock and explicit token/cost updates; reject negative limits; canonicalize URL path/interactable semantics/key states, not graph/node IDs.

```ts
export class ExplorationBudget {
  reserveStep(): Reservation {
    if (this.used.steps >= this.limit.maximumSteps) return exhausted("budget_exhausted");
    this.used.steps += 1;
    return { ok: true };
  }
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 1 command; expect exact-boundary and property tests pass.

- [ ] **Step 5: Commit**

```text
git add packages/runner-components/exploration tests/unit/runner-components/exploration
git commit -m "feat(exploration): add deterministic budgets and state visits"
```

### Task 2: Implement model Proposal and Exploration Controller

**Files:**

- Create: `packages/runner-components/model-agent/src/exploration-agent.ts`
- Create: `packages/runner-components/exploration/src/exploration-controller.ts`
- Create: `packages/core-modules/mission/src/exploration-policy.ts`
- Modify: `packages/contracts/model-provider/src/index.ts`
- Test: `tests/unit/runner-components/exploration/exploration-controller.test.ts`
- Test: `tests/replay/exploration/bounded-exploration.test.ts`

**Interfaces:** Adds `exploration.next-action`; Controller runs Seed replay then bounded Observe→Proposal→Authorize→Execute→Checkpoint.

- [ ] **Step 1: Write adversarial matrix**

Unknown node, disallowed kind, risk above ceiling, repeated action/state, model stop, Policy denial, token/step/time exhaustion, Finding and Plan divergence each yield exact terminal reason and no extra action.

```ts
const result = await controller.run(job, proposal({ action: click("unknown") }));
expect(result.terminalReason).toBe("no_safe_action");
expect(target.executedActions()).toHaveLength(0);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/runner-components/exploration/exploration-controller.test.ts tests/replay/exploration/bounded-exploration.test.ts`

Expected: Agent/controller missing.

- [ ] **Step 3: Implement fail-closed loop**

Validate environment non-production, Seed signature, node/action/risk before Policy; reserve budget atomically before action and settle actual token/time after; save checkpoint after each observation; never accept model novelty/risk as fact.

```ts
while (budget.canContinue()) {
  const graph = await target.capture();
  const proposal = await agent.nextAction(toExplorationContext(graph, budget.snapshot()));
  const action = validateProposalAgainstGraph(proposal, graph, policy);
  if (!action.ok) return terminal(action.reason);
  await target.execute(action.value);
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 2 command; expect matrix/replay deterministic terminal reasons pass.

- [ ] **Step 5: Commit**

```text
git add packages/contracts/model-provider packages/runner-components packages/core-modules/mission tests/unit/runner-components/exploration tests/replay/exploration
git commit -m "feat(exploration): run policy-bounded exploration"
```

### Task 3: Freeze Benchmark Manifest and Scorer

**Files:**

- Create: `packages/benchmarking/detection/package.json`
- Create: `packages/benchmarking/detection/tsconfig.json`
- Create: `packages/benchmarking/detection/src/manifest.ts`
- Create: `packages/benchmarking/detection/src/scorer.ts`
- Create: `packages/benchmarking/detection/src/report.ts`
- Create: `packages/benchmarking/detection/src/index.ts`
- Create: `benchmarks/detection-v1/manifest.json`
- Create: `benchmarks/detection-v1/scenarios/cart-normal.json`
- Create: `benchmarks/detection-v1/scenarios/cart-known-bugs.json`
- Create: `benchmarks/detection-v1/ground-truth/cart.json`
- Test: `tests/unit/benchmarking/detection/scorer.test.ts`

**Interfaces:** `scoreBenchmark(manifest, attempts, groundTruth)` consumes the exact `ReferenceModelProfile` and `BenchmarkScenario` fields and returns the frozen `DetectionMetrics`/`DetectionBenchmarkReport` shape.

- [ ] **Step 1: Write scorer arithmetic tests**

Use a hand-computable set: 5 known/4 hit=0.8 recall; 4 true/6 findings=0.666 precision; 7/10 stable reproduced=0.7; one P0 miss fails regardless totals; normal 2 high-confidence FP fails.

```ts
const report = scoreBenchmark(manifest, attempts({ known: 5, hit: 4, findings: 6, trueFindings: 4, stable: 10, reproduced: 7 }), truth);
expect(report.metrics.knownBugRecall.value).toBe(0.8);
expect(report.metrics.stableReproductionRate.value).toBe(0.7);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/benchmarking/detection/scorer.test.ts`

Expected: package/manifest missing.

- [ ] **Step 3: Implement strict Manifest and scorer**

Require schema version, profile/prompt/policy/skill/browser/fixture hashes, budgets/repetitions and exact thresholds. Match only scenarioId+defectId; include every repetition; output metric numerators/denominators and failure codes.

```ts
export function scoreBenchmark(
  manifest: BenchmarkManifest,
  attempts: readonly BenchmarkAttempt[],
  truth: GroundTruth,
): DetectionBenchmarkReport {
  assertCompleteAttemptMatrix(manifest, attempts);
  return reportFrom(computeMetrics(attempts, truth), manifest.thresholds);
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 3 command; expect arithmetic, invalid Manifest and threshold tests pass.

- [ ] **Step 5: Commit**

```text
git add packages/benchmarking benchmarks/detection-v1 tests/unit/benchmarking/detection
git commit -m "feat(benchmark): freeze detection benchmark v1 scorer"
```

### Task 4: Add Benchmark Runner, persistence and release Gate

**Files:**

- Create: `apps/benchmark-runner/package.json`
- Create: `apps/benchmark-runner/tsconfig.json`
- Create: `apps/benchmark-runner/src/main.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/migrations/004-exploration-benchmark.ts`
- Test: `tests/e2e/detection-benchmark/reference-profile.test.ts`
- Test: `tests/e2e/detection-benchmark/unverified-profile.test.ts`
- Modify: `package.json`
- Modify: `docs/superpowers/implementation-status.md`

**Interfaces:** `qualigence-benchmark run --manifest ... --output ...`; saves attempts and hash-linked Report.

- [ ] **Step 1: Write runner/label tests**

Reference fake profile meeting thresholds returns exit 0/Gate passed; one metric under returns exit 1/failure code; non-reference profile always labels `unverified` and never claims official pass.

```ts
expect(await runBenchmark(referencePassing)).toMatchObject({ exitCode: 0, report: { gate: { status: "passed" } } });
expect(await runBenchmark(referenceBelowRecall)).toMatchObject({ exitCode: 1, report: { gate: { failureCodes: expect.arrayContaining(["KnownBugRecallBelowMinimum"]) } } });
expect((await runBenchmark(byoProfile)).report.profileStatus).toBe("unverified");
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/e2e/detection-benchmark`

Expected: Runner/persistence missing.

- [ ] **Step 3: Implement runner and attempt persistence**

Validate all input hashes before execution; run every scenario/repetition; save each attempt append-only; compute Report after completion; include manifest/profile/ground-truth hashes and environment versions.

```ts
for (const scenario of manifest.scenarios) {
  for (let repetition = 1; repetition <= manifest.repetitions; repetition += 1) {
    await attemptStore.append(await executeAttempt(scenario, repetition));
  }
}
return scoreBenchmark(manifest, await attemptStore.forRun(runId), groundTruth);
```

- [ ] **Step 4: Run LS-09 Gate**

```text
pnpm build
pnpm test
pnpm typecheck
pnpm vitest run tests/replay/exploration tests/e2e/detection-benchmark
pnpm benchmark:detection
git diff --check
```

Expected: deterministic Reference fixture report satisfies all five thresholds; unverified label test passes.

- [ ] **Step 5: Commit/status**

```text
git add apps/benchmark-runner packages benchmarks tests package.json docs/superpowers/implementation-status.md
git commit -m "feat(benchmark): complete bounded detection gate"
```

## Plan Self-Review

- Spec coverage: regression seed, budgets/state/risk, model boundary, scorer/thresholds, profile labels, persistence and Gate map to Tasks 1–4.
- Placeholder scan: exact terminal reasons and metric arithmetic are specified.
- Type consistency: Controller emits attempts; scorer consumes structured attempts/Ground Truth without model dependency.
