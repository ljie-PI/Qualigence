# [LS-10] M2 Investigation、Human Review 与 Evidence Capsule 设计

- 状态：批量设计草案，待整体审阅
- Milestone：M2
- 直接依赖：LS-09
- 下游：LS-11

## 1. 目标与边界

本能力包把 Finding Candidate 转成受预算约束的 Investigation Case，保存不可变 Reproduction Attempt，生成 Bug Episode 或确定性转入 Needs Human，并提供并发安全的 Human Review Queue 和可在 Runner 离线后受控调查的 Evidence Capsule。

范围外：Jira/GitHub Issue Connector、复杂 SLA/排班、Cloud 跨区 KMS、多组织共享证据。

## 2. 模块结构

```text
packages/core-modules/investigation/
packages/core-modules/review/
packages/core-modules/evidence/src/capsule/
packages/core-modules/intelligence/
packages/storage-providers/kms-local/
packages/storage-providers/kms-self-hosted/
packages/runner-components/evidence-capsule/
tests/unit/core-modules/investigation/
tests/unit/core-modules/review/
tests/contract/evidence-crypto/
tests/component/investigation/
```

Investigation/Review 聚合只由 Core Command Handler 修改。Runner/Intelligence Worker 只提交 Result/Proposal。

## 3. Investigation 状态机

```ts
export type InvestigationStatus =
  | "candidate"
  | "investigating"
  | "reproducing"
  | "confirmed"
  | "refuted"
  | "flaky"
  | "needs_human"
  | "resolved"
  | "regression_verified";

export interface InvestigationBudget {
  readonly maximumReproductionAttempts: number;
  readonly maximumPlanningRevisions: number;
  readonly maximumEnvironmentRetries: number;
  readonly maximumWallClockMs: number;
  readonly maximumModelTokens: number;
  readonly maximumEnvironmentResets: number;
  readonly maximumDestructiveActions: number;
  readonly confirmationConfidenceThreshold: number;
}

export interface ReproductionAttempt {
  readonly attemptId: string;
  readonly caseId: string;
  readonly ordinal: number;
  readonly planRevision: number;
  readonly environmentRef: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: "reproduced" | "not_reproduced" | "diverged" | "environment_failed" | "blocked";
  readonly divergenceStepId?: string;
  readonly evidenceRefs: readonly string[];
  readonly budgetConsumed: InvestigationBudgetUsage;
}
```

合法主路径：Candidate→Investigating→Reproducing→Confirmed/Refuted/Flaky/Needs Human→Resolved→Regression Verified。每次 Attempt 追加，绝不覆盖。Environment failure 只消耗 environment budget。

## 4. Bug Episode 与人工交接

```ts
export interface BugEpisode {
  readonly episodeId: string;
  readonly caseId: string;
  readonly findingId: string;
  readonly confirmedAttemptIds: readonly [string, ...string[]];
  readonly expectedClaims: readonly string[];
  readonly observedFacts: readonly string[];
  readonly minimalSteps: readonly IntentStep[];
  readonly environment: Readonly<Record<string, string>>;
  readonly evidenceRefs: readonly string[];
  readonly confidence: number;
}

export interface HumanHandoff {
  readonly caseId: string;
  readonly bestHypothesis: string;
  readonly attemptIds: readonly string[];
  readonly lastDivergence?: string;
  readonly keyEvidenceRefs: readonly string[];
  readonly suggestedActions: readonly string[];
  readonly limitationCodes: readonly string[];
}
```

只有确定性规则确认 Evidence/attempt/threshold 后创建 Bug Episode。预算任一硬上限耗尽且未确认时转 Needs Human，并在同一事务创建 ReviewTask/Handoff。

## 5. ReviewTask 并发语义

```ts
export interface ReviewTask {
  readonly taskId: string;
  readonly caseId: string;
  readonly status: "open" | "claimed" | "resolved";
  readonly reason: string;
  readonly priority: "low" | "medium" | "high" | "urgent";
  readonly evidenceCompleteness: "complete" | "limited" | "unavailable";
  readonly assigneeId?: string;
  readonly version: number;
}

export interface ClaimReviewTaskCommand {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly reviewerId: string;
  readonly idempotencyKey: string;
}
```

只有 Open 且 version 相等可认领。并发失败返回当前 assignee/version；列表投影不能覆盖聚合状态。Resolve 必须由当前 assignee 执行并携带 disposition/evidence refs。

## 6. Evidence Capsule

```ts
export interface EvidenceEncryptionProfile {
  readonly profileId: string;
  readonly recipient: string;
  readonly region: string;
  readonly wrappingKeyId: string;
  readonly wrappingPublicKeyPem: string;
  readonly allowedAlgorithms: readonly ["AES-256-GCM+RSA-OAEP-256"];
  readonly expiresAt: string;
}

export interface EvidenceCapsuleManifest {
  readonly capsuleId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly policyId: string;
  readonly ciphertextSha256: string;
  readonly ciphertextBytes: number;
  readonly wrappedDekBase64: string;
  readonly wrappingKeyId: string;
  readonly nonceBase64: string;
  readonly authTagBase64: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}
```

Runner 在本地按白名单、最大 bytes、Trace 时间窗口和 sensitivity 选择内容，先脱敏，再生成一次性 256-bit DEK，使用 AES-256-GCM 加密；DEK 用目标 KMS RSA-OAEP-256 公钥包装。明文/DEK 不上传、不落普通日志。`local_only` 不创建远端 wrapped DEK。

解密必须校验 tenant、case、purpose、TTL、region、policy 和 key status并写 Audit Event。KMS 不可用时 `EvidenceLimited`，不允许明文降级。TTL 到期删除密文并撤销解包许可。

## 7. Intelligence Job 边界

Reproduction Planning/Bug Analysis 使用持久化 `IntelligenceJob`，Result 只含 Proposal/evidence refs/confidence/usage。Result 必须通过 Schema、Budget、Policy、idempotency 和 base aggregate version 后由确定性 Handler 应用；过期 Result 重新归并或重算。

## 8. 测试与出口 Gate

- Unit：Case 状态机、每类预算、Attempt append、Review 并发、过期 Result。
- Crypto Contract：加解密、篡改、错 key、跨 tenant/region、TTL、轮换、KMS 拒绝。
- Component：Finding→reproduction→Confirmed Bug Episode；预算耗尽→Needs Human/ReviewTask。
- Offline：Runner 下线后授权 Worker 可解密已预暂存 Capsule；未预暂存时明确 Evidence Limited。

出口：Finding 有可追溯调查结论；Attempt 不可变；预算停止可靠；并发认领安全；离线调查只使用策略允许的加密 Capsule；任何降级都显式且可审计。

