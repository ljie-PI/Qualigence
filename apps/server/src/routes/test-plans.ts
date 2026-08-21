import type { FastifyInstance } from "fastify";
import type { ApproveTestPlanBody, CreateTestPlanBody, IntentStepDto, TestPlanDto } from "@qualigence/public-api";
import type { IntentStep, TestCase, TestPlanRevision } from "@qualigence/mission";
import { authenticateOidc, requireIdempotencyKey, requireRole, testPlans, withTenant, type ServerDeps } from "../server-context.js";
import { commandEnvelope } from "../envelopes.js";
import { newCorrelationId, notFound, validationFailed, versionConflict } from "../errors.js";

function stepFromDto(step: IntentStepDto): IntentStep {
  if (step.kind !== "verify") return step;
  const [first, ...rest] = step.claimIds;
  if (first === undefined) throw validationFailed("verify steps require claimIds");
  return { kind: "verify", claimIds: [first, ...rest] };
}

function planFromBody(planId: string, body: CreateTestPlanBody): TestPlanRevision {
  const claims = body.expectedClaims.map((claim) => ({ ...claim, sourceRefs: claim.sourceRefs as TestPlanRevision["expectedClaims"][number]["sourceRefs"] }));
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  const testCases = body.testCases.map((testCase): TestCase => {
    const steps = testCase.steps.map(stepFromDto);
    const expectedClaims = testCase.expectedClaimIds.map((claimId) => byId.get(claimId)).filter((claim) => claim !== undefined);
    const [firstStep, ...restSteps] = steps;
    const [firstClaim, ...restClaims] = expectedClaims;
    if (firstStep === undefined || firstClaim === undefined) throw validationFailed("test cases require steps and expected claims");
    return { id: testCase.testCaseId, title: testCase.title, objective: testCase.objective, preconditions: testCase.preconditions, steps: [firstStep, ...restSteps], expectedClaims: [firstClaim, ...restClaims], sourceRefs: firstClaim.sourceRefs, priority: testCase.priority };
  });
  const [firstClaim, ...restClaims] = claims;
  const [firstTestCase, ...restTestCases] = testCases;
  if (firstClaim === undefined || firstTestCase === undefined || !Number.isInteger(body.prdRevision) || body.prdRevision < 1) throw validationFailed("a Test Plan requires PRD provenance, claims and test cases");
  return Object.freeze({ planId, projectId: body.projectId, prdId: body.prdId, prdRevision: body.prdRevision, version: 1, status: "draft", expectedClaims: [firstClaim, ...restClaims] as TestPlanRevision["expectedClaims"], testCases: [firstTestCase, ...restTestCases] as TestPlanRevision["testCases"] });
}

function toDto(plan: TestPlanRevision): TestPlanDto {
  return { planId: plan.planId, projectId: plan.projectId, prdId: plan.prdId, prdRevision: plan.prdRevision, status: plan.status, version: plan.version, payload: { schemaVersion: "test-plan/v1", testCases: plan.testCases.map((testCase) => ({ testCaseId: testCase.id, title: testCase.title, objective: testCase.objective, preconditions: testCase.preconditions, steps: testCase.steps, expectedClaimIds: testCase.expectedClaims.map((claim) => claim.claimId), priority: testCase.priority })) } };
}

export function registerTestPlanRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post<{ Body: Partial<CreateTestPlanBody> }>("/v1/test-plans", async (request, reply) => {
    const principal = await authenticateOidc(deps, request); requireRole(deps, principal, "tester");
    const key = requireIdempotencyKey(request); const body = request.body;
    if (typeof body.projectId !== "string" || typeof body.prdId !== "string" || body.expectedClaims === undefined || body.testCases === undefined) throw validationFailed("Test Plan provenance and payload are required");
    const plan = planFromBody(key, body as CreateTestPlanBody);
    const stored = await withTenant(deps, principal.tenantId, (stores) => testPlans(deps, stores, principal.tenantId).saveDraft({ plan, idempotencyKey: key, createdAt: deps.clock.now() }));
    return reply.status(201).send(commandEnvelope(toDto(stored), stored.version, newCorrelationId()));
  });
  app.get<{ Params: { planId: string } }>("/v1/test-plans/:planId", async (request, reply) => {
    const principal = await authenticateOidc(deps, request); requireRole(deps, principal, "viewer");
    const plan = await withTenant(deps, principal.tenantId, (stores) => testPlans(deps, stores, principal.tenantId).get(request.params.planId));
    if (plan === undefined) throw notFound("Test Plan not found"); return reply.send(toDto(plan));
  });
  app.post<{ Params: { planId: string }; Body: Partial<ApproveTestPlanBody> }>("/v1/test-plans/:planId/approve", async (request, reply) => {
    const principal = await authenticateOidc(deps, request); requireRole(deps, principal, "tester"); const key = requireIdempotencyKey(request); const body = request.body;
    if (typeof body.expectedVersion !== "number") throw validationFailed("expectedVersion is required");
    try {
      const plan = await withTenant(deps, principal.tenantId, (stores) => testPlans(deps, stores, principal.tenantId).approve({ planId: request.params.planId, expectedVersion: body.expectedVersion as number, reviewerId: principal.subject, idempotencyKey: key, clock: deps.clock }));
      return reply.send(commandEnvelope(toDto(plan), plan.version, newCorrelationId()));
    } catch (error) { const conflict = error as { code?: string; currentVersion?: number }; if (conflict.code === "PlanVersionConflict" || conflict.code === "PlanAlreadyApproved" || conflict.code === "IdempotencyConflict") throw versionConflict({ actualVersion: conflict.currentVersion }); throw error; }
  });
}
