import { expect, it } from "vitest";
import { PrdDocument } from "@qualigence/context-intake";
import { createDraftTestPlan, MissionIntakeService, TestPlanService, testPlanSnapshotHash, type PrdMissionRepository, type TestPlanRepository, type TestPlanRevision } from "@qualigence/mission";
import { createTargetRevision, type ProjectTargetRepository } from "@qualigence/project-target";
import { sequentialIds, validatedProposal } from "../../unit/core-modules/mission/fixtures.js";

const clock = { now: () => "2026-08-21T00:00:00.000Z" };

export interface ProductIntakeProvider {
  readonly targets: ProjectTargetRepository;
  readonly plans: TestPlanRepository;
  readonly missions: PrdMissionRepository;
  seedPrd(document: ReturnType<typeof PrdDocument.create>): Promise<void>;
  close(): Promise<void>;
}

export interface ProductIntakeProviderFactory {
  open(): Promise<ProductIntakeProvider>;
  concurrent?<T>(
    operation: (provider: ProductIntakeProvider, index: number) => Promise<T>,
  ): Promise<readonly PromiseSettledResult<T>[]>;
}

async function runConcurrent<T>(
  factory: ProductIntakeProviderFactory,
  operation: (provider: ProductIntakeProvider, index: number) => Promise<T>,
): Promise<readonly PromiseSettledResult<T>[]> {
  if (factory.concurrent !== undefined) {
    return factory.concurrent(operation);
  }
  return Promise.allSettled([0, 1].map(async (index) => {
    const provider = await factory.open();
    try {
      return await operation(provider, index);
    } finally {
      await provider.close();
    }
  }));
}

function targetRevision(targetId: string, expectedVersion: number, displayName: string) {
  return createTargetRevision({
    targetId,
    projectId: "project-1",
    displayName,
    runnerId: "runner-1",
    expectedVersion,
    configuration: {
      kind: "web",
      startUrl: "https://example.test/",
      allowedOrigins: ["https://example.test"],
      browser: "chromium",
    },
  });
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

  it.each([
    ["create", 0],
    ["update", 1],
  ] as const)("returns the identical Target %s winner to overlapping same-key same-command callers", async (operationName, expectedVersion) => {
    const targetId = `target-idempotent-${operationName}`;
    if (expectedVersion === 1) {
      const setup = await factory.open();
      try {
        await setup.targets.saveRevision({ revision: targetRevision(targetId, 0, "Initial"), expectedVersion: 0, idempotencyKey: `${targetId}-initial`, createdAt: clock.now() });
      } finally { await setup.close(); }
    }
    const revision = targetRevision(targetId, expectedVersion, "Winner");
    const outcomes = await runConcurrent(factory, (provider) => provider.targets.saveRevision({ revision, expectedVersion, idempotencyKey: `${targetId}-shared`, createdAt: clock.now() }));

    expect(outcomes).toEqual([
      { status: "fulfilled", value: revision },
      { status: "fulfilled", value: revision },
    ]);
  });

  it.each([
    ["create", 0],
    ["update", 1],
  ] as const)("atomically binds a concurrent Target %s idempotency key to one complete command", async (operationName, expectedVersion) => {
    const targetId = `target-idempotency-conflict-${operationName}`;
    if (expectedVersion === 1) {
      const setup = await factory.open();
      try {
        await setup.targets.saveRevision({ revision: targetRevision(targetId, 0, "Initial"), expectedVersion: 0, idempotencyKey: `${targetId}-initial`, createdAt: clock.now() });
      } finally { await setup.close(); }
    }
    const commands = [targetRevision(targetId, expectedVersion, "Command A"), targetRevision(targetId, expectedVersion, "Command B")] as const;
    const outcomes = await runConcurrent(factory, (provider, index) => provider.targets.saveRevision({ revision: commands[index]!, expectedVersion, idempotencyKey: `${targetId}-shared`, createdAt: clock.now() }));
    const fulfilled = outcomes.find((outcome): outcome is PromiseFulfilledResult<(typeof commands)[number]> => outcome.status === "fulfilled");
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");

    expect(fulfilled).toBeDefined();
    expect(rejected?.reason).toMatchObject({ code: "TargetIdempotencyConflict", currentVersion: expectedVersion + 1 });
    const verify = await factory.open();
    try {
      expect(await verify.targets.getRevision(targetId)).toEqual(fulfilled!.value);
      expect(await verify.targets.getRevision(targetId, expectedVersion + 2)).toBeUndefined();
    } finally { await verify.close(); }
  });

  it("returns one Test Plan create winner and one authoritative conflict for stale different keys", async () => {
    const setup = await factory.open();
    let plan: TestPlanRevision;
    try {
      const document = PrdDocument.create({ prdId: "plan-create-race-prd", projectId: "p", revision: 1, title: "Plan", content: "Plan requirement" }, clock);
      await setup.seedPrd(document);
      const created = createDraftTestPlan({ projectId: "p", prdId: document.prdId, prdRevision: 1, proposal: validatedProposal() }, sequentialIds("plan-create-race"));
      if (!created.ok) throw new Error(created.error.code);
      plan = created.value;
    } finally { await setup.close(); }
    const outcomes = await runConcurrent(factory, (provider, index) => provider.plans.saveDraft({ plan, idempotencyKey: `plan-create-race-${index}`, createdAt: clock.now() }));

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "PlanVersionConflict", currentVersion: 1 });
  });

  it("returns the identical Test Plan create winner to overlapping same-key same-command callers", async () => {
    const setup = await factory.open();
    let plan: TestPlanRevision;
    try {
      const document = PrdDocument.create({ prdId: "plan-create-idempotent-prd", projectId: "p", revision: 1, title: "Plan", content: "Plan requirement" }, clock);
      await setup.seedPrd(document);
      const created = createDraftTestPlan({ projectId: "p", prdId: document.prdId, prdRevision: 1, proposal: validatedProposal() }, sequentialIds("plan-create-idempotent"));
      if (!created.ok) throw new Error(created.error.code);
      plan = created.value;
    } finally { await setup.close(); }
    const outcomes = await runConcurrent(factory, (provider) => provider.plans.saveDraft({ plan, idempotencyKey: "plan-create-idempotent-shared", createdAt: clock.now() }));

    expect(outcomes).toEqual([
      { status: "fulfilled", value: plan },
      { status: "fulfilled", value: plan },
    ]);
  });

  it("atomically binds a concurrent Test Plan create idempotency key to one complete command", async () => {
    const setup = await factory.open();
    const plans: TestPlanRevision[] = [];
    try {
      const document = PrdDocument.create({ prdId: "plan-create-conflict-prd", projectId: "p", revision: 1, title: "Plan", content: "Plan requirement" }, clock);
      await setup.seedPrd(document);
      for (const suffix of ["a", "b"]) {
        const created = createDraftTestPlan({ projectId: "p", prdId: document.prdId, prdRevision: 1, proposal: validatedProposal() }, sequentialIds(`plan-create-conflict-${suffix}`));
        if (!created.ok) throw new Error(created.error.code);
        plans.push(created.value);
      }
    } finally { await setup.close(); }
    const outcomes = await runConcurrent(factory, (provider, index) => provider.plans.saveDraft({ plan: plans[index]!, idempotencyKey: "plan-create-conflict-shared", createdAt: clock.now() }));
    const fulfilled = outcomes.find((outcome): outcome is PromiseFulfilledResult<(typeof plans)[number]> => outcome.status === "fulfilled");
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");

    expect(fulfilled).toBeDefined();
    expect(rejected?.reason).toMatchObject({ code: "IdempotencyConflict", currentVersion: 1 });
    const loser = plans.find((plan) => plan.planId !== fulfilled!.value.planId);
    const verify = await factory.open();
    try {
      expect(await verify.plans.get(fulfilled!.value.planId)).toEqual(fulfilled!.value);
      expect(await verify.plans.get(loser!.planId)).toBeUndefined();
    } finally { await verify.close(); }
  });

  it("returns the identical Test Plan approval winner to overlapping same-key same-command callers", async () => {
    const setup = await factory.open();
    let planId: string;
    try {
      const document = PrdDocument.create({ prdId: "approve-idempotent-prd", projectId: "p", revision: 1, title: "Plan", content: "Plan requirement" }, clock);
      await setup.seedPrd(document);
      const created = createDraftTestPlan({ projectId: "p", prdId: document.prdId, prdRevision: 1, proposal: validatedProposal() }, sequentialIds("approve-idempotent"));
      if (!created.ok) throw new Error(created.error.code);
      planId = created.value.planId;
      await setup.plans.saveDraft({ plan: created.value, idempotencyKey: "approve-idempotent-create", createdAt: clock.now() });
    } finally { await setup.close(); }
    const outcomes = await runConcurrent(factory, (provider) => provider.plans.approve({ planId, expectedVersion: 1, reviewerId: "tester", idempotencyKey: "approve-idempotent-shared", clock }));
    const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<TestPlanRevision> => outcome.status === "fulfilled");

    expect(fulfilled).toHaveLength(2);
    expect(fulfilled[0]?.value).toEqual(fulfilled[1]?.value);
  });

  it("atomically binds a concurrent Test Plan approval idempotency key to one complete command", async () => {
    const setup = await factory.open();
    let planId: string;
    try {
      const document = PrdDocument.create({ prdId: "approve-conflict-prd", projectId: "p", revision: 1, title: "Plan", content: "Plan requirement" }, clock);
      await setup.seedPrd(document);
      const created = createDraftTestPlan({ projectId: "p", prdId: document.prdId, prdRevision: 1, proposal: validatedProposal() }, sequentialIds("approve-conflict"));
      if (!created.ok) throw new Error(created.error.code);
      planId = created.value.planId;
      await setup.plans.saveDraft({ plan: created.value, idempotencyKey: "approve-conflict-create", createdAt: clock.now() });
    } finally { await setup.close(); }
    const outcomes = await runConcurrent(factory, (provider, index) => provider.plans.approve({ planId, expectedVersion: 1, reviewerId: `reviewer-${index}`, idempotencyKey: "approve-conflict-shared", clock }));
    const fulfilled = outcomes.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<ProductIntakeProvider["plans"]["approve"]>>> => outcome.status === "fulfilled");
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");

    expect(fulfilled).toBeDefined();
    expect(rejected?.reason).toMatchObject({ code: "IdempotencyConflict", currentVersion: 2 });
    const verify = await factory.open();
    try {
      expect(await verify.plans.get(planId)).toEqual(fulfilled!.value);
      expect(await verify.plans.get(planId, 1)).toMatchObject({ status: "draft", version: 1 });
    } finally { await verify.close(); }
  });

  it("atomically binds a concurrent Mission idempotency key to one complete command", async () => {
    const setup = await factory.open();
    const commands: Array<{ projectId: string; targetId: string; targetVersion: number; targetSnapshotHash: string; planId: string; planVersion: number; idempotencyKey: string }> = [];
    try {
      const document = PrdDocument.create({ prdId: "mission-prd", projectId: "mission-project", revision: 1, title: "Mission", content: "Mission requirement" }, clock);
      await setup.seedPrd(document);
      for (const index of [0, 1]) {
        const target = createTargetRevision({ targetId: `mission-target-${index}`, projectId: "mission-project", displayName: `Target ${index}`, runnerId: `runner-${index}`, expectedVersion: 0, configuration: { kind: "web", startUrl: `https://target-${index}.example.test/`, allowedOrigins: [`https://target-${index}.example.test`], browser: "chromium" } });
        await setup.targets.saveRevision({ revision: target, expectedVersion: 0, idempotencyKey: `mission-target-command-${index}`, createdAt: clock.now() });
        const created = createDraftTestPlan({ projectId: "mission-project", prdId: document.prdId, prdRevision: 1, proposal: validatedProposal() }, sequentialIds(`mission-plan-${index}`));
        if (!created.ok) throw new Error(created.error.code);
        await setup.plans.saveDraft({ plan: created.value, idempotencyKey: `mission-plan-command-${index}`, createdAt: clock.now() });
        const approved = await setup.plans.approve({ planId: created.value.planId, expectedVersion: 1, reviewerId: "tester", idempotencyKey: `mission-plan-approve-${index}`, clock });
        commands.push({ projectId: "mission-project", targetId: target.targetId, targetVersion: target.version, targetSnapshotHash: target.snapshotHash, planId: approved.planId, planVersion: approved.version, idempotencyKey: "shared-mission-command" });
      }
    } finally { await setup.close(); }

    const operation = (provider: ProductIntakeProvider, index: number) => new MissionIntakeService(provider.targets, provider.plans, provider.missions, clock).create(commands[index]!);
    const outcomes = factory.concurrent === undefined
      ? await Promise.allSettled([factory.open().then(async (provider) => { try { return await operation(provider, 0); } finally { await provider.close(); } }), factory.open().then(async (provider) => { try { return await operation(provider, 1); } finally { await provider.close(); } })])
      : await factory.concurrent(operation);
    const fulfilled = outcomes.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof operation>>> => outcome.status === "fulfilled");
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(fulfilled).toBeDefined();
    expect(rejected?.reason).toMatchObject({ code: "MissionIdempotencyConflict", currentVersion: 1 });

    const verify = await factory.open();
    try {
      const persisted = await verify.missions.loadMissionForDispatch(fulfilled!.value.missionId);
      const persistedPlan = await verify.plans.get(fulfilled!.value.planId, fulfilled!.value.planVersion);
      expect(persisted?.jobs).toHaveLength(1);
      expect(persisted?.dispatch.binding).toMatchObject({ targetId: fulfilled!.value.targetId, runnerId: fulfilled!.value.runnerId, planVersion: fulfilled!.value.planVersion, planSnapshotHash: testPlanSnapshotHash(persistedPlan!) });
      expect(persisted?.planId).toBe(fulfilled!.value.planId);
    } finally { await verify.close(); }
  });

  it("allocates unique monotonic project revisions for concurrent different PRDs", async () => {
    const operation = (provider: ProductIntakeProvider, index: number) => new TestPlanService(provider.plans, clock, async () => true).ingestPrd({
      idempotencyKey: `concurrent-prd-${index}`,
      projectId: "concurrent-prd-project",
      title: `PRD ${index}`,
      content: `Requirement ${index}`,
    });
    const outcomes = factory.concurrent === undefined
      ? await Promise.allSettled([factory.open().then(async (provider) => { try { return await operation(provider, 0); } finally { await provider.close(); } }), factory.open().then(async (provider) => { try { return await operation(provider, 1); } finally { await provider.close(); } })])
      : await factory.concurrent(operation);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (rejected !== undefined) throw rejected.reason;
    const revisions = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [(outcome.value as Awaited<ReturnType<typeof operation>>).revision] : []).sort();
    expect(revisions).toEqual([1, 2]);
  });
}
