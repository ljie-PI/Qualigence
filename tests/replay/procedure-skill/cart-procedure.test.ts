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
import { webReplayGraph } from "./graph-fixture.js";

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

function unsignedBundle(
  signerKeyId: string,
  payload: ProcedureSkillVersion = cartPayload(),
): UnsignedSkillBundle {
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

function claimCheckpointPayload(): ProcedureSkillVersion {
  const base = cartPayload();
  const firstStep = base.steps[0];
  const secondStep = base.steps[1];
  if (secondStep === undefined) {
    throw new Error("cart fixture must contain a second step");
  }
  const withClaimCheckpoint: ProcedureSkillVersion = {
    ...base,
    steps: [
      firstStep,
      {
        ...secondStep,
        checkpoint: [{ kind: "claim_satisfied", claimId: "cart.count>=1" }],
      },
    ],
    contentSha256: "will-be-overwritten",
  };
  return {
    ...withClaimCheckpoint,
    contentSha256: bundlePayloadContentSha256(withClaimCheckpoint),
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
  private readonly claims = new Set<string>();

  constructor(private readonly variant: "normal" | "dom" = "normal") {}

  async capture() {
    this.captures += 1;
    const nodes =
      this.variant === "dom"
        ? [
            { ...ADD },
            { ...QTY, text: "reordered field 42" },
          ]
        : [QTY, ADD];
    return webReplayGraph(this.path, nodes, {
      graphId: `cart-${this.captures}`,
      queryKeys: ["ref"],
      claimIds: [...this.claims],
    });
  }

  async execute(action: {
    step: { intent: { kind: string } };
  }): Promise<void> {
    if (action.step.intent.kind === "click") {
      this.path = "/cart";
      this.claims.add("cart.count>=1");
    }
  }
}

/** A Target whose precondition (`/product`) is never satisfied. */
class OffTarget implements ReplayTarget {
  captures = 0;
  async capture() {
    this.captures += 1;
    return webReplayGraph("/home", [QTY, ADD], { graphId: `off-${this.captures}` });
  }
  async execute(): Promise<void> {
    throw new Error("execute must not be called after a diverged precondition");
  }
}

class LegacyObservationTarget implements ReplayTarget {
  captures = 0;
  executed = 0;
  async capture(): Promise<ReplayObservation> {
    this.captures += 1;
    return { urlPath: "/product", nodes: [QTY, ADD], claims: [] };
  }
  async execute(): Promise<void> {
    this.executed += 1;
  }
}

class InvalidGraphTarget implements ReplayTarget {
  captures = 0;
  executed = 0;
  constructor(private readonly captureGraph: () => unknown) {}
  async capture(): Promise<unknown> {
    this.captures += 1;
    return this.captureGraph();
  }
  async execute(): Promise<void> {
    this.executed += 1;
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

  it("rejects a direct legacy replay observation before executing actions", async () => {
    const signer = LocalSkillSigner.generate();
    const bundle = await signer.sign(unsignedBundle(signer.keyId));
    const controller = new SkillReplayController({ signer });
    const target = new LegacyObservationTarget();

    const result = await controller.run(bundle, target, scope);

    expect(result).toEqual({ status: "blocked", errorCode: "ObservationSchemaInvalid" });
    expect(target.captures).toBe(1);
    expect(target.executed).toBe(0);
  });

  it("uses canonical redacted web/v1 path semantics for URL checkpoints", async () => {
    const signer = LocalSkillSigner.generate();
    const bundle = await signer.sign(unsignedBundle(signer.keyId));
    const controller = new SkillReplayController({ signer });

    const result = await controller.run(bundle, new CartTarget("normal"), scope);

    expect(result).toEqual({ status: "passed" });
  });

  it("checks claim_satisfied checkpoints through the typed skill-replay/v1 extension", async () => {
    const signer = LocalSkillSigner.generate();
    const bundle = await signer.sign(unsignedBundle(signer.keyId, claimCheckpointPayload()));
    const controller = new SkillReplayController({ signer });

    const result = await controller.run(bundle, new CartTarget("normal"), scope);

    expect(result).toEqual({ status: "passed" });
  });

  it("rejects a web v1 replay graph without the required web/v1 extension", async () => {
    const signer = LocalSkillSigner.generate();
    const bundle = await signer.sign(unsignedBundle(signer.keyId));
    const controller = new SkillReplayController({ signer });
    const target = new InvalidGraphTarget(() => ({
      ...webReplayGraph("/product", [QTY, ADD]),
      extensions: {},
    }));

    const result = await controller.run(bundle, target, scope);

    expect(result).toEqual({ status: "blocked", errorCode: "ExtensionVersionUnsupported" });
    expect(target.captures).toBe(1);
    expect(target.executed).toBe(0);
  });

  it("rejects raw web/v1 query values before replay consumers use URL state", async () => {
    const signer = LocalSkillSigner.generate();
    const bundle = await signer.sign(unsignedBundle(signer.keyId));
    const controller = new SkillReplayController({ signer });
    const graph = webReplayGraph("/product", [QTY, ADD]);
    const web = graph.extensions?.["web/v1"];
    const target = new InvalidGraphTarget(() => ({
      ...graph,
      extensions: {
        ...graph.extensions,
        "web/v1": {
          ...web,
          payload: {
            ...web?.payload,
            query: { token: "raw-secret" },
          },
        },
      },
    }));

    const result = await controller.run(bundle, target, scope);

    expect(result).toEqual({ status: "blocked", errorCode: "ObservationSchemaInvalid" });
    expect(target.captures).toBe(1);
    expect(target.executed).toBe(0);
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
