# [LS-07] PRD 到 Test Case/Mission/Execution Job 设计

- 状态：批量设计草案，待整体审阅
- Milestone：PRD Bridge
- 直接依赖：LS-03、LS-04
- 下游：LS-08、LS-09、LS-11

## 1. 目标与边界

本能力包把 PRD 文本转成有来源、可审阅、可执行的 Expected Claims、结构化 Test Cases、Test Mission 和 Execution Jobs，并通过共享应用接口运行。规划模型只产生 Proposal；确定性代码负责 Schema、来源、能力、预算和状态迁移。

范围内：纯文本/Markdown PRD、单项目、人工批准测试计划、WebTarget、结构化意图步骤、Mission 编译和执行结果聚合。

范围外：Office/PDF OCR、Git/PR Connector、自动需求变更同步、无审阅直接生产执行、CSS/XPath、Cloud 多租户 UI。

## 2. 模块结构

```text
packages/core-modules/context-intake/
packages/core-modules/application-model/
packages/core-modules/mission/
packages/runner-components/model-agent/src/prd-planning-agent.ts
packages/contracts/model-provider/src/operations.ts
packages/execution-application/src/mission-execution-use-case.ts
tests/unit/core-modules/context-intake/
tests/unit/core-modules/application-model/
tests/unit/core-modules/mission/
tests/component/prd-planning/
```

模块外只导入各包 `public.ts`。Mission 不读取 Application Model repository；通过公开 query/command DTO 交换数据。

## 3. 冻结领域类型

```ts
export interface PrdDocument {
  readonly prdId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly title: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly ingestedAt: string;
}

export interface PrdSourceRef {
  readonly prdId: string;
  readonly revision: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly quotedTextSha256: string;
}

export interface ExpectedClaim {
  readonly claimId: string;
  readonly semanticKey: string;
  readonly statement: string;
  readonly sourceRefs: readonly [PrdSourceRef, ...PrdSourceRef[]];
  readonly confidence: number;
}

export type IntentStep =
  | { readonly kind: "navigate"; readonly path: string }
  | { readonly kind: "click"; readonly target: SemanticTarget }
  | { readonly kind: "input"; readonly target: SemanticTarget; readonly valueRef: string }
  | { readonly kind: "verify"; readonly claimIds: readonly [string, ...string[]] };

export interface SemanticTarget {
  readonly role?: string;
  readonly name?: string;
  readonly purpose: string;
}

export interface TestCase {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly [IntentStep, ...IntentStep[]];
  readonly expectedClaims: readonly [ExpectedClaim, ...ExpectedClaim[]];
  readonly sourceRefs: readonly [PrdSourceRef, ...PrdSourceRef[]];
  readonly priority: "low" | "medium" | "high";
}

export interface TestMission {
  readonly missionId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly targetId: string;
  readonly testCaseIds: readonly [string, ...string[]];
  readonly executionBudget: MissionBudget;
  readonly status: "draft" | "approved" | "running" | "completed" | "blocked";
}
```

`ExecutionJob` 保存 Mission/TestCase/revision 引用、不可变步骤快照、Expected Claim IDs、预算和 required capabilities。Runner Protocol 的 `AcceptedExecutionJob` 增加可选 `plan`，不破坏 M1 单 objective Job。

## 4. Planning Proposal 与确定性校验

Model Operation 增加 `planning.prd-test-cases`。模型输入只包含 PRD 分段、项目/目标摘要和输出 Schema；输出：

```ts
export interface TestPlanProposal {
  readonly expectedClaims: readonly ProposedExpectedClaim[];
  readonly testCases: readonly ProposedTestCase[];
}
```

`PrdPlanningAgent` 不生成 ID、不写 Repository、不创建 Mission。`TestPlanProposalValidator` 必须：

- 验证 source offset 范围与 hash 对应原文。
- 拒绝空 claim、重复 semantic key、无来源 TestCase。
- 拒绝 CSS、XPath、坐标、脚本和 URL credential。
- 校验每个 verify claimId 存在。
- 校验 Step kind 在 Target capability 内；M1 未支持 input 时 Plan 可保存，但执行前返回明确 `CapabilityMismatch`。
- 将模型 confidence 限制在 `[0,1]`，但不把其当作审批。

校验通过后确定性 ID 使用 UUIDv7；相同 `prd revision + normalized proposal hash` 幂等返回原计划。

## 5. 状态与数据流

```text
PRD ingest
→ create Planning Intelligence request
→ Model Gateway proposal
→ deterministic validation
→ Draft Test Plan
→ human ApproveTestPlan(expectedVersion)
→ Expected Claims append
→ MissionCompiler
→ Execution Jobs
→ MissionExecutionUseCase
→ RunExecutionUseCase/Runner
→ Mission result projection
```

Draft、Approved 不覆盖；PRD 新 revision 创建新的 Test Plan revision。Approval 必须携带 expectedVersion、reviewerId、idempotencyKey。执行中 PRD 更新不改变已发 Job 快照。

Mission Orchestrator 首版按 TestCase 顺序发 Job；同一 TestCase 的 IntentStep 在 Runner 内按检查点顺序执行。任何步骤 blocked 时停止该 TestCase 后续步骤；其他 TestCase 是否继续由 Mission policy 决定。

## 6. 持久化与错误

新增逻辑表：`prd_documents`、`test_plan_revisions`、`expected_claims`、`test_cases`、`missions`、`mission_revisions`、`execution_jobs`、`execution_job_attempts`。Local 使用 SQLite；LS-11 使用相同 Kysely schema 的 PostgreSQL 方言实现。

稳定错误：`PrdEmpty`、`PrdSourceMismatch`、`InvalidPlanningProposal`、`SelectorLeakRejected`、`PlanVersionConflict`、`PlanNotApproved`、`TargetCapabilityMismatch`、`MissionBudgetExceeded`。

模型失败不产生半成品 Approved Plan；可以保留脱敏 Planning Invocation summary。过期 Proposal 必须针对新 revision 重算。

## 7. 安全与隐私

- PRD 按敏感数据处理；Data Policy 不允许出站时不调用远程 Planner。
- 日志不记录全文和 source quote，只记录 PRD ID/revision/hash。
- valueRef 引用测试数据/Secret，不把密码写入 TestCase。
- 用户批准的是结构化 Plan revision，不能只批准模型聊天文本。

## 8. 测试责任

- Unit：offset/hash、selector 泄漏、claim 关系、version conflict、Mission 状态机。
- Contract：Planning Schema 与 Model Gateway correction；SQLite schema conformance。
- Component：固定 PRD + deterministic planner → Draft → approve → Mission →购物车执行。
- E2E：CLI/API 入口不启动另一个 CLI 子进程，直接调用应用用例。

## 9. 出口 Gate

固定 PRD 能产生有来源、无 selector 的 Test Cases；人工批准后编译为版本化 Mission/Jobs；支持能力的 Job 经共享执行接口运行；PRD revision、Plan、Claim、Job、Run 和 Finding 可全链路追溯。

