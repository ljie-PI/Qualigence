import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { LocalArtifactStore } from "@qualigence/artifact-fs";
import { ARTIFACT_CHUNK_SIZE_BYTES } from "@qualigence/runner-protocol";
import { PostgresSkillStore, type PostgresConnectionConfig } from "@qualigence/postgres-runtime";
import { bundlePayloadContentSha256, REQUIRED_REPLAY_ORACLES } from "@qualigence/skill";
import type { ProcedureSkillVersion, SkillEvaluation } from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PublicApiClient } from "../../../apps/web-console/src/api/client.js";
import { MemoryTokenStore, type ConsoleSession } from "../../../apps/web-console/src/auth/memory-token-store.js";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";
import { runRepositoryExternalRunnerHarness } from "./external-runner-harness.js";

const { Client } = pg;

const recording: RecordingSession = {
  recordingId: "ls11-skill-rec",
  projectId: "ls11-project",
  targetId: "ls11-target",
  targetVersion: "1",
  observationSchemaEpoch: "pre-v1",
  startedAt: "2026-08-27T00:00:00.000Z",
  completedAt: "2026-08-27T00:01:00.000Z",
  steps: [{ ordinal: 1, beforeGraphRef: "graph-before", intent: { kind: "click", target: { purpose: "submit" } }, resolvedNode: { role: "button", name: "Submit", purpose: "submit", sourceNodeId: "node-submit" }, outcome: { status: "ok" }, afterGraphRef: "graph-after", checkpoint: { requiredClaims: ["submitted"], stateFingerprint: "fp" } }],
  sourceTraceRefs: ["ls11-run"],
};

describe("LS-11 self-hosted full product acceptance", () => {
  beforeAll(() => {
    requireDocker();
  });

  it("drives the restored Compose stack through Public API, Console routing, and an external Runner", async () => {
    const stdout = await runRepositoryExternalRunnerHarness();
    expect(stdout).toContain("qualigence-external-runner-acceptance:pass");
    expect(stdout).toContain("harness:mission=");
    expect(stdout).toContain("harness:run=");
    expect(stdout).toContain("harness:traceEvents=");
    expect(stdout).toContain("harness:artifactRefs=");
  }, 1_200_000);

  it("covers PRD, Test Plan, Mission, Skill, Investigation, Review and Evidence through the Console Public API client", async () => {
    const fx = await setupServerFixture();
    const store = new MemoryTokenStore();
    const client = new PublicApiClient({ baseUrl: fx.baseUrl, accessToken: () => store.accessToken() });
    const admin: PostgresConnectionConfig = {
      host: fx.container.host,
      port: fx.container.port,
      database: fx.container.database,
      user: fx.container.superuser,
      password: fx.container.password,
    };
    const login = (tenantId: string, roles: readonly string[]) => {
      const session: ConsoleSession = {
        subject: "ls11-user",
        tenantId,
        roles: roles as never,
        accessToken: fx.token(tenantId, roles),
        expiresAtMs: Date.now() + 3_600_000,
      };
      store.set(session);
    };

    try {
      login("tenant-a", ["admin"]);
      await client.createProject({ name: "LS-11" }, { idempotencyKey: "ls11-project" });
      const prd = await client.ingestPrd("ls11-project", { title: "LS-11 PRD", content: "The checkout total is visible." }, { idempotencyKey: "ls11-prd" });
      const target = await client.createTarget("ls11-project", {
        targetId: "ls11-target",
        displayName: "LS-11 target",
        runnerId: "runner-ls11",
        expectedVersion: 0,
        configuration: { kind: "web", startUrl: "https://example.test/checkout", allowedOrigins: ["https://example.test"], browser: "chromium" },
      }, { idempotencyKey: "ls11-target" });
      const quoted = "The checkout total is visible.";
      const sourceRef = { prdId: prd.resource.prdId, revision: 1, startOffset: 0, endOffset: quoted.length, quotedTextSha256: createHash("sha256").update(quoted).digest("hex") };
      const draft = await client.createTestPlan({
        projectId: "ls11-project",
        prdId: prd.resource.prdId,
        prdRevision: 1,
        sourceContentSha256: prd.resource.contentSha256,
        expectedClaims: [{ semanticKey: "checkout.total", statement: "Checkout total is visible", sourceRefs: [sourceRef], confidence: 1 }],
        testCases: [{ title: "Checkout", objective: "Verify checkout total", preconditions: [], steps: [{ kind: "verify", claimSemanticKeys: ["checkout.total"] }], expectedClaimSemanticKeys: ["checkout.total"], sourceRefs: [sourceRef], priority: "high" }],
      }, { idempotencyKey: "ls11-plan" });
      const approved = await client.approveTestPlan(draft.resource.planId, { expectedVersion: draft.resource.version }, { idempotencyKey: "ls11-plan-approve" });
      const mission = await client.createMission({ projectId: "ls11-project", targetId: target.resource.targetId, targetVersion: target.resource.version, targetSnapshotHash: target.resource.snapshotHash, planId: approved.resource.planId, planVersion: approved.resource.version }, { idempotencyKey: "ls11-mission" });
      expect(await client.getMission(mission.resource.missionId)).toEqual(mission.resource);

      await seedVerifiedSkill(fx);
      const skill = await client.getSkill("ls11-skill");
      expect(skill).toMatchObject({ state: "verified", signatureStatus: "valid", evaluationStatus: "passed" });
      const promoted = await client.promoteSkill("ls11-skill", { expectedVersion: skill.version }, { idempotencyKey: "ls11-skill-promote" });
      expect(promoted.resource).toMatchObject({ state: "promoted" });

      await seedInvestigationReviewAndEvidence(fx, admin, mission.resource.missionId);
      expect(await client.getInvestigation("ls11-case")).toMatchObject({ caseId: "ls11-case", status: "needs_human" });
      const reviewTasks = await client.listReviewTasks();
      expect(reviewTasks.items.map((task) => task.taskId)).toContain("ls11-review-task");
      const claimed = await client.claimReviewTask("ls11-review-task", { expectedVersion: 1, reviewerId: "reviewer-ls11" }, { idempotencyKey: randomUUID() });
      const resolved = await client.resolveReviewTask("ls11-review-task", { expectedVersion: claimed.resource.version, reviewerId: "reviewer-ls11", disposition: "confirmed", evidenceRefs: ["ls11-artifact"] }, { idempotencyKey: randomUUID() });
      expect(resolved.resource).toMatchObject({ status: "resolved" });

      const runs = await client.listRuns();
      expect(runs.items.map((run) => run.runId)).toContain("ls11-run");
      const metadata = await apiJson(fx.baseUrl, fx.token("tenant-a", ["viewer"]), "/v1/projects/ls11-project/runs/ls11-run/artifacts/ls11-artifact?purpose=investigation");
      expect(metadata).toMatchObject({ artifactId: "ls11-artifact", runId: "ls11-run", mediaType: "text/plain" });
      const bytes = await apiText(fx.baseUrl, fx.token("tenant-a", ["viewer"]), "/v1/projects/ls11-project/runs/ls11-run/artifacts/ls11-artifact/bytes?purpose=investigation");
      expect(bytes).toBe("ls11 artifact evidence");

      store.clear();
      await expect(client.listProjects()).rejects.toMatchObject({ code: "Unauthorized" });
    } finally {
      await fx.stop();
    }
  }, 240_000);
});

function requireDocker(): void {
  if (!dockerAvailable()) {
    throw Object.assign(new Error("DockerUnavailable: LS-11 self-hosted acceptance requires Docker"), {
      code: "DockerUnavailable",
    });
  }
}

function skillVersion(version: number, state: ProcedureSkillVersion["state"]): ProcedureSkillVersion {
  const base: ProcedureSkillVersion = {
    skillId: "ls11-skill",
    version,
    state,
    projectId: "ls11-project",
    targetScope: { targetId: "ls11-target", allowedOrigins: ["https://example.test"] },
    parameters: [],
    steps: [{ stepId: "step-1", intent: { kind: "click", target: { purpose: "submit" } }, preconditions: [], checkpoint: [{ kind: "claim_satisfied", claimId: "submitted" }], recovery: "stop", sourceNodeId: "node-submit" }],
    sourceRecordingIds: [recording.recordingId],
    observationSchemaEpoch: "pre-v1",
    locatorSchemaVersion: "semantic-locator/v1",
    compilerVersion: "skill-compiler/v1",
    contentSha256: "will-be-overwritten",
  };
  return { ...base, contentSha256: bundlePayloadContentSha256(base) };
}

async function seedVerifiedSkill(fx: ServerFixture): Promise<void> {
  await fx.provider.withTenant("tenant-a", async ({ db }) => {
    const store = new PostgresSkillStore(db, "tenant-a");
    await store.saveRecording(recording);
    await store.saveSkillVersion({ version: skillVersion(1, "draft"), expectedVersion: 0, sourceRecording: recording });
    await store.saveSkillVersion({ version: skillVersion(2, "candidate"), expectedVersion: 1, sourceRecording: recording });
    const verified = skillVersion(3, "verified");
    await store.saveSkillVersion({ version: verified, expectedVersion: 2, sourceRecording: recording });
    const evaluation: SkillEvaluation = { evaluationId: "ls11-skill-eval", skillId: "ls11-skill", skillVersion: 3, oracles: passingOracles(), outcome: "passed", signatureValid: true, createdAt: "2026-08-27T00:02:00.000Z" };
    const bundle = await fx.skillSigner.sign({ bundleId: "ls11-skill-bundle", skillId: "ls11-skill", skillVersion: 3, schemaVersion: "skill-bundle/v1", compilerVersion: verified.compilerVersion, contentSha256: verified.contentSha256, signerKeyId: fx.skillSigner.keyId, signatureAlgorithm: "Ed25519", issuedAt: "2026-08-27T00:03:00.000Z", payload: verified });
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

async function seedInvestigationReviewAndEvidence(fx: ServerFixture, admin: PostgresConnectionConfig, missionId: string): Promise<void> {
  const artifactBytes = new TextEncoder().encode("ls11 artifact evidence");
  const artifactStore = new LocalArtifactStore(join(fx.artifactDataDir, "tenant-a", "ls11-project"), { now: () => "2026-08-27T00:04:00.000Z" });
  const artifact = await artifactStore.write({ artifactId: "ls11-artifact", runId: "ls11-run", name: "ls11.txt", kind: "log", mediaType: "text/plain", bytes: artifactBytes });
  const profile = await fx.evidenceKms.encryptionProfile({ tenantId: "tenant-a", caseId: "ls11-case", region: "self-hosted", purpose: "investigation" });
  const protectedHeader = {
    schemaVersion: profile.aadSchemaVersion,
    capsuleId: artifact.artifactId,
    profileId: profile.profileId,
    payloadSchemaVersion: "evidence-capsule/v1",
    tenantId: "tenant-a",
    caseId: "ls11-case",
    recipient: profile.recipient,
    region: profile.region,
    purpose: profile.purpose,
    policyId: profile.policyId,
    contentEncryptionAlgorithm: profile.contentEncryptionAlgorithm,
    keyWrappingAlgorithm: profile.keyWrappingAlgorithm,
    wrappingKeyId: profile.wrappingKeyId,
    plaintextSha256: artifact.sha256,
    plaintextBytes: artifact.size,
    createdAt: artifact.createdAt,
    expiresAt: profile.expiresAt,
  };
  const client = new Client(admin);
  await client.connect();
  try {
    await client.query(
      `insert into investigation_cases
        (tenant_id, case_id, finding_id, project_id, status, version, plan_revision,
         budget_json, usage_json, bug_episode_id, created_at, updated_at)
       values ('tenant-a','ls11-case','ls11-finding','ls11-project','needs_human',1,1,'{}','{}',null,now(),now())`,
    );
    await client.query(
      `insert into review_tasks
        (tenant_id, task_id, case_id, status, reason, priority, evidence_completeness,
         assignee_id, version, created_at, updated_at)
       values ('tenant-a','ls11-review-task','ls11-case','open','ls11 acceptance','high','complete',null,1,now(),now())`,
    );
    await client.query(
      `insert into execution_runs
        (tenant_id, run_id, job_id, target_kind, objective, status,
         next_sequence_number, created_at, completed_at, error_code)
       values ('tenant-a','ls11-run','ls11-runner-job','web','ls11 acceptance','completed',1,now(),now(),null)`,
    );
    await client.query(
      `insert into execution_jobs
        (tenant_id, job_id, mission_id, mission_revision, test_case_id, objective,
         required_capabilities_json, source_refs_json, snapshot_hash, snapshot_json,
         idempotency_key, status)
       values ($1,'ls11-logical-job',$2,1,'ls11-case','ls11 acceptance','[]','[]','ls11-snapshot','{}','ls11-logical-job','completed')`,
      ["tenant-a", missionId],
    );
    await client.query(
      `insert into mission_job_attempts
        (tenant_id, attempt_id, mission_id, mission_revision, logical_job_id,
         runner_job_id, run_id, status, created_at)
       values ($1,'ls11-attempt',$2,1,'ls11-logical-job','ls11-runner-job','ls11-run','accepted',now())`,
      ["tenant-a", missionId],
    );
    await client.query(
      `insert into artifact_manifests
        (tenant_id, artifact_id, run_id, kind, media_type, relative_path, sha256, size_bytes, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      ["tenant-a", artifact.artifactId, artifact.runId, artifact.kind, artifact.mediaType, artifact.relativePath, artifact.sha256, artifact.size, artifact.createdAt],
    );
    await client.query(
      `insert into artifact_upload_manifests
        (tenant_id, artifact_id, project_id, run_id, job_id, size_bytes, sha256, media_type,
         sensitivity, chunk_size_bytes, total_chunks, registered_by_runner_id,
         registered_lease_epoch, status, relative_path, created_at, verified_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'sensitive',$9,1,'runner-ls11',1,'verified',$10,$11,$11)`,
      ["tenant-a", artifact.artifactId, "ls11-project", artifact.runId, "ls11-runner-job", artifact.size, artifact.sha256, artifact.mediaType, ARTIFACT_CHUNK_SIZE_BYTES, artifact.relativePath, artifact.createdAt],
    );
    await client.query(
      `insert into evidence_encryption_profiles
        (tenant_id, profile_id, case_id, recipient, region, purpose, policy_id,
         wrapping_key_id, wrapping_public_key_pem, content_encryption_algorithm,
         key_wrapping_algorithm, aad_schema_version, allowed_entry_kinds_json,
         maximum_entry_bytes, maximum_plaintext_bytes, maximum_ciphertext_bytes,
         expires_at, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      ["tenant-a", profile.profileId, profile.caseId, profile.recipient, profile.region, profile.purpose, profile.policyId, profile.wrappingKeyId, profile.wrappingPublicKeyPem, profile.contentEncryptionAlgorithm, profile.keyWrappingAlgorithm, profile.aadSchemaVersion, JSON.stringify(profile.allowedEntryKinds), profile.maximumEntryBytes, profile.maximumPlaintextBytes, profile.maximumCiphertextBytes, profile.expiresAt, artifact.createdAt],
    );
    await client.query(
      `insert into evidence_capsule_manifests
        (tenant_id, capsule_id, revision, parent_revision, profile_id,
         payload_schema_version, aad_schema_version, case_id, recipient, region,
         purpose, policy_id, content_encryption_algorithm, key_wrapping_algorithm,
         wrapping_key_id, plaintext_sha256, plaintext_bytes, ciphertext_sha256,
         ciphertext_bytes, ciphertext, wrapped_dek_base64, nonce_base64, auth_tag_base64,
         protected_header_json, revocation_state, revoked_at, revoked_reason,
         lifecycle_state, lifecycle_updated_at, deleted_at, last_lifecycle_error,
         created_at, expires_at)
       values ($1,$2,1,null,$3,'evidence-capsule/v1',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13,$14,$15,'wrapped','nonce','tag',$16,'active',null,null,'active',$17,null,null,$17,$18)`,
      ["tenant-a", artifact.artifactId, profile.profileId, profile.aadSchemaVersion, "ls11-case", profile.recipient, profile.region, profile.purpose, profile.policyId, profile.contentEncryptionAlgorithm, profile.keyWrappingAlgorithm, profile.wrappingKeyId, artifact.sha256, artifact.size, Buffer.from(artifactBytes), JSON.stringify(protectedHeader), artifact.createdAt, profile.expiresAt],
    );
  } finally {
    await client.end();
  }
}

async function apiJson(baseUrl: string, token: string, path: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  expect(response.status).toBe(200);
  return response.json();
}

async function apiText(baseUrl: string, token: string, path: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return response.text();
}
