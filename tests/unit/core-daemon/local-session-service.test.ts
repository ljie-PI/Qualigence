import { describe, expect, it } from "vitest";
import { LocalSessionService } from "../../../apps/core-daemon/src/local/local-session-service.js";
import { encodeBootstrapCredential } from "@qualigence/local-control";

describe("LocalSessionService", () => {
  it("exchanges the user bootstrap once and keeps only hashes", () => {
    const bootstrap = Buffer.alloc(32, 1);
    const supervisor = Buffer.alloc(32, 2);
    const service = new LocalSessionService({
      userBootstrap: bootstrap,
      supervisor,
      userBootstrapExpiresAtEpochMs: 2_000,
      userSessionTtlMs: 500,
      now: () => 1_000,
      randomBytes: () => Buffer.alloc(32, 3),
    });

    expect(service.exchangeBootstrap(encodeBootstrapCredential(bootstrap))).toEqual({
      sessionToken: encodeBootstrapCredential(Buffer.alloc(32, 3)),
      expiresAt: new Date(1_500).toISOString(),
    });
    expect(() => service.exchangeBootstrap(encodeBootstrapCredential(bootstrap))).toThrow();
    expect(service.authorizeUser(encodeBootstrapCredential(Buffer.alloc(32, 3)))).toBe(true);
    expect(service.authorizeSupervisor(encodeBootstrapCredential(supervisor))).toBe(true);
    expect(service.authorizeSupervisor(encodeBootstrapCredential(supervisor))).toBe(false);
  });

  it("makes all malformed, wrong, expired, and wrong-kind credentials unauthorized", () => {
    const service = new LocalSessionService({
      userBootstrap: Buffer.alloc(32, 1),
      supervisor: Buffer.alloc(32, 2),
      userBootstrapExpiresAtEpochMs: 999,
      userSessionTtlMs: 500,
      now: () => 1_000,
    });
    for (const value of ["bad", encodeBootstrapCredential(Buffer.alloc(32, 9)), encodeBootstrapCredential(Buffer.alloc(32, 2))]) {
      expect(() => service.exchangeBootstrap(value)).toThrowError(expect.objectContaining({ code: "Unauthorized" }));
    }
  });
});
