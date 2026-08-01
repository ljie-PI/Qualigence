import { createHash } from "node:crypto";
import {
  CANONICAL_GRAPH_FIELDS,
  CANONICAL_NODE_FIELDS,
  OBSERVATION_GRAPH_V1_VERSION,
  type ObservationBounds,
  type ObservationGraphV1,
  type ObservationNodeV1,
  type ObservationRelationType,
  type VersionedExtension,
} from "./core.js";
import { canonicalObservationJson } from "./canonical.js";
import { observationError, parseExtensionKey } from "./extensions.js";

const RELATION_TYPES: ReadonlySet<ObservationRelationType> = new Set([
  "child",
  "labelled_by",
  "described_by",
  "controls",
  "owns",
  "focuses",
]);

const SENSITIVITIES: ReadonlySet<string> = new Set([
  "public",
  "internal",
  "sensitive",
  "secret",
]);

/**
 * An evidence resolver used to confirm every `evidenceRefs` entry points at a
 * registered, hash-valid Artifact. When omitted, evidence refs are only checked
 * for structural non-emptiness (offline/contract-only validation).
 */
export type EvidenceResolver = (ref: string) => boolean;

export interface ValidateOptions {
  readonly evidenceResolver?: EvidenceResolver;
}

/**
 * Validate an Observation Graph against the v1 canonical invariants. This is the
 * enforcement layer paired with the published JSON Schema: it rejects unknown
 * non-extension fields strictly, but well-formed `extensions` payloads carry
 * arbitrary forward-compatible data.
 *
 * Throws {@link ObservationError} with a precise code on the first violation and
 * returns the (unchanged) graph on success.
 */
export function validateObservationGraphV1(
  graph: ObservationGraphV1,
  options: ValidateOptions = {},
): ObservationGraphV1 {
  assertObject(graph, "graph");
  assertNoUnknownFields(graph, CANONICAL_GRAPH_FIELDS, "graph");

  if (
    graph.schema?.epoch !== "v1" ||
    graph.schema?.version !== OBSERVATION_GRAPH_V1_VERSION
  ) {
    throw observationError(
      "ObservationSchemaInvalid",
      `Graph schema must be { epoch: "v1", version: "${OBSERVATION_GRAPH_V1_VERSION}" }.`,
    );
  }

  assertNonEmptyString(graph.graphId, "graphId");
  assertObject(graph.target, "target");
  assertNoUnknownFields(graph.target, ["kind", "targetId"], "target");
  if (graph.target.kind !== "web" && graph.target.kind !== "app") {
    throw observationError(
      "ObservationSchemaInvalid",
      `target.kind must be "web" or "app".`,
    );
  }
  assertNonEmptyString(graph.target.targetId, "target.targetId");
  assertNonEmptyString(graph.capturedAt, "capturedAt");
  assertArray(graph.nodes, "nodes");
  assertArray(graph.rootNodeIds, "rootNodeIds");
  assertArray(graph.evidenceRefs, "evidenceRefs");

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    validateNode(node, options);
    if (nodeIds.has(node.id)) {
      throw observationError(
        "ObservationSchemaInvalid",
        `Duplicate node id "${node.id}".`,
      );
    }
    nodeIds.add(node.id);
  }

  if (graph.rootNodeIds.length === 0) {
    throw observationError(
      "ObservationSchemaInvalid",
      "A graph must declare at least one rootNodeId.",
    );
  }
  for (const rootId of graph.rootNodeIds) {
    assertNonEmptyString(rootId, "rootNodeId");
    if (!nodeIds.has(rootId)) {
      throw observationError(
        "DanglingNodeReference",
        `rootNodeId "${rootId}" does not exist in the graph.`,
      );
    }
  }

  for (const node of graph.nodes) {
    for (const relation of node.relations) {
      if (!nodeIds.has(relation.targetNodeId)) {
        throw observationError(
          "DanglingNodeReference",
          `Node "${node.id}" has a ${relation.type} relation to missing node "${relation.targetNodeId}".`,
        );
      }
    }
  }

  validateEvidence(graph.evidenceRefs, "graph", options.evidenceResolver);
  for (const node of graph.nodes) {
    validateEvidence(node.evidenceRefs, `node ${node.id}`, options.evidenceResolver);
  }

  return graph;
}

function validateNode(node: ObservationNodeV1, options: ValidateOptions): void {
  assertObject(node, "node");
  assertNoUnknownFields(node, CANONICAL_NODE_FIELDS, `node`);
  assertNonEmptyString(node.id, "node.id");
  assertNonEmptyString(node.role, `node ${node.id} role`);

  if (node.name !== undefined && typeof node.name !== "string") {
    throw observationError("ObservationSchemaInvalid", `node ${node.id} name must be a string.`);
  }

  if (!SENSITIVITIES.has(node.sensitivity)) {
    throw observationError(
      "ObservationSchemaInvalid",
      `node ${node.id} sensitivity "${node.sensitivity}" is invalid.`,
    );
  }

  if (
    node.sensitivity === "secret" &&
    node.value !== undefined &&
    !isMasked(node.value)
  ) {
    throw observationError(
      "ObservationSchemaInvalid",
      `secret node ${node.id} must omit or mask its value; it cannot be recovered at the logging layer.`,
    );
  }
  if (node.value !== undefined && typeof node.value !== "string") {
    throw observationError("ObservationSchemaInvalid", `node ${node.id} value must be a string.`);
  }

  if (typeof node.confidence !== "number" || !Number.isFinite(node.confidence)) {
    throw observationError("ObservationSchemaInvalid", `node ${node.id} confidence must be finite.`);
  }
  if (node.confidence < 0 || node.confidence > 1) {
    throw observationError(
      "ObservationSchemaInvalid",
      `node ${node.id} confidence ${node.confidence} is outside [0, 1].`,
    );
  }

  validateState(node);
  if (node.bounds !== undefined) {
    validateBounds(node.id, node.bounds);
  }

  assertArray(node.relations, `node ${node.id} relations`);
  for (const relation of node.relations) {
    assertNoUnknownFields(relation, ["type", "targetNodeId"], "relation");
    if (!RELATION_TYPES.has(relation.type)) {
      throw observationError(
        "ObservationSchemaInvalid",
        `node ${node.id} has invalid relation type "${relation.type}".`,
      );
    }
    assertNonEmptyString(relation.targetNodeId, "relation.targetNodeId");
  }

  assertObject(node.source, `node ${node.id} source`);
  assertNoUnknownFields(node.source, ["adapterId", "sourceKind"], "source");
  assertNonEmptyString(node.source.adapterId, "source.adapterId");
  assertNonEmptyString(node.source.sourceKind, "source.sourceKind");

  assertArray(node.evidenceRefs, `node ${node.id} evidenceRefs`);
  validateExtensions(node.id, node.extensions);
  void options;
}

function validateState(node: ObservationNodeV1): void {
  assertObject(node.state, `node ${node.id} state`);
  for (const [key, value] of Object.entries(node.state)) {
    const kind = typeof value;
    if (kind !== "boolean" && kind !== "string" && kind !== "number") {
      throw observationError(
        "ObservationSchemaInvalid",
        `node ${node.id} state.${key} must be a boolean, string or number.`,
      );
    }
    if (kind === "number" && !Number.isFinite(value)) {
      throw observationError(
        "ObservationSchemaInvalid",
        `node ${node.id} state.${key} must be a finite number.`,
      );
    }
  }
}

function validateBounds(nodeId: string, bounds: ObservationBounds): void {
  assertNoUnknownFields(bounds, ["x", "y", "width", "height"], "bounds");
  for (const axis of ["x", "y", "width", "height"] as const) {
    const value = bounds[axis];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw observationError(
        "ObservationSchemaInvalid",
        `node ${nodeId} bounds.${axis} must be a finite number.`,
      );
    }
  }
  if (bounds.width < 0 || bounds.height < 0) {
    throw observationError(
      "ObservationSchemaInvalid",
      `node ${nodeId} bounds width/height must be non-negative.`,
    );
  }
}

function validateExtensions(
  nodeId: string,
  extensions: Readonly<Record<string, VersionedExtension>>,
): void {
  assertObject(extensions, `node ${nodeId} extensions`);
  for (const [key, extension] of Object.entries(extensions)) {
    if (parseExtensionKey(key) === undefined) {
      throw observationError(
        "ObservationSchemaInvalid",
        `node ${nodeId} extension key "${key}" must match "<name>/v<major>".`,
      );
    }
    assertObject(extension, `extension ${key}`);
    assertNoUnknownFields(extension, ["type", "version", "payload"], "extension");
    assertNonEmptyString(extension.type, `extension ${key} type`);
    assertNonEmptyString(extension.version, `extension ${key} version`);
    assertObject(extension.payload, `extension ${key} payload`);
  }
}

function validateEvidence(
  refs: readonly string[],
  where: string,
  resolver: EvidenceResolver | undefined,
): void {
  for (const ref of refs) {
    assertNonEmptyString(ref, `${where} evidenceRef`);
    if (resolver !== undefined && !resolver(ref)) {
      throw observationError(
        "EvidenceReferenceInvalid",
        `${where} evidenceRef "${ref}" is not a registered, hash-valid artifact.`,
      );
    }
  }
}

/** A secret value is acceptable only when fully masked (all bullet/asterisk) or empty. */
function isMasked(value: string): boolean {
  return value.length === 0 || /^[•*]+$/.test(value);
}

/**
 * The stable SHA-256 hex digest of a *validated* Observation Graph. Two graphs
 * that differ only by object-key insertion order hash identically.
 */
export function observationGraphHash(
  graph: ObservationGraphV1,
  options: ValidateOptions = {},
): string {
  validateObservationGraphV1(graph, options);
  return createHash("sha256")
    .update(canonicalObservationJson(graph), "utf8")
    .digest("hex");
}

function assertObject(value: unknown, where: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw observationError("ObservationSchemaInvalid", `${where} must be an object.`);
  }
}

function assertArray(value: unknown, where: string): void {
  if (!Array.isArray(value)) {
    throw observationError("ObservationSchemaInvalid", `${where} must be an array.`);
  }
}

function assertNonEmptyString(value: unknown, where: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw observationError("ObservationSchemaInvalid", `${where} must be a non-empty string.`);
  }
}

function assertNoUnknownFields(
  value: object,
  allowed: readonly string[],
  where: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw observationError(
        "ObservationSchemaInvalid",
        `${where} has unknown field "${key}"; unknown data must live inside a versioned extension.`,
      );
    }
  }
}
