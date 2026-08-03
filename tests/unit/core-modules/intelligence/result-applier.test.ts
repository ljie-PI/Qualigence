import { describe, expect, it } from "vitest";
import {
  IntelligenceResultApplier,
  type AggregateVersionReader,
  type AppliedEffect,
  type AppliedResultLedger,
  type IntelligenceCommandExecutor,
  type IntelligenceJob,
  type IntelligenceResult,
} from "@qualigence/intelligence";

function job(overrides: Partial<IntelligenceJob> = {}): IntelligenceJob {
  return {
    jobId: "job-1",
    jobType: "investigation.reproduction-planning",
    schemaVersion: "intelligence-job/v1",
    tenantId: "tenant-1",
    projectId: "proj-1",
    aggregateRef: { type: "investigation", id: "case-1" },
    baseAggregateVersion: 3,
    inputRefs: ["evidence-1", "evidence-2"],
    modelProfileId: "model-a",
    dataPolicyId: "policy-1",
    budget: { maximumTokens: 10_000, maximumCostMicros: 50_000, timeoutMs: 60_000 },
    priority: "normal",
    idempotencyKey: "idem-1",
    causationId: "cause-1",
    expectedResultSchema: "intelligence-result/v1",
    ...overrides,
  };
}

function result(overrides: Partial<IntelligenceResult> = {}): IntelligenceResult {
  return {
    jobId: "job-1",
    resultSchemaVersion: "intelligence-result/v1",
    proposals: [{ kind: "reproduction-plan" }],
    evidenceRefs: ["evidence-1"],
    confidence: 0.9,
    provenance: ["model-a"],
    usage: { inputTokens: 100, outputTokens: 200, costMicros: 300 },
    terminalStatus: "succeeded",
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

class InMemoryLedger implements AppliedResultLedger {
  private readonly applied = new Map<string, AppliedEffect>();
  async find(idempotencyKey: string): Promise<AppliedEffect | undefined> {
    return this.applied.get(idempotencyKey);
  }
  async record(idempotencyKey: string, effect: AppliedEffect): Promise<void> {
    this.applied.set(idempotencyKey, effect);
  }
}

class FixedVersionReader implements AggregateVersionReader {
  constructor(private version: number | undefined) {}
  async currentVersion(): Promise<number | undefined> {
    return this.version;
  }
}

class CountingExecutor implements IntelligenceCommandExecutor {
  calls = 0;
  async execute(): Promise<AppliedEffect> {
    this.calls += 1;
    return {
      aggregateType: "investigation",
      aggregateId: "case-1",
      newVersion: 4,
      summary: "reproduction plan applied",
    };
  }
}

function applier(
  version: number | undefined = 3,
  executor: CountingExecutor = new CountingExecutor(),
  ledger: InMemoryLedger = new InMemoryLedger(),
) {
  return {
    executor,
    ledger,
    applier: new IntelligenceResultApplier({
      ledger,
      versions: new FixedVersionReader(version),
      executor,
    }),
  };
}

describe("IntelligenceResultApplier", () => {
  it("applies a valid result exactly once and is idempotent", async () => {
    const { applier: a, executor } = applier();
    const first = await a.apply(job(), result());
    expect(first).toMatchObject({ status: "applied" });
    const second = await a.apply(job(), result());
    expect(second).toMatchObject({ status: "duplicate" });
    // The deterministic command executor ran only once.
    expect(executor.calls).toBe(1);
  });

  it("returns recompute when the base aggregate version is stale", async () => {
    const { applier: a, executor } = applier(5); // current version moved to 5
    const stale = await a.apply(
      job({ baseAggregateVersion: 3, idempotencyKey: "idem-stale" }),
      result({ idempotencyKey: "idem-stale" }),
    );
    expect(stale).toMatchObject({ status: "recompute" });
    expect(executor.calls).toBe(0);
  });

  it("returns recompute when the aggregate does not exist", async () => {
    const executor = new CountingExecutor();
    const a = new IntelligenceResultApplier({
      ledger: new InMemoryLedger(),
      versions: new FixedVersionReader(undefined),
      executor,
    });
    const missing = await a.apply(job(), result());
    expect(missing.status).toBe("recompute");
    expect(executor.calls).toBe(0);
  });

  it("rejects a result over the token budget", async () => {
    const { applier: a } = applier();
    const rejected = await a.apply(
      job({ budget: { maximumTokens: 100, maximumCostMicros: 999, timeoutMs: 1 } }),
      result({ usage: { inputTokens: 90, outputTokens: 90, costMicros: 10 } }),
    );
    expect(rejected).toMatchObject({ status: "rejected", code: "BudgetExceeded" });
  });

  it("rejects a result over the cost budget", async () => {
    const { applier: a } = applier();
    const rejected = await a.apply(
      job({ budget: { maximumTokens: 10_000, maximumCostMicros: 100, timeoutMs: 1 } }),
      result({ usage: { inputTokens: 1, outputTokens: 1, costMicros: 500 } }),
    );
    expect(rejected).toMatchObject({ status: "rejected", code: "BudgetExceeded" });
  });

  it("rejects a schema-mismatched result", async () => {
    const { applier: a } = applier();
    const rejected = await a.apply(
      job(),
      result({ resultSchemaVersion: "intelligence-result/v0" as never }),
    );
    expect(rejected).toMatchObject({ status: "rejected", code: "SchemaInvalid" });
  });

  it("rejects a non-succeeded terminal status", async () => {
    const { applier: a } = applier();
    const rejected = await a.apply(
      job(),
      result({ terminalStatus: "blocked" }),
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      code: "TerminalNotSucceeded",
    });
  });

  it("rejects evidence not present among the job inputs", async () => {
    const { applier: a } = applier();
    const rejected = await a.apply(
      job(),
      result({ evidenceRefs: ["evidence-unknown"] }),
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      code: "EvidenceMismatch",
    });
  });

  it("consults an optional policy gate", async () => {
    const ledger = new InMemoryLedger();
    const executor = new CountingExecutor();
    const a = new IntelligenceResultApplier({
      ledger,
      versions: new FixedVersionReader(3),
      executor,
      policy: { allows: () => false },
    });
    const rejected = await a.apply(job(), result());
    expect(rejected).toMatchObject({
      status: "rejected",
      code: "PolicyViolation",
    });
    expect(executor.calls).toBe(0);
  });
});
