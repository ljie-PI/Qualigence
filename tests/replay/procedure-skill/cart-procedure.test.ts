import { describe, expect, it } from "vitest";
import { LocalSkillSigner } from "@qualigence/kms-local";
import {
  bundlePayloadContentSha256,
  REQUIRED_REPLAY_ORACLES,
  SkillPromotionPolicy,
  SkillVerifier,
} from "@qualigence/skill";
import type {
  ProcedureSkillVersion,
  SignedSkillBundle,
  SkillReplayFixture,
  SkillReplayPort,
  UnsignedSkillBundle,
  SkillVerificationScope,
} from "@qualigence/skill";
import {
  SkillReplayController,
  type ReplayObservation,
  type ReplayTarget,
} from "@qualigence/skill-replay";

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
    targetScope: {
      targetId: "web-cart",
      allowedOrigins: ["https://shop.example"],
    },
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
        stepId: "step-001",
        intent: {
          kind: "input",
          target: { purpose: "cart quantity" },
          valueRef: "test-data.cart.quantity",
        },
        preconditions: [{ kind: "url_path", path: "/product" }],
        checkpoint: [{ kind: "node_present", target: { purpose: "cart quantity" } }],
        recovery: "reobserve",
        sourceNodeId: "node-11",
      },
      {
        stepId: "step-002",
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

const QTY = { role: "spinbutton", name: "Cart quantity", text: "2" };
const ADD = { role: "button", name: "Add to cart" };

/**
 * A scripted cart Target. `normal` observes nodes in recording order; `dom`
 * reorders nodes and rewrites their visible text but keeps accessible names, so
 * only a semantics-based replay still resolves each step. Clicking add-to-cart
 * navigates to /cart.
 */
class CartTarget implements ReplayTarget {
  captures = 0;
  private path = "/product";

  constructor(private readonly variant: "normal" | "dom" = "normal") {}

  async capture(): Promise<ReplayObservation> {
    this.captures += 1;
    const nodes =
      this.variant === "dom"
        ? [
            { ...ADD },
            { ...QTY, text: "reordered field 42" },
          ]
        : [QTY, ADD];
    return { urlPath: this.path, nodes, claims: [] };
  }

  async execute(action: {
    step: { intent: { kind: string } };
  }): Promise<void> {
    if (action.step.intent.kind === "click") {
      this.path = "/cart";
    }
  }
}

/** A Target whose precondition (`/product`) is never satisfied. */
class OffTarget implements ReplayTarget {
  captures = 0;
  async capture(): Promise<ReplayObservation> {
    this.captures += 1;
    return { urlPath: "/home", nodes: [QTY, ADD], claims: [] };
  }
  async execute(): Promise<void> {
    throw new Error("execute must not be called after a diverged precondition");
  }
}

describe("Procedure Skill replay — cart procedure", () => {
  it("replays a signed Verified bundle to passed on an unchanged target", async () => {
    const signer = LocalSkillSigner.generate();
    const bundle = await signer.sign(unsignedBundle(signer.keyId));
    const controller = new SkillReplayController({ signer });

    const result = await controller.run(bundle, new CartTarget("normal"), scope);
    expect(result).toEqual({ status: "passed" });
  });

  it("still passes when the DOM is reordered and text changed (semantic locate)", async () => {
    const signer = LocalSkillSigner.generate();
    const bundle = await signer.sign(unsignedBundle(signer.keyId));
    const controller = new SkillReplayController({ signer });

    const result = await controller.run(bundle, new CartTarget("dom"), scope);
    expect(result).toEqual({ status: "passed" });
  });

  it("verifies across four oracles and permits promotion", async () => {
    const signer = LocalSkillSigner.generate();
    const bundle = await signer.sign(unsignedBundle(signer.keyId));
    const controller = new SkillReplayController({ signer });

    const port: SkillReplayPort = {
      async replay(replayBundle: SignedSkillBundle, fixture: SkillReplayFixture) {
        const target =
          fixture.kind === "precondition-negative"
            ? new OffTarget()
            : new CartTarget(fixture.kind === "dom-variation" ? "dom" : "normal");
        return controller.run(replayBundle, target, scope);
      },
    };

    const fixtures: SkillReplayFixture[] = [
      { name: "normal-1", kind: "normal" },
      { name: "normal-2", kind: "normal" },
      { name: "dom", kind: "dom-variation" },
      { name: "negative", kind: "precondition-negative" },
    ];

    const signatureVerification = await signer.verify(bundle, scope);
    const verifier = new SkillVerifier({
      replay: port,
      clock: { now: () => "2026-08-01T00:02:00.000Z" },
      idFactory: () => "eval-1",
    });
    const evaluation = await verifier.verify({
      bundle,
      signatureVerification,
      fixtures,
    });

    expect(evaluation.outcome).toBe("passed");
    expect(evaluation.signatureValid).toBe(true);
    expect(evaluation.oracles).toHaveLength(4);
    expect(
      evaluation.oracles.every((oracle) => oracle.status === "passed"),
    ).toBe(true);

    const decision = new SkillPromotionPolicy().evaluate({
      version: bundle.payload,
      evaluation,
      signatureVerification,
      requiredOracles: REQUIRED_REPLAY_ORACLES,
    });
    expect(decision).toEqual({ status: "approved" });
  });
});
