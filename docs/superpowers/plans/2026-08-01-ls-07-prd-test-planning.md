# [LS-07] PRD Test Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Markdown/text PRDs into source-grounded Expected Claims, approved Test Cases, versioned Missions and executable Jobs without selectors or direct model writes.

**Architecture:** Context Intake stores immutable PRD revisions; a Model Agent emits a proposal; deterministic validation and Core command handlers create/approve plan revisions; Mission Compiler snapshots approved intent into Jobs consumed by shared execution interfaces.

**Tech Stack:** TypeScript, Zod/JSON Schema, Model Gateway, Kysely providers, Vitest.

**Direct Dependencies:** LS-03 and LS-04.

## Global Constraints

- Planner never starts the CLI, imports storage providers, creates IDs or writes aggregates.
- No CSS/XPath/coordinate/script may enter TestCase or Job.
- Every Claim/TestCase has valid PRD source offsets and hashes.
- Approval uses expectedVersion/reviewer/idempotency and execution snapshots immutable revisions.
- Tests remain under top-level `tests/`.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

### Task 1: Implement PRD revision and source-reference validation

**Files:**

- Create: `packages/core-modules/context-intake/package.json`
- Create: `packages/core-modules/context-intake/tsconfig.json`
- Create: `packages/core-modules/context-intake/src/domain/prd-document.ts`
- Create: `packages/core-modules/context-intake/src/application/prd-intake-service.ts`
- Create: `packages/core-modules/context-intake/src/public.ts`
- Create: `packages/core-modules/context-intake/src/index.ts`
- Test: `tests/unit/core-modules/context-intake/prd-document.test.ts`
- Modify: `tsconfig.json`

**Interfaces:** Produces `PrdDocument`, `PrdSourceRef`, `PrdIntakeService.ingest` and `verifySourceRef`.

- [ ] **Step 1: Write hash/offset/revision tests**

```ts
const doc = PrdDocument.create({ projectId: "p", title: "Cart", content: "Total equals item price." }, clock);
expect(verifySourceRef(doc, ref(0, 5, sha256("Total")))).toBe(true);
expect(verifySourceRef(doc, ref(0, 6, sha256("Total")))).toBe(false);
```

Same content/hash is idempotent; changed content creates next revision; empty content returns `PrdEmpty`.

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/core-modules/context-intake/prd-document.test.ts`

Expected: module missing.

- [ ] **Step 3: Implement immutable revision rules**

Use UUIDv7 at application service, SHA-256 UTF-8 content, JS string offset convention documented as UTF-16 code units, and exact quoted substring hash. Export only public boundary.

```ts
export class PrdIntakeService {
  ingest(input: IngestPrdInput): Promise<PrdDocument>;
}
export function verifySourceRef(document: PrdDocument, ref: PrdSourceRef): boolean;
```

- [ ] **Step 4: Confirm GREEN**

Run Task 1 command; expect Unicode/offset/hash/idempotency/revision cases pass.

- [ ] **Step 5: Commit**

```text
git add packages/core-modules/context-intake tests/unit/core-modules/context-intake tsconfig.json
git commit -m "feat(prd): ingest immutable prd revisions"
```

### Task 2: Add Application Model claims and deterministic Proposal validation

**Files:**

- Create: `packages/core-modules/application-model/package.json`
- Create: `packages/core-modules/application-model/tsconfig.json`
- Create: `packages/core-modules/application-model/src/domain/expected-claim.ts`
- Create: `packages/core-modules/application-model/src/application/test-plan-proposal-validator.ts`
- Create: `packages/core-modules/application-model/src/public.ts`
- Create: `packages/core-modules/application-model/src/index.ts`
- Test: `tests/unit/core-modules/application-model/test-plan-proposal-validator.test.ts`

**Interfaces:** Consumes `PrdDocument` and provider-neutral `TestPlanProposal` with `ProposedIntentStep.claimSemanticKeys`; produces validated Claims/TestCases without IDs.

- [ ] **Step 1: Write rejection matrix**

Accept a grounded click/verify proposal. Reject bad offset/hash, duplicate semantic key, missing claim, empty steps, `css=`, XPath (`//`), coordinates, script, URL credentials, unknown action and confidence outside `[0,1]` with exact Design error codes.

```ts
expect(validator.validate(document, groundedProposal)).toMatchObject({ ok: true });
expect(validator.validate(document, proposalWith("css=#buy"))).toMatchObject({ ok: false, error: { code: "SelectorLeakRejected" } });
expect(validator.validate(document, badSourceProposal)).toMatchObject({ ok: false, error: { code: "PrdSourceMismatch" } });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/core-modules/application-model/test-plan-proposal-validator.test.ts`

Expected: validator missing.

- [ ] **Step 3: Implement structural + semantic validation**

Use strict Zod for shape, then explicit source/relationship/forbidden-selector passes. Normalize semantic keys but keep statement text. Validate proposed Claim relationships by semantic key; the command handler later creates Claim IDs and compiles verify steps to final `claimIds`. Return an immutable validated value; do not save.

```ts
export class TestPlanProposalValidator {
  validate(document: PrdDocument, proposal: TestPlanProposal): Result<ValidatedTestPlanProposal, PlanningValidationError>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 2 command; expect every matrix row returns its exact code.

- [ ] **Step 5: Commit**

```text
git add packages/core-modules/application-model tests/unit/core-modules/application-model
git commit -m "feat(prd): validate grounded test plan proposals"
```

### Task 3: Implement Model-backed PRD Planning Agent

**Files:**

- Create: `packages/runner-components/model-agent/src/prd-planning-agent.ts`
- Modify: `packages/contracts/model-provider/src/index.ts`
- Modify: `packages/runner-components/model-agent/src/index.ts`
- Test: `tests/unit/runner-components/model-agent/prd-planning-agent.test.ts`

**Interfaces:** Adds Model Operation `planning.prd-test-cases`; returns `TestPlanProposal`, never domain entities.

- [ ] **Step 1: Write schema/correction/no-write tests**

Fake Gateway returns valid proposal and invalid source shape. Assert operation, strict Schema and one correction behavior; package dependencies must not contain any repository/storage package.

```ts
await agent.propose(document, targetSummary);
expect(gateway.invokeStructured).toHaveBeenCalledWith(expect.objectContaining({ operation: "planning.prd-test-cases" }), expect.any(Object));
expect(modelAgentPackageDependencies()).not.toContain("storage-providers");
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/runner-components/model-agent/prd-planning-agent.test.ts`

Expected: operation/agent missing.

- [ ] **Step 3: Implement Agent**

Send PRD ID/revision/content and target capability summary; parse strict proposal with Zod. Do not create IDs, validate source hashes or approve; those remain Task 2/Core responsibilities.

```ts
export class PrdPlanningAgent {
  propose(document: PrdDocument, target: TargetCapabilitySummary): Promise<TestPlanProposal>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 3 command; expect operation/schema/dependency-boundary tests pass.

- [ ] **Step 5: Commit**

```text
git add packages/contracts/model-provider packages/runner-components/model-agent tests/unit/runner-components/model-agent/prd-planning-agent.test.ts
git commit -m "feat(prd): propose test plans through model gateway"
```

### Task 4: Implement Test Plan approval, Mission and Jobs

**Files:**

- Create: `packages/core-modules/mission/package.json`
- Create: `packages/core-modules/mission/tsconfig.json`
- Create: `packages/core-modules/mission/src/domain/test-plan-revision.ts`
- Create: `packages/core-modules/mission/src/domain/test-mission.ts`
- Create: `packages/core-modules/mission/src/application/mission-compiler.ts`
- Create: `packages/core-modules/mission/src/application/mission-orchestrator.ts`
- Create: `packages/core-modules/mission/src/public.ts`
- Modify: `packages/contracts/runner-protocol/src/index.ts`
- Test: `tests/unit/core-modules/mission/test-plan-approval.test.ts`
- Test: `tests/unit/core-modules/mission/mission-compiler.test.ts`

**Interfaces:** Produces Approved Plan revisions, `TestMission`, `MissionBudget`, core `ExecutionJob`; adds exact optional `{missionId,missionRevision,testCaseId,steps,expectedClaimIds,budget}` plan snapshot to `AcceptedExecutionJob`.

- [ ] **Step 1: Write state/version/snapshot tests**

Draft cannot execute; approval with wrong expectedVersion returns `PlanVersionConflict`; duplicate idempotency returns original result; compiled Job contains immutable plan/claim/source revision; later PRD update does not mutate it; unsupported input action returns `TargetCapabilityMismatch` before dispatch.

```ts
await expect(approve({ planId, expectedVersion: 0, reviewerId: "r", idempotencyKey: "k" })).rejects.toMatchObject({ code: "PlanVersionConflict" });
const job = compiler.compile(approvedPlan, mission);
expect(job.testCaseSnapshot.sourceRefs[0]?.revision).toBe(approvedPlan.prdRevision);
expect(Object.isFrozen(job.testCaseSnapshot)).toBe(true);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/core-modules/mission`

Expected: Mission package missing.

- [ ] **Step 3: Implement state machines/compiler**

Use `draft|approved|running|completed|blocked`; allocate IDs only in handlers; persist approval actor/time; compiler snapshots exact TestCase and required capabilities; optional protocol `plan` preserves objective-only M1 jobs.

```ts
export class MissionCompiler {
  compile(plan: ApprovedTestPlan, mission: TestMission): readonly ExecutionJob[];
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 4 command and `pnpm typecheck`; expect old protocol consumers plus new Job tests compile/pass.

- [ ] **Step 5: Commit**

```text
git add packages/core-modules/mission packages/contracts/runner-protocol tests/unit/core-modules/mission
git commit -m "feat(mission): approve and compile prd test plans"
```

### Task 5: Persist and execute the PRD bridge

**Files:**

- Create: `packages/execution-application/src/mission-execution-use-case.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/migrations/002-prd-mission.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/sqlite-prd-mission-store.ts`
- Test: `tests/contract/sqlite/prd-mission-store.test.ts`
- Test: `tests/component/prd-planning/prd-to-run.test.ts`
- Modify: `packages/execution-application/src/index.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/index.ts`
- Modify: `docs/superpowers/implementation-status.md`

**Interfaces:** `MissionExecutionUseCase.execute(missionId)` dispatches supported Jobs through shared execution/Runner port; no CLI child process.

- [ ] **Step 1: Write persistence and end-to-end component tests**

Use fixed cart PRD and deterministic Planner; ingest→proposal→draft→approve→compile→execute. Assert source/Plan/Mission/Job/Run/Finding links after reopen. Spy on child_process and assert zero calls.

```ts
const result = await harness.planApproveAndExecute(cartPrd);
expect(result.trace).toMatchObject({ prdRevision: 1, planId: expect.any(String), missionId: expect.any(String), runId: expect.any(String) });
expect(childProcessSpawn).not.toHaveBeenCalled();
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/sqlite/prd-mission-store.test.ts tests/component/prd-planning/prd-to-run.test.ts`

Expected: migration/store/use case missing.

- [ ] **Step 3: Implement migration/store/use case**

Create eight Design tables with structured revision/status columns and JSON snapshots; expected-version updates are conditional; orchestrator stops unsupported/blocked TestCase steps per Mission policy and aggregates results.

```ts
export class MissionExecutionUseCase {
  execute(missionId: string): Promise<MissionExecutionResult>;
}
```

- [ ] **Step 4: Run LS-07 Gate**

```text
pnpm build
pnpm test
pnpm typecheck
pnpm smoke:node-imports
pnpm vitest run tests/component/prd-planning
git diff --check
```

Expected: all exit 0 and no selector/storage/CLI-process boundary violation is present.

- [ ] **Step 5: Commit/status**

```text
git add packages tests docs/superpowers/implementation-status.md
git commit -m "feat(prd): complete source-grounded planning bridge"
```

## Plan Self-Review

- Spec coverage: PRD revision/source, Proposal validation, Model Agent, approval/version, Mission/Jobs, persistence and direct application execution map to Tasks 1–5.
- Placeholder scan: all rejection cases, states, files and commands are explicit.
- Type consistency: Planner returns Proposal; validator returns validated values; handlers create entities; Mission dispatches shared execution jobs.
