import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SqliteRuntime,
  SqliteInvestigationStore,
  SqliteIntelligenceStore,
} from "@qualigence/sqlite-runtime";
import {
  InvestigationCase,
  InvestigationError,
  type InvestigationBudget,
} from "@qualigence/investigation";
import {
} from "@qualigence/review";
import type {
  AppliedEffect,
  IntelligenceJob,
  IntelligenceResult,
} from "@qualigence/intelligence";

const budget: InvestigationBudget = {
  maximumReproductionAttempts: 3,
  maximumPlanningRevisions: 5,
  maximumEnvironmentRetries: 3,
  maximumWallClockMs: 600_000,
  maximumModelTokens: 500_000,
  maximumEnvironmentResets: 5,
  maximumDestructiveActions: 2,
  confirmationConfidenceThreshold: 0.8,
};

const noUsage = {
  reproductionAttempts: 0,
  planningRevisions: 0,
  environmentRetries: 0,
  wallClockMs: 0,
  modelTokens: 0,
  environmentResets: 0,
  destructiveActions: 0,
};

function openCase(caseId = "case-1"): InvestigationCase {
  return InvestigationCase.open({
    caseId,
    findingId: "finding-1",
    projectId: "proj-1",
    budget,
  });
}

describe("SqliteInvestigationStore / SqliteIntelligenceStore", () => {
  let dir: string;
  let filename: string;
  let runtime: SqliteRuntime;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), ".tmp-inv-review-store-"));
    filename = join(dir, "qualigence.db");
    runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
  });

  afterEach(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips an investigation case with its attempts", async () => {
    const store = new SqliteInvestigationStore(runtime);
    const investigation = openCase();
    investigation.startInvestigation({ expectedVersion: 1, idempotencyKey: "k1" });
    investigation.startReproduction({ expectedVersion: 2, idempotencyKey: "k2" });
    investigation.appendAttempt({
      expectedVersion: 3,
      idempotencyKey: "k3",
      attempt: {
        attemptId: "attempt-1",
        environmentRef: "env-1",
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:05.000Z",
        outcome: "not_reproduced",
        evidenceRefs: ["evidence-1"],
        budgetConsumed: noUsage,
      },
    });

    await store.save(investigation, 0);
    const loaded = await store.load("case-1");
    expect(loaded).toBeDefined();
    expect(loaded?.status()).toBe(investigation.status());
    expect(loaded?.currentVersion()).toBe(investigation.currentVersion());
    expect(loaded?.reproductionAttempts()).toHaveLength(1);
    expect(loaded?.usage().reproductionAttempts).toBe(1);
  });

  it("rejects a stale optimistic-concurrency write", async () => {
    const store = new SqliteInvestigationStore(runtime);
    const investigation = openCase();
    investigation.startInvestigation({ expectedVersion: 1, idempotencyKey: "k1" });
    await store.save(investigation, 0);
    const storedVersion = investigation.currentVersion();

    investigation.startReproduction({
      expectedVersion: storedVersion,
      idempotencyKey: "k2",
    });

    // Saving with a stale expectedVersion (0, not the stored version) must fail.
    await expect(store.save(investigation, 0)).rejects.toBeInstanceOf(
      InvestigationError,
    );
    await expect(store.save(investigation, 0)).rejects.toThrow(
      "InvestigationVersionConflict",
    );

    // The correct expectedVersion succeeds.
    await store.save(investigation, storedVersion);
    const loaded = await store.load("case-1");
    expect(loaded?.status()).toBe("reproducing");
  });

  it("persists the budget ledger and reloads exhausted usage", async () => {
    const store = new SqliteInvestigationStore(runtime);
    const tight: InvestigationBudget = {
      ...budget,
      maximumReproductionAttempts: 1,
    };
    const investigation = InvestigationCase.open({
      caseId: "case-budget",
      findingId: "finding-1",
      projectId: "proj-1",
      budget: tight,
    });
    investigation.startInvestigation({ expectedVersion: 1, idempotencyKey: "k1" });
    investigation.startReproduction({ expectedVersion: 2, idempotencyKey: "k2" });
    investigation.appendAttempt({
      expectedVersion: 3,
      idempotencyKey: "k3",
      attempt: {
        attemptId: "attempt-1",
        environmentRef: "env-1",
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:05.000Z",
        outcome: "not_reproduced",
        evidenceRefs: [],
        budgetConsumed: noUsage,
      },
    });

    await store.save(investigation, 0);
    const loaded = await store.load("case-budget");
    expect(loaded?.status()).toBe("needs_human");
    expect(loaded?.handoff()).toBeDefined();
    expect(loaded?.usage().reproductionAttempts).toBe(1);
  });

  it("applies an intelligence result idempotently via the ledger", async () => {
    const store = new SqliteIntelligenceStore(runtime);
    const job: IntelligenceJob = {
      jobId: "job-1",
      jobType: "investigation.reproduction-planning",
      schemaVersion: "intelligence-job/v1",
      tenantId: "tenant-1",
      projectId: "proj-1",
      aggregateRef: { type: "investigation", id: "case-1" },
      baseAggregateVersion: 2,
      inputRefs: ["evidence-1"],
      modelProfileId: "model-a",
      dataPolicyId: "policy-1",
      budget: { maximumTokens: 1000, maximumCostMicros: 1000, timeoutMs: 1000 },
      priority: "normal",
      idempotencyKey: "job-key",
      causationId: "cause-1",
      expectedResultSchema: "intelligence-result/v1",
    };
    const result: IntelligenceResult = {
      jobId: "job-1",
      resultSchemaVersion: "intelligence-result/v1",
      proposals: [{ steps: [] }],
      evidenceRefs: ["evidence-1"],
      confidence: 0.9,
      provenance: ["model-a"],
      usage: { inputTokens: 10, outputTokens: 10, costMicros: 20 },
      terminalStatus: "succeeded",
      idempotencyKey: "job-key",
    };
    await store.saveJob(job);
    await store.saveResult(result);

    expect(await store.find("job-key")).toBeUndefined();

    const effect: AppliedEffect = {
      aggregateType: "investigation",
      aggregateId: "case-1",
      newVersion: 3,
      summary: "reproduction plan applied",
    };
    await store.record("job-key", effect);
    await store.record("job-key", { ...effect, newVersion: 99 });

    const found = await store.find("job-key");
    expect(found).toEqual(effect);
    expect(await store.job("job-1")).toMatchObject({ jobId: "job-1" });
  });

  it("reserves separate Evidence Capsule metadata tables for remote and local-only records", async () => {
    const tables = await runtime.db
      .selectFrom("sqlite_master")
      .select("name")
      .where("type", "=", "table")
      .where("name", "like", "evidence_%")
      .execute();
    const names = tables.map((row) => row.name).sort();
    expect(names).toEqual([
      "evidence_audit_events",
      "evidence_capsule_entries",
      "evidence_capsule_manifests",
      "evidence_encryption_profiles",
      "evidence_key_rotations",
      "evidence_local_only_records",
    ]);

    // A local-only record is stored in its own table and is never a manifest.
    await runtime.db
      .insertInto("evidence_local_only_records")
      .values({
        local_record_id: "local-1",
        tenant_id: "tenant-1",
        case_id: "case-1",
        run_id: "run-1",
        disposition: "local_only",
        reason: "kms_unavailable",
        local_content_refs_json: JSON.stringify(["artifact-1"]),
        created_at: "2026-08-01T00:00:00.000Z",
        expires_at: "2026-09-01T00:00:00.000Z",
      })
      .execute();

    const manifests = await runtime.db
      .selectFrom("evidence_capsule_manifests")
      .selectAll()
      .execute();
    expect(manifests).toEqual([]);
  });
});
