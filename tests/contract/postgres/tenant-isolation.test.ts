import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  canonicalTraceEventHash,
  type TraceEvent,
  type TraceEventHashInput,
} from "@qualigence/runner-protocol";
import {
  MissionSchedulingService,
  type MissionSchedulingIds,
} from "@qualigence/mission";
import {
  createPostgresRuntime,
  OperationScopedPostgresRunnerControlStore,
  PostgresPrdMissionRepository,
  PostgresTraceStore,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { dockerAvailable } from "../../helpers/docker-container.js";
import {
  executionRunRow,
  intelligenceJobRow,
  setupPostgresFixture,
  type PostgresFixture,
} from "../../helpers/postgres-fixture.js";
import { observationGraphV1 } from "../../helpers/observation-graph-v1.js";
import { schedulingFixture } from "../mission/prd-mission-repository.contract.js";

const { Client } = pg;

describe.skipIf(!dockerAvailable())("PostgreSQL tenant isolation", () => {
  let fixture: PostgresFixture;
  let runtime: TenantTransactionProvider;

  beforeAll(async () => {
    fixture = await setupPostgresFixture();
    runtime = createPostgresRuntime(fixture.serverConfig);
    // Seed a row owned by tenant-a.
    await runtime.withTenant("tenant-a", async ({ db }) => {
      await db
        .insertInto("execution_runs")
        .values(executionRunRow({ tenantId: "tenant-a", runId: "run-a" }) as never)
        .execute();
      await db
        .insertInto("intelligence_jobs")
        .values(intelligenceJobRow({ tenantId: "tenant-a", runId: "run-a" }) as never)
        .execute();
    });
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    await fixture?.stop();
  });

  it("hides another tenant's rows even with the correct primary key", async () => {
    const found = await runtime.withTenant("tenant-b", async ({ db }) => {
      return db
        .selectFrom("execution_runs")
        .selectAll()
        .where("run_id", "=", "run-a")
        .executeTakeFirst();
    });
    expect(found).toBeUndefined();
  });

  it("returns zero rows when no tenant context is set", async () => {
    const client = new Client(fixture.serverConfig);
    await client.connect();
    try {
      const result = await client.query("select count(*)::int as count from execution_runs");
      expect(result.rows[0].count).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("rejects a write whose tenant_id does not match the context", async () => {
    await expect(
      runtime.withTenant("tenant-b", async ({ db }) => {
        await db
          .insertInto("execution_runs")
          .values(executionRunRow({ tenantId: "tenant-a", runId: "run-x" }) as never)
          .execute();
      }),
    ).rejects.toThrow();
  });

  it("opens runner-control operations as tenant-scoped transactions without leaking across tenants", async () => {
    const tenantAStore = new OperationScopedPostgresRunnerControlStore(runtime, "tenant-a");
    const tenantBStore = new OperationScopedPostgresRunnerControlStore(runtime, "tenant-b");

    await tenantAStore.saveSession({
      sessionId: "runner-same-session-a",
      runnerId: "runner-same",
      certificateFingerprint: "fp-tenant-a",
      capabilities: ["target:web-playwright"],
      protocolMajor: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    await tenantBStore.saveSession({
      sessionId: "runner-same-session-b",
      runnerId: "runner-same",
      certificateFingerprint: "fp-tenant-b",
      capabilities: ["target:web-playwright"],
      protocolMajor: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    const [tenantARows, tenantBRows] = await Promise.all([
      runtime.withTenant("tenant-a", ({ db }) => db.selectFrom("runner_sessions").select(["tenant_id", "runner_id", "session_id"]).where("runner_id", "=", "runner-same").execute()),
      runtime.withTenant("tenant-b", ({ db }) => db.selectFrom("runner_sessions").select(["tenant_id", "runner_id", "session_id"]).where("runner_id", "=", "runner-same").execute()),
    ]);

    expect(tenantARows).toEqual([{ tenant_id: "tenant-a", runner_id: "runner-same", session_id: "runner-same-session-a" }]);
    expect(tenantBRows).toEqual([{ tenant_id: "tenant-b", runner_id: "runner-same", session_id: "runner-same-session-b" }]);
  });

  it("accepts the first Runner Trace event for a Mission-scheduled run and rejects gaps", async () => {
    const tenantId = "tenant-trace-sequence";
    await runtime.withTenant(tenantId, async ({ db }) => {
      await seedMissionForTrace(db, tenantId, "trace-sequence");
      const scheduling = new MissionSchedulingService(
        new PostgresPrdMissionRepository(db, tenantId),
        ids("trace-sequence"),
        { now: () => "2026-08-22T00:00:00.000Z" },
      );

      const scheduled = await scheduling.start({
        missionId: schedulingFixture("trace-sequence").missionId,
        expectedVersion: 1,
        idempotencyKey: "start-trace-sequence",
      });
      const scheduledRun = scheduled.runs[0];
      expect(scheduledRun).toMatchObject({ runId: "run-trace-sequence" });
      const runId = scheduledRun!.runId;

      const createdRun = await db
        .selectFrom("execution_runs")
        .select("next_sequence_number")
        .where("tenant_id", "=", tenantId)
        .where("run_id", "=", runId)
        .executeTakeFirstOrThrow();
      expect(createdRun.next_sequence_number).toBe(1);

      const trace = new PostgresTraceStore(db, tenantId);
      await expect(trace.appendTraceEvent(traceEvent(runId, 1))).resolves.toMatchObject({
        status: "accepted",
        nextSequenceNumber: 2,
      });
      await expect(trace.appendTraceEvent(traceEvent(runId, 3))).resolves.toMatchObject({
        status: "sequence_gap",
        code: "SequenceGap",
        expectedSequenceNumber: 2,
      });
      await expect(trace.nextTraceSequenceNumber(runId)).resolves.toBe(2);
    });
  });

  it("rejects an insert when no tenant context is set", async () => {
    const client = new Client(fixture.serverConfig);
    await client.connect();
    try {
      await expect(
        client.query(
          `insert into execution_runs
             (tenant_id, run_id, job_id, target_kind, objective, status, next_sequence_number, created_at)
           values ('tenant-a', 'run-y', 'job-y', 'web', 'x', 'running', 0, '2026-08-01T00:00:00.000Z')`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.end();
    }
  });

  it("runs the Server role as a non-owner without BYPASSRLS or superuser", async () => {
    const client = new Client(fixture.adminConfig);
    await client.connect();
    try {
      const role = await client.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        "select rolsuper, rolbypassrls from pg_roles where rolname = $1",
        [fixture.serverConfig.user],
      );
      expect(role.rows[0]?.rolsuper).toBe(false);
      expect(role.rows[0]?.rolbypassrls).toBe(false);

      const owner = await client.query<{ owner: string }>(
        `select tableowner as owner from pg_tables
           where schemaname = 'public' and tablename = 'execution_runs'`,
      );
      expect(owner.rows[0]?.owner).not.toBe(fixture.serverConfig.user);
    } finally {
      await client.end();
    }
  });

  it("denies the Worker role access to aggregate, review and evidence tables", async () => {
    const client = new Client(fixture.workerConfig);
    await client.connect();
    try {
      for (const table of [
        "execution_runs",
        "review_tasks",
        "evidence_capsule_manifests",
        "investigation_cases",
      ]) {
        await expect(
          client.query(`select * from ${table}`),
        ).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await client.end();
    }
  });

  it("denies raw Worker reads of Intelligence Jobs while preserving lease operations", async () => {
    const client = new Client(fixture.workerConfig);
    await client.connect();
    try {
      await expect(
        client.query("select job_id, tenant_id from intelligence_jobs"),
      ).rejects.toMatchObject({ code: "42501" });

      const result = await client.query(
        "select job_json, attempt, expires_at from worker_claim_intelligence_lease($1::text[], $2::text, $3::text, $4::integer)",
        [["reproduce"], "worker-isolation", "token-hash", 60_000],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ attempt: 1 });
      expect(result.rows[0].expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await client.end();
    }
  });

  it("forbids the Worker role from writing raw Server-consumed Intelligence Results", async () => {
    const client = new Client(fixture.workerConfig);
    await client.connect();
    try {
      // Worker has no grant on intelligence_applied_results or on the legacy raw
      // results table; accepted proposals must go through the fenced append
      // function that records intelligence_result_inbox metadata.
      await expect(
        client.query("select * from intelligence_applied_results"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        client.query(
          `insert into intelligence_results
             (tenant_id, idempotency_key, job_id, terminal_status, confidence, result_json, created_at)
           values ('tenant-a', 'forged-result', 'job-a', 'succeeded', 1, '{}', now()::text)`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        client.query(
          `insert into intelligence_result_inbox
             (tenant_id, idempotency_key, job_id, worker_id, lease_attempt, lease_token_hash,
              lease_expires_at, base_aggregate_version, result_hash, result_json, accepted_at)
           values ('tenant-a', 'forged-inbox', 'job-a', 'worker-a', 1, 'hash', now()::text, 0, 'hash', '{}', now()::text)`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.end();
    }
  });
});

type TenantDb = Parameters<Parameters<TenantTransactionProvider["withTenant"]>[1]>[0]["db"];

function ids(suffix: string): MissionSchedulingIds {
  return {
    allocateAttemptId: () => `attempt-${suffix}`,
    allocateRunnerJobId: () => `runner-job-${suffix}`,
    allocateRunId: () => `run-${suffix}`,
  };
}

function traceEvent(runId: string, sequenceNumber: number): TraceEvent {
  const hashInput: TraceEventHashInput = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `${runId}:${sequenceNumber}`,
    idempotencyKey: `${runId}:${sequenceNumber}`,
    runId,
    sequenceNumber,
    stage: "observation",
    occurredAt: "2026-08-22T00:00:01.000Z",
    payload: observationGraphV1(`mission-scheduled-${sequenceNumber}`),
  };
  return {
    ...hashInput,
    payloadHash: canonicalTraceEventHash(hashInput),
  } as TraceEvent;
}

async function seedMissionForTrace(db: TenantDb, tenantId: string, name: string): Promise<void> {
  const fixture = schedulingFixture(name);
  const plan = JSON.parse(fixture.planJson) as { projectId: string; prdId: string; prdRevision: number };
  const compiled = JSON.parse(fixture.compiledJson) as { projectId: string; targetId: string };
  const dispatch = JSON.parse(fixture.dispatchJson) as {
    binding: { readonly runnerId: string; readonly configuration: { readonly kind: string } };
  };
  const snapshot = JSON.parse(fixture.jobSnapshotJson) as { id: string; objective: string };

  await db.insertInto("project_targets").values({
    tenant_id: tenantId,
    target_id: fixture.targetId,
    project_id: compiled.projectId,
    current_version: 1,
    created_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T00:00:00.000Z",
  } as never).execute();
  await db.insertInto("target_revisions").values({
    tenant_id: tenantId,
    target_id: fixture.targetId,
    version: 1,
    project_id: compiled.projectId,
    display_name: "Target",
    runner_id: dispatch.binding.runnerId,
    kind: dispatch.binding.configuration.kind,
    snapshot_hash: `target-hash-${name}`,
    configuration_json: JSON.stringify(dispatch.binding.configuration),
    idempotency_key: `target-${name}`,
    created_at: "2026-08-22T00:00:00.000Z",
  } as never).execute();
  await db.insertInto("test_plan_heads").values({
    tenant_id: tenantId,
    plan_id: fixture.planId,
    project_id: plan.projectId,
    current_version: 2,
    created_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T00:00:00.000Z",
  } as never).execute();
  await db.insertInto("test_plan_version_revisions").values({
    tenant_id: tenantId,
    plan_id: fixture.planId,
    version: 2,
    project_id: plan.projectId,
    prd_id: plan.prdId,
    prd_revision: plan.prdRevision,
    status: "approved",
    reviewer_id: "reviewer-1",
    approved_at: "2026-08-22T00:00:00.000Z",
    idempotency_key: `approve-${name}`,
    plan_json: fixture.planJson,
    created_at: "2026-08-22T00:00:00.000Z",
  } as never).execute();
  await db.insertInto("missions").values({
    tenant_id: tenantId,
    mission_id: fixture.missionId,
    revision: 1,
    project_id: compiled.projectId,
    plan_id: fixture.planId,
    prd_id: plan.prdId,
    prd_revision: plan.prdRevision,
    target_id: fixture.targetId,
    compiled_hash: fixture.compiledHash,
    status: "approved",
    dispatch_json: fixture.dispatchJson,
    stop_on_blocked: 1,
  } as never).execute();
  await db.insertInto("mission_scheduling_heads").values({
    tenant_id: tenantId,
    mission_id: fixture.missionId,
    mission_revision: 1,
    version: 1,
    compiled_hash: fixture.compiledHash,
  } as never).execute();
  await db.insertInto("mission_revisions").values({
    tenant_id: tenantId,
    mission_id: fixture.missionId,
    revision: 1,
    compiled_json: fixture.compiledJson,
    created_at: "2026-08-22T00:00:00.000Z",
  } as never).execute();
  await db.insertInto("execution_jobs").values({
    tenant_id: tenantId,
    job_id: fixture.logicalJobId,
    mission_id: fixture.missionId,
    mission_revision: 1,
    test_case_id: snapshot.id,
    objective: snapshot.objective,
    required_capabilities_json: fixture.requiredCapabilitiesJson,
    source_refs_json: fixture.sourceRefsJson,
    snapshot_hash: fixture.jobSnapshotHash,
    snapshot_json: fixture.jobSnapshotJson,
    idempotency_key: `logical-${name}`,
    status: "queued",
  } as never).execute();
}
