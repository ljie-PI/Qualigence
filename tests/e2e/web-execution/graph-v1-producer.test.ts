import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WEB_EXTENSION_V1_REDACTION_MARKER,
  WEB_EXTENSION_V1_TYPE,
  WEB_OBSERVATION_V1_CAPABILITY_TOKENS,
  canonicalTraceEventHash,
  requireGraphExtensionMajor,
  validateObservationGraphV1,
  type AcceptedExecutionJob,
  type ExecutionEventBatch,
  type TraceEventHashInput,
} from "@qualigence/runner-protocol";
import { PlaywrightWebTargetAdapter, WebTargetError } from "@qualigence/web-playwright";
import { eventBatchFromWire, eventBatchToWire, offerToWire } from "@qualigence/grpc-runner-protocol";
import { RunnerOfferRuntime } from "../../../apps/runner/src/offer-runtime.js";
import type { RunnerConfig } from "../../../apps/runner/src/config.js";

let server: Server | undefined;
let adapter: PlaywrightWebTargetAdapter | undefined;

afterEach(async () => {
  await adapter?.close();
  adapter = undefined;
  if (server !== undefined) {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    server = undefined;
  }
});

describe("Graph v1 production Web producer acceptance", () => {
  it("captures real Chromium output as validated Graph v1/web-v1 and transports it losslessly", async () => {
    const origin = await startPage();
    adapter = new PlaywrightWebTargetAdapter({
      url: `${origin}/checkout?token=secret&ref=campaign#fragment`,
      expectedOrigin: origin,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      allowedOrigins: [origin],
      allowedWebQueryKeys: ["ref"],
    });
    try {
      await adapter.start();
    } catch (error) {
      if (error instanceof WebTargetError && error.code === "BrowserLaunchFailed") {
        throw new Error("ChromiumUnavailable", { cause: error });
      }
      throw error;
    }

    const graph = await adapter.capture(job(origin));
    expect(() => validateObservationGraphV1(graph, { allowedWebQueryKeys: ["ref"] })).not.toThrow();
    expect(() => requireGraphExtensionMajor(graph, "web", 1)).not.toThrow();
    expect(graph.schema).toEqual({ epoch: "v1", version: "observation-graph/v1" });
    expect(graph.target).toEqual({ kind: "web", targetId: origin });
    expect(graph.rootNodeIds.length).toBeGreaterThan(0);
    expect(graph.nodes.length).toBeGreaterThan(1);
    expect(graph.nodes.every((node) => node.source.adapterId === "web-playwright")).toBe(true);

    const web = graph.extensions?.[WEB_EXTENSION_V1_TYPE]?.payload;
    expect(web).toMatchObject({
      origin,
      pathname: "/checkout",
      query: { ref: WEB_EXTENSION_V1_REDACTION_MARKER },
    });
    expect(JSON.stringify(graph)).not.toContain("secret");
    expect(JSON.stringify(graph)).not.toContain("fragment");

    const hashInput: TraceEventHashInput = {
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      messageId: "message-1",
      idempotencyKey: "idem-1",
      runId: "run-graph-v1",
      sequenceNumber: 1,
      stage: "observation",
      occurredAt: "2026-08-24T00:00:00.000Z",
      payload: graph,
    };
    const batch: ExecutionEventBatch = {
      batchId: "batch-1",
      runId: "run-graph-v1",
      firstSequenceNumber: 1,
      events: [{ ...hashInput, payloadHash: canonicalTraceEventHash(hashInput) }],
    };
    const roundTrip = eventBatchFromWire(eventBatchToWire(batch));
    expect(roundTrip.events[0]).toEqual(batch.events[0]);
  }, 60_000);

  it("rejects missing or incompatible Graph/web capability requirements before accepting a lease", async () => {
    const validOffer = offer("https://example.test/", ["target:web-playwright", ...WEB_OBSERVATION_V1_CAPABILITY_TOKENS]);
    expect(() => offerToWire(validOffer)).not.toThrow();
    expect(() => offerToWire(offer("https://example.test/", ["target:web-playwright"]))).toThrow(/Observation Graph v1 and web\/v1/);
    expect(() => offerToWire(offer("https://example.test/", ["target:web-playwright", "observation:observation-graph/v2", "observation:web/v2"]))).toThrow(/Observation Graph v1 and web\/v1/);

    const accept = vi.fn();
    const createTarget = vi.fn();
    const runtime = new RunnerOfferRuntime({
      session: {
        accept,
        renew: vi.fn(),
        complete: vi.fn(),
        submit: vi.fn(),
        close: vi.fn(),
        welcome: {
          sessionId: "session-1",
          resumeToken: "resume-1",
          selectedProtocolMajor: 1,
          serverVersion: "test",
          heartbeatIntervalMs: 1_000,
          leaseDurationMs: 30_000,
          traceBatchMaximumEvents: 10,
          traceBatchMaximumBytes: 1_000_000,
          maximumInFlightBatches: 1,
          maximumPendingWriteBytes: 1_000_000,
        },
      },
      spool: {} as never,
      config: runnerConfig(),
      createTarget: createTarget as never,
    });

    await expect(runtime.run(offer("https://example.test/", ["target:web-playwright"]))).rejects.toMatchObject({
      code: "CapabilityMismatch",
    });
    expect(accept).not.toHaveBeenCalled();
    expect(createTarget).not.toHaveBeenCalled();
  });
});

async function startPage(): Promise<string> {
  server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
      <html>
        <head><title>Graph producer checkout</title></head>
        <body>
          <main>
            <h1>Checkout</h1>
            <button type="button">Add to cart</button>
            <label>Email <input aria-label="Email" value="private@example.test" /></label>
          </main>
        </body>
      </html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `http://127.0.0.1:${address.port}`;
}

function job(origin: string): AcceptedExecutionJob {
  return {
    jobId: "job-graph-v1",
    runId: "run-graph-v1",
    projectId: "project-test",
    target: { kind: "web", url: `${origin}/checkout?token=secret&ref=campaign#fragment` },
    objective: "capture graph v1",
    policy: {
      policyId: "policy-1",
      environment: "isolated_test",
      allowedOrigins: [origin],
      allowedActionKinds: ["click"],
      maximumRisk: "Normal",
      explorationAllowed: false,
      issuedAt: "2026-08-24T00:00:00.000Z",
      expiresAt: "2026-08-24T00:01:00.000Z",
    },
  };
}

function offer(url: string, requiredCapabilities: readonly string[]) {
  return {
    offerId: "offer-graph-v1",
    job: job(new URL(url).origin),
    requiredCapabilities,
    leaseDurationMs: 30_000,
  };
}

function runnerConfig(): RunnerConfig {
  return {
    runnerId: "runner-1",
    coreAddress: "127.0.0.1:0",
    authority: "localhost",
    tls: { ca: Buffer.alloc(0), cert: Buffer.alloc(0), key: Buffer.alloc(0) },
    dataDir: ".",
    model: { baseUrl: "http://127.0.0.1:1", apiKey: "unused", modelName: "unused", maximumTokensPerCall: 128 },
    headed: false,
    navigationTimeoutMs: 15_000,
    actionTimeoutMs: 10_000,
  };
}
