import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ExecutionCompletion,
  ExecutionEventBatch,
  ExecutionJobLease,
  ExecutionJobOffer,
  ObservationGraph,
  TraceEvent,
} from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import type { RunnerSpool } from "@qualigence/runner-spool";
import {
  PlaywrightWebTargetAdapter,
  type PlaywrightWebTargetOptions,
} from "@qualigence/web-playwright";
import type {
  SensitiveEvidenceDiagnosticReason,
} from "@qualigence/web-playwright/internal";
import { RunnerOfferRuntime } from "../../../apps/runner/src/offer-runtime.js";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";

describe("RunnerOfferRuntime production valueRef path", () => {
  let fixture: FixtureServer | undefined;
  let modelServer: Server | undefined;

  afterEach(async () => {
    await fixture?.close();
    if (modelServer !== undefined) {
      modelServer.closeAllConnections();
      modelServer.close();
      await once(modelServer, "close");
    }
  });

  it("releases normal input evidence without poisoning an integrity check", async () => {
    fixture = await startFixtureServer({
      "/": htmlDocument(`
        <label>Email <input aria-label="Email" /></label>
        <p data-qualigence-observe id="status">Waiting</p>
        <p data-qualigence-observe id="reflection"></p>
        <p data-qualigence-observe id="delayed-reflection"></p>
        <script>
          document.querySelector('input').addEventListener('input', (event) => {
            document.getElementById('status').textContent = 'ready';
            document.getElementById('reflection').textContent = event.target.value;
            setTimeout(() => {
              document.getElementById('delayed-reflection').textContent = 'reflected:' + event.target.value;
            }, 50);
          });
        </script>
      `, "Runtime valueRef"),
    });
    modelServer = createServer(async (request, response) => {
      const body = JSON.parse(await readBody(request)) as {
        readonly messages: readonly { readonly content: string }[];
        readonly response_format: { readonly json_schema: { readonly name: string } };
      };
      const operation = body.response_format.json_schema.name;
      const payload = operation === "execution_verification"
        ? { status: "passed", summary: "input completed", claims: [] }
        : decision(body.messages.at(-1)?.content ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "chatcmpl-component",
        model: "component-model",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload) } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }));
    });
    modelServer.listen(0, "127.0.0.1");
    await once(modelServer, "listening");
    const modelAddress = modelServer.address();
    if (modelAddress === null || typeof modelAddress === "string") throw new Error("Expected model listener.");

    const diagnostics: SensitiveEvidenceDiagnosticReason[] = [];
    const completions: ExecutionCompletion[] = [];
    const spool = new MemoryRunnerSpool();
    const session: RunnerSession = {
      welcome: {
        sessionId: "session-component",
        resumeToken: "resume-component",
        selectedProtocolMajor: 1,
        serverVersion: "test",
        heartbeatIntervalMs: 10_000,
        leaseDurationMs: 60_000,
        traceBatchMaximumEvents: 100,
        traceBatchMaximumBytes: 1_000_000,
        maximumInFlightBatches: 1,
        maximumPendingWriteBytes: 1_000_000,
      },
      nextOffer: async () => { throw new Error("Unexpected nextOffer"); },
      accept: async (): Promise<ExecutionJobLease> => ({
        jobId: "job-input",
        runId: "run-input",
        leaseToken: "lease-input",
        leaseEpoch: 1,
        expiresAt: "2099-08-22T00:00:00.000Z",
      }),
      renew: async () => { throw new Error("Unexpected lease renewal"); },
      submit: async (batch: ExecutionEventBatch) => ({
        batchId: batch.batchId,
        runId: batch.runId,
        nextExpectedSequenceNumber: batch.firstSequenceNumber + batch.events.length,
      }),
      complete: async (_lease, completion) => { completions.push(completion); },
      close: async () => undefined,
    };
    const runtime = new RunnerOfferRuntime({
      session,
      spool,
      valueProvider: { resolve: async () => "a\r\nb\r\n" },
      config: {
        runnerId: "runner-component",
        coreAddress: "unused",
        authority: "unused",
        tls: { ca: Buffer.alloc(0), cert: Buffer.alloc(0), key: Buffer.alloc(0) },
        dataDir: "unused",
        headed: false,
        navigationTimeoutMs: 15_000,
        actionTimeoutMs: 10_000,
        model: {
          baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
          apiKey: "component-key",
          modelName: "component-model",
          maximumTokensPerCall: 100,
        },
      },
      createTarget: (options: PlaywrightWebTargetOptions) => {
        const adapter = new PlaywrightWebTargetAdapter(options, undefined, {
          onSensitiveEvidenceDiagnostic: (reason) => diagnostics.push(reason),
        });
        const capture = adapter.capture.bind(adapter);
        adapter.capture = async (job) => {
          const graph = await capture(job);
          await adapter.captureArtifacts(graph.graphId);
          return graph;
        };
        return adapter;
      },
    });

    const failure = await runtime.run(offer(fixture.url, fixture.origin)).catch((error: unknown) => error);
    expect(diagnostics).toEqual([]);
    expect(failure).toBeUndefined();
    expect(completions).toEqual([{ jobId: "job-input", runId: "run-input", status: "passed" }]);
  }, 30_000);
});

class MemoryRunnerSpool implements RunnerSpool {
  private events: TraceEvent[] = [];

  async append(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }

  async pending(runId: string, fromSequence: number): Promise<readonly TraceEvent[]> {
    return this.events.filter((event) => event.runId === runId && event.sequenceNumber >= fromSequence);
  }

  async acknowledge(runId: string, nextExpectedSequenceNumber: number): Promise<void> {
    this.events = this.events.filter((event) =>
      event.runId !== runId || event.sequenceNumber >= nextExpectedSequenceNumber);
  }

  async usage(): Promise<{ readonly bytes: number; readonly events: number }> {
    return { bytes: 0, events: this.events.length };
  }
}

function offer(url: string, origin: string): ExecutionJobOffer {
  return {
    offerId: "offer-input",
    job: {
      jobId: "job-input",
      runId: "run-input",
      projectId: "project-component",
      target: { kind: "web", url },
      objective: "Enter the Plan-owned value",
      policy: {
        policyId: "policy-input",
        environment: "isolated_test",
        allowedOrigins: [origin],
        allowedActionKinds: ["input"],
        maximumRisk: "ExternalSideEffect",
        explorationAllowed: false,
        issuedAt: "2026-08-22T00:00:00.000Z",
        expiresAt: "2099-08-22T00:00:00.000Z",
      },
      plan: {
        missionId: "mission-component",
        missionRevision: 1,
        testCaseId: "case-input",
        steps: [{
          stepIndex: 0,
          kind: "input",
          target: { role: "textbox", name: "Email", purpose: "enter email" },
          valueRef: "profile.email",
        }],
        expectedClaimIds: ["claim-input"],
        budget: { maximumStepsPerJob: 1, maximumWallClockMs: 20_000, maximumModelTokens: 100 },
      },
    },
    requiredCapabilities: ["action:input"],
    leaseDurationMs: 60_000,
  };
}

function decision(content: string): { readonly nodeId: string; readonly reason: string } {
  const prompt = JSON.parse(content) as { readonly observation: ObservationGraph };
  const node = prompt.observation.nodes.find((candidate) =>
    candidate.role === "textbox" && candidate.name === "Email");
  if (node === undefined) throw new Error("Expected model-visible input.");
  return { nodeId: node.id, reason: "ground input" };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
