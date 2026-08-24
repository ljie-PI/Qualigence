/**
 * Observation Graph v1 — the candidate cross-platform observation contract.
 *
 * This is a CANDIDATE contract. It is intentionally never marked `frozen` in
 * this package: the freeze transition only happens after LS-13 delivers the
 * Windows/UIA conformance evidence (see the M3 freeze gate). The types here are
 * the single source of truth for the Graph; `@qualigence/runner-protocol`
 * re-exports them for a compatibility cycle rather than declaring a second copy.
 */

/** A JSON value restricted to the deterministic, canonicalisable subset. */
export type ObservationJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ObservationJsonValue[]
  | { readonly [key: string]: ObservationJsonValue };

/**
 * The epoch/version discriminator carried by every observation asset. Pre-v1
 * assets keep their historical version string; v1 assets pin the canonical
 * `observation-graph/v1` version.
 */
export type ObservationSchema =
  | { readonly epoch: "pre-v1"; readonly version: string }
  | { readonly epoch: "v1"; readonly version: "observation-graph/v1" };

/** The stable v1 schema discriminator value. */
export const OBSERVATION_GRAPH_V1_VERSION = "observation-graph/v1" as const;

/** The candidate v1 schema discriminator literal reused across the package. */
export const OBSERVATION_GRAPH_V1_SCHEMA: {
  readonly epoch: "v1";
  readonly version: typeof OBSERVATION_GRAPH_V1_VERSION;
} = {
  epoch: "v1",
  version: OBSERVATION_GRAPH_V1_VERSION,
};

/** A target a Graph was captured against. `app` covers future native targets. */
export interface ObservationTarget {
  readonly kind: "web" | "app";
  readonly targetId: string;
}

/** The canonical relation kinds shared by every platform. */
export type ObservationRelationType =
  | "child"
  | "labelled_by"
  | "described_by"
  | "controls"
  | "owns"
  | "focuses";

/** A directed, typed edge from one node to another inside the same Graph. */
export interface ObservationRelationV1 {
  readonly type: ObservationRelationType;
  readonly targetNodeId: string;
}

/** The provenance of a node: which adapter produced it and from which surface. */
export interface ObservationNodeSource {
  readonly adapterId: string;
  readonly sourceKind: string;
}

/** Axis-aligned bounds in CSS/device-independent pixels. */
export interface ObservationBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The data-policy sensitivity of a node's observable value. */
export type ObservationSensitivity =
  | "public"
  | "internal"
  | "sensitive"
  | "secret";

/**
 * A single versioned extension payload. Extensions are the forward-compatibility
 * mechanism: a consumer that does not understand an extension `type`/`version`
 * may safely round-trip and ignore it, while a consumer that *requires* a given
 * major must fail closed (`ExtensionVersionUnsupported`) if it is absent.
 */
export interface VersionedExtension {
  readonly type: string;
  readonly version: string;
  /** JSON Pointer paths under `payload` whose arrays are semantic sets. */
  readonly setSemantics?: readonly string[];
  readonly payload: Readonly<Record<string, ObservationJsonValue>>;
}

export interface WebViewportV1 extends Readonly<Record<string, ObservationJsonValue>> {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

export interface WebExtensionV1Payload extends Readonly<Record<string, ObservationJsonValue>> {
  readonly origin: string;
  readonly pathname: string;
  readonly title: string;
  readonly viewport: WebViewportV1;
  readonly query: Readonly<Record<string, "[redacted]">>;
}

export interface WebExtensionV1 extends VersionedExtension {
  readonly type: "web/v1";
  readonly version: string;
  readonly payload: WebExtensionV1Payload;
}

/** A single observed node in a v1 Graph. */
export interface ObservationNodeV1 {
  readonly id: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly state: Readonly<Record<string, boolean | string | number>>;
  readonly bounds?: ObservationBounds;
  readonly relations: readonly ObservationRelationV1[];
  readonly source: ObservationNodeSource;
  readonly confidence: number;
  readonly sensitivity: ObservationSensitivity;
  readonly extensions: Readonly<Record<string, VersionedExtension>>;
  readonly evidenceRefs: readonly string[];
}

/** The candidate v1 Observation Graph. */
export interface ObservationGraphV1 {
  readonly schema: { readonly epoch: "v1"; readonly version: "observation-graph/v1" };
  readonly graphId: string;
  readonly target: ObservationTarget;
  readonly capturedAt: string;
  readonly rootNodeIds: readonly string[];
  readonly nodes: readonly ObservationNodeV1[];
  readonly evidenceRefs: readonly string[];
  readonly extensions?: Readonly<Record<string, VersionedExtension>>;
}

/**
 * Provenance metadata attached to every migrated pre-v1 asset. Historical
 * payloads are never mutated in place; a migration produces a NEW projection
 * that cites the source's schema version and artifact refs so the asset stays
 * re-projectable/re-compilable.
 */
export interface PreV1AssetMetadata {
  readonly observationSchemaEpoch: "pre-v1";
  readonly sourceSchemaVersion: string;
  readonly locatorSchemaVersion?: string;
  readonly skillCompilerVersion?: string;
  readonly sourceArtifactRefs: readonly string[];
}

/** The canonical (cross-platform core) property names of a v1 node. */
export const CANONICAL_NODE_FIELDS: readonly string[] = [
  "id",
  "role",
  "name",
  "value",
  "state",
  "bounds",
  "relations",
  "source",
  "confidence",
  "sensitivity",
  "extensions",
  "evidenceRefs",
];

/** The canonical property names of a v1 Graph. */
export const CANONICAL_GRAPH_FIELDS: readonly string[] = [
  "schema",
  "graphId",
  "target",
  "capturedAt",
  "rootNodeIds",
  "nodes",
  "evidenceRefs",
  "extensions",
];
