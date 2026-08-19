import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ArtifactManifest,
  ArtifactStore,
  ArtifactWriteRequest,
} from "@qualigence/evidence";
import type { Clock } from "@qualigence/shared-kernel";

export type ArtifactStoreErrorCode =
  | "ArtifactPathRejected"
  | "ArtifactWriteFailed"
  | "ArtifactHashMismatch";

export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode;

  constructor(
    code: ArtifactStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeSegment(kind: "run id" | "name", value: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value)
  ) {
    throw new ArtifactStoreError(
      "ArtifactPathRejected",
      `Unsafe artifact ${kind}: ${JSON.stringify(value)}`,
    );
  }
}

export class LocalArtifactStore implements ArtifactStore {
  private readonly rootDir: string;

  constructor(
    rootDir: string,
    private readonly clock: Clock,
  ) {
    this.rootDir = resolve(rootDir);
  }

  async write(request: ArtifactWriteRequest): Promise<ArtifactManifest> {
    const finalPath = this.resolveSafePath(request.runId, request.name);
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;

    await mkdir(dirname(finalPath), { recursive: true });

    try {
      await writeFile(temporaryPath, request.bytes, { flag: "wx" });
      await rename(temporaryPath, finalPath);
    } catch (cause) {
      await this.cleanupTemporary(temporaryPath);
      throw new ArtifactStoreError(
        "ArtifactWriteFailed",
        `Failed to persist artifact ${request.artifactId}`,
        { cause },
      );
    }

    return this.manifestFor(request);
  }

  async read(manifest: ArtifactManifest): Promise<Uint8Array> {
    const filePath = this.resolveSafePathFromRelative(manifest.relativePath);
    const bytes = new Uint8Array(await readFile(filePath));
    if (sha256Hex(bytes) !== manifest.sha256) {
      throw new ArtifactStoreError(
        "ArtifactHashMismatch",
        `Artifact ${manifest.artifactId} failed hash verification on read`,
      );
    }
    return bytes;
  }

  async verify(manifest: ArtifactManifest): Promise<boolean> {
    const filePath = this.resolveSafePathFromRelative(manifest.relativePath);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(filePath));
    } catch {
      return false;
    }
    return bytes.length === manifest.size && sha256Hex(bytes) === manifest.sha256;
  }

  async delete(manifest: ArtifactManifest): Promise<void> {
    await rm(this.resolveSafePathFromRelative(manifest.relativePath), { force: true });
  }

  private manifestFor(request: ArtifactWriteRequest): ArtifactManifest {
    return {
      artifactId: request.artifactId,
      runId: request.runId,
      kind: request.kind,
      mediaType: request.mediaType,
      relativePath: `${request.runId}/${request.name}`,
      sha256: sha256Hex(request.bytes),
      size: request.bytes.length,
      createdAt: this.clock.now(),
    };
  }

  private resolveSafePath(runId: string, name: string): string {
    assertSafeSegment("run id", runId);
    assertSafeSegment("name", name);
    return this.resolveWithinRoot(join(this.rootDir, runId, name));
  }

  private resolveSafePathFromRelative(relativePath: string): string {
    return this.resolveWithinRoot(resolve(this.rootDir, relativePath));
  }

  private resolveWithinRoot(candidate: string): string {
    const resolved = resolve(candidate);
    const rel = relative(this.rootDir, resolved);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.startsWith(`..${sep}`)) {
      throw new ArtifactStoreError(
        "ArtifactPathRejected",
        `Artifact path escapes the store root: ${resolved}`,
      );
    }
    return resolved;
  }

  private async cleanupTemporary(temporaryPath: string): Promise<void> {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
