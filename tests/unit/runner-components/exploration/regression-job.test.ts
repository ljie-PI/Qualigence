import { describe, expect, it } from "vitest";
import { LocalSkillSigner } from "@qualigence/kms-local";
import { RegressionJobRunner } from "@qualigence/exploration";
import { bundlePayloadContentSha256 } from "@qualigence/skill";
import type {
  ProcedureSkillVersion,
  SignedSkillBundle,
  UnsignedSkillBundle,
  SkillVerificationScope,
} from "@qualigence/skill";
import {
  SkillReplayController,
  type ReplayTarget,
} from "@qualigence/skill-replay";
import { webReplayGraph } from "../../../replay/procedure-skill/graph-fixture.js";
import type { RegressionJobPlan } from "@qualigence/mission";

const scope: SkillVerificationScope = {
  projectId: "proj-1",
  targetId: "web-cart",
  origin: "https://shop.example",
};

function cartPayload(): ProcedureSkillVersion {
  const base: ProcedureSkillVersion = {
    skillId: "skill-cart",
    version: 3,
    state: "verified",
    projectId: "proj-1",
    targetScope: { targetId: "web-cart", allowedOrigins: ["https://shop.example"] },
    parameters: [],
    steps: [
      {
        stepId: "step-001",
        intent: { kind: "click", target: { purpose: "add to cart" } },
        preconditions: [{ kind: "url_path", path: "/product" }],
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

function unsignedBundle(signerKeyId: string): UnsignedSkillBundle {
  const payload = cartPayload();
  return {
    bundleId: "bundle-cart-1",
    skillId: payload.skillId,
    skillVersion: payload.version,
    schemaVersion: "skill-bundle/v1",
    compilerVersion: payload.compilerVersion,
    contentSha256: payload.contentSha256,
    signerKeyId,
    signatureAlgorithm: "Ed25519",
    issuedAt: "2026-08-01T00:00:00.000Z",
    payload,
  };
}

const ADD = { role: "button", name: "Add to cart" };

class CartTarget implements ReplayTarget {
  private path = "/product";
  async capture() {
    return webReplayGraph(this.path, [ADD]);
  }
  async execute(action: { step: { intent: { kind: string } } }): Promise<void> {
    if (action.step.intent.kind === "click") {
      this.path = "/cart";
    }
  }
}

/** A Target permanently off the skill's precondition path, so replay diverges. */
class BrokenTarget implements ReplayTarget {
  async capture() {
    return webReplayGraph("/home", [ADD]);
  }
  async execute(): Promise<void> {}
}

function plan(overrides: Partial<RegressionJobPlan> = {}): RegressionJobPlan {
  return {
    skillBundleId: "bundle-cart-1",
    targetVersion: "2026.08.01",
    repetitions: 3,
    stopOnFirstFailure: true,
    ...overrides,
  };
}

async function signedBundle(): Promise<{ bundle: SignedSkillBundle; controller: SkillReplayController }> {
  const signer = LocalSkillSigner.generate();
  const bundle = await signer.sign(unsignedBundle(signer.keyId));
  return { bundle, controller: new SkillReplayController({ signer }) };
}

describe("RegressionJobRunner", () => {
  it("replays a Verified skill for every repetition and reports passed", async () => {
    const { bundle, controller } = await signedBundle();
    const runner = new RegressionJobRunner(controller);

    const result = await runner.run(
      { plan: plan({ repetitions: 3 }), bundle, scope },
      () => new CartTarget(),
    );

    expect(result.status).toBe("passed");
    expect(result.repetitionsRun).toBe(3);
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.every((attempt) => attempt.status === "passed")).toBe(true);
  });

  it("stops on the first failure when configured", async () => {
    const { bundle, controller } = await signedBundle();
    const runner = new RegressionJobRunner(controller);

    const result = await runner.run(
      { plan: plan({ repetitions: 3, stopOnFirstFailure: true }), bundle, scope },
      () => new BrokenTarget(),
    );

    expect(result.status).toBe("failed");
    expect(result.repetitionsRun).toBe(1);
    expect(result.attempts).toHaveLength(1);
  });

  it("runs all repetitions when stopOnFirstFailure is false", async () => {
    const { bundle, controller } = await signedBundle();
    const runner = new RegressionJobRunner(controller);

    const result = await runner.run(
      { plan: plan({ repetitions: 2, stopOnFirstFailure: false }), bundle, scope },
      () => new BrokenTarget(),
    );

    expect(result.status).toBe("failed");
    expect(result.repetitionsRun).toBe(2);
    expect(result.attempts).toHaveLength(2);
  });
});
