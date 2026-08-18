import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteRunnerControlStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
import {
  runnerControlStoreContract,
  type RunnerControlStoreContractHarness,
} from "./runner-control-store.contract.js";

async function createHarness(): Promise<RunnerControlStoreContractHarness> {
  const directory = await mkdtemp(join(process.cwd(), ".tmp-runner-control-sqlite-"));
  const filename = join(directory, "qualigence.db");
  let primary = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
  let concurrent = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });

  return {
    runPrimary: (operation) => operation(new SqliteRunnerControlStore(primary)),
    runConcurrent: (operation) => operation(new SqliteRunnerControlStore(concurrent)),
    async reopen() {
      await concurrent.close();
      await primary.close();
      primary = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
      concurrent = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    },
    async close() {
      await concurrent.close();
      await primary.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

runnerControlStoreContract("SQLite", createHarness);

describe("SqliteRunnerControlStore persisted policy migration", () => {
  it("rejects a projectless persisted Job on read and renewal without changing expiry", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-projectless-sqlite-"));
    const runtime = await SqliteRuntime.open({ filename: join(directory, "qualigence.db"), busyTimeoutMs: 5_000 });
    const expiresAt = "2026-08-18T00:01:00.000Z";
    const { projectId: _projectId, ...projectless } = plannedJob("job-projectless", "run-projectless");
    try {
      await runtime.db.insertInto("execution_leases").values({
        run_id: "run-projectless", job_id: "job-projectless", runner_id: "runner-1", session_id: "session-1",
        lease_epoch: 1, lease_token_hash: "token-hash", expires_at: expiresAt, lost_at: null, completed_at: null,
        recovery_of_run_id: null, job_json: JSON.stringify(projectless),
      }).execute();
      const store = new SqliteRunnerControlStore(runtime);
      await expect(store.lease("run-projectless")).rejects.toMatchObject({ code: "PolicyMissing" });
      await expect(store.renewLease({ runId: "run-projectless", jobId: "job-projectless", owner: { runnerId: "runner-1", sessionId: "session-1" }, leaseEpoch: 1, leaseTokenHash: "token-hash", checkedAt: "2026-08-18T00:00:30.000Z", newExpiresAt: "2026-08-18T00:02:00.000Z" })).rejects.toMatchObject({ code: "PolicyMissing" });
      await expect(runtime.db.selectFrom("execution_leases").select("expires_at").where("run_id", "=", "run-projectless").executeTakeFirstOrThrow()).resolves.toMatchObject({ expires_at: expiresAt });
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a policyless persisted Job on read and renewal without changing expiry", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-policyless-sqlite-"));
    const runtime = await SqliteRuntime.open({ filename: join(directory, "qualigence.db"), busyTimeoutMs: 5_000 });
    const expiresAt = "2026-08-18T00:01:00.000Z";
    try {
      await runtime.db.insertInto("execution_leases").values({
        run_id: "run-policyless", job_id: "job-policyless", runner_id: "runner-1", session_id: "session-1",
        lease_epoch: 1, lease_token_hash: "token-hash", expires_at: expiresAt, lost_at: null, completed_at: null,
        recovery_of_run_id: null,
        job_json: JSON.stringify({ jobId: "job-policyless", runId: "run-policyless", target: { kind: "web", url: "https://example.test/" }, objective: "legacy" }),
      }).execute();
      const store = new SqliteRunnerControlStore(runtime);
      await expect(store.lease("run-policyless")).rejects.toMatchObject({ code: "PolicyMissing" });
      await expect(store.renewLease({ runId: "run-policyless", jobId: "job-policyless", owner: { runnerId: "runner-1", sessionId: "session-1" }, leaseEpoch: 1, leaseTokenHash: "token-hash", checkedAt: "2026-08-18T00:00:30.000Z", newExpiresAt: "2026-08-18T00:02:00.000Z" })).rejects.toMatchObject({ code: "PolicyMissing" });
      const row = await runtime.db.selectFrom("execution_leases").select("expires_at").where("run_id", "=", "run-policyless").executeTakeFirstOrThrow();
      expect(row.expires_at).toBe(expiresAt);
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["malformed Job identity", { runId: 12, projectId: "project-test" }],
    ["malformed target", { target: { kind: "web" }, projectId: "project-test" }],
    ["invalid policy timestamp", { projectId: "project-test", policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "invalid" } }],
    ["inverted policy timestamp", { projectId: "project-test", policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:01:00.000Z", expiresAt: "2026-08-18T00:00:00.000Z" } }],
  ])("rejects persisted %s on lease and renewal without mutating expiry", async (_name, invalid) => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-malformed-sqlite-"));
    const runtime = await SqliteRuntime.open({ filename: join(directory, "qualigence.db"), busyTimeoutMs: 5_000 });
    const expiresAt = "2026-08-18T00:01:00.000Z";
    try {
      await runtime.db.insertInto("execution_leases").values({
        run_id: "run-malformed", job_id: "job-malformed", runner_id: "runner-1", session_id: "session-1", lease_epoch: 1,
        lease_token_hash: "token-hash", expires_at: expiresAt, lost_at: null, completed_at: null, recovery_of_run_id: null,
        job_json: JSON.stringify({ jobId: "job-malformed", runId: "run-malformed", target: { kind: "web", url: "https://example.test/" }, objective: "legacy", policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" }, ...invalid }),
      }).execute();
      const store = new SqliteRunnerControlStore(runtime);
      await expect(store.lease("run-malformed")).rejects.toMatchObject({ code: "PolicyMissing" });
      await expect(store.renewLease({ runId: "run-malformed", jobId: "job-malformed", owner: { runnerId: "runner-1", sessionId: "session-1" }, leaseEpoch: 1, leaseTokenHash: "token-hash", checkedAt: "2026-08-18T00:00:30.000Z", newExpiresAt: "2026-08-18T00:02:00.000Z" })).rejects.toMatchObject({ code: "PolicyMissing" });
      await expect(runtime.db.selectFrom("execution_leases").select("expires_at").where("run_id", "=", "run-malformed").executeTakeFirstOrThrow()).resolves.toMatchObject({ expires_at: expiresAt });
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("upcasts only the exact verified Local recovery record", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-legacy-upcast-sqlite-"));
    const runtime = await SqliteRuntime.open({ filename: join(directory, "qualigence.db"), busyTimeoutMs: 5_000 });
    const planned = plannedJob("job-legacy", "run-legacy");
    const job = { jobId: planned.jobId, runId: planned.runId, target: planned.target, objective: "legacy", plan: planned.plan };
    const policy = { policyId: "legacy-m1-local", environment: "isolated_test" as const, allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"] as const, maximumRisk: "Normal" as const, explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" };
    try {
      await runtime.db.insertInto("execution_leases").values({
        run_id: job.runId, job_id: job.jobId, runner_id: "runner-1", session_id: "session-1", lease_epoch: 1, lease_token_hash: "token-hash",
        expires_at: "2026-08-18T00:01:00.000Z", lost_at: null, completed_at: null, recovery_of_run_id: null, job_json: JSON.stringify(job),
      }).execute();
      const store = new SqliteRunnerControlStore(runtime, { legacyM1LocalRecovery: [{ ...job, canonicalJobSha256: canonicalPayloadHash(job), policy }] });
      await expect(store.lease(job.runId)).resolves.toMatchObject({ job: { projectId: "local", policy, plan: job.plan } });
      const wrong = new SqliteRunnerControlStore(runtime, { legacyM1LocalRecovery: [{ ...job, canonicalJobSha256: "0".repeat(64), policy }] });
      await expect(wrong.lease(job.runId)).rejects.toMatchObject({ code: "PolicyMissing" });
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("upcasts a projectless historical Job only when its policy and manifest hash match", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-projectless-upcast-sqlite-"));
    const runtime = await SqliteRuntime.open({ filename: join(directory, "qualigence.db"), busyTimeoutMs: 5_000 });
    const { projectId: _projectId, ...job } = plannedJob("job-projectless-legacy", "run-projectless-legacy");
    try {
      await runtime.db.insertInto("execution_leases").values({
        run_id: job.runId, job_id: job.jobId, runner_id: "runner-1", session_id: "session-1", lease_epoch: 1, lease_token_hash: "token-hash",
        expires_at: "2026-08-18T00:01:00.000Z", lost_at: null, completed_at: null, recovery_of_run_id: null, job_json: JSON.stringify(job),
      }).execute();
      const store = new SqliteRunnerControlStore(runtime, { legacyM1LocalRecovery: [{ jobId: job.jobId, runId: job.runId, canonicalJobSha256: canonicalPayloadHash(job), policy: job.policy }] });
      await expect(store.lease(job.runId)).resolves.toMatchObject({ job: { projectId: "local", policy: job.policy } });
      const wrong = new SqliteRunnerControlStore(runtime, { legacyM1LocalRecovery: [{ jobId: job.jobId, runId: job.runId, canonicalJobSha256: canonicalPayloadHash(job), policy: { ...job.policy, policyId: "other" } }] });
      await expect(wrong.lease(job.runId)).rejects.toMatchObject({ code: "PolicyMissing" });
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("losslessly loads a persisted Job with a plan and rejects a malformed plan", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-plan-sqlite-"));
    const runtime = await SqliteRuntime.open({ filename: join(directory, "qualigence.db"), busyTimeoutMs: 5_000 });
    const job = plannedJob("job-plan", "run-plan");
    try {
      await insertLease(runtime, job);
      await expect(new SqliteRunnerControlStore(runtime).lease(job.runId)).resolves.toMatchObject({ job });
      await runtime.db.updateTable("execution_leases").set({ job_json: JSON.stringify({ ...job, plan: { ...job.plan, steps: [] } }) }).where("run_id", "=", job.runId).execute();
      await expect(new SqliteRunnerControlStore(runtime).lease(job.runId)).rejects.toMatchObject({ code: "PolicyMissing" });
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function plannedJob(jobId: string, runId: string) {
  return {
    jobId, runId, projectId: "project-test", target: { kind: "web" as const, url: "https://example.test/" }, objective: "planned",
    policy: { policyId: "policy-1", environment: "isolated_test" as const, allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"] as const, maximumRisk: "Normal" as const, explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
    plan: { missionId: "mission-1", missionRevision: 1, testCaseId: "case-1", steps: [{ kind: "navigate" as const, path: "/cart" }, { kind: "verify" as const, claimIds: ["claim-1"] as [string] }], expectedClaimIds: ["claim-1"] as [string], budget: { maximumStepsPerJob: 2, maximumWallClockMs: 30_000, maximumModelTokens: 1_000 } },
  };
}

async function insertLease(runtime: SqliteRuntime, job: ReturnType<typeof plannedJob>): Promise<void> {
  await runtime.db.insertInto("execution_leases").values({ run_id: job.runId, job_id: job.jobId, runner_id: "runner-1", session_id: "session-1", lease_epoch: 1, lease_token_hash: "token-hash", expires_at: "2026-08-18T00:01:00.000Z", lost_at: null, completed_at: null, recovery_of_run_id: null, job_json: JSON.stringify(job) }).execute();
}
