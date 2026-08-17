import { describe, expect, it } from "vitest";
import type { AcceptedExecutionJob, ExecutionCompletion } from "@qualigence/runner-protocol";
import { capabilities } from "@qualigence/runner-protocol";
import { ExecutionJobService, RunOwnershipService } from "@qualigence/core-application";

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
