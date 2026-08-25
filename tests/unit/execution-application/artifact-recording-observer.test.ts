import { describe, expect, it } from "vitest";
import type {
  ArtifactManifest,
  ArtifactManifestStore,
  ArtifactStore,
  ArtifactWriteRequest,
} from "@qualigence/evidence";
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_TYPE,
  type AcceptedExecutionJob,
  type ObservationGraphV1,
} from "@qualigence/runner-protocol";
import type { Observer } from "@qualigence/runner-kernel";
import {
  ArtifactRecordingObserver,
  ExecutionApplicationError,
  type ArtifactSource,
  type RawArtifact,
} from "@qualigence/execution-application";

const job: AcceptedExecutionJob = {
  jobId: "job-1",
  runId: "run-1",
  projectId: "project-test",
  target: { kind: "web", url: "http://127.0.0.1:1" },
  objective: "add one item",
  policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["http://127.0.0.1:1"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
};

function graph(graphId: string): ObservationGraphV1 {
  return {
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId,
    target: { kind: "web", targetId: "http://127.0.0.1:1" },
    capturedAt: "2026-08-24T00:00:00.000Z",
    rootNodeIds: ["root"],
    nodes: [{
      id: "root",
      role: "document",
      name: "Test page",
      state: {},
      relations: [],
      source: { adapterId: "execution-application-test", sourceKind: "fixture" },
      confidence: 1,
      sensitivity: "public",
      extensions: {},
      evidenceRefs: [],
    }],
    evidenceRefs: [],
    extensions: {
      [WEB_EXTENSION_V1_TYPE]: {
        type: WEB_EXTENSION_V1_TYPE,
        version: "1.0",
        payload: {
          origin: "http://127.0.0.1:1",
          pathname: "/",
          title: "Test page",
          viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
          query: {},
        },
      },
    },
  };
}

function manifestFor(request: ArtifactWriteRequest): ArtifactManifest {
  return {
    artifactId: request.artifactId,
    runId: request.runId,
    kind: request.kind,
    mediaType: request.mediaType,
    relativePath: `${request.runId}/${request.name}`,
    sha256: "0".repeat(64),
    size: request.bytes.byteLength,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

class FakeArtifactStore implements ArtifactStore {
  readonly writes: ArtifactWriteRequest[] = [];
  private failOnKind?: string;
  failWritesForKind(kind: string): void {
    this.failOnKind = kind;
  }
  async write(request: ArtifactWriteRequest): Promise<ArtifactManifest> {
    if (this.failOnKind === request.kind) {
      throw new Error("disk full");
    }
    this.writes.push(request);
    return manifestFor(request);
  }
  async read(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async verify(): Promise<boolean> {
    return true;
  }
}

class FakeManifestStore implements ArtifactManifestStore {
  readonly appended: ArtifactManifest[] = [];
  async append(manifest: ArtifactManifest): Promise<"accepted" | "duplicate"> {
    this.appended.push(manifest);
    return "accepted";
  }
  async listForRun(): Promise<readonly ArtifactManifest[]> {
    return this.appended;
  }
}

function rawArtifacts(): readonly RawArtifact[] {
  return [
    {
      name: "1-observation.json",
      mediaType: "application/json",
      bytes: new TextEncoder().encode("{}"),
    },
    {
      name: "1.png",
      mediaType: "image/png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    },
  ];
}

function fakeSource(artifacts: readonly RawArtifact[]): ArtifactSource {
  return { captureArtifacts: async () => artifacts };
}

function innerObserver(result: ObservationGraphV1): Observer {
  return { capture: async () => result };
}

function idFactory(...ids: readonly string[]): () => string {
  const queue = [...ids];
  return () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("id factory exhausted");
    }
    return next;
  };
}

describe("ArtifactRecordingObserver", () => {
  it("writes graph JSON, screenshot and manifests then returns artifact refs", async () => {
    const artifacts = new FakeArtifactStore();
    const manifests = new FakeManifestStore();
    const observer = new ArtifactRecordingObserver({
      observer: innerObserver(graph("before")),
      source: fakeSource(rawArtifacts()),
      artifacts,
      manifests,
      runId: "run-1",
      createArtifactId: idFactory("before-json", "before-png"),
    });

    const recorded = await observer.capture(job);

    expect(recorded.evidenceRefs).toEqual(["before-json", "before-png"]);
    expect(artifacts.writes.map((w) => w.kind)).toEqual([
      "observation",
      "screenshot",
    ]);
    expect(manifests.appended.map((m) => m.artifactId)).toEqual([
      "before-json",
      "before-png",
    ]);
  });

  it("throws ArtifactUnavailable and records no partial refs when a write fails", async () => {
    const artifacts = new FakeArtifactStore();
    artifacts.failWritesForKind("screenshot");
    const manifests = new FakeManifestStore();
    const observer = new ArtifactRecordingObserver({
      observer: innerObserver(graph("before")),
      source: fakeSource(rawArtifacts()),
      artifacts,
      manifests,
      runId: "run-1",
      createArtifactId: idFactory(
        "before-json",
        "before-png",
        "retry-json",
        "retry-png",
      ),
    });

    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "ArtifactUnavailable",
    });
    await expect(observer.capture(job)).rejects.toBeInstanceOf(
      ExecutionApplicationError,
    );
  });
});
