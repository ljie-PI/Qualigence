import { describe, expect, it, vi } from "vitest";
import type {
  ArtifactManifest,
  ArtifactManifestStore,
  ArtifactStore,
  ExecutionRunRecord,
  RunStore,
  RunTerminalUpdate,
} from "@qualigence/evidence";
import { InMemoryTraceStore } from "@qualigence/evidence";
import { RunExecutionUseCaseImpl, type RunExecutionRequest } from "@qualigence/execution-application";
import type { RunnerConnectionPort } from "@qualigence/grpc-runner-protocol";
import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
  ExecutionJobLease,
  RunId,
} from "@qualigence/runner-protocol";
import {
  RunnerBackedRunResourceFactory,
} from "../../../apps/core-daemon/src/index.js";

class InMemoryRunStore implements RunStore {
  readonly records = new Map<string, ExecutionRunRecord>();
  async create(record: ExecutionRunRecord): Promise<void> {
    this.records.set(record.runId, record);
  }
  async complete(runId: RunId, terminal: RunTerminalUpdate): Promise<"completed" | "duplicate"> {
    const existing = this.records.get(runId);
    if (!existing) throw new Error(`unknown run ${runId}`);
    if (existing.status !== "running") return "duplicate";
    this.records.set(runId, {
      ...existing,
      status: terminal.status,
      completedAt: terminal.completedAt,
      ...(terminal.errorCode === undefined ? {} : { errorCode: terminal.errorCode }),
    });
    return "completed";
  }
  async get(runId: RunId): Promise<ExecutionRunRecord | undefined> {
    return this.records.get(runId);
  }
}

const artifactStore: ArtifactStore = {
  async write(req) {
    return {
      artifactId: req.artifactId,
      runId: req.runId,
      kind: req.kind,
      mediaType: req.mediaType,
      relativePath: `${req.runId}/${req.name}`,
      sha256: "0".repeat(64),
      size: req.bytes.byteLength,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
  },
  async read() {
    return new Uint8Array();
  },
  async verify() {
    return true;
  },
};

class InMemoryManifestStore implements ArtifactManifestStore {
  readonly manifests: ArtifactManifest[] = [];
  async append(manifest: ArtifactManifest): Promise<"accepted" | "duplicate"> {
    this.manifests.push(manifest);
    return "accepted";
  }
  async listForRun(runId: RunId): Promise<readonly ArtifactManifest[]> {
    return this.manifests.filter((manifest) => manifest.runId === runId);
  }
}

function request(): RunExecutionRequest {
  return {
    projectId: "project-test",
    target: { kind: "web", url: "http://127.0.0.1:3000/" },
    objective: "add one item to the cart",
    policy: { policyId: "policy-request", environment: "isolated_test", allowedOrigins: ["http://127.0.0.1:3000"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
    executionProfile: {
      modelProfileId: "default",
      headed: false,
      navigationTimeoutMs: 10_000,
      actionTimeoutMs: 5_000,
    },
  };
}

describe("RunnerBackedRunResourceFactory", () => {
  it("rejects a legacy injected policy gate at the public constructor", () => {
    expect(() => new RunnerBackedRunResourceFactory({
      connection: { offer: vi.fn(), cancel: vi.fn() },
      openStores: vi.fn(), awaitCompletion: vi.fn(), policyGate: {} as never,
    } as never)).toThrow(/policyGate/);
  });

  it("rejects missing project provenance or a missing/malformed request policy before opening stores or offering", async () => {
    const openStores = vi.fn();
    const offer = vi.fn();
    const factory = new RunnerBackedRunResourceFactory({
      connection: { authenticatedRunner: runnerSnapshot, offer, cancel: vi.fn() },
      openStores,
      awaitCompletion: vi.fn(),
    });

    await expect(factory.open("run-1", { ...request(), policy: undefined } as never)).rejects.toMatchObject({ code: "PolicyMissing" });
    await expect(factory.open("run-1", { ...request(), projectId: undefined } as never)).rejects.toMatchObject({ code: "PolicyMissing" });
    await expect(factory.open("run-1", { ...request(), policy: { ...request().policy, expiresAt: "not-an-instant" } } as never)).rejects.toMatchObject({ code: "PolicyMissing" });
    expect(openStores).not.toHaveBeenCalled();
    expect(offer).not.toHaveBeenCalled();
  });

  it("offers the exact already-derived policy and waits for Runner completion without Core execution", async () => {
    const runs = new InMemoryRunStore();
    const traces = new InMemoryTraceStore();
    const manifests = new InMemoryManifestStore();

    const lease: ExecutionJobLease = {
      jobId: "job-1",
      runId: "run-1",
      leaseToken: "secret",
      leaseEpoch: 1,
      expiresAt: "2999-01-01T00:00:00.000Z",
    };
    const offer = vi.fn(async (_job: AcceptedExecutionJob, _reqs: readonly string[]) => lease);
    const cancel = vi.fn(async () => undefined);
    const connection: RunnerConnectionPort = { authenticatedRunner: runnerSnapshot, offer, cancel };

    const awaitCompletion = vi.fn(async (acceptedLease: ExecutionJobLease): Promise<ExecutionCompletion> => ({
      jobId: acceptedLease.jobId,
      runId: acceptedLease.runId,
      status: "passed",
    }));
    const runRequest = request();
    const factory = new RunnerBackedRunResourceFactory({
      connection,
      openStores: async () => ({
        runs,
        traces,
        artifacts: artifactStore,
        manifests,
        close: async () => undefined,
      }),
      awaitCompletion,
    });

    const useCase = new RunExecutionUseCaseImpl(factory);
    const result = await useCase.execute(runRequest);

    expect(result.status).toBe("passed");
    // A single-owner lease was acquired via the RunnerConnectionPort and released.
    expect(offer).toHaveBeenCalledOnce();
    expect(offer.mock.calls[0]?.[1]).toEqual(["target:web-playwright"]);
    expect(offer.mock.calls[0]?.[0].policy).toBe(runRequest.policy);
    expect(offer.mock.calls[0]?.[0].projectId).toBe(runRequest.projectId);
    expect(awaitCompletion).toHaveBeenCalledWith(lease);
    expect(cancel).toHaveBeenCalledOnce();
    expect(traces.eventsFor(result.runId)).toEqual([]);
  });

  it("rejects a Job from another project before offering it to a Runner", async () => {
    const offer = vi.fn();
    const factory = new RunnerBackedRunResourceFactory({
      connection: { authenticatedRunner: runnerSnapshot, offer, cancel: vi.fn() },
      openStores: async () => ({
        runs: new InMemoryRunStore(),
        traces: new InMemoryTraceStore(),
        artifacts: artifactStore,
        manifests: new InMemoryManifestStore(),
        close: async () => undefined,
      }),
      awaitCompletion: vi.fn(),
    });
    const runRequest = request();
    const scope = await factory.open("run-1", runRequest);
    try {
      await expect(scope.execute({
        jobId: "job-1",
        runId: "run-1",
        projectId: "other-project",
        target: runRequest.target,
        objective: runRequest.objective,
        policy: runRequest.policy,
      })).rejects.toThrow(/project provenance/);
      expect(offer).not.toHaveBeenCalled();
    } finally {
      await scope.close();
    }
  });
});

const runnerSnapshot = { runnerId: "runner-1", scope: { kind: "local" as const }, capabilities: ["target:web-playwright"] };
