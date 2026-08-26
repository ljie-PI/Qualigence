import { createHash } from "node:crypto";
import { join } from "node:path";
import { LocalArtifactStore } from "@qualigence/artifact-fs";
import { ARTIFACT_CHUNK_SIZE_BYTES } from "@qualigence/runner-protocol";
import pg from "pg";
import { PostgresSkillStore, type PostgresConnectionConfig } from "@qualigence/postgres-runtime";
import { bundlePayloadContentSha256, REQUIRED_REPLAY_ORACLES } from "@qualigence/skill";
import type { ProcedureSkillVersion, SignedSkillBundle, SkillEvaluation } from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { generateRunnerCsr } from "../../helpers/runner-identity-pki.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";

const { Client } = pg;
if (!dockerAvailable()) {
  throw new Error("DockerUnavailable: Public API v1 contract requires Docker.");
}

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

const recording: RecordingSession = {
  recordingId: "api-skill-rec",
  projectId: "api-skill-project",
  targetId: "api-skill-target",
  targetVersion: "2026.08.01",
  observationSchemaEpoch: "pre-v1",
  startedAt: "2026-08-01T00:00:00.000Z",
  completedAt: "2026-08-01T00:01:00.000Z",
  steps: [{ ordinal: 1, beforeGraphRef: "graph-a", intent: { kind: "click", target: { purpose: "save" } }, resolvedNode: { role: "button", name: "Save", purpose: "save", sourceNodeId: "node-save" }, outcome: { status: "ok" }, afterGraphRef: "graph-b", checkpoint: { requiredClaims: ["saved"], stateFingerprint: "fp" } }],
  sourceTraceRefs: ["run-api-skill"],
};

async function seedProject(
  admin: PostgresConnectionConfig,
  input: { tenantId: string; projectId: string; name: string },
): Promise<void> {
  const client = new Client(admin);
  await client.connect();
  try {
    await client.query(
      `insert into projects (tenant_id, project_id, name, version, created_at, updated_at)
       values ($1,$2,$3,1,now(),now())`,
      [input.tenantId, input.projectId, input.name],
    );
  } finally {
    await client.end();
  }
}

async function seedReviewTask(
  admin: PostgresConnectionConfig,
  input: { tenantId: string; taskId: string; caseId: string; version: number },
): Promise<void> {
  const client = new Client(admin);
  await client.connect();
  try {
    await client.query(
      `insert into review_tasks
        (tenant_id, task_id, case_id, status, reason, priority, evidence_completeness,
         assignee_id, version, created_at, updated_at)
       values ($1,$2,$3,'open','needs review','high','limited',null,$4,now(),now())`,
      [input.tenantId, input.taskId, input.caseId, input.version],
    );
  } finally {
    await client.end();
  }
}

async function readReviewTask(
  admin: PostgresConnectionConfig,
  taskId: string,
): Promise<{ status: string; assignee_id: string | null; version: number }> {
  const client = new Client(admin);
  await client.connect();
  try {
    const result = await client.query<{
      status: string;
      assignee_id: string | null;
      version: number;
    }>(
      "select status, assignee_id, version from review_tasks where task_id = $1",
      [taskId],
    );
    return result.rows[0] as { status: string; assignee_id: string | null; version: number };
  } finally {
    await client.end();
  }
}

async function seedRunApiRows(fx: ServerFixture, tenantId: string): Promise<void> {
  await fx.provider.withTenant(tenantId, async ({ db }) => {
    await db.insertInto("missions").values({ tenant_id: tenantId, mission_id: `api-mission-${tenantId}`, revision: 1, project_id: `api-project-${tenantId}`, plan_id: `api-plan-${tenantId}`, prd_id: `api-prd-${tenantId}`, prd_revision: 1, target_id: `api-target-${tenantId}`, compiled_hash: `api-compiled-${tenantId}`, status: "running", dispatch_json: "{}", stop_on_blocked: 1 } as never).execute();
    await db.insertInto("execution_jobs").values({ tenant_id: tenantId, job_id: `api-logical-${tenantId}`, mission_id: `api-mission-${tenantId}`, mission_revision: 1, test_case_id: `api-case-${tenantId}`, objective: "API run read", required_capabilities_json: "[]", source_refs_json: "[]", snapshot_hash: `api-snapshot-${tenantId}`, snapshot_json: "{}", idempotency_key: `api-logical-${tenantId}`, status: "queued" } as never).execute();
    await db.insertInto("execution_runs").values({ tenant_id: tenantId, run_id: `api-run-${tenantId}`, job_id: `api-runner-job-${tenantId}`, target_kind: "web", objective: "API run read", status: "running", next_sequence_number: 2, created_at: "2026-08-23T00:00:00.000Z", completed_at: null, error_code: null } as never).execute();
    await db.insertInto("mission_job_attempts").values({ tenant_id: tenantId, attempt_id: `api-attempt-${tenantId}`, mission_id: `api-mission-${tenantId}`, mission_revision: 1, logical_job_id: `api-logical-${tenantId}`, runner_job_id: `api-runner-job-${tenantId}`, run_id: `api-run-${tenantId}`, status: "accepted", created_at: "2026-08-23T00:00:00.000Z" } as never).execute();
    await db.insertInto("trace_events").values({ tenant_id: tenantId, run_id: `api-run-${tenantId}`, sequence_number: 1, message_id: `api-message-${tenantId}`, idempotency_key: `api-trace-${tenantId}`, stage: "observation", occurred_at: "2026-08-23T00:00:01.000Z", payload_hash: "a".repeat(64), envelope_json: "{}" } as never).execute();
    await db.insertInto("findings").values({ tenant_id: tenantId, finding_id: `finding-${tenantId}`, run_id: `api-run-${tenantId}`, payload_hash: "b".repeat(64), envelope_json: "{}", created_at: "2026-08-23T00:00:02.000Z" } as never).execute();
    await db.insertInto("artifact_manifests").values({ tenant_id: tenantId, artifact_id: `artifact-${tenantId}`, run_id: `api-run-${tenantId}`, kind: "screenshot", media_type: "image/png", relative_path: `api-run-${tenantId}/screen.png`, sha256: "c".repeat(64), size_bytes: 16, created_at: "2026-08-23T00:00:03.000Z" } as never).execute();
  });
}

async function seedEvidenceArtifact(
  fx: ServerFixture,
  input: { tenantId: string; projectId: string; runId: string; artifactId: string; bytes: Uint8Array },
): Promise<void> {
  const store = new LocalArtifactStore(join(fx.artifactDataDir, input.tenantId, input.projectId), { now: () => "2026-08-23T00:00:03.000Z" });
  const manifest = await store.write({
    artifactId: input.artifactId,
    runId: input.runId,
    name: `${input.artifactId}.txt`,
    kind: "log",
    mediaType: "text/plain",
    bytes: input.bytes,
  });
  await fx.provider.withTenant(input.tenantId, async ({ db }) => {
    await db.insertInto("missions").values({ tenant_id: input.tenantId, mission_id: `evidence-mission-${input.projectId}`, revision: 1, project_id: input.projectId, plan_id: `evidence-plan-${input.projectId}`, prd_id: `evidence-prd-${input.projectId}`, prd_revision: 1, target_id: `evidence-target-${input.projectId}`, compiled_hash: `evidence-compiled-${input.projectId}`, status: "running", dispatch_json: "{}", stop_on_blocked: 1 } as never).execute();
    await db.insertInto("execution_jobs").values({ tenant_id: input.tenantId, job_id: `evidence-logical-${input.projectId}`, mission_id: `evidence-mission-${input.projectId}`, mission_revision: 1, test_case_id: `evidence-case-${input.projectId}`, objective: "Evidence API read", required_capabilities_json: "[]", source_refs_json: "[]", snapshot_hash: `evidence-snapshot-${input.projectId}`, snapshot_json: "{}", idempotency_key: `evidence-logical-${input.projectId}`, status: "queued" } as never).execute();
    await db.insertInto("execution_runs").values({ tenant_id: input.tenantId, run_id: input.runId, job_id: `evidence-runner-job-${input.projectId}`, target_kind: "web", objective: "Evidence API read", status: "running", next_sequence_number: 1, created_at: "2026-08-23T00:00:00.000Z", completed_at: null, error_code: null } as never).execute();
    await db.insertInto("mission_job_attempts").values({ tenant_id: input.tenantId, attempt_id: `evidence-attempt-${input.projectId}`, mission_id: `evidence-mission-${input.projectId}`, mission_revision: 1, logical_job_id: `evidence-logical-${input.projectId}`, runner_job_id: `evidence-runner-job-${input.projectId}`, run_id: input.runId, status: "accepted", created_at: "2026-08-23T00:00:00.000Z" } as never).execute();
    await db.insertInto("artifact_manifests").values({ tenant_id: input.tenantId, artifact_id: manifest.artifactId, run_id: manifest.runId, kind: manifest.kind, media_type: manifest.mediaType, relative_path: manifest.relativePath, sha256: manifest.sha256, size_bytes: manifest.size, created_at: manifest.createdAt } as never).execute();
    await db.insertInto("artifact_upload_manifests").values({ tenant_id: input.tenantId, artifact_id: manifest.artifactId, project_id: input.projectId, run_id: manifest.runId, job_id: `evidence-runner-job-${input.tenantId}`, size_bytes: manifest.size, sha256: manifest.sha256, media_type: manifest.mediaType, sensitivity: "sensitive", chunk_size_bytes: ARTIFACT_CHUNK_SIZE_BYTES, total_chunks: Math.ceil(manifest.size / ARTIFACT_CHUNK_SIZE_BYTES), registered_by_runner_id: `runner-${input.projectId}`, registered_lease_epoch: 1, status: "verified", relative_path: manifest.relativePath, created_at: manifest.createdAt, verified_at: manifest.createdAt } as never).execute();
  });
}

function skillVersion(skillId: string, version: number, state: ProcedureSkillVersion["state"], recordingId = recording.recordingId): ProcedureSkillVersion {
  const base: ProcedureSkillVersion = {
    skillId,
    version,
    state,
    projectId: "api-skill-project",
    targetScope: { targetId: "api-skill-target", allowedOrigins: ["https://example.test"] },
    parameters: [],
    steps: [{ stepId: "step-1", intent: { kind: "click", target: { purpose: "save" } }, preconditions: [], checkpoint: [{ kind: "claim_satisfied", claimId: "saved" }], recovery: "stop", sourceNodeId: "node-save" }],
    sourceRecordingIds: [recordingId],
    observationSchemaEpoch: "pre-v1",
    locatorSchemaVersion: "semantic-locator/v1",
    compilerVersion: "skill-compiler/v1",
    contentSha256: "will-be-overwritten",
  };
  return { ...base, contentSha256: bundlePayloadContentSha256(base) };
}

async function seedVerifiedSkill(fx: ServerFixture, input: { tenantId: string; skillId: string }): Promise<void> {
  await fx.provider.withTenant(input.tenantId, async ({ db }) => {
    const store = new PostgresSkillStore(db, input.tenantId);
    await store.saveRecording({ ...recording, recordingId: `${input.skillId}-rec` });
    await store.saveSkillVersion({ version: skillVersion(input.skillId, 1, "draft", `${input.skillId}-rec`), expectedVersion: 0, sourceRecording: { ...recording, recordingId: `${input.skillId}-rec` } });
    await store.saveSkillVersion({ version: skillVersion(input.skillId, 2, "candidate", `${input.skillId}-rec`), expectedVersion: 1, sourceRecording: { ...recording, recordingId: `${input.skillId}-rec` } });
    const verified = skillVersion(input.skillId, 3, "verified", `${input.skillId}-rec`);
    await store.saveSkillVersion({ version: verified, expectedVersion: 2, sourceRecording: { ...recording, recordingId: `${input.skillId}-rec` } });
    const evaluation: SkillEvaluation = { evaluationId: `${input.skillId}-eval`, skillId: input.skillId, skillVersion: 3, oracles: passingOracles(), outcome: "passed", signatureValid: true, createdAt: "2026-08-01T00:02:00.000Z" };
    const bundle: SignedSkillBundle = await fx.skillSigner.sign({ bundleId: `${input.skillId}-bundle`, skillId: input.skillId, skillVersion: 3, schemaVersion: "skill-bundle/v1", compilerVersion: verified.compilerVersion, contentSha256: verified.contentSha256, signerKeyId: fx.skillSigner.keyId, signatureAlgorithm: "Ed25519", issuedAt: "2026-08-01T00:03:00.000Z", payload: verified });
    await store.saveEvaluation(evaluation);
    await store.saveBundle(bundle);
  });
}

function passingOracles(): SkillEvaluation["oracles"] {
  return [
    { oracle: REQUIRED_REPLAY_ORACLES[0] as string, status: "passed" },
    ...REQUIRED_REPLAY_ORACLES.slice(1).map((oracle) => ({ oracle, status: "passed" as const })),
  ];
}

describe("Public API v1 contract", () => {
  let fx: ServerFixture;
  let admin: PostgresConnectionConfig;

  beforeAll(async () => {
    fx = await setupServerFixture();
    admin = {
      host: fx.container.host,
      port: fx.container.port,
      database: fx.container.database,
      user: fx.container.superuser,
      password: fx.container.password,
    };
  }, 180_000);

  afterAll(async () => {
    await fx?.stop();
  });

  function url(path: string): string {
    return `${fx.baseUrl}${path}`;
  }

  describe("OIDC authentication + RBAC", () => {
    it("rejects an unauthenticated request with 401", async () => {
      const res = await fetch(url("/v1/projects"));
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("Unauthorized");
    });

    it("rejects an invalid token with 401", async () => {
      const res = await fetch(url("/v1/projects"), {
        headers: { authorization: "Bearer not-a-real-jwt" },
      });
      expect(res.status).toBe(401);
    });

    it("rejects an under-privileged caller with 403", async () => {
      const token = fx.token("tenant-a", ["viewer"]);
      const res = await fetch(url("/v1/projects"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "proj-forbidden",
        },
        body: JSON.stringify({ name: "Nope" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("Forbidden");
    });
  });

  describe("Project create + list", () => {
    it("requires an Idempotency-Key on mutations (400)", async () => {
      const token = fx.token("tenant-a", ["tester"]);
      const res = await fetch(url("/v1/projects"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "No Key" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("IdempotencyKeyRequired");
    });

    it("creates a project and returns a command envelope DTO", async () => {
      const token = fx.token("tenant-a", ["tester"]);
      const res = await fetch(url("/v1/projects"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "proj-alpha",
        },
        body: JSON.stringify({ name: "Alpha" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        resource: { projectId: string; name: string; version: number };
        version: number;
        correlationId: string;
      };
      expect(body.resource).toEqual({ projectId: "proj-alpha", name: "Alpha", version: 1 });
      expect(body.version).toBe(1);
      expect(typeof body.correlationId).toBe("string");
      // No domain-internal fields leak into the DTO.
      expect(Object.keys(body.resource).sort()).toEqual(["name", "projectId", "version"]);
    });

    it("is idempotent: replaying the same key returns the same resource", async () => {
      const token = fx.token("tenant-a", ["tester"]);
      const send = () =>
        fetch(url("/v1/projects"), {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            [IDEMPOTENCY_KEY_HEADER]: "proj-idem",
          },
          body: JSON.stringify({ name: "Idem" }),
        });
      const first = (await (await send()).json()) as { resource: { projectId: string } };
      const second = (await (await send()).json()) as { resource: { projectId: string } };
      expect(second.resource.projectId).toBe(first.resource.projectId);
    });
  });

  describe("versioned Target and Test Plan intake", () => {
    it("creates approved immutable inputs and a provenance-bound Mission", async () => {
      const token = fx.token("tenant-a", ["tester"]);
      const headers = (key: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: key });
      await fetch(url("/v1/projects"), { method: "POST", headers: headers("product-project"), body: JSON.stringify({ name: "Product" }) });
      const prdContent = "Total is shown";
      const prdResponse = await fetch(url("/v1/projects/product-project/prd-revisions"), { method: "POST", headers: headers("prd-1"), body: JSON.stringify({ title: "Checkout", content: prdContent }) });
      const prd = (await prdResponse.json()) as { resource: { prdId: string; revision: number; contentSha256: string } };
      const prdConflict = await fetch(url("/v1/projects/product-project/prd-revisions"), { method: "POST", headers: headers("prd-1"), body: JSON.stringify({ title: "Changed", content: prdContent }) });
      expect(prdConflict.status).toBe(409);
      expect(await prdConflict.json()).toMatchObject({ code: "VersionConflict" });

      const targetResponse = await fetch(url("/v1/projects/product-project/targets"), { method: "POST", headers: headers("target-create-command"), body: JSON.stringify({ targetId: "checkout", displayName: "Checkout", runnerId: "runner-1", expectedVersion: 0, configuration: { kind: "web", startUrl: "https://shop.example.test/checkout", allowedOrigins: ["https://shop.example.test"], browser: "chromium" } }) });
      expect(targetResponse.status).toBe(201);
      const target = (await targetResponse.json()) as { resource: { targetId: string; projectId: string; runnerId: string; version: number; snapshotHash: string; configuration: unknown } };
      expect(target.resource).toMatchObject({ targetId: "checkout", projectId: "product-project", runnerId: "runner-1", version: 1 });
      expect(JSON.stringify(target.resource)).not.toMatch(/password|secret/i);
      const targetUpdate = await fetch(url("/v1/projects/product-project/targets"), { method: "POST", headers: headers("target-update-command"), body: JSON.stringify({ targetId: "checkout", displayName: "Checkout v2", runnerId: "runner-1", expectedVersion: 1, configuration: { kind: "web", startUrl: "https://shop.example.test/checkout-v2", allowedOrigins: ["https://shop.example.test"], browser: "chromium" } }) });
      expect(targetUpdate.status).toBe(201);
      const staleTarget = await fetch(url("/v1/projects/product-project/targets"), { method: "POST", headers: headers("target-stale-command"), body: JSON.stringify({ targetId: "checkout", displayName: "stale", runnerId: "runner-1", expectedVersion: 1, configuration: { kind: "web", startUrl: "https://shop.example.test/stale", allowedOrigins: ["https://shop.example.test"], browser: "chromium" } }) });
      expect(staleTarget.status).toBe(409);
      expect(await staleTarget.json()).toMatchObject({ code: "VersionConflict", details: { actualVersion: 2 } });

      const sourceRef = { prdId: prd.resource.prdId, revision: 1, startOffset: 0, endOffset: prdContent.length, quotedTextSha256: createHash("sha256").update(prdContent).digest("hex") };
      const planResponse = await fetch(url("/v1/test-plans"), { method: "POST", headers: headers("plan-1"), body: JSON.stringify({ projectId: "product-project", prdId: prd.resource.prdId, prdRevision: 1, sourceContentSha256: prd.resource.contentSha256, expectedClaims: [{ semanticKey: "cart.total", statement: "Total is shown", sourceRefs: [sourceRef], confidence: 1 }], testCases: [{ title: "Checkout", objective: "Verify total", preconditions: [], steps: [{ kind: "verify", claimSemanticKeys: ["cart.total"] }], expectedClaimSemanticKeys: ["cart.total"], sourceRefs: [sourceRef], priority: "high" }] }) });
      expect(planResponse.status).toBe(201);
      const draft = (await planResponse.json()) as { resource: { planId: string; version: number } };
      const approvedResponse = await fetch(url(`/v1/test-plans/${draft.resource.planId}/approve`), { method: "POST", headers: headers("approve-plan-1"), body: JSON.stringify({ expectedVersion: 1 }) });
      expect(approvedResponse.status).toBe(200);
      const approved = (await approvedResponse.json()) as { resource: { status: string; version: number } };
      expect(approved.resource).toMatchObject({ status: "approved", version: 2 });

      const stale = await fetch(url(`/v1/test-plans/${draft.resource.planId}/approve`), { method: "POST", headers: headers("approve-plan-stale"), body: JSON.stringify({ expectedVersion: 1 }) });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "VersionConflict", details: { actualVersion: 2 } });

      const targetV2 = (await targetUpdate.json()) as typeof target;
      const missionResponse = await fetch(url("/v1/missions"), { method: "POST", headers: headers("mission-1"), body: JSON.stringify({ projectId: "product-project", targetId: targetV2.resource.targetId, targetVersion: targetV2.resource.version, targetSnapshotHash: targetV2.resource.snapshotHash, planId: draft.resource.planId, planVersion: approved.resource.version }) });
      expect(missionResponse.status).toBe(201);
      const mission = (await missionResponse.json()) as { resource: { missionId: string; version: number; targetId: string; targetVersion: number; runnerId: string; planVersion: number; status: string } };
      expect(mission).toMatchObject({ resource: { targetId: "checkout", targetVersion: 2, runnerId: "runner-1", planVersion: 2, status: "approved", version: 1 } });

      const start = await fetch(url(`/v1/missions/${mission.resource.missionId}/start`), { method: "POST", headers: headers("start-mission-1"), body: JSON.stringify({ expectedVersion: mission.resource.version }) });
      expect(start.status).toBe(202);
      const scheduled = (await start.json()) as { resource: { missionVersion: number; runs: readonly { runId: string; attemptId: string; runnerJobId: string }[] } };
      expect(scheduled.resource).toMatchObject({ missionVersion: 2, status: "running", runs: [{ runId: expect.any(String), attemptId: expect.any(String), runnerJobId: expect.any(String) }] });
      const replay = await fetch(url(`/v1/missions/${mission.resource.missionId}/start`), { method: "POST", headers: headers("start-mission-1"), body: JSON.stringify({ expectedVersion: mission.resource.version }) });
      expect(replay.status).toBe(202);
      expect((await replay.json()) as { resource: unknown }).toMatchObject({ resource: scheduled.resource });

      await fx.provider.withTenant("tenant-a", async ({ db }) => {
        const missionRevision = await db.selectFrom("mission_revisions").select("compiled_json").executeTakeFirstOrThrow();
        const jobs = await db.selectFrom("execution_jobs").select(["job_id", "snapshot_json"]).execute();
        expect(JSON.parse(missionRevision.compiled_json)).toMatchObject({ missionRevision: 1, jobs: [{ status: "queued" }] });
        expect(jobs).toHaveLength(1);
        await expect(db.selectFrom("mission_dispatch_outbox").select("status").executeTakeFirstOrThrow()).resolves.toMatchObject({ status: "pending" });
      });
    });

    it.each(["source hash mismatch", "selector", "script", "plaintext valueRef", "unknown claim"])("rejects %s", async (name) => {
      const token = fx.token("tenant-a", ["tester"]);
      const key = `reject-${name.replaceAll(" ", "-")}`;
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: key };
      await fetch(url("/v1/projects"), { method: "POST", headers, body: JSON.stringify({ name: key }) });
      const content = "A user can sign in.";
      const prdResponse = await fetch(url(`/v1/projects/${key}/prd-revisions`), { method: "POST", headers: { ...headers, [IDEMPOTENCY_KEY_HEADER]: `${key}-prd` }, body: JSON.stringify({ title: "Login", content }) });
      const prd = (await prdResponse.json()) as { resource: { prdId: string; revision: number; contentSha256: string } };
      const sourceRef = { prdId: prd.resource.prdId, revision: 1, startOffset: 0, endOffset: content.length, quotedTextSha256: createHash("sha256").update(content).digest("hex") };
      const semanticKey = "known";
      const step = name === "selector"
        ? { kind: "click", target: { purpose: "css=#password" } }
        : name === "script"
          ? { kind: "navigate", path: "javascript:alert(1)" }
          : name === "plaintext valueRef"
            ? { kind: "input", target: { purpose: "password" }, valueRef: "hunter2" }
            : { kind: "verify", claimSemanticKeys: [name === "unknown claim" ? "missing" : semanticKey] };
      const body = { projectId: key, prdId: prd.resource.prdId, prdRevision: 1, sourceContentSha256: name === "source hash mismatch" ? "0".repeat(64) : prd.resource.contentSha256, expectedClaims: [{ semanticKey, statement: content, sourceRefs: [sourceRef], confidence: 1 }], testCases: [{ title: "Login", objective: "Verify login", preconditions: [], steps: [step], expectedClaimSemanticKeys: [name === "unknown claim" ? "missing" : semanticKey], sourceRefs: [sourceRef], priority: "high" }] };
      const response = await fetch(url("/v1/test-plans"), { method: "POST", headers: { ...headers, [IDEMPOTENCY_KEY_HEADER]: `${key}-plan` }, body: JSON.stringify(body) });
      expect(response.status).toBe(422);
    });

    it("returns tenant A product IDs as not found to tenant B", async () => {
      const token = fx.token("tenant-b", ["viewer"]);
      const response = await fetch(url("/v1/test-plans/plan-1"), { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(404);
    });
  });

  describe("Run and Trace API", () => {
    it("returns tenant-scoped Run summaries, finding references, artifact references, and Trace events", async () => {
      await seedRunApiRows(fx, "tenant-a");
      await seedRunApiRows(fx, "tenant-b");
      const token = fx.token("tenant-a", ["viewer"]);
      const headers = { authorization: `Bearer ${token}` };

      const list = await fetch(url("/v1/runs"), { headers });
      expect(list.status).toBe(200);
      const listed = await list.json() as { items: { runId: string; missionId?: string; findingIds: string[]; evidenceRefs: string[] }[] };
      const apiRun = listed.items.find((run) => run.runId === "api-run-tenant-a");
      expect(apiRun).toEqual({ runId: "api-run-tenant-a", missionId: "api-mission-tenant-a", status: "running", findingIds: ["finding-tenant-a"], evidenceRefs: ["artifact-tenant-a"], createdAt: "2026-08-23T00:00:00.000Z" });
      expect(listed.items.some((run) => run.runId === "api-run-tenant-b")).toBe(false);

      const get = await fetch(url("/v1/runs/api-run-tenant-a"), { headers });
      expect(get.status).toBe(200);
      expect(await get.json()).toMatchObject({ runId: "api-run-tenant-a", missionId: "api-mission-tenant-a", findingIds: ["finding-tenant-a"], evidenceRefs: ["artifact-tenant-a"] });

      const trace = await fetch(url("/v1/runs/api-run-tenant-a/trace"), { headers });
      expect(trace.status).toBe(200);
      expect(await trace.json()).toMatchObject({ items: [{ runId: "api-run-tenant-a", sequenceNumber: 1, stage: "observation", occurredAt: "2026-08-23T00:00:01.000Z", payloadHash: "a".repeat(64) }] });

      const hidden = await fetch(url("/v1/runs/api-run-tenant-b"), { headers });
      expect(hidden.status).toBe(404);
      const hiddenTrace = await fetch(url("/v1/runs/api-run-tenant-b/trace"), { headers });
      expect(hiddenTrace.status).toBe(404);
    });
  });

  describe("Evidence API", () => {
    it("serves authorized artifact metadata and bytes without exposing cross-tenant or wrong-purpose plaintext", async () => {
      const secret = new TextEncoder().encode("tenant-a plaintext evidence");
      await seedEvidenceArtifact(fx, {
        tenantId: "tenant-a",
        projectId: "evidence-project-a",
        runId: "evidence-run-a",
        artifactId: "evidence-artifact-a",
        bytes: secret,
      });
      await seedEvidenceArtifact(fx, {
        tenantId: "tenant-b",
        projectId: "evidence-project-b",
        runId: "evidence-run-b",
        artifactId: "evidence-artifact-b",
        bytes: new TextEncoder().encode("tenant-b plaintext evidence"),
      });

      const tenantAHeaders = { authorization: `Bearer ${fx.token("tenant-a", ["viewer"])}` };
      const metadata = await fetch(url("/v1/projects/evidence-project-a/runs/evidence-run-a/artifacts/evidence-artifact-a?purpose=investigation"), { headers: tenantAHeaders });
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toEqual({
        artifactId: "evidence-artifact-a",
        runId: "evidence-run-a",
        kind: "log",
        mediaType: "text/plain",
        size: secret.byteLength,
        sha256: createHash("sha256").update(secret).digest("hex"),
        downloadAllowed: true,
      });

      const bytes = await fetch(url("/v1/projects/evidence-project-a/runs/evidence-run-a/artifacts/evidence-artifact-a/bytes?purpose=investigation"), { headers: tenantAHeaders });
      expect(bytes.status).toBe(200);
      expect(await bytes.text()).toBe("tenant-a plaintext evidence");

      const wrongPurpose = await fetch(url("/v1/projects/evidence-project-a/runs/evidence-run-a/artifacts/evidence-artifact-a/bytes?purpose=export"), { headers: tenantAHeaders });
      expect(wrongPurpose.status).toBe(422);
      expect(await wrongPurpose.text()).not.toContain("tenant-a plaintext evidence");

      const wrongProject = await fetch(url("/v1/projects/evidence-project-b/runs/evidence-run-a/artifacts/evidence-artifact-a/bytes?purpose=investigation"), { headers: tenantAHeaders });
      expect(wrongProject.status).toBe(404);
      expect(await wrongProject.text()).not.toContain("tenant-a plaintext evidence");

      const tenantBHeaders = { authorization: `Bearer ${fx.token("tenant-b", ["viewer"])}` };
      const hidden = await fetch(url("/v1/projects/evidence-project-a/runs/evidence-run-a/artifacts/evidence-artifact-a/bytes?purpose=investigation"), { headers: tenantBHeaders });
      expect(hidden.status).toBe(404);
      expect(await hidden.text()).not.toContain("tenant-a plaintext evidence");
    });

    it("fails closed when byte storage is unavailable", async () => {
      const secret = new TextEncoder().encode("unavailable plaintext evidence");
      await seedEvidenceArtifact(fx, {
        tenantId: "tenant-a",
        projectId: "evidence-unavailable-project",
        runId: "evidence-unavailable-run",
        artifactId: "evidence-unavailable-artifact",
        bytes: secret,
      });
      await fx.provider.withTenant("tenant-a", async ({ db }) => {
        await db
          .updateTable("artifact_manifests")
          .set({ relative_path: "evidence-unavailable-run/missing.txt" })
          .where("tenant_id", "=", "tenant-a")
          .where("artifact_id", "=", "evidence-unavailable-artifact")
          .execute();
        await db
          .updateTable("artifact_upload_manifests")
          .set({ relative_path: "evidence-unavailable-run/missing.txt" })
          .where("tenant_id", "=", "tenant-a")
          .where("artifact_id", "=", "evidence-unavailable-artifact")
          .execute();
      });

      const res = await fetch(url("/v1/projects/evidence-unavailable-project/runs/evidence-unavailable-run/artifacts/evidence-unavailable-artifact/bytes?purpose=investigation"), {
        headers: { authorization: `Bearer ${fx.token("tenant-a", ["viewer"])}` },
      });
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain("unavailable plaintext evidence");
    });
  });

  describe("Tenant isolation (RLS through the API)", () => {
    it("never returns tenant B's projects to tenant A", async () => {
      await seedProject(admin, { tenantId: "tenant-b", projectId: "b-secret", name: "B Secret" });
      const token = fx.token("tenant-a", ["viewer"]);
      const res = await fetch(url("/v1/projects"), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { projectId: string }[] };
      const ids = body.items.map((p) => p.projectId);
      expect(ids).not.toContain("b-secret");
    });

    it("cannot read tenant B's investigation case by id (404)", async () => {
      const client = new Client(admin);
      await client.connect();
      try {
        await client.query(
          `insert into investigation_cases
            (tenant_id, case_id, finding_id, project_id, status, version, plan_revision,
             budget_json, usage_json, bug_episode_id, created_at, updated_at)
           values ('tenant-b','case-b','finding-b','project-1','investigating',1,1,'{}','{}',null,now(),now())`,
        );
      } finally {
        await client.end();
      }
      const token = fx.token("tenant-a", ["viewer"]);
      const res = await fetch(url("/v1/investigations/case-b"), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("Skill lifecycle", () => {
    it("lists Skill versions and promotes/deprecates with expected-version idempotency", async () => {
      await seedVerifiedSkill(fx, { tenantId: "tenant-a", skillId: "api-skill" });
      const token = fx.token("tenant-a", ["tester"]);
      const headers = (key: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: key });

      const list = await fetch(url("/v1/skills"), { headers: { authorization: `Bearer ${token}` } });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({ items: [{ skillId: "api-skill", version: 3, state: "verified", signatureStatus: "valid", evaluationStatus: "passed" }] });

      const promote = await fetch(url("/v1/skills/api-skill/promote"), { method: "POST", headers: headers("api-skill-promote"), body: JSON.stringify({ expectedVersion: 3 }) });
      expect(promote.status).toBe(200);
      const promoted = await promote.json() as { resource: { version: number; state: string } };
      expect(promoted.resource).toMatchObject({ version: 4, state: "promoted" });

      const replay = await fetch(url("/v1/skills/api-skill/promote"), { method: "POST", headers: headers("api-skill-promote"), body: JSON.stringify({ expectedVersion: 3 }) });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ resource: promoted.resource });

      const idempotencyConflict = await fetch(url("/v1/skills/api-skill/deprecate"), { method: "POST", headers: headers("api-skill-promote"), body: JSON.stringify({ expectedVersion: 4, reason: "different intent" }) });
      expect(idempotencyConflict.status).toBe(409);
      expect(await idempotencyConflict.json()).toMatchObject({ code: "IdempotencyConflict" });

      const stale = await fetch(url("/v1/skills/api-skill/promote"), { method: "POST", headers: headers("api-skill-promote-stale"), body: JSON.stringify({ expectedVersion: 3 }) });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "VersionConflict", details: { actualVersion: 4 } });

      const deprecate = await fetch(url("/v1/skills/api-skill/deprecate"), { method: "POST", headers: headers("api-skill-deprecate"), body: JSON.stringify({ expectedVersion: 4, reason: "superseded" }) });
      expect(deprecate.status).toBe(200);
      expect(await deprecate.json()).toMatchObject({ resource: { version: 5, state: "deprecated", signatureStatus: "revoked" } });
    });

    it("does not create idempotency success for validation or auth failures", async () => {
      await seedVerifiedSkill(fx, { tenantId: "tenant-a", skillId: "api-skill-reject" });
      const viewer = fx.token("tenant-a", ["viewer"]);
      const rejected = await fetch(url("/v1/skills/api-skill-reject/promote"), { method: "POST", headers: { authorization: `Bearer ${viewer}`, "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: "api-skill-reject-key" }, body: JSON.stringify({ expectedVersion: 3 }) });
      expect(rejected.status).toBe(403);
      const tester = fx.token("tenant-a", ["tester"]);
      const missingKey = await fetch(url("/v1/skills/api-skill-reject/promote"), { method: "POST", headers: { authorization: `Bearer ${tester}`, "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 3 }) });
      expect(missingKey.status).toBe(400);
      expect(await missingKey.json()).toMatchObject({ code: "IdempotencyKeyRequired" });
      const invalidBody = await fetch(url("/v1/skills/api-skill-reject/promote"), { method: "POST", headers: { authorization: `Bearer ${tester}`, "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: "api-skill-invalid-body" }, body: JSON.stringify({ expectedVersion: 0 }) });
      expect(invalidBody.status).toBe(422);
      expect(await invalidBody.json()).toMatchObject({ code: "ValidationFailed" });
      const nullBody = await fetch(url("/v1/skills/api-skill-reject/promote"), { method: "POST", headers: { authorization: `Bearer ${tester}`, "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: "api-skill-null-body" }, body: "null" });
      expect(nullBody.status).toBe(422);
      expect(await nullBody.json()).toMatchObject({ code: "ValidationFailed" });
      const missingBody = await fetch(url("/v1/skills/api-skill-reject/promote"), { method: "POST", headers: { authorization: `Bearer ${tester}`, [IDEMPOTENCY_KEY_HEADER]: "api-skill-missing-body" } });
      expect(missingBody.status).toBe(422);
      expect(await missingBody.json()).toMatchObject({ code: "ValidationFailed" });
      await fx.provider.withTenant("tenant-a", async ({ db }) => {
        expect(await db.selectFrom("skill_lifecycle_commands").selectAll().where("idempotency_key", "=", "api-skill-reject-key").execute()).toHaveLength(0);
        expect(await db.selectFrom("skill_lifecycle_commands").selectAll().where("idempotency_key", "=", "api-skill-invalid-body").execute()).toHaveLength(0);
        expect(await db.selectFrom("skill_lifecycle_commands").selectAll().where("idempotency_key", "=", "api-skill-null-body").execute()).toHaveLength(0);
        expect(await db.selectFrom("skill_lifecycle_commands").selectAll().where("idempotency_key", "=", "api-skill-missing-body").execute()).toHaveLength(0);
      });
      const retry = await fetch(url("/v1/skills/api-skill-reject/promote"), { method: "POST", headers: { authorization: `Bearer ${tester}`, "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: "api-skill-null-body" }, body: JSON.stringify({ expectedVersion: 3 }) });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ resource: { version: 4, state: "promoted" } });
    });

    it("returns one success and one version conflict for concurrent two-writer promotion", async () => {
      await seedVerifiedSkill(fx, { tenantId: "tenant-a", skillId: "api-skill-race" });
      const token = fx.token("tenant-a", ["tester"]);
      const send = (key: string) => fetch(url("/v1/skills/api-skill-race/promote"), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: key }, body: JSON.stringify({ expectedVersion: 3 }) });

      const responses = await Promise.all([send("api-skill-race-a"), send("api-skill-race-b")]);
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 409]);
      const conflict = responses.find((response) => response.status === 409);
      expect(await conflict?.json()).toMatchObject({ code: "VersionConflict", details: { actualVersion: 4 } });
    });
  });

  describe("Optimistic concurrency on review tasks", () => {
    it("rejects a stale expectedVersion with 409", async () => {
      await seedReviewTask(admin, {
        tenantId: "tenant-a",
        taskId: "task-conflict",
        caseId: "case-1",
        version: 3,
      });
      const token = fx.token("tenant-a", ["reviewer"]);
      const res = await fetch(url("/v1/review-tasks/task-conflict/claim"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "claim-stale",
        },
        body: JSON.stringify({ expectedVersion: 1, reviewerId: "rev-1" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("VersionConflict");
    });

    it("claims a task at the correct version and bumps it", async () => {
      await seedReviewTask(admin, {
        tenantId: "tenant-a",
        taskId: "task-ok",
        caseId: "case-1",
        version: 1,
      });
      const token = fx.token("tenant-a", ["reviewer"]);
      const res = await fetch(url("/v1/review-tasks/task-ok/claim"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "claim-ok",
        },
        body: JSON.stringify({ expectedVersion: 1, reviewerId: "rev-1" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { resource: { status: string; version: number } };
      expect(body.resource.status).toBe("claimed");
      expect(body.resource.version).toBe(2);
    });

    it("rejects resolving an open task and preserves its row", async () => {
      await seedReviewTask(admin, {
        tenantId: "tenant-a",
        taskId: "task-open-resolve",
        caseId: "case-1",
        version: 1,
      });
      const token = fx.token("tenant-a", ["reviewer"]);
      const res = await fetch(url("/v1/review-tasks/task-open-resolve/resolve"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "resolve-open",
        },
        body: JSON.stringify({
          expectedVersion: 1,
          reviewerId: "rev-1",
          disposition: "confirmed_bug",
          evidenceRefs: [],
        }),
      });

      expect(res.status).toBe(409);
      expect((await res.json() as { code: string }).code).toBe("VersionConflict");
      await expect(readReviewTask(admin, "task-open-resolve")).resolves.toEqual({
        status: "open",
        assignee_id: null,
        version: 1,
      });
    });

    it("rejects a non-assignee resolve and preserves the claimed row", async () => {
      await seedReviewTask(admin, {
        tenantId: "tenant-a",
        taskId: "task-non-assignee",
        caseId: "case-1",
        version: 1,
      });
      const token = fx.token("tenant-a", ["reviewer"]);
      const claimed = await fetch(url("/v1/review-tasks/task-non-assignee/claim"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "claim-alice",
        },
        body: JSON.stringify({ expectedVersion: 1, reviewerId: "alice" }),
      });
      expect(claimed.status).toBe(200);

      const res = await fetch(url("/v1/review-tasks/task-non-assignee/resolve"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "resolve-bob",
        },
        body: JSON.stringify({
          expectedVersion: 2,
          reviewerId: "bob",
          disposition: "confirmed_bug",
          evidenceRefs: [],
        }),
      });

      expect(res.status).toBe(409);
      expect((await res.json() as { code: string }).code).toBe("VersionConflict");
      await expect(readReviewTask(admin, "task-non-assignee")).resolves.toEqual({
        status: "claimed",
        assignee_id: "alice",
        version: 2,
      });
    });

    it("replays an idempotency key without another version increment", async () => {
      await seedReviewTask(admin, {
        tenantId: "tenant-a",
        taskId: "task-idempotent",
        caseId: "case-1",
        version: 1,
      });
      const token = fx.token("tenant-a", ["reviewer"]);
      const send = () => fetch(url("/v1/review-tasks/task-idempotent/claim"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "claim-idempotent",
        },
        body: JSON.stringify({ expectedVersion: 1, reviewerId: "alice" }),
      });

      const first = await send();
      const firstBody = await first.json() as { resource: { version: number; status: string; assigneeId?: string } };
      const replay = await send();
      const replayBody = await replay.json() as { resource: { version: number; status: string; assigneeId?: string } };

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replayBody.resource).toEqual(firstBody.resource);
      await expect(readReviewTask(admin, "task-idempotent")).resolves.toEqual({
        status: "claimed",
        assignee_id: "alice",
        version: 2,
      });
    });
  });

  describe("Runner enrollment (mTLS, never OIDC)", () => {
    it("requires OIDC admin to register a Runner", async () => {
      const viewer = fx.token("tenant-a", ["viewer"]);
      const forbidden = await fetch(url("/v1/runner-enrollments"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${viewer}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "enroll-forbidden",
        },
        body: JSON.stringify({ runnerId: "runner-1", projectIds: ["p1"], ttlMs: 60000 }),
      });
      expect(forbidden.status).toBe(403);
    });

    it("completes the enrollment -> certificate -> self identity flow without OIDC on the runner routes", async () => {
      const adminToken = fx.token("tenant-a", ["admin"]);
      const createRes = await fetch(url("/v1/runner-enrollments"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "enroll-1",
        },
        body: JSON.stringify({ runnerId: "runner-1", projectIds: ["p1"], ttlMs: 600000 }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        resource: { enrollmentId: string; enrollmentToken: string };
      };
      const { enrollmentId, enrollmentToken } = created.resource;
      expect(typeof enrollmentToken).toBe("string");
      expect(enrollmentToken.length).toBeGreaterThan(0);

      const csr = generateRunnerCsr({ commonName: "runner-1" });
      // Certificate issue is Runner-facing: NO OIDC bearer token, tenant via header.
      const certRes = await fetch(url(`/v1/runner-enrollments/${enrollmentId}/certificate`), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-id": "tenant-a",
        },
        body: JSON.stringify({ enrollmentToken, csrPem: csr.csrPem }),
      });
      expect(certRes.status).toBe(201);
      const cert = (await certRes.json()) as { runnerId: string; certificatePem: string };
      expect(cert.runnerId).toBe("runner-1");
      expect(cert.certificatePem).toContain("BEGIN CERTIFICATE");

      // Self identity is mTLS-authenticated via the client certificate header, NOT OIDC.
      // A TLS-terminating proxy forwards the PEM URL-encoded.
      const selfRes = await fetch(url("/v1/runner-identity/self"), {
        headers: { "x-client-cert": encodeURIComponent(cert.certificatePem) },
      });
      expect(selfRes.status).toBe(200);
      const identity = (await selfRes.json()) as { runnerId: string; tenantId: string };
      expect(identity.runnerId).toBe("runner-1");
      expect(identity.tenantId).toBe("tenant-a");
    });

    it("rejects the self route when no client certificate is presented (401)", async () => {
      const res = await fetch(url("/v1/runner-identity/self"));
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("RunnerIdentityUnauthenticated");
    });

    it("does not accept an OIDC bearer token in place of a client certificate", async () => {
      const adminToken = fx.token("tenant-a", ["admin"]);
      const res = await fetch(url("/v1/runner-identity/self"), {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(401);
    });
  });
});
