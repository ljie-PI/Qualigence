# M1 Real Web Vertical Slice Implementation Plan

> **实施状态说明（2026-08-01）：** Task 1–4 已在 PR #4 中实现并合并；Task 5–8 尚未实现，分别由 LS-01 至 LS-04 编号能力包继续细化。权威状态见 `docs/superpowers/implementation-status.md`，编号和依赖见 `docs/superpowers/roadmaps/2026-08-01-local-self-hosted-through-m3.md`。本文保留原始实施历史，不通过重命名或删除改写既有决策。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build a runnable local CLI that uses Playwright and a remote OpenAI-compatible model to detect the deterministic cart-total bug, then persists its trace, finding, model summary, and evidence locally.

**Architecture:** The CLI is a single-process composition root. It wires vendor-neutral model contracts, a Model Gateway, Playwright target components, the existing Runner Kernel, the in-memory Runner Protocol transport, SQLite Evidence storage, and file-backed artifacts. Execution behavior remains reusable through RunExecutionUseCase; CLI contains only parsing, composition, and output.

**Tech Stack:** Node.js 24–25, TypeScript 5.9, pnpm 11, Vitest 4, Playwright 1.62, OpenAI JavaScript SDK 6.48, Zod 4.4, Kysely 0.29, better-sqlite3 13, Commander, Fastify, and Pino.

## Global Constraints

- Implement Community Local only; do not add Cloud, web console, gRPC, Docker Compose, PostgreSQL, S3, Skill, PRD parsing, or Windows UIA.
- Keep tests only under the top-level tests directory.
- Keep the CLI single-process, but do not bypass Runner Protocol envelopes, hash validation, TraceIngestor, or ports.
- The only action type in this slice is click.
- The only real provider is a remote OpenAI-compatible endpoint; model keys come from environment or configuration, never command arguments.
- Model output selects nodeId and evidence node references only; it never supplies selectors, file paths, trace sequence numbers, or finding IDs.
- Run ordinary tests without real credentials. Live model smoke requires explicit environment configuration and is not part of the ordinary test command.
- Core and Runner domain packages must not import Playwright, OpenAI, Kysely, better-sqlite3, Fastify, or Commander.
- Apply TDD to every production behavior: add a failing test, observe the intended failure, add minimal implementation, and rerun the focused test.

---

## File Structure

- Modify: package.json — dependency versions, workspace scripts, and type packages.
- Modify: pnpm-workspace.yaml — discover the new package categories.
- Modify: tsconfig.json and tsconfig.test.json — project references for added packages and tests.
- Move: packages/adapters/in-memory-runner-protocol to packages/protocol-adapters/in-memory-runner-protocol — preserve the public package name.
- Create: packages/contracts/model-provider — provider-neutral model DTOs and port.
- Create: packages/model-gateway — capability checking, structured parsing, retry and normalized provider errors.
- Create: packages/model-providers/openai-compatible — OpenAI-compatible SDK adapter.
- Create: packages/runner-components/model-agent — Decision Provider and Verifier backed by Model Gateway.
- Create: packages/target-adapters/web-playwright — browser lifetime, semantic observation, node mapping, resolver, executor, and screenshot capture.
- Create: packages/storage-providers/sqlite-runtime — migrations, runs, trace/finding persistence, model invocation summaries, and artifact manifests.
- Create: packages/storage-providers/artifact-fs — atomic local artifact writes and SHA-256 manifests.
- Create: packages/execution-application — RunExecutionUseCase and adapters that enrich observations with artifacts.
- Create: apps/cli — command parsing, composition root, output, cleanup, and exit mapping.
- Create: tests/fixtures/web-cart — Fastify cart page with normal and wrong-total modes.
- Create: tests/unit, tests/contract, tests/component, tests/e2e, and tests/live files matching the packages above.

## Task 1: Move the in-memory protocol adapter into its final category

**Files:**

- Modify: pnpm-workspace.yaml
- Modify: tsconfig.json
- Modify: tsconfig.test.json
- Move: packages/adapters/in-memory-runner-protocol

**Interfaces:**

- Consumes: existing workspace package naming and NodeNext build configuration.
- Produces: the existing @qualigence/in-memory-runner-protocol public package from packages/protocol-adapters without changing its import path.

- [ ] **Step 1: Establish the public package baseline**

This task is a no-behavior-change package move, so it does not add a structure-only test. Run the existing build and Node import smoke to establish that the public @qualigence/in-memory-runner-protocol import works before the move.

- [ ] **Step 2: Run the existing baseline checks**

Run:

~~~text
pnpm build
pnpm smoke:node-imports
~~~

Expected: both commands pass before the move.

- [ ] **Step 3: Move the package and update project references**

Move the directory with git mv, retain package name and dist exports, add packages/protocol-adapters/* to pnpm-workspace.yaml, and replace the old path in tsconfig project references.

- [ ] **Step 4: Run workspace verification**

Run: pnpm build && pnpm smoke:node-imports

Expected: the existing workspace builds and the original import still succeeds from the new category directory.

## Task 2: Runner protocol and terminal execution semantics

**Files:**

- Modify: packages/contracts/runner-protocol/src/index.ts
- Modify: packages/runner-kernel/src/execution-runtime.ts
- Modify: packages/protocol-adapters/in-memory-runner-protocol/src/index.ts
- Modify: packages/testkit/src/index.ts
- Modify: tests/unit/runner-kernel/execution-runtime.test.ts
- Modify: tests/unit/core-modules/evidence/trace-ingestor.test.ts
- Modify: tests/type/trace-event-input.types.ts

**Interfaces:**

- Consumes: existing discriminated TraceEvent union and ExecutionRuntime ports.
- Produces: richer observation nodes, verification claims, run_completed trace events, and ExecutionCompletion status values passed, finding, blocked, and error.

- [ ] **Step 1: Write failing Runner tests for passed, finding, and blocked terminal traces**

Add tests that assert:

~~~ts
expect(events.map((event) => event.stage)).toEqual([
  "observation",
  "decision",
  "action_resolved",
  "policy_authorized",
  "action_executed",
  "observation",
  "verification",
  "run_completed",
]);

expect(findingCompletion.status).toBe("finding");
expect(blockedCompletion.status).toBe("blocked");
~~~

The failed-verification test must assert exactly one finding event before run_completed. The passed test must assert no finding event.

- [ ] **Step 2: Run Runner tests and observe the missing stage/status failure**

Run: pnpm test tests/unit/runner-kernel/execution-runtime.test.ts

Expected: failure because run_completed and the new completion states are absent.

- [ ] **Step 3: Extend protocol DTOs**

Add ObservationNode text, value, disabled, graph URL, title, capturedAt, and artifact references. Add VerificationEvidenceValue, VerificationClaim, discriminated VerificationTracePayload, RunCompletedTracePayload, and the run_completed TraceEvent union member. Make ExecutionCompletion distinguish passed, finding, blocked, and error.

- [ ] **Step 4: Update ExecutionRuntime minimally**

Record run_completed on each passed, finding, policy-blocked, and action-failed return path. An ActionOutcome with status failed returns blocked without observing or verifying again. Create a Finding only for a failed verification whose claims have been validated by its Verifier adapter. A policy denial returns blocked without a product Finding.

- [ ] **Step 5: Update recorder and type tests**

Extend discriminated switches in the in-memory recorder and testkit. Add compile-time assertions that run_completed accepts only RunCompletedTracePayload and verification accepts only the new union payload.

- [ ] **Step 6: Run focused and full protocol tests**

Run:

~~~text
pnpm test tests/unit/runner-kernel/execution-runtime.test.ts
pnpm test tests/unit/core-modules/evidence/trace-ingestor.test.ts
pnpm typecheck
~~~

Expected: all focused tests and types pass.

## Task 3: Model provider contract, gateway, and model-agent components

**Files:**

- Create: packages/contracts/model-provider/src/index.ts
- Create: packages/model-gateway/src/index.ts
- Create: packages/model-gateway/src/model-gateway.ts
- Create: packages/runner-components/model-agent/src/index.ts
- Create: packages/runner-components/model-agent/src/model-agent.ts
- Create: tests/unit/model-gateway/model-gateway.test.ts
- Create: tests/unit/runner-components/model-agent/model-agent.test.ts

**Interfaces:**

- Consumes: Runner AgentContext, VerificationContext, proposed click action, and new verification claim DTOs.
- Produces: ModelProvider, ModelGateway, StructuredOutputContract, ModelBackedDecisionProvider, and ModelBackedVerifier.

- [ ] **Step 1: Write failing ModelGateway tests**

Cover these concrete behaviors:

~~~ts
await expect(gateway.invokeStructured(request, contract)).rejects.toMatchObject({
  code: "CapabilityMismatch",
});

expect(provider.requests).toHaveLength(2);
expect(result.value).toEqual({ action: { kind: "click", nodeId: "add" }, reason: "..." });
~~~

Test one retry for invalid structured output, no retry for authentication failure, and a normalized timeout error.

- [ ] **Step 2: Run the ModelGateway test and observe the missing package failure**

Run: pnpm test tests/unit/model-gateway/model-gateway.test.ts

Expected: failure because @qualigence/model-gateway does not exist.

- [ ] **Step 3: Implement provider-neutral contracts**

Define ModelCapabilities, ModelProviderRequest, ModelProviderResponse, ModelProviderError, ModelUsage, JsonSchema, ModelProvider, StructuredModelRequest, StructuredOutputContract, StructuredOutputValidationIssue, StructuredOutputValidationError, and ValidatedModelResult. Do not import Zod or any provider SDK in this contract package.

- [ ] **Step 4: Implement ModelGateway**

Accept an injected provider and retry policy. Require structuredOutput capability. Invoke the provider with a JSON schema, parse with the supplied contract, retry one schema correction with bounded sanitized path/reason details, and retry up to two transient provider failures with an injected delay function. Return normalized error codes AuthenticationFailed, InvalidRequest, RateLimited, TimedOut, ProviderUnavailable, InvalidStructuredOutput, and CapabilityMismatch. InvalidRequest is permanent and is never retried.

- [ ] **Step 5: Write and run failing model-agent tests**

Make a fake ModelGateway return a DecisionProposal and a failed VerificationJudgment with before and after evidence refs. Assert the decision component never exposes a selector and the verifier preserves graphId/nodeId evidence references.

Run: pnpm test tests/unit/runner-components/model-agent/model-agent.test.ts

Expected: failure because ModelBackedDecisionProvider and ModelBackedVerifier do not exist.

- [ ] **Step 6: Implement model-agent components**

Map AgentContext to an execution.decision structured request. Map VerificationContext to an execution.verification request. Define Zod schemas locally in the model-agent package and expose their JSON schemas through the gateway contract. Reject passed results with claims, failed results with no claims, and empty visible evidence. Map exhausted InvalidStructuredOutput errors to the Runner Kernel's provider-neutral ExecutionBlockedError so ExecutionRuntime records a blocked terminal event; allow infrastructure errors to propagate to Task 7.

- [ ] **Step 7: Verify Task 3**

Run:

~~~text
pnpm test tests/unit/model-gateway/model-gateway.test.ts
pnpm test tests/unit/runner-components/model-agent/model-agent.test.ts
pnpm typecheck
~~~

Expected: all commands pass.

## Task 4: OpenAI-compatible provider adapter

**Files:**

- Create: packages/model-providers/openai-compatible/src/index.ts
- Create: packages/model-providers/openai-compatible/src/openai-compatible-model-provider.ts
- Create: tests/contract/model-providers/openai-compatible-model-provider.test.ts

**Interfaces:**

- Consumes: ModelProvider contract.
- Produces: OpenAICompatibleModelProvider that translates normalized messages, JSON schema, usage, finish reason, and provider errors.

- [ ] **Step 1: Write a local HTTP contract test**

Start a test HTTP server that captures the request body. Assert that the adapter sends the configured base URL, model, messages, and JSON schema, then maps a valid structured response into ModelProviderResponse. Add tests for permanent 400, 401, 429, 500, malformed or null content, and request abortion on timeout.

- [ ] **Step 2: Run the contract test and observe adapter import failure**

Run: pnpm test tests/contract/model-providers/openai-compatible-model-provider.test.ts

Expected: failure because the provider class does not exist.

- [ ] **Step 3: Implement the adapter**

Use the OpenAI JavaScript SDK with the configured baseURL and apiKey. Use the Chat Completions JSON schema response format so an OpenAI-compatible endpoint can serve the slice. Translate SDK exceptions into ModelProviderError without retaining secret values or raw prompts.

- [ ] **Step 4: Verify Task 4**

Run: pnpm test tests/contract/model-providers/openai-compatible-model-provider.test.ts

Expected: all adapter contract tests pass.

## Task 5: SQLite evidence and file-backed artifacts

**Files:**

- Create: packages/storage-providers/artifact-fs/src/index.ts
- Create: packages/storage-providers/artifact-fs/src/local-artifact-store.ts
- Create: packages/storage-providers/sqlite-runtime/src/index.ts
- Create: packages/storage-providers/sqlite-runtime/src/sqlite-evidence-store.ts
- Create: packages/storage-providers/sqlite-runtime/src/migrations.ts
- Create: tests/contract/artifact-fs/local-artifact-store.test.ts
- Create: tests/contract/sqlite/sqlite-evidence-store.test.ts

**Interfaces:**

- Consumes: Evidence TraceStore, FindingEnvelope, Artifact references, and model invocation summaries.
- Produces: LocalArtifactStore, SqliteEvidenceStore, SqliteRunStore, and migration runner.

- [ ] **Step 1: Write failing artifact contract tests**

Assert writeJson and writeBinary create a relative path, SHA-256, media type, size, and readable bytes. Assert a simulated write failure never returns an Artifact Manifest.

- [ ] **Step 2: Run artifact tests and observe missing store failure**

Run: pnpm test tests/contract/artifact-fs/local-artifact-store.test.ts

Expected: failure because @qualigence/artifact-fs is missing.

- [ ] **Step 3: Implement LocalArtifactStore**

Write each artifact into a run-specific directory using a temporary sibling file followed by rename. Hash the final bytes with SHA-256. Reject absolute artifact names and path traversal.

- [ ] **Step 4: Write failing SQLite contract tests**

Cover migration creation, a persisted run, accepted trace ordering, duplicate trace idempotency, Finding integrity, model invocation summary persistence, artifact manifest persistence, and reopening the database to read all records.

- [ ] **Step 5: Run SQLite tests and observe missing store failure**

Run: pnpm test tests/contract/sqlite/sqlite-evidence-store.test.ts

Expected: failure because SqliteEvidenceStore does not exist.

- [ ] **Step 6: Implement migrations and stores**

Create schema_migrations, execution_runs, trace_events, findings, artifact_manifests, and model_invocations. Enable foreign_keys, journal_mode WAL, and busy_timeout. Make TraceStore append semantics transactionally enforce sequence number and idempotency. Never persist raw prompts or raw provider responses.

- [ ] **Step 7: Verify Task 5**

Run:

~~~text
pnpm test tests/contract/artifact-fs/local-artifact-store.test.ts
pnpm test tests/contract/sqlite/sqlite-evidence-store.test.ts
pnpm typecheck
~~~

Expected: all storage tests and types pass.

## Task 6: Playwright web target adapter

**Files:**

- Create: packages/target-adapters/web-playwright/src/index.ts
- Create: packages/target-adapters/web-playwright/src/playwright-web-driver.ts
- Create: tests/component/web-execution/playwright-web-driver.test.ts

**Interfaces:**

- Consumes: Runner Observer, ActionResolver, ActionExecutor, and ExecutionPermit interfaces.
- Produces: PlaywrightWebDriver that owns browser/page lifetime, semantic observations, stable per-graph node mapping, click resolution, action execution, and screenshots.

- [ ] **Step 1: Write a failing browser component test**

Serve a minimal page containing a $19 product, an Add to cart button, and an observed total. Assert capture returns role, name, text, URL, title, and graphId. Resolve the returned add button nodeId, execute with a permit, capture again, and assert the total text changed.

- [ ] **Step 2: Run the component test and observe missing driver failure**

Run: pnpm test tests/component/web-execution/playwright-web-driver.test.ts

Expected: failure because PlaywrightWebDriver does not exist.

- [ ] **Step 3: Implement PlaywrightWebDriver**

Launch Chromium on first capture. Observe buttons, role=button elements, and elements marked data-qualigence-observe. Assign node IDs scoped to graphId and preserve an in-memory Locator mapping. Click only a locator resolved from the current graph. Expose captureScreenshot and close methods for the application layer.

- [ ] **Step 4: Verify Task 6**

Run: pnpm test tests/component/web-execution/playwright-web-driver.test.ts

Expected: browser component test passes after Chromium is installed.

## Task 7: Execution application and CLI

**Files:**

- Create: packages/execution-application/src/index.ts
- Create: packages/execution-application/src/run-execution-use-case.ts
- Create: packages/execution-application/src/artifact-recording-observer.ts
- Create: apps/cli/src/index.ts
- Create: apps/cli/src/local-run-composition-root.ts
- Create: tests/component/web-execution/run-execution-use-case.test.ts
- Create: tests/unit/cli/exit-code.test.ts

**Interfaces:**

- Consumes: ExecutionRuntime, Model Gateway components, PlaywrightWebDriver, InMemoryProtocolTraceRecorder, TraceIngestor, SqliteEvidenceStore, and LocalArtifactStore.
- Produces: RunExecutionUseCase, stable RunExecutionResult, CLI JSON/human output, cleanup semantics, and exit-code mapping.

- [ ] **Step 1: Write failing application tests**

Assert a failing verification produces status finding, a persisted Finding with artifact references, one run_completed trace, and browser close in finally. Assert a policy/invalid-node scenario returns blocked without a product Finding. Assert an infrastructure exception returns error without a Finding.

- [ ] **Step 2: Run application tests and observe missing use-case failure**

Run: pnpm test tests/component/web-execution/run-execution-use-case.test.ts

Expected: failure because RunExecutionUseCase does not exist.

- [ ] **Step 3: Implement RunExecutionUseCase**

Create the run row, wrap the Playwright observer so each capture writes observation JSON and screenshot artifacts, run ExecutionRuntime through the protocol adapter, record model summaries, map terminal results, and close browser/database in finally. Attempt run_completed for created runs; if persistence itself fails, return error with a sanitized code.

- [ ] **Step 4: Write failing CLI tests**

Assert missing model configuration maps to exit code 3, a passed RunExecutionResult maps to 0, finding to 1, blocked to 2, and error to 3. Assert JSON output is exactly one serialized RunExecutionResult line.

- [ ] **Step 5: Run CLI tests and observe missing app failure**

Run: pnpm test tests/unit/cli/exit-code.test.ts

Expected: failure because the CLI module does not exist.

- [ ] **Step 6: Implement CLI and composition root**

Use Commander to parse run, url, objective, output, and headed. Read model configuration only from environment. Validate an http or https URL. Compose concrete adapters and print human or JSON output. Route Pino logs to stderr and result output to stdout.

- [ ] **Step 7: Verify Task 7**

Run:

~~~text
pnpm test tests/component/web-execution/run-execution-use-case.test.ts
pnpm test tests/unit/cli/exit-code.test.ts
pnpm typecheck
~~~

Expected: all application and CLI tests pass.

## Task 8: Cart fixture, CLI E2E, Live Smoke, and full verification

**Files:**

- Create: tests/fixtures/web-cart/server.ts
- Create: tests/fixtures/openai-compatible-mock-server.ts
- Create: tests/e2e/cli-web-cart.test.ts
- Create: tests/live/remote-model-smoke.test.ts
- Modify: package.json
- Modify: README.md
- Modify: tests/smoke/node-package-imports.mjs

**Interfaces:**

- Consumes: built CLI, environment-based model configuration, SQLite, artifact directories, and the OpenAI-compatible transport contract.
- Produces: deterministic normal/fault CLI E2E and explicit opt-in live smoke coverage.

- [ ] **Step 1: Write the failing CLI E2E**

Start the cart fixture in normal and fault modes and a mock OpenAI-compatible HTTP server. Spawn the built CLI with temporary QUALIGENCE_DATA_DIR and mock model variables. Assert normal mode exits 0 with passed JSON. Assert fault mode exits 1 with a finding containing $19 and $29, then reopen SQLite and assert before/after artifacts and a single run_completed event.

- [ ] **Step 2: Run the E2E and observe missing fixture or CLI behavior failure**

Run: pnpm test tests/e2e/cli-web-cart.test.ts

Expected: failure until Fixture, mock server, and CLI composition are present.

- [ ] **Step 3: Implement the Fixture and mock provider server**

Use Fastify to serve a product price, add button, and cart total. Normal mode yields $19 after click; fault mode yields $29. The mock model server derives the add-button nodeId from the Decision request and derives expected/observed evidence refs from the Verification request.

- [ ] **Step 4: Add Live Smoke**

Skip unless QUALIGENCE_LIVE_MODEL_SMOKE equals true and all model configuration variables are present. Use the fault Fixture and assert only structurally valid finding evidence; do not assert generated prose.

- [ ] **Step 5: Add scripts and usage documentation**

Add test:e2e, test:live, and cli scripts. Document browser installation, configuration variables, run command, artifact directory, exit codes, and the fact that normal CI uses a mock endpoint.

- [ ] **Step 6: Run the complete verification suite**

Run:

~~~text
pnpm install
pnpm exec playwright install chromium
pnpm test
pnpm typecheck
pnpm smoke:node-imports
pnpm test:e2e
git diff --check
~~~

Expected: all commands pass. Do not run test:live without explicit remote-model credentials.

- [ ] **Step 7: Commit the finished slice**

~~~text
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.test.json apps packages tests README.md docs/superpowers/plans/2026-07-31-m1-real-web-vertical-slice.md
git commit -m "feat: add real web vertical slice"
~~~

## Plan Self-Review

- Spec coverage: Tasks 1–8 cover the package taxonomy, terminal protocol, Model Gateway, one remote provider, semantic Playwright click, SQLite and artifact evidence, shared execution use case, CLI, cart Fixture, deterministic E2E, opt-in live smoke, security boundaries, and M1 hardening exclusions.
- Placeholder scan: no TBD, TODO, deferred implementation instruction, or unspecified error-handling step remains.
- Type consistency: ModelProvider feeds ModelGateway; ModelBackedDecisionProvider and ModelBackedVerifier implement Runner ports; PlaywrightWebDriver implements target ports; RunExecutionUseCase composes the concrete implementations; CLI invokes only RunExecutionUseCase.
