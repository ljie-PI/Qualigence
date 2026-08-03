import { describe, expect, it } from "vitest";
import { SkillPromotionPolicy } from "@qualigence/skill";
import type {
  ProcedureSkillVersion,
  SkillEvaluation,
  SkillSignatureVerification,
} from "@qualigence/skill";

function version(
  overrides: Partial<ProcedureSkillVersion> = {},
): ProcedureSkillVersion {
  return {
    skillId: "skill-1",
    version: 3,
    state: "verified",
    projectId: "proj-1",
    targetScope: { targetId: "web-cart", allowedOrigins: [] },
    parameters: [],
    steps: [
      {
        stepId: "step-001",
        intent: { kind: "click", target: { purpose: "add to cart" } },
        preconditions: [],
        checkpoint: [],
        recovery: "stop",
        sourceNodeId: "node-1",
      },
    ],
    sourceRecordingIds: ["rec-1"],
    observationSchemaEpoch: "pre-v1",
    locatorSchemaVersion: "semantic-locator/v1",
    compilerVersion: "skill-compiler/v1",
    contentSha256: "deadbeef",
    ...overrides,
  };
}

function evaluation(
  overrides: Partial<SkillEvaluation> = {},
): SkillEvaluation {
  return {
    evaluationId: "eval-1",
    skillId: "skill-1",
    skillVersion: 3,
    oracles: [
      { oracle: "normal-run-1", status: "passed" },
      { oracle: "normal-run-2", status: "passed" },
    ],
    outcome: "passed",
    signatureValid: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const validSignature: SkillSignatureVerification = { status: "valid" };
const requiredOracles = ["normal-run-1", "normal-run-2"];

describe("SkillPromotionPolicy", () => {
  const policy = new SkillPromotionPolicy();

  it("approves a verified, signed, fully-replayed skill", () => {
    const decision = policy.evaluate({
      version: version(),
      evaluation: evaluation(),
      signatureVerification: validSignature,
      requiredOracles,
    });
    expect(decision).toEqual({ status: "approved" });
  });

  it("rejects promotion of a non-verified version", () => {
    const decision = policy.evaluate({
      version: version({ state: "candidate" }),
      evaluation: evaluation(),
      signatureVerification: validSignature,
      requiredOracles,
    });
    expect(decision).toMatchObject({ status: "rejected", code: "SkillNotVerified" });
  });

  it("rejects promotion with an invalid signature", () => {
    const decision = policy.evaluate({
      version: version(),
      evaluation: evaluation(),
      signatureVerification: {
        status: "invalid",
        code: "SkillSignatureInvalid",
        message: "bad",
      },
      requiredOracles,
    });
    expect(decision).toMatchObject({
      status: "rejected",
      code: "SkillSignatureInvalid",
    });
  });

  it("rejects promotion when the evaluation did not pass", () => {
    const decision = policy.evaluate({
      version: version(),
      evaluation: evaluation({ outcome: "failed" }),
      signatureVerification: validSignature,
      requiredOracles,
    });
    expect(decision).toMatchObject({
      status: "rejected",
      code: "SkillVerificationFailed",
    });
  });

  it("rejects promotion when a required oracle did not pass", () => {
    const decision = policy.evaluate({
      version: version(),
      evaluation: evaluation({
        oracles: [
          { oracle: "normal-run-1", status: "passed" },
          { oracle: "normal-run-2", status: "failed" },
        ],
      }),
      signatureVerification: validSignature,
      requiredOracles,
    });
    expect(decision).toMatchObject({
      status: "rejected",
      code: "SkillVerificationFailed",
    });
  });
});
