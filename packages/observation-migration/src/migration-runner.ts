import { createHash } from "node:crypto";
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

/** The immutable per-asset migration result recorded in the append-only ledger. */
export interface ObservationMigrationResult {
  readonly assetId: string;
  readonly assetKind?: "observation" | "skill";
  readonly sourceHash: string;
  readonly status: ObservationMigrationStatus;
  readonly outputRef?: string;
  readonly reasonCode?: string;
  readonly migratorVersion: string;
  readonly sourceTraceRefs?: readonly string[];
  /** Declared source hash when it mismatches the computed source payload hash. */
  readonly expectedSourceHash?: string;
  /** Original pre-v1 Skill content hash when a Skill result is keyed by source Trace hash. */
  readonly skillSourceHash?: string;
  /** Original pre-v1 Skill version when a Skill result is keyed by source Trace hash. */
  readonly skillVersion?: number;
  /** Hash of the actual Skill inventory source bytes used to distinguish stale declared content hashes. */
  readonly skillAssetHash?: string;
  readonly computedSkillSourceHash?: string;
  readonly locatorSchemaVersion?: string;
  readonly skillCompilerVersion?: string;
}

/** Optional identity fields that distinguish Skill inventory attempts sharing one source Trace. */
export interface ObservationMigrationLookupIdentity {
  readonly skillSourceHash?: string;
  readonly skillVersion?: number;
  readonly skillAssetHash?: string;
}

/** A durable, append-only migration ledger entry. */
export interface StoredObservationMigration {
  readonly result: ObservationMigrationResult;
  readonly projection?: ObservationGraphV1;
  readonly metadata?: PreV1AssetMetadata;
}

/**
 * The durable, append-only store the runner uses for idempotency and resume.
 * Observation results are keyed by `(assetId, sourceHash, migratorVersion)` so a
 * re-run with unchanged source returns the existing result, while a changed
 * source becomes a new attempt. Skill inventory results also include the
 * immutable Skill version/content hash and actual Skill asset hash because
 * several Skill versions or stale declared hashes can share one source Trace
 * hash.
 */
export interface ObservationMigrationStore {
  find(
    assetId: string,
    sourceHash: string,
    migratorVersion?: string,
    identity?: ObservationMigrationLookupIdentity,
  ): Promise<StoredObservationMigration | undefined>;
  append(record: StoredObservationMigration): Promise<void>;
  list(): Promise<readonly StoredObservationMigration[]>;
}

export interface ObservationMigrationRunnerOptions {
  /** When true, the runner projects and classifies but never persists. */
  readonly dryRun?: boolean;
}

interface SourceHashBinding {
  /** The hash computed from the actual source payload observed in this run. */
  readonly sourceHash: string;
  /** The declared source hash when it mismatches the computed source payload. */
  readonly expectedSourceHash?: string;
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
    const sourceBinding = this.sourceHashForLedger(asset);
    const record = this.classify(asset, sourceBinding);

    if (this.canReturnExistingResult(record.result)) {
      const existing = await this.store.find(
        asset.assetId,
        sourceBinding.sourceHash,
        record.result.migratorVersion,
      );
      if (existing !== undefined) {
        return existing.result;
      }
    }
    if (options.dryRun !== true) {
      await this.store.append(record);
    }
    return record.result;
  }

  private classify(
    asset: PreV1ObservationAsset,
    sourceBinding: SourceHashBinding,
  ): StoredObservationMigration {
    try {
      const projected = this.projector.projectRecord(asset);
      if (asset.kind === "skill") {
        return {
          result: {
            ...this.baseResult(asset, sourceBinding),
            status: "needs_human",
            reasonCode: "SkillInventoryRunnerRequired",
          },
        };
      }
      const outputRef = observationGraphHash(projected.graph);
      return {
        result: {
          ...this.baseResult(asset, sourceBinding),
          status: "migrated",
          outputRef,
        },
        projection: projected.graph,
        metadata: projected.metadata,
      };
    } catch (error) {
      return {
        result: {
          ...this.baseResult(asset, sourceBinding),
          ...this.classifyFailure(error),
        },
      };
    }
  }

  private baseResult(
    asset: PreV1ObservationAsset,
    sourceBinding: SourceHashBinding,
  ): Omit<ObservationMigrationResult, "status"> {
    return {
      assetId: asset.assetId,
      assetKind: asset.kind,
      sourceHash: sourceBinding.sourceHash,
      migratorVersion: this.migratorVersion,
      ...(sourceBinding.expectedSourceHash === undefined
        ? {}
        : { expectedSourceHash: sourceBinding.expectedSourceHash }),
      ...(asset.locatorSchemaVersion === undefined
        ? {}
        : { locatorSchemaVersion: asset.locatorSchemaVersion }),
      ...(asset.skillCompilerVersion === undefined
        ? {}
        : { skillCompilerVersion: asset.skillCompilerVersion }),
    };
  }

  private sourceHashForLedger(asset: PreV1ObservationAsset): SourceHashBinding {
    try {
      const computed = this.projector.sourceHash(asset);
      return this.bindComputedSourceHash(asset, computed);
    } catch {
      const raw = JSON.stringify(asset.observation ?? null);
      return this.bindComputedSourceHash(
        asset,
        createHash("sha256").update(raw).digest("hex"),
      );
    }
  }

  private bindComputedSourceHash(
    asset: PreV1ObservationAsset,
    computed: string,
  ): SourceHashBinding {
    if (
      asset.declaredSourceHash !== undefined &&
      asset.declaredSourceHash !== computed
    ) {
      return { sourceHash: computed, expectedSourceHash: asset.declaredSourceHash };
    }
    return { sourceHash: computed };
  }

  private canReturnExistingResult(result: ObservationMigrationResult): boolean {
    // A source integrity failure must never be hidden by a prior successful
    // record for the same asset. The caller sees the freshly verified failure;
    // append remains duplicate-safe if that exact failed binding already exists.
    return result.reasonCode !== "SourceAssetCorrupted";
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
    migratorVersion: string = OBSERVATION_MIGRATOR_VERSION,
    identity: ObservationMigrationLookupIdentity = {},
  ): Promise<StoredObservationMigration | undefined> {
    return this.records.get(
      this.key(assetId, sourceHash, migratorVersion, identity),
    );
  }

  async append(record: StoredObservationMigration): Promise<void> {
    const key = this.recordKey(record);
    if (this.records.has(key)) {
      return;
    }
    this.records.set(key, record);
  }

  async list(): Promise<readonly StoredObservationMigration[]> {
    return [...this.records.values()];
  }

  private recordKey(record: StoredObservationMigration): string {
    return this.key(
      record.result.assetId,
      record.result.sourceHash,
      record.result.migratorVersion,
      record.result,
    );
  }

  private key(
    assetId: string,
    sourceHash: string,
    migratorVersion: string,
    identity: ObservationMigrationLookupIdentity = {},
  ): string {
    return [
      assetId,
      sourceHash,
      migratorVersion,
      ...skillIdentityKeyParts(identity),
    ].join("\u0000");
  }
}

function skillIdentityKeyParts(
  identity: ObservationMigrationLookupIdentity,
): readonly string[] {
  if (
    identity.skillSourceHash === undefined &&
    identity.skillVersion === undefined &&
    identity.skillAssetHash === undefined
  ) {
    return [];
  }
  return [
    "skill",
    identity.skillSourceHash ?? "",
    identity.skillVersion === undefined ? "" : String(identity.skillVersion),
    identity.skillAssetHash ?? "",
  ];
}
