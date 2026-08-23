import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlitePrdMissionStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import { PrdDocument, sha256Hex } from "@qualigence/context-intake";
import type { PrdSourceRef } from "@qualigence/context-intake";
import { TestPlanProposalValidator } from "@qualigence/application-model";
import {
  approveTestPlan,
  createDraftTestPlan,
  MissionCompiler,
} from "@qualigence/mission";
import type {
  CompiledMission,
  MissionDispatchDescriptor,
  TargetCapabilitySummary,
  TestMission,
  TestPlanRevision,
} from "@qualigence/mission";
import type { Clock } from "@qualigence/shared-kernel";
import "./mission-scheduling-store.contract.js";

const fixedClock: Clock = { now: () => "2026-08-01T00:00:00.000Z" };

const CONTENT = "Cart total equals the sum of item prices. Checkout is enabled.";

const prdDocument = PrdDocument.create(
  { prdId: "prd-1", revision: 1, projectId: "proj-1", title: "Cart", content: CONTENT },
  fixedClock,
);

function refFor(quote: string): PrdSourceRef {
  const startOffset = CONTENT.indexOf(quote);
  if (startOffset < 0) throw new Error(`quote not found: ${quote}`);
  return {
    prdId: prdDocument.prdId,
    revision: prdDocument.revision,
    startOffset,
    endOffset: startOffset + quote.length,
    quotedTextSha256: sha256Hex(quote),
  };
}

const groundedRef = refFor("Cart total equals the sum of item prices.");

function sequentialIds(prefix = "id"): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

function approvedPlan(): TestPlanRevision {
  const validator = new TestPlanProposalValidator();
  const validated = validator.validate(prdDocument, {
    expectedClaims: [
      {
        semanticKey: "cart-total",
        statement: "Cart total equals the sum of item prices.",
        sourceRefs: [groundedRef],
        confidence: 0.9,
      },
    ],
    testCases: [
      {
        title: "Add item and verify total",
        objective: "Ensure the cart total reflects item prices.",
        preconditions: ["A product is available."],
        steps: [
          { kind: "navigate", path: "/cart" },
          { kind: "click", target: { role: "button", name: "Add to cart", purpose: "add item" } },
          { kind: "verify", claimSemanticKeys: ["cart-total"] },
        ],
        expectedClaimSemanticKeys: ["cart-total"],
        sourceRefs: [groundedRef],
        priority: "high",
      },
    ],
  });
  if (!validated.ok) throw new Error(validated.error.reason);

  const draft = createDraftTestPlan(
    {
      projectId: "proj-1",
      prdId: prdDocument.prdId,
      prdRevision: prdDocument.revision,
      proposal: validated.value,
    },
    sequentialIds("plan"),
  );
  if (!draft.ok) throw new Error(draft.error.code);

  const approval = approveTestPlan(
    draft.value,
    { expectedVersion: 1, reviewerId: "reviewer-1", idempotencyKey: "approve-1" },
    fixedClock,
  );
  if (!approval.ok) throw new Error(approval.error.code);
  return approval.value;
}

const webTarget: TargetCapabilitySummary = {
  targetId: "target-web",
  targetVersion: 1,
  targetSnapshotHash: "target-hash",
  supportedStepKinds: ["navigate", "click", "verify"],
  capabilities: ["web.navigate", "web.click", "web.assert"],
};

function mission(): TestMission {
  return {
    missionId: "mission-1",
    projectId: "proj-1",
    revision: 1,
    targetId: "target-web",
    testCaseIds: ["tc-1"],
    executionBudget: {
      maximumJobs: 10,
      maximumStepsPerJob: 20,
      maximumWallClockMs: 60_000,
      maximumModelTokens: 100_000,
      stopOnBlockedTestCase: true,
    },
    executionPolicy: { policyId: "policy-mission", environment: "staging", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-01T00:01:00.000Z" },
    status: "approved",
  };
}

function compiledMission(plan: TestPlanRevision): CompiledMission {
  const result = new MissionCompiler().compile(plan, mission(), webTarget);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function dispatch(plan: TestPlanRevision): MissionDispatchDescriptor {
  return {
    targetUrl: "https://example.test/",
    modelProfileId: "default",
    headed: false,
    navigationTimeoutMs: 20_000,
    actionTimeoutMs: 15_000,
    binding: {
      targetId: webTarget.targetId,
      targetVersion: webTarget.targetVersion,
      targetSnapshotHash: webTarget.targetSnapshotHash,
      runnerId: "runner-1",
      planVersion: plan.version,
      planSnapshotHash: sha256Hex(JSON.stringify(plan)),
      configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" },
    },
  };
}

let dir: string;
let filename: string;

beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), ".tmp-prd-mission-"));
  filename = join(dir, "qualigence.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function open(): Promise<SqliteRuntime> {
  return SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
}

async function seed(store: SqlitePrdMissionStore, plan: TestPlanRevision) {
  await store.savePrdDocument(prdDocument);
  await store.saveTestPlanRevision(plan);
  await store.saveCompiledMission({
    mission: compiledMission(plan),
    projectId: "proj-1",
    planId: plan.planId,
    prdId: prdDocument.prdId,
    prdRevision: prdDocument.revision,
    dispatch: dispatch(plan),
    stopOnBlockedTestCase: true,
  });
}

describe("SqlitePrdMissionStore", () => {
  it("creates the PRD bridge and additive Mission scheduling tables", async () => {
    const runtime = await open();
    const rows = await runtime.db
      .selectFrom("sqlite_master")
      .select("name")
      .where("type", "=", "table")
      .execute();
    const names = new Set(rows.map((row) => row.name));
    for (const table of [
      "prd_documents",
      "test_plan_revisions",
      "expected_claims",
      "test_cases",
      "missions",
      "mission_revisions",
      "execution_jobs",
      "execution_job_attempts",
      "mission_scheduling_heads",
      "mission_start_commands",
      "mission_job_attempts",
      "runner_execution_jobs",
      "mission_execution_provenance",
      "mission_dispatch_outbox",
      "mission_dispatch_wakeups",
    ]) {
      expect(names.has(table), `missing table ${table}`).toBe(true);
    }
    await runtime.close();
  });

  it("persists a dispatchable mission with source-grounded jobs", async () => {
    const runtime = await open();
    const store = new SqlitePrdMissionStore(runtime);
    const plan = approvedPlan();
    await seed(store, plan);

    const loaded = await store.loadMissionForDispatch("mission-1");
    expect(loaded).toBeDefined();
    expect(loaded?.prdRevision).toBe(1);
    expect(loaded?.projectId).toBe("proj-1");
    expect(loaded?.executionPolicy).toEqual(mission().executionPolicy);
    expect(loaded?.planId).toBe(plan.planId);
    expect(loaded?.dispatch.binding).toMatchObject({
      planVersion: plan.version,
      planSnapshotHash: sha256Hex(JSON.stringify(plan)),
      targetVersion: webTarget.targetVersion,
      targetSnapshotHash: webTarget.targetSnapshotHash,
    });
    expect(loaded?.dispatch.targetUrl).toBe("https://example.test/");
    expect(loaded?.jobs).toHaveLength(1);
    const job = loaded?.jobs[0];
    expect(job?.objective).toBe("Ensure the cart total reflects item prices.");
    expect(job?.status).toBe("queued");
    expect(job?.sourceRefs[0]?.revision).toBe(1);
    expect(job?.sourceRefs[0]?.quotedTextSha256).toBe(groundedRef.quotedTextSha256);
    await expect(store.loadMissionForScheduling("mission-1")).resolves.toMatchObject({
      planId: plan.planId,
      planVersion: plan.version,
      planSnapshotHash: sha256Hex(JSON.stringify(plan)),
      targetVersion: 1,
      targetSnapshotHash: "target-hash",
    });
    await runtime.close();
  });

  it("records attempts and durable provenance readable after reopen", async () => {
    const first = await open();
    const store = new SqlitePrdMissionStore(first);
    const plan = approvedPlan();
    await seed(store, plan);

    const loaded = await store.loadMissionForDispatch("mission-1");
    const jobId = loaded!.jobs[0]!.jobId;

    await store.setMissionStatus("mission-1", 1, "running");
    await store.recordJobAttempt({
      attemptId: "attempt-1",
      jobId,
      missionId: "mission-1",
      runId: "run-1",
      status: "passed",
      createdAt: fixedClock.now(),
    });
    await store.setJobStatus(jobId, "completed");
    await store.setMissionStatus("mission-1", 1, "completed");
    await first.close();

    const second = await open();
    const reopened = new SqlitePrdMissionStore(second);
    const record = await reopened.loadMissionExecution("mission-1");
    expect(record).toBeDefined();
    expect(record?.status).toBe("completed");
    expect(record?.prdId).toBe(prdDocument.prdId);
    expect(record?.prdRevision).toBe(1);
    expect(record?.projectId).toBe("proj-1");
    expect(record?.jobs).toHaveLength(1);
    const job = record?.jobs[0];
    expect(job?.status).toBe("completed");
    expect(job?.attempts).toHaveLength(1);
    expect(job?.attempts[0]?.runId).toBe("run-1");
    // Provenance chain back to the originating PRD source range and hash.
    expect(job?.sourceRefs[0]?.quotedTextSha256).toBe(groundedRef.quotedTextSha256);
    expect(job?.sourceRefs[0]?.startOffset).toBe(groundedRef.startOffset);
    await second.close();
  });

  it("is idempotent on repeated saves of the same compiled mission", async () => {
    const runtime = await open();
    const store = new SqlitePrdMissionStore(runtime);
    const plan = approvedPlan();
    await seed(store, plan);
    await expect(seed(store, plan)).resolves.toBeUndefined();

    const loaded = await store.loadMissionForDispatch("mission-1");
    expect(loaded?.jobs).toHaveLength(1);
    await runtime.close();
  });

  it("rejects a persistence scope that disagrees with immutable compiled project provenance", async () => {
    const runtime = await open();
    const store = new SqlitePrdMissionStore(runtime);
    const plan = approvedPlan();
    await expect(store.saveCompiledMission({
      mission: compiledMission(plan),
      projectId: "other-project",
      planId: plan.planId,
      prdId: prdDocument.prdId,
      prdRevision: prdDocument.revision,
      dispatch: dispatch(plan),
      stopOnBlockedTestCase: true,
    })).rejects.toThrow(/provenance/);
    await runtime.close();
  });

  it("rejects a dispatch binding that disagrees with immutable Plan and Target provenance", async () => {
    const runtime = await open();
    const store = new SqlitePrdMissionStore(runtime);
    const plan = approvedPlan();
    await expect(store.saveCompiledMission({
      mission: compiledMission(plan),
      projectId: "proj-1",
      planId: plan.planId,
      prdId: prdDocument.prdId,
      prdRevision: prdDocument.revision,
      dispatch: { ...dispatch(plan), binding: { ...dispatch(plan).binding!, planSnapshotHash: "stale-plan-hash" } },
      stopOnBlockedTestCase: true,
    })).rejects.toThrow(/provenance/);
    await runtime.close();
  });
});
