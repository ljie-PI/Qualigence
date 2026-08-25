import { describe, expect, it, vi } from "vitest";
import type {
  ArtifactManifest,
  ArtifactManifestStore,
  ArtifactStore,
  ArtifactWriteRequest,
  ExecutionRunRecord,
  RunStore,
  RunTerminalUpdate,
} from "@qualigence/evidence";
import { InMemoryTraceStore, TraceIngestor } from "@qualigence/evidence";
import type {
  ObservationGraphV1,
  RunId,
} from "@qualigence/runner-protocol";
import {
  ExecutionRuntime,
  type Observer,
  type PolicyDecision,
  type RunnerPolicyGate,
  type VerificationResult,
  type Verifier,
} from "@qualigence/runner-kernel";
import { InMemoryProtocolTraceRecorder } from "@qualigence/in-memory-runner-protocol";
import { AllowAllRunnerPolicyGate, ScriptedDecisionProvider } from "@qualigence/testkit";
import {
  ArtifactRecordingObserver,
  RunExecutionUseCaseImpl,
  type ArtifactSource,
  type RunExecutionRequest,
  type RunResourceFactory,
} from "@qualigence/execution-application";
import { observationGraphV1 } from "../../helpers/observation-graph-v1.js";

function request(): RunExecutionRequest {
  return {
    projectId: "project-test",
    target: { kind: "web", url: "http://127.0.0.1:3000/" },
    objective: "add one item",
    policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["http://127.0.0.1:3000"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
    executionProfile: {
      modelProfileId: "default",
      headed: false,
      navigationTimeoutMs: 10_000,
      actionTimeoutMs: 5_000,
    },
  };
}

class InMemoryRunStore implements RunStore {
  readonly records = new Map<string, ExecutionRunRecord>();
  async create(record: ExecutionRunRecord): Promise<void> {
    this.records.set(record.runId, record);
  }
  async complete(
    runId: RunId,
    terminal: RunTerminalUpdate,
  ): Promise<"completed" | "duplicate"> {
    const existing = this.records.get(runId);
    if (!existing) {
      throw new Error(`unknown run ${runId}`);
    }
    if (existing.status !== "running") {
      return "duplicate";
    }
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

class InMemoryArtifactStore implements ArtifactStore {
  async write(req: ArtifactWriteRequest): Promise<ArtifactManifest> {
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
  }
  async read(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async verify(): Promise<boolean> {
    return true;
  }
}

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

function graph(graphId: string, nodeId: string, text: string): ObservationGraphV1 {
  return observationGraphV1(graphId, [{ id: nodeId, role: "button", name: text, confidence: 1 }]);
}

function scriptedObserver(graphs: readonly ObservationGraphV1[]): Observer {
  const queue = [...graphs];
  return {
    async capture() {
      const next = queue.shift();
      if (!next) {
        throw new Error("scripted observer exhausted");
      }
      return next;
    },
  };
}

const denyPolicy: RunnerPolicyGate = {
  async authorize(): Promise<PolicyDecision> {
    return { status: "denied", reason: "blocked by test policy" };
  },
};

const passedVerifier: Verifier = {
  async verify(): Promise<VerificationResult> {
    return { status: "passed", summary: "ok", claims: [] };
  },
};

const findingVerifier: Verifier = {
  async verify(): Promise<VerificationResult> {
    return {
      status: "failed",
      summary: "cart total mismatch",
      severitySuggestion: "medium",
      claims: [
        {
          expected: { graphId: "g-before", nodeId: "n1", text: "Cart total: $0" },
          observed: { graphId: "g-after", nodeId: "n2", text: "Cart total: $19" },
        },
      ],
    };
  },
};

const artifactSource: ArtifactSource = {
  async captureArtifacts(graphId) {
    return [
      {
        name: `${graphId}.json`,
        mediaType: "application/json",
        bytes: new TextEncoder().encode("{}"),
      },
      {
        name: `${graphId}.png`,
        mediaType: "image/png",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
    ];
  },
};

interface HarnessOptions {
  readonly makeObserver: () => Observer;
  readonly policyGate: RunnerPolicyGate;
  readonly verifier: Verifier;
  readonly withArtifacts?: boolean;
  readonly executeAction?: import("@qualigence/runner-kernel").ActionExecutor["execute"];
}

interface Harness {
  readonly useCase: RunExecutionUseCaseImpl;
  readonly runs: InMemoryRunStore;
  readonly traces: InMemoryTraceStore;
  readonly manifests: InMemoryManifestStore;
  readonly close: ReturnType<typeof vi.fn>;
}

function createHarness(options: HarnessOptions): Harness {
  const runs = new InMemoryRunStore();
  const manifests = new InMemoryManifestStore();
  const artifacts = new InMemoryArtifactStore();
  const traces = new InMemoryTraceStore();
  const close = vi.fn(async () => undefined);
  let artifactCounter = 0;

  const factory: RunResourceFactory = {
    async open(runId) {
      const traceRecorder = new InMemoryProtocolTraceRecorder(
        new TraceIngestor(traces),
      );
      const base = options.makeObserver();
      const observer = options.withArtifacts
        ? new ArtifactRecordingObserver({
            observer: base,
            source: artifactSource,
            artifacts,
            manifests,
            runId,
            createArtifactId: () => `art-${(artifactCounter += 1)}`,
          })
        : base;
      const runtime = new ExecutionRuntime({
        observer,
        decisionProvider: new ScriptedDecisionProvider({
          kind: "click",
          target: { nodeId: "n1" },
          reason: "add item",
        }),
        resolver: {
          async resolve(action, resolvedGraph) {
            return {
              kind: "click",
              target: { nodeId: action.target.nodeId, selector: "sel" },
              graphId: resolvedGraph.graphId,
            };
          },
        },
        policyGate: options.policyGate,
        actionExecutor: {
          execute: options.executeAction ?? (async () => ({ status: "ok" })),
        },
        verifier: options.verifier,
        traceRecorder,
        objectiveOnlyMaximumWallClockMs: 5_000,
        objectiveOnlyMaximumModelTokens: 100,
      });
      return { execute: (job) => runtime.run(job), artifacts, manifests, runs, traces, close };
    },
  };

  return { useCase: new RunExecutionUseCaseImpl(factory), runs, traces, manifests, close };
}

function twoGraphs(): readonly ObservationGraphV1[] {
  return [
    graph("g-before", "n1", "Cart total: $0"),
    graph("g-after", "n2", "Cart total: $19"),
  ];
}

function passedHarness(): Harness {
  return createHarness({
    makeObserver: () => scriptedObserver(twoGraphs()),
    policyGate: new AllowAllRunnerPolicyGate(),
    verifier: passedVerifier,
  });
}

function findingHarness(): Harness {
  return createHarness({
    makeObserver: () => scriptedObserver(twoGraphs()),
    policyGate: new AllowAllRunnerPolicyGate(),
    verifier: findingVerifier,
    withArtifacts: true,
  });
}

function blockedHarness(): Harness {
  return createHarness({
    makeObserver: () => scriptedObserver(twoGraphs()),
    policyGate: denyPolicy,
    verifier: passedVerifier,
  });
}

function rejectingHarness(error: Error): Harness {
  return createHarness({
    makeObserver: () => ({
      async capture() {
        throw error;
      },
    }),
    policyGate: new AllowAllRunnerPolicyGate(),
    verifier: passedVerifier,
  });
}

function unknownActionOutcomeHarness(): Harness {
  return createHarness({
    makeObserver: () => scriptedObserver(twoGraphs()),
    policyGate: new AllowAllRunnerPolicyGate(),
    verifier: passedVerifier,
    executeAction: async (_action, permit, signal) => {
      permit.assertAuthorizedForDispatch(signal);
      throw new Error("connection lost after dispatch");
    },
  });
}

describe("RunExecutionUseCaseImpl", () => {
  it.each([
    ["passed", passedHarness],
    ["finding", findingHarness],
    ["blocked", blockedHarness],
  ] as const)("maps runtime %s completion to a persisted terminal", async (
    status,
    build,
  ) => {
    const harness = build();

    const result = await harness.useCase.execute(request());

    expect(result.status).toBe(status);
    const run = await harness.runs.get(result.runId);
    expect(run?.status).toBe(status);
    const terminals = harness.traces
      .eventsFor(result.runId)
      .filter((event) => event.stage === "run_completed");
    expect(terminals).toHaveLength(1);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("returns and persists a Finding with semantic and artifact evidence refs", async () => {
    const harness = findingHarness();

    const result = await harness.useCase.execute(request());

    expect(result.status).toBe("finding");
    expect(result.finding?.evidenceRefs).toEqual(
      expect.arrayContaining([
        "g-before:n1",
        "g-after:n2",
        "art-1",
        "art-2",
        "art-3",
        "art-4",
      ]),
    );
    expect(result.evidenceRefs).toEqual(
      expect.arrayContaining(["g-before:n1", "art-1"]),
    );
  });

  it("maps infrastructure errors, ensures a terminal and closes resources", async () => {
    const harness = rejectingHarness(new Error("browser crashed"));

    const result = await harness.useCase.execute(request());

    expect(result).toMatchObject({
      status: "error",
      errorCode: "BrowserUnavailable",
    });
    const run = await harness.runs.get(result.runId);
    expect(run?.status).toBe("error");
    const terminals = harness.traces
      .eventsFor(result.runId)
      .filter((event) => event.stage === "run_completed");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.payload).toMatchObject({
      status: "error",
      errorCode: "BrowserUnavailable",
    });
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("preserves an unknown action outcome as an error without retrying", async () => {
    const harness = unknownActionOutcomeHarness();

    const result = await harness.useCase.execute(request());

    expect(result).toMatchObject({ status: "error", errorCode: "ActionOutcomeUnknown" });
    expect((await harness.runs.get(result.runId))?.status).toBe("error");
    expect(harness.traces.eventsFor(result.runId).filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(harness.traces.eventsFor(result.runId).at(-1)?.payload).toEqual({
      status: "error",
      errorCode: "ActionOutcomeUnknown",
    });
  });

  it("creates no Run and never opens a scope when the URL is invalid", async () => {
    const open = vi.fn(async () => {
      throw new Error("open must not be called");
    });
    const factory: RunResourceFactory = { open };
    const useCase = new RunExecutionUseCaseImpl(factory);

    const result = await useCase.execute({
      ...request(),
      target: { kind: "web", url: "not-a-url" },
    });

    expect(result).toMatchObject({ status: "error", errorCode: "InvalidTargetUrl" });
    expect(result.runId).toBe("");
    expect(open).not.toHaveBeenCalled();
  });

  it("creates no Run and never opens a scope when project provenance is missing", async () => {
    const open = vi.fn(async () => {
      throw new Error("open must not be called");
    });
    const useCase = new RunExecutionUseCaseImpl({ open });

    const result = await useCase.execute({ ...request(), projectId: undefined } as never);

    expect(result).toMatchObject({ status: "error", errorCode: "InvalidConfiguration", runId: "" });
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects an empty objective as invalid configuration before opening a scope", async () => {
    const open = vi.fn();
    const useCase = new RunExecutionUseCaseImpl({ open } as RunResourceFactory);

    const result = await useCase.execute({ ...request(), objective: "   " });

    expect(result).toMatchObject({
      status: "error",
      errorCode: "InvalidConfiguration",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps state and logs isolated across concurrent runs", async () => {
    const harness = passedHarness();

    const [first, second] = await Promise.all([
      harness.useCase.execute(request()),
      harness.useCase.execute(request()),
    ]);

    expect(first.runId).not.toBe(second.runId);
    expect((await harness.runs.get(first.runId))?.status).toBe("passed");
    expect((await harness.runs.get(second.runId))?.status).toBe("passed");
    const firstStages = harness.traces
      .eventsFor(first.runId)
      .map((event) => event.stage);
    const secondStages = harness.traces
      .eventsFor(second.runId)
      .map((event) => event.stage);
    expect(firstStages.at(-1)).toBe("run_completed");
    expect(secondStages.at(-1)).toBe("run_completed");
    expect(
      harness.traces
        .eventsFor(first.runId)
        .every((event) => event.runId === first.runId),
    ).toBe(true);
  });
});
