import Fastify, { type FastifyInstance } from "fastify";
import { localRunRequestSchema } from "@qualigence/local-control";
import type { LocalRunAccepted, LocalRunStatusResponse } from "@qualigence/local-control";
import { isValidExecutionTargetUrl } from "@qualigence/execution-application";
import type { LocalSessionService } from "./local-session-service.js";

export function buildLocalHttpServer(options: {
  readonly sessions: LocalSessionService;
  readonly createRun: (input: { readonly targetUrl: string; readonly objective: string }) => Promise<LocalRunAccepted>;
  readonly readRun: (runId: string) => Promise<LocalRunStatusResponse | undefined>;
  readonly quiesce: () => Promise<void>;
  readonly health: { live(): boolean; internalReady(): Promise<boolean>; ready(): Promise<boolean> };
}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: false });
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.origin !== undefined || request.headers.cookie !== undefined || request.headers["x-forwarded-host"] !== undefined) await reply.code(400).send({ code: "InvalidRequest" });
  });
  app.post("/api/v1/local/session", async (request, reply) => {
    if (request.url.includes("?") || request.headers["content-type"] !== undefined || hasBody(request)) return reply.code(400).send({ code: "InvalidRequest" });
    const bearer = token(request.headers.authorization); if (bearer === undefined) return reply.code(401).send({ code: "Unauthorized" });
    try { return reply.code(201).send(options.sessions.exchangeBootstrap(bearer)); } catch { return reply.code(401).send({ code: "Unauthorized" }); }
  });
  app.post("/api/v1/local/runs", async (request, reply) => {
    const bearer = token(request.headers.authorization); if (bearer === undefined || !options.sessions.authorizeUser(bearer)) return reply.code(401).send({ code: "Unauthorized" });
    const parsed = localRunRequestSchema.safeParse(request.body); if (!parsed.success || request.url.includes("?") || !isValidExecutionTargetUrl(parsed.data.targetUrl)) return reply.code(400).send({ code: "InvalidRequest" });
    return reply.code(202).send(await options.createRun(parsed.data));
  });
  app.get<{ Params: { runId: string } }>("/api/v1/local/runs/:runId", async (request, reply) => {
    const bearer = token(request.headers.authorization); if (bearer === undefined || !options.sessions.authorizeUser(bearer)) return reply.code(401).send({ code: "Unauthorized" });
    const run = await options.readRun(request.params.runId); return run === undefined ? reply.code(404).send({ code: "RunNotFound" }) : reply.send(run);
  });
  app.post("/api/v1/local/quiesce", async (request, reply) => {
    if (request.url.includes("?") || request.headers["content-type"] !== undefined || hasBody(request)) return reply.code(400).send({ code: "InvalidRequest" });
    const bearer = token(request.headers.authorization); if (bearer === undefined || !options.sessions.authorizeSupervisor(bearer)) return reply.code(401).send({ code: "Unauthorized" });
    await options.quiesce(); return reply.code(204).send();
  });
  app.get("/health/live", async (_request, reply) => reply.code(options.health.live() ? 200 : 503).send({ status: options.health.live() ? "live" : "unavailable" }));
  app.get("/health/internal-ready", async (_request, reply) => { const ready = await options.health.internalReady(); return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "unavailable" }); });
  app.get("/health/ready", async (_request, reply) => { const ready = await options.health.ready(); return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "unavailable" }); });
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    const known = path === "/api/v1/local/session" || path === "/api/v1/local/runs" || path === "/api/v1/local/quiesce" || path === "/health/live" || path === "/health/internal-ready" || path === "/health/ready" || /^\/api\/v1\/local\/runs\/[^/]+$/.test(path ?? "");
    return reply.code(known ? 405 : 404).send({ code: known ? "MethodNotAllowed" : "NotFound" });
  });
  return app;
}

function token(value: string | undefined): string | undefined { const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value ?? ""); return match?.[1]; }
function hasBody(request: { body?: unknown }): boolean { return request.body !== undefined && request.body !== null && request.body !== ""; }
