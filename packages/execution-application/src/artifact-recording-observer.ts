import type {
  ArtifactKind,
  ArtifactManifestStore,
  ArtifactStore,
} from "@qualigence/evidence";
import type {
  AcceptedExecutionJob,
  ObservationGraph,
  RunId,
} from "@qualigence/runner-protocol";
import type { Observer } from "@qualigence/runner-kernel";
import { ExecutionApplicationError } from "./errors.js";

/**
 * A raw, unpersisted capture artifact produced by the target adapter for a
 * single observation graph. Provider-neutral so the observer never imports a
 * concrete Target adapter.
 */
export interface RawArtifact {
  readonly name: string;
  readonly mediaType: "image/png" | "application/json";
  readonly bytes: Uint8Array;
}

export interface ArtifactSource {
  captureArtifacts(graphId: string): Promise<readonly RawArtifact[]>;
}

export interface ArtifactRecordingObserverDependencies {
  readonly observer: Observer;
  readonly source: ArtifactSource;
  readonly artifacts: ArtifactStore;
  readonly manifests: ArtifactManifestStore;
  readonly runId: RunId;
  readonly createArtifactId: () => string;
}

/**
 * Decorates a raw {@link Observer}: after every capture it persists the graph
 * JSON, the screenshot and their manifests, then returns a copy of the graph
 * carrying the registered Artifact IDs. If any artifact step fails it raises
 * `ArtifactUnavailable` before returning, so a Finding can never reference a
 * missing artifact.
 */
export class ArtifactRecordingObserver implements Observer {
  constructor(
    private readonly dependencies: ArtifactRecordingObserverDependencies,
  ) {}

  async capture(job: AcceptedExecutionJob): Promise<ObservationGraph> {
    const graph = await this.dependencies.observer.capture(job);

    let rawArtifacts: readonly RawArtifact[];
    try {
      rawArtifacts = await this.dependencies.source.captureArtifacts(
        graph.graphId,
      );
    } catch (cause) {
      throw new ExecutionApplicationError(
        "ArtifactUnavailable",
        `Failed to capture artifacts for graph ${graph.graphId}.`,
        { cause },
      );
    }

    const artifactRefs: string[] = [];
    for (const raw of rawArtifacts) {
      const artifactId = this.dependencies.createArtifactId();
      try {
        const manifest = await this.dependencies.artifacts.write({
          artifactId,
          runId: this.dependencies.runId,
          name: raw.name,
          kind: kindFor(raw.mediaType),
          mediaType: raw.mediaType,
          bytes: raw.bytes,
        });
        await this.dependencies.manifests.append(manifest);
      } catch (cause) {
        throw new ExecutionApplicationError(
          "ArtifactUnavailable",
          `Failed to persist artifact ${artifactId} for graph ${graph.graphId}.`,
          { cause },
        );
      }
      artifactRefs.push(artifactId);
    }

    const existing = graph.artifactRefs ?? [];
    return {
      ...graph,
      artifactRefs: [...new Set([...existing, ...artifactRefs])],
    };
  }
}

function kindFor(mediaType: RawArtifact["mediaType"]): ArtifactKind {
  return mediaType === "image/png" ? "screenshot" : "observation";
}
