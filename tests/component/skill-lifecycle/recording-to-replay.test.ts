import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRuntime, SqliteSkillStore } from "@qualigence/sqlite-runtime";
import { LocalSkillSigner } from "@qualigence/kms-local";
import {
  SkillCompiler,
  SkillPromotionPolicy,
  SkillVerifier,
  REQUIRED_REPLAY_ORACLES,
  TestSkill,
  bundlePayloadContentSha256,
  skillCommand,
} from "@qualigence/skill";
import type {
  SignedSkillBundle,
  SkillInductionProposal,
  SkillReplayFixture,
  SkillReplayPort,
  UnsignedSkillBundle,
  SkillVerificationScope,
} from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";
import { PreV1TraceProjector } from "@qualigence/observation-migration";
import { validateObservationGraphV1, type ObservationGraph, type ObservationGraphV1 } from "@qualigence/runner-protocol";
import {
  SkillReplayController,
  type ReplayTarget,
} from "@qualigence/skill-replay";

const scopeOrigin = "https://shop.example";
const scope: SkillVerificationScope = {
  projectId: "proj-1",
  targetId: "web-cart",
  origin: scopeOrigin,
};

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

const proposal: SkillInductionProposal = {
  parameters: [],
  steps: [
    {
      sourceRecordedStepOrdinal: 1,
      intent: { kind: "click", target: { purpose: "add to cart" } },
      preconditions: [{ kind: "url_path", path: "/product" }],
      checkpoint: [{ kind: "url_path", path: "/cart" }],
      recovery: "stop",
    },
  ],
};

const ADD = { role: "button", name: "Add to cart" };
const projector = new PreV1TraceProjector();

function projectedReplayGraph(
  path: string,
  nodes: readonly { readonly role: string; readonly name: string }[],
  graphId = `legacy-${path.replace(/[^a-z0-9]+/gi, "-")}`,
): ObservationGraphV1 {
  const observation: ObservationGraph = {
    graphId,
    url: `${scopeOrigin}${path}?session=legacy-fixture`,
    title: "Skill lifecycle fixture",
    capturedAt: "2026-08-01T00:00:00.000Z",
    artifactRefs: ["recording-graph-ref"],
    nodes: nodes.map((node, index) => ({
      id: `${graphId}:node-${index + 1}`,
      role: node.role,
      name: node.name,
      confidence: 1,
    })),
  };
  return validateObservationGraphV1(projector.project({
    assetId: graphId,
    kind: "skill",
    sourceSchemaVersion: "pre-v1-replay-fixture",
    target: { kind: "web", targetId: scopeOrigin },
    adapterId: "skill-lifecycle-fixture",
    sourceKind: "accessibility",
    observation,
  }));
}

class CartTarget implements ReplayTarget {
  private path = "/product";
  private captures = 0;
  constructor(private readonly variant: "normal" | "dom" = "normal") {}
  async capture(): Promise<ObservationGraphV1> {
    this.captures += 1;
    const nodes =
      this.variant === "dom" ? [{ ...ADD, name: "Add to cart" }] : [ADD];
    return projectedReplayGraph(this.path, nodes, `cart-${this.captures}`);
  }
  async execute(action: { step: { intent: { kind: string } } }): Promise<void> {
    if (action.step.intent.kind === "click") {
      this.path = "/cart";
    }
  }
}

class OffTarget implements ReplayTarget {
  async capture(): Promise<ObservationGraphV1> {
    return projectedReplayGraph("/home", [ADD], "off-target");
  }
  async execute(): Promise<void> {
    throw new Error("must not execute after divergence");
  }
}

function unsignedBundle(
  signerKeyId: string,
  bundle: UnsignedSkillBundle["payload"],
): UnsignedSkillBundle {
  return {
    bundleId: "bundle-1",
    skillId: bundle.skillId,
    skillVersion: bundle.version,
    schemaVersion: "skill-bundle/v1",
    compilerVersion: bundle.compilerVersion,
    contentSha256: bundle.contentSha256,
    signerKeyId,
    signatureAlgorithm: "Ed25519",
    issuedAt: "2026-08-01T00:03:00.000Z",
    payload: bundle,
  };
}

describe("Skill lifecycle — recording to replay end to end", () => {
  let dir: string;
  let runtime: SqliteRuntime;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), ".tmp-skill-e2e-"));
    runtime = await SqliteRuntime.open({
      filename: join(dir, "qualigence.db"),
      busyTimeoutMs: 5_000,
    });
  });

  afterEach(async () => {
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("records, induces, compiles, verifies, signs, promotes, reopens and replays", async () => {
    const store = new SqliteSkillStore(runtime);
    const signer = LocalSkillSigner.generate();
    const controller = new SkillReplayController({ signer });

    // 1. Persist the source Recording.
    await store.saveRecording(recording);

    // 2. Deterministic compile of an approved proposal → candidate content.
    const candidate = new SkillCompiler().compile(recording, proposal);

    // 3. Draft → Candidate aggregate transitions; the first persisted snapshot
    //    is the compiled Candidate (a draft carries no content).
    const skill = TestSkill.draft({
      skillId: "skill-1",
      projectId: "proj-1",
      targetScope: { targetId: "web-cart", allowedOrigins: ["https://shop.example"] },
    });
    skill.markCandidate({ ...skillCommand(1, "mark-1"), candidate });
    const candidateVersion = skill.snapshot();
    await store.saveSkillVersion({
      version: candidateVersion,
      expectedVersion: 0,
      sourceRecording: recording,
    });

    // 4. Sign the Candidate Bundle with a real Ed25519 key. The Bundle payload
    //    carries an identity-inclusive content digest for signature integrity.
    const bundlePayload = {
      ...candidateVersion,
      contentSha256: bundlePayloadContentSha256(candidateVersion),
    };
    const signed = await signer.sign(unsignedBundle(signer.keyId, bundlePayload));
    await store.saveBundle(signed);
    const signatureVerification = await signer.verify(signed, scope);
    expect(signatureVerification.status).toBe("valid");

    // 5. Verify across the four oracles via real replay.
    const port: SkillReplayPort = {
      async replay(bundle: SignedSkillBundle, fixture: SkillReplayFixture) {
        const target =
          fixture.kind === "precondition-negative"
            ? new OffTarget()
            : new CartTarget(fixture.kind === "dom-variation" ? "dom" : "normal");
        return controller.run(bundle, target, scope);
      },
    };
    const fixtures: SkillReplayFixture[] = [
      { name: "normal-1", kind: "normal" },
      { name: "normal-2", kind: "normal" },
      { name: "dom", kind: "dom-variation" },
      { name: "negative", kind: "precondition-negative" },
    ];
    const evaluation = await new SkillVerifier({
      replay: port,
      clock: { now: () => "2026-08-01T00:02:00.000Z" },
      idFactory: () => "eval-1",
    }).verify({ bundle: signed, signatureVerification, fixtures });
    expect(evaluation.outcome).toBe("passed");
    await store.saveEvaluation(evaluation);

    // 6. Candidate → Verified transition and persistence.
    skill.verify({
      ...skillCommand(2, "verify-1"),
      evaluation,
      signatureValid: signatureVerification.status === "valid",
    });
    await store.saveSkillVersion({
      version: skill.snapshot(),
      expectedVersion: 2,
      sourceRecording: recording,
    });

    // 7. Promotion policy gate, then Verified → Promoted.
    const decision = new SkillPromotionPolicy().evaluate({
      version: skill.snapshot(),
      evaluation,
      signatureVerification,
      requiredOracles: REQUIRED_REPLAY_ORACLES,
    });
    expect(decision).toEqual({ status: "approved" });
    skill.promote(skillCommand(3, "promote-1"));
    await store.saveSkillVersion({
      version: skill.snapshot(),
      expectedVersion: 3,
      sourceRecording: recording,
    });

    // 8. Reopen the store and replay the persisted, signed bundle.
    await runtime.close();
    runtime = await SqliteRuntime.open({
      filename: join(dir, "qualigence.db"),
      busyTimeoutMs: 5_000,
    });
    const reopened = new SqliteSkillStore(runtime);
    const promoted = await reopened.latestVersion("skill-1");
    expect(promoted?.state).toBe("promoted");
    expect(promoted?.version).toBe(4);

    const durableBundle = await reopened.bundle("skill-1", signed.manifest.skillVersion);
    expect(durableBundle).toBeDefined();
    const replayResult = await controller.run(
      durableBundle as SignedSkillBundle,
      new CartTarget("normal"),
      scope,
    );
    expect(replayResult).toEqual({ status: "passed" });

    // 9. No signing private key or plaintext secret is ever persisted.
    for (const table of [
      "recordings",
      "recording_steps",
      "skill_versions",
      "skill_evaluations",
      "skill_bundles",
    ] as const) {
      const rows = await runtime.db
        .selectFrom("sqlite_master")
        .select("sql")
        .where("name", "=", table)
        .execute();
      expect(rows.length).toBeGreaterThan(0);
    }
    const bundleRows = await runtime.db
      .selectFrom("skill_bundles")
      .select(["manifest_json", "payload_json"])
      .execute();
    const versionRows = await runtime.db
      .selectFrom("skill_versions")
      .select("content_json")
      .execute();
    const blob = [
      ...bundleRows.map((row) => `${row.manifest_json}${row.payload_json}`),
      ...versionRows.map((row) => row.content_json),
    ].join("");
    expect(blob).not.toContain("PRIVATE KEY");
    expect(blob).not.toContain("BEGIN");
  });
});
