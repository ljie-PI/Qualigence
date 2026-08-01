import {
  ObservationError,
  observationGraphHash,
  type ObservationGraphV1,
  type PreV1AssetMetadata,
} from "@qualigence/observation-contracts";
import {
  OBSERVATION_MIGRATOR_VERSION,
  PreV1TraceProjector,
  type PreV1ObservationAsset,
} from "./pre-v1-projector.js";

/** The terminal disposition of one migrated asset. */
export type ObservationMigrationStatus =
  | "migrated"
  | "deprecated"
  | "needs_human"
  | "failed";

/** The immutable per-asset migration result, keyed by asset + source hash. */
export interface ObservationMigrationResult {
  readonly assetId: string;
  readonly sourceHash: string;
  readonly status: ObservationMigrationStatus;
  readonly outputRef?: string;
  readonly reasonCode?: string;
  readonly migratorVersion: string;
}

/** A durable, append-only migration ledger entry. */
export interface StoredObservationMigration {
  readonly result: ObservationMigrationResult;
  readonly projection?: ObservationGraphV1;
  readonly metadata?: PreV1AssetMetadata;
}

/**
 * The durable, append-only store the runner uses for idempotency and resume.
 * `find` is keyed by `(assetId, sourceHash)` so a re-run with unchanged source
 * returns the existing result, while a changed source becomes a new attempt.
 */
export interface ObservationMigrationStore {
  find(
    assetId: string,
    sourceHash: string,
  ): Promise<StoredObservationMigration | undefined>;
  append(record: StoredObservationMigration): Promise<void>;
  list(): Promise<readonly StoredObservationMigration[]>;
}

export interface ObservationMigrationRunnerOptions {
  /** When true, the runner projects and classifies but never persists. */
  readonly dryRun?: boolean;
}

/**
 * The idempotent, resumable migration runner. It projects each pre-v1 asset to a
 * v1 candidate, classifies the outcome, and appends an immutable ledger entry.
 * A batch failure never rolls back an already-appended projection because the
 * historical source is unchanged — the ledger records each asset's status.
 */
export class ObservationMigrationRunner {
  private readonly projector: PreV1TraceProjector;

  constructor(
    private readonly store: ObservationMigrationStore,
    projector: PreV1TraceProjector = new PreV1TraceProjector(),
  ) {
    this.projector = projector;
  }

  get migratorVersion(): string {
    return OBSERVATION_MIGRATOR_VERSION;
  }

  async migrate(
    asset: PreV1ObservationAsset,
    options: ObservationMigrationRunnerOptions = {},
  ): Promise<ObservationMigrationResult> {
    const sourceHash = this.projector.sourceHash(asset);

    const existing = await this.store.find(asset.assetId, sourceHash);
    if (existing !== undefined) {
      return existing.result;
    }

    const record = this.classify(asset, sourceHash);
    if (options.dryRun !== true) {
      await this.store.append(record);
    }
    return record.result;
  }

  private classify(
    asset: PreV1ObservationAsset,
    sourceHash: string,
  ): StoredObservationMigration {
    try {
      const projected = this.projector.projectRecord(asset);
      const outputRef = observationGraphHash(projected.graph);
      return {
        result: {
          assetId: asset.assetId,
          sourceHash,
          status: "migrated",
          outputRef,
          migratorVersion: this.migratorVersion,
        },
        projection: projected.graph,
        metadata: projected.metadata,
      };
    } catch (error) {
      return {
        result: {
          assetId: asset.assetId,
          sourceHash,
          ...this.classifyFailure(error),
          migratorVersion: this.migratorVersion,
        },
      };
    }
  }

  private classifyFailure(error: unknown): {
    readonly status: ObservationMigrationStatus;
    readonly reasonCode: string;
  } {
    if (error instanceof ObservationError) {
      switch (error.code) {
        // A source we cannot even read is an explained failure, never silent.
        case "SourceAssetCorrupted":
          return { status: "failed", reasonCode: error.code };
        // A source that is readable but not expressible in v1 is deprecated.
        case "ProjectionUnsupported":
          return { status: "deprecated", reasonCode: error.code };
        default:
          return { status: "failed", reasonCode: error.code };
      }
    }
    return { status: "failed", reasonCode: "UnknownProjectionError" };
  }
}

/** A simple in-memory store, used by tests and dry-runs. */
export class InMemoryObservationMigrationStore
  implements ObservationMigrationStore
{
  private readonly records = new Map<string, StoredObservationMigration>();

  async find(
    assetId: string,
    sourceHash: string,
  ): Promise<StoredObservationMigration | undefined> {
    return this.records.get(this.key(assetId, sourceHash));
  }

  async append(record: StoredObservationMigration): Promise<void> {
    const key = this.key(record.result.assetId, record.result.sourceHash);
    if (this.records.has(key)) {
      return;
    }
    this.records.set(key, record);
  }

  async list(): Promise<readonly StoredObservationMigration[]> {
    return [...this.records.values()];
  }

  private key(assetId: string, sourceHash: string): string {
    return `${assetId}\u0000${sourceHash}`;
  }
}
