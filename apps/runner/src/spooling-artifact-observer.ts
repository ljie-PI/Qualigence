import { createHash } from "node:crypto";
import {
  ARTIFACT_CHUNK_SIZE_BYTES,
  validateObservationGraphV1,
  type AcceptedExecutionJob,
  type ArtifactUploadChunk,
  type ArtifactUploadManifest,
  type ObservationGraphV1,
} from "@qualigence/runner-protocol";
import type { Observer } from "@qualigence/runner-kernel";
import type { RunnerSpool } from "@qualigence/runner-spool";
import { RunnerAppError } from "./errors.js";

export interface RawCapturedArtifact {
  readonly name: string;
  readonly mediaType: "image/png" | "application/json";
  readonly bytes: Uint8Array;
}

export interface ArtifactSource {
  captureArtifacts(graphId: string): Promise<readonly RawCapturedArtifact[]>;
}

export interface SpoolingArtifactObserverOptions {
  readonly observer: Observer;
  readonly source: ArtifactSource;
  readonly spool: RunnerSpool;
  readonly tenantId: string;
}

/**
 * Decorates a target Observer so captured large evidence is written to the
 * Runner Spool before the Observation Trace referencing it can be appended.
 * The Artifact upload pump later drains these manifests/chunks before Trace,
 * allowing reconnect/restart recovery without sending bytes in Trace payloads.
 */
export class SpoolingArtifactObserver implements Observer {
  constructor(private readonly options: SpoolingArtifactObserverOptions) {}

  async capture(job: AcceptedExecutionJob, signal?: AbortSignal): Promise<ObservationGraphV1> {
    const graph = validateCapturedGraph(await this.options.observer.capture(job, signal));
    signal?.throwIfAborted();
    const artifacts = await this.options.source.captureArtifacts(graph.graphId);
    const artifactRefs = new Map<string, string>();
    for (const artifact of artifacts) {
      signal?.throwIfAborted();
      const artifactId = artifactIdFor(job.runId, artifact);
      await saveArtifact(this.options.spool, manifestFor({ artifactId, tenantId: this.options.tenantId, projectId: job.projectId, runId: job.runId, artifact }));
      for (const chunk of chunksFor({ artifactId, tenantId: this.options.tenantId, projectId: job.projectId, runId: job.runId, bytes: artifact.bytes })) {
        await saveArtifactChunk(this.options.spool, chunk);
      }
      artifactRefs.set(artifact.name, artifactId);
    }
    if (artifactRefs.size === 0) return graph;
    return validateCapturedGraph({
      ...graph,
      nodes: graph.nodes.map((node) => ({
        ...node,
        evidenceRefs: rewriteRefs(node.evidenceRefs, artifactRefs),
      })),
      evidenceRefs: [
        ...new Set([
          ...rewriteRefs(graph.evidenceRefs, artifactRefs),
          ...artifactRefs.values(),
        ]),
      ],
    });
  }
}

async function saveArtifact(spool: RunnerSpool, manifest: ArtifactUploadManifest): Promise<void> {
  if (spool.saveArtifactManifest === undefined) {
    throw new RunnerAppError("TransportError", "runner spool does not support artifact manifest recovery");
  }
  await spool.saveArtifactManifest(manifest);
}

async function saveArtifactChunk(spool: RunnerSpool, chunk: ArtifactUploadChunk): Promise<void> {
  if (spool.saveArtifactChunk === undefined) {
    throw new RunnerAppError("TransportError", "runner spool does not support artifact chunk recovery");
  }
  await spool.saveArtifactChunk(chunk);
}

function manifestFor(input: {
  readonly artifactId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly artifact: RawCapturedArtifact;
}): ArtifactUploadManifest {
  return {
    artifactId: input.artifactId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    runId: input.runId,
    sizeBytes: input.artifact.bytes.length,
    sha256: sha256(input.artifact.bytes),
    mediaType: input.artifact.mediaType,
    sensitivity: "internal",
    chunkSizeBytes: ARTIFACT_CHUNK_SIZE_BYTES,
    totalChunks: Math.ceil(input.artifact.bytes.length / ARTIFACT_CHUNK_SIZE_BYTES),
  };
}

function chunksFor(input: {
  readonly artifactId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly bytes: Uint8Array;
}): readonly ArtifactUploadChunk[] {
  const chunks: ArtifactUploadChunk[] = [];
  for (let offset = 0; offset < input.bytes.length; offset += ARTIFACT_CHUNK_SIZE_BYTES) {
    const bytes = input.bytes.slice(offset, Math.min(input.bytes.length, offset + ARTIFACT_CHUNK_SIZE_BYTES));
    chunks.push({
      artifactId: input.artifactId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      runId: input.runId,
      offset,
      bytes,
      sha256: sha256(bytes),
    });
  }
  return chunks;
}

function rewriteRefs(refs: readonly string[], artifactRefs: ReadonlyMap<string, string>): readonly string[] {
  return [...new Set(refs.map((ref) => artifactRefs.get(ref) ?? ref))];
}

function artifactIdFor(runId: string, artifact: RawCapturedArtifact): string {
  const contentSha = sha256(artifact.bytes);
  const runNamespace = sha256(Buffer.from(runId, "utf8")).slice(0, 16);
  const identityHash = sha256(Buffer.from(`${runId}\0${artifact.name}\0${contentSha}`, "utf8")).slice(0, 32);
  return `run-${runNamespace}-artifact-${identityHash}${extensionFor(artifact)}`;
}

function extensionFor(artifact: RawCapturedArtifact): string {
  switch (artifact.mediaType) {
    case "image/png":
      return ".png";
    case "application/json":
      return ".json";
    default:
      return "";
  }
}

function validateCapturedGraph(graph: ObservationGraphV1): ObservationGraphV1 {
  const web = graph.extensions?.["web/v1"];
  const query = web?.payload["query"];
  return validateObservationGraphV1(graph, {
    allowedWebQueryKeys:
      query !== undefined && query !== null && typeof query === "object" && !Array.isArray(query)
        ? Object.keys(query)
        : [],
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
