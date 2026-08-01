import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AcceptedExecutionJob, ExecutionEventBatch, TraceEvent } from "@qualigence/runner-protocol";
import type { GrpcRunnerProtocolClient, GrpcRunnerProtocolServer } from "@qualigence/grpc-runner-protocol";
import { createGrpcTestPki } from "../../helpers/grpc-test-pki.js";
import type { GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import { makeHello, makeTestClient, startTestServer } from "../../helpers/grpc-harness.js";

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
    payload: { graphId: `graph-${sequenceNumber}`, nodes: [] },
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

    const session = await client.connect(makeHello("runner-1"));
    const connection = await server.waitForConnection("runner-1");

    const job: AcceptedExecutionJob = {
      jobId: "job-1",
      runId: "run-attempt-1",
      target: { kind: "web", url: "https://example.test/" },
      objective: "add the item to the cart",
    };
    const leasePromise = connection.offer(job, ["target:web-playwright"]);

    const offer = await session.nextOffer(new AbortController().signal);
    expect(offer.job.jobId).toBe("job-1");
    expect(offer.requiredCapabilities).toEqual(["target:web-playwright"]);

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
    expect(session2.welcome.sessionId).not.toBe(session1.welcome.sessionId);

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
});
