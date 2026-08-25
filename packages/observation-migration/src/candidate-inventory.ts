import { createHash } from "node:crypto";
import { ObservationError } from "@qualigence/observation-contracts";
import { buildFreezeReport, type ObservationFreezeReportV1 } from "./freeze-report.js";
import {
  OBSERVATION_MIGRATOR_VERSION,
  PreV1TraceProjector,
  type PreV1ObservationAsset,
  type ProjectionRecord,
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
  private readonly sourceProjector: PreV1TraceProjector;

  constructor(
    private readonly store: ObservationMigrationStore,
    private readonly skillRecompiler: SkillRecompiler,
    observationRunner?: ObservationMigrationRunner,
    sourceProjector: PreV1TraceProjector = new PreV1TraceProjector(),
  ) {
    this.observationRunner = observationRunner ?? new ObservationMigrationRunner(store);
    this.sourceProjector = sourceProjector;
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
    const sourceBinding = this.skillSourceBinding(asset, migratorVersion);
    const existing = await this.store.find(
      asset.assetId,
      sourceBinding.sourceHash,
      migratorVersion,
    );
    if (existing !== undefined) {
      return existing.result;
    }

    if (sourceBinding.failure !== undefined) {
      if (options.dryRun !== true) {
        await this.store.append({ result: sourceBinding.failure });
      }
      return sourceBinding.failure;
    }

    const outcome = await this.skillRecompiler.recompile(asset);
    const result = skillOutcomeToMigrationResult(
      asset,
      outcome,
      migratorVersion,
      sourceBinding.projection,
    );
    if (options.dryRun !== true) {
      await this.store.append({
        result,
        projection: sourceBinding.projection.graph,
        metadata: sourceBinding.projection.metadata,
      });
    }
    return result;
  }

  private skillSourceBinding(
    asset: PreV1SkillInventoryAsset,
    migratorVersion: string,
  ):
    | {
        readonly sourceHash: string;
        readonly projection: ProjectionRecord;
        readonly failure?: undefined;
      }
    | {
        readonly sourceHash: string;
        readonly projection?: undefined;
        readonly failure: ObservationMigrationResult;
      } {
    try {
      const projection = this.sourceProjector.projectRecord(asset);
      return { sourceHash: projection.sourceHash, projection };
    } catch (error) {
      const { sourceHash, expectedSourceHash } = this.sourceHashForFailedSkillSource(asset);
      return {
        sourceHash,
        failure: {
          ...baseSkillResult(asset, sourceHash, migratorVersion),
          ...classifySkillSourceFailure(error),
          ...(expectedSourceHash === undefined ? {} : { expectedSourceHash }),
        },
      };
    }
  }

  private sourceHashForFailedSkillSource(asset: PreV1SkillInventoryAsset): {
    readonly sourceHash: string;
    readonly expectedSourceHash?: string;
  } {
    try {
      const computed = this.sourceProjector.sourceHash(asset);
      if (
        asset.declaredSourceHash !== undefined &&
        asset.declaredSourceHash !== computed
      ) {
        return { sourceHash: asset.declaredSourceHash, expectedSourceHash: computed };
      }
      return { sourceHash: computed };
    } catch {
      const raw = JSON.stringify(asset.observation ?? null);
      return {
        sourceHash:
          asset.declaredSourceHash ??
          createHash("sha256").update(raw).digest("hex"),
      };
    }
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
  sourceProjection: ProjectionRecord,
): ObservationMigrationResult {
  return {
    ...baseSkillResult(asset, sourceProjection.sourceHash, migratorVersion),
    status: outcome.status,
    ...(outcome.candidate === undefined
      ? {}
      : { outputRef: outcome.candidate.contentSha256 }),
    ...(outcome.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }),
    skillSourceHash: outcome.sourceContentSha256,
    ...(outcome.computedContentSha256 === undefined
      ? {}
      : { computedSkillSourceHash: outcome.computedContentSha256 }),
  };
}

function baseSkillResult(
  asset: PreV1SkillInventoryAsset,
  sourceHash: string,
  migratorVersion: string,
): Omit<ObservationMigrationResult, "status"> {
  return {
    assetId: asset.assetId,
    assetKind: "skill",
    sourceHash,
    migratorVersion,
    sourceTraceRefs: [...asset.recording.sourceTraceRefs],
    locatorSchemaVersion: asset.previous.locatorSchemaVersion,
    skillCompilerVersion: asset.previous.compilerVersion,
    skillSourceHash: asset.previous.contentSha256,
  };
}

function classifySkillSourceFailure(error: unknown): {
  readonly status: "deprecated" | "failed";
  readonly reasonCode: string;
} {
  if (error instanceof ObservationError) {
    switch (error.code) {
      case "ProjectionUnsupported":
        return { status: "deprecated", reasonCode: error.code };
      case "SourceAssetCorrupted":
      default:
        return { status: "failed", reasonCode: error.code };
    }
  }
  return { status: "failed", reasonCode: "UnknownProjectionError" };
}
