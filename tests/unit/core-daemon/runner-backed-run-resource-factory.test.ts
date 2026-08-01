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
  ExecutionJobLease,
  ObservationGraph,
  RunId,
} from "@qualigence/runner-protocol";
import type {
  ActionOutcome,
  ProposedAction,
  ResolvedAction,
  VerificationResult,
} from "@qualigence/runner-kernel";
import { AllowAllRunnerPolicyGate } from "@qualigence/testkit";
import {
  RunnerBackedRunResourceFactory,
  type RemoteRunnerTarget,
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
    target: { kind: "web", url: "http://127.0.0.1:3000/" },
    objective: "add one item to the cart",
    executionProfile: {
      modelProfileId: "default",
      headed: false,
      navigationTimeoutMs: 10_000,
      actionTimeoutMs: 5_000,
    },
  };
}

function graph(graphId: string): ObservationGraph {
  return { graphId, nodes: [{ id: "n1", role: "button", name: "add", text: "Add", confidence: 1 }] };
}

/** A remote target that scripts a passing run and records every dispatched call. */
class RecordingRemoteTarget implements RemoteRunnerTarget {
  readonly calls: string[] = [];
  private captures = 0;
  async capture(): Promise<ObservationGraph> {
    this.calls.push("capture");
    this.captures += 1;
    return graph(`g-${this.captures}`);
  }
  async decide(): Promise<ProposedAction> {
    this.calls.push("decide");
    return { kind: "click", target: { nodeId: "n1" }, reason: "click add" };
  }
  async resolve(): Promise<ResolvedAction> {
    this.calls.push("resolve");
    return { kind: "click", target: { nodeId: "n1", selector: "#add" }, graphId: "g-1" };
  }
  async execute(): Promise<ActionOutcome> {
    this.calls.push("execute");
    return { status: "ok" };
  }
  async verify(): Promise<VerificationResult> {
    this.calls.push("verify");
    return { status: "passed", summary: "ok", claims: [] };
  }
  async close(): Promise<void> {
    this.calls.push("close");
  }
}

describe("RunnerBackedRunResourceFactory", () => {
  it("drives RunExecutionUseCase over a leased Runner without changing its interface", async () => {
    const target = new RecordingRemoteTarget();
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
    const connection: RunnerConnectionPort = { offer, cancel };

    const factory = new RunnerBackedRunResourceFactory({
      connection,
      openTarget: async () => target,
      openStores: async () => ({
        runs,
        traces,
        artifacts: artifactStore,
        manifests,
        close: async () => undefined,
      }),
      policyGate: new AllowAllRunnerPolicyGate(),
    });

    const useCase = new RunExecutionUseCaseImpl(factory);
    const result = await useCase.execute(request());

    expect(result.status).toBe("passed");
    // The whole pipeline was dispatched to the remote Runner target.
    expect(target.calls).toContain("capture");
    expect(target.calls).toContain("execute");
    expect(target.calls).toContain("verify");
    // A single-owner lease was acquired via the RunnerConnectionPort and released.
    expect(offer).toHaveBeenCalledOnce();
    expect(offer.mock.calls[0]?.[1]).toEqual(["target:web-playwright"]);
    expect(cancel).toHaveBeenCalledOnce();
    // Trace was persisted on the Core side.
    expect(traces.eventsFor(result.runId).length).toBeGreaterThan(0);
  });
});
