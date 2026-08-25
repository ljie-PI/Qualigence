import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  OBSERVATION_GRAPH_V1_CAPABILITY,
  OBSERVATION_GRAPH_V1_CAPABILITY_TOKEN,
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_TYPE,
  WEB_OBSERVATION_EXTENSION_V1_CAPABILITY,
  WEB_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN,
  type AcceptedExecutionJob,
  type ExecutionEventBatch,
  type TraceEvent,
} from "@qualigence/runner-protocol";
import { GrpcRunnerProtocolClient } from "@qualigence/grpc-runner-protocol";
import type { GrpcRunnerProtocolServer } from "@qualigence/grpc-runner-protocol";
import { createGrpcTestPki } from "../../helpers/grpc-test-pki.js";
import type { GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import { eventBatchToWire, helloToWire } from "@qualigence/grpc-runner-protocol";
import { makeHello, makeRawTestStream, makeTestClient, startTestServer } from "../../helpers/grpc-harness.js";

let pki: GrpcTestPki;

beforeAll(() => {
  pki = createGrpcTestPki();
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(server: GrpcRunnerProtocolServer, client: GrpcRunnerProtocolClient): void {
  cleanups.push(async () => {
    await client.close();
    await server.shutdown();
  });
}

function traceEvent(runId: string, sequenceNumber: number): TraceEvent {
  return {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `${runId}:${sequenceNumber}`,
    idempotencyKey: `${runId}:${sequenceNumber}`,
    runId,
    sequenceNumber,
    stage: "observation",
    occurredAt: "2026-08-01T00:00:00.000Z",
    payloadHash: `${sequenceNumber}`.padStart(64, "0"),
    payload: {
      schema: OBSERVATION_GRAPH_V1_SCHEMA,
      graphId: `graph-${sequenceNumber}`,
      target: { kind: "web", targetId: "https://example.test" },
      capturedAt: "2026-08-01T00:00:00.000Z",
      rootNodeIds: ["node-1"],
      nodes: [
        {
          id: "node-1",
          role: "document",
          state: {},
          relations: [],
          source: { adapterId: "web-playwright", sourceKind: "document" },
          confidence: 1,
          sensitivity: "public",
          extensions: {},
          evidenceRefs: [],
        },
      ],
      evidenceRefs: [],
      extensions: {
        [WEB_EXTENSION_V1_TYPE]: {
          type: WEB_EXTENSION_V1_TYPE,
          version: "1.0",
          payload: {
            origin: "https://example.test",
            pathname: "/",
            title: "Example",
            viewport: { width: 1024, height: 768, devicePixelRatio: 1 },
            query: {},
          },
        },
      },
    } as never,
  };
}

function webV1Requirements(): readonly string[] {
  return [
    "target:web-playwright",
    OBSERVATION_GRAPH_V1_CAPABILITY_TOKEN,
    WEB_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN,
  ];
}

function makeWebV1Hello(runnerId: string, options?: Parameters<typeof makeHello>[1]): ReturnType<typeof makeHello> {
  const hello = makeHello(runnerId, options);
  return {
    ...hello,
    capabilities: {
      ...hello.capabilities,
      observationExtensions: [
        OBSERVATION_GRAPH_V1_CAPABILITY,
        WEB_OBSERVATION_EXTENSION_V1_CAPABILITY,
      ],
    },
  };
}

function batch(runId: string, firstSequenceNumber: number, count: number): ExecutionEventBatch {
  const events: TraceEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    events.push(traceEvent(runId, firstSequenceNumber + index));
  }
  return { batchId: `batch-${firstSequenceNumber}`, runId, firstSequenceNumber, events };
}

describe("grpc runner protocol handshake", () => {
  it("binds IPv6 loopback with a bracketed transport address", async () => {
    const { server, port } = await startTestServer(pki, { host: "::1", port: 0 });
    const cert = pki.clientFor("runner-1");
    const client = new GrpcRunnerProtocolClient({
      address: `[::1]:${port}`,
      tls: { ca: pki.ca, key: cert.key, cert: cert.cert },
      authority: "localhost",
    });
    track(server, client);
    await expect(client.connect(makeHello("runner-1"))).resolves.toMatchObject({ welcome: { selectedProtocolMajor: 1 } });
  });

  it("round-trips RunnerHello -> RunnerWelcome over a real mutual-TLS connection", async () => {
    const { server, port } = await startTestServer(pki);
    const client = makeTestClient(pki, port, pki.clientFor("runner-1"));
    track(server, client);

    const session = await client.connect(makeHello("runner-1"));

    expect(session.welcome.selectedProtocolMajor).toBe(1);
    expect(session.welcome.serverVersion).toBe("0.1.0");
    expect(session.welcome.sessionId).toBeTruthy();
    expect(session.welcome.resumeToken).toBeTruthy();
    expect(session.welcome.traceBatchMaximumEvents).toBe(128);
  });

  it("rejects an unshared protocol major with ProtocolVersionMismatch", async () => {
    const { server, port } = await startTestServer(pki);
    const client = makeTestClient(pki, port, pki.clientFor("runner-1"));
    track(server, client);

    await expect(
      client.connect(makeHello("runner-1", { supportedProtocolMajors: [2] })),
    ).rejects.toMatchObject({ code: "ProtocolVersionMismatch" });
  });

  it("delivers an offer, issues a lease on accept and acknowledges trace batches", async () => {
    const { server, port } = await startTestServer(pki);
    const client = makeTestClient(pki, port, pki.clientFor("runner-1"));
    track(server, client);

    const session = await client.connect(makeWebV1Hello("runner-1"));
    const connection = await server.waitForConnection("runner-1");

    const job: AcceptedExecutionJob = {
      jobId: "job-1",
      runId: "run-attempt-1",
      projectId: "project-1",
      target: { kind: "web", url: "https://example.test/" },
      objective: "add the item to the cart",
      policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
    };
    const leasePromise = connection.offer(job, webV1Requirements());

    const offer = await session.nextOffer(new AbortController().signal);
    expect(offer.job.jobId).toBe("job-1");
    expect(offer.job.projectId).toBe("project-1");
    expect(offer.requiredCapabilities).toEqual(webV1Requirements());

    const clientLease = await session.accept(offer.offerId);
    const serverLease = await leasePromise;
    expect(clientLease.jobId).toBe("job-1");
    expect(clientLease.runId).toBe("run-attempt-1");
    expect(serverLease.leaseToken).toBe(clientLease.leaseToken);

    const ack = await session.submit(batch("run-attempt-1", 1, 2));
    expect(ack.nextExpectedSequenceNumber).toBe(3);
  });

  it("reconnects after a dropped connection and resumes the trace cursor via the resume token", async () => {
    const { server, port } = await startTestServer(pki);
    const cert = pki.clientFor("runner-1");
    const client1 = makeTestClient(pki, port, cert);

    const session1 = await client1.connect(makeHello("runner-1"));
    const rotatedResumeToken = session1.welcome.resumeToken;
    const ack1 = await session1.submit(batch("run-attempt-1", 1, 2));
    expect(ack1.nextExpectedSequenceNumber).toBe(3);

    // Simulate a dropped connection: the runner loses its transport entirely.
    await client1.close();

    const client2 = makeTestClient(pki, port, cert);
    const server2Cleanup = async (): Promise<void> => {
      await client2.close();
      await server.shutdown();
    };
    cleanups.push(server2Cleanup);

    const session2 = await client2.connect(
      makeHello("runner-1", { resumeToken: rotatedResumeToken }),
    );
    // A fresh, single-use resume token is issued on every successful handshake.
    expect(session2.welcome.resumeToken).not.toBe(rotatedResumeToken);
    expect(session2.welcome.sessionId).toBe(session1.welcome.sessionId);

    // The trace cursor survives the reconnect: uploads continue from sequence 3.
    const ack2 = await session2.submit(batch("run-attempt-1", 3, 1));
    expect(ack2.nextExpectedSequenceNumber).toBe(4);
  });

  it("rejects a consumed or unknown resume token", async () => {
    const { server, port } = await startTestServer(pki);
    const cert = pki.clientFor("runner-1");
    const client1 = makeTestClient(pki, port, cert);
    const session1 = await client1.connect(makeHello("runner-1"));
    const consumed = session1.welcome.resumeToken;
    await client1.close();

    const client2 = makeTestClient(pki, port, cert);
    const session2 = await client2.connect(makeHello("runner-1", { resumeToken: consumed }));
    await client2.close();
    expect(session2.welcome.resumeToken).toBeTruthy();

    // The token from session1 was rotated/consumed by session2's handshake.
    const client3 = makeTestClient(pki, port, cert);
    cleanups.push(async () => {
      await client3.close();
      await server.shutdown();
    });
    await expect(
      client3.connect(makeHello("runner-1", { resumeToken: consumed })),
    ).rejects.toMatchObject({ code: "ResumeRejected" });
  });

  it("blocks the producer at the negotiated in-flight batch limit without dropping a batch", async () => {
    const { server, port } = await startTestServer(pki, {
      welcome: {
        serverVersion: "0.1.0",
        heartbeatIntervalMs: 5_000,
        leaseDurationMs: 30_000,
        traceBatchMaximumEvents: 128,
        traceBatchMaximumBytes: 262_144,
        maximumInFlightBatches: 1,
        maximumPendingWriteBytes: 1_048_576,
      },
    });
    const client = makeTestClient(pki, port, pki.clientFor("runner-1"));
    track(server, client);

    const session = await client.connect(makeHello("runner-1"));

    // With one in-flight slot, two concurrent submits must both be acknowledged;
    // the second is admitted only after the first drains, never dropped.
    const [ackA, ackB] = await Promise.all([
      session.submit(batch("run-attempt-1", 1, 1)),
      session.submit(batch("run-attempt-1", 2, 1)),
    ]);
    expect(new Set([ackA.nextExpectedSequenceNumber, ackB.nextExpectedSequenceNumber])).toEqual(
      new Set([2, 3]),
    );
  });

  it("shares one waiter for a duplicate client correlation id", async () => {
    const { server, port } = await startTestServer(pki);
    const cert = pki.clientFor("runner-1");
    const client = new GrpcRunnerProtocolClient({
      address: `127.0.0.1:${port}`,
      tls: { ca: pki.ca, key: cert.key, cert: cert.cert },
      authority: "localhost",
      generateId: () => "duplicate-correlation",
    });
    track(server, client);

    const session = await client.connect(makeWebV1Hello("runner-1"));
    const connection = await server.waitForConnection("runner-1");
    const job: AcceptedExecutionJob = {
      jobId: "job-1",
      runId: "run-attempt-1",
      projectId: "project-1",
      target: { kind: "web", url: "https://example.test/" },
      objective: "add the item to the cart",
      policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
    };
    const leasePromise = connection.offer(job, webV1Requirements());
    const offer = await session.nextOffer(new AbortController().signal);
    const lease = await session.accept(offer.offerId);
    await leasePromise;

    const first = session.renew(lease);
    const second = session.renew(lease);
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ jobId: "job-1", runId: "run-attempt-1" });
  });

  it("rejects a concurrent Hello for the same runner and keeps the first admission", async () => {
    const { server, port } = await startTestServer(pki);
    const cert = pki.clientFor("runner-1");
    const client1 = makeTestClient(pki, port, cert);
    const client2 = makeTestClient(pki, port, cert);
    cleanups.push(async () => {
      await client1.close();
      await client2.close();
      await server.shutdown();
    });

    const first = client1.connect(makeHello("runner-1"));
    const second = client2.connect(makeHello("runner-1"));
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "RunnerAlreadyConnected",
    });
    expect(server.connection("runner-1")).toBeDefined();
  });

  it("fails stop a handshake mailbox that exceeds the pending-frame limit", async () => {
    let releaseWelcome!: () => void;
    const beforeWelcome = new Promise<void>((resolve) => {
      releaseWelcome = resolve;
    });
    const { server, port } = await startTestServer(pki, {
      maximumHandshakePendingFrames: 1,
      beforeWelcome: () => beforeWelcome,
    });
    const raw = makeRawTestStream(pki, port, pki.clientFor("runner-1"));
    let streamError: unknown;
    raw.stream.on("error", (error: unknown) => {
      streamError = error;
    });
    cleanups.push(async () => {
      releaseWelcome();
      raw.close();
      await server.shutdown();
    });
    raw.stream.write({ correlation_id: "hello", hello: helloToWire(makeHello("runner-1")) });
    raw.stream.write({ correlation_id: "batch-1", event_batch: eventBatchToWire(batch("run-1", 1, 1)) });
    raw.stream.write({ correlation_id: "batch-2", event_batch: eventBatchToWire(batch("run-1", 2, 1)) });
    await expect.poll(() => streamError).toMatchObject({ details: "ProtocolViolation" });
    releaseWelcome();
    expect(server.connection("runner-1")).toBeUndefined();
  });

  it("ignores a frame after the connection generation increments", async () => {
    let enteredHandle = 0;
    let releaseHandle!: () => void;
    const beforeHandleFrame = new Promise<void>((resolve) => {
      releaseHandle = resolve;
    });
    const { server, port } = await startTestServer(pki, {
      beforeHandleFrame: async () => {
        enteredHandle += 1;
        await beforeHandleFrame;
      },
    });
    const cert = pki.clientFor("runner-1");
    const client1 = makeTestClient(pki, port, cert);
    const session1 = await client1.connect(makeHello("runner-1"));
    expect(server.connectionGeneration("runner-1")).toBe(1);
    const staleSubmit = session1.submit(batch("run-1", 1, 5));
    staleSubmit.catch(() => undefined);
    await expect.poll(() => enteredHandle).toBe(1);

    const client2 = makeTestClient(pki, port, cert);
    cleanups.push(async () => {
      releaseHandle();
      await client1.close();
      await client2.close();
      await server.shutdown();
    });
    const session2 = await client2.connect(
      makeHello("runner-1", { resumeToken: session1.welcome.resumeToken }),
    );
    expect(server.connectionGeneration("runner-1")).toBe(2);
    const superseded = server.supersededConnection("runner-1");
    expect(superseded?.generation).toBe(1);

    releaseHandle();
    await superseded?.drain();
    expect(server.nextExpectedSequence("run-1")).toBe(1);

    const ack = await session2.submit(batch("run-1", 1, 1));
    expect(ack.nextExpectedSequenceNumber).toBe(2);
  });

  it("fails stop a live connection mailbox that exceeds the pending-frame limit", async () => {
    let enteredHandle = 0;
    let releaseHandle!: () => void;
    const beforeHandleFrame = new Promise<void>((resolve) => {
      releaseHandle = resolve;
    });
    const { server, port } = await startTestServer(pki, {
      maximumConnectionPendingFrames: 1,
      beforeHandleFrame: async () => {
        enteredHandle += 1;
        await beforeHandleFrame;
      },
    });
    const raw = makeRawTestStream(pki, port, pki.clientFor("runner-1"));
    let streamError: unknown;
    raw.stream.on("error", (error: unknown) => {
      streamError = error;
    });
    cleanups.push(async () => {
      releaseHandle();
      raw.close();
      await server.shutdown();
    });
    raw.stream.write({ correlation_id: "hello", hello: helloToWire(makeHello("runner-1")) });
    await expect.poll(() => server.connection("runner-1")).toBeDefined();
    raw.stream.write({ correlation_id: "batch-1", event_batch: eventBatchToWire(batch("run-1", 1, 1)) });
    await expect.poll(() => enteredHandle).toBe(1);
    raw.stream.write({ correlation_id: "batch-2", event_batch: eventBatchToWire(batch("run-1", 2, 1)) });
    await expect.poll(() => streamError).toMatchObject({ details: "ProtocolViolation" });
    releaseHandle();
  });

  it("shares one shutdown promise and fails closed in-flight Trace and completion", async () => {
    let enteredHandle = 0;
    let releaseHandle!: () => void;
    const beforeHandleFrame = new Promise<void>((resolve) => {
      releaseHandle = resolve;
    });
    const { server, port } = await startTestServer(pki, {
      beforeHandleFrame: async () => {
        enteredHandle += 1;
        await beforeHandleFrame;
      },
    });
    const waiting = server.waitForConnection("never-connects");
    const client = makeTestClient(pki, port, pki.clientFor("runner-1"));
    cleanups.push(async () => {
      releaseHandle();
      await client.close();
      await server.shutdown();
    });
    const session = await client.connect(makeWebV1Hello("runner-1"));
    const connection = await server.waitForConnection("runner-1");
    const offering = connection.offer({
       jobId: "job-race",
       runId: "run-race",
       projectId: "project-1",
       target: { kind: "web", url: "https://example.test/" },
       objective: "race shutdown",
       policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
    }, webV1Requirements());
    const submitting = session.submit(batch("run-1", 1, 1));
    void session.complete(
      {
        jobId: "job-race",
        runId: "run-complete",
        leaseToken: "token",
        leaseEpoch: 1,
        expiresAt: "2026-08-17T00:00:30.000Z",
      },
      { jobId: "job-race", runId: "run-complete", status: "passed" },
    );
    await expect.poll(() => enteredHandle).toBe(1);

    const first = server.shutdown();
    const second = server.shutdown();
    expect(second).toBe(first);
    await expect(waiting).rejects.toMatchObject({ code: "SessionClosed" });
    await expect(offering).rejects.toMatchObject({ code: "SessionClosed" });
    releaseHandle();
    await expect(submitting).rejects.toMatchObject({ code: "SessionClosed" });
    await first;
    expect(server.nextExpectedSequence("run-1")).toBe(1);
    await expect(server.waitForConnection("runner-late")).rejects.toMatchObject({
      code: "SessionClosed",
    });
    await expect(session.submit(batch("run-1", 2, 1))).rejects.toMatchObject({ code: "SessionClosed" });
  });
});
