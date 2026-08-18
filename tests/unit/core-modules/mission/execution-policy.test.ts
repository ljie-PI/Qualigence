import { describe, expect, it } from "vitest";
import {
  narrowApprovedExecutionPolicy,
  validateApprovedExecutionPolicy,
} from "@qualigence/mission";

const approved = {
  policyId: "policy-staging",
  environment: "staging" as const,
  allowedOrigins: ["https://staging.example.test"],
  allowedActionKinds: ["click"] as const,
  maximumRisk: "Normal" as const,
  explorationAllowed: false,
  issuedAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T00:01:00.000Z",
};

describe("ApprovedExecutionPolicy", () => {
  it("accepts only explicit bounded staging authority", () => {
    expect(validateApprovedExecutionPolicy(approved, 60_000)).toEqual(approved);
    expect(() => validateApprovedExecutionPolicy({ ...approved, allowedOrigins: ["https://*.example.test"] }, 60_000)).toThrow();
    expect(() => validateApprovedExecutionPolicy({ ...approved, allowedActionKinds: ["click", "input"] }, 60_000)).toThrow();
  });

  it("never lets exploration widen approved policy authority", () => {
    const exploration = {
      seedSkillBundleIds: [], allowedActionKinds: ["click"], allowedOrigins: ["https://staging.example.test"],
      maximumSteps: 1, maximumWallClockMs: 1_000, maximumModelTokens: 1_000, maximumStateVisits: 1,
      maximumRecoveries: 0, riskCeiling: "ReadOnly" as const,
    };
    expect(() => narrowApprovedExecutionPolicy({ ...approved, environment: "production", explorationAllowed: true }, exploration)).toThrow();
    expect(() => narrowApprovedExecutionPolicy({ ...approved, environment: "isolated_test", explorationAllowed: true }, { ...exploration, allowedOrigins: ["https://other.example.test"] })).toThrow();
  });

  it("narrows an exactly representable risk ceiling and rejects unrepresentable authority", () => {
    const exploration = { seedSkillBundleIds: [], allowedActionKinds: ["click"], allowedOrigins: ["https://staging.example.test"], maximumSteps: 1, maximumWallClockMs: 1_000, maximumModelTokens: 1_000, maximumStateVisits: 1, maximumRecoveries: 0, riskCeiling: "ReadOnly" as const };
    const explorationApproved = { ...approved, environment: "isolated_test" as const, explorationAllowed: true, maximumRisk: "ExternalSideEffect" as const };
    expect(narrowApprovedExecutionPolicy(explorationApproved, exploration)).toMatchObject({ maximumRisk: "Normal" });
    expect(() => narrowApprovedExecutionPolicy(explorationApproved, { ...exploration, riskCeiling: "LocalMutation" })).toThrow(/risk/i);
  });
});
