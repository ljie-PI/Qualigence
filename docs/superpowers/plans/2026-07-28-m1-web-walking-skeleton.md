# M1 Web Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first runnable local M1 skeleton that can execute one web-oriented job through Observation, Decision, Action, Verification, Trace, and Finding ingestion.

**Architecture:** TypeScript packages provide shared contracts, runner orchestration, and Core evidence ingestion. The first slice keeps infrastructure in memory so behavior is deterministic and covered by unit tests before SQLite, Fastify, Playwright, and gRPC are added.

**Tech Stack:** Node.js 24 LTS target, TypeScript 6.0.x, pnpm workspace, Vitest, pure TypeScript domain packages.

## Global Constraints

- Do not implement Qualigence Cloud.
- Local and Self-hosted must share domain contracts and module boundaries.
- Route A is selected: TypeScript-first for Core, Runner, Web, and Intelligence Worker.
- Rust/Tauri is reserved for M3 Desktop Companion and native system boundaries.
- No LangChain as core workflow, state, or retry layer.
- No Kafka, RabbitMQ, Redis, Temporal, or EventStoreDB in the first Local/Self-hosted closure.
- Do not use Node built-in `node:sqlite`.
- Unit tests must live under `tests/unit`, not beside source files.
- M3 Windows VM automation is out of scope; keep only the manual checklist document.
- Production code must be written after a failing test has been observed.

---

## File Structure

- Create `package.json`: root package scripts, Node engine, workspace dev dependencies.
- Create `pnpm-workspace.yaml`: workspace package discovery.
- Create `tsconfig.base.json`: shared compiler settings for all packages and tests.
- Create `vitest.config.ts`: root Vitest configuration with tests under `tests/`.
- Create `packages/shared-kernel/src/index.ts`: branded identifiers, clock, result, and domain event primitives.
- Create `packages/contracts/runner-protocol/src/index.ts`: M1 runner protocol DTOs, trace DTOs, action DTOs, and finding envelope.
- Create `packages/runner-kernel/src/index.ts`: public exports for runner kernel.
- Create `packages/runner-kernel/src/execution-runtime.ts`: deterministic Observe -> Decide -> Resolve -> Authorize -> Execute -> Verify -> Record pipeline.
- Create `packages/core-modules/evidence/src/index.ts`: public exports for evidence module.
- Create `packages/core-modules/evidence/src/trace-ingestor.ts`: trace ordering, duplicate, gap, and finding ingestion behavior.
- Create `tests/unit/runner-kernel/execution-runtime.test.ts`: M1 pipeline behavior tests.
- Create `tests/unit/core-modules/evidence/trace-ingestor.test.ts`: Core trace/finding ingestion behavior tests.

## Task 1: Workspace and Failing Runner Pipeline Test

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `tests/unit/runner-kernel/execution-runtime.test.ts`

**Interfaces:**
- Consumes: no production interfaces.
- Produces: expected runner public API names `ExecutionRuntime`, `InMemoryTraceRecorder`, `AllowAllRunnerPolicyGate`, and `ScriptedDecisionProvider`.

- [x] **Step 1: Add TypeScript workspace configuration**

```json
{
  "name": "qualigence",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.7.0",
  "engines": {
    "node": ">=24 <26"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.base.json"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^6.0.0",
    "vitest": "^4.0.0"
  }
}
```

- [x] **Step 2: Write the failing pipeline test**

```ts
import { describe, expect, it } from "vitest";
import {
  AllowAllRunnerPolicyGate,
  ExecutionRuntime,
  InMemoryTraceRecorder,
  ScriptedDecisionProvider,
} from "../../../packages/runner-kernel/src/index.js";

it("runs an accepted web job through all M1 stages and records trace in order", async () => {
  const traceRecorder = new InMemoryTraceRecorder();
  const runtime = new ExecutionRuntime({
    observer: {
      capture: async () => ({
        graphId: "graph-1",
        nodes: [{ id: "node-login", role: "button", name: "Login", confidence: 1 }],
      }),
    },
    decisionProvider: new ScriptedDecisionProvider({
      kind: "click",
      target: { nodeId: "node-login" },
      reason: "exercise first web action",
    }),
    resolver: {
      resolve: async (action, graph) => ({
        kind: "click",
        target: { nodeId: action.target.nodeId, selector: "text=Login" },
        graphId: graph.graphId,
      }),
    },
    policyGate: new AllowAllRunnerPolicyGate(),
    actionExecutor: {
      execute: async () => ({ status: "ok" }),
    },
    verifier: {
      verify: async () => ({ status: "passed", summary: "login button accepted click" }),
    },
    traceRecorder,
  });

  const completion = await runtime.run({
    jobId: "job-1",
    runId: "run-1",
    target: { kind: "web", url: "https://example.test" },
    objective: "Click login",
  });

  expect(completion.status).toBe("completed");
  expect(completion.finding.title).toBe("M1 verification passed");
  expect(traceRecorder.eventsFor("run-1").map((event) => event.stage)).toEqual([
    "observation",
    "decision",
    "action_resolved",
    "policy_authorized",
    "action_executed",
    "verification",
    "finding",
  ]);
});
```

- [x] **Step 3: Run the test and verify it fails**

Run: `pnpm install && pnpm test tests/unit/runner-kernel/execution-runtime.test.ts`

Expected: FAIL because `packages/runner-kernel/src/index.js` does not exist.

## Task 2: Minimal Runner Kernel

**Files:**
- Create: `packages/shared-kernel/src/index.ts`
- Create: `packages/contracts/runner-protocol/src/index.ts`
- Create: `packages/runner-kernel/src/index.ts`
- Create: `packages/runner-kernel/src/execution-runtime.ts`

**Interfaces:**
- Consumes: expected test API from Task 1.
- Produces: `ExecutionRuntime.run(job: AcceptedExecutionJob): Promise<ExecutionCompletion>` and trace event sequencing.

- [x] **Step 1: Implement shared and runner contract types**

Define M1 string-literal DTOs for `AcceptedExecutionJob`, `ObservationGraph`, `ProposedAction`, `ResolvedAction`, `PolicyDecision`, `ActionOutcome`, `VerificationResult`, `FindingEnvelope`, `TraceEvent`, and `ExecutionCompletion`.

- [x] **Step 2: Implement the minimal runtime pipeline**

`ExecutionRuntime.run` must call collaborators in this exact order: observe, decide, resolve, authorize, execute, verify, record finding.

- [x] **Step 3: Run the pipeline test**

Run: `pnpm test tests/unit/runner-kernel/execution-runtime.test.ts`

Expected: PASS.

## Task 3: Failing Core Trace and Finding Ingestion Tests

**Files:**
- Create: `tests/unit/core-modules/evidence/trace-ingestor.test.ts`

**Interfaces:**
- Consumes: `TraceIngestor` and `InMemoryTraceStore`.
- Produces: evidence module behavior for trace dedupe, gaps, conflicts, and finding ingestion.

- [x] **Step 1: Write tests for trace sequencing and finding acceptance**

```ts
import { describe, expect, it } from "vitest";
import { InMemoryTraceStore, TraceIngestor } from "../../../../packages/core-modules/evidence/src/index.js";

describe("TraceIngestor", () => {
  it("accepts a contiguous trace event and advances the cursor", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());

    const result = await ingestor.ingest({
      runId: "run-1",
      sequenceNumber: 1,
      stage: "observation",
      payloadHash: "hash-1",
      payload: { graphId: "graph-1" },
    });

    expect(result).toEqual({ status: "accepted", nextSequenceNumber: 2 });
  });

  it("accepts an exact duplicate without advancing incorrectly", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());
    const event = {
      runId: "run-1",
      sequenceNumber: 1,
      stage: "observation",
      payloadHash: "hash-1",
      payload: { graphId: "graph-1" },
    } as const;

    await ingestor.ingest(event);
    const duplicate = await ingestor.ingest(event);

    expect(duplicate).toEqual({ status: "duplicate", nextSequenceNumber: 2 });
  });

  it("rejects a conflicting duplicate at the same sequence number", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());

    await ingestor.ingest({
      runId: "run-1",
      sequenceNumber: 1,
      stage: "observation",
      payloadHash: "hash-1",
      payload: { graphId: "graph-1" },
    });

    const conflict = await ingestor.ingest({
      runId: "run-1",
      sequenceNumber: 1,
      stage: "observation",
      payloadHash: "hash-2",
      payload: { graphId: "graph-2" },
    });

    expect(conflict).toEqual({
      status: "integrity_violation",
      code: "TraceIntegrityViolation",
      existingPayloadHash: "hash-1",
    });
  });

  it("rejects a sequence gap with the expected sequence number", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());

    const result = await ingestor.ingest({
      runId: "run-1",
      sequenceNumber: 2,
      stage: "decision",
      payloadHash: "hash-2",
      payload: { kind: "click" },
    });

    expect(result).toEqual({
      status: "sequence_gap",
      code: "SequenceGap",
      expectedSequenceNumber: 1,
    });
  });

  it("stores a finding envelope after trace verification", async () => {
    const store = new InMemoryTraceStore();
    const ingestor = new TraceIngestor(store);

    await ingestor.ingestFinding({
      findingId: "finding-1",
      runId: "run-1",
      title: "M1 verification passed",
      severity: "info",
      evidenceRefs: [],
    });

    expect(store.findingsFor("run-1")).toEqual([
      {
        findingId: "finding-1",
        runId: "run-1",
        title: "M1 verification passed",
        severity: "info",
        evidenceRefs: [],
      },
    ]);
  });
});
```

- [x] **Step 2: Run the tests and verify they fail**

Run: `pnpm test tests/unit/core-modules/evidence/trace-ingestor.test.ts`

Expected: FAIL because the evidence module does not exist.

## Task 4: Minimal Core Evidence Module

**Files:**
- Create: `packages/core-modules/evidence/src/index.ts`
- Create: `packages/core-modules/evidence/src/trace-ingestor.ts`

**Interfaces:**
- Consumes: `TraceEvent` and `FindingEnvelope` from runner protocol contracts.
- Produces: `TraceIngestor.ingest`, `TraceIngestor.ingestFinding`, `InMemoryTraceStore.eventsFor`, and `InMemoryTraceStore.findingsFor`.

- [x] **Step 1: Implement in-memory trace store and ingestor**

Rules:

- First event for a run must have `sequenceNumber: 1`.
- Existing event with the same `sequenceNumber` and `payloadHash` returns `duplicate`.
- Existing event with the same `sequenceNumber` and a different `payloadHash` returns `integrity_violation`.
- New event after the current cursor returns `sequence_gap`.
- Accepted event advances `nextSequenceNumber` by one.

- [x] **Step 2: Run evidence tests**

Run: `pnpm test tests/unit/core-modules/evidence/trace-ingestor.test.ts`

Expected: PASS.

## Task 5: Whole Slice Verification and Commit

**Files:**
- Modify: all files from Tasks 1 through 4.

**Interfaces:**
- Consumes: all M1 public APIs created in this plan.
- Produces: a committed, runnable M1 local skeleton.

- [x] **Step 1: Run all tests**

Run: `pnpm test`

Expected: PASS.

- [x] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [x] **Step 3: Check whitespace**

Run: `git diff --check`

Expected: no output and exit code 0.

- [x] **Step 4: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts packages tests docs/superpowers/plans/2026-07-28-m1-web-walking-skeleton.md
git commit -m "feat: add M1 web walking skeleton"
```
