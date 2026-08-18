import { describe, expect, it } from "vitest";
import type { AcceptedExecutionJob, ExecutionCompletion } from "@qualigence/runner-protocol";
import type { RunnerControlIntegrityEvent } from "@qualigence/runner-control";
import { RunOwnershipService } from "@qualigence/core-application";
import { InMemoryRunnerControlStore } from "../../helpers/in-memory-runner-control-store.js";

function job(runId: string, jobId = `job-${runId}`): AcceptedExecutionJob {
  return {
    jobId,
    runId,
    target: { kind: "web", url: "https://example.test/" },
    objective: "add the item to the cart",
  };
}

const owner1 = { runnerId: "runner-1", sessionId: "session-1" } as const;

function fixedClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: (): number => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

function batch(runId: string): { batchId: string; runId: string; firstSequenceNumber: number; events: [] } {
  return { batchId: `batch-${runId}`, runId, firstSequenceNumber: 1, events: [] };
}

function recordingSink(): { events: RunnerControlIntegrityEvent[]; emit: (event: RunnerControlIntegrityEvent) => void } {
  const events: RunnerControlIntegrityEvent[] = [];
  return {
    events,
    emit: (event) => {
      events.push(event);
    },
  };
}

function ownership(options: {
  leaseDurationMs?: number;
  now?: () => number;
  integrityEvents?: { emit: (event: RunnerControlIntegrityEvent) => void };
} = {}): RunOwnershipService {
  return new RunOwnershipService({
    store: new InMemoryRunnerControlStore(),
    integrityEvents: options.integrityEvents ?? { emit: () => {} },
    ...options,
  });
}

const passed = (runId = "run-1"): ExecutionCompletion => ({
  jobId: `job-${runId}`,
  runId,
  status: "passed",
});

describe("RunOwnershipService", () => {
  it("grants a single-owner lease bound to run, runner, session and epoch", async () => {
    const service = ownership({ leaseDurationMs: 30_000 });
    const lease = await service.grant(job("run-1"), owner1);

    expect(lease.runId).toBe("run-1");
    expect(lease.leaseEpoch).toBe(1);
    expect(lease.leaseToken).toBeTruthy();
    await expect(service.ownerOf("run-1")).resolves.toEqual(owner1);
  });

  it("never re-grants an existing run to another owner", async () => {
    const service = ownership();
    await service.grant(job("run-1"), owner1);

    await expect(service.grant(job("run-1"), { runnerId: "runner-2", sessionId: "s2" })).rejects.toMatchObject({
      code: "RunOwnershipViolation",
    });
  });

  it("rejects renew with a wrong lease token as LeaseLost", async () => {
    const service = ownership();
    const lease = await service.grant(job("run-1"), owner1);

    await expect(service.renew({ ...lease, leaseToken: "wrong" })).rejects.toMatchObject({
      code: "LeaseLost",
    });
  });

  it("blocks new actions and completion once the lease has expired", async () => {
    const clock = fixedClock();
    const service = ownership({ leaseDurationMs: 10_000, now: clock.now });
    const lease = await service.grant(job("run-1"), owner1);

    await expect(service.mayStartAction(lease)).resolves.toBe(true);
    clock.advance(10_001);
    await expect(service.mayStartAction(lease)).resolves.toBe(false);
    await expect(service.complete(lease, passed())).rejects.toMatchObject({
      code: "LeaseLost",
    });
  });

  it("renew extends the deadline without changing the epoch", async () => {
    const clock = fixedClock();
    const service = ownership({ leaseDurationMs: 10_000, now: clock.now });
    const lease = await service.grant(job("run-1"), owner1);

    clock.advance(5_000);
    const renewed = await service.renew(lease);
    expect(renewed.leaseEpoch).toBe(lease.leaseEpoch);

    clock.advance(9_000);
    await expect(service.mayStartAction(renewed)).resolves.toBe(true);
  });

  it("refuses recovery while the prior run still holds a live lease", async () => {
    const clock = fixedClock();
    const service = ownership({ now: clock.now });
    const lease = await service.grant(job("run-1"), owner1);

    await expect(service.createRecoveryRun("run-1")).rejects.toMatchObject({
      code: "LeaseActive",
    });
    await expect(service.mayStartAction(lease)).resolves.toBe(true);
  });

  it("recovers an expired run under a fresh runId and persists the lineage", async () => {
    const clock = fixedClock();
    const service = ownership({ now: clock.now });
    const lease = await service.grant(job("run-1"), owner1);

    clock.advance(30_001); // expire; recovery is now safe
    const recovery = await service.createRecoveryRun("run-1");
    expect(recovery.job.runId).not.toBe("run-1");
    expect(recovery.recoveryOfRunId).toBe("run-1");

    await service.grant(recovery.job, owner1, recovery.recoveryOfRunId);
    await expect(service.recoveryOf(recovery.job.runId)).resolves.toBe("run-1");
    await expect(service.mayStartAction(lease)).resolves.toBe(false);
  });

  it("never recovers an unknown or already-completed run", async () => {
    const service = ownership();
    await expect(service.createRecoveryRun("run-ghost")).rejects.toMatchObject({
      code: "UnknownRun",
    });

    const lease = await service.grant(job("run-1"), owner1);
    await service.complete(lease, passed());
    await expect(service.createRecoveryRun("run-1")).rejects.toMatchObject({
      code: "RunCompleted",
    });
  });

  it("creates a recovery run with a fresh runId and never assigns the lost runId to another runner", async () => {
    const service = ownership();
    const lease = await service.grant(job("run-1"), owner1);
    await service.markLost("run-1", "expired");

    const recovery = await service.createRecoveryRun("run-1");
    expect(recovery.job.runId).not.toBe("run-1");
    expect(recovery.recoveryOfRunId).toBe("run-1");
    await service.grant(recovery.job, owner1, recovery.recoveryOfRunId);
    await expect(service.recoveryOf(recovery.job.runId)).resolves.toBe("run-1");
    await expect(service.mayStartAction(lease)).resolves.toBe(false);
  });

  it("records a completion conflict as an integrity event and rejects it", async () => {
    const sink = recordingSink();
    const service = ownership({ integrityEvents: sink });
    const lease = await service.grant(job("run-1"), owner1);
    await service.complete(lease, passed());

    const conflicting: ExecutionCompletion = {
      jobId: "job-run-1",
      runId: "run-1",
      status: "error",
      errorCode: "action_failed",
    };
    await expect(service.complete(lease, conflicting)).rejects.toMatchObject({
      code: "RunOwnershipViolation",
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      kind: "completion_conflict",
      runId: "run-1",
      storedCompletionHash: expect.any(String),
      presentedCompletionHash: expect.any(String),
    });
    // Only hashes, never the payloads or a raw lease token.
    expect(JSON.stringify(sink.events[0])).not.toContain("passed");
    expect(JSON.stringify(sink.events[0])).not.toContain("action_failed");
  });

  it("treats a canonical-equivalent completion replay as duplicate without an integrity event", async () => {
    const sink = recordingSink();
    const service = ownership({ integrityEvents: sink });
    const lease = await service.grant(job("run-1"), owner1);
    await service.complete(lease, passed());
    await service.complete(lease, passed());

    expect(sink.events).toHaveLength(0);
  });

  it("completes against the stored lease when the raw token is not in hand", async () => {
    const service = ownership();
    const lease = await service.grant(job("run-1"), owner1);

    // The resumed-connection path: the gRPC server never saw this lease on the
    // current connection, so no raw token is presented.
    await service.completeStored("run-1", passed());
    await expect(service.completionOf("run-1")).resolves.toEqual(passed());
    await expect(service.mayStartAction(lease)).resolves.toBe(false);
  });

  it("refuses a stored completion for an unknown or lost run", async () => {
    const service = ownership();
    await expect(service.completeStored("run-ghost", passed())).rejects.toMatchObject({
      code: "LeaseLost",
    });

    await service.grant(job("run-1"), owner1);
    await service.markLost("run-1", "expired");
    await expect(service.completeStored("run-1", passed())).rejects.toMatchObject({
      code: "LeaseLost",
    });
  });

  it("allows only the original owning identity to upload Trace, even after lease loss", async () => {
    const service = ownership();
    await service.grant(job("run-1"), owner1);
    await service.markLost("run-1", "expired");

    await expect(
      service.authorizeTraceUpload(
        { runnerId: "runner-1", certificateFingerprint: "fp-1", scope: { kind: "local" } },
        batch("run-1"),
      ),
    ).resolves.toBeUndefined();

    await expect(
      service.authorizeTraceUpload(
        { runnerId: "runner-2", certificateFingerprint: "fp-2", scope: { kind: "local" } },
        batch("run-1"),
      ),
    ).rejects.toMatchObject({ code: "RunOwnershipViolation" });
  });
});