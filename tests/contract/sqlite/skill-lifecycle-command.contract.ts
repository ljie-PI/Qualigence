import { describe, expect, it } from "vitest";
import {
  bundlePayloadContentSha256,
  REQUIRED_REPLAY_ORACLES,
  SkillLifecycleService,
  skillLifecycleCommandHash,
} from "@qualigence/skill";
import type {
  ProcedureSkillVersion,
  SignedSkillBundle,
  SkillEvaluation,
  SkillLifecycleCommand,
  SkillRepository,
  SkillSigner,
  SkillVerificationScope,
} from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";

export interface SkillStoreHarness {
  readonly signer: SkillSigner;
  readonly tenantId: string;
  withStore<T>(operation: (store: SkillRepository) => Promise<T>): Promise<T>;
  withFailingStore<T>(
    failAfterLifecycleWrite: number,
    operation: (store: SkillRepository) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export interface SkillStoreContractProvider {
  open(): Promise<SkillStoreHarness>;
}

export const skillRecording: RecordingSession = {
  recordingId: "rec-skill-contract",
  projectId: "proj-skill-contract",
  targetId: "web-cart",
  targetVersion: "2026.08.01",
  observationSchemaEpoch: "pre-v1",
  startedAt: "2026-08-01T00:00:00.000Z",
  completedAt: "2026-08-01T00:01:00.000Z",
  steps: [{ ordinal: 1, beforeGraphRef: "graph-a", intent: { kind: "click", target: { purpose: "add to cart" } }, resolvedNode: { role: "button", name: "Add to cart", purpose: "add to cart", sourceNodeId: "node-22" }, outcome: { status: "ok" }, afterGraphRef: "graph-b", checkpoint: { requiredClaims: ["cart.count>=1"], stateFingerprint: "fp-1" } }],
  sourceTraceRefs: ["run-1"],
};

export function skillVersionAt(
  skillId: string,
  version: number,
  state: ProcedureSkillVersion["state"],
  recordingId = skillRecording.recordingId,
): ProcedureSkillVersion {
  const base: ProcedureSkillVersion = {
    skillId,
    version,
    state,
    projectId: "proj-skill-contract",
    targetScope: { targetId: "web-cart", allowedOrigins: ["https://shop.example"] },
    parameters: [],
    steps: [{ stepId: "step-001", intent: { kind: "click", target: { purpose: "add to cart" } }, preconditions: [], checkpoint: [{ kind: "url_path", path: "/cart" }], recovery: "stop", sourceNodeId: "node-22" }],
    sourceRecordingIds: [recordingId],
    observationSchemaEpoch: "pre-v1",
    locatorSchemaVersion: "semantic-locator/v1",
    compilerVersion: "skill-compiler/v1",
    contentSha256: "will-be-overwritten",
  };
  return { ...base, contentSha256: bundlePayloadContentSha256(base) };
}

export async function seedVerifiedSkill(
  store: SkillRepository,
  signer: SkillSigner,
  skillId = "skill-contract",
): Promise<void> {
  const recording = { ...skillRecording, recordingId: `${skillId}-rec` };
  await store.saveRecording(recording);
  await store.saveSkillVersion({ version: skillVersionAt(skillId, 1, "draft", recording.recordingId), expectedVersion: 0, sourceRecording: recording });
  await store.saveSkillVersion({ version: skillVersionAt(skillId, 2, "candidate", recording.recordingId), expectedVersion: 1, sourceRecording: recording });
  const verified = skillVersionAt(skillId, 3, "verified", recording.recordingId);
  await store.saveSkillVersion({ version: verified, expectedVersion: 2, sourceRecording: recording });
  await store.saveEvaluation(evaluationAt(skillId, 3));
  await store.saveBundle(await bundleAt(signer, verified));
}

export function skillLifecycleCommandContract(provider: SkillStoreContractProvider): void {
  describe("Skill lifecycle command provider contract", () => {
    it("promotes through the core service with durable idempotency and audit", async () => {
      const harness = await provider.open();
      try {
        await harness.withStore((store) => seedVerifiedSkill(store, harness.signer));
        const command: SkillLifecycleCommand = { operation: "promote", skillId: "skill-contract", expectedVersion: 3, idempotencyKey: "promote-1", requiredOracles: REQUIRED_REPLAY_ORACLES, actor: { actorId: "tester-1", tenantId: harness.tenantId, roles: ["tester"] }, occurredAt: "2026-08-01T00:05:00.000Z" };

        const promoted = await harness.withStore((store) => new SkillLifecycleService({ repository: store, signer: harness.signer }).promote(command));
        const replay = await harness.withStore((store) => new SkillLifecycleService({ repository: store, signer: harness.signer }).promote(command));

        expect(promoted).toMatchObject({ skillId: "skill-contract", version: 4, state: "promoted" });
        expect(replay).toEqual(promoted);
        await harness.withStore(async (store) => {
          expect(await store.latestVersion("skill-contract")).toEqual(promoted);
          expect(await store.lifecycleAuditEvents("skill-contract")).toHaveLength(1);
          expect(await store.replayLifecycleCommand(command.idempotencyKey, skillLifecycleCommandHash(command))).toMatchObject({ status: "replayed", result: promoted });
        });
      } finally {
        await harness.close();
      }
    });

    it("conflicts when an idempotency key is reused for a different lifecycle command", async () => {
      const harness = await provider.open();
      try {
        await harness.withStore((store) => seedVerifiedSkill(store, harness.signer));
        const service = (store: SkillRepository) => new SkillLifecycleService({ repository: store, signer: harness.signer });
        await harness.withStore((store) => service(store).promote({ operation: "promote", skillId: "skill-contract", expectedVersion: 3, idempotencyKey: "same-key", requiredOracles: REQUIRED_REPLAY_ORACLES, actor: { actorId: "tester-1", tenantId: harness.tenantId, roles: ["tester"] }, occurredAt: "2026-08-01T00:05:00.000Z" }));

        await expect(harness.withStore((store) => service(store).deprecate({ operation: "deprecate", skillId: "skill-contract", expectedVersion: 4, idempotencyKey: "same-key", reason: "superseded", actor: { actorId: "tester-1", tenantId: harness.tenantId, roles: ["tester"] }, occurredAt: "2026-08-01T00:06:00.000Z" }))).rejects.toMatchObject({ code: "SkillIdempotencyConflict" });
        await harness.withStore(async (store) => {
          expect(await store.latestVersion("skill-contract")).toMatchObject({ version: 4, state: "promoted" });
          expect(await store.lifecycleAuditEvents("skill-contract")).toHaveLength(1);
        });
      } finally {
        await harness.close();
      }
    });

    it("rejects a second stale writer after one lifecycle command wins", async () => {
      const harness = await provider.open();
      try {
        await harness.withStore((store) => seedVerifiedSkill(store, harness.signer));
        await harness.withStore((store) => new SkillLifecycleService({ repository: store, signer: harness.signer }).promote({ operation: "promote", skillId: "skill-contract", expectedVersion: 3, idempotencyKey: "race-promote-a", requiredOracles: REQUIRED_REPLAY_ORACLES, actor: { actorId: "tester-1", tenantId: harness.tenantId, roles: ["tester"] }, occurredAt: "2026-08-01T00:05:00.000Z" }));
        await expect(harness.withStore((store) => new SkillLifecycleService({ repository: store, signer: harness.signer }).deprecate({ operation: "deprecate", skillId: "skill-contract", expectedVersion: 3, idempotencyKey: "race-deprecate-b", reason: "race loser", actor: { actorId: "tester-2", tenantId: harness.tenantId, roles: ["tester"] }, occurredAt: "2026-08-01T00:05:00.000Z" }))).rejects.toMatchObject({ code: "SkillVersionConflict" });

        await harness.withStore(async (store) => {
          expect((await store.latestVersion("skill-contract"))?.version).toBe(4);
          expect(await store.lifecycleAuditEvents("skill-contract")).toHaveLength(1);
        });
      } finally {
        await harness.close();
      }
    });

    it("does not persist idempotency success when validation fails before dispatch", async () => {
      const harness = await provider.open();
      try {
        await harness.withStore(async (store) => {
          const recording = { ...skillRecording, recordingId: "skill-invalid-rec" };
          await store.saveRecording(recording);
          await store.saveSkillVersion({ version: skillVersionAt("skill-invalid", 1, "draft", recording.recordingId), expectedVersion: 0, sourceRecording: recording });
          await store.saveSkillVersion({ version: skillVersionAt("skill-invalid", 2, "candidate", recording.recordingId), expectedVersion: 1, sourceRecording: recording });
          await store.saveSkillVersion({ version: skillVersionAt("skill-invalid", 3, "verified", recording.recordingId), expectedVersion: 2, sourceRecording: recording });
        });

        const command: SkillLifecycleCommand = { operation: "promote", skillId: "skill-invalid", expectedVersion: 3, idempotencyKey: "promote-after-fix", requiredOracles: REQUIRED_REPLAY_ORACLES, actor: { actorId: "tester-1", tenantId: harness.tenantId, roles: ["tester"] }, occurredAt: "2026-08-01T00:05:00.000Z" };
        await expect(harness.withStore((store) => new SkillLifecycleService({ repository: store, signer: harness.signer }).promote(command))).rejects.toMatchObject({ code: "SkillVerificationFailed" });
        await harness.withStore(async (store) => {
          expect(await store.replayLifecycleCommand(command.idempotencyKey, skillLifecycleCommandHash(command))).toEqual({ status: "not_found" });
          const verified = skillVersionAt("skill-invalid", 3, "verified", "skill-invalid-rec");
          await store.saveEvaluation(evaluationAt("skill-invalid", 3));
          await store.saveBundle(await bundleAt(harness.signer, verified));
        });
        await expect(harness.withStore((store) => new SkillLifecycleService({ repository: store, signer: harness.signer }).promote(command))).resolves.toMatchObject({ version: 4, state: "promoted" });
      } finally {
        await harness.close();
      }
    });

    it("deprecates through the core service and revocation evidence", async () => {
      const harness = await provider.open();
      try {
        await harness.withStore((store) => seedVerifiedSkill(store, harness.signer));
        const deprecated = await harness.withStore((store) => new SkillLifecycleService({ repository: store, signer: harness.signer }).deprecate({ operation: "deprecate", skillId: "skill-contract", expectedVersion: 3, idempotencyKey: "deprecate-1", reason: "unsafe locator", actor: { actorId: "tester-1", tenantId: harness.tenantId, roles: ["tester"] }, occurredAt: "2026-08-01T00:05:00.000Z" }));

        expect(deprecated).toMatchObject({ version: 4, state: "deprecated" });
        await harness.withStore(async (store) => {
          expect(await store.isRevoked("skill-contract", 4)).toBe(true);
          expect(await store.lifecycleAuditEvents("skill-contract")).toMatchObject([{ operation: "deprecate", reason: "unsafe locator" }]);
        });
      } finally {
        await harness.close();
      }
    });

    it("rolls back aggregate, command, and audit writes on lifecycle persistence failure", async () => {
      const harness = await provider.open();
      try {
        await harness.withStore((store) => seedVerifiedSkill(store, harness.signer));
        await expect(harness.withFailingStore(3, (store) => new SkillLifecycleService({ repository: store, signer: harness.signer }).deprecate({ operation: "deprecate", skillId: "skill-contract", expectedVersion: 3, idempotencyKey: "deprecate-fail", reason: "injected failure", actor: { actorId: "tester-1", tenantId: harness.tenantId, roles: ["tester"] }, occurredAt: "2026-08-01T00:05:00.000Z" }))).rejects.toThrow("InjectedSkillLifecycleFailureAfterWrite:3");

        await harness.withStore(async (store) => {
          expect(await store.latestVersion("skill-contract")).toMatchObject({ version: 3, state: "verified" });
          expect(await store.lifecycleAuditEvents("skill-contract")).toHaveLength(0);
          expect(await store.isRevoked("skill-contract", 4)).toBe(false);
        });
      } finally {
        await harness.close();
      }
    });
  });
}

export class TrustingSkillSigner implements SkillSigner {
  readonly keyId = "0123456789abcdef0123456789abcdef";
  verifyCalls = 0;

  async sign(bundle: Omit<SignedSkillBundle["manifest"], "signatureBase64"> & { readonly payload: ProcedureSkillVersion }): Promise<SignedSkillBundle> {
    const { payload, ...manifest } = bundle;
    return { manifest: { ...manifest, signatureBase64: "trusted-test-signature" }, payload };
  }

  async verify(bundle: SignedSkillBundle, scope: SkillVerificationScope) {
    this.verifyCalls += 1;
    if (bundle.payload.projectId !== scope.projectId || bundle.payload.targetScope.targetId !== scope.targetId) {
      return { status: "invalid" as const, code: "SkillTargetMismatch" as const, message: "scope mismatch" };
    }
    return { status: "valid" as const };
  }
}

function evaluationAt(skillId: string, version: number): SkillEvaluation {
  return { evaluationId: `eval-${skillId}-${version}`, skillId, skillVersion: version, oracles: passingOracles(), outcome: "passed", signatureValid: true, createdAt: "2026-08-01T00:02:00.000Z" };
}

function passingOracles(): SkillEvaluation["oracles"] {
  return [
    { oracle: REQUIRED_REPLAY_ORACLES[0] as string, status: "passed" },
    ...REQUIRED_REPLAY_ORACLES.slice(1).map((oracle) => ({ oracle, status: "passed" as const })),
  ];
}

async function bundleAt(signer: SkillSigner, version: ProcedureSkillVersion): Promise<SignedSkillBundle> {
  return signer.sign({ bundleId: `bundle-${version.skillId}-${version.version}`, skillId: version.skillId, skillVersion: version.version, schemaVersion: "skill-bundle/v1", compilerVersion: version.compilerVersion, contentSha256: version.contentSha256, signerKeyId: signer.keyId, signatureAlgorithm: "Ed25519", issuedAt: "2026-08-01T00:03:00.000Z", payload: version });
}
