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

/** A Target that never satisfies the `/product` precondition. */
class OffTarget implements ReplayTarget {
  captures = 0;
  executed = 0;
  async capture(): Promise<ReplayObservation> {
    this.captures += 1;
    return { urlPath: "/home", nodes: [ADD], claims: [] };
  }
  async execute(): Promise<void> {
    this.executed += 1;
  }
}

/** A Target that records whether it was ever touched. */
class SpyTarget implements ReplayTarget {
  captures = 0;
  async capture(): Promise<ReplayObservation> {
    this.captures += 1;
    return { urlPath: "/product", nodes: [ADD], claims: [] };
  }
  async execute(): Promise<void> {}
}

describe("Procedure Skill replay — divergence and tamper safety", () => {
  it("diverges safely (PlanDiverged) before acting when a precondition is unmet", async () => {
    const signer = LocalSkillSigner.generate();
    const bundle = await signer.sign(unsignedBundle(signer.keyId));
    const controller = new SkillReplayController({ signer });

    const target = new OffTarget();
    const result = await controller.run(bundle, target, scope);

    expect(result).toEqual({ status: "blocked", errorCode: "PlanDiverged" });
    expect(target.executed).toBe(0);
  });

  it("rejects a tampered signed bundle before any Target access", async () => {
    const signer = LocalSkillSigner.generate();
    const signed = await signer.sign(unsignedBundle(signer.keyId));
    const bytes = Buffer.from(signed.manifest.signatureBase64, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered: SignedSkillBundle = {
      manifest: { ...signed.manifest, signatureBase64: bytes.toString("base64") },
      payload: signed.payload,
    };

    const controller = new SkillReplayController({ signer });
    const target = new SpyTarget();
    const result = await controller.run(tampered, target, scope);

    expect(result).toEqual({
      status: "blocked",
      errorCode: "SkillSignatureInvalid",
    });
    expect(target.captures).toBe(0);
  });

  it("produces a failed evaluation that blocks promotion when a normal replay fails", async () => {
    const signer = LocalSkillSigner.generate();
    const bundle = await signer.sign(unsignedBundle(signer.keyId));

    const port: SkillReplayPort = {
      async replay(_bundle: SignedSkillBundle, fixture: SkillReplayFixture) {
        if (fixture.kind === "precondition-negative") {
          return { status: "blocked", errorCode: "PlanDiverged" };
        }
        // A normal/dom replay unexpectedly diverges.
        return { status: "blocked", errorCode: "PlanDiverged" };
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
      idFactory: () => "eval-2",
    });
    const evaluation = await verifier.verify({
      bundle,
      signatureVerification,
      fixtures,
    });

    expect(evaluation.outcome).toBe("failed");

    const decision = new SkillPromotionPolicy().evaluate({
      version: bundle.payload,
      evaluation,
      signatureVerification,
      requiredOracles: REQUIRED_REPLAY_ORACLES,
    });
    expect(decision).toMatchObject({
      status: "rejected",
      code: "SkillVerificationFailed",
    });
  });
});
