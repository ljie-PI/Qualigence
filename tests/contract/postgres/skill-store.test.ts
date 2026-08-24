import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSkillStore, createPostgresRuntime, provisionPostgres, type TenantTransactionProvider } from "@qualigence/postgres-runtime";
import { bundlePayloadContentSha256, REQUIRED_REPLAY_ORACLES, SkillLifecycleService } from "@qualigence/skill";
import type { ProcedureSkillVersion, SignedSkillBundle, SkillEvaluation, SkillLifecycleCommand } from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";
import { dockerAvailable, startPostgres, type StartedPostgres } from "../../helpers/docker-container.js";

if (!dockerAvailable()) throw new Error("DockerUnavailable: PostgreSQL Skill store contract requires Docker.");

const recording: RecordingSession = {
  recordingId: "rec-skill-pg",
  projectId: "proj-skill-pg",
  targetId: "web-cart",
  targetVersion: "2026.08.01",
  observationSchemaEpoch: "pre-v1",
  startedAt: "2026-08-01T00:00:00.000Z",
  completedAt: "2026-08-01T00:01:00.000Z",
  steps: [{ ordinal: 1, beforeGraphRef: "graph-a", intent: { kind: "click", target: { purpose: "add to cart" } }, resolvedNode: { role: "button", name: "Add to cart", purpose: "add to cart", sourceNodeId: "node-22" }, outcome: { status: "ok" }, afterGraphRef: "graph-b", checkpoint: { requiredClaims: ["cart.count>=1"], stateFingerprint: "fp-1" } }],
  sourceTraceRefs: ["run-1"],
};

function versionAt(version: number, state: ProcedureSkillVersion["state"]): ProcedureSkillVersion {
  const base: ProcedureSkillVersion = {
    skillId: "skill-pg",
    version,
    state,
    projectId: "proj-skill-pg",
    targetScope: { targetId: "web-cart", allowedOrigins: ["https://shop.example"] },
    parameters: [],
    steps: [{ stepId: "step-001", intent: { kind: "click", target: { purpose: "add to cart" } }, preconditions: [], checkpoint: [{ kind: "url_path", path: "/cart" }], recovery: "stop", sourceNodeId: "node-22" }],
    sourceRecordingIds: ["rec-skill-pg"],
    observationSchemaEpoch: "pre-v1",
    locatorSchemaVersion: "semantic-locator/v1",
    compilerVersion: "skill-compiler/v1",
    contentSha256: "will-be-overwritten",
  };
  return { ...base, contentSha256: bundlePayloadContentSha256(base) };
}

describe("PostgresSkillStore", () => {
  let container: StartedPostgres;
  let provider: TenantTransactionProvider;

  beforeAll(async () => {
    container = await startPostgres();
    const admin = { host: container.host, port: container.port, database: container.database, user: container.superuser, password: container.password };
    await provisionPostgres({ admin, roles: { server: { name: "skill_server", password: "server_pw" }, worker: { name: "skill_worker", password: "worker_pw" } } });
    provider = createPostgresRuntime({ ...admin, user: "skill_server", password: "server_pw" });
  }, 180_000);

  afterAll(async () => {
    await provider?.close();
    await container?.stop();
  });

  it("matches the Skill lifecycle command contract with idempotency and rollback", async () => {
    await provider.withTenant("tenant-a", async ({ db }) => {
      const store = new PostgresSkillStore(db, "tenant-a");
      await seedVerified(store);

      const command: SkillLifecycleCommand = { operation: "promote", skillId: "skill-pg", expectedVersion: 3, idempotencyKey: "pg-promote", requiredOracles: REQUIRED_REPLAY_ORACLES, actor: { actorId: "tester-1", tenantId: "tenant-a", roles: ["tester"] }, occurredAt: "2026-08-01T00:05:00.000Z" };
      const service = new SkillLifecycleService(store);
      const promoted = await service.promote(command);
      const replay = await service.promote(command);
      expect(promoted).toMatchObject({ version: 4, state: "promoted" });
      expect(replay).toEqual(promoted);
      await expect(service.deprecate({ ...command, operation: "deprecate", expectedVersion: 4, reason: "different" })).rejects.toMatchObject({ code: "SkillIdempotencyConflict" });
      expect(await store.lifecycleAuditEvents("skill-pg")).toHaveLength(1);
    });

    await expect(provider.withTenant("tenant-a", async ({ db }) => {
      const failing = new PostgresSkillStore(db, "tenant-a", { failAfterLifecycleWrite: 2 });
      await new SkillLifecycleService(failing).deprecate({ operation: "deprecate", skillId: "skill-pg", expectedVersion: 4, idempotencyKey: "pg-fail", reason: "injected", actor: { actorId: "tester-1", tenantId: "tenant-a", roles: ["tester"] }, occurredAt: "2026-08-01T00:06:00.000Z" });
    })).rejects.toThrow("InjectedSkillLifecycleFailureAfterWrite:2");

    await provider.withTenant("tenant-a", async ({ db }) => {
      const store = new PostgresSkillStore(db, "tenant-a");
      expect(await store.latestVersion("skill-pg")).toMatchObject({ version: 4, state: "promoted" });
      expect(await db.selectFrom("skill_lifecycle_commands").selectAll().where("idempotency_key", "=", "pg-fail").execute()).toHaveLength(0);
    });

    await provider.withTenant("tenant-a", async ({ db }) => {
      const store = new PostgresSkillStore(db, "tenant-a");
      const deprecated = await new SkillLifecycleService(store).deprecate({ operation: "deprecate", skillId: "skill-pg", expectedVersion: 4, idempotencyKey: "pg-deprecate", reason: "superseded", actor: { actorId: "tester-1", tenantId: "tenant-a", roles: ["tester"] }, occurredAt: "2026-08-01T00:07:00.000Z" });
      expect(deprecated).toMatchObject({ version: 5, state: "deprecated" });
      expect(await store.isRevoked("skill-pg", 5)).toBe(true);
    });
  });

  it("keeps tenant Skill reads isolated", async () => {
    await provider.withTenant("tenant-a", async ({ db }) => {
      const store = new PostgresSkillStore(db, "tenant-a");
      await store.saveRecording({ ...recording, recordingId: "rec-isolated-a" });
      await store.saveSkillVersion({ version: { ...versionAt(1, "draft"), skillId: "tenant-secret", sourceRecordingIds: ["rec-isolated-a"] }, expectedVersion: 0, sourceRecording: { ...recording, recordingId: "rec-isolated-a" } });
    });
    await provider.withTenant("tenant-b", async ({ db }) => {
      const store = new PostgresSkillStore(db, "tenant-b");
      expect(await store.latestVersion("tenant-secret")).toBeUndefined();
    });
  });

  it("allows only one winner when two lifecycle writers race on the same expected version", async () => {
    await provider.withTenant("tenant-race", async ({ db }) => {
      await seedVerified(new PostgresSkillStore(db, "tenant-race", {}));
    });

    const results = await Promise.allSettled([
      provider.withTenant("tenant-race", async ({ db }) => new SkillLifecycleService(new PostgresSkillStore(db, "tenant-race")).promote({ operation: "promote", skillId: "skill-pg", expectedVersion: 3, idempotencyKey: "pg-race-promote", requiredOracles: REQUIRED_REPLAY_ORACLES, actor: { actorId: "tester-a", tenantId: "tenant-race", roles: ["tester"] }, occurredAt: "2026-08-01T00:08:00.000Z" })),
      provider.withTenant("tenant-race", async ({ db }) => new SkillLifecycleService(new PostgresSkillStore(db, "tenant-race")).deprecate({ operation: "deprecate", skillId: "skill-pg", expectedVersion: 3, idempotencyKey: "pg-race-deprecate", reason: "race loser", actor: { actorId: "tester-b", tenantId: "tenant-race", roles: ["tester"] }, occurredAt: "2026-08-01T00:08:00.000Z" })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "SkillVersionConflict" } });
    await provider.withTenant("tenant-race", async ({ db }) => {
      const store = new PostgresSkillStore(db, "tenant-race");
      expect((await store.latestVersion("skill-pg"))?.version).toBe(4);
      expect(await store.lifecycleAuditEvents("skill-pg")).toHaveLength(1);
    });
  });
});

function evaluationAt(version: number): SkillEvaluation {
  return { evaluationId: `eval-pg-${version}`, skillId: "skill-pg", skillVersion: version, oracles: passingOracles(), outcome: "passed", signatureValid: true, createdAt: "2026-08-01T00:02:00.000Z" };
}

function passingOracles(): SkillEvaluation["oracles"] {
  return [
    { oracle: REQUIRED_REPLAY_ORACLES[0] as string, status: "passed" },
    ...REQUIRED_REPLAY_ORACLES.slice(1).map((oracle) => ({ oracle, status: "passed" as const })),
  ];
}

function bundleAt(version: ProcedureSkillVersion): SignedSkillBundle {
  return { manifest: { bundleId: `bundle-pg-${version.version}`, skillId: version.skillId, skillVersion: version.version, schemaVersion: "skill-bundle/v1", compilerVersion: version.compilerVersion, contentSha256: version.contentSha256, signerKeyId: "0123456789abcdef0123456789abcdef", signatureAlgorithm: "Ed25519", signatureBase64: "AAAA", issuedAt: "2026-08-01T00:03:00.000Z" }, payload: version };
}

async function seedVerified(store: PostgresSkillStore): Promise<void> {
  await store.saveRecording(recording);
  await store.saveSkillVersion({ version: versionAt(1, "draft"), expectedVersion: 0, sourceRecording: recording });
  await store.saveSkillVersion({ version: versionAt(2, "candidate"), expectedVersion: 1, sourceRecording: recording });
  const verified = versionAt(3, "verified");
  await store.saveSkillVersion({ version: verified, expectedVersion: 2, sourceRecording: recording });
  await store.saveEvaluation(evaluationAt(3));
  await store.saveBundle(bundleAt(verified));
}
