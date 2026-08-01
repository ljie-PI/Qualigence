/**
 * Visual-input content contract shared by the model provider, gateway and
 * concrete providers. Kept in its own module so image types and their
 * log-safe metadata helpers can be imported without pulling in the whole
 * provider surface.
 */

export type ModelImageMediaType = "image/png" | "image/jpeg";

export type ModelImageSensitivity = "public" | "internal" | "sensitive";

/**
 * A single image attachment carried on a {@link ModelMessage}. The raw pixels
 * live in {@link ModelImageInput.dataBase64} and must never be written to logs
 * or error output; use {@link describeImage} for any diagnostic rendering.
 */
export interface ModelImageInput {
  readonly mediaType: ModelImageMediaType;
  readonly dataBase64: string;
  readonly sha256: string;
  readonly sensitivity: ModelImageSensitivity;
  readonly sourceArtifactId: string;
}

/**
 * Explicit, caller-supplied policy that governs whether image attachments may
 * leave the process. There is no default: a request that carries images but no
 * policy fails closed (see the Gateway's `VisionNotAllowed` rejection).
 */
export interface ModelDataPolicy {
  readonly visualInput: "disabled" | "on-demand";
  readonly allowedImageSensitivities: readonly ModelImageSensitivity[];
  readonly maximumImageBytes: number;
}

/**
 * The only representation of an image that is safe to place in logs, errors or
 * audit records: it identifies the source artifact and carries structural
 * metadata (media type, hash, size, sensitivity) but never the base64 payload.
 */
export interface SafeImageMetadata {
  readonly sourceArtifactId: string;
  readonly mediaType: ModelImageMediaType;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly sensitivity: ModelImageSensitivity;
}

/**
 * Returns the decoded byte length of a base64 payload without materializing the
 * bytes in a way that risks logging them.
 */
export function base64ByteLength(dataBase64: string): number {
  const normalized = dataBase64.replace(/=+$/u, "");
  return Math.floor((normalized.length * 3) / 4);
}

/**
 * Projects an image onto its log-safe metadata. The base64 payload is dropped.
 */
export function describeImage(image: ModelImageInput): SafeImageMetadata {
  return {
    sourceArtifactId: image.sourceArtifactId,
    mediaType: image.mediaType,
    sha256: image.sha256,
    sizeBytes: base64ByteLength(image.dataBase64),
    sensitivity: image.sensitivity,
  };
}
