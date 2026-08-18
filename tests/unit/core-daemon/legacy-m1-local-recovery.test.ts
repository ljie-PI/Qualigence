import { describe, expect, it } from "vitest";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
import { validateLegacyM1LocalRecoveryCandidate } from "@qualigence/core-daemon";
import { verifyLegacyM1LocalRecoveryRows } from "../../../apps/core-daemon/src/legacy-m1-local-recovery.js";

describe("legacy M1 Local recovery", () => {
  it("rejects a non-Local or non-loopback recovery candidate before SQLite opens", () => {
    expect(() => validateLegacyM1LocalRecoveryCandidate({ deploymentMode: "self_hosted" })).toThrow();
  });

  it("requires an explicit supported loopback host", () => {
    const candidate = { format: "legacy-m1-local-recovery/v1", records: [] };
    expect(() => validateLegacyM1LocalRecoveryCandidate(candidate, { deploymentMode: "local" })).toThrow();
    expect(() => validateLegacyM1LocalRecoveryCandidate(candidate, { deploymentMode: "local", host: "::1" })).toThrow(/manifest format/);
    expect(() => validateLegacyM1LocalRecoveryCandidate(candidate, { deploymentMode: "local", host: "0.0.0.0" })).toThrow();
  });

  it("requires a hash-bound policyless row and constrained legacy policy", () => {
    const job = { jobId: "job-1", runId: "run-1", target: { kind: "web", url: "https://example.test/" }, objective: "legacy" };
    const candidate = validateLegacyM1LocalRecoveryCandidate({
      format: "legacy-m1-local-recovery/v1",
      records: [{ jobId: job.jobId, runId: job.runId, canonicalJobSha256: canonicalPayloadHash(job), policy: { policyId: "legacy-m1-local", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" } }],
    }, { deploymentMode: "local", host: "127.0.0.1" });
    expect(verifyLegacyM1LocalRecoveryRows(candidate, new Map([["job-1:run-1", JSON.stringify(job)]]))).toHaveLength(1);
    expect(() => validateLegacyM1LocalRecoveryCandidate({
      format: "legacy-m1-local-recovery/v1",
      records: candidate.records,
    }, { deploymentMode: "local", host: "::1" })).not.toThrow();
    expect(() => verifyLegacyM1LocalRecoveryRows(candidate, new Map())).toThrow();
  });
});
