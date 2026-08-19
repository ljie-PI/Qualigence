import { describe, expect, it } from "vitest";
import { LocalRunPolicyIssuer } from "../../../apps/core-daemon/src/local/local-run-policy-issuer.js";

describe("LocalRunPolicyIssuer", () => {
  it("issues one deterministic frozen Local isolated-test policy", () => {
    const issuer = new LocalRunPolicyIssuer({ now: () => 1_000, ttlMs: 60_000, issuerVersion: "v1" });
    const issued = issuer.issue({ kind: "web", url: "https://Example.test:443/cart" });
    expect(issued.projectId).toBe("local");
    expect(issued.policy).toMatchObject({
      environment: "isolated_test",
      allowedOrigins: ["https://example.test"],
      allowedActionKinds: ["click"],
      maximumRisk: "Normal",
      explorationAllowed: false,
      issuedAt: new Date(1_000).toISOString(),
      expiresAt: new Date(61_000).toISOString(),
      policyId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.isFrozen(issued.policy)).toBe(true);
  });

  it.each(["ftp://example.test", "https://user:pass@example.test", "not a URL"])(
    "rejects invalid Local target %s",
    (url) => expect(() => new LocalRunPolicyIssuer().issue({ kind: "web", url })).toThrow(),
  );
});
