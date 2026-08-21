import { createHash } from "node:crypto";
import { TestPlanProposalValidator, type TestPlanProposal } from "@qualigence/application-model";
import { PrdDocument, type PrdDocument as PrdDocumentValue } from "@qualigence/context-intake";
import type { Clock } from "@qualigence/shared-kernel";
import { createDraftTestPlan, type IntentStep, type TestPlanRevision } from "../domain/test-plan-revision.js";
import type { TestPlanRepository } from "./test-plan-repository.js";

export type TestPlanServiceErrorCode =
  | "InvalidPlanningProposal"
  | "PrdSourceMismatch"
  | "SelectorLeakRejected"
  | "PrdIdempotencyConflict"
  | "PlanNotFound"
  | "PlanProjectMismatch";

export class TestPlanServiceError extends Error {
  constructor(readonly code: TestPlanServiceErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "TestPlanServiceError";
  }
}

export interface CreateTestPlanCommand {
  readonly projectId: string;
  readonly prdId: string;
  readonly prdRevision: number;
  readonly sourceContentSha256: string;
  readonly proposal: unknown;
  readonly idempotencyKey: string;
}

export interface ApproveTestPlanInput {
  readonly planId: string;
  readonly expectedVersion: number;
  readonly reviewerId: string;
  readonly idempotencyKey: string;
}

export interface IngestPrdCommand {
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly title: string;
  readonly content: string;
}

function deterministicIds(key: string): () => string {
  let index = 0;
  return () => createHash("sha256").update(`test-plan\0${key}\0${index++}`).digest("hex").slice(0, 32);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseProposal(value: unknown): TestPlanProposal {
  const proposal = record(value);
  if (proposal === undefined || !Array.isArray(proposal.expectedClaims) || !Array.isArray(proposal.testCases)) {
    throw new TestPlanServiceError("InvalidPlanningProposal", "proposal claims and test cases are required");
  }
  return {
    expectedClaims: proposal.expectedClaims.map((candidate) => {
      const claim = record(candidate);
      if (claim === undefined || typeof claim.semanticKey !== "string" || typeof claim.statement !== "string" || !Array.isArray(claim.sourceRefs) || typeof claim.confidence !== "number") {
        throw new TestPlanServiceError("InvalidPlanningProposal", "claim shape is invalid");
      }
      return { semanticKey: claim.semanticKey, statement: claim.statement, sourceRefs: nonEmpty(claim.sourceRefs.map(parseSourceRef), "sourceRefs"), confidence: claim.confidence };
    }),
    testCases: proposal.testCases.map((candidate) => {
      const testCase = record(candidate);
      if (testCase === undefined || typeof testCase.title !== "string" || typeof testCase.objective !== "string" || !Array.isArray(testCase.preconditions) || !testCase.preconditions.every((item) => typeof item === "string") || !Array.isArray(testCase.steps) || !Array.isArray(testCase.expectedClaimSemanticKeys) || !testCase.expectedClaimSemanticKeys.every((item) => typeof item === "string") || !Array.isArray(testCase.sourceRefs) || (testCase.priority !== "low" && testCase.priority !== "medium" && testCase.priority !== "high")) {
        throw new TestPlanServiceError("InvalidPlanningProposal", "test case shape is invalid");
      }
      return { title: testCase.title, objective: testCase.objective, preconditions: testCase.preconditions, steps: nonEmpty(testCase.steps.map(parseStep), "steps"), expectedClaimSemanticKeys: nonEmptyStrings(testCase.expectedClaimSemanticKeys), sourceRefs: nonEmpty(testCase.sourceRefs.map(parseSourceRef), "sourceRefs"), priority: testCase.priority };
    }),
  };
}

function parseSourceRef(value: unknown) {
  const ref = record(value);
  if (ref === undefined || typeof ref.prdId !== "string" || !Number.isInteger(ref.revision) || !Number.isInteger(ref.startOffset) || !Number.isInteger(ref.endOffset) || typeof ref.quotedTextSha256 !== "string") {
    throw new TestPlanServiceError("InvalidPlanningProposal", "source reference shape is invalid");
  }
  return { prdId: ref.prdId, revision: ref.revision as number, startOffset: ref.startOffset as number, endOffset: ref.endOffset as number, quotedTextSha256: ref.quotedTextSha256 };
}

function parseStep(value: unknown): TestPlanProposal["testCases"][number]["steps"][number] {
  const step = record(value);
  if (step === undefined || typeof step.kind !== "string") throw new TestPlanServiceError("InvalidPlanningProposal", "step shape is invalid");
  if (step.kind === "navigate" && typeof step.path === "string") return { kind: "navigate", path: step.path };
  if ((step.kind === "click" || step.kind === "input") && record(step.target) !== undefined) {
    const target = parseTarget(step.target);
    if (step.kind === "click") return { kind: "click", target };
    if (typeof step.valueRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*[._/-][A-Za-z0-9._/-]+$/.test(step.valueRef)) {
      throw new TestPlanServiceError("InvalidPlanningProposal", "input valueRef must be an opaque reference, not plaintext");
    }
    return { kind: "input", target, valueRef: step.valueRef };
  }
  if (step.kind === "verify" && Array.isArray(step.claimSemanticKeys) && step.claimSemanticKeys.every((item) => typeof item === "string")) {
    return { kind: "verify", claimSemanticKeys: nonEmptyStrings(step.claimSemanticKeys) };
  }
  throw new TestPlanServiceError("InvalidPlanningProposal", "unknown or malformed step");
}

function parseTarget(value: unknown) {
  const target = record(value);
  if (target === undefined || typeof target.purpose !== "string" || (target.role !== undefined && typeof target.role !== "string") || (target.name !== undefined && typeof target.name !== "string")) {
    throw new TestPlanServiceError("InvalidPlanningProposal", "semantic target shape is invalid");
  }
  return { purpose: target.purpose, ...(target.role === undefined ? {} : { role: target.role as string }), ...(target.name === undefined ? {} : { name: target.name as string }) };
}

function nonEmpty<T>(values: readonly T[], field: string): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new TestPlanServiceError("InvalidPlanningProposal", `${field} must not be empty`);
  return [first, ...rest];
}

function nonEmptyStrings(values: readonly string[]): readonly [string, ...string[]] {
  return nonEmpty(values, "claim references");
}

function proposalFromPlan(plan: TestPlanRevision): TestPlanProposal {
  const keyById = new Map(plan.expectedClaims.map((claim) => [claim.claimId, claim.semanticKey]));
  return {
    expectedClaims: plan.expectedClaims,
    testCases: plan.testCases.map((testCase) => ({
      title: testCase.title,
      objective: testCase.objective,
      preconditions: testCase.preconditions,
      steps: nonEmpty(testCase.steps.map((step) => toProposedStep(step, keyById)), "steps"),
      expectedClaimSemanticKeys: nonEmptyStrings(testCase.expectedClaims.map((claim) => claim.semanticKey)),
      sourceRefs: testCase.sourceRefs,
      priority: testCase.priority,
    })),
  };
}

function toProposedStep(step: IntentStep, keyById: ReadonlyMap<string, string>): TestPlanProposal["testCases"][number]["steps"][number] {
  if (step.kind !== "verify") return step;
  return { kind: "verify", claimSemanticKeys: nonEmptyStrings(step.claimIds.map((id) => keyById.get(id) ?? "")) };
}

export class TestPlanService {
  constructor(
    private readonly repository: TestPlanRepository,
    private readonly clock: Clock,
    private readonly projectExists: (projectId: string) => Promise<boolean>,
    private readonly validator = new TestPlanProposalValidator(),
  ) {}

  async ingestPrd(command: IngestPrdCommand): Promise<PrdDocumentValue> {
    const prdId = command.idempotencyKey;
    const existing = await this.repository.getPrdDocumentById(prdId);
    if (existing !== undefined) {
      this.assertPrdReplay(existing, command);
      return existing;
    }
    if (!await this.projectExists(command.projectId)) throw new TestPlanServiceError("PlanProjectMismatch", "project was not found");
    const revisions = await this.repository.listPrdDocuments(command.projectId);
    const revision = revisions.reduce((highest, document) => Math.max(highest, document.revision), 0) + 1;
    const document = PrdDocument.create({ prdId, projectId: command.projectId, title: command.title, content: command.content, revision }, this.clock);
    await this.repository.savePrdDocument(document);
    const persisted = await this.repository.getPrdDocumentById(prdId) ?? document;
    this.assertPrdReplay(persisted, command);
    return persisted;
  }

  listPrds(projectId: string): Promise<readonly PrdDocumentValue[]> {
    return this.repository.listPrdDocuments(projectId);
  }

  private assertPrdReplay(document: PrdDocumentValue, command: IngestPrdCommand): void {
    if (document.projectId !== command.projectId || document.title !== command.title || document.content !== command.content) {
      throw new TestPlanServiceError("PrdIdempotencyConflict", "idempotency key is bound to another PRD revision");
    }
  }

  async recordPrd(document: PrdDocumentValue): Promise<void> {
    await this.repository.savePrdDocument(document);
  }

  async create(command: CreateTestPlanCommand): Promise<TestPlanRevision> {
    const document = await this.repository.getPrdDocument(command.prdId, command.prdRevision);
    if (document === undefined) throw new TestPlanServiceError("PrdSourceMismatch", "PRD revision was not found");
    if (document.projectId !== command.projectId) throw new TestPlanServiceError("PlanProjectMismatch", "PRD project does not match the command");
    if (document.contentSha256 !== command.sourceContentSha256) throw new TestPlanServiceError("PrdSourceMismatch", "PRD content hash does not match the selected revision");
    const validated = this.validator.validate(document, parseProposal(command.proposal));
    if (!validated.ok) throw new TestPlanServiceError(validated.error.code, validated.error.message);
    const draft = createDraftTestPlan({ projectId: command.projectId, prdId: command.prdId, prdRevision: command.prdRevision, proposal: validated.value }, deterministicIds(command.idempotencyKey));
    if (!draft.ok) throw new TestPlanServiceError("InvalidPlanningProposal", draft.error.message);
    return this.repository.saveDraft({ plan: draft.value, idempotencyKey: command.idempotencyKey, createdAt: this.clock.now() });
  }

  async approve(command: ApproveTestPlanInput): Promise<TestPlanRevision> {
    const plan = await this.repository.get(command.planId);
    if (plan === undefined) throw new TestPlanServiceError("PlanNotFound", "Test Plan was not found");
    const document = await this.repository.getPrdDocument(plan.prdId, plan.prdRevision);
    if (document === undefined || document.projectId !== plan.projectId) throw new TestPlanServiceError("PrdSourceMismatch", "Test Plan PRD provenance is unavailable");
    const validated = this.validator.validate(document, proposalFromPlan(plan));
    if (!validated.ok) throw new TestPlanServiceError(validated.error.code, validated.error.message);
    return this.repository.approve({ ...command, clock: this.clock });
  }
}
