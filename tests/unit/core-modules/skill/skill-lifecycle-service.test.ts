import { describe, expect, it } from "vitest";
import { bundlePayloadContentSha256, REQUIRED_REPLAY_ORACLES, SkillLifecycleService } from "@qualigence/skill";
import type { CommitSkillLifecycleCommandInput, ProcedureSkillVersion, SignedSkillBundle, SkillEvaluation, SkillLifecycleReplayResult, SkillRepository, SkillRevocation, SkillSigner } from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";

const recording: RecordingSession = {
  recordingId: "rec-core",
  projectId: "proj-core",
  targetId: "target-core",
  targetVersion: "1",
  observationSchemaEpoch: "pre-v1",
  startedAt: "2026-08-01T00:00:00.000Z",
  completedAt: "2026-08-01T00:01:00.000Z",
  steps: [{ ordinal: 1, beforeGraphRef: "graph-a", intent: { kind: "click", target: { purpose: "save" } }, resolvedNode: { role: "button", name: "Save", purpose: "save", sourceNodeId: "node-save" }, outcome: { status: "ok" }, afterGraphRef: "graph-b", checkpoint: { requiredClaims: ["saved"], stateFingerprint: "fp" } }],
  sourceTraceRefs: ["run-core"],
};

describe("SkillLifecycleService", () => {
  it("orchestrates promotion policy before atomic persistence", async () => {
    const repository = new MemorySkillRepository();
    await repository.seedVerified();
    const result = await new SkillLifecycleService({ repository, signer: new TrustingSkillSigner() }).promote({ operation: "promote", skillId: "skill-core", expectedVersion: 3, idempotencyKey: "promote-core", requiredOracles: REQUIRED_REPLAY_ORACLES, actor: { actorId: "tester", tenantId: "tenant-a", roles: ["tester"] }, occurredAt: "2026-08-01T00:05:00.000Z" });

    expect(result).toMatchObject({ version: 4, state: "promoted" });
    expect(repository.commits).toHaveLength(1);
    expect(repository.commits[0]?.audit).toMatchObject({ operation: "promote", decision: "allowed" });
  });

  it("rejects reused idempotency keys before re-running transitions", async () => {
    const repository = new MemorySkillRepository({ replay: { status: "conflict", resultVersion: 4 } });
    await expect(new SkillLifecycleService({ repository, signer: new TrustingSkillSigner() }).promote({ operation: "promote", skillId: "skill-core", expectedVersion: 3, idempotencyKey: "reuse", requiredOracles: REQUIRED_REPLAY_ORACLES, actor: { actorId: "tester", tenantId: "tenant-a", roles: ["tester"] }, occurredAt: "2026-08-01T00:05:00.000Z" })).rejects.toMatchObject({ code: "SkillIdempotencyConflict" });
    expect(repository.commits).toHaveLength(0);
  });

  it("uses the configured signer verification rather than trusting stored evaluation signature flags", async () => {
    const repository = new MemorySkillRepository();
    await repository.seedVerified();
    const signer = new RejectingSkillSigner();

    await expect(new SkillLifecycleService({ repository, signer }).promote({ operation: "promote", skillId: "skill-core", expectedVersion: 3, idempotencyKey: "promote-bad-signature", requiredOracles: REQUIRED_REPLAY_ORACLES, actor: { actorId: "tester", tenantId: "tenant-a", roles: ["tester"] }, occurredAt: "2026-08-01T00:05:00.000Z" })).rejects.toMatchObject({ code: "SkillSignatureInvalid" });
    expect(signer.verifyCalls).toBe(1);
    expect(repository.commits).toHaveLength(0);
  });

  it("fails before repository mutation when the command is already aborted and retry with same key can succeed", async () => {
    const repository = new MemorySkillRepository();
    await repository.seedVerified();
    const service = new SkillLifecycleService({ repository, signer: new TrustingSkillSigner() });
    const aborted = AbortSignal.abort();
    const command = { operation: "promote" as const, skillId: "skill-core", expectedVersion: 3, idempotencyKey: "aborted-command", requiredOracles: REQUIRED_REPLAY_ORACLES, actor: { actorId: "tester", tenantId: "tenant-a", roles: ["tester"] }, occurredAt: "2026-08-01T00:05:00.000Z" };

    await expect(service.promote({ ...command, abortSignal: aborted })).rejects.toMatchObject({ code: "SkillCommandAborted" });
    expect(repository.replayCalls).toBe(0);
    expect(repository.commits).toHaveLength(0);

    await expect(service.promote(command)).resolves.toMatchObject({ version: 4, state: "promoted" });
  });
});

class MemorySkillRepository implements SkillRepository {
  readonly commits: CommitSkillLifecycleCommandInput[] = [];
  replayCalls = 0;
  private current: ProcedureSkillVersion | undefined;
  private readonly replay: SkillLifecycleReplayResult;

  constructor(options: { readonly replay?: SkillLifecycleReplayResult } = {}) {
    this.replay = options.replay ?? { status: "not_found" };
  }

  async seedVerified(): Promise<void> {
    this.current = versionAt(3, "verified");
  }

  async saveRecording(): Promise<void> {}
  async loadRecording(): Promise<RecordingSession | undefined> { return undefined; }
  async saveSkillVersion(input: { readonly version: ProcedureSkillVersion }): Promise<void> { this.current = input.version; }
  async version(): Promise<ProcedureSkillVersion | undefined> { return this.current; }
  async latestVersion(): Promise<ProcedureSkillVersion | undefined> { return this.current; }
  async latestVersions(): Promise<readonly ProcedureSkillVersion[]> { return this.current === undefined ? [] : [this.current]; }
  async versionsInState(): Promise<readonly ProcedureSkillVersion[]> { return []; }
  async versions(): Promise<readonly ProcedureSkillVersion[]> { return this.current === undefined ? [] : [this.current]; }
  async saveEvaluation(): Promise<void> {}
  async evaluations(): Promise<readonly SkillEvaluation[]> { return [evaluationAt(3)]; }
  async saveBundle(): Promise<void> {}
  async bundle(): Promise<SignedSkillBundle | undefined> { return this.current === undefined ? undefined : bundleAt(this.current); }
  async revoke(): Promise<void> {}
  async isRevoked(): Promise<boolean> { return false; }
  async replayLifecycleCommand(): Promise<SkillLifecycleReplayResult> { this.replayCalls += 1; return this.replay; }
  async commitLifecycleCommand(input: CommitSkillLifecycleCommandInput): Promise<ProcedureSkillVersion> { this.commits.push(input); this.current = input.result; return input.result; }
  async lifecycleAuditEvents(): Promise<readonly []> { return []; }
}

class RejectingSkillSigner implements SkillSigner {
  readonly keyId = "rejecting-key";
  verifyCalls = 0;

  async sign(bundle: Omit<SignedSkillBundle["manifest"], "signatureBase64"> & { readonly payload: ProcedureSkillVersion }): Promise<SignedSkillBundle> {
    const { payload, ...manifest } = bundle;
    return { manifest: { ...manifest, signatureBase64: "bad" }, payload };
  }

  async verify() {
    this.verifyCalls += 1;
    return { status: "invalid" as const, code: "SkillSignatureInvalid" as const, message: "bad signature" };
  }
}

class TrustingSkillSigner implements SkillSigner {
  readonly keyId = "trusted-key";

  async sign(bundle: Omit<SignedSkillBundle["manifest"], "signatureBase64"> & { readonly payload: ProcedureSkillVersion }): Promise<SignedSkillBundle> {
    const { payload, ...manifest } = bundle;
    return { manifest: { ...manifest, signatureBase64: "trusted" }, payload };
  }

  async verify() {
    return { status: "valid" as const };
  }
}

function versionAt(version: number, state: ProcedureSkillVersion["state"]): ProcedureSkillVersion {
  const base: ProcedureSkillVersion = {
    skillId: "skill-core",
    version,
    state,
    projectId: "proj-core",
    targetScope: { targetId: "target-core", allowedOrigins: [] },
    parameters: [],
    steps: [{ stepId: "step-1", intent: { kind: "click", target: { purpose: "save" } }, preconditions: [], checkpoint: [], recovery: "stop", sourceNodeId: "node-save" }],
    sourceRecordingIds: [recording.recordingId],
    observationSchemaEpoch: "pre-v1",
    locatorSchemaVersion: "semantic-locator/v1",
    compilerVersion: "skill-compiler/v1",
    contentSha256: "will-be-overwritten",
  };
  return { ...base, contentSha256: bundlePayloadContentSha256(base) };
}

function evaluationAt(version: number): SkillEvaluation {
  return { evaluationId: `eval-${version}`, skillId: "skill-core", skillVersion: version, oracles: [{ oracle: REQUIRED_REPLAY_ORACLES[0] as string, status: "passed" }, ...REQUIRED_REPLAY_ORACLES.slice(1).map((oracle) => ({ oracle, status: "passed" as const }))], outcome: "passed", signatureValid: true, createdAt: "2026-08-01T00:02:00.000Z" };
}

function bundleAt(version: ProcedureSkillVersion): SignedSkillBundle {
  return { manifest: { bundleId: `bundle-${version.version}`, skillId: version.skillId, skillVersion: version.version, schemaVersion: "skill-bundle/v1", compilerVersion: version.compilerVersion, contentSha256: version.contentSha256, signerKeyId: "0123456789abcdef0123456789abcdef", signatureAlgorithm: "Ed25519", signatureBase64: "AAAA", issuedAt: "2026-08-01T00:03:00.000Z" }, payload: version };
}
