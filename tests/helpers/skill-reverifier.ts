import { LocalSkillSigner } from "@qualigence/kms-local";
import {
  SkillReplayController,
  type ReplayTarget,
  type ResolvedReplayAction,
} from "@qualigence/skill-replay";
import {
  SkillVerifier,
  TestSkill,
  skillCommand,
  bundlePayloadContentSha256,
  type ProcedureSkillVersion,
  type SignedSkillBundle,
  type SkillCandidate,
  type SkillEvaluation,
  type SkillReplayFixture,
  type SkillReplayPort,
  type SkillVerificationScope,
  type UnsignedSkillBundle,
} from "@qualigence/skill";
import type {
  PreV1SkillReference,
  RecompiledSkillReverifier,
} from "@qualigence/observation-migration";

/** Selects the live Target a given replay fixture exercises. */
export type TargetFactory = (fixture: SkillReplayFixture) => ReplayTarget;

/** The standard four-fixture oracle battery used across recompilation tests. */
export const STANDARD_FIXTURES: readonly SkillReplayFixture[] = [
  { name: "normal-1", kind: "normal" },
  { name: "normal-2", kind: "normal" },
  { name: "dom", kind: "dom-variation" },
  { name: "negative", kind: "precondition-negative" },
];

function unsignedBundle(
  signerKeyId: string,
  version: ProcedureSkillVersion,
): UnsignedSkillBundle {
  return {
    bundleId: `bundle-${version.skillId}-${version.version}`,
    skillId: version.skillId,
    skillVersion: version.version,
    schemaVersion: "skill-bundle/v1",
    compilerVersion: version.compilerVersion,
    contentSha256: version.contentSha256,
    signerKeyId,
    signatureAlgorithm: "Ed25519",
    issuedAt: "2026-08-01T00:03:00.000Z",
    payload: version,
  };
}

/**
 * A real reverifier: it turns a recompiled candidate into a signed Bundle,
 * verifies the signature, replays it across the standard oracle battery and
 * folds the results into a {@link SkillEvaluation}. It uses the exact same
 * signing/replay/verification components as normal Skill promotion.
 */
export class StandardReverifier implements RecompiledSkillReverifier {
  constructor(
    private readonly signer: LocalSkillSigner,
    private readonly targetFor: TargetFactory,
    private readonly fixtures: readonly SkillReplayFixture[] = STANDARD_FIXTURES,
    private readonly idFactory: () => string = () => "eval-recompiled",
  ) {}

  async verify(input: {
    readonly candidate: SkillCandidate;
    readonly previous: PreV1SkillReference;
  }): Promise<SkillEvaluation> {
    const { candidate, previous } = input;

    const skill = TestSkill.draft({
      skillId: previous.skillId,
      projectId: previous.projectId,
      targetScope: previous.targetScope,
    });
    skill.markCandidate({ ...skillCommand(1, "recompile-1"), candidate });
    const version = skill.snapshot();

    const bundlePayload: ProcedureSkillVersion = {
      ...version,
      contentSha256: bundlePayloadContentSha256(version),
    };
    const signed = await this.signer.sign(
      unsignedBundle(this.signer.keyId, bundlePayload),
    );

    const origin = previous.targetScope.allowedOrigins[0];
    const scope: SkillVerificationScope = {
      projectId: previous.projectId,
      targetId: previous.targetScope.targetId,
      ...(origin !== undefined ? { origin } : {}),
    };
    const signatureVerification = await this.signer.verify(signed, scope);

    const controller = new SkillReplayController({ signer: this.signer });
    const port: SkillReplayPort = {
      replay: (bundle: SignedSkillBundle, fixture: SkillReplayFixture) =>
        controller.run(bundle, this.targetFor(fixture), scope),
    };

    return new SkillVerifier({
      replay: port,
      clock: { now: () => "2026-08-01T00:02:00.000Z" },
      idFactory: this.idFactory,
    }).verify({ bundle: signed, signatureVerification, fixtures: this.fixtures });
  }
}

/** A Target that resolves the "Add to cart" step and reaches the /cart checkpoint. */
export class CartTarget implements ReplayTarget {
  private path = "/product/mouse";
  constructor(private readonly variant: "normal" | "dom" = "normal") {}
  async capture() {
    const nodes =
      this.variant === "dom"
        ? [
            { role: "button", name: "Add to cart", text: "Add to cart now" },
            { role: "link", name: "Back to catalog" },
          ]
        : [{ role: "button", name: "Add to cart" }];
    return { urlPath: this.path, nodes, claims: [] };
  }
  async execute(action: ResolvedReplayAction): Promise<void> {
    if (action.step.intent.kind === "click") {
      this.path = "/cart";
    }
  }
}

/** A Target whose duplicated buttons make the semantic locator ambiguous. */
export class AmbiguousCartTarget implements ReplayTarget {
  async capture() {
    return {
      urlPath: "/product/mouse",
      nodes: [
        { role: "button", name: "Add to cart" },
        { role: "button", name: "Add to cart" },
      ],
      claims: [],
    };
  }
  async execute(): Promise<void> {
    throw new Error("must not execute when the locator is ambiguous");
  }
}

/** A Target parked off the precondition path, forcing a safe divergence. */
export class OffTarget implements ReplayTarget {
  async capture() {
    return {
      urlPath: "/home",
      nodes: [{ role: "button", name: "Add to cart" }],
      claims: [],
    };
  }
  async execute(): Promise<void> {
    throw new Error("must not execute after divergence");
  }
}

/** Targets that let a well-grounded Skill replay to `passed`. */
export function resolvingTargets(fixture: SkillReplayFixture): ReplayTarget {
  if (fixture.kind === "precondition-negative") {
    return new OffTarget();
  }
  return new CartTarget(fixture.kind === "dom-variation" ? "dom" : "normal");
}

/** Targets where every normal replay diverges on an ambiguous locator. */
export function ambiguousTargets(fixture: SkillReplayFixture): ReplayTarget {
  if (fixture.kind === "precondition-negative") {
    return new OffTarget();
  }
  return new AmbiguousCartTarget();
}
