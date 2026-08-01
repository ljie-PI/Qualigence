import { createHash } from "node:crypto";
import { observationError } from "./extensions.js";
/**
 * Deterministic canonical JSON for an Observation Graph:
 *  - object keys are emitted in sorted order (insertion order is irrelevant),
 *  - array order is preserved (it is semantically meaningful),
 *  - strings are NFC-normalised UTF-8,
 *  - non-finite numbers (NaN/Infinity) are rejected.
 *
 * This is the exact byte sequence that feeds {@link observationGraphHash}; two
 * graphs that differ only by key insertion order hash identically.
 */
export function canonicalObservationJson(value: unknown): string {
  return encode(value);
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
