import type { ObservationGraphV1, ObservationNodeV1, VersionedExtension } from "./core.js";

export const OBSERVATION_GRAPH_V1_CAPABILITY = "observation-graph/v1" as const;
export const WEB_EXTENSION_V1_TYPE = "web/v1" as const;
export const WEB_EXTENSION_V1_REDACTION_MARKER = "[redacted]" as const;

export function observationRelationSemanticKey(relation: {
  readonly type: string;
  readonly targetNodeId: string;
}): string {
  return `${relation.type}\u0000${relation.targetNodeId}`;
}

/** Error codes for the observation contract layer. */
export type ObservationErrorCode =
  | "ObservationSchemaInvalid"
  | "DanglingNodeReference"
  | "EvidenceReferenceInvalid"
  | "ExtensionVersionUnsupported"
  | "SourceAssetCorrupted"
  | "ProjectionUnsupported"
  | "SkillRecompileFailed"
  | "MigrationSourceChanged";

/** A typed observation-contract error carrying a stable {@link ObservationErrorCode}. */
export class ObservationError extends Error {
  readonly code: ObservationErrorCode;

  constructor(code: ObservationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ObservationError";
    this.code = code;
  }
}

export function observationError(
  code: ObservationErrorCode,
  message: string,
): ObservationError {
  return new ObservationError(code, message);
}

/** A parsed `<name>/v<major>` extension key. */
export interface ParsedExtensionKey {
  readonly name: string;
  readonly major: number;
}

const EXTENSION_KEY = /^([a-z][a-z0-9-]*)\/v(\d+)$/;

/**
 * Parse an extension key of the form `<name>/v<major>` (for example `uia/v1`).
 * Returns `undefined` for a malformed key rather than throwing so callers can
 * decide whether a malformed key is a schema violation in their context.
 */
export function parseExtensionKey(key: string): ParsedExtensionKey | undefined {
  const match = EXTENSION_KEY.exec(key);
  if (match === null) {
    return undefined;
  }
  const [, name, majorText] = match;
  if (name === undefined || majorText === undefined) {
    return undefined;
  }
  return { name, major: Number.parseInt(majorText, 10) };
}

/**
 * Resolve the extension a consumer *requires* at a specific major version. A
 * node that carries the extension at the requested major returns it; a node
 * that lacks it — even if it carries the same extension at a different major —
 * fails closed with `ExtensionVersionUnsupported`. This is the deliberate
 * forward-compatibility fence: unknown majors are never silently reinterpreted.
 */
export function requireExtensionMajor(
  node: ObservationNodeV1,
  name: string,
  major: number,
): VersionedExtension {
  return requireExtensionMajorFromMap(node.extensions, name, major, `Node "${node.id}"`);
}

export function requireGraphExtensionMajor(
  graph: ObservationGraphV1,
  name: string,
  major: number,
): VersionedExtension {
  return requireExtensionMajorFromMap(graph.extensions ?? {}, name, major, `Graph "${graph.graphId}"`);
}

function requireExtensionMajorFromMap(
  extensions: Readonly<Record<string, VersionedExtension>>,
  name: string,
  major: number,
  where: string,
): VersionedExtension {
  const key = `${name}/v${major}`;
  const extension = extensions[key];
  if (extension !== undefined) {
    return extension;
  }

  const otherMajors = Object.keys(extensions)
    .map((candidate) => parseExtensionKey(candidate))
    .filter(
      (parsed): parsed is ParsedExtensionKey =>
        parsed !== undefined && parsed.name === name,
    )
    .map((parsed) => parsed.major);

  if (otherMajors.length > 0) {
    throw observationError(
      "ExtensionVersionUnsupported",
      `${where} carries extension "${name}" at major(s) ${otherMajors
        .sort((a, b) => a - b)
        .join(", ")} but consumer requires major ${major}.`,
    );
  }

  throw observationError(
    "ExtensionVersionUnsupported",
    `${where} does not carry required extension "${name}/v${major}".`,
  );
}

/** Look up an optional extension without failing closed when it is absent. */
export function findExtensionMajor(
  node: ObservationNodeV1,
  name: string,
  major: number,
): VersionedExtension | undefined {
  return node.extensions[`${name}/v${major}`];
}

export function findGraphExtensionMajor(
  graph: ObservationGraphV1,
  name: string,
  major: number,
): VersionedExtension | undefined {
  return graph.extensions?.[`${name}/v${major}`];
}
