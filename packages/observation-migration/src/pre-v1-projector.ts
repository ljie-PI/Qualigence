import type { ObservationGraph } from "@qualigence/runner-protocol";
import {
  canonicalObservationHash,
  observationError,
  validateObservationGraphV1,
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_TYPE,
  type ObservationGraphV1,
  type ObservationNodeV1,
  type ObservationTarget,
  type PreV1AssetMetadata,
} from "@qualigence/observation-contracts";

/** The migrator version stamped onto every projection and result. */
export const OBSERVATION_MIGRATOR_VERSION = "observation-migrator/v1" as const;

/** The default source-kind assigned to a projected node when the asset omits one. */
const DEFAULT_SOURCE_KIND = "accessibility";

/**
 * A pre-v1 observation asset envelope, as inventoried from historical Traces or
 * the Web Playwright adapter output. The `observation` payload is the exact
 * pre-v1 flat {@link ObservationGraph} shape; the envelope adds the provenance a
 * v1 projection needs (target identity, adapter, source schema version).
 *
 * Historical payloads are never mutated: a projection is a NEW, re-derivable
 * artifact and this envelope stays intact.
 */
export interface PreV1ObservationAsset {
  readonly assetId: string;
  readonly kind: "observation" | "skill";
  readonly sourceSchemaVersion: string;
  readonly target: ObservationTarget;
  readonly adapterId: string;
  readonly sourceKind?: string;
  readonly capturedAt?: string;
  readonly observation: ObservationGraph;
  /**
   * Optional integrity guard. When present it must equal the canonical hash of
   * the pre-v1 `observation` payload; a mismatch means the source bytes were
   * corrupted and the asset is refused (`SourceAssetCorrupted`).
   */
  readonly declaredSourceHash?: string;
  readonly locatorSchemaVersion?: string;
  readonly skillCompilerVersion?: string;
}

/** The immutable outcome of projecting one pre-v1 asset to a v1 candidate. */
export interface ProjectionRecord {
  readonly assetId: string;
  readonly sourceHash: string;
  readonly graph: ObservationGraphV1;
  readonly metadata: PreV1AssetMetadata;
  readonly migratorVersion: string;
}

/**
 * The deterministic pre-v1 → v1 projector. It verifies the source integrity,
 * re-derives a schema-valid v1 candidate Graph (never a lossy flatten), and
 * tags the result with `pre-v1` provenance so the asset remains re-projectable.
 */
export class PreV1TraceProjector {
  readonly version = OBSERVATION_MIGRATOR_VERSION;

  /** Compute the canonical source hash of a pre-v1 asset's observation payload. */
  sourceHash(asset: PreV1ObservationAsset): string {
    return canonicalObservationHash(asset.observation);
  }

  /** Project a pre-v1 asset to a v1 candidate Graph. */
  project(asset: PreV1ObservationAsset): ObservationGraphV1 {
    return this.projectRecord(asset).graph;
  }

  /** Project and return the full provenance-bearing record. */
  projectRecord(asset: PreV1ObservationAsset): ProjectionRecord {
    const sourceHash = this.verifiedSourceHash(asset);
    const graph = this.toV1(asset);

    try {
      validateObservationGraphV1(graph);
    } catch (error) {
      throw observationError(
        "ProjectionUnsupported",
        `Asset "${asset.assetId}" could not be projected to a valid v1 graph: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const metadata: PreV1AssetMetadata = {
      observationSchemaEpoch: "pre-v1",
      sourceSchemaVersion: asset.sourceSchemaVersion,
      ...(asset.locatorSchemaVersion !== undefined
        ? { locatorSchemaVersion: asset.locatorSchemaVersion }
        : {}),
      ...(asset.skillCompilerVersion !== undefined
        ? { skillCompilerVersion: asset.skillCompilerVersion }
        : {}),
      sourceArtifactRefs: asset.observation.artifactRefs ?? [],
    };

    return {
      assetId: asset.assetId,
      sourceHash,
      graph,
      metadata,
      migratorVersion: this.version,
    };
  }

  private verifiedSourceHash(asset: PreV1ObservationAsset): string {
    const graph = asset.observation;
    if (
      graph === null ||
      typeof graph !== "object" ||
      typeof graph.graphId !== "string" ||
      graph.graphId.length === 0 ||
      !Array.isArray(graph.nodes)
    ) {
      throw observationError(
        "SourceAssetCorrupted",
        `Asset "${asset.assetId}" has a malformed pre-v1 observation payload.`,
      );
    }
    for (const node of graph.nodes) {
      if (
        node === null ||
        typeof node !== "object" ||
        typeof node.id !== "string" ||
        node.id.length === 0 ||
        typeof node.role !== "string" ||
        typeof node.confidence !== "number" ||
        !Number.isFinite(node.confidence)
      ) {
        throw observationError(
          "SourceAssetCorrupted",
          `Asset "${asset.assetId}" has a malformed pre-v1 node.`,
        );
      }
    }

    const hash = canonicalObservationHash(graph);
    if (asset.declaredSourceHash !== undefined && asset.declaredSourceHash !== hash) {
      throw observationError(
        "SourceAssetCorrupted",
        `Asset "${asset.assetId}" source hash mismatch: declared ${asset.declaredSourceHash}, computed ${hash}.`,
      );
    }
    return hash;
  }

  private toV1(asset: PreV1ObservationAsset): ObservationGraphV1 {
    const source = asset.observation;
    const capturedAt = source.capturedAt ?? asset.capturedAt;
    if (capturedAt === undefined || capturedAt.length === 0) {
      throw observationError(
        "ProjectionUnsupported",
        `Asset "${asset.assetId}" has no capturedAt timestamp to project.`,
      );
    }

    const sourceKind = asset.sourceKind ?? DEFAULT_SOURCE_KIND;
    const nodes = source.nodes.map((node) =>
      this.toV1Node(node, asset.adapterId, sourceKind),
    );

    return {
      schema: OBSERVATION_GRAPH_V1_SCHEMA,
      graphId: source.graphId,
      target: asset.target,
      capturedAt,
      // A flat pre-v1 graph has no hierarchy: every node is a root; relations are
      // re-derived by later platform adapters, not fabricated here.
      rootNodeIds: nodes.map((node) => node.id),
      nodes,
      evidenceRefs: source.artifactRefs ?? [],
      ...webExtensionForPreV1Source(asset),
    };
  }

  private toV1Node(
    node: ObservationGraph["nodes"][number],
    adapterId: string,
    sourceKind: string,
  ): ObservationNodeV1 {
    // Legacy `text`/`disabled` map into the v1 `state` map so nothing is dropped
    // and the projection stays re-derivable back to the pre-v1 semantics.
    const state: Record<string, boolean | string | number> = {};
    if (node.disabled !== undefined) {
      state.disabled = node.disabled;
    }
    if (node.text !== undefined) {
      state.text = node.text;
    }

    return {
      id: node.id,
      role: node.role,
      ...(node.name !== undefined ? { name: node.name } : {}),
      ...(node.value !== undefined ? { value: node.value } : {}),
      state,
      relations: [],
      source: { adapterId, sourceKind },
      confidence: node.confidence,
      sensitivity: "public",
      extensions: {},
      evidenceRefs: [],
    };
  }
}

function webExtensionForPreV1Source(asset: PreV1ObservationAsset): Pick<ObservationGraphV1, "extensions"> | Record<string, never> {
  if (asset.target.kind !== "web") {
    return {};
  }
  const sourceUrl = asset.observation.url ?? asset.target.targetId;
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw observationError(
      "ProjectionUnsupported",
      `Asset "${asset.assetId}" has no canonical web URL to project into web/v1 semantics.`,
    );
  }
  return {
    extensions: {
      [WEB_EXTENSION_V1_TYPE]: {
        type: WEB_EXTENSION_V1_TYPE,
        version: "1.0",
        payload: {
          origin: url.origin,
          pathname: url.pathname,
          title: asset.observation.title ?? "",
          viewport: { width: 1, height: 1, devicePixelRatio: 1 },
          query: {},
        },
      },
    },
  };
}
