import type { ObservationNodeV1, VersionedExtension } from "./core.js";

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
  const key = `${name}/v${major}`;
  const extension = node.extensions[key];
  if (extension !== undefined) {
    return extension;
  }

  const otherMajors = Object.keys(node.extensions)
    .map((candidate) => parseExtensionKey(candidate))
    .filter(
      (parsed): parsed is ParsedExtensionKey =>
        parsed !== undefined && parsed.name === name,
    )
    .map((parsed) => parsed.major);

  if (otherMajors.length > 0) {
    throw observationError(
      "ExtensionVersionUnsupported",
      `Node "${node.id}" carries extension "${name}" at major(s) ${otherMajors
        .sort((a, b) => a - b)
        .join(", ")} but consumer requires major ${major}.`,
    );
  }

  throw observationError(
    "ExtensionVersionUnsupported",
    `Node "${node.id}" does not carry required extension "${name}/v${major}".`,
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
