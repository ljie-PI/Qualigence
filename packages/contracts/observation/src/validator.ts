import { createHash } from "node:crypto";
import {
  CANONICAL_GRAPH_FIELDS,
  CANONICAL_NODE_FIELDS,
  OBSERVATION_GRAPH_V1_VERSION,
  type ObservationBounds,
  type ObservationGraphV1,
  type ObservationNodeV1,
  type ObservationRelationType,
  type ObservationRelationV1,
  type VersionedExtension,
} from "./core.js";
import { canonicalObservationGraphJson, canonicalObservationJson } from "./canonical.js";
import {
  WEB_EXTENSION_V1_REDACTION_MARKER,
  WEB_EXTENSION_V1_TYPE,
  observationError,
  observationRelationSemanticKey,
  parseExtensionKey,
} from "./extensions.js";

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

const PORT_PATTERN = "(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";
const WEB_ORIGIN_PATTERN = new RegExp(
  `^(?:http://(?![^/?#]*@)(?![^/?#]*:80$)[a-z0-9.-]+(?::${PORT_PATTERN})?|https://(?![^/?#]*@)(?![^/?#]*:443$)[a-z0-9.-]+(?::${PORT_PATTERN})?)$`,
);
const WEB_PATHNAME_PATTERN = /^(?!\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*%2[eE])\/(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9A-Fa-f]{2})*$/;

/**
 * An evidence resolver used to confirm every `evidenceRefs` entry points at a
 * registered, hash-valid Artifact. When omitted, evidence refs are only checked
 * for structural non-emptiness (offline/contract-only validation).
 */
export type EvidenceResolver = (ref: string) => boolean;

export interface ValidateOptions {
  readonly evidenceResolver?: EvidenceResolver;
  readonly allowedWebQueryKeys?: readonly string[];
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
  const graphExtensions = graph.extensions ?? {};
  validateExtensions("graph", graphExtensions, options, true);
  assertUniqueCanonicalStringKeys(graph.rootNodeIds, "graph rootNodeIds");
  assertUniqueCanonicalStringKeys(graph.evidenceRefs, "graph evidenceRefs");

  const nodeIds = new Set<string>();
  const normalizedNodeIds = new Map<string, string>();
  for (const node of graph.nodes) {
    validateNode(node, options);
    if (nodeIds.has(node.id)) {
      throw observationError(
        "ObservationSchemaInvalid",
        `Duplicate node id "${node.id}".`,
      );
    }
    const normalizedNodeId = node.id.normalize("NFC");
    const existingNodeId = normalizedNodeIds.get(normalizedNodeId);
    if (existingNodeId !== undefined && existingNodeId !== node.id) {
      throw observationError(
        "ObservationSchemaInvalid",
        `Node id "${node.id}" has the same canonical key as "${existingNodeId}" but is not byte-identical.`,
      );
    }
    nodeIds.add(node.id);
    normalizedNodeIds.set(normalizedNodeId, node.id);
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
    assertUniqueRelationKeys(node.id, node.relations);
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
    assertObject(relation, `node ${node.id} relation`);
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
  validateExtensions(`node ${node.id}`, node.extensions, options, false);
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
  where: string,
  extensions: Readonly<Record<string, VersionedExtension>>,
  options: ValidateOptions,
  allowGraphExtensions: boolean,
): void {
  assertObject(extensions, `${where} extensions`);
  for (const [key, extension] of Object.entries(extensions)) {
    if (parseExtensionKey(key) === undefined) {
      throw observationError(
        "ObservationSchemaInvalid",
        `${where} extension key "${key}" must match "<name>/v<major>".`,
      );
    }
    assertObject(extension, `extension ${key}`);
    assertNoUnknownFields(extension, ["type", "version", "setSemantics", "payload"], "extension");
    assertNonEmptyString(extension.type, `extension ${key} type`);
    if (extension.type !== key) {
      throw observationError(
        "ObservationSchemaInvalid",
        `extension key "${key}" must match extension type "${extension.type}".`,
      );
    }
    assertNonEmptyString(extension.version, `extension ${key} version`);
    assertObject(extension.payload, `extension ${key} payload`);
    validateSetSemantics(extension, `extension ${key} setSemantics`);
    if (key === WEB_EXTENSION_V1_TYPE) {
      if (!allowGraphExtensions) {
        throw observationError(
          "ObservationSchemaInvalid",
          "web/v1 is a graph-level extension and must not be attached to a node.",
        );
      }
      validateWebExtensionV1(extension, options);
    }
  }
}

function validateWebExtensionV1(extension: VersionedExtension, options: ValidateOptions): void {
  if (extension.type !== WEB_EXTENSION_V1_TYPE) {
    throw observationError(
      "ObservationSchemaInvalid",
      `web/v1 extension type must be "${WEB_EXTENSION_V1_TYPE}".`,
    );
  }
  const payload = extension.payload;
  assertNoUnknownFields(payload, ["origin", "pathname", "title", "viewport", "query"], "web/v1 payload");
  assertWebOrigin(payload.origin);
  assertPathname(payload.pathname);
  if (typeof payload.title !== "string") {
    throw observationError("ObservationSchemaInvalid", "web/v1 title must be a string.");
  }
  assertObject(payload.viewport, "web/v1 viewport");
  const viewport = payload.viewport as Record<string, unknown>;
  assertNoUnknownFields(viewport, ["width", "height", "devicePixelRatio"], "web/v1 viewport");
  assertViewportInteger(viewport.width, "web/v1 viewport.width", 32768);
  assertViewportInteger(viewport.height, "web/v1 viewport.height", 32768);
  assertViewportNumber(viewport.devicePixelRatio, "web/v1 viewport.devicePixelRatio", 16);

  assertObject(payload.query, "web/v1 query");
  const query = payload.query as Record<string, unknown>;
  const allowedKeys = new Set(options.allowedWebQueryKeys ?? []);
  for (const [key, value] of Object.entries(query)) {
    if (key.length === 0 || key !== key.normalize("NFC")) {
      throw observationError(
        "ObservationSchemaInvalid",
        "web/v1 query keys must be non-empty NFC-normalized strings.",
      );
    }
    if (!allowedKeys.has(key)) {
      throw observationError(
        "ObservationSchemaInvalid",
        `web/v1 query key "${key}" is not allowlisted by target policy.`,
      );
    }
    if (value !== WEB_EXTENSION_V1_REDACTION_MARKER) {
      throw observationError(
        "ObservationSchemaInvalid",
        `web/v1 query value for "${key}" must be "${WEB_EXTENSION_V1_REDACTION_MARKER}".`,
      );
    }
  }
}

function assertWebOrigin(value: unknown): void {
  const origin = nonEmptyString(value, "web/v1 origin");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw observationError("ObservationSchemaInvalid", "web/v1 origin must be a canonical URL origin.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== origin ||
    !WEB_ORIGIN_PATTERN.test(origin)
  ) {
    throw observationError("ObservationSchemaInvalid", "web/v1 origin must be a canonical URL origin.");
  }
}

function assertPathname(value: unknown): void {
  const pathname = nonEmptyString(value, "web/v1 pathname");
  let canonical: string;
  try {
    canonical = new URL(pathname, "https://qualigence.invalid").pathname;
  } catch {
    throw observationError(
      "ObservationSchemaInvalid",
      "web/v1 pathname must be a canonical path only and must omit query and fragment.",
    );
  }
  if (
    !pathname.startsWith("/") ||
    pathname.includes("?") ||
    pathname.includes("#") ||
    pathname !== canonical ||
    !WEB_PATHNAME_PATTERN.test(pathname)
  ) {
    throw observationError(
      "ObservationSchemaInvalid",
      "web/v1 pathname must be a canonical path only and must omit query and fragment.",
    );
  }
}

function validateSetSemantics(extension: VersionedExtension, where: string): void {
  if (extension.setSemantics === undefined) {
    return;
  }
  assertArray(extension.setSemantics, where);
  for (const pointer of extension.setSemantics as readonly unknown[]) {
    if (typeof pointer !== "string" || !pointer.startsWith("/") || pointer.length === 1) {
      throw observationError(
        "ObservationSchemaInvalid",
        `${where} entries must be non-root JSON Pointer payload paths.`,
      );
    }
    const setArray = extensionSetArrayAtPath(extension.payload, pointer);
    if (setArray === undefined) {
      throw observationError(
        "ObservationSchemaInvalid",
        `${where} entry "${pointer}" must resolve to a payload array.`,
      );
    }
    assertUniqueCanonicalJsonKeys(setArray, `${where} entry "${pointer}"`);
  }
}

function extensionSetArrayAtPath(
  payload: Readonly<Record<string, unknown>>,
  pointer: string,
): readonly unknown[] | undefined {
  let current: unknown = payload;
  for (const part of pointer
    .slice(1)
    .split("/")
    .map((item) => item.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Readonly<Record<string, unknown>>)[part];
  }
  return Array.isArray(current) ? current : undefined;
}

function assertUniqueCanonicalJsonKeys(values: readonly unknown[], where: string): void {
  const byNormalized = new Map<string, string>();
  for (const value of values) {
    const key = canonicalObservationJson(value);
    const raw = rawCanonicalJson(value);
    const normalized = key.normalize("NFC");
    const existing = byNormalized.get(normalized);
    if (existing !== undefined && existing !== raw) {
      throw observationError(
        "ObservationSchemaInvalid",
        `${where} has entries with the same canonical key but non-byte-identical JSON.`,
      );
    }
    byNormalized.set(normalized, raw);
  }
}

function rawCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw observationError(
        "ObservationSchemaInvalid",
        `Non-finite number is not valid observation JSON: ${String(value)}.`,
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item) => rawCanonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${rawCanonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw observationError(
    "ObservationSchemaInvalid",
    `Unsupported value in observation JSON: ${typeof value}.`,
  );
}

function assertViewportInteger(value: unknown, where: string, max: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw observationError(
      "ObservationSchemaInvalid",
      `${where} must be a positive safe integer no greater than ${max}.`,
    );
  }
}

function assertViewportNumber(value: unknown, where: string, max: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
    throw observationError(
      "ObservationSchemaInvalid",
      `${where} must be finite, positive, and no greater than ${max}.`,
    );
  }
}

function assertUniqueCanonicalStringKeys(values: readonly string[], where: string): void {
  const byNormalized = new Map<string, string>();
  for (const value of values) {
    assertNonEmptyString(value, where);
    const normalized = value.normalize("NFC");
    const existing = byNormalized.get(normalized);
    if (existing !== undefined && existing !== value) {
      throw observationError(
        "ObservationSchemaInvalid",
        `${where} entry "${value}" has the same canonical key as "${existing}" but is not byte-identical.`,
      );
    }
    byNormalized.set(normalized, value);
  }
}

function assertUniqueRelationKeys(
  nodeId: string,
  relations: readonly ObservationRelationV1[],
): void {
  const byNormalized = new Map<string, string>();
  for (const relation of relations) {
    const rawKey = observationRelationSemanticKey(relation);
    const normalized = rawKey.normalize("NFC");
    const existing = byNormalized.get(normalized);
    if (existing !== undefined && existing !== rawKey) {
      throw observationError(
        "ObservationSchemaInvalid",
        `node ${nodeId} relation key "${rawKey}" has the same canonical key as "${existing}" but is not byte-identical.`,
      );
    }
    byNormalized.set(normalized, rawKey);
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
    .update(canonicalObservationGraphJson(graph), "utf8")
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

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw observationError("ObservationSchemaInvalid", `${where} must be a non-empty string.`);
  }
  return value;
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
