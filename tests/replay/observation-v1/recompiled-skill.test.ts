import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { LocalSkillSigner } from "@qualigence/kms-local";
import {
  SkillCompiler,
  type OracleResult,
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
} from "../../helpers/skill-reverifier.js";

async function loadFixture(): Promise<{
  recording: RecordingSession;
  proposal: SkillInductionProposal;
  previous: PreV1SkillReference;
}> {
  const path = fileURLToPath(
    new URL(
      "../../fixtures/migration/pre-v1/m2-procedure-skill.json",
      import.meta.url,
    ),
  );
  return JSON.parse(await readFile(path, "utf8")) as {
    recording: RecordingSession;
    proposal: SkillInductionProposal;
    previous: PreV1SkillReference;
  };
}

/** The per-oracle status vector — the observable "behavior" of a replayed Skill. */
function oracleVector(oracles: readonly OracleResult[]): Record<string, string> {
  return Object.fromEntries(oracles.map((oracle) => [oracle.oracle, oracle.status]));
}

describe("recompiled Skill replays behaviorally identically to pre-v1", () => {
  it("produces the same replay-oracle results before and after migration", async () => {
    const fixture = await loadFixture();
    const signer = LocalSkillSigner.generate();

    // The pre-v1 baseline: verify the ORIGINAL (epoch pre-v1) candidate against
    // the same live Targets.
    const preV1Candidate = new SkillCompiler().compile(
      fixture.recording,
      fixture.proposal,
    );
    expect(preV1Candidate.observationSchemaEpoch).toBe("pre-v1");
    const baseline = await new StandardReverifier(signer, resolvingTargets).verify({
      candidate: preV1Candidate,
      previous: fixture.previous,
    });

    // The migration path: recompile to v1, then verify with the same Targets.
    const recompiler = new SkillRecompiler(
      new StandardReverifier(signer, resolvingTargets),
    );
    const asset: PreV1SkillAsset = {
      assetId: "skill-m2-cart",
      recording: fixture.recording,
      proposal: fixture.proposal,
      previous: fixture.previous,
    };
    const outcome = await recompiler.recompile(asset);

    expect(outcome.status).toBe("migrated");
    expect(outcome.candidate?.observationSchemaEpoch).toBe("v1");
    expect(baseline.outcome).toBe("passed");
    expect(outcome.evaluation?.outcome).toBe("passed");

    // Identical oracle-by-oracle result vector: behavior is unchanged.
    expect(oracleVector(outcome.evaluation!.oracles)).toEqual(
      oracleVector(baseline.oracles),
    );
  });
});
