import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  ArtifactManifest,
  ArtifactStore,
  ArtifactWriteRequest,
} from "@qualigence/evidence";
import type { Clock } from "@qualigence/shared-kernel";

export type S3ArtifactStoreErrorCode =
  | "ArtifactPathRejected"
  | "ArtifactWriteFailed"
  | "ArtifactReadFailed"
  | "ArtifactHashMismatch";

export class S3ArtifactStoreError extends Error {
  readonly code: S3ArtifactStoreErrorCode;

  constructor(
    code: S3ArtifactStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "S3ArtifactStoreError";
    this.code = code;
  }
}

export interface S3ArtifactStoreConfig {
  readonly client: S3Client;
  readonly bucket: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly clock: Clock;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeSegment(
  kind: "tenant id" | "project id" | "run id" | "name",
  value: string,
): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new S3ArtifactStoreError(
      "ArtifactPathRejected",
      `Unsafe artifact ${kind}: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Content-addressed artifact store backed by an S3-compatible object store.
 *
 * Objects are keyed `<tenant>/<project>/<sha256-prefix>/<sha256>` so that
 * identical bytes are stored idempotently and cross-tenant references cannot
 * collide. Writes put the object first, then re-read its metadata (HEAD) to
 * confirm size and hash before a manifest is returned; a manifest therefore
 * never references bytes that are not durably present and verified.
 */
export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly tenantId: string;
  private readonly projectId: string;
  private readonly clock: Clock;

  constructor(config: S3ArtifactStoreConfig) {
    assertSafeSegment("tenant id", config.tenantId);
    assertSafeSegment("project id", config.projectId);
    this.client = config.client;
    this.bucket = config.bucket;
    this.tenantId = config.tenantId;
    this.projectId = config.projectId;
    this.clock = config.clock;
  }

  async write(request: ArtifactWriteRequest): Promise<ArtifactManifest> {
    assertSafeSegment("run id", request.runId);
    assertSafeSegment("name", request.name);

    const sha256 = sha256Hex(request.bytes);
    const size = request.bytes.length;
    const key = this.objectKey(sha256);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: request.bytes,
          ContentType: request.mediaType,
          ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
          Metadata: {
            sha256,
            size: String(size),
            "artifact-id": request.artifactId,
            "run-id": request.runId,
            kind: request.kind,
          },
        }),
      );
    } catch (cause) {
      throw new S3ArtifactStoreError(
        "ArtifactWriteFailed",
        `Failed to persist artifact ${request.artifactId}`,
        { cause },
      );
    }

    await this.verifyStoredMetadata(request.artifactId, key, sha256, size);

    return {
      artifactId: request.artifactId,
      runId: request.runId,
      kind: request.kind,
      mediaType: request.mediaType,
      relativePath: key,
      sha256,
      size,
      createdAt: this.clock.now(),
    };
  }

  async read(manifest: ArtifactManifest): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: manifest.relativePath,
        }),
      );
      if (!response.Body) {
        throw new S3ArtifactStoreError(
          "ArtifactReadFailed",
          `Artifact ${manifest.artifactId} returned an empty body`,
        );
      }
      bytes = await response.Body.transformToByteArray();
    } catch (cause) {
      if (cause instanceof S3ArtifactStoreError) {
        throw cause;
      }
      throw new S3ArtifactStoreError(
        "ArtifactReadFailed",
        `Failed to read artifact ${manifest.artifactId}`,
        { cause },
      );
    }

    if (bytes.length !== manifest.size || sha256Hex(bytes) !== manifest.sha256) {
      throw new S3ArtifactStoreError(
        "ArtifactHashMismatch",
        `Artifact ${manifest.artifactId} failed integrity verification on read`,
      );
    }
    return bytes;
  }

  async verify(manifest: ArtifactManifest): Promise<boolean> {
    try {
      const bytes = await this.read(manifest);
      return bytes.length === manifest.size;
    } catch {
      return false;
    }
  }

  private objectKey(sha256: string): string {
    return `${this.tenantId}/${this.projectId}/${sha256.slice(0, 2)}/${sha256}`;
  }

  private async verifyStoredMetadata(
    artifactId: string,
    key: string,
    sha256: string,
    size: number,
  ): Promise<void> {
    let head;
    try {
      head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (cause) {
      throw new S3ArtifactStoreError(
        "ArtifactWriteFailed",
        `Artifact ${artifactId} could not be confirmed after write`,
        { cause },
      );
    }

    const reportedSize = head.ContentLength ?? -1;
    const reportedHash = head.Metadata?.sha256;
    if (reportedSize !== size || reportedHash !== sha256) {
      throw new S3ArtifactStoreError(
        "ArtifactWriteFailed",
        `Artifact ${artifactId} metadata did not match after write`,
      );
    }
  }
}
