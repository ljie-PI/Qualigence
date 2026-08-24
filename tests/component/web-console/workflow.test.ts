import { createHash, randomUUID } from "node:crypto";
import { PostgresSkillStore, type PostgresConnectionConfig } from "@qualigence/postgres-runtime";
import { bundlePayloadContentSha256, REQUIRED_REPLAY_ORACLES } from "@qualigence/skill";
import type { ProcedureSkillVersion, SignedSkillBundle, SkillEvaluation } from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicApiClient } from "../../../apps/web-console/src/api/client.js";
import { ApiClientError, isApiErrorCode } from "../../../apps/web-console/src/api/errors.js";
import { MemoryTokenStore } from "../../../apps/web-console/src/auth/memory-token-store.js";
import type { ConsoleSession } from "../../../apps/web-console/src/auth/memory-token-store.js";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";

const skip = !dockerAvailable();
const describeMaybe = skip ? describe.skip : describe;

async function seedInvestigationAndTask(
  admin: PostgresConnectionConfig,
  input: { tenantId: string; caseId: string; taskId: string },
): Promise<void> {
  const client = new pg.Client(admin);
  await client.connect();
  try {
    await client.query(
      `insert into investigation_cases
        (tenant_id, case_id, finding_id, project_id, status, version, plan_revision,
         budget_json, usage_json, bug_episode_id, created_at, updated_at)
       values ($1,$2,'finding-x','project-1','needs_human',1,1,'{}','{}',null,now(),now())`,
      [input.tenantId, input.caseId],
    );
    await client.query(
      `insert into review_tasks
        (tenant_id, task_id, case_id, status, reason, priority, evidence_completeness,
         assignee_id, version, created_at, updated_at)
       values ($1,$2,$3,'open','needs review','urgent','limited',null,1,now(),now())`,
      [input.tenantId, input.taskId, input.caseId],
    );
  } finally {
    await client.end();
  }
}

const skillRecording: RecordingSession = {
  recordingId: "flow-skill-rec",
  projectId: "flow-project",
  targetId: "flow-target",
  targetVersion: "1",
  observationSchemaEpoch: "pre-v1",
  startedAt: "2026-08-01T00:00:00.000Z",
  completedAt: "2026-08-01T00:01:00.000Z",
  steps: [{ ordinal: 1, beforeGraphRef: "graph-a", intent: { kind: "click", target: { purpose: "login" } }, resolvedNode: { role: "button", name: "Login", purpose: "login", sourceNodeId: "node-login" }, outcome: { status: "ok" }, afterGraphRef: "graph-b", checkpoint: { requiredClaims: ["login"], stateFingerprint: "fp" } }],
  sourceTraceRefs: ["run-flow-skill"],
};

function flowSkillVersion(version: number, state: ProcedureSkillVersion["state"]): ProcedureSkillVersion {
  const base: ProcedureSkillVersion = {
    skillId: "flow-skill",
    version,
    state,
    projectId: "flow-project",
    targetScope: { targetId: "flow-target", allowedOrigins: ["https://example.test"] },
    parameters: [],
    steps: [{ stepId: "step-1", intent: { kind: "click", target: { purpose: "login" } }, preconditions: [], checkpoint: [{ kind: "claim_satisfied", claimId: "login" }], recovery: "stop", sourceNodeId: "node-login" }],
    sourceRecordingIds: [skillRecording.recordingId],
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
    await store.saveRecording(skillRecording);
    await store.saveSkillVersion({ version: flowSkillVersion(1, "draft"), expectedVersion: 0, sourceRecording: skillRecording });
    await store.saveSkillVersion({ version: flowSkillVersion(2, "candidate"), expectedVersion: 1, sourceRecording: skillRecording });
    const verified = flowSkillVersion(3, "verified");
    await store.saveSkillVersion({ version: verified, expectedVersion: 2, sourceRecording: skillRecording });
    const evaluation: SkillEvaluation = { evaluationId: "flow-skill-eval", skillId: "flow-skill", skillVersion: 3, oracles: passingOracles(), outcome: "passed", signatureValid: true, createdAt: "2026-08-01T00:02:00.000Z" };
    const bundle: SignedSkillBundle = await fx.skillSigner.sign({ bundleId: "flow-skill-bundle", skillId: "flow-skill", skillVersion: 3, schemaVersion: "skill-bundle/v1", compilerVersion: verified.compilerVersion, contentSha256: verified.contentSha256, signerKeyId: fx.skillSigner.keyId, signatureAlgorithm: "Ed25519", issuedAt: "2026-08-01T00:03:00.000Z", payload: verified });
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

/**
 * Critical-user-flow test driven entirely through the Console's typed client
 * against a real `apps/server`: an authenticated user views projects, ingests a
 * PRD, inspects an Investigation and claims + resolves the resulting Review
 * task. No mocked HTTP anywhere.
 */
describeMaybe("Web Console critical user flow (login → project → investigation → review)", () => {
  let fx: ServerFixture;
  let admin: PostgresConnectionConfig;
  const store = new MemoryTokenStore();
  let client: PublicApiClient;

  function login(tenantId: string, roles: readonly string[]): void {
    const session: ConsoleSession = {
      subject: "user-flow",
      tenantId,
      roles: roles as never,
      accessToken: fx.token(tenantId, roles),
      expiresAtMs: Date.now() + 3600_000,
    };
    store.set(session);
  }

  beforeAll(async () => {
    fx = await setupServerFixture();
    admin = {
      host: fx.container.host,
      port: fx.container.port,
      database: fx.container.database,
      user: fx.container.superuser,
      password: fx.container.password,
    };
    client = new PublicApiClient({ baseUrl: fx.baseUrl, accessToken: () => store.accessToken() });
  }, 180_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("runs the full Project → Target → Test Plan → Mission → Skill → Investigation → Review journey", async () => {
    // 1. Login as an admin (satisfies tester + reviewer via role hierarchy).
    login("tenant-a", ["admin"]);
    expect(store.isAuthenticated()).toBe(true);

    // 2. Create and list a project.
    await client.createProject({ name: "Journey" }, { idempotencyKey: "flow-project" });
    const projects = await client.listProjects();
    expect(projects.items.map((p) => p.projectId)).toContain("flow-project");

    // 3. Ingest a PRD revision and see it listed.
    const prd = await client.ingestPrd(
      "flow-project",
      { title: "Login PRD", content: "Users can sign in." },
      { idempotencyKey: "flow-prd-1" },
    );
    expect(prd.resource.revision).toBe(1);
    const prds = await client.listPrdRevisions("flow-project");
    expect(prds.items.map((r) => r.prdId)).toContain("flow-prd-1");

    const target = await client.createTarget("flow-project", {
      targetId: "flow-target",
      displayName: "Flow target",
      runnerId: "runner-flow",
      expectedVersion: 0,
      configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" },
    }, { idempotencyKey: "flow-target-create" });
    const sourceRef = { prdId: prd.resource.prdId, revision: 1, startOffset: 0, endOffset: 18, quotedTextSha256: createHash("sha256").update("Users can sign in.").digest("hex") };
    const draft = await client.createTestPlan({
      projectId: "flow-project", prdId: prd.resource.prdId, prdRevision: 1,
      sourceContentSha256: prd.resource.contentSha256,
      expectedClaims: [{ semanticKey: "login", statement: "Users sign in", sourceRefs: [sourceRef], confidence: 1 }],
      testCases: [{ title: "Login", objective: "Verify login", preconditions: [], steps: [{ kind: "verify", claimSemanticKeys: ["login"] }], expectedClaimSemanticKeys: ["login"], sourceRefs: [sourceRef], priority: "high" }],
    }, { idempotencyKey: "flow-plan" });
    const approved = await client.approveTestPlan(draft.resource.planId, { expectedVersion: draft.resource.version }, { idempotencyKey: "flow-plan-approve" });
    const mission = await client.createMission({ projectId: "flow-project", targetId: target.resource.targetId, targetVersion: target.resource.version, targetSnapshotHash: target.resource.snapshotHash, planId: approved.resource.planId, planVersion: approved.resource.version }, { idempotencyKey: "flow-mission" });
    expect(mission.resource).toMatchObject({ runnerId: "runner-flow", targetVersion: 1, planVersion: 2, status: "approved" });
    const replay = await client.createMission({ projectId: "flow-project", targetId: target.resource.targetId, targetVersion: target.resource.version, targetSnapshotHash: target.resource.snapshotHash, planId: approved.resource.planId, planVersion: approved.resource.version }, { idempotencyKey: "flow-mission" });
    expect(replay.resource).toEqual(mission.resource);
    const conflictingTarget = await client.createTarget("flow-project", {
      targetId: "flow-target-2", displayName: "Other target", runnerId: "runner-other", expectedVersion: 0,
      configuration: { kind: "web", startUrl: "https://other.example.test/", allowedOrigins: ["https://other.example.test"], browser: "chromium" },
    }, { idempotencyKey: "flow-target-2-create" });
    const conflict = await client.createMission({ projectId: "flow-project", targetId: conflictingTarget.resource.targetId, targetVersion: conflictingTarget.resource.version, targetSnapshotHash: conflictingTarget.resource.snapshotHash, planId: approved.resource.planId, planVersion: approved.resource.version }, { idempotencyKey: "flow-mission" }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ApiClientError);
    expect(conflict).toMatchObject({ code: "VersionConflict", details: { actualVersion: 1 } });
    expect(await client.getMission(mission.resource.missionId)).toEqual(mission.resource);

    // 4. Inspect a seeded Investigation in the needs_human state.
    await seedInvestigationAndTask(admin, {
      tenantId: "tenant-a",
      caseId: "flow-case",
      taskId: "flow-task",
    });
    const investigation = await client.getInvestigation("flow-case");
    expect(investigation.status).toBe("needs_human");

    // 5. Inspect Skill versions, exercise promotion conflict, then deprecate.
    await seedVerifiedSkill(fx);
    const skill = await client.getSkill("flow-skill");
    expect(skill).toMatchObject({ skillId: "flow-skill", version: 3, state: "verified", signatureStatus: "valid", evaluationStatus: "passed" });
    const history = await client.listSkillVersions("flow-skill");
    expect(history.items.map((item) => item.version)).toEqual([1, 2, 3]);
    const promoted = await client.promoteSkill("flow-skill", { expectedVersion: skill.version }, { idempotencyKey: "flow-skill-promote" });
    expect(promoted.resource).toMatchObject({ version: 4, state: "promoted" });
    const promoteConflict = await client.promoteSkill("flow-skill", { expectedVersion: skill.version }, { idempotencyKey: "flow-skill-promote-stale" }).catch((error: unknown) => error);
    expect(promoteConflict).toBeInstanceOf(ApiClientError);
    expect(promoteConflict).toMatchObject({ code: "VersionConflict", details: { actualVersion: 4 } });
    const deprecated = await client.deprecateSkill("flow-skill", { expectedVersion: promoted.resource.version, reason: "superseded" }, { idempotencyKey: "flow-skill-deprecate" });
    expect(deprecated.resource).toMatchObject({ version: 5, state: "deprecated", signatureStatus: "revoked" });

    // 6. Claim then resolve the Review task with idempotency + expectedVersion.
    const claimed = await client.claimReviewTask(
      "flow-task",
      { expectedVersion: 1, reviewerId: "reviewer-flow" },
      { idempotencyKey: randomUUID() },
    );
    expect(claimed.resource.status).toBe("claimed");
    const resolved = await client.resolveReviewTask(
      "flow-task",
      {
        expectedVersion: claimed.resource.version,
        reviewerId: "reviewer-flow",
        disposition: "confirmed",
        evidenceRefs: [],
      },
      { idempotencyKey: randomUUID() },
    );
    expect(resolved.resource.status).toBe("resolved");

    // 7. Logout clears the in-memory token — subsequent calls are unauthorized.
    store.clear();
    const error = await client.listProjects().catch((e: unknown) => e);
    expect(isApiErrorCode(error, "Unauthorized")).toBe(true);
  });

  it("documents that Run routes remain owned by later tickets (NotFound)", async () => {
    // The DTOs exist and the client targets the frozen contract paths, but the
    // PR-21 Server does not yet register these routes. The Console degrades to a
    // typed NotFound rather than a broken page — no fabricated data.
    login("tenant-a", ["viewer"]);
    const error = await client.listRuns().catch((e: unknown) => e);
    expect(isApiErrorCode(error, "NotFound")).toBe(true);
  });
});
