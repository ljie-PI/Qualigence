import type { FastifyInstance } from "fastify";
import type { ApproveTestPlanBody, CreateTestPlanBody, TestPlanDto } from "@qualigence/public-api";
import { TestPlanServiceError, type TestPlanRevision } from "@qualigence/mission";
import { authenticateOidc, requireIdempotencyKey, requireRole, testPlanService, testPlans, withTenant, type ServerDeps } from "../server-context.js";
import { commandEnvelope } from "../envelopes.js";
import { newCorrelationId, notFound, validationFailed, versionConflict } from "../errors.js";

function toDto(plan: TestPlanRevision): TestPlanDto {
  return { planId: plan.planId, projectId: plan.projectId, prdId: plan.prdId, prdRevision: plan.prdRevision, status: plan.status, version: plan.version, payload: { schemaVersion: "test-plan/v1", testCases: plan.testCases.map((testCase) => ({ testCaseId: testCase.id, title: testCase.title, objective: testCase.objective, preconditions: testCase.preconditions, steps: testCase.steps, expectedClaimIds: testCase.expectedClaims.map((claim) => claim.claimId), priority: testCase.priority })) } };
}

function mapServiceError(error: unknown): never {
  if (error instanceof TestPlanServiceError) {
    if (error.code === "PlanNotFound") throw notFound("Test Plan not found");
    throw validationFailed(error.code);
  }
  const conflict = error as { code?: string; currentVersion?: number };
  if (conflict.code === "PlanVersionConflict" || conflict.code === "PlanAlreadyApproved" || conflict.code === "IdempotencyConflict") throw versionConflict({ actualVersion: conflict.currentVersion });
  throw error;
}

export function registerTestPlanRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post<{ Body: Partial<CreateTestPlanBody> }>("/v1/test-plans", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "tester");
    const idempotencyKey = requireIdempotencyKey(request);
    const body = request.body;
    if (typeof body.projectId !== "string" || typeof body.prdId !== "string" || typeof body.prdRevision !== "number" || typeof body.sourceContentSha256 !== "string") throw validationFailed("Test Plan provenance is required");
    const projectId = body.projectId;
    const prdId = body.prdId;
    const prdRevision = body.prdRevision;
    const sourceContentSha256 = body.sourceContentSha256;
    try {
      const plan = await withTenant(deps, principal.tenantId, (stores) => testPlanService(deps, stores, principal.tenantId).create({ projectId, prdId, prdRevision, sourceContentSha256, proposal: { expectedClaims: body.expectedClaims, testCases: body.testCases }, idempotencyKey }));
      return reply.status(201).send(commandEnvelope(toDto(plan), plan.version, newCorrelationId()));
    } catch (error) { mapServiceError(error); }
  });
  app.get<{ Params: { planId: string } }>("/v1/test-plans/:planId", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    const plan = await withTenant(deps, principal.tenantId, (stores) => testPlans(deps, stores, principal.tenantId).get(request.params.planId));
    if (plan === undefined) throw notFound("Test Plan not found");
    return reply.send(toDto(plan));
  });
  app.post<{ Params: { planId: string }; Body: Partial<ApproveTestPlanBody> }>("/v1/test-plans/:planId/approve", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "tester");
    const idempotencyKey = requireIdempotencyKey(request);
    if (typeof request.body.expectedVersion !== "number") throw validationFailed("expectedVersion is required");
    try {
      const plan = await withTenant(deps, principal.tenantId, (stores) => testPlanService(deps, stores, principal.tenantId).approve({ planId: request.params.planId, expectedVersion: request.body.expectedVersion as number, reviewerId: principal.subject, idempotencyKey }));
      return reply.send(commandEnvelope(toDto(plan), plan.version, newCorrelationId()));
    } catch (error) { mapServiceError(error); }
  });
}
