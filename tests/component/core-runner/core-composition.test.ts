import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalTraceEventHash } from "@qualigence/runner-protocol";
import type { ExecutionEventBatch, TraceEvent } from "@qualigence/runner-protocol";
import { startCoreDaemon } from "@qualigence/core-daemon";
import { createGrpcTestPki } from "../../helpers/grpc-test-pki.js";
import type { GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import { makeHello, makeTestClient } from "../../helpers/grpc-harness.js";
import { WEB_TARGET_TOKEN, webJob } from "../../helpers/core-runner-harness.js";

let pki: GrpcTestPki;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  pki = createGrpcTestPki();
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function event(runId: string, graphId = "graph-1"): TraceEvent {
  const input = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `${runId}:1`,
    idempotencyKey: `${runId}:1`,
    runId,
    sequenceNumber: 1,
    stage: "observation",
    occurredAt: "2026-08-17T00:00:00.000Z",
    payload: { graphId, nodes: [] },
  } as const;
  return { ...input, payloadHash: canonicalTraceEventHash(input) } as TraceEvent;
}

function batch(trace: TraceEvent): ExecutionEventBatch {
  return {
    batchId: `batch-${trace.payloadHash}`,
    runId: trace.runId,
    firstSequenceNumber: trace.sequenceNumber,
    events: [trace],
  };
}

describe("Core runner protocol production composition", () => {
  it("persists trace before ACK and owns renew and completion behind gRPC", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-composition-"));
    const daemon = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const client = makeTestClient(pki, daemon.port, pki.clientFor("runner-1"));
    cleanups.push(async () => {
      await client.close();
      await daemon.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    });

    const session = await client.connect(makeHello("runner-1"));
    const connection = await daemon.server.waitForConnection("runner-1");
    const job = webJob();
    const leasePromise = connection.offer(job, [WEB_TARGET_TOKEN]);
    const replayLeasePromise = connection.offer(job, [WEB_TARGET_TOKEN]);
    await expect(
      connection.offer({ ...job, objective: "different objective" }, [WEB_TARGET_TOKEN]),
    ).rejects.toMatchObject({ code: "RunIdentityMismatch" });
    const offer = await session.nextOffer(new AbortController().signal);
    const lease = await session.accept(offer.offerId);
    await expect(Promise.all([leasePromise, replayLeasePromise])).resolves.toEqual([lease, lease]);

    const original = event(job.runId);
    const ack = await session.submit(batch(original));
    expect(await daemon.traceStore.eventAt(job.runId, 1)).toEqual(original);
    expect(ack.nextExpectedSequenceNumber).toBe(2);
    expect((await session.submit(batch(original))).nextExpectedSequenceNumber).toBe(2);

    const renewed = await session.renew(lease);
    const completion = { jobId: job.jobId, runId: job.runId, status: "passed" } as const;
    await session.complete(renewed, completion);
    await expect.poll(() => daemon.application.jobs.completionOf(job.runId)).toEqual(completion);

    await expect(session.renew({ ...renewed, leaseToken: "wrong" })).rejects.toMatchObject({
      code: "LeaseLost",
    });
  });

  it("isolates a same-sequence different-hash session and closes database then port", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-composition-"));
    const daemon = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const client = makeTestClient(pki, daemon.port, pki.clientFor("runner-1"));
    const session = await client.connect(makeHello("runner-1"));
    const connection = await daemon.server.waitForConnection("runner-1");
    const job = webJob();
    const leasePromise = connection.offer(job, [WEB_TARGET_TOKEN]);
    const offer = await session.nextOffer(new AbortController().signal);
    await session.accept(offer.offerId);
    await leasePromise;
    await session.submit(batch(event(job.runId)));

    await expect(session.submit(batch(event(job.runId, "tampered")))).rejects.toMatchObject({
      code: "TraceIntegrityViolation",
    });
    await client.close();
    await daemon.shutdown();
    await expect(daemon.traceStore.eventAt(job.runId, 1)).rejects.toMatchObject({
      code: "StorageClosed",
    });

    const probe = makeTestClient(pki, daemon.port, pki.clientFor("runner-1"));
    await expect(probe.connect(makeHello("runner-1"))).rejects.toMatchObject({
      code: expect.stringMatching(/TransportError|TlsPeerRejected/),
    });
    await probe.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("recreates an unaccepted offer after Core restart without stranding ownership", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-restart-"));
    const first = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const client1 = makeTestClient(pki, first.port, pki.clientFor("runner-1"));
    const session1 = await client1.connect(makeHello("runner-1"));
    const connection1 = await first.server.waitForConnection("runner-1");
    const job = webJob({ jobId: "job-restart", runId: "run-restart" });
    const offering = connection1.offer(job, [WEB_TARGET_TOKEN]);
    offering.catch(() => undefined);
    await session1.nextOffer(new AbortController().signal);
    await client1.close();
    await first.shutdown();

    const second = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const client2 = makeTestClient(pki, second.port, pki.clientFor("runner-1"));
    cleanups.push(async () => {
      await client2.close();
      await second.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    });
    const session2 = await client2.connect(makeHello("runner-1"));
    const connection2 = await second.server.waitForConnection("runner-1");
    const leasePromise = connection2.offer(job, [WEB_TARGET_TOKEN]);
    const offer = await session2.nextOffer(new AbortController().signal);
    const lease = await session2.accept(offer.offerId);
    await expect(leasePromise).resolves.toEqual(lease);
    expect(second.application.ownership.ownerOf(job.runId)).toEqual({
      runnerId: "runner-1",
      sessionId: session2.welcome.sessionId,
    });
  });

  it("resumes the same session after a real mTLS disconnect without extending the lease", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-resume-"));
    const daemon = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const cert = pki.clientFor("runner-1");
    const client1 = makeTestClient(pki, daemon.port, cert);
    const session1 = await client1.connect(makeHello("runner-1"));
    const connection = await daemon.server.waitForConnection("runner-1");
    const job = webJob({ jobId: "job-resume", runId: "run-resume" });
    const leasePromise = connection.offer(job, [WEB_TARGET_TOKEN]);
    const offer = await session1.nextOffer(new AbortController().signal);
    const lease = await session1.accept(offer.offerId);
    await leasePromise;
    const original = event(job.runId);
    await session1.submit(batch(original));
    const resumeToken = session1.welcome.resumeToken;
    await client1.close();
    await expect.poll(() => daemon.server.connection("runner-1")).toBeUndefined();

    const client2 = makeTestClient(pki, daemon.port, cert);
    cleanups.push(async () => {
      await client2.close();
      await daemon.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    });
    const session2 = await client2.connect(makeHello("runner-1", { resumeToken }));
    expect(session2.welcome.sessionId).toBe(session1.welcome.sessionId);
    expect(session2.welcome.resumeToken).not.toBe(resumeToken);
    expect(lease.leaseEpoch).toBe(1);
    expect((await session2.submit(batch(original))).nextExpectedSequenceNumber).toBe(2);
    const completion = { jobId: job.jobId, runId: job.runId, status: "passed" } as const;
    await session2.complete(lease, completion);
    await expect.poll(() => daemon.application.jobs.completionOf(job.runId)).toEqual(completion);
    const renewed = await session2.renew(lease).catch((error: unknown) => error);
    expect(renewed).toMatchObject({ code: "LeaseLost" });
  });
});
