import { createHash } from "node:crypto";
import type {
  ObservationGraphV1,
  ObservationJsonValue,
  ObservationNodeV1,
  ObservationRelationV1,
  VersionedExtension,
} from "./core.js";
import {
  WEB_EXTENSION_V1_TYPE,
  observationError,
  observationRelationSemanticKey,
} from "./extensions.js";
/**
 * Deterministic canonical JSON for an Observation Graph:
 *  - object keys are emitted in sorted order (insertion order is irrelevant),
 *  - business array order is preserved,
 *  - Observation Graph semantic sets are sorted by stable NFC-normalised keys,
 *  - strings are NFC-normalised UTF-8,
 *  - non-finite numbers (NaN/Infinity) are rejected.
 *
 * Generic JSON callers preserve array order. Observation Graph callers use
 * `canonicalObservationGraphJson` so set-order changes cannot affect hashes.
 */
export function canonicalObservationJson(value: unknown): string {
  return encode(value);
}

export function canonicalObservationGraphJson(graph: ObservationGraphV1): string {
  return encode(canonicalizeObservationGraph(graph));
}

export function canonicalizeObservationGraph(graph: ObservationGraphV1): ObservationGraphV1 {
  return {
    ...graph,
    rootNodeIds: sortStringSet(graph.rootNodeIds),
    nodes: sortNodes(graph.nodes),
    evidenceRefs: sortStringSet(graph.evidenceRefs),
    extensions: canonicalizeExtensions(graph.extensions ?? {}),
  };
}

function sortNodes(nodes: readonly ObservationNodeV1[]): readonly ObservationNodeV1[] {
  return sortByKey(nodes, (node) => node.id).map((node) => ({
    ...node,
    relations: sortRelations(node.relations),
    extensions: canonicalizeExtensions(node.extensions),
  }));
}

function sortRelations(
  relations: readonly ObservationRelationV1[],
): readonly ObservationRelationV1[] {
  return sortByKey(relations, observationRelationSemanticKey);
}

function sortStringSet(items: readonly string[]): readonly string[] {
  return sortByKey(items, (item) => item);
}

function sortByKey<T>(items: readonly T[], keyOf: (item: T) => string): readonly T[] {
  return [...items].sort((left, right) => {
    const leftKey = keyOf(left).normalize("NFC");
    const rightKey = keyOf(right).normalize("NFC");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function canonicalizeExtensions(
  extensions: Readonly<Record<string, VersionedExtension>>,
): Readonly<Record<string, VersionedExtension>> {
  const out: Record<string, VersionedExtension> = {};
  for (const [key, extension] of Object.entries(extensions)) {
    out[key] = {
      ...extension,
      payload: canonicalizeExtensionPayload(extension),
    };
  }
  return out;
}

function canonicalizeExtensionPayload(
  extension: VersionedExtension,
): Readonly<Record<string, ObservationJsonValue>> {
  let payload = extension.payload;
  for (const pointer of extension.setSemantics ?? []) {
    payload = sortExtensionSetAtPath(payload, pointer);
  }
  if (extension.type !== WEB_EXTENSION_V1_TYPE) {
    return payload;
  }
  const query = payload.query;
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    return payload;
  }
  return {
    ...payload,
    query: sortRecordByNormalizedKey(query as Readonly<Record<string, ObservationJsonValue>>),
  };
}

function sortExtensionSetAtPath(
  payload: Readonly<Record<string, ObservationJsonValue>>,
  pointer: string,
): Readonly<Record<string, ObservationJsonValue>> {
  const path = parseJsonPointer(pointer);
  if (path.length === 0) {
    return payload;
  }
  const sorted = sortAtPath(payload, path);
  return sorted === undefined ? payload : sorted as Readonly<Record<string, ObservationJsonValue>>;
}

function sortAtPath(
  value: ObservationJsonValue,
  path: readonly string[],
): ObservationJsonValue | undefined {
  if (path.length === 0) {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return sortByKey(value, (item) => canonicalObservationJson(item)) as readonly ObservationJsonValue[];
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const [head, ...tail] = path;
  if (head === undefined || !(head in value)) {
    return undefined;
  }
  const child = (value as Readonly<Record<string, ObservationJsonValue>>)[head];
  if (child === undefined) {
    return undefined;
  }
  const sortedChild = sortAtPath(child, tail);
  if (sortedChild === undefined) {
    return undefined;
  }
  return {
    ...value,
    [head]: sortedChild,
  };
}

function parseJsonPointer(pointer: string): readonly string[] {
  if (!pointer.startsWith("/")) {
    return [];
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function sortRecordByNormalizedKey(
  value: Readonly<Record<string, ObservationJsonValue>>,
): Readonly<Record<string, ObservationJsonValue>> {
  const out: Record<string, ObservationJsonValue> = {};
  for (const key of Object.keys(value).sort((a, b) => {
    const left = a.normalize("NFC");
    const right = b.normalize("NFC");
    return left < right ? -1 : left > right ? 1 : 0;
  })) {
    const item = value[key];
    if (item !== undefined) {
      out[key] = item;
    }
  }
  return out;
}

function encode(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFC"));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw observationError(
        "ObservationSchemaInvalid",
        `Non-finite number is not canonicalisable: ${String(value)}.`,
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key.normalize("NFC"))}:${encode(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw observationError(
    "ObservationSchemaInvalid",
    `Unsupported value in observation JSON: ${typeof value}.`,
  );
}

/**
 * The stable SHA-256 hex digest of the canonical JSON encoding. Callers that
 * need validation-before-hash use `observationGraphHash` in `./validator`,
 * which validates first and then delegates here.
 */
export function canonicalObservationHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalObservationJson(value), "utf8")
    .digest("hex");
}
