import { buildFreezeReport, type ObservationFreezeReportV1 } from "./freeze-report.js";
import {
  OBSERVATION_MIGRATOR_VERSION,
  type PreV1ObservationAsset,
} from "./pre-v1-projector.js";
import type {
  ObservationMigrationResult,
  ObservationMigrationRunnerOptions,
  ObservationMigrationStore,
} from "./migration-runner.js";
import {
  ObservationMigrationRunner,
} from "./migration-runner.js";
import type {
  PreV1SkillAsset,
  RecompileOutcome,
} from "./skill-recompiler.js";
import { SkillRecompiler } from "./skill-recompiler.js";

/** A full active Skill inventory record, combining the source Trace projection payload and Skill source. */
export interface PreV1SkillInventoryAsset
  extends PreV1ObservationAsset,
    PreV1SkillAsset {
  readonly kind: "skill";
}

/** The active pre-v1 inventory accepted by the candidate Gate. */
export type ActivePreV1InventoryAsset =
  | (PreV1ObservationAsset & { readonly kind: "observation" })
  | PreV1SkillInventoryAsset;

export interface CandidateInventoryRunOptions
  extends ObservationMigrationRunnerOptions {
  readonly now?: () => string;
}

/**
 * Runs the Ticket 25 active pre-v1 inventory in one place: Trace observations
 * are projected through the historical decoder, and active Skills are
 * recompiled/reverified through the existing Skill pipeline before both classes
 * are appended to the same immutable migration ledger and candidate report.
 */
export class ObservationCandidateInventoryRunner {
  private readonly observationRunner: ObservationMigrationRunner;

  constructor(
    private readonly store: ObservationMigrationStore,
    private readonly skillRecompiler: SkillRecompiler,
    observationRunner?: ObservationMigrationRunner,
  ) {
    this.observationRunner = observationRunner ?? new ObservationMigrationRunner(store);
  }

  async run(
    assets: readonly ActivePreV1InventoryAsset[],
    options: CandidateInventoryRunOptions = {},
  ): Promise<ObservationFreezeReportV1> {
    const results: ObservationMigrationResult[] = [];
    for (const asset of assets) {
      results.push(await this.migrateAsset(asset, options));
    }
    return buildFreezeReport(results, options.now);
  }

  private async migrateAsset(
    asset: ActivePreV1InventoryAsset,
    options: ObservationMigrationRunnerOptions,
  ): Promise<ObservationMigrationResult> {
    if (isSkillInventoryAsset(asset)) {
      return this.migrateSkill(asset, options);
    }
    return this.observationRunner.migrate(asset, options);
  }

  private async migrateSkill(
    asset: PreV1SkillInventoryAsset,
    options: ObservationMigrationRunnerOptions,
  ): Promise<ObservationMigrationResult> {
    const migratorVersion = skillMigratorVersion(asset);
    const outcome = await this.skillRecompiler.recompile(asset);
    const result = skillOutcomeToMigrationResult(asset, outcome, migratorVersion);
    const existing = await this.store.find(
      asset.assetId,
      result.sourceHash,
      migratorVersion,
    );
    if (existing !== undefined) {
      return existing.result;
    }

    if (options.dryRun !== true) {
      await this.store.append({ result });
    }
    return result;
  }
}

function isSkillInventoryAsset(
  asset: ActivePreV1InventoryAsset,
): asset is PreV1SkillInventoryAsset {
  return (
    asset.kind === "skill" &&
    "recording" in asset &&
    "proposal" in asset &&
    "previous" in asset
  );
}

function skillMigratorVersion(asset: PreV1SkillInventoryAsset): string {
  return `${OBSERVATION_MIGRATOR_VERSION}+${asset.previous.compilerVersion}`;
}

function skillOutcomeToMigrationResult(
  asset: PreV1SkillInventoryAsset,
  outcome: RecompileOutcome,
  migratorVersion: string,
): ObservationMigrationResult {
  return {
    assetId: asset.assetId,
    assetKind: "skill",
    sourceHash: outcome.computedContentSha256 ?? outcome.sourceContentSha256,
    status: outcome.status,
    ...(outcome.candidate === undefined
      ? {}
      : { outputRef: outcome.candidate.contentSha256 }),
    ...(outcome.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }),
    migratorVersion,
    sourceTraceRefs: [...asset.recording.sourceTraceRefs],
    ...(outcome.computedContentSha256 === undefined
      ? {}
      : { expectedSourceHash: outcome.sourceContentSha256 }),
    locatorSchemaVersion: asset.previous.locatorSchemaVersion,
    skillCompilerVersion: asset.previous.compilerVersion,
  };
}
