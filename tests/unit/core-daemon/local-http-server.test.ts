import { describe, expect, it, vi } from "vitest";
import { encodeBootstrapCredential } from "@qualigence/local-control";
import { LocalSessionService } from "../../../apps/core-daemon/src/local/local-session-service.js";
import { buildLocalHttpServer } from "../../../apps/core-daemon/src/local/local-http-server.js";

describe("Local HTTP strict contracts", () => {
  it("returns the exact session 201 contract and rejects body/query/content-type", async () => {
    const bootstrap = Buffer.alloc(32, 1);
    const sessions = new LocalSessionService({
      userBootstrap: bootstrap,
      supervisor: Buffer.alloc(32, 2),
      userBootstrapExpiresAtEpochMs: 2_000,
      userSessionTtlMs: 500,
      now: () => 1_000,
      randomBytes: () => Buffer.alloc(32, 3),
    });
    const server = buildLocalHttpServer({
      sessions,
      createRun: async () => ({ runId: "run-1", status: "pending_runner" }),
      readRun: async () => undefined,
      quiesce: async () => undefined,
      health: { live: () => true, internalReady: async () => true, ready: async () => true },
    });
    const authorization = `Bearer ${encodeBootstrapCredential(bootstrap)}`;

    const response = await server.inject({ method: "POST", url: "/api/v1/local/session", headers: { authorization } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      sessionToken: encodeBootstrapCredential(Buffer.alloc(32, 3)),
      expiresAt: new Date(1_500).toISOString(),
    });
    expect((await server.inject({ method: "POST", url: "/api/v1/local/session?x=1", headers: { authorization } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/api/v1/local/session", headers: { authorization, "content-type": "application/json" }, payload: {} })).statusCode).toBe(400);
    await server.close();
  });
});
