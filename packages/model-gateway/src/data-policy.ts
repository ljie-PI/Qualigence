import { createHash } from "node:crypto";
import {
  base64ByteLength,
  describeImage,
  type ModelCapabilities,
  type ModelImageInput,
  type ModelMessage,
  type SafeImageMetadata,
  type StructuredModelRequest,
} from "@qualigence/model-provider";

export type VisualInputErrorCode =
  | "VisionNotAllowed"
  | "VisionCapabilityMismatch"
  | "ImageIntegrityViolation";

/**
 * Signals a failed visual-input pre-check. Carries only log-safe image metadata
 * (never the base64 payload) so it can be serialized into logs and audit
 * records without leaking pixels.
 */
export class VisualInputPolicyError extends Error {
  constructor(
    readonly code: VisualInputErrorCode,
    message: string,
    readonly images: readonly SafeImageMetadata[],
  ) {
    super(message);
    this.name = "VisualInputPolicyError";
  }
}

/**
 * Enforces every condition that must hold before image bytes may reach a
 * provider: an explicit non-disabled Data Policy, provider vision capability,
 * per-image SHA-256 integrity, allowed sensitivity and a byte ceiling. Throws
 * before any provider I/O when a condition fails. Text-only requests are a
 * no-op.
 */
export function assertVisualInputAllowed(
  request: StructuredModelRequest,
  capabilities: ModelCapabilities,
): void {
  const images = collectImages(request.messages);
  if (images.length === 0) {
    return;
  }

  const metadata = images.map(describeImage);
  const policy = request.dataPolicy;
  if (policy === undefined || policy.visualInput === "disabled") {
    throw new VisualInputPolicyError(
      "VisionNotAllowed",
      `Visual input is not permitted for ${metadata.length} attachment(s) without an enabling data policy.`,
      metadata,
    );
  }

  if (!capabilities.visionInput) {
    throw new VisualInputPolicyError(
      "VisionCapabilityMismatch",
      `The selected model provider cannot accept ${metadata.length} image attachment(s).`,
      metadata,
    );
  }

  for (const image of images) {
    const safe = describeImage(image);
    if (!hasMatchingHash(image)) {
      throw new VisualInputPolicyError(
        "ImageIntegrityViolation",
        `Image ${safe.sourceArtifactId} failed SHA-256 integrity verification.`,
        [safe],
      );
    }

    if (!policy.allowedImageSensitivities.includes(image.sensitivity)) {
      throw new VisualInputPolicyError(
        "VisionNotAllowed",
        `Image ${safe.sourceArtifactId} sensitivity is not permitted by the data policy.`,
        [safe],
      );
    }

    if (safe.sizeBytes > policy.maximumImageBytes) {
      throw new VisualInputPolicyError(
        "VisionNotAllowed",
        `Image ${safe.sourceArtifactId} of ${safe.sizeBytes} bytes exceeds the data policy maximum of ${policy.maximumImageBytes} bytes.`,
        [safe],
      );
    }
  }
}

function collectImages(messages: readonly ModelMessage[]): readonly ModelImageInput[] {
  return messages.flatMap((message) => message.images ?? []);
}

function hasMatchingHash(image: ModelImageInput): boolean {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(image.dataBase64, "base64");
  } catch {
    return false;
  }

  if (base64ByteLength(image.dataBase64) === 0) {
    return false;
  }

  const actual = createHash("sha256").update(bytes).digest("hex");
  return timingSafeEqualHex(actual, image.sha256);
}

function timingSafeEqualHex(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) {
    mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}
