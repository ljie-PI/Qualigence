# [LS-10] M2 Investigation、Human Review 与 Evidence Capsule 设计

- 状态：批量设计草案，待整体审阅
- Milestone：M2
- 直接依赖：LS-05、LS-09
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

export interface InvestigationBudgetUsage {
  readonly reproductionAttempts: number;
  readonly planningRevisions: number;
  readonly environmentRetries: number;
  readonly wallClockMs: number;
  readonly modelTokens: number;
  readonly environmentResets: number;
  readonly destructiveActions: number;
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
  readonly tenantId: string;
  readonly caseId: string;
  readonly recipient: string;
  readonly region: string;
  readonly purpose: "investigation";
  readonly policyId: string;
  readonly wrappingKeyId: string;
  readonly wrappingPublicKeyPem: string;
  readonly contentEncryptionAlgorithm: "A256GCM";
  readonly keyWrappingAlgorithm: "RSA-OAEP-256";
  readonly aadSchemaVersion: "evidence-capsule-aad/v1";
  readonly allowedEntryKinds: readonly EvidenceCapsuleEntry["kind"][];
  readonly maximumEntryBytes: number;
  readonly maximumPlaintextBytes: number;
  readonly maximumCiphertextBytes: number;
  readonly expiresAt: string;
}

export interface EvidenceCapsuleEntry {
  readonly entryId: string;
  readonly kind: "trace" | "semantic_graph" | "screenshot" | "log_summary";
  readonly mediaType: "application/json" | "image/png" | "image/jpeg" | "text/plain";
  readonly plaintextSha256: string;
  readonly plaintextBytes: number;
  readonly dataBase64: string;
}

export interface EvidenceCapsulePayload {
  readonly schemaVersion: "evidence-capsule/v1";
  readonly runId: string;
  readonly entries: readonly EvidenceCapsuleEntry[];
}

export interface EvidenceCapsuleProtectedHeader {
  readonly schemaVersion: "evidence-capsule-aad/v1";
  readonly capsuleId: string;
  readonly profileId: string;
  readonly payloadSchemaVersion: "evidence-capsule/v1";
  readonly tenantId: string;
  readonly caseId: string;
  readonly recipient: string;
  readonly region: string;
  readonly purpose: "investigation";
  readonly policyId: string;
  readonly contentEncryptionAlgorithm: "A256GCM";
  readonly keyWrappingAlgorithm: "RSA-OAEP-256";
  readonly wrappingKeyId: string;
  readonly plaintextSha256: string;
  readonly plaintextBytes: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface RemoteEvidenceCapsuleManifest {
  readonly protectedHeader: EvidenceCapsuleProtectedHeader;
  readonly ciphertextSha256: string;
  readonly ciphertextBytes: number;
  readonly wrappedDekBase64: string;
  readonly nonceBase64: string;
  readonly authTagBase64: string;
}

export interface LocalOnlyEvidenceRecord {
  readonly localRecordId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly disposition: "local_only";
  readonly reason: string;
  readonly localContentRefs: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type EvidenceCapsuleBuildResult =
  | {
      readonly disposition: "remote_capsule";
      readonly manifest: RemoteEvidenceCapsuleManifest;
      readonly ciphertext: Uint8Array;
    }
  | {
      readonly disposition: "local_only";
      readonly record: LocalOnlyEvidenceRecord;
    };

export interface EvidenceAuditEvent {
  readonly auditId: string;
  readonly actorType: "user" | "service";
  readonly actorId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly capsuleId: string;
  readonly keyVersion: string;
  readonly purpose: "investigation";
  readonly operation: "profile" | "wrap" | "unwrap" | "rewrap" | "revoke" | "delete";
  readonly decision: "allowed" | "denied" | "failed";
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly occurredAt: string;
}
```

Runner 在本地按 profile 白名单、最大 entry/总明文/总密文 bytes、Trace 时间窗口和 sensitivity 选择内容，先脱敏，再把 Trace、Semantic Graph、Screenshot 和 Log Summary 的实际内容编码为 `EvidenceCapsuleEntry.dataBase64`。外部 Artifact ref 只作 provenance，不能作为离线解密后的必需内容；构建器必须在读取实际 bytes 后校验每项与总量上限，并重新计算 entry 与 protected header 的 `plaintextSha256/plaintextBytes`。

远端 Capsule 使用 RFC 8785 canonical JSON 编码 Payload 和完整 `EvidenceCapsuleProtectedHeader`。每个 Capsule 生成一次性 32-byte DEK 和随机 12-byte nonce，以 AES-256-GCM 加密 Payload；唯一 AAD 是 canonical protected-header bytes，tag 固定 16 bytes。DEK 使用 RSA-OAEP-256 包装：OAEP hash 与 MGF1 hash 均为 SHA-256，label 为空。Profile 必须来自已认证的 KMS 调用，并逐项绑定 tenant、case、recipient、region、purpose、policy、algorithms、key 和 TTL；Builder 不接受调用方覆盖这些字段。

明文/DEK 不上传、不落普通日志。`local_only` 返回显式 `LocalOnlyEvidenceRecord`，不创建 Manifest、ciphertext、wrapped DEK 或任何可进入远端 upload queue 的对象。Remote 与 local-only 不能通过 optional fields 表示。

解密顺序固定为：解析并限制 Manifest 大小与字段 → 根据认证上下文校验 protected header 的 tenant/case/recipient/region/purpose/policy/TTL/algorithm → 检查 key status → 解包 DEK → 以 canonical protected header 作为 AAD 验证并解密 → 校验 Payload schema 和每个 Entry 的 hash/size → 写 Audit Event → 返回明文。任何 header 替换、ciphertext/tag/wrapped-key 变更都在返回明文前失败。KMS 不可用时 `EvidenceLimited`，不允许明文降级。

TTL 到期先调用 `revoke` 使解包许可失效并持久化成功审计，再删除 ciphertext；撤销失败时保留 ciphertext 并重试，不能出现“数据已删但解包许可状态未知”。密钥轮换创建不可变 Manifest revision（或由 KMS 受控 rewrap）并保留原 revision、父 revision、actor、reason、old/new key id 和时间审计。

Key Management port 固定为：

```ts
export interface KeyManagementProvider {
  encryptionProfile(input: {
    readonly tenantId: string;
    readonly caseId: string;
    readonly region: string;
    readonly purpose: "investigation";
  }): Promise<EvidenceEncryptionProfile>;
  wrapDek(profile: EvidenceEncryptionProfile, dek: Uint8Array): Promise<string>;
  unwrapDek(input: {
    readonly manifest: RemoteEvidenceCapsuleManifest;
    readonly tenantId: string;
    readonly caseId: string;
    readonly region: string;
    readonly purpose: "investigation";
  }): Promise<Uint8Array>;
  revoke(capsuleId: string, reason: string): Promise<void>;
}
```

## 7. Intelligence Job 边界

Reproduction Planning/Bug Analysis 使用持久化 `IntelligenceJob`，Result 只含 Proposal/evidence refs/confidence/usage。Result 必须通过 Schema、Budget、Policy、idempotency 和 base aggregate version 后由确定性 Handler 应用；过期 Result 重新归并或重算。

```ts
export type IntelligenceJobType =
  | "prd.planning"
  | "skill.induction"
  | "skill.evaluation"
  | "investigation.reproduction-planning"
  | "investigation.bug-analysis";

export interface IntelligenceJob {
  readonly jobId: string;
  readonly jobType: IntelligenceJobType;
  readonly schemaVersion: "intelligence-job/v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly aggregateRef: { readonly type: string; readonly id: string };
  readonly baseAggregateVersion: number;
  readonly inputRefs: readonly string[];
  readonly modelProfileId: string;
  readonly dataPolicyId: string;
  readonly budget: { readonly maximumTokens: number; readonly maximumCostMicros: number; readonly timeoutMs: number };
  readonly priority: "low" | "normal" | "high";
  readonly idempotencyKey: string;
  readonly causationId: string;
  readonly expectedResultSchema: string;
}

export interface IntelligenceResult {
  readonly jobId: string;
  readonly resultSchemaVersion: "intelligence-result/v1";
  readonly proposals: readonly Readonly<Record<string, unknown>>[];
  readonly evidenceRefs: readonly string[];
  readonly confidence: number;
  readonly provenance: readonly string[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costMicros: number };
  readonly terminalStatus: "succeeded" | "blocked" | "failed";
  readonly idempotencyKey: string;
}
```

## 8. 平台与兼容

Local 和 Self-hosted 使用相同 Case/Review/Capsule schema；Local KMS 与企业 KMS 通过同一 Contract Tests。所有新增 Event/Payload 使用独立 `v1` schema，minor 只增加可选字段。关系数据库 migration 只前进，Evidence Capsule v1 密文不在原地重加密；密钥轮换通过新 wrapped DEK/Manifest revision 或 KMS 受控重包装并保留审计。

## 9. 测试与出口 Gate

- Unit：Case 状态机、每类预算、Attempt append、Review 并发、过期 Result。
- Crypto Contract：canonical header/AAD、nonce 唯一性、加解密、header/ciphertext/tag/wrapped-key 篡改、错 key、跨 tenant/case/recipient/region/purpose/policy、TTL、轮换、KMS 拒绝。
- Component：Finding→reproduction→Confirmed Bug Episode；预算耗尽→Needs Human/ReviewTask。
- Offline：Runner 下线且本地 Artifact 已删除后，授权 Worker 仍能从 Capsule 内实际 Entry bytes 还原 Screenshot/Trace/Graph/Log；未预暂存时明确 Evidence Limited。

出口：Finding 有可追溯调查结论；Attempt 不可变；预算停止可靠；并发认领安全；离线调查只使用策略允许的加密 Capsule；任何降级都显式且可审计。
