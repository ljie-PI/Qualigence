import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  createScenarioWalkTestDoubleAgentFactory,
  runBenchmark,
  type BenchmarkStore,
  type ScenarioDefinition,
} from "@qualigence/benchmark-runner";
import type {
  BenchmarkAttempt,
  DetectionBenchmarkManifest,
  DetectionBenchmarkReport,
  GroundTruth,
  ReferenceModelProfile,
} from "@qualigence/benchmarking-detection";
import type {
  ArtifactManifest,
  ArtifactManifestStore,
  ArtifactStore,
  ArtifactWriteRequest,
} from "@qualigence/evidence";
import {
  ArtifactRecordingObserver,
  type ArtifactSource,
  type RawArtifact,
} from "@qualigence/execution-application";
import {
  ExplorationController,
  StateVisitTracker,
  type ExplorationAgentPort,
  type ExplorationContext,
  type ExplorationProgressStore,
  type ExplorationProgressUpdate,
  type ExplorationProgressUpdateResult,
  type ExplorationProposal,
  type ExplorationTarget,
  type GroundedExplorationAction,
  type NewExplorationAttemptProgress,
} from "@qualigence/exploration";
import { LocalSkillSigner } from "@qualigence/kms-local";
import { ModelBackedDecisionProvider, ModelBackedVerifier } from "@qualigence/model-agent";
import type { StructuredModelInvoker, StructuredModelRequest } from "@qualigence/model-gateway";
import type {
  ExplorationAttemptProgress,
  ExplorationCheckpoint,
  ExplorationDecision,
  ExplorationPolicy,
} from "@qualigence/mission";
import { PreV1TraceProjector, type ProjectionRecord } from "@qualigence/observation-migration";
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_REDACTION_MARKER,
  WEB_EXTENSION_V1_TYPE,
  canonicalPayloadHash,
  observationGraphHash,
  validateObservationGraphV1,
  type AcceptedExecutionJob,
  type ObservationGraph,
  type ObservationGraphV1,
  type ObservationNode,
  type ObservationNodeV1,
  type TraceEvent,
} from "@qualigence/runner-protocol";
import {
  ExecutionPermit,
  ExecutionRuntime,
  type ActionExecutor,
  type ActionResolver,
  type AnyResolvedAction,
  type PolicyDecision,
  type ProposedAction,
  type RunnerPolicyContext,
  type RunnerPolicyGate,
  type TraceEventInput,
  type TraceRecorder,
} from "@qualigence/runner-kernel";
import {
  bundlePayloadContentSha256,
  type ProcedureSkillVersion,
  type SignedSkillBundle,
  type SkillVerificationScope,
  type UnsignedSkillBundle,
} from "@qualigence/skill";
import {
  SkillReplayController,
  type ReplayTarget,
  type ResolvedReplayAction,
} from "@qualigence/skill-replay";

const scopeOrigin = "https://shop.example";
const scope: SkillVerificationScope = {
  projectId: "proj-1",
  targetId: "web-cart",
  origin: scopeOrigin,
};

const job: AcceptedExecutionJob = {
  jobId: "job-consumer-migration",
  runId: "run-consumer-migration",
  projectId: "project-test",
  target: { kind: "web", url: `${scopeOrigin}/product?session=raw-live` },
  objective: "add an item to the cart",
  policy: {
    policyId: "policy-1",
    environment: "isolated_test",
    allowedOrigins: [scopeOrigin],
    allowedActionKinds: ["click"],
    maximumRisk: "Normal",
    explorationAllowed: true,
    issuedAt: "2026-08-25T00:00:00.000Z",
    expiresAt: "2026-08-25T00:05:00.000Z",
  },
  plan: {
    missionId: "mission-1",
    missionRevision: 1,
    testCaseId: "case-cart",
    steps: [
      {
        stepIndex: 0,
        kind: "click",
        target: { purpose: "add to cart" },
      },
    ],
    expectedClaimIds: ["cart.count>=1"],
    budget: {
      maximumStepsPerJob: 1,
      maximumWallClockMs: 10_000,
      maximumModelTokens: 10_000,
    },
  },
};

const ADD_NODE = {
  id: "node-add",
  role: "button",
  name: "Add to cart",
  confidence: 1,
} as const;

const profile: ReferenceModelProfile = {
  profileId: "consumer-migration-reference-profile",
  providerId: "qualigence-deterministic",
  modelId: "qualigence-reference-detector-1",
  promptVersion: "prompt/2026-08-25",
  policyBundleSha256: "1".repeat(64),
  skillPackSha256: "2".repeat(64),
  browserVersion: "deterministic-target/1.0.0",
  fixtureVersions: { cart: "cart/1.0.0" },
  maximumSteps: 4,
  maximumWallClockMs: 60_000,
  maximumModelTokens: 10_000,
  repetitions: 1,
};

const manifest: DetectionBenchmarkManifest = {
  schemaVersion: "detection-benchmark/v1",
  benchmarkVersion: "consumer-migration-acceptance",
  referenceProfile: profile,
  scenarios: [
    {
      scenarioId: "cart-defect",
      fixtureId: "cart",
      fixtureVersion: "cart/1.0.0",
      mode: "fault",
      missionRef: "scenarios/cart-defect.json",
      groundTruthRef: "ground-truth/cart.json",
      expectedDefectIds: ["bug-cart-total"],
    },
  ],
  thresholds: {
    p0RecallMinimum: 1,
    knownBugRecallMinimum: 0.8,
    findingPrecisionMinimum: 0.6,
    stableReproductionRateMinimum: 0.7,
    maximumHighConfidenceFalsePositivesPerNormalMission: 1,
  },
};

const groundTruth: GroundTruth = {
  benchmarkVersion: manifest.benchmarkVersion,
  defects: [
    {
      scenarioId: "cart-defect",
      defectId: "bug-cart-total",
      severity: "P1",
      stable: true,
    },
  ],
};

describe("Observation Graph v1 consumer migration acceptance", () => {
  it("runs model, resolver, evidence, exploration, benchmark and replay over v1 and projected historical input", async () => {
    const liveBefore = webGraph({
      graphId: "live-before",
      pathname: "/product",
      nodes: [ADD_NODE],
      graphEvidenceRefs: ["producer-live-before"],
      nodeEvidenceRefs: { "node-add": ["producer-node-add"] },
      queryKeys: ["session"],
    });
    const liveAfter = webGraph({
      graphId: "live-after",
      pathname: "/cart",
      nodes: [ADD_NODE],
      graphEvidenceRefs: ["producer-live-after"],
      nodeEvidenceRefs: { "node-add": ["producer-node-after"] },
      queryKeys: ["session"],
    });

    const gateway = new ScriptedStructuredGateway([
      { nodeId: "node-add", reason: "semantic v1 button" },
      { status: "passed", summary: "cart changed", claims: [] },
    ]);
    const resolver = new CapturingResolver();
    const actionExecutor = new RecordingActionExecutor();
    const trace = new RecordingTraceRecorder();
    const artifactStore = new FakeArtifactStore();
    const manifestStore = new FakeManifestStore();
    const artifactSource = new GraphArtifactSource();
    const runtime = new ExecutionRuntime({
      observer: new ArtifactRecordingObserver({
        observer: new SequentialObserver([liveBefore, liveAfter]),
        source: artifactSource,
        artifacts: artifactStore,
        manifests: manifestStore,
        runId: job.runId,
        createArtifactId: idFactory("artifact-before-json", "artifact-before-png", "artifact-after-json", "artifact-after-png"),
      }),
      decisionProvider: new ModelBackedDecisionProvider(gateway, "acceptance-model"),
      resolver,
      policyGate: new AllowingPolicyGate(),
      actionExecutor,
      verifier: new ModelBackedVerifier(gateway, "acceptance-model"),
      traceRecorder: trace,
    });

    await expect(runtime.run(job)).resolves.toEqual({
      jobId: job.jobId,
      runId: job.runId,
      status: "passed",
    });

    const observations = trace.observations();
    expect(observations).toHaveLength(2);
    expect(observations[0]?.schema).toEqual(OBSERVATION_GRAPH_V1_SCHEMA);
    expect(observations[0]?.evidenceRefs).toEqual([
      "producer-live-before",
      "artifact-before-json",
      "artifact-before-png",
    ]);
    expect(observations[0]?.nodes.find((node) => node.id === "node-add")?.evidenceRefs).toEqual([
      "producer-node-add",
    ]);
    expect(manifestStore.appended.map((manifest) => manifest.artifactId)).toEqual([
      "artifact-before-json",
      "artifact-before-png",
      "artifact-after-json",
      "artifact-after-png",
    ]);
    expect(artifactSource.graphIds).toEqual(["live-before", "live-after"]);
    expect(resolver.graphs[0]?.schema).toEqual(OBSERVATION_GRAPH_V1_SCHEMA);
    expect(resolver.graphs[0]?.evidenceRefs).toContain("artifact-before-json");
    expect(actionExecutor.actions[0]).toMatchObject({
      kind: "click",
      target: { nodeId: "node-add" },
      graphId: "live-before",
    });

    const decisionPrompt = String(gateway.requests[0]?.messages[1]?.content ?? "");
    const verificationPrompt = String(gateway.requests[1]?.messages[1]?.content ?? "");
    expect(decisionPrompt).toContain('"schema":{"epoch":"v1"');
    expect(decisionPrompt).toContain('"web":{"origin":"https://shop.example","pathname":"/product"');
    expect(decisionPrompt).toContain('"queryKeys":["session"]');
    expect(decisionPrompt).not.toContain("raw-live");
    expect(verificationPrompt).toContain('"after"');
    expect(verificationPrompt).not.toContain("raw-live");

    const replayTarget = new ProjectedReplayTarget();
    const signer = LocalSkillSigner.generate();
    const signed = await signer.sign(unsignedBundle(signer.keyId));
    const replay = await new SkillReplayController({ signer }).run(signed, replayTarget, scope);
    expect(replay).toEqual({ status: "passed" });
    expect(replayTarget.executed).toBe(1);
    expect(replayTarget.projections).toHaveLength(2);
    expect(replayTarget.projections[0]?.metadata.sourceArtifactRefs).toEqual(["legacy-product-artifact"]);
    expect(replayTarget.projections[0]?.graph.evidenceRefs).toEqual(["legacy-product-artifact"]);
    expect(replayTarget.projections[0]?.migratorVersion).toBe("observation-migrator/v1");

    const projectedProduct = replayTarget.projections[0]?.graph;
    if (projectedProduct === undefined) {
      throw new Error("Projected historical graph was not captured.");
    }
    const tracker = new StateVisitTracker();
    const firstFingerprint = tracker.fingerprintOf(projectedProduct);
    const secondFingerprint = new StateVisitTracker().fingerprintOf(projectedProduct);
    expect(secondFingerprint).toBe(firstFingerprint);

    const firstExploration = await runExploration(projectedProduct, "explore-a");
    const secondExploration = await runExploration(projectedProduct, "explore-b");
    expect(secondExploration.result).toEqual(firstExploration.result);
    expect(secondExploration.agent.contexts[0]?.graph.schema).toEqual(OBSERVATION_GRAPH_V1_SCHEMA);
    expect(firstExploration.result.checkpoints.map((checkpoint) => checkpoint.graphFingerprint)).toEqual([
      firstFingerprint,
    ]);

    const firstBenchmark = await runBenchmarkScenario(
      scenarioWithRawQueryValues({ seed: "alpha", productSession: "one", cartSession: "two" }),
    );
    const secondBenchmark = await runBenchmarkScenario(
      scenarioWithRawQueryValues({ seed: "beta", productSession: "three", cartSession: "four" }),
    );
    expect(secondBenchmark.runId).toBe(firstBenchmark.runId);
    expect(secondBenchmark.report.inputSha256).toBe(firstBenchmark.report.inputSha256);
    expect(secondBenchmark.report.attemptBindingSha256s).toEqual(firstBenchmark.report.attemptBindingSha256s);
    expect(secondBenchmark.report.metrics).toEqual(firstBenchmark.report.metrics);
  });

  it("rejects unsupported extension majors and direct legacy replay observations before side effects", async () => {
    const signer = LocalSkillSigner.generate();
    const signed = await signer.sign(unsignedBundle(signer.keyId));
    const controller = new SkillReplayController({ signer });

    const unsupportedMajorTarget = new UnsupportedMajorTarget();
    await expect(controller.run(signed, unsupportedMajorTarget, scope)).resolves.toEqual({
      status: "blocked",
      errorCode: "ExtensionVersionUnsupported",
    });
    expect(unsupportedMajorTarget.executed).toBe(0);

    const directLegacyTarget = new DirectLegacyTarget();
    await expect(controller.run(signed, directLegacyTarget, scope)).resolves.toEqual({
      status: "blocked",
      errorCode: "ObservationSchemaInvalid",
    });
    expect(directLegacyTarget.executed).toBe(0);
  });
});

interface WebGraphInput {
  readonly graphId: string;
  readonly pathname: string;
  readonly nodes: readonly (Pick<ObservationNodeV1, "id" | "role"> &
    Partial<Pick<ObservationNodeV1, "name" | "value" | "sensitivity">> & {
      readonly text?: string;
      readonly confidence?: number;
    })[];
  readonly graphEvidenceRefs?: readonly string[];
  readonly nodeEvidenceRefs?: Readonly<Record<string, readonly string[]>>;
  readonly queryKeys?: readonly string[];
  readonly origin?: string;
}

function webGraph(input: WebGraphInput): ObservationGraphV1 {
  const origin = input.origin ?? scopeOrigin;
  const rootId = `${input.graphId}:root`;
  const nodes = input.nodes.map((node): ObservationNodeV1 => ({
    id: node.id,
    role: node.role,
    ...(node.name === undefined ? {} : { name: node.name }),
    ...(node.value === undefined ? {} : { value: node.value }),
    state: node.text === undefined ? {} : { text: node.text },
    relations: [],
    source: { adapterId: "acceptance-web-producer", sourceKind: "accessibility" },
    confidence: node.confidence ?? 1,
    sensitivity: node.sensitivity ?? "public",
    extensions: {},
    evidenceRefs: input.nodeEvidenceRefs?.[node.id] ?? [],
  }));
  const root: ObservationNodeV1 = {
    id: rootId,
    role: "document",
    name: "Acceptance fixture",
    state: {},
    relations: nodes.map((node) => ({ type: "child", targetNodeId: node.id })),
    source: { adapterId: "acceptance-web-producer", sourceKind: "accessibility" },
    confidence: 1,
    sensitivity: "public",
    extensions: {},
    evidenceRefs: [],
  };
  return validateObservationGraphV1({
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId: input.graphId,
    target: { kind: "web", targetId: origin },
    capturedAt: "2026-08-25T00:00:00.000Z",
    rootNodeIds: [rootId],
    nodes: [root, ...nodes],
    evidenceRefs: input.graphEvidenceRefs ?? [],
    extensions: {
      [WEB_EXTENSION_V1_TYPE]: {
        type: WEB_EXTENSION_V1_TYPE,
        version: "1.0",
        payload: {
          origin,
          pathname: input.pathname,
          title: "Acceptance fixture",
          viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
          query: Object.fromEntries(
            (input.queryKeys ?? []).map((key) => [key, WEB_EXTENSION_V1_REDACTION_MARKER]),
          ),
        },
      },
    },
  }, { allowedWebQueryKeys: input.queryKeys ?? [] });
}

function unsupportedWebMajorGraph(): ObservationGraphV1 {
  const graph = webGraph({ graphId: "unsupported-major", pathname: "/product", nodes: [ADD_NODE] });
  const web = graph.extensions?.[WEB_EXTENSION_V1_TYPE];
  if (web === undefined) {
    throw new Error("webGraph did not attach web/v1 semantics.");
  }
  return {
    ...graph,
    extensions: {
      "web/v2": {
        type: "web/v2",
        version: "2.0",
        payload: web.payload,
      },
    },
  };
}

function legacyObservation(input: {
  readonly graphId: string;
  readonly pathname: string;
  readonly artifactRefs?: readonly string[];
}): ObservationGraph {
  const observation: ObservationGraph = {
    graphId: input.graphId,
    url: `${scopeOrigin}${input.pathname}?session=raw-historical`,
    title: "Historical cart fixture",
    capturedAt: "2026-08-24T00:00:00.000Z",
    artifactRefs: input.artifactRefs ?? [],
    nodes: [legacyNode(ADD_NODE)],
  };
  return observation;
}

function legacyNode(node: typeof ADD_NODE): ObservationNode {
  return {
    id: node.id,
    role: node.role,
    name: node.name,
    confidence: node.confidence,
  };
}

function projectHistorical(input: {
  readonly assetId: string;
  readonly pathname: string;
  readonly artifactRefs?: readonly string[];
}): ProjectionRecord {
  const projector = new PreV1TraceProjector();
  const observation = legacyObservation({
    graphId: `${input.assetId}-legacy`,
    pathname: input.pathname,
    ...(input.artifactRefs === undefined ? {} : { artifactRefs: input.artifactRefs }),
  });
  return projector.projectRecord({
    assetId: input.assetId,
    kind: "observation",
    sourceSchemaVersion: "pre-v1-web-fixture",
    target: { kind: "web", targetId: scopeOrigin },
    adapterId: "legacy-web-fixture",
    sourceKind: "accessibility",
    observation,
  });
}

function unsignedBundle(signerKeyId: string): UnsignedSkillBundle {
  const payload = cartPayload();
  return {
    bundleId: "bundle-consumer-migration",
    skillId: payload.skillId,
    skillVersion: payload.version,
    schemaVersion: "skill-bundle/v1",
    compilerVersion: payload.compilerVersion,
    contentSha256: payload.contentSha256,
    signerKeyId,
    signatureAlgorithm: "Ed25519",
    issuedAt: "2026-08-25T00:00:00.000Z",
    payload,
  };
}

function cartPayload(): ProcedureSkillVersion {
  const base: ProcedureSkillVersion = {
    skillId: "skill-consumer-migration",
    version: 1,
    state: "verified",
    projectId: scope.projectId,
    targetScope: {
      targetId: scope.targetId,
      allowedOrigins: [scopeOrigin],
    },
    parameters: [],
    steps: [
      {
        stepId: "step-add",
        intent: { kind: "click", target: { purpose: "add to cart" } },
        preconditions: [{ kind: "url_path", path: "/product" }],
        checkpoint: [{ kind: "url_path", path: "/cart" }],
        recovery: "stop",
        sourceNodeId: ADD_NODE.id,
      },
    ],
    sourceRecordingIds: ["rec-legacy"],
    observationSchemaEpoch: "pre-v1",
    locatorSchemaVersion: "semantic-locator/v1",
    compilerVersion: "skill-compiler/v1",
    contentSha256: "will-be-overwritten",
  };
  return { ...base, contentSha256: bundlePayloadContentSha256(base) };
}

class SequentialObserver {
  private index = 0;

  constructor(private readonly graphs: readonly ObservationGraphV1[]) {}

  async capture(): Promise<ObservationGraphV1> {
    const graph = this.graphs[Math.min(this.index, this.graphs.length - 1)];
    this.index += 1;
    if (graph === undefined) {
      throw new Error("SequentialObserver requires at least one graph.");
    }
    return graph;
  }
}

class ScriptedStructuredGateway implements StructuredModelInvoker {
  readonly requests: StructuredModelRequest[] = [];

  constructor(private readonly values: unknown[]) {}

  async invokeStructured<T>(request: StructuredModelRequest): Promise<{
    readonly value: T;
    readonly model: string;
    readonly finishReason: string;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number };
  }> {
    this.requests.push(request);
    const value = this.values.shift();
    if (value === undefined) {
      throw new Error("No scripted model response available.");
    }
    return {
      value: value as T,
      model: "acceptance-model",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
}

class CapturingResolver implements ActionResolver<"click"> {
  readonly graphs: ObservationGraphV1[] = [];

  async resolve(action: ProposedAction<"click">, graph: ObservationGraphV1): Promise<AnyResolvedAction> {
    this.graphs.push(graph);
    return {
      targetKind: "web",
      kind: "click",
      target: { nodeId: action.target.nodeId, selector: `[data-node-id="${action.target.nodeId}"]` },
      graphId: graph.graphId,
    };
  }
}

class AllowingPolicyGate implements RunnerPolicyGate {
  readonly contexts: RunnerPolicyContext[] = [];

  async authorize(_action: AnyResolvedAction, context: RunnerPolicyContext): Promise<PolicyDecision> {
    this.contexts.push(context);
    return { status: "allowed", reason: "acceptance" };
  }
}

class RecordingActionExecutor implements ActionExecutor {
  readonly actions: AnyResolvedAction[] = [];

  async execute(action: AnyResolvedAction, permit: ExecutionPermit): Promise<{ readonly status: "ok" }> {
    permit.assertAuthorizedForDispatch();
    this.actions.push(action);
    return { status: "ok" };
  }
}

class RecordingTraceRecorder implements TraceRecorder {
  readonly events: TraceEvent[] = [];
  private sequence = 0;

  async append(input: TraceEventInput): Promise<TraceEvent> {
    this.sequence += 1;
    const event = {
      protocolVersion: "runner-protocol/v1" as const,
      schemaVersion: "trace-event/v1" as const,
      messageId: `trace-${this.sequence}`,
      idempotencyKey: `trace-${this.sequence}`,
      occurredAt: "2026-08-25T00:00:00.000Z",
      payloadHash: canonicalPayloadHash(input.payload),
      sequenceNumber: this.sequence,
      ...input,
    } as TraceEvent;
    this.events.push(event);
    return event;
  }

  observations(): ObservationGraphV1[] {
    return this.events
      .filter((event) => event.stage === "observation")
      .map((event) => event.payload as ObservationGraphV1);
  }
}

class FakeArtifactStore implements ArtifactStore {
  readonly writes: ArtifactWriteRequest[] = [];

  async write(request: ArtifactWriteRequest): Promise<ArtifactManifest> {
    this.writes.push(request);
    return {
      artifactId: request.artifactId,
      runId: request.runId,
      kind: request.kind,
      mediaType: request.mediaType,
      relativePath: `${request.runId}/${request.name}`,
      sha256: createHash("sha256").update(request.bytes).digest("hex"),
      size: request.bytes.byteLength,
      createdAt: "2026-08-25T00:00:00.000Z",
    };
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

class GraphArtifactSource implements ArtifactSource {
  readonly graphIds: string[] = [];

  async captureArtifacts(graphId: string): Promise<readonly RawArtifact[]> {
    this.graphIds.push(graphId);
    return [
      {
        name: `${graphId}.json`,
        mediaType: "application/json",
        bytes: new TextEncoder().encode(JSON.stringify({ graphId })),
      },
      {
        name: `${graphId}.png`,
        mediaType: "image/png",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
    ];
  }
}

function idFactory(...ids: readonly string[]): () => string {
  const queue = [...ids];
  return () => {
    const id = queue.shift();
    if (id === undefined) {
      throw new Error("id factory exhausted");
    }
    return id;
  };
}

class ProjectedReplayTarget implements ReplayTarget {
  readonly projections: ProjectionRecord[] = [];
  executed = 0;
  private pathname: "/product" | "/cart" = "/product";

  async capture(): Promise<ObservationGraphV1> {
    const projection = projectHistorical({
      assetId: this.pathname === "/product" ? "legacy-product" : "legacy-cart",
      pathname: this.pathname,
      artifactRefs: [this.pathname === "/product" ? "legacy-product-artifact" : "legacy-cart-artifact"],
    });
    this.projections.push(projection);
    return projection.graph;
  }

  async execute(action: ResolvedReplayAction): Promise<void> {
    this.executed += 1;
    if (action.step.intent.kind === "click") {
      this.pathname = "/cart";
    }
  }
}

class UnsupportedMajorTarget implements ReplayTarget {
  executed = 0;

  async capture(): Promise<ObservationGraphV1> {
    return unsupportedWebMajorGraph();
  }

  async execute(): Promise<void> {
    this.executed += 1;
  }
}

class DirectLegacyTarget implements ReplayTarget {
  executed = 0;

  async capture(): Promise<unknown> {
    return { urlPath: "/product", nodes: [ADD_NODE], claims: [] };
  }

  async execute(): Promise<void> {
    this.executed += 1;
  }
}

async function runExploration(graph: ObservationGraphV1, attemptId: string): Promise<{
  readonly result: Awaited<ReturnType<ExplorationController["run"]>>;
  readonly agent: StoppingExplorationAgent;
}> {
  const agent = new StoppingExplorationAgent();
  const controller = new ExplorationController({
    target: new StaticExplorationTarget(graph),
    agent,
    progressStore: new InMemoryProgressStore(),
    clock: { now: () => 0 },
  });
  const result = await controller.run({
    runId: "run-exploration",
    attemptId,
    sourceBindingHash: observationGraphHash(graph),
    policy: explorationPolicy(),
    environment: "test",
  });
  return { result, agent };
}

function explorationPolicy(): ExplorationPolicy {
  return {
    seedSkillBundleIds: [],
    allowedActionKinds: ["navigate", "click", "input"],
    allowedOrigins: [scopeOrigin],
    maximumSteps: 3,
    maximumWallClockMs: 10_000,
    maximumModelTokens: 1_000,
    maximumStateVisits: 3,
    maximumRecoveries: 0,
    riskCeiling: "RecoverableMutation",
  };
}

class StaticExplorationTarget implements ExplorationTarget {
  constructor(private readonly graph: ObservationGraphV1) {}

  async capture(): Promise<ObservationGraphV1> {
    return this.graph;
  }

  async execute(_action: GroundedExplorationAction): Promise<void> {
    throw new Error("stop agent must not execute actions");
  }
}

class StoppingExplorationAgent implements ExplorationAgentPort {
  readonly contexts: ExplorationContext[] = [];

  async nextAction(context: ExplorationContext): Promise<ExplorationProposal> {
    this.contexts.push(context);
    return {
      decision: { status: "stop", reason: "acceptance complete" },
      tokensUsed: 5,
    };
  }
}

class InMemoryProgressStore implements ExplorationProgressStore {
  private readonly progress = new Map<string, ExplorationAttemptProgress>();
  private readonly checkpoints = new Map<string, ExplorationCheckpoint[]>();
  private sequence = 0;

  async loadAttemptProgress(attemptId: string): Promise<ExplorationAttemptProgress | undefined> {
    return this.progress.get(attemptId);
  }

  async initializeAttemptProgress(input: NewExplorationAttemptProgress): Promise<ExplorationAttemptProgress> {
    const existing = this.progress.get(input.attemptId);
    if (existing !== undefined) {
      return existing;
    }
    const created: ExplorationAttemptProgress = {
      ...input,
      version: 1,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.progress.set(input.attemptId, created);
    return created;
  }

  async compareAndSetAttemptProgress(update: ExplorationProgressUpdate): Promise<ExplorationProgressUpdateResult> {
    const current = this.progress.get(update.attemptId);
    if (current === undefined || current.version !== update.expectedVersion) {
      return { status: "conflict", current };
    }
    if (update.checkpoint !== undefined) {
      const existing = this.checkpoints.get(update.attemptId) ?? [];
      this.checkpoints.set(update.attemptId, [...existing, update.checkpoint]);
    }
    const next: ExplorationAttemptProgress = {
      attemptId: current.attemptId,
      runId: current.runId,
      sourceBindingHash: current.sourceBindingHash,
      policyBindingHash: current.policyBindingHash,
      seedBindingHash: current.seedBindingHash,
      phase: update.phase,
      seedCursor: update.seedCursor,
      lastSafeStep: update.lastSafeStep,
      ...(update.lastSafeGraphFingerprint === undefined ? {} : { lastSafeGraphFingerprint: update.lastSafeGraphFingerprint }),
      remaining: update.remaining,
      ...(update.inFlightAction === undefined ? {} : { inFlightAction: update.inFlightAction }),
      ...(update.terminalReason === undefined ? {} : { terminalReason: update.terminalReason }),
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    };
    this.progress.set(update.attemptId, next);
    return { status: "updated", progress: next };
  }

  async liveCheckpointsForAttempt(attemptId: string): Promise<readonly ExplorationCheckpoint[]> {
    return this.checkpoints.get(attemptId) ?? [];
  }

  private now(): string {
    this.sequence += 1;
    return `2026-08-25T00:00:${this.sequence.toString().padStart(2, "0")}.000Z`;
  }
}

class InMemoryBenchmarkStore extends InMemoryProgressStore implements BenchmarkStore {
  private readonly runs = new Map<string, import("@qualigence/sqlite-runtime").BenchmarkRunRecord>();
  private readonly attempts = new Map<string, BenchmarkAttempt[]>();
  private readonly reports = new Map<string, DetectionBenchmarkReport>();

  async saveRun(run: import("@qualigence/sqlite-runtime").BenchmarkRunRecord): Promise<void> {
    this.runs.set(run.runId, run);
  }

  async appendAttempt(runId: string, attempt: import("@qualigence/sqlite-runtime").PersistedAttempt): Promise<void> {
    const existing = this.attempts.get(runId) ?? [];
    this.attempts.set(runId, [...existing, attempt.attempt]);
  }

  async attemptsForRun(runId: string): Promise<readonly BenchmarkAttempt[]> {
    return this.attempts.get(runId) ?? [];
  }

  async saveReport(runId: string, report: DetectionBenchmarkReport): Promise<void> {
    this.reports.set(runId, report);
  }

  async reportForRun(runId: string): Promise<DetectionBenchmarkReport | undefined> {
    return this.reports.get(runId);
  }
}

function scenarioWithRawQueryValues(input: {
  readonly seed: string;
  readonly productSession: string;
  readonly cartSession: string;
}): ScenarioDefinition {
  return {
    scenarioId: "cart-defect",
    mode: "fault",
    seedUrl: `${scopeOrigin}/product?seed=${input.seed}`,
    states: [
      {
        id: "product",
        url: `${scopeOrigin}/product?session=${input.productSession}`,
        title: "Product",
        nodes: [{ id: "advance-cart", role: "link", name: "Cart", confidence: 1 }],
        advanceNodeId: "advance-cart",
        signals: [],
      },
      {
        id: "cart",
        url: `${scopeOrigin}/cart?session=${input.cartSession}`,
        title: "Cart",
        nodes: [{ id: "bug-cart-total", role: "text", text: "incorrect total", confidence: 1 }],
        advanceNodeId: null,
        signals: [{ defectId: "bug-cart-total", confidence: "high" }],
      },
    ],
  };
}

function runBenchmarkScenario(scenario: ScenarioDefinition) {
  return runBenchmark({
    manifest,
    groundTruth,
    scenarios: [scenario],
    store: new InMemoryBenchmarkStore(),
    agentFactory: createScenarioWalkTestDoubleAgentFactory(),
    createdAt: "2026-08-25T00:00:00.000Z",
  });
}
