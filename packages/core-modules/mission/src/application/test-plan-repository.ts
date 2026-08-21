import type { Clock } from "@qualigence/shared-kernel";
import type { PrdDocument } from "@qualigence/context-intake";
import type { TestPlanRevision } from "../domain/test-plan-revision.js";

export interface SaveDraftTestPlanInput {
  readonly plan: TestPlanRevision;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface ApproveStoredTestPlanInput {
  readonly planId: string;
  readonly expectedVersion: number;
  readonly reviewerId: string;
  readonly idempotencyKey: string;
  readonly clock: Clock;
}

export interface TestPlanRepository {
  savePrdDocument(document: PrdDocument): Promise<void>;
  getPrdDocumentById(prdId: string): Promise<PrdDocument | undefined>;
  listPrdDocuments(projectId: string): Promise<readonly PrdDocument[]>;
  saveDraft(input: SaveDraftTestPlanInput): Promise<TestPlanRevision>;
  approve(input: ApproveStoredTestPlanInput): Promise<TestPlanRevision>;
  get(planId: string, version?: number): Promise<TestPlanRevision | undefined>;
  getPrdDocument(prdId: string, revision: number): Promise<PrdDocument | undefined>;
}
