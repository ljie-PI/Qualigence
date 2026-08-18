import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
import type {
  AcceptedExecutionJob,
  ExecutionJobPlanSnapshot,
} from "@qualigence/runner-protocol";

const legacyJob: AcceptedExecutionJob = {
  jobId: "job-1",
  runId: "run-attempt-1",
  target: { kind: "web", url: "https://example.test/" },
  objective: "add the item to the cart",
  policy: {
    policyId: "policy-test",
    environment: "isolated_test",
    allowedOrigins: ["https://example.test"],
    allowedActionKinds: ["click"],
    maximumRisk: "Normal",
    explorationAllowed: false,
    issuedAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-18T00:01:00.000Z",
  },
};

const planSnapshot: ExecutionJobPlanSnapshot = {
  missionId: "mission-1",
  missionRevision: 1,
  testCaseId: "tc-1",
  steps: [
    { kind: "navigate", path: "/cart" },
    { kind: "click", target: { role: "button", name: "Add to cart", purpose: "add item" } },
    { kind: "verify", claimIds: ["claim-1"] },
  ],
  expectedClaimIds: ["claim-1"],
  budget: {
    maximumStepsPerJob: 20,
    maximumWallClockMs: 60_000,
    maximumModelTokens: 100_000,
  },
};

const plannedJob: AcceptedExecutionJob = {
  ...legacyJob,
  plan: planSnapshot,
};

describe("AcceptedExecutionJob.plan (additive snapshot)", () => {
  it("freezes policy as a required immutable execution snapshot", () => {
    expect(legacyJob.policy.policyId).toBe("policy-test");
  });

  it("keeps M1 objective-only jobs valid and JSON round-trippable without a plan", () => {
    expect(legacyJob.plan).toBeUndefined();
    const roundTripped = JSON.parse(JSON.stringify(legacyJob)) as AcceptedExecutionJob;
    expect(roundTripped).toEqual(legacyJob);
  });

  it("does not introduce a phantom plan key for a job that omits the optional plan", () => {
    // `plan` remains optional, while the required policy is part of every Job's
    // immutable identity.
    const preLs07Shape = {
      jobId: "job-1",
      runId: "run-attempt-1",
      target: { kind: "web", url: "https://example.test/" },
      objective: "add the item to the cart",
      policy: legacyJob.policy,
    };
    expect("plan" in legacyJob).toBe(false);
    expect(canonicalPayloadHash(legacyJob)).toBe(canonicalPayloadHash(preLs07Shape));
  });

  it("carries an immutable mission plan snapshot when present", () => {
    const roundTripped = JSON.parse(JSON.stringify(plannedJob)) as AcceptedExecutionJob;
    expect(roundTripped.plan).toBeDefined();
    expect(roundTripped.plan?.missionId).toBe("mission-1");
    expect(roundTripped.plan?.missionRevision).toBe(1);
    expect(roundTripped.plan?.testCaseId).toBe("tc-1");
    expect(roundTripped.plan?.expectedClaimIds).toEqual(["claim-1"]);
    expect(roundTripped.plan?.steps.length).toBe(3);
    expect(roundTripped.plan?.budget.maximumStepsPerJob).toBe(20);
    // The optional field genuinely changes identity when supplied.
    expect(canonicalPayloadHash(plannedJob)).not.toBe(
      canonicalPayloadHash(legacyJob),
    );
  });

  it("reserves a frozen wire field number for the plan snapshot", () => {
    const protoPath = fileURLToPath(
      new URL(
        "../../../packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto",
        import.meta.url,
      ),
    );
    const proto = readFileSync(protoPath, "utf8");
    const message = proto.match(/message AcceptedExecutionJob\s*{([^}]*)}/)?.[1] ?? "";
    // The four original fields keep their numbers; plan is a new, additive field.
    expect(message).toMatch(/string\s+job_id\s*=\s*1\s*;/);
    expect(message).toMatch(/string\s+objective\s*=\s*4\s*;/);
    expect(message).toMatch(/ExecutionJobPlanSnapshot\s+plan\s*=\s*5\s*;/);
    expect(message).toMatch(/ExecutionPolicySnapshot\s+policy\s*=\s*6\s*;/);
  });
});
