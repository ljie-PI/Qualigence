import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { LocalSkillSigner } from "@qualigence/kms-local";
import {
  SkillCompiler,
  type SkillInductionProposal,
} from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";
import {
  SkillRecompiler,
  type PreV1SkillAsset,
  type PreV1SkillReference,
} from "@qualigence/observation-migration";
import {
  StandardReverifier,
  resolvingTargets,
  ambiguousTargets,
} from "../../helpers/skill-reverifier.js";

interface SkillFixture {
  readonly recording: RecordingSession;
  readonly proposal: SkillInductionProposal;
  readonly previous: PreV1SkillReference;
}

async function loadSkillFixture(): Promise<SkillFixture> {
  const path = fileURLToPath(
    new URL(
      "../../fixtures/migration/pre-v1/m2-procedure-skill.json",
      import.meta.url,
    ),
  );
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    recording: RecordingSession;
    proposal: SkillInductionProposal;
    previous: PreV1SkillReference;
  };
  return { recording: raw.recording, proposal: raw.proposal, previous: raw.previous };
}

function assetFrom(fixture: SkillFixture): PreV1SkillAsset {
  return {
    assetId: "skill-m2-cart",
    recording: fixture.recording,
    proposal: fixture.proposal,
    previous: fixture.previous,
  };
}

describe("pre-v1 Skill recompilation", () => {
  it("recompiles a resolvable pre-v1 Skill into a Verified v1 candidate", async () => {
    const fixture = await loadSkillFixture();
    const signer = LocalSkillSigner.generate();
    const recompiler = new SkillRecompiler(
      new StandardReverifier(signer, resolvingTargets),
    );

    const outcome = await recompiler.recompile(assetFrom(fixture));

    expect(outcome.status).toBe("migrated");
    expect(outcome.candidate?.observationSchemaEpoch).toBe("v1");
    expect(outcome.evaluation?.outcome).toBe("passed");
  });

  it("classifies an ambiguous locator as needs_human", async () => {
    const fixture = await loadSkillFixture();
    const signer = LocalSkillSigner.generate();
    const recompiler = new SkillRecompiler(
      new StandardReverifier(signer, ambiguousTargets),
    );

    const outcome = await recompiler.recompile(assetFrom(fixture));

    expect(outcome.status).toBe("needs_human");
    expect(outcome.reasonCode).toBe("SkillRecompileFailed");
  });

  it("classifies an unsupported/leaky proposal as deprecated without reverifying", async () => {
    const fixture = await loadSkillFixture();
    const signer = LocalSkillSigner.generate();
    // A leaked CSS selector in a semantic field is a deterministic compile
    // rejection — the migrator deprecates rather than guesses.
    const leaky: SkillInductionProposal = {
      ...fixture.proposal,
      steps: [
        {
          ...fixture.proposal.steps[0]!,
          intent: {
            kind: "click",
            target: { purpose: "css=button.add-to-cart" },
          },
        },
      ],
    };
    let reverified = false;
    const recompiler = new SkillRecompiler({
      async verify() {
        reverified = true;
        throw new Error("should not reverify a deprecated asset");
      },
    });

    const outcome = await recompiler.recompile({
      ...assetFrom(fixture),
      proposal: leaky,
    });

    expect(outcome.status).toBe("deprecated");
    expect(outcome.reasonCode).toBe("SelectorLeakRejected");
    expect(reverified).toBe(false);
    void signer;
  });

  it("fails closed when the stored pre-v1 Skill source hash no longer matches", async () => {
    const fixture = await loadSkillFixture();
    const recompiler = new SkillRecompiler(
      new StandardReverifier(LocalSkillSigner.generate(), resolvingTargets),
    );

    const outcome = await recompiler.recompile({
      ...assetFrom(fixture),
      previous: { ...fixture.previous, contentSha256: "0".repeat(64) },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.reasonCode).toBe("MigrationSourceChanged");
    expect(outcome.sourceContentSha256).toBe("0".repeat(64));
    expect(outcome.computedContentSha256).toBe(fixture.previous.contentSha256);
    expect(outcome.candidate).toBeUndefined();
    expect(outcome.evaluation).toBeUndefined();
  });

  it("never mutates the pre-v1 Skill source (bytes and epoch unchanged)", async () => {
    const fixture = await loadSkillFixture();
    const signer = LocalSkillSigner.generate();
    const recompiler = new SkillRecompiler(
      new StandardReverifier(signer, resolvingTargets),
    );

    const before = JSON.stringify(fixture.recording);
    const originalSha = fixture.previous.contentSha256;

    const outcome = await recompiler.recompile(assetFrom(fixture));

    expect(JSON.stringify(fixture.recording)).toBe(before);
    expect(fixture.recording.observationSchemaEpoch).toBe("pre-v1");
    expect(outcome.sourceContentSha256).toBe(originalSha);
    // The recompiled v1 content is a new artifact — a distinct digest.
    expect(outcome.candidate?.contentSha256).not.toBe(originalSha);
  });

  it("compiles the pre-v1 recording deterministically (baseline)", async () => {
    const fixture = await loadSkillFixture();
    const preV1 = new SkillCompiler().compile(fixture.recording, fixture.proposal);
    expect(preV1.observationSchemaEpoch).toBe("pre-v1");
    expect(preV1.contentSha256).toBe(fixture.previous.contentSha256);
  });
});
