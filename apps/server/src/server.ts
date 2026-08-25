import Fastify, { type FastifyInstance } from "fastify";
import type { ErrorEnvelope } from "@qualigence/public-api";
import { ApiError, newCorrelationId, toErrorEnvelope } from "./errors.js";
import type { ServerDeps } from "./server-context.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerTargetRoutes } from "./routes/targets.js";
import { registerPrdRevisionRoutes } from "./routes/prd-revisions.js";
import { registerInvestigationRoutes } from "./routes/investigations.js";
import { registerReviewTaskRoutes } from "./routes/review-tasks.js";
import { registerRunnerEnrollmentRoutes } from "./routes/runner-enrollments.js";
import { registerTestPlanRoutes } from "./routes/test-plans.js";
import { registerMissionRoutes } from "./routes/missions.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSkillRoutes } from "./routes/skills.js";

/**
 * Build the Public API Fastify server. Every human route authenticates via OIDC
 * and authorizes via RBAC before opening the caller's tenant-scoped RLS
 * transaction; Runner-facing routes authenticate via the enrollment token or
 * mTLS certificate — never OIDC. All errors are rendered as the safe
 * {@link ErrorEnvelope}, never leaking internals.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    const correlationId = newCorrelationId();
    if (error instanceof ApiError) {
      const envelope: ErrorEnvelope = toErrorEnvelope(error, correlationId);
      void reply.status(error.status).send(envelope);
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 400) {
      const envelope: ErrorEnvelope = {
        code: "ValidationFailed",
        safeMessage: "the request body is invalid",
        correlationId,
      };
      void reply.status(422).send(envelope);
      return;
    }
    const envelope: ErrorEnvelope = {
      code: "Internal",
      safeMessage: "an internal error occurred",
      correlationId,
    };
    void reply.status(500).send(envelope);
  });

  app.setNotFoundHandler((_request, reply) => {
    const envelope: ErrorEnvelope = {
      code: "NotFound",
      safeMessage: "route not found",
      correlationId: newCorrelationId(),
    };
    void reply.status(404).send(envelope);
  });

  app.get("/readyz", async (_request, reply) => {
    const report = deps.readiness?.() ?? {
      status: "not-ready" as const,
      checks: [{
        name: "intelligence_result_consumer" as const,
        status: "fail" as const,
        code: "NotConfigured",
        safeMessage: "intelligence result consumer readiness is not configured",
      }],
    };
    await reply.status(report.status === "ready" ? 200 : 503).send(report);
  });

  registerProjectRoutes(app, deps);
  registerTargetRoutes(app, deps);
  registerPrdRevisionRoutes(app, deps);
  registerInvestigationRoutes(app, deps);
  registerReviewTaskRoutes(app, deps);
  registerRunnerEnrollmentRoutes(app, deps);
  registerTestPlanRoutes(app, deps);
  registerMissionRoutes(app, deps);
  registerRunRoutes(app, deps);
  registerSkillRoutes(app, deps);

  return app;
}
