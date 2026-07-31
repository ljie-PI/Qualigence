# Model Error State Machine Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the M1 model error state machine so timeout retry, contract-parser faults, and Decision node references have deterministic, layer-owned behavior.

**Architecture:** Keep the existing packages and dependency direction. The OpenAI-compatible adapter classifies transport failures, Model Gateway separately controls provider retry and typed schema correction, Model Agent grounds semantic output in the current observation, and Runner Kernel consumes only its provider-neutral blocked signal.

**Tech Stack:** TypeScript 5, Vitest 4, Zod, OpenAI JavaScript SDK, pnpm workspace packages.

## Global Constraints

- Do not add packages, directories, public error codes, SDK dependencies in `contracts`, or a new architectural layer.
- `409` remains `InvalidRequest` and is never retried in M1.
- Only a `StructuredOutputValidationError` creates one schema-correction request; other parser exceptions propagate unchanged.
- Decision grounding is separate from the future Resolver locator/session-staleness validation.
- Tests live exclusively under `tests/`; run the build before Vitest because workspace tests import compiled package exports.

---

### Task 1: Isolate Gateway provider and parser error domains

**Files:**

- Modify: `packages/model-gateway/src/model-gateway.ts`
- Modify: `tests/unit/model-gateway/model-gateway.test.ts`

- [ ] **Step 1: Write a failing parser-defect regression test**

Add a contract whose `parse` throws a specific `TypeError("contract bug")` and a provider that returns one valid transport response. Assert the real `ModelGateway.invokeStructured` rejects with that exact error, the provider receives one request, and no correction message is sent. The production regression this detects is widening the provider catch around `output.parse`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node .\\node_modules\\typescript\\bin\\tsc -b; node .\\node_modules\\vitest\\vitest.mjs run tests/unit/model-gateway/model-gateway.test.ts`

Expected before implementation: failure because the current outer catch converts the `TypeError` to a provider error and retries.

- [ ] **Step 3: Make the minimal control-flow change**

Use one loop, but make two non-overlapping try/catch boundaries:

~~~ts
let response;
try {
  response = await provider.invoke(providerRequest);
} catch (error) {
  // Normalize/retry only Provider exceptions.
}

try {
  return toValidatedResult(output.parse(response.output), response);
} catch (error) {
  if (!isStructuredOutputValidationError(error)) throw error;
  // Add exactly one correction or throw InvalidStructuredOutput.
}
~~~

Do not alter the existing bounded backoff or sanitized correction summary.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node .\\node_modules\\typescript\\bin\\tsc -b; node .\\node_modules\\vitest\\vitest.mjs run tests/unit/model-gateway/model-gateway.test.ts`

Expected: the new generic-parser test and the existing typed-validation retry tests pass.

### Task 2: Classify HTTP 408 before generic client errors

**Files:**

- Modify: `packages/model-providers/openai-compatible/src/openai-compatible-model-provider.ts`
- Modify: `tests/contract/model-providers/openai-compatible-model-provider.test.ts`
- Modify: `tests/unit/model-gateway/model-gateway.test.ts`

- [ ] **Step 1: Write failing HTTP 408 contract coverage**

Add an HTTP-server table row with `statusCode: 408` and expected public result `{ code: "TimedOut", message: "The model provider request timed out." }`. Retain literal expectations for 400, 401, 429, and 500, and add 403/409 rows to lock the state matrix.

- [ ] **Step 2: Run the adapter contract test and verify RED**

Run: `node .\\node_modules\\typescript\\bin\\tsc -b; node .\\node_modules\\vitest\\vitest.mjs run tests/contract/model-providers/openai-compatible-model-provider.test.ts`

Expected before implementation: 408 is reported as `InvalidRequest`.

- [ ] **Step 3: Implement the precedence rule**

Classify `status === 408` as `TimedOut` before the generic `400 <= status < 500` branch. Preserve the existing SDK timeout mapping and leave 409 in the generic permanent branch.

- [ ] **Step 4: Confirm normalized timeout invokes existing retry policy**

Use the injected `ModelGateway` provider fake to return `TimedOut` twice and a success once. Assert a result is returned and retry delays are `[100, 200]`; retain the permanent-error tests that prove no retry for `InvalidRequest`.

- [ ] **Step 5: Run both focused suites and verify GREEN**

Run: `node .\\node_modules\\typescript\\bin\\tsc -b; node .\\node_modules\\vitest\\vitest.mjs run tests/contract/model-providers/openai-compatible-model-provider.test.ts tests/unit/model-gateway/model-gateway.test.ts`

Expected: 408 is `TimedOut`; 409 is `InvalidRequest`; only transient codes retry.

### Task 3: Ground Decision output in the current observation

**Files:**

- Modify: `packages/runner-components/model-agent/src/model-agent.ts`
- Modify: `tests/unit/runner-components/model-agent.test.ts`
- Modify: `tests/unit/runner-kernel/execution-runtime.test.ts`

- [ ] **Step 1: Write a failing Model Agent correction test**

Use the real `ModelGateway` and a scripted ModelProvider whose first decision names `node-unknown` and whose second decision names the observed `node-add`. Assert the returned proposal targets `node-add`, two requests occur, and the second request contains only the safe issue `action.nodeId:unknown_node_reference`. This catches the missing context-aware Decision validation.

- [ ] **Step 2: Run the focused Model Agent test and verify RED**

Run: `node .\\node_modules\\typescript\\bin\\tsc -b; node .\\node_modules\\vitest\\vitest.mjs run tests/unit/runner-components/model-agent.test.ts`

Expected before implementation: the first unknown `nodeId` is accepted without a correction request.

- [ ] **Step 3: Implement a context-aware Decision contract**

Replace the generic Decision `structuredContract` call with `decisionContract(context)`. It must parse the existing Zod schema and then verify the parsed nodeId appears in `context.observation.nodes`; otherwise throw the existing typed validation error with `{ path: "action.nodeId", reason: "unknown_node_reference" }`. Keep JSON schema generation identical.

- [ ] **Step 4: Write and run an exhausted-grounding runtime test**

Script two unknown Decision responses through `ModelBackedDecisionProvider` and `ExecutionRuntime`. Assert completion is `blocked`, stages are exactly `["observation", "run_completed"]`, and resolver, action executor, and verifier remain uncalled. This catches an invalid node reaching side-effecting stages.

- [ ] **Step 5: Run focused suites and verify GREEN**

Run: `node .\\node_modules\\typescript\\bin\\tsc -b; node .\\node_modules\\vitest\\vitest.mjs run tests/unit/runner-components/model-agent.test.ts tests/unit/runner-kernel/execution-runtime.test.ts`

Expected: valid observed nodes work unchanged; unknown nodes receive one correction then block without a finding or action.

### Task 4: Regression verification and PR follow-up

**Files:**

- Modify: `docs/superpowers/specs/2026-07-31-m1-real-web-vertical-slice-design.md`
- Create: `docs/superpowers/plans/2026-08-01-model-error-state-machine-hardening.md`

- [ ] **Step 1: Run complete local verification**

Run:

~~~text
node .\\node_modules\\typescript\\bin\\tsc -b
node .\\node_modules\\vitest\\vitest.mjs run
node .\\node_modules\\typescript\\bin\\tsc --noEmit -p tsconfig.test.json
node tests\\smoke\\node-package-imports.mjs
git diff --check
~~~

Expected: build, all tests, test typecheck, import smoke, and whitespace validation pass.

- [ ] **Step 2: Re-read PR threads against the final state machine**

Reply that HTTP 408 now maps to `TimedOut` before generic 4xx (with 409 intentionally permanent) and that generic parser exceptions now bypass retry/correction. Resolve only those threads after the corresponding implementation and tests are present.

- [ ] **Step 3: Commit and push the cohesive fix**

Stage only the source, tests, and two design/plan documents listed above. Use a single commit message describing model error-state hardening, then push `codex/m1-real-web-vertical-slice`.

## Plan Self-Review

- The error matrix assigns each failure to exactly one layer and prevents the Gateway from reclassifying contract defects as provider failures.
- Tests are behavior-focused: they observe retry/correction outcomes, externally normalized error codes, and the absence of forbidden runtime stages.
- The plan deliberately excludes resolver locator staleness, application infrastructure lifecycle, new providers, and any package restructuring.
