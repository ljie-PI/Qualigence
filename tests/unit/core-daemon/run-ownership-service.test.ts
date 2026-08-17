import { describe, expect, it } from "vitest";
import type { AcceptedExecutionJob } from "@qualigence/runner-protocol";
import { RunOwnershipService } from "@qualigence/core-application";

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

describe("RunOwnershipService", () => {
  it("grants a single-owner lease bound to run, runner, session and epoch", () => {
    const ownership = new RunOwnershipService({ leaseDurationMs: 30_000 });
    const lease = ownership.grant(job("run-1"), owner1);

    expect(lease.runId).toBe("run-1");
    expect(lease.leaseEpoch).toBe(1);
    expect(lease.leaseToken).toBeTruthy();
    expect(ownership.ownerOf("run-1")).toEqual(owner1);
  });

  it("never re-grants an existing run to another owner", () => {
    const ownership = new RunOwnershipService();
    ownership.grant(job("run-1"), owner1);

    expect(() => ownership.grant(job("run-1"), { runnerId: "runner-2", sessionId: "s2" })).toThrowError(
      expect.objectContaining({ code: "RunOwnershipViolation" }),
    );
  });

  it("rejects renew with a wrong lease token as LeaseLost", () => {
    const ownership = new RunOwnershipService();
    const lease = ownership.grant(job("run-1"), owner1);

    expect(() => ownership.renew({ ...lease, leaseToken: "wrong" })).toThrowError(
      expect.objectContaining({ code: "LeaseLost" }),
    );
  });

  it("blocks new actions and completion once the lease has expired", () => {
    const clock = fixedClock();
    const ownership = new RunOwnershipService({ leaseDurationMs: 10_000, now: clock.now });
    const lease = ownership.grant(job("run-1"), owner1);

    expect(ownership.mayStartAction(lease)).toBe(true);
    clock.advance(10_001);
    expect(ownership.mayStartAction(lease)).toBe(false);
    expect(() => ownership.complete(lease)).toThrowError(
      expect.objectContaining({ code: "LeaseLost" }),
    );
  });

  it("renew extends the deadline without changing the epoch", () => {
    const clock = fixedClock();
    const ownership = new RunOwnershipService({ leaseDurationMs: 10_000, now: clock.now });
    const lease = ownership.grant(job("run-1"), owner1);

    clock.advance(5_000);
    const renewed = ownership.renew(lease);
    expect(renewed.leaseEpoch).toBe(lease.leaseEpoch);

    clock.advance(9_000);
    expect(ownership.mayStartAction(renewed)).toBe(true);
  });

  it("creates a recovery run with a fresh runId and never assigns the lost runId to another runner", () => {
    const ownership = new RunOwnershipService();
    const lease = ownership.grant(job("run-1"), owner1);
    ownership.markLost("run-1", "expired");

    const recovery = ownership.createRecoveryRun("run-1");
    expect(recovery.runId).not.toBe("run-1");
    expect(ownership.recoveryOf(recovery.runId)).toBe("run-1");
    // The original run remains lost and blocked; it is never reassigned.
    expect(ownership.mayStartAction(lease)).toBe(false);
  });

  it("allows only the original owning identity to upload Trace, even after lease loss", () => {
    const ownership = new RunOwnershipService();
    ownership.grant(job("run-1"), owner1);
    ownership.markLost("run-1", "expired");

    expect(() =>
      ownership.authorizeTraceUpload(
        { runnerId: "runner-1", certificateFingerprint: "fp-1", scope: { kind: "local" } },
        batch("run-1"),
      ),
    ).not.toThrow();

    expect(() =>
      ownership.authorizeTraceUpload(
        { runnerId: "runner-2", certificateFingerprint: "fp-2", scope: { kind: "local" } },
        batch("run-1"),
      ),
    ).toThrowError(expect.objectContaining({ code: "RunOwnershipViolation" }));
  });
});
