# [LS-09] M2 Regression、有限探索与 Detection Benchmark v1 设计

- 状态：批量设计草案，待整体审阅
- Milestone：M2
- 直接依赖：LS-08
- 下游：LS-10、LS-11

## 1. 目标与边界

本能力包让已验证 Procedure Skill 可作为回归种子，并在确定性预算/Policy 内执行有限探索；同时建立带 Ground Truth 的 Detection Benchmark v1 和发布阈值。

探索不是无限自主 Agent。模型只能在当前 Graph、允许动作、风险级别、状态去重和预算内提出下一步；确定性控制器决定是否执行或停止。

范围外：生产探索、跨项目公共 Skill、自动生成无限测试、性能 Benchmark、Cloud 模型排行榜。

## 2. 模块与资产

```text
packages/core-modules/mission/src/exploration-policy.ts
packages/runner-components/exploration/
  src/exploration-controller.ts
  src/state-visit-tracker.ts
  src/exploration-budget.ts
packages/runner-components/model-agent/src/exploration-agent.ts
packages/benchmarking/detection/
  src/manifest.ts
  src/scorer.ts
  src/report.ts
apps/benchmark-runner/
benchmarks/detection-v1/
  manifest.json
  scenarios/*.json
  ground-truth/*.json
tests/unit/runner-components/exploration/
tests/unit/benchmarking/detection/
tests/e2e/detection-benchmark/
```

Benchmark scorer 不依赖 Model Gateway；它只读取结构化 Run/Finding/Ground Truth。

## 3. Regression 与 Exploration 契约

```ts
export interface RegressionJobPlan {
  readonly skillBundleId: string;
  readonly targetVersion: string;
  readonly repetitions: number;
  readonly stopOnFirstFailure: boolean;
}

export interface ExplorationPolicy {
  readonly seedSkillBundleIds: readonly string[];
  readonly allowedActionKinds: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly maximumSteps: number;
  readonly maximumWallClockMs: number;
  readonly maximumModelTokens: number;
  readonly maximumStateVisits: number;
  readonly maximumRecoveries: number;
  readonly riskCeiling: "ReadOnly" | "LocalMutation" | "RecoverableMutation";
}

export interface ExplorationDecision {
  readonly status: "act" | "stop";
  readonly action?: ProposedAction;
  readonly reason: string;
  readonly expectedNovelty?: string;
}

export interface ExplorationCheckpoint {
  readonly step: number;
  readonly graphFingerprint: string;
  readonly remaining: ExplorationBudgetSnapshot;
  readonly terminalReason?: ExplorationTerminalReason;
}
```

Terminal Reason 固定为 `objective_satisfied`、`no_safe_action`、`state_repeated`、`budget_exhausted`、`policy_denied`、`plan_diverged`、`finding_created` 或 `error`。

## 4. 有限探索算法

1. 先 replay Seed Skill 到已知 checkpoint。
2. 计算 Graph fingerprint：URL path、可交互节点语义、关键状态，排除时间戳/随机 ID。
3. 若相同 fingerprint 达到 `maximumStateVisits`，停止为 `state_repeated`。
4. 模型只接收当前 Graph、已访问摘要、允许 action kind 和剩余预算。
5. Schema Parser 校验 nodeId 存在、action allowlist、risk ceiling。
6. Runner Policy Gate 再授权；Policy 不能被模型输出覆盖。
7. 执行动作、观察、验证高置信信号和 Expected Claims。
8. 原子保存 Checkpoint 和预算消耗；达到任一上限立即停止。

生产环境默认拒绝 Exploration。首版只在可重置 Fixture/测试环境允许 `ReadOnly`、`LocalMutation`、`RecoverableMutation`；ExternalSideEffect 及以上始终拒绝。

## 5. Benchmark Manifest v1

```ts
export interface DetectionBenchmarkManifest {
  readonly schemaVersion: "detection-benchmark/v1";
  readonly benchmarkVersion: string;
  readonly referenceProfile: ReferenceModelProfile;
  readonly scenarios: readonly BenchmarkScenario[];
  readonly thresholds: DetectionThresholds;
}

export interface DetectionThresholds {
  readonly p0RecallMinimum: 1;
  readonly knownBugRecallMinimum: 0.8;
  readonly findingPrecisionMinimum: 0.6;
  readonly stableReproductionRateMinimum: 0.7;
  readonly maximumHighConfidenceFalsePositivesPerNormalMission: 1;
}
```

Reference Profile 固定 Provider/model ID、Prompt version、Policy Bundle hash、Skill Pack hash、Browser version、Fixture versions、maximum steps、预算和重复次数。Manifest 与 Ground Truth 都提交 Git；Report 保存输入 hashes。

## 6. 评分规则

- Finding 通过 `scenarioId + defectId` 匹配 Ground Truth；仅相似文本不算命中。
- Recall = 命中的已知缺陷 / 全部已知缺陷。
- Precision = 确认命中的 Finding / 全部高置信 Finding。
- P0/安全 deterministic 缺陷任一漏报即 Gate 失败。
- stable reproduction rate 只计算标记 `stable=true` 的缺陷。
- normal 版本每个 30 分钟 Mission 高置信误报 >1 即失败。
- 同一场景重复运行按 Manifest 聚合；禁止只挑最好一次。

BYO Profile 可运行相同 Benchmark，但只生成 `unverified` Report，不获得 Reference Profile 发布声明。

## 7. 幂等、持久化和错误

Benchmark Run ID 由 manifest hash + profile hash + repetition 组成；重复执行保存新 attempt，不覆盖历史 Report。探索 Checkpoint 与预算同事务提交，Core/Runner 重启从最后安全 checkpoint 恢复。

错误：`ExplorationNotAllowed`、`ExplorationBudgetExceeded`、`RepeatedState`、`UnsafeExplorationAction`、`BenchmarkManifestInvalid`、`GroundTruthMismatch`、`ReferenceProfileMismatch`、`BenchmarkThresholdFailed`。

## 8. 测试与出口 Gate

- Unit：fingerprint、访问去重、每种预算、risk ceiling、scorer 数学。
- Replay：固定 Graph 序列产生相同探索终止原因。
- E2E：正常/已知 Bug Fixture，Reference Profile 完成全部场景并生成 Report。
- Adversarial：模型重复动作、越权动作、伪造 novelty、未知 nodeId 均被阻止。

出口：Verified Skill 可回归；有限探索在预算/Policy 内可重放；Benchmark v1 的 Manifest/Ground Truth/Scorer 冻结；Reference Profile 达到上游规定的五项最低阈值。

