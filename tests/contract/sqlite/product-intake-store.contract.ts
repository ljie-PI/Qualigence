import { expect, it } from "vitest";
import { PrdDocument } from "@qualigence/context-intake";
import { createDraftTestPlan, type TestPlanRepository } from "@qualigence/mission";
import { createTargetRevision, type ProjectTargetRepository } from "@qualigence/project-target";
import { sequentialIds, validatedProposal } from "../../unit/core-modules/mission/fixtures.js";

const clock = { now: () => "2026-08-21T00:00:00.000Z" };

export interface ProductIntakeProvider {
  readonly targets: ProjectTargetRepository;
  readonly plans: TestPlanRepository;
  seedPrd(document: ReturnType<typeof PrdDocument.create>): Promise<void>;
  close(): Promise<void>;
}

export interface ProductIntakeProviderFactory {
  open(): Promise<ProductIntakeProvider>;
  concurrent?(
    operation: (provider: ProductIntakeProvider) => Promise<unknown>,
  ): Promise<readonly PromiseSettledResult<unknown>[]>;
}

export function productIntakeProviderContract(factory: ProductIntakeProviderFactory): void {
  it("preserves immutable revisions and rejects project drift", async () => {
    const provider = await factory.open();
    try {
      const first = createTargetRevision({ targetId: "target-1", projectId: "project-1", displayName: "Web", runnerId: "runner-1", expectedVersion: 0, configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" } });
      await provider.targets.saveRevision({ revision: first, expectedVersion: 0, idempotencyKey: "target-create", createdAt: clock.now() });
      const drift = createTargetRevision({ targetId: "target-1", projectId: "project-2", displayName: "Web", runnerId: "runner-1", expectedVersion: 1, configuration: first.configuration });
      await expect(provider.targets.saveRevision({ revision: drift, expectedVersion: 1, idempotencyKey: "target-drift", createdAt: clock.now() })).rejects.toMatchObject({ code: "InvalidTargetConfiguration" });
      expect(await provider.targets.getRevision("target-1", 1)).toEqual(first);
    } finally { await provider.close(); }
  });

  it("loads the selected PRD and stores approval as a new immutable revision", async () => {
    const provider = await factory.open();
    try {
      const document = PrdDocument.create({ prdId: "prd-1", projectId: "p", revision: 1, title: "Cart", content: "Cart total equals the sum of item prices. Checkout is enabled." }, clock);
      await provider.seedPrd(document);
      expect(await provider.plans.getPrdDocument("prd-1", 1)).toEqual(document);
      const created = createDraftTestPlan({ projectId: "p", prdId: "prd-1", prdRevision: 1, proposal: validatedProposal() }, sequentialIds("approval"));
      if (!created.ok) throw new Error(created.error.code);
      await provider.plans.saveDraft({ plan: created.value, idempotencyKey: "plan-create", createdAt: clock.now() });
      const approved = await provider.plans.approve({ planId: created.value.planId, expectedVersion: 1, reviewerId: "tester", idempotencyKey: "plan-approve", clock });
      expect(approved).toMatchObject({ status: "approved", version: 2 });
      expect(await provider.plans.get(created.value.planId, 1)).toMatchObject({ status: "draft", version: 1 });
    } finally { await provider.close(); }
  });

  it("returns one approval and one stable conflict for concurrent writers", async () => {
    const setup = await factory.open();
    let planId: string;
    try {
      const created = createDraftTestPlan({ projectId: "p", prdId: "prd-1", prdRevision: 1, proposal: validatedProposal() }, sequentialIds("concurrent"));
      if (!created.ok) throw new Error(created.error.code);
      planId = created.value.planId;
      await setup.plans.saveDraft({ plan: created.value, idempotencyKey: "concurrent-plan-create", createdAt: clock.now() });
    } finally { await setup.close(); }
    const operation = (provider: ProductIntakeProvider) => provider.plans.approve({ planId, expectedVersion: 1, reviewerId: "tester", idempotencyKey: crypto.randomUUID(), clock });
    const outcomes = factory.concurrent === undefined
      ? await Promise.allSettled([factory.open().then(async (provider) => { try { return await operation(provider); } finally { await provider.close(); } }), factory.open().then(async (provider) => { try { return await operation(provider); } finally { await provider.close(); } })])
      : await factory.concurrent(operation);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "PlanVersionConflict", currentVersion: 2 });
  });

  it.each([
    ["create", 0],
    ["update", 1],
  ] as const)("maps concurrent Target %s races to the authoritative current version", async (operationName, expectedVersion) => {
    const targetId = `target-race-${operationName}`;
    if (expectedVersion === 1) {
      const setup = await factory.open();
      try {
        const initial = createTargetRevision({ targetId, projectId: "project-1", displayName: "Initial", runnerId: "runner-1", expectedVersion: 0, configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" } });
        await setup.targets.saveRevision({ revision: initial, expectedVersion: 0, idempotencyKey: "target-race-initial", createdAt: clock.now() });
      } finally { await setup.close(); }
    }
    const operation = (provider: ProductIntakeProvider) => {
      const revision = createTargetRevision({ targetId, projectId: "project-1", displayName: crypto.randomUUID(), runnerId: "runner-1", expectedVersion, configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" } });
      return provider.targets.saveRevision({ revision, expectedVersion, idempotencyKey: crypto.randomUUID(), createdAt: clock.now() });
    };
    const outcomes = factory.concurrent === undefined
      ? await Promise.allSettled([factory.open().then(async (provider) => { try { return await operation(provider); } finally { await provider.close(); } }), factory.open().then(async (provider) => { try { return await operation(provider); } finally { await provider.close(); } })])
      : await factory.concurrent(operation);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "TargetVersionConflict", currentVersion: expectedVersion + 1 });
  });
}
