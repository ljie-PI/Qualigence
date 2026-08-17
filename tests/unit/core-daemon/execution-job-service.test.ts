import { describe, expect, it } from "vitest";
import { InMemoryTraceStore, TraceIngestor } from "@qualigence/evidence";
import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
  ExecutionEventBatch,
  RunnerHello,
  TraceEvent,
} from "@qualigence/runner-protocol";
import { canonicalTraceEventHash, capabilities } from "@qualigence/runner-protocol";
import type { AuthenticatedRunnerContext } from "@qualigence/runner-control";
import {
  CoreRunnerProtocolApplication,
  ExecutionJobService,
  RunnerResumeTokenService,
  RunnerSessionService,
  RunOwnershipService,
} from "@qualigence/core-application";

function job(runId: string, jobId = `job-${runId}`): AcceptedExecutionJob {
  return {
    jobId,
    runId,
    target: { kind: "web", url: "https://example.test/" },
    objective: "add the item to the cart",
  };
}

const owner1 = { runnerId: "runner-1", sessionId: "session-1" } as const;
const webCaps = capabilities({ targetAdapters: ["web-playwright"] });

describe("ExecutionJobService", () => {
  it("offers a web job to a runner that advertises web-playwright", () => {
    const service = new ExecutionJobService(new RunOwnershipService());
    const offer = service.offer({
      owner: owner1,
      capabilities: webCaps,
      job: job("run-1"),
      requiredCapabilities: ["target:web-playwright"],
    });
    expect(offer.job.jobId).toBe("job-run-1");
    expect(offer.requiredCapabilities).toEqual(["target:web-playwright"]);
  });

  it("rejects an offer with an explicit CapabilityMismatch instead of silently downgrading", () => {
    const service = new ExecutionJobService(new RunOwnershipService());
    expect(() =>
      service.offer({
        owner: owner1,
        capabilities: webCaps,
        job: job("run-1"),
        requiredCapabilities: ["target:web-playwright", "model:vision-input"],
      }),
    ).toThrowError(expect.objectContaining({ code: "CapabilityMismatch" }));
  });

  it("returns the same lease for a duplicate accept of the same offer", () => {
    const service = new ExecutionJobService(new RunOwnershipService());
    const offer = service.offer({
      owner: owner1,
      capabilities: webCaps,
      job: job("run-1"),
      requiredCapabilities: ["target:web-playwright"],
    });
    const first = service.accept(offer.offerId);
    const second = service.accept(offer.offerId);
    expect(second).toEqual(first);
  });

  it("records completion under a valid lease", () => {
    const service = new ExecutionJobService(new RunOwnershipService());
    const offer = service.offer({
      owner: owner1,
      capabilities: webCaps,
      job: job("run-1"),
      requiredCapabilities: ["target:web-playwright"],
    });
    const lease = service.accept(offer.offerId);
    const completion: ExecutionCompletion = { jobId: lease.jobId, runId: lease.runId, status: "passed" };
    service.complete(lease, completion);
    expect(service.completionOf("run-1")).toEqual(completion);
  });

  it("rejects an unknown offer", () => {
    const service = new ExecutionJobService(new RunOwnershipService());
    expect(() => service.accept("nope")).toThrowError(
      expect.objectContaining({ code: "UnknownOffer" }),
    );
  });
});

const identity1: AuthenticatedRunnerContext = {
  runnerId: "runner-1",
  certificateFingerprint: "fp-1",
  scope: { kind: "local" },
};
const identity2: AuthenticatedRunnerContext = {
  runnerId: "runner-2",
  certificateFingerprint: "fp-2",
  scope: { kind: "local" },
};

const welcome = {
  serverVersion: "0.1.0",
  heartbeatIntervalMs: 5_000,
  leaseDurationMs: 30_000,
  traceBatchMaximumEvents: 128,
  traceBatchMaximumBytes: 262_144,
  maximumInFlightBatches: 2,
  maximumPendingWriteBytes: 1_048_576,
} as const;

function hello(runnerId: string, overrides: Partial<RunnerHello> = {}): RunnerHello {
  return {
    runnerId,
    runnerVersion: "0.1.0",
    supportedProtocolMajors: [1],
    capabilities: capabilities({ targetAdapters: ["web-playwright"] }),
    ...overrides,
  };
}

function observationEvent(runId: string, sequenceNumber: number, graphId = `graph-${sequenceNumber}`): TraceEvent {
  const base = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `${runId}:${sequenceNumber}`,
    idempotencyKey: `${runId}:${sequenceNumber}`,
    runId,
    sequenceNumber,
    stage: "observation",
    occurredAt: "2026-08-01T00:00:00.000Z",
    payload: { graphId, nodes: [] },
  } as const;
  return { ...base, payloadHash: canonicalTraceEventHash(base) } as TraceEvent;
}

function batch(runId: string, first: number, events: TraceEvent[]): ExecutionEventBatch {
  return { batchId: `batch-${first}`, runId, firstSequenceNumber: first, events };
}

class BarrierTraceStore extends InMemoryTraceStore {
  private barrier: Promise<void> = Promise.resolve();
  private releaseHold: (() => void) | undefined;

  startHold(): void {
    this.barrier = new Promise<void>((resolve) => {
      this.releaseHold = resolve;
    });
  }

  endHold(): void {
    this.releaseHold?.();
    this.releaseHold = undefined;
    this.barrier = Promise.resolve();
  }

  override async appendTraceEvent(event: TraceEvent) {
    await this.barrier;
    return super.appendTraceEvent(event);
  }
}

function makeApplication(options: {
  readonly store?: InMemoryTraceStore;
  readonly now?: () => number;
} = {}) {
  const store = options.store ?? new InMemoryTraceStore();
  const ownership = new RunOwnershipService({
    leaseDurationMs: welcome.leaseDurationMs,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const sessions = new RunnerSessionService({
    welcome,
    resumeTokens: new RunnerResumeTokenService(),
    traceIngestor: new TraceIngestor(store),
    ownership,
  });
  const jobs = new ExecutionJobService(ownership, { leaseDurationMs: welcome.leaseDurationMs });
  const application = new CoreRunnerProtocolApplication({ sessions, jobs, ownership });
  return { application, sessions, jobs, ownership, store };
}

describe("CoreRunnerProtocolApplication", () => {
  it("replays an exact canonical offer and rejects different content for the same identities", async () => {
    const { application } = makeApplication();
    const session = await application.openSession(hello("runner-1"), identity1);
    const first = await application.createOffer(session.sessionId, job("run-1"), ["target:web-playwright"]);
    const replay = await application.createOffer(session.sessionId, job("run-1"), ["target:web-playwright"]);
    expect(replay).toEqual(first);

    await expect(
      application.createOffer(session.sessionId, { ...job("run-1"), objective: "other" }, ["target:web-playwright"]),
    ).rejects.toMatchObject({ code: "RunIdentityMismatch" });
    await expect(
      application.createOffer(session.sessionId, job("run-1", "job-other"), ["target:web-playwright"]),
    ).rejects.toMatchObject({ code: "RunIdentityMismatch" });
    await expect(
      application.createOffer(session.sessionId, job("run-other", "job-run-1"), ["target:web-playwright"]),
    ).rejects.toMatchObject({ code: "RunIdentityMismatch" });
  });

  it("does not let a rejected resume steal run ownership", async () => {
    const { application, ownership } = makeApplication();
    const first = await application.openSession(hello("runner-1"), identity1);
    const offer = await application.createOffer(first.sessionId, job("run-1"), ["target:web-playwright"]);
    await application.accept(first.sessionId, offer.offerId);
    expect(ownership.ownerOf("run-1")).toEqual({ runnerId: "runner-1", sessionId: first.sessionId });

    await expect(
      application.openSession(hello("runner-2", { resumeToken: first.resumeToken }), identity2),
    ).rejects.toMatchObject({ code: "RunnerResumeRejected" });
    expect(ownership.ownerOf("run-1")).toEqual({ runnerId: "runner-1", sessionId: first.sessionId });
  });

  it("keeps the live session identity after a successful resume", async () => {
    const { application, ownership, sessions } = makeApplication();
    const first = await application.openSession(hello("runner-1"), identity1);
    const offer = await application.createOffer(first.sessionId, job("run-1"), ["target:web-playwright"]);
    const lease = await application.accept(first.sessionId, offer.offerId);

    const resumed = await application.openSession(
      hello("runner-1", { resumeToken: first.resumeToken }),
      identity1,
    );
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(sessions.session(first.sessionId)?.identity.runnerId).toBe("runner-1");

    const replay = await application.createOffer(resumed.sessionId, job("run-1"), ["target:web-playwright"]);
    expect(replay.offerId).toBe(offer.offerId);
    const accepted = await application.accept(resumed.sessionId, replay.offerId);
    expect(accepted.leaseToken).toBe(lease.leaseToken);
    expect(ownership.ownerOf("run-1")?.sessionId).toBe(resumed.sessionId);
  });

  it("returns the same lease for a second accept", async () => {
    const { application } = makeApplication();
    const session = await application.openSession(hello("runner-1"), identity1);
    const offer = await application.createOffer(session.sessionId, job("run-1"), ["target:web-playwright"]);
    const first = await application.accept(session.sessionId, offer.offerId);
    const second = await application.accept(session.sessionId, offer.offerId);
    expect(second).toEqual(first);
  });

  it("returns LeaseLost for an expired lease and does not mint a new epoch", async () => {
    let now = 1_000;
    const { application } = makeApplication({ now: () => now });
    const session = await application.openSession(hello("runner-1"), identity1);
    const offer = await application.createOffer(session.sessionId, job("run-1"), ["target:web-playwright"]);
    const lease = await application.accept(session.sessionId, offer.offerId);
    now += welcome.leaseDurationMs + 1;
    await expect(application.renew(session.sessionId, lease)).rejects.toMatchObject({ code: "LeaseLost" });
    await expect(application.renew(session.sessionId, lease)).rejects.toMatchObject({ code: "LeaseLost" });
    expect(lease.leaseEpoch).toBe(1);
  });

  it("rejects renew after completion and records a replayed completion once", async () => {
    const { application, jobs } = makeApplication();
    const session = await application.openSession(hello("runner-1"), identity1);
    const offer = await application.createOffer(session.sessionId, job("run-1"), ["target:web-playwright"]);
    const lease = await application.accept(session.sessionId, offer.offerId);
    const completion: ExecutionCompletion = { jobId: lease.jobId, runId: lease.runId, status: "passed" };
    await application.complete(session.sessionId, lease, completion);
    await application.complete(session.sessionId, lease, completion);
    expect(jobs.completionOf("run-1")).toEqual(completion);
    await expect(application.renew(session.sessionId, lease)).rejects.toMatchObject({ code: "LeaseLost" });
  });

  it("preserves overlapping Trace arrival order and acks only after ingest", async () => {
    const store = new BarrierTraceStore();
    const { application } = makeApplication({ store });
    const session = await application.openSession(hello("runner-1"), identity1);
    const offer = await application.createOffer(session.sessionId, job("run-1"), ["target:web-playwright"]);
    await application.accept(session.sessionId, offer.offerId);

    store.startHold();
    const first = application.ingest(session.sessionId, batch("run-1", 1, [observationEvent("run-1", 1)]));
    const second = application.ingest(session.sessionId, batch("run-1", 2, [observationEvent("run-1", 2)]));
    expect(store.eventsFor("run-1")).toHaveLength(0);
    store.endHold();
    await expect(first).resolves.toMatchObject({ nextExpectedSequenceNumber: 2 });
    await expect(second).resolves.toMatchObject({ nextExpectedSequenceNumber: 3 });
    expect(store.eventsFor("run-1")).toHaveLength(2);
  });

  it("rolls back an interrupted Welcome reservation without stranding ownership", async () => {
    const { application, sessions, ownership } = makeApplication();
    const existing = await application.openSession(hello("runner-1"), identity1);
    const offer = await application.createOffer(existing.sessionId, job("run-1"), ["target:web-playwright"]);
    await application.accept(existing.sessionId, offer.offerId);

    const interrupted = await application.openSession(hello("runner-2"), identity2);
    await application.closeSession(interrupted.sessionId);
    expect(sessions.session(interrupted.sessionId)).toBeUndefined();
    await expect(
      application.createOffer(interrupted.sessionId, job("run-2"), ["target:web-playwright"]),
    ).rejects.toMatchObject({ code: "UnknownSession" });
    expect(ownership.ownerOf("run-1")).toEqual({ runnerId: "runner-1", sessionId: existing.sessionId });

    const replacement = await application.openSession(hello("runner-2"), identity2);
    expect(replacement.sessionId).not.toBe(interrupted.sessionId);
    await expect(
      application.createOffer(replacement.sessionId, job("run-1"), ["target:web-playwright"]),
    ).rejects.toMatchObject({ code: "RunIdentityMismatch" });
    expect(ownership.ownerOf("run-1")?.runnerId).toBe("runner-1");
  });
});
