import {
  canonicalPayloadHash,
  findGraphExtensionMajor,
  requireGraphExtensionMajor,
  validateObservationGraphV1,
  type ObservationGraphV1,
  type ObservationJsonValue,
  type ObservationNodeV1,
  type ObservationRelationV1,
  type VersionedExtension,
  type WebViewportV1,
} from "@qualigence/runner-protocol";

/** Privacy-preserving, typed web/v1 fields safe for model prompts and state keys. */
export interface WebV1Semantics {
  readonly origin: string;
  readonly pathname: string;
  readonly title: string;
  readonly viewport: WebViewportV1;
  /** Only allowlisted query keys are exposed; redacted query values are never copied into consumers. */
  readonly queryKeys: readonly string[];
}

/** A deterministic, prompt-safe projection of a v1 Graph's core semantics. */
export interface ObservationGraphPromptView {
  readonly schema: ObservationGraphV1["schema"];
  readonly graphId: string;
  readonly target: ObservationGraphV1["target"];
  readonly capturedAt: string;
  readonly rootNodeIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly web?: WebV1Semantics;
  readonly nodes: readonly ObservationNodePromptView[];
}

export interface ObservationNodePromptView {
  readonly id: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly state: Readonly<Record<string, boolean | string | number>>;
  readonly relations: ObservationNodeV1["relations"];
  readonly source: ObservationNodeV1["source"];
  readonly sensitivity: ObservationNodeV1["sensitivity"];
  readonly evidenceRefs: readonly string[];
}

interface ObservationNodeBaseFingerprintView {
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly state: Readonly<Record<string, boolean | string | number>>;
  readonly source: ObservationNodeV1["source"];
  readonly sensitivity: ObservationNodeV1["sensitivity"];
}

interface ObservationRelationFingerprintView {
  readonly type: ObservationRelationV1["type"];
  /** Stable semantic identity of the target node; raw volatile node IDs are not fingerprinted. */
  readonly target: string;
}

interface ObservationNodeFingerprintView extends ObservationNodeBaseFingerprintView {
  readonly relations: readonly ObservationRelationFingerprintView[];
}

/** Validate a live v1 Graph before any consumer derives prompts, fingerprints, or actions from it. */
export function validateConsumerObservationGraph(graph: ObservationGraphV1): ObservationGraphV1 {
  return validateObservationGraphV1(graph, {
    allowedWebQueryKeys: webQueryKeysPresentOnGraph(graph),
  });
}

/**
 * Read the required web/v1 extension for consumers that depend on URL/title
 * semantics. Missing or incompatible majors fail closed via ObservationError.
 */
export function requireWebV1Semantics(graph: ObservationGraphV1): WebV1Semantics {
  return webSemanticsFromExtension(requireGraphExtensionMajor(graph, "web", 1));
}

/** Read optional web/v1 semantics while ignoring absent/unknown optional extensions. */
export function findWebV1Semantics(graph: ObservationGraphV1): WebV1Semantics | undefined {
  const extension = findGraphExtensionMajor(graph, "web", 1);
  return extension === undefined ? undefined : webSemanticsFromExtension(extension);
}

/** A URL base assembled only from the typed, redacted web/v1 extension. */
export function webV1LocationHref(graph: ObservationGraphV1): string {
  const web = requireWebV1Semantics(graph);
  return `${web.origin}${web.pathname}`;
}

/** Visible text a consumer may cite from v1 common semantics. */
export function observationNodeVisibleText(node: ObservationNodeV1): string {
  const stateText = node.state["text"];
  return node.name ?? node.value ?? (typeof stateText === "string" ? stateText : "");
}

/** Stable prompt projection over v1 core fields plus understood, typed extension semantics. */
export function observationGraphPromptView(graph: ObservationGraphV1): ObservationGraphPromptView {
  const validated = validateConsumerObservationGraph(graph);
  const web = findWebV1Semantics(validated);
  return {
    schema: validated.schema,
    graphId: validated.graphId,
    target: validated.target,
    capturedAt: validated.capturedAt,
    rootNodeIds: sortStrings(validated.rootNodeIds),
    evidenceRefs: sortStrings(validated.evidenceRefs),
    ...(web === undefined ? {} : { web }),
    nodes: [...validated.nodes]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((node) => ({
        id: node.id,
        role: node.role,
        ...(node.name === undefined ? {} : { name: node.name }),
        ...(node.value === undefined || node.sensitivity === "secret" ? {} : { value: node.value }),
        state: node.sensitivity === "secret" ? redactStringState(node.state) : node.state,
        relations: [...node.relations].sort((left, right) =>
          compareStrings(`${left.type}\u0000${left.targetNodeId}`, `${right.type}\u0000${right.targetNodeId}`),
        ),
        source: node.source,
        sensitivity: node.sensitivity,
        evidenceRefs: sortStrings(node.evidenceRefs),
      })),
  };
}

/** Deterministic state fingerprint over v1 common semantics and typed redacted web/v1 fields. */
export function fingerprintObservationGraphV1(graph: ObservationGraphV1): string {
  const validated = validateConsumerObservationGraph(graph);
  const web = requireWebV1Semantics(validated);
  const nodeIdentityById = stableNodeIdentityById(validated.nodes);
  const nodes = [...validated.nodes]
    .map((node) => nodeFingerprintView(node, nodeIdentityById))
    .sort((left, right) => compareStrings(canonicalPayloadHash(left), canonicalPayloadHash(right)));
  const rootNodes = sortStrings(validated.rootNodeIds.map((id) => nodeIdentityById.get(id) ?? id));

  return canonicalPayloadHash({
    web: {
      origin: web.origin,
      pathname: web.pathname,
      title: normalizeText(web.title),
      queryKeys: web.queryKeys,
    },
    target: validated.target,
    rootNodes,
    nodes,
  });
}

function webQueryKeysPresentOnGraph(graph: ObservationGraphV1): readonly string[] {
  const web = graph.extensions?.["web/v1"];
  const query = web?.payload["query"];
  if (query === undefined || query === null || typeof query !== "object" || Array.isArray(query)) {
    return [];
  }
  return Object.keys(query);
}

function webSemanticsFromExtension(extension: VersionedExtension): WebV1Semantics {
  const payload = extension.payload;
  const viewport = payload["viewport"] as unknown as WebViewportV1;
  const query = payload["query"] as Readonly<Record<string, ObservationJsonValue>>;
  return {
    origin: String(payload["origin"]),
    pathname: String(payload["pathname"]),
    title: String(payload["title"]),
    viewport,
    queryKeys: sortStrings(Object.keys(query)),
  };
}

function stableNodeIdentityById(nodes: readonly ObservationNodeV1[]): ReadonlyMap<string, string> {
  return new Map(nodes.map((node) => [node.id, canonicalPayloadHash(nodeBaseFingerprintView(node))]));
}

function nodeBaseFingerprintView(node: ObservationNodeV1): ObservationNodeBaseFingerprintView {
  return {
    role: normalizeText(node.role),
    name: normalizeText(node.name ?? ""),
    ...(node.value === undefined || node.sensitivity === "secret" ? {} : { value: normalizeText(node.value) }),
    state: node.sensitivity === "secret" ? {} : normalizedState(node.state),
    source: node.source,
    sensitivity: node.sensitivity,
  };
}

function nodeFingerprintView(
  node: ObservationNodeV1,
  nodeIdentityById: ReadonlyMap<string, string>,
): ObservationNodeFingerprintView {
  return {
    ...nodeBaseFingerprintView(node),
    relations: [...node.relations]
      .map((relation) => relationFingerprintView(relation, nodeIdentityById))
      .sort((left, right) =>
        compareStrings(`${left.type}\u0000${left.target}`, `${right.type}\u0000${right.target}`),
      ),
  };
}

function relationFingerprintView(
  relation: ObservationRelationV1,
  nodeIdentityById: ReadonlyMap<string, string>,
): ObservationRelationFingerprintView {
  return {
    type: relation.type,
    target: nodeIdentityById.get(relation.targetNodeId) ?? relation.targetNodeId,
  };
}

function normalizedState(
  state: Readonly<Record<string, boolean | string | number>>,
): Readonly<Record<string, boolean | string | number>> {
  const normalized: Record<string, boolean | string | number> = {};
  for (const key of Object.keys(state).sort(compareStrings)) {
    const value = state[key];
    if (value !== undefined) {
      normalized[key] = typeof value === "string" ? normalizeText(value) : value;
    }
  }
  return normalized;
}

function redactStringState(
  state: Readonly<Record<string, boolean | string | number>>,
): Readonly<Record<string, boolean | string | number>> {
  const redacted: Record<string, boolean | string | number> = {};
  for (const [key, value] of Object.entries(state)) {
    redacted[key] = typeof value === "string" ? "[redacted]" : value;
  }
  return redacted;
}

function sortStrings(values: readonly string[]): readonly string[] {
  return [...values].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  const normalizedLeft = left.normalize("NFC");
  const normalizedRight = right.normalize("NFC");
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
