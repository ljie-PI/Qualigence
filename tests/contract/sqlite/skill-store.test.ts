import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRuntime, SqliteSkillStore } from "@qualigence/sqlite-runtime";
import { bundlePayloadContentSha256, REQUIRED_REPLAY_ORACLES, SkillError } from "@qualigence/skill";
import type {
  ProcedureSkillVersion,
  SignedSkillBundle,
  SkillEvaluation,
  SkillLifecycleCommand,
} from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";

const recording: RecordingSession = {
  recordingId: "rec-1",
  projectId: "proj-1",
  targetId: "web-cart",
  targetVersion: "2026.08.01",
  observationSchemaEpoch: "pre-v1",
  startedAt: "2026-08-01T00:00:00.000Z",
  completedAt: "2026-08-01T00:01:00.000Z",
  steps: [
    {
      ordinal: 1,
      beforeGraphRef: "graph-a",
      intent: { kind: "click", target: { purpose: "add to cart" } },
      resolvedNode: {
        role: "button",
        name: "Add to cart",
        purpose: "add to cart",
        sourceNodeId: "node-22",
      },
      outcome: { status: "ok" },
      afterGraphRef: "graph-b",
      checkpoint: { requiredClaims: ["cart.count>=1"], stateFingerprint: "fp-1" },
    },
  ],
  sourceTraceRefs: ["run-1"],
};

function versionAt(
  version: number,
  state: ProcedureSkillVersion["state"],
): ProcedureSkillVersion {
  const base: ProcedureSkillVersion = {
    skillId: "skill-1",
    version,
    state,
    projectId: "proj-1",
    targetScope: {
      targetId: "web-cart",
      allowedOrigins: ["https://shop.example"],
    },
    parameters: [],
    steps: [
      {
        stepId: "step-001",
        intent: { kind: "click", target: { purpose: "add to cart" } },
        preconditions: [],
        checkpoint: [{ kind: "url_path", path: "/cart" }],
        recovery: "stop",
        sourceNodeId: "node-22",
      },
    ],
    sourceRecordingIds: ["rec-1"],
    observationSchemaEpoch: "pre-v1",
    locatorSchemaVersion: "semantic-locator/v1",
    compilerVersion: "skill-compiler/v1",
    contentSha256: "will-be-overwritten",
  };
  return { ...base, contentSha256: bundlePayloadContentSha256(base) };
}

describe("SqliteSkillStore", () => {
  let dir: string;
  let runtime: SqliteRuntime;
  let store: SqliteSkillStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), ".tmp-skill-store-"));
    runtime = await SqliteRuntime.open({
      filename: join(dir, "qualigence.db"),
      busyTimeoutMs: 5_000,
    });
    store = new SqliteSkillStore(runtime);
  });

  afterEach(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a recording with its steps", async () => {
    await store.saveRecording(recording);
    const loaded = await store.loadRecording("rec-1");
    expect(loaded).toEqual(recording);
  });

  it("persists skill versions under optimistic concurrency", async () => {
    await store.saveSkillVersion({
      version: versionAt(1, "draft"),
      expectedVersion: 0,
      sourceRecording: recording,
    });
    await store.saveSkillVersion({
      version: versionAt(2, "candidate"),
      expectedVersion: 1,
      sourceRecording: recording,
    });

    const latest = await store.latestVersion("skill-1");
    expect(latest?.version).toBe(2);
    expect(latest?.state).toBe("candidate");

    const candidates = await store.versionsInState("skill-1", "candidate");
    expect(candidates.map((version) => version.version)).toEqual([2]);
  });

  it("rejects a stale expected version with SkillVersionConflict", async () => {
    await store.saveSkillVersion({
      version: versionAt(1, "draft"),
      expectedVersion: 0,
      sourceRecording: recording,
    });
    await expect(
      store.saveSkillVersion({
        version: versionAt(2, "candidate"),
        expectedVersion: 0,
        sourceRecording: recording,
      }),
    ).rejects.toThrow("SkillVersionConflict");

    await expect(
      store.saveSkillVersion({
        version: versionAt(2, "candidate"),
        expectedVersion: 0,
        sourceRecording: recording,
      }),
    ).rejects.toBeInstanceOf(SkillError);
  });

  it("stores evaluations and signed bundles and enforces revocation", async () => {
    const version = versionAt(3, "verified");
    await store.saveSkillVersion({
      version: versionAt(1, "draft"),
      expectedVersion: 0,
      sourceRecording: recording,
    });

    const evaluation: SkillEvaluation = {
      evaluationId: "eval-1",
      skillId: "skill-1",
      skillVersion: 3,
      oracles: [{ oracle: "signature-integrity", status: "passed" }],
      outcome: "passed",
      signatureValid: true,
      createdAt: "2026-08-01T00:02:00.000Z",
    };
    await store.saveEvaluation(evaluation);
    expect(await store.evaluations("skill-1", 3)).toEqual([evaluation]);

    const bundle: SignedSkillBundle = {
      manifest: {
        bundleId: "bundle-1",
        skillId: "skill-1",
        skillVersion: 3,
        schemaVersion: "skill-bundle/v1",
        compilerVersion: "skill-compiler/v1",
        contentSha256: version.contentSha256,
        signerKeyId: "0123456789abcdef0123456789abcdef",
        signatureAlgorithm: "Ed25519",
        signatureBase64: "AAAA",
        issuedAt: "2026-08-01T00:03:00.000Z",
      },
      payload: version,
    };
    await store.saveBundle(bundle);
    expect(await store.bundle("skill-1", 3)).toEqual(bundle);

    expect(await store.isRevoked("skill-1", 3)).toBe(false);
    await store.revoke({
      revocationId: "rev-1",
      skillId: "skill-1",
      skillVersion: 3,
      reason: "compromised",
      revokedAt: "2026-08-01T00:04:00.000Z",
    });
    expect(await store.isRevoked("skill-1", 3)).toBe(true);
  });

  it("promotes through domain lifecycle with durable idempotency and audit", async () => {
    await seedVerified(store);
    const command: SkillLifecycleCommand = {
      operation: "promote",
      skillId: "skill-1",
      expectedVersion: 3,
      idempotencyKey: "promote-1",
      requiredOracles: REQUIRED_REPLAY_ORACLES,
      actor: { actorId: "tester-1", tenantId: "local", roles: ["tester"] },
      occurredAt: "2026-08-01T00:05:00.000Z",
    };

    const promoted = await store.applyLifecycleCommand(command);
    const replay = await store.applyLifecycleCommand(command);

    expect(promoted).toMatchObject({ skillId: "skill-1", version: 4, state: "promoted" });
    expect(replay).toEqual(promoted);
    expect(await store.latestVersion("skill-1")).toEqual(promoted);
    expect(await store.lifecycleAuditEvents("skill-1")).toHaveLength(1);
    const commandRows = await runtime.db.selectFrom("skill_lifecycle_commands").selectAll().execute();
    expect(commandRows).toHaveLength(1);
    expect(commandRows[0]).toMatchObject({ command_type: "promote", result_version: 4 });
  });

  it("conflicts when an idempotency key is reused for a different lifecycle command", async () => {
    await seedVerified(store);
    await store.applyLifecycleCommand({
      operation: "promote",
      skillId: "skill-1",
      expectedVersion: 3,
      idempotencyKey: "same-key",
      requiredOracles: REQUIRED_REPLAY_ORACLES,
      actor: { actorId: "tester-1", tenantId: "local", roles: ["tester"] },
      occurredAt: "2026-08-01T00:05:00.000Z",
    });

    await expect(store.applyLifecycleCommand({
      operation: "deprecate",
      skillId: "skill-1",
      expectedVersion: 4,
      idempotencyKey: "same-key",
      reason: "superseded",
      actor: { actorId: "tester-1", tenantId: "local", roles: ["tester"] },
      occurredAt: "2026-08-01T00:06:00.000Z",
    })).rejects.toMatchObject({ code: "SkillIdempotencyConflict" });
    expect(await store.latestVersion("skill-1")).toMatchObject({ version: 4, state: "promoted" });
    expect(await store.lifecycleAuditEvents("skill-1")).toHaveLength(1);
  });

  it("does not persist idempotency success when promotion validation fails", async () => {
    await store.saveRecording(recording);
    await store.saveSkillVersion({ version: versionAt(1, "draft"), expectedVersion: 0, sourceRecording: recording });
    await store.saveSkillVersion({ version: versionAt(2, "candidate"), expectedVersion: 1, sourceRecording: recording });
    await store.saveSkillVersion({ version: versionAt(3, "verified"), expectedVersion: 2, sourceRecording: recording });

    const command: SkillLifecycleCommand = {
      operation: "promote",
      skillId: "skill-1",
      expectedVersion: 3,
      idempotencyKey: "promote-after-fix",
      requiredOracles: REQUIRED_REPLAY_ORACLES,
      actor: { actorId: "tester-1", tenantId: "local", roles: ["tester"] },
      occurredAt: "2026-08-01T00:05:00.000Z",
    };
    await expect(store.applyLifecycleCommand(command)).rejects.toMatchObject({ code: "SkillVerificationFailed" });
    expect(await runtime.db.selectFrom("skill_lifecycle_commands").selectAll().execute()).toHaveLength(0);

    await store.saveEvaluation(evaluationAt(3));
    await store.saveBundle(bundleAt(versionAt(3, "verified")));
    await expect(store.applyLifecycleCommand(command)).resolves.toMatchObject({ version: 4, state: "promoted" });
  });

  it("deprecates through the domain lifecycle and revocation evidence", async () => {
    await seedVerified(store);
    const deprecated = await store.applyLifecycleCommand({
      operation: "deprecate",
      skillId: "skill-1",
      expectedVersion: 3,
      idempotencyKey: "deprecate-1",
      reason: "unsafe locator",
      actor: { actorId: "tester-1", tenantId: "local", roles: ["tester"] },
      occurredAt: "2026-08-01T00:05:00.000Z",
    });

    expect(deprecated).toMatchObject({ version: 4, state: "deprecated" });
    expect(await store.isRevoked("skill-1", 4)).toBe(true);
    expect(await store.lifecycleAuditEvents("skill-1")).toMatchObject([{ operation: "deprecate", reason: "unsafe locator" }]);
  });

  it("rolls back aggregate, command, and audit writes on lifecycle persistence failure", async () => {
    await seedVerified(store);
    const failing = new SqliteSkillStore(runtime, { failAfterLifecycleWrite: 3 });

    await expect(failing.applyLifecycleCommand({
      operation: "deprecate",
      skillId: "skill-1",
      expectedVersion: 3,
      idempotencyKey: "deprecate-fail",
      reason: "injected failure",
      actor: { actorId: "tester-1", tenantId: "local", roles: ["tester"] },
      occurredAt: "2026-08-01T00:05:00.000Z",
    })).rejects.toThrow("InjectedSkillLifecycleFailureAfterWrite:3");

    expect(await store.latestVersion("skill-1")).toMatchObject({ version: 3, state: "verified" });
    expect(await runtime.db.selectFrom("skill_lifecycle_commands").selectAll().execute()).toHaveLength(0);
    expect(await store.lifecycleAuditEvents("skill-1")).toHaveLength(0);
    expect(await store.isRevoked("skill-1", 4)).toBe(false);
  });

  it("never persists a private key or plaintext secret in the database bytes", async () => {
    await store.saveRecording(recording);
    await store.saveSkillVersion({
      version: versionAt(1, "draft"),
      expectedVersion: 0,
      sourceRecording: recording,
    });
    const rows = await runtime.db
      .selectFrom("skill_versions")
      .select("content_json")
      .execute();
    const blob = rows.map((row) => row.content_json).join("");
    expect(blob).not.toContain("PRIVATE KEY");
    expect(blob).not.toContain("BEGIN EC");
  });
});

function evaluationAt(version: number): SkillEvaluation {
  return {
    evaluationId: `eval-${version}`,
    skillId: "skill-1",
    skillVersion: version,
    oracles: passingOracles(),
    outcome: "passed",
    signatureValid: true,
    createdAt: "2026-08-01T00:02:00.000Z",
  };
}

function passingOracles(): SkillEvaluation["oracles"] {
  return [
    { oracle: REQUIRED_REPLAY_ORACLES[0] as string, status: "passed" },
    ...REQUIRED_REPLAY_ORACLES.slice(1).map((oracle) => ({ oracle, status: "passed" as const })),
  ];
}

function bundleAt(version: ProcedureSkillVersion): SignedSkillBundle {
  return {
    manifest: {
      bundleId: `bundle-${version.version}`,
      skillId: version.skillId,
      skillVersion: version.version,
      schemaVersion: "skill-bundle/v1",
      compilerVersion: version.compilerVersion,
      contentSha256: version.contentSha256,
      signerKeyId: "0123456789abcdef0123456789abcdef",
      signatureAlgorithm: "Ed25519",
      signatureBase64: "AAAA",
      issuedAt: "2026-08-01T00:03:00.000Z",
    },
    payload: version,
  };
}

async function seedVerified(store: SqliteSkillStore): Promise<void> {
  await store.saveRecording(recording);
  await store.saveSkillVersion({ version: versionAt(1, "draft"), expectedVersion: 0, sourceRecording: recording });
  await store.saveSkillVersion({ version: versionAt(2, "candidate"), expectedVersion: 1, sourceRecording: recording });
  const verified = versionAt(3, "verified");
  await store.saveSkillVersion({ version: verified, expectedVersion: 2, sourceRecording: recording });
  await store.saveEvaluation(evaluationAt(3));
  await store.saveBundle(bundleAt(verified));
}
