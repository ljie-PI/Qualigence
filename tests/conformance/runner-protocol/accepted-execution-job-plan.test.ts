import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalPayloadHash, parseExecutionJob } from "@qualigence/runner-protocol";
import type {
  AcceptedExecutionJob,
  ExecutionJobPlanSnapshot,
} from "@qualigence/runner-protocol";

const legacyJob: AcceptedExecutionJob = {
  jobId: "job-1",
  runId: "run-attempt-1",
  projectId: "project-1",
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
  policy: {
    ...legacyJob.policy,
    allowedActionKinds: ["navigate", "click", "input"],
  },
  plan: planSnapshot,
};

describe("AcceptedExecutionJob.plan (additive snapshot)", () => {
  it("freezes policy as a required immutable execution snapshot", () => {
    expect(legacyJob.policy.policyId).toBe("policy-test");
    expect(legacyJob.projectId).toBe("project-1");
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
      projectId: "project-1",
      target: { kind: "web", url: "https://example.test/" },
      objective: "add the item to the cart",
      policy: legacyJob.policy,
    };
    expect("plan" in legacyJob).toBe(false);
    expect(canonicalPayloadHash(legacyJob)).toBe(canonicalPayloadHash(preLs07Shape));
  });

  it("includes immutable project provenance in the canonical Job identity", () => {
    expect(canonicalPayloadHash({ ...legacyJob, projectId: "project-2" })).not.toBe(
      canonicalPayloadHash(legacyJob),
    );
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

  it("accepts all six immutable indexed plan step kinds", () => {
    const job = parseExecutionJob({
      ...legacyJob,
      policy: {
        ...legacyJob.policy,
        allowedActionKinds: ["navigate", "click", "input", "select", "scroll"],
      },
      plan: {
        ...planSnapshot,
        steps: [
          { stepIndex: 0, kind: "navigate", path: "/checkout" },
          { stepIndex: 1, kind: "click", target: { role: "button", purpose: "begin checkout" } },
          { stepIndex: 2, kind: "input", target: { role: "textbox", purpose: "enter email" }, valueRef: "customer.email" },
          { stepIndex: 3, kind: "select", target: { role: "combobox", purpose: "choose country" }, valueRef: "customer.country" },
          { stepIndex: 4, kind: "scroll", direction: "down", amount: "page" },
          { stepIndex: 5, kind: "verify", claimIds: ["claim-1"] },
        ],
      },
    });

    expect(job.plan?.steps).toEqual([
      { stepIndex: 0, kind: "navigate", path: "/checkout" },
      { stepIndex: 1, kind: "click", target: { role: "button", purpose: "begin checkout" } },
      { stepIndex: 2, kind: "input", target: { role: "textbox", purpose: "enter email" }, valueRef: "customer.email" },
      { stepIndex: 3, kind: "select", target: { role: "combobox", purpose: "choose country" }, valueRef: "customer.country" },
      { stepIndex: 4, kind: "scroll", direction: "down", amount: "page" },
      { stepIndex: 5, kind: "verify", claimIds: ["claim-1"] },
    ]);
  });

  it("keeps the concrete pre-index plan compatible without applying indexed policy checks", () => {
    const job = parseExecutionJob({
      ...plannedJob,
      policy: legacyJob.policy,
    });

    expect(job.plan?.steps).toEqual(planSnapshot.steps);
    expect(job.plan?.steps.every((step) => !("stepIndex" in step))).toBe(true);
  });

  it.each([
    ["an unindexed select", [{ kind: "select", target: { purpose: "choose country" }, valueRef: "customer.country" }]],
    ["an unindexed scroll", [{ kind: "scroll", direction: "down", amount: "small" }]],
    ["unknown step fields", [{ stepIndex: 0, kind: "navigate", path: "/checkout", selector: "body" }]],
  ])("rejects a new plan form with %s", (_name, steps) => {
    expect(() => parseExecutionJob({
      ...legacyJob,
      policy: { ...legacyJob.policy, allowedActionKinds: ["navigate", "select", "scroll"] },
      plan: { ...planSnapshot, steps },
    })).toThrow();
  });

  it("rejects a plan action that its immutable policy does not allow", () => {
    expect(() => parseExecutionJob({
      ...legacyJob,
      plan: {
        ...planSnapshot,
        steps: [{ stepIndex: 0, kind: "navigate", path: "/checkout" }],
      },
    })).toThrow();
  });

  it("rejects model-owned select option text even when a valueRef is present", () => {
    expect(() => parseExecutionJob({
      ...legacyJob,
      plan: {
        ...planSnapshot,
        steps: [{
          stepIndex: 0,
          kind: "select",
          target: { role: "combobox", purpose: "choose country" },
          valueRef: "customer.country",
          option: "Canada",
        }],
      },
    })).toThrow();
  });

  it.each([
    ["a duplicate index", [
      { stepIndex: 0, kind: "navigate", path: "/checkout" },
      { stepIndex: 0, kind: "verify", claimIds: ["claim-1"] },
    ]],
    ["a skipped index", [
      { stepIndex: 0, kind: "navigate", path: "/checkout" },
      { stepIndex: 2, kind: "verify", claimIds: ["claim-1"] },
    ]],
    ["a mixed indexed/unindexed sequence", [
      { stepIndex: 0, kind: "navigate", path: "/checkout" },
      { kind: "verify", claimIds: ["claim-1"] },
    ]],
    ["more steps than its immutable budget", [
      { stepIndex: 0, kind: "navigate", path: "/checkout" },
      { stepIndex: 1, kind: "verify", claimIds: ["claim-1"] },
    ]],
  ])("rejects an indexed plan with %s", (_name, steps) => {
    expect(() => parseExecutionJob({
      ...legacyJob,
      plan: {
        ...planSnapshot,
        steps,
        ...(_name === "more steps than its immutable budget"
          ? { budget: { ...planSnapshot.budget, maximumStepsPerJob: 1 } }
          : {}),
      },
    })).toThrow();
  });

  it.each([
    ["pixels", { stepIndex: 0, kind: "scroll", direction: "down", amount: "pixels" }],
    ["arbitrary direction", { stepIndex: 0, kind: "scroll", direction: "diagonal", amount: "small" }],
    ["missing select valueRef", { stepIndex: 0, kind: "select", target: { purpose: "choose country" } }],
  ])("rejects unsupported plan parameters: %s", (_name, step) => {
    expect(() => parseExecutionJob({
      ...legacyJob,
      plan: { ...planSnapshot, steps: [step] },
    })).toThrow();
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
    expect(message).toMatch(/string\s+project_id\s*=\s*7\s*;/);
  });
});
