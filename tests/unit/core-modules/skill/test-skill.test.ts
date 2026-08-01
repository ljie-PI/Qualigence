import { describe, expect, it } from "vitest";
import {
  TestSkill,
  skillCommand,
} from "@qualigence/skill";
import type {
  SkillCandidate,
  SkillDraftInput,
  SkillEvaluation,
} from "@qualigence/skill";

const draftInput: SkillDraftInput = {
  skillId: "skill-1",
  projectId: "proj-1",
  targetScope: {
    targetId: "web-cart",
    allowedOrigins: ["https://shop.example"],
  },
};

const candidate: SkillCandidate = {
  parameters: [
    {
      name: "quantity",
      valueRef: "test-data.cart.quantity",
      required: true,
      sensitivity: "public",
    },
  ],
  steps: [
    {
      stepId: "step-1",
      intent: { kind: "click", target: { purpose: "add to cart" } },
      preconditions: [],
      checkpoint: [{ kind: "url_path", path: "/cart" }],
      recovery: "stop",
      sourceNodeId: "node-1",
    },
  ],
  sourceRecordingIds: ["rec-1"],
  observationSchemaEpoch: "pre-v1",
  locatorSchemaVersion: "locator/v1",
  compilerVersion: "skill-compiler/v1",
  contentSha256: "abc123",
};

function passingEvaluation(version: number): SkillEvaluation {
  return {
    evaluationId: "eval-1",
    skillId: "skill-1",
    skillVersion: version,
    oracles: [{ oracle: "normal-run-1", status: "passed" }],
    outcome: "passed",
    signatureValid: true,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("TestSkill lifecycle", () => {
  it("walks draft → candidate → verified → promoted", () => {
    const skill = TestSkill.draft(draftInput);
    expect(skill.state()).toBe("draft");
    expect(skill.currentVersion()).toBe(1);

    skill.markCandidate({
      ...skillCommand(skill.currentVersion(), "cmd-candidate"),
      candidate,
    });
    expect(skill.state()).toBe("candidate");
    expect(skill.currentVersion()).toBe(2);

    skill.verify({
      ...skillCommand(skill.currentVersion(), "cmd-verify"),
      evaluation: passingEvaluation(skill.currentVersion()),
      signatureValid: true,
    });
    expect(skill.state()).toBe("verified");

    skill.promote(skillCommand(skill.currentVersion(), "cmd-promote"));
    expect(skill.state()).toBe("promoted");
    expect(skill.snapshot()).toMatchObject({ state: "promoted", version: 4 });
  });

  it("refuses promotion before verification with SkillNotVerified", () => {
    const skill = TestSkill.draft(draftInput);
    skill.markCandidate({
      ...skillCommand(1, "cmd-candidate"),
      candidate,
    });
    expect(() =>
      skill.promote(skillCommand(skill.currentVersion(), "cmd-promote")),
    ).toThrow("SkillNotVerified");
  });

  it("rejects a candidate command on a stale expected version", () => {
    const skill = TestSkill.draft(draftInput);
    try {
      skill.markCandidate({
        ...skillCommand(99, "cmd-candidate"),
        candidate,
      });
      expect.unreachable("stale expected version must conflict");
    } catch (error) {
      expect(error).toMatchObject({ code: "SkillVersionConflict" });
    }
  });

  it("is idempotent: replaying the same command returns the prior transition", () => {
    const skill = TestSkill.draft(draftInput);
    const first = skill.markCandidate({
      ...skillCommand(1, "cmd-candidate"),
      candidate,
    });
    const replay = skill.markCandidate({
      ...skillCommand(1, "cmd-candidate"),
      candidate,
    });
    expect(replay).toEqual(first);
    expect(skill.currentVersion()).toBe(2);
  });

  it("fails verification when an oracle failed", () => {
    const skill = TestSkill.draft(draftInput);
    skill.markCandidate({ ...skillCommand(1, "cmd-candidate"), candidate });
    const failing: SkillEvaluation = {
      ...passingEvaluation(skill.currentVersion()),
      oracles: [{ oracle: "normal-run-1", status: "failed" }],
      outcome: "failed",
    };
    expect(() =>
      skill.verify({
        ...skillCommand(skill.currentVersion(), "cmd-verify"),
        evaluation: failing,
        signatureValid: true,
      }),
    ).toThrow("SkillVerificationFailed");
  });

  it("fails verification when the signature is invalid", () => {
    const skill = TestSkill.draft(draftInput);
    skill.markCandidate({ ...skillCommand(1, "cmd-candidate"), candidate });
    expect(() =>
      skill.verify({
        ...skillCommand(skill.currentVersion(), "cmd-verify"),
        evaluation: passingEvaluation(skill.currentVersion()),
        signatureValid: false,
      }),
    ).toThrow("SkillSignatureInvalid");
  });

  it("prevents reversing a verified skill back to candidate", () => {
    const skill = TestSkill.draft(draftInput);
    skill.markCandidate({ ...skillCommand(1, "cmd-candidate"), candidate });
    skill.verify({
      ...skillCommand(skill.currentVersion(), "cmd-verify"),
      evaluation: passingEvaluation(skill.currentVersion()),
      signatureValid: true,
    });
    expect(() =>
      skill.markCandidate({
        ...skillCommand(skill.currentVersion(), "cmd-candidate-2"),
        candidate,
      }),
    ).toThrow("SkillStateReversal");
  });

  it("can deprecate from any non-deprecated state and blocks re-deprecation", () => {
    const skill = TestSkill.draft(draftInput);
    skill.markCandidate({ ...skillCommand(1, "cmd-candidate"), candidate });
    skill.deprecate({
      ...skillCommand(skill.currentVersion(), "cmd-deprecate"),
      reason: "superseded",
    });
    expect(skill.state()).toBe("deprecated");
    expect(() =>
      skill.deprecate({
        ...skillCommand(skill.currentVersion(), "cmd-deprecate-2"),
        reason: "again",
      }),
    ).toThrow("SkillAlreadyDeprecated");
  });
});
