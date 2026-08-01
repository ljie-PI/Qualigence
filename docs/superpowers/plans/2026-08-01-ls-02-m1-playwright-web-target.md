# [LS-02] M1 Playwright Web Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a one-run Playwright adapter that observes semantic nodes, resolves node IDs safely, executes authorized same-origin clicks, captures screenshots, and closes deterministically.

**Architecture:** A public `PlaywrightWebTargetAdapter` delegates to focused BrowserSession, Observer, Resolver and Executor internals. No Playwright object or executable selector leaves the package.

**Tech Stack:** Node.js 24, TypeScript ESM, Playwright 1.62, Vitest, Fastify fixture.

**Direct Dependencies:** BASE-02 and BASE-03.

## Global Constraints

- Tests live under top-level `tests/`.
- Product code uses the Playwright Library API; Playwright Test is not a runtime dependency.
- The model and persisted Graph receive node IDs only, never CSS/XPath/Locator.
- Each adapter instance serves one Run and one isolated BrowserContext.
- Support only http(s), semantic observation, screenshot and click in LS-02.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

## File Structure

```text
packages/target-adapters/web-playwright/src/browser-session.ts
packages/target-adapters/web-playwright/src/observation-builder.ts
packages/target-adapters/web-playwright/src/playwright-observer.ts
packages/target-adapters/web-playwright/src/playwright-action-resolver.ts
packages/target-adapters/web-playwright/src/playwright-action-executor.ts
packages/target-adapters/web-playwright/src/playwright-web-target-adapter.ts
```

### Task 1: Create package and session lifecycle

**Files:**

- Create: `packages/target-adapters/web-playwright/package.json`
- Create: `packages/target-adapters/web-playwright/tsconfig.json`
- Create: `packages/target-adapters/web-playwright/src/browser-session.ts`
- Create: `packages/target-adapters/web-playwright/src/index.ts`
- Test: `tests/unit/target-adapters/web-playwright/browser-session.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`

**Interfaces:** Produces `WebSessionOptions` and internal `PlaywrightBrowserSession.start/page/close` without exporting Playwright types.

- [ ] **Step 1: Write lifecycle tests**

```ts
it("starts once and closes idempotently", async () => {
  const session = new PlaywrightBrowserSession(options, launcher);
  await Promise.all([session.start(), session.start()]);
  expect(launcher.launch).toHaveBeenCalledTimes(1);
  await session.close();
  await session.close();
});
```

Add invalid scheme, credential URL and launch failure cases.

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts`

Expected: package/session is missing.

- [ ] **Step 3: Implement lifecycle**

Install `playwright@1.62`; launch Chromium, create isolated Context/Page, set timeouts, register navigation origin checks, and close Page→Context→Browser. Serialize start/close state with `new|starting|started|closing|closed`.

```ts
export class PlaywrightBrowserSession {
  start(): Promise<void>;
  withPage<T>(operation: (page: Page) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm vitest run tests/unit/target-adapters/web-playwright/browser-session.test.ts`

Expected: lifecycle and URL rejection cases pass.

- [ ] **Step 5: Commit**

```text
git add package.json pnpm-lock.yaml tsconfig.json packages/target-adapters/web-playwright tests/unit/target-adapters/web-playwright/browser-session.test.ts
git commit -m "feat(web): add playwright session lifecycle"
```

### Task 2: Build semantic Observation Graphs

**Files:**

- Create: `packages/target-adapters/web-playwright/src/observation-builder.ts`
- Create: `packages/target-adapters/web-playwright/src/playwright-observer.ts`
- Test: `tests/unit/target-adapters/web-playwright/observation-builder.test.ts`
- Test: `tests/component/web-execution/playwright-observation.test.ts`

**Interfaces:** Consumes `AcceptedExecutionJob`; produces `ObservationGraph` plus an internal graph-scoped locator descriptor map.

- [ ] **Step 1: Write normalization/node identity tests**

```ts
expect(normalizeVisibleText("  A\n B  ")).toBe("A B");
const graph = buildGraph("run-1", 1, candidates);
expect(graph.graphId).toBe("run-1:observation:1");
expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
```

Component fixture must include button, observed text, disabled control and password input; assert no password value appears.

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/target-adapters/web-playwright/observation-builder.test.ts tests/component/web-execution/playwright-observation.test.ts`

Expected: builder/observer imports fail.

- [ ] **Step 3: Implement capture**

Collect role/name/text/value/disabled and `[data-qualigence-observe]`; normalize NFC/whitespace; assign `n-<ordinal>-<8-char-hash>`; keep LocatorDescriptor inside Session keyed by graphId/nodeId. Return no selector or ElementHandle.

```ts
export class PlaywrightObserver implements Observer {
  capture(job: AcceptedExecutionJob): Promise<ObservationGraph>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run the Task 2 command after `pnpm exec playwright install chromium`.

Expected: unit and real Chromium observation cases pass.

- [ ] **Step 5: Commit**

```text
git add packages/target-adapters/web-playwright tests/unit/target-adapters/web-playwright/observation-builder.test.ts tests/component/web-execution/playwright-observation.test.ts
git commit -m "feat(web): capture semantic playwright observations"
```

### Task 3: Resolve and execute authorized clicks

**Files:**

- Create: `packages/target-adapters/web-playwright/src/playwright-action-resolver.ts`
- Create: `packages/target-adapters/web-playwright/src/playwright-action-executor.ts`
- Test: `tests/unit/target-adapters/web-playwright/action-resolution.test.ts`
- Test: `tests/component/web-execution/playwright-click.test.ts`

**Interfaces:** Implements existing `ActionResolver.resolve` and `ActionExecutor.execute`; returns only `pw:<graphId>:<nodeId>` as the trace-safe token.

- [ ] **Step 1: Write failing negative and click tests**

```ts
await expect(resolver.resolve(click("missing"), graph)).rejects.toMatchObject({ code: "UnknownObservationNode" });
await expect(resolver.resolve(click(nodeId), oldGraph)).rejects.toMatchObject({ code: "StaleObservation" });
const resolved = await resolver.resolve(click(nodeId), graph);
expect(resolved.selector).toBe(`pw:${graph.graphId}:${nodeId}`);
expect(await executor.execute(resolved, permit)).toEqual({ status: "ok" });
```

Add ambiguous, disabled, timeout and cross-origin cases.

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/component/web-execution/playwright-click.test.ts`

Expected: resolver/executor are missing.

- [ ] **Step 3: Implement resolution/execution**

Restore Locator from the internal descriptor, require count exactly one, visibility/enabled state and allowed origin. Execute only with `ExecutionPermit`; map Playwright timeout to `{status:"failed",errorCode:"ActionTimedOut"}` and throw Browser infrastructure failures.

```ts
export class PlaywrightActionResolver implements ActionResolver {
  resolve(action: ProposedAction, graph: ObservationGraph): Promise<ResolvedAction>;
}
export class PlaywrightActionExecutor implements ActionExecutor {
  execute(action: ResolvedAction, permit: ExecutionPermit): Promise<ActionOutcome>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run the Task 3 command.

Expected: click changes the fixture state and every unsafe/stale case is rejected without click.

- [ ] **Step 5: Commit**

```text
git add packages/target-adapters/web-playwright tests/unit/target-adapters/web-playwright/action-resolution.test.ts tests/component/web-execution/playwright-click.test.ts
git commit -m "feat(web): resolve and execute safe playwright clicks"
```

### Task 4: Add facade, artifacts and Gate

**Files:**

- Create: `packages/target-adapters/web-playwright/src/playwright-web-target-adapter.ts`
- Test: `tests/component/web-execution/playwright-web-target.test.ts`
- Modify: `packages/target-adapters/web-playwright/src/index.ts`
- Modify: `tests/smoke/node-package-imports.mjs`

**Interfaces:** Produces the Design Spec facade implementing `Observer`, `ActionResolver`, `ActionExecutor`, `WebTargetSession`.

- [ ] **Step 1: Write the facade lifecycle test**

Open a page, capture, resolve Add button, create a real `ExecutionPermit` from an allowed decision, execute, recapture, obtain JSON/PNG bytes, close twice, and assert no operation succeeds after close.

```ts
const before = await adapter.capture(job);
const action = await adapter.resolve(click(nodeNamed(before, "Add to cart")), before);
expect(await adapter.execute(action, allowedPermit())).toEqual({ status: "ok" });
expect(await adapter.captureArtifacts(before.graphId)).toHaveLength(2);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/component/web-execution/playwright-web-target.test.ts`

Expected: facade is missing.

- [ ] **Step 3: Implement facade and screenshot artifacts**

Delegate rather than duplicate internal logic. `captureArtifacts(graphId)` returns `<ordinal>-observation.json` and `<ordinal>.png`, rejecting unknown graph IDs. Serialize operations through one promise queue and reject concurrent reentry with `ConcurrentSessionOperation`.

```ts
export class PlaywrightWebTargetAdapter
  implements Observer, ActionResolver, ActionExecutor, WebTargetSession {
  captureArtifacts(graphId: string): Promise<readonly CapturedArtifact[]>;
}
```

- [ ] **Step 4: Run LS-02 Gate**

```text
pnpm build
pnpm vitest run tests/unit/target-adapters/web-playwright tests/component/web-execution/playwright-*.test.ts
pnpm typecheck
pnpm smoke:node-imports
git diff --check
```

Expected: all commands exit 0 and the test process leaves no Chromium child.

- [ ] **Step 5: Commit and update status**

```text
git add packages/target-adapters/web-playwright tests docs/superpowers/implementation-status.md
git commit -m "feat(web): complete playwright target adapter"
```

## Plan Self-Review

- Spec coverage: lifecycle, semantic capture, node scoping, safe token, permit, same-origin, screenshot, concurrency, cleanup and errors map to Tasks 1–4.
- Placeholder scan: implementation behavior and negative tests are explicit.
- Type consistency: facade implements current Runner Kernel ports and exposes no Playwright type.
