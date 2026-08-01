# [LS-03] M1 Execution Application and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose persistence, Playwright, model components and Runner Runtime behind one reusable application use case and a stable CLI.

**Architecture:** `@qualigence/execution-application` owns orchestration and resource cleanup through ports. `apps/cli` is the only local composition root and contains no execution algorithm.

**Tech Stack:** Node.js 24, TypeScript ESM, Commander 14, Pino, Zod, existing workspace packages.

**Direct Dependencies:** LS-01, LS-02 and BASE-03.

## Global Constraints

- Do not change the fixed `ExecutionRuntime` pipeline.
- Every created Run gets exactly one `run_completed`; pre-Run configuration failures get none.
- stdout is result-only; logs use stderr and never include secrets/prompts/raw observations.
- CLI and future API/PRD callers use the same `RunExecutionUseCase`.
- Tests stay under top-level `tests/`.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

## File Structure

```text
packages/execution-application/src/contracts.ts
packages/execution-application/src/artifact-recording-observer.ts
packages/execution-application/src/terminal-trace-ensurer.ts
packages/execution-application/src/run-execution-use-case.ts
apps/cli/src/config.ts
apps/cli/src/output.ts
apps/cli/src/exit-code.ts
apps/cli/src/local-run-composition-root.ts
apps/cli/src/index.ts
```

### Task 1: Define the application package and request/result contract

**Files:**

- Create: `packages/execution-application/package.json`
- Create: `packages/execution-application/tsconfig.json`
- Create: `packages/execution-application/src/contracts.ts`
- Create: `packages/execution-application/src/index.ts`
- Test: `tests/type/run-execution-use-case.types.ts`
- Modify: `tsconfig.json`

**Interfaces:** Produces the exact `RunExecutionRequest`, `RunExecutionResult`, `RunExecutionUseCase`, `RunResourceScope`, and `RunResourceFactory` types from the Design Spec.

- [ ] **Step 1: Add a consumer type test**

```ts
declare const useCase: RunExecutionUseCase;
const result = await useCase.execute({
  target: { kind: "web", url: "http://127.0.0.1:3000" },
  objective: "add one item",
  executionProfile: { modelProfileId: "default", headed: false, navigationTimeoutMs: 10_000, actionTimeoutMs: 5_000 },
});
result satisfies RunExecutionResult;
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm typecheck`

Expected: package and types are missing.

- [ ] **Step 3: Add the contract package**

Copy field names/unions exactly from the LS-03 Design Spec. Keep ports provider-neutral; `RunResourceScope` imports only public package types.

```ts
export interface RunExecutionUseCase {
  execute(request: RunExecutionRequest): Promise<RunExecutionResult>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm typecheck`

Expected: type consumer compiles.

- [ ] **Step 5: Commit**

```text
git add packages/execution-application tests/type/run-execution-use-case.types.ts tsconfig.json
git commit -m "feat(execution): define shared run use case"
```

### Task 2: Record capture artifacts and enforce one terminal event

**Files:**

- Create: `packages/execution-application/src/artifact-recording-observer.ts`
- Create: `packages/execution-application/src/terminal-trace-ensurer.ts`
- Test: `tests/unit/execution-application/artifact-recording-observer.test.ts`
- Test: `tests/unit/execution-application/terminal-trace-ensurer.test.ts`
- Modify: `packages/execution-application/src/index.ts`

**Interfaces:** `ArtifactRecordingObserver` decorates `Observer`; `TerminalTraceEnsurer.ensureError(runId, code)` uses `TraceStore.nextTraceSequenceNumber/eventAt` before append.

- [ ] **Step 1: Write failing decorator/terminal tests**

```ts
const graph = await observer.capture(job);
expect(graph.artifactRefs).toEqual(["before-json", "before-png"]);
await ensurer.ensureError("run-1", "BrowserUnavailable");
await ensurer.ensureError("run-1", "BrowserUnavailable");
expect(trace.eventsFor("run-1").filter((e) => e.stage === "run_completed")).toHaveLength(1);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/execution-application`

Expected: decorators are missing.

- [ ] **Step 3: Implement both focused components**

For every capture, write Graph JSON and PNG, append both Manifests, then return a copied Graph with artifact IDs. If any artifact step fails, throw `ArtifactUnavailable` before returning the Graph. Terminalizer appends `status:error` only when no terminal exists and tolerates a duplicate created by a concurrent writer.

```ts
export class TerminalTraceEnsurer {
  ensureError(runId: string, errorCode: string): Promise<void>;
}
export class ArtifactRecordingObserver implements Observer {
  capture(job: AcceptedExecutionJob): Promise<ObservationGraph>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm vitest run tests/unit/execution-application`

Expected: artifacts are complete-or-error and terminal append is idempotent.

- [ ] **Step 5: Commit**

```text
git add packages/execution-application tests/unit/execution-application
git commit -m "feat(execution): record artifacts and terminal trace"
```

### Task 3: Implement RunExecutionUseCase

**Files:**

- Create: `packages/execution-application/src/run-execution-use-case.ts`
- Create: `packages/execution-application/src/persisted-model-invocation-observer.ts`
- Modify: `packages/contracts/model-provider/src/index.ts`
- Modify: `packages/model-gateway/src/model-gateway.ts`
- Modify: `packages/runner-components/model-agent/src/model-agent.ts`
- Modify: `packages/runner-kernel/src/execution-runtime.ts`
- Test: `tests/component/web-execution/run-execution-use-case.test.ts`
- Test: `tests/unit/model-gateway/model-invocation-observer.test.ts`
- Modify: `packages/execution-application/src/index.ts`

**Interfaces:** Consumes `RunResourceFactory`; produces `RunExecutionUseCaseImpl.execute` and stable application results.

- [ ] **Step 1: Write four terminal-path tests**

```ts
it.each([
  [completionPassed, "passed"],
  [completionFinding, "finding"],
  [completionBlocked, "blocked"],
])("maps runtime completion", async (completion, status) => {
  expect((await harness(completion).execute(request)).status).toBe(status);
});

it("maps infrastructure errors and closes resources", async () => {
  const h = harnessRejecting(new Error("browser crashed"));
  expect(await h.useCase.execute(request)).toMatchObject({ status: "error", errorCode: "BrowserUnavailable" });
  expect(h.close).toHaveBeenCalledOnce();
});
```

Also assert pre-validation creates no Run and every created Run has one terminal event.

Add a failed-verification case whose before/after Graphs contain Artifact IDs; assert the persisted/returned Finding contains both semantic `graphId:nodeId` refs and those Artifact IDs. Add Gateway success/final-failure tests that emit exactly one provider-neutral `ModelInvocationReport`; test `PersistedModelInvocationObserver` maps it to one `ModelInvocationSummary` with run/invocation/model/usage/latency/status/error and never raw messages/output.

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/component/web-execution/run-execution-use-case.test.ts`

Expected: implementation missing.

- [ ] **Step 3: Implement the use case**

Validate request; generate UUIDv7 IDs; open Scope; create Run; run Runtime; persist terminal Run; map evidence. Extend `StructuredModelRequest` with optional invocation context, have both Model Agents set it, and add Gateway's optional `ModelInvocationObserver`/clock to emit one logical Report after retries. Implement the execution-application adapter that maps Report to the LS-01 Store without making model-gateway depend on evidence. Change `findingFromVerification` to receive before/after Graphs and union their registered Artifact IDs with semantic claim refs. In catch, map only known dependency errors, ensure error terminal, complete Run; in finally close Scope and log cleanup failure without changing an already returned business terminal.

```ts
export class RunExecutionUseCaseImpl implements RunExecutionUseCase {
  constructor(private readonly resources: RunResourceFactory) {}
  execute(request: RunExecutionRequest): Promise<RunExecutionResult>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm vitest run tests/component/web-execution/run-execution-use-case.test.ts tests/unit/model-gateway/model-invocation-observer.test.ts`

Expected: passed/finding/blocked/error, pre-validation, one-terminal and cleanup tests pass.

- [ ] **Step 5: Commit**

```text
git add packages/execution-application packages/contracts/model-provider packages/model-gateway packages/runner-components/model-agent packages/runner-kernel tests/component/web-execution/run-execution-use-case.test.ts tests/unit/model-gateway/model-invocation-observer.test.ts
git commit -m "feat(execution): orchestrate local web runs"
```

### Task 4: Implement CLI shell and output contract

**Files:**

- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Create: `apps/cli/src/config.ts`
- Create: `apps/cli/src/output.ts`
- Create: `apps/cli/src/exit-code.ts`
- Create: `apps/cli/src/index.ts`
- Test: `tests/unit/cli/config.test.ts`
- Test: `tests/unit/cli/output.test.ts`
- Test: `tests/unit/cli/exit-code.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`

**Interfaces:** CLI parses `run --url --objective --output --headed`; calls an injected `RunExecutionUseCase`.

- [ ] **Step 1: Write parser/output/exit tests**

```ts
expect(exitCodeFor({ runId: "r", status: "finding", evidenceRefs: [] })).toBe(1);
expect(renderJson(result)).toBe(`${JSON.stringify(result)}\n`);
try {
  loadConfig({ QUALIGENCE_MODEL_API_KEY: undefined });
  expect.unreachable("missing model secret must fail");
} catch (error) {
  expect(error).toMatchObject({ code: "InvalidConfiguration" });
}
```

Assert no option named `--api-key` exists and stderr logger redacts known secret keys.

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/cli`

Expected: CLI modules missing.

- [ ] **Step 3: Implement shell**

Install Commander/Pino/Zod. Parse only specified options, read model secrets from environment, write one JSON line to stdout or human summary, and set `process.exitCode` to 0/1/2/3 without calling `process.exit()` inside library functions.

```ts
export async function runCli(argv: readonly string[], env: NodeJS.ProcessEnv, useCase: RunExecutionUseCase): Promise<number> {
  const result = await useCase.execute(parseRunRequest(argv, env));
  return exitCodeFor(result);
}
```

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm vitest run tests/unit/cli`

Expected: config, redaction, exact JSON and exit mapping pass.

- [ ] **Step 5: Commit**

```text
git add apps/cli tests/unit/cli package.json pnpm-lock.yaml tsconfig.json
git commit -m "feat(cli): add stable run command contract"
```

### Task 5: Compose concrete Local dependencies and Gate

**Files:**

- Create: `apps/cli/src/local-run-composition-root.ts`
- Test: `tests/component/web-execution/local-run-composition-root.test.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: `tests/smoke/node-package-imports.mjs`
- Modify: `README.md`

**Interfaces:** Composition Root creates SQLite/Artifact, Playwright, InMemory protocol/TraceIngestor, Model Gateway/Provider/Agent and Runtime; returns the shared use case.

- [ ] **Step 1: Write a dependency-wiring test**

Use a mock OpenAI-compatible HTTP server and real temporary stores/Playwright; assert the returned object exposes only `execute`, closes all resources and writes the Run.

```ts
const useCase = await createLocalRunUseCase(configFor(mockServer, dataDir));
expect(Object.keys(useCase)).toEqual(["execute"]);
const result = await useCase.execute(requestFor(fixtureUrl));
expect(await reopenRun(dataDir, result.runId)).toBeDefined();
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/component/web-execution/local-run-composition-root.test.ts`

Expected: composition root missing.

- [ ] **Step 3: Wire concrete packages**

The CLI imports concrete packages only here. Create one adapter per Run, inject model name/base URL/API key without logging, use `TraceIngestor` rather than direct SQL, and return `RunExecutionUseCaseImpl`.

```ts
export async function createLocalRunUseCase(config: CliConfig): Promise<RunExecutionUseCase> {
  return new RunExecutionUseCaseImpl(new LocalRunResourceFactory(config));
}
```

- [ ] **Step 4: Run LS-03 Gate**

```text
pnpm build
pnpm vitest run tests/unit/execution-application tests/unit/cli tests/component/web-execution/run-execution-use-case.test.ts tests/component/web-execution/local-run-composition-root.test.ts
pnpm typecheck
pnpm smoke:node-imports
git diff --check
```

Expected: all commands exit 0; no API key appears in captured stdout/stderr/database/artifacts.

- [ ] **Step 5: Commit and update status**

```text
git add apps packages tests README.md docs/superpowers/implementation-status.md
git commit -m "feat(cli): complete shared local execution entrypoint"
```

## Plan Self-Review

- Spec coverage: stable contract, artifacts, one terminal, error mapping, cleanup, CLI config/output/exit and concrete composition map to Tasks 1–5.
- Placeholder scan: each task has exact paths, behavior, test oracle and command.
- Type consistency: CLI calls only `RunExecutionUseCase`; concrete dependencies remain in Composition Root.
