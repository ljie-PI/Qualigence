# [LS-04] M1 E2E and Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the real CLI/browser/model-contract/storage vertical slice with deterministic normal, defect, blocked and provider-error black-box scenarios.

**Architecture:** Fastify fixtures and a dynamic OpenAI-compatible fake run outside product packages. E2E spawns the built CLI, then reopens stores through public readers and verifies evidence integrity.

**Tech Stack:** Node.js 24, Fastify 5, Playwright Chromium, Vitest, child_process.

**Direct Dependencies:** LS-03.

## Global Constraints

- No fixed ports, sleeps, public network calls or real API keys in normal CI.
- Mock responses derive current graph/node IDs from each request.
- A passing test deletes its temp directory; a failure preserves diagnostics.
- Live Smoke is explicit opt-in and not a pull-request Gate.
- Tests remain under top-level `tests/`.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

### Task 1: Build deterministic cart and model fixtures

**Files:**

- Create: `tests/fixtures/web-cart/page.ts`
- Create: `tests/fixtures/web-cart/server.ts`
- Create: `tests/fixtures/openai-compatible/responses.ts`
- Create: `tests/fixtures/openai-compatible/mock-server.ts`
- Test: `tests/contract/fixtures/web-cart.test.ts`
- Test: `tests/contract/fixtures/openai-compatible-mock.test.ts`

**Interfaces:** `startCartFixture(mode)` and `startMockModelServer()` return `{url, close}`; model fake accepts the same HTTP contract as the Provider.

- [ ] **Step 1: Write failing fixture contracts**

```ts
const cart = await startCartFixture("fault");
expect(await fetchText(cart.url)).toContain("$19");
const model = await startMockModelServer();
const decision = await invoke(model.url, decisionRequest(graphWithAddButton("n-live")));
expect(decision.output.action.nodeId).toBe("n-live");
```

Verification response must cite dynamic before/after graph IDs and `$19/$29` text.

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/fixtures`

Expected: fixture helpers missing.

- [ ] **Step 3: Implement both servers**

Bind `127.0.0.1:0`; expose `/health`; return normal `$19` or fault `$29` after click; parse request JSON and reject missing current nodes with HTTP 400. Track request count for retry assertions.

```ts
export function startCartFixture(mode: "normal" | "fault"): Promise<FixtureHandle>;
export function startMockModelServer(): Promise<FixtureHandle & { requestCount(): number }>;
```

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm vitest run tests/contract/fixtures`

Expected: both modes, dynamic IDs, health and close/port reuse pass.

- [ ] **Step 5: Commit**

```text
git add tests/fixtures tests/contract/fixtures
git commit -m "test(e2e): add deterministic cart and model fixtures"
```

### Task 2: Add process/temp diagnostics helpers

**Files:**

- Create: `tests/helpers/cli-process.ts`
- Create: `tests/helpers/temp-data-dir.ts`
- Test: `tests/unit/test-helpers/cli-process.test.ts`

**Interfaces:** `runCli(args, env, deadlineMs)` returns exitCode/stdout/stderr; `withTempDataDir(testName)` tracks preserve/delete state.

- [ ] **Step 1: Write timeout/stdout tests**

Spawn a small Node fixture that exits 7 and another that exceeds deadline; assert exact capture, termination and diagnostic path.

```ts
expect(await runCli([exitFixture, "7"], {}, 1_000)).toMatchObject({ exitCode: 7 });
await expect(runCli([hangingFixture], {}, 10)).rejects.toMatchObject({ code: "CliProcessTimedOut" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/test-helpers/cli-process.test.ts`

Expected: helpers missing.

- [ ] **Step 3: Implement condition-based process control**

Wait for process close with deadline/AbortController, terminate only the spawned process tree using platform-safe APIs, and never use fixed sleep. On success remove temp dir; on failure print its absolute path.

```ts
export function runCli(args: readonly string[], env: NodeJS.ProcessEnv, deadlineMs: number): Promise<CliProcessResult>;
export function withTempDataDir(testName: string): Promise<TempDataDir>;
```

- [ ] **Step 4: Confirm GREEN**

Run the Task 2 command; expect exit, timeout and cleanup cases pass with no child process left.

- [ ] **Step 5: Commit**

```text
git add tests/helpers tests/unit/test-helpers
git commit -m "test(e2e): add cli process diagnostics"
```

### Task 3: Implement black-box CLI E2E

**Files:**

- Create: `tests/e2e/cli-web-cart.test.ts`
- Modify: `package.json`

**Interfaces:** Runs built `apps/cli/dist/index.js`; reopens `SqliteRuntime` and `LocalArtifactStore` through public APIs.

- [ ] **Step 1: Write all four scenarios**

```ts
expect(await runScenario("normal")).toMatchObject({ exitCode: 0, result: { status: "passed" } });
expect(await runScenario("fault")).toMatchObject({ exitCode: 1, result: { status: "finding" } });
expect(await runBlockedScenario()).toMatchObject({ exitCode: 2, result: { status: "blocked" } });
expect(await runUnauthorizedProvider()).toMatchObject({ exitCode: 3, result: { status: "error" } });
```

For each created Run assert one terminal event. For fault assert `$19/$29`, Manifests and all file hashes. For 401 assert one Provider request and no Finding.

- [ ] **Step 2: Confirm RED**

Run: `pnpm test:e2e`

Expected: script/test or an unimplemented integration path fails.

- [ ] **Step 3: Complete fixture wiring and E2E script**

Set `test:e2e` to build then run this file. Supply only temporary `QUALIGENCE_DATA_DIR` and fake model environment; parse stdout as exactly one JSON line and treat extra output as failure.

```ts
async function runScenario(mode: "normal" | "fault"): Promise<{ result: RunExecutionResult; exitCode: number }> {
  return runBuiltCliAgainstFixtures(mode);
}
```

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm test:e2e`

Expected: four scenarios pass; database/artifact reopen checks pass; no external request occurs.

- [ ] **Step 5: Commit**

```text
git add tests/e2e/cli-web-cart.test.ts package.json
git commit -m "test(e2e): verify real web cli vertical slice"
```

### Task 4: Add opt-in Live Smoke and release documentation

**Files:**

- Create: `tests/live/remote-model-smoke.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/superpowers/implementation-status.md`

**Interfaces:** `pnpm test:live` skips unless opt-in plus all model variables exist.

- [ ] **Step 1: Write skip/structure tests**

Test helper `liveModelEnabled(env)` returns false unless flag and four variables exist. Live assertion checks only status/evidence integrity, not prose.

```ts
expect(liveModelEnabled({ QUALIGENCE_LIVE_MODEL_SMOKE: "true" })).toBe(false);
expect(liveModelEnabled(completeLiveEnv)).toBe(true);
expect(await verifyFindingEvidence(liveResult)).toBe(true);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/live/remote-model-smoke.test.ts`

Expected: helper/test file is missing before implementation.

- [ ] **Step 3: Implement Live Smoke and README**

Use fault fixture and real Provider. Document Chromium install, four env vars, CLI command, exit codes, data directory, deterministic fake CI and Live opt-in. Never print API key.

```ts
export function liveModelEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.QUALIGENCE_LIVE_MODEL_SMOKE === "true" && requiredModelKeys.every((key) => Boolean(env[key]));
}
```

- [ ] **Step 4: Run LS-04 Gate**

```text
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm test
pnpm typecheck
pnpm smoke:node-imports
pnpm test:e2e
git diff --check
```

Expected: every command exits 0; `test:live` is not invoked without explicit credentials.

- [ ] **Step 5: Commit and record evidence**

```text
git add tests/live package.json README.md docs/superpowers/implementation-status.md
git commit -m "docs(test): close m1 real web release gate"
```

## Plan Self-Review

- Spec coverage: deterministic fixture/fake, dynamic node IDs, four black-box paths, persistence/hash checks, process cleanup, Live Smoke and release commands map to Tasks 1–4.
- Placeholder scan: every scenario names its exact oracle and command.
- Type consistency: fixtures implement external HTTP behavior only; product modules remain unchanged.
