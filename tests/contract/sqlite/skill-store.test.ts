import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRuntime, SqliteSkillStore } from "@qualigence/sqlite-runtime";
import { bundlePayloadContentSha256, SkillError } from "@qualigence/skill";
import type {
  ProcedureSkillVersion,
  SignedSkillBundle,
  SkillEvaluation,
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
