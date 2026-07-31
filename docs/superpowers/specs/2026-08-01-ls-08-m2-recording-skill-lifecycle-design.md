# [LS-08] M2 Recording 与 Procedure Skill 生命周期设计

- 状态：批量设计草案，待整体审阅
- Milestone：M2
- 直接依赖：LS-04、LS-07
- 下游：LS-09、LS-10、LS-11、LS-12

## 1. 目标与边界

本能力包把人工或成功执行轨迹转成可审查、可验证、签名、版本化的 Procedure Skill，并通过意图级重放执行。Skill 归纳由模型产生 Proposal；生命周期、签名、Promotion 和执行许可由确定性代码控制。

首版只实现 Procedure Skill、Tenant Private Registry 和 WebTarget。Navigation/Exploration/Oracle/Recovery/Evidence Skill 只保留 `skillType` 扩展值，不在本包实现其算法。Official/Community 发布流程不在 M2 首包。

## 2. 模块结构

```text
packages/core-modules/skill/
  src/domain/test-skill.ts
  src/application/skill-compiler.ts
  src/application/skill-verifier.ts
  src/application/skill-promotion-policy.ts
  src/ports/skill-repository.ts
  src/ports/skill-signer.ts
  src/public.ts
packages/runner-components/recording/
packages/runner-components/skill-replay/
packages/runner-components/model-agent/src/skill-induction-agent.ts
packages/storage-providers/kms-local/
tests/unit/core-modules/skill/
tests/component/skill-lifecycle/
tests/replay/procedure-skill/
```

`recording` 只产生不可变 Recording；`skill` 模块拥有聚合与晋升；`skill-replay` 消费已验证 Bundle；Model Agent 不导入 Repository。

## 3. Recording 契约

```ts
export interface RecordingSession {
  readonly recordingId: string;
  readonly projectId: string;
  readonly targetId: string;
  readonly targetVersion: string;
  readonly observationSchemaEpoch: "pre-v1" | "v1";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly steps: readonly [RecordedStep, ...RecordedStep[]];
  readonly sourceTraceRefs: readonly string[];
}

export interface RecordedStep {
  readonly ordinal: number;
  readonly beforeGraphRef: string;
  readonly intent: IntentStep;
  readonly resolvedNode: RecordedSemanticNode;
  readonly outcome: ActionOutcome;
  readonly afterGraphRef: string;
  readonly checkpoint: RecordedCheckpoint;
}

export interface RecordedSemanticNode {
  readonly role: string;
  readonly name?: string;
  readonly purpose: string;
  readonly sourceNodeId: string;
}

export interface RecordedCheckpoint {
  readonly requiredClaims: readonly string[];
  readonly stateFingerprint: string;
}
```

Recorder 只记录经过 Policy Gate 的动作。密码值使用 `valueRef`；外部副作用必须记录审批证据。失败/取消 Recording 可以保留 Trace，但不能进入 Skill induction。

## 4. Skill 聚合与 Bundle

```ts
export type SkillState = "draft" | "candidate" | "verified" | "promoted" | "deprecated";

export interface TargetScope {
  readonly targetId: string;
  readonly minimumTargetVersion?: string;
  readonly maximumTargetVersion?: string;
  readonly allowedOrigins: readonly string[];
}

export interface SkillParameter {
  readonly name: string;
  readonly valueRef: string;
  readonly required: boolean;
  readonly sensitivity: "public" | "internal" | "sensitive" | "secret";
}

export type SkillAssertion =
  | { readonly kind: "node_present"; readonly target: SemanticTarget }
  | { readonly kind: "node_text"; readonly target: SemanticTarget; readonly expected: string }
  | { readonly kind: "claim_satisfied"; readonly claimId: string }
  | { readonly kind: "url_path"; readonly path: string };

export interface ProcedureSkillVersion {
  readonly skillId: string;
  readonly version: number;
  readonly state: SkillState;
  readonly projectId: string;
  readonly targetScope: TargetScope;
  readonly parameters: readonly SkillParameter[];
  readonly steps: readonly [SkillStep, ...SkillStep[]];
  readonly sourceRecordingIds: readonly [string, ...string[]];
  readonly observationSchemaEpoch: "pre-v1" | "v1";
  readonly locatorSchemaVersion: string;
  readonly compilerVersion: string;
  readonly contentSha256: string;
}

export interface SkillStep {
  readonly stepId: string;
  readonly intent: IntentStep;
  readonly preconditions: readonly SkillAssertion[];
  readonly checkpoint: readonly SkillAssertion[];
  readonly recovery: "stop" | "reobserve";
}

export interface SkillBundleManifest {
  readonly bundleId: string;
  readonly skillId: string;
  readonly skillVersion: number;
  readonly schemaVersion: "skill-bundle/v1";
  readonly compilerVersion: string;
  readonly contentSha256: string;
  readonly signerKeyId: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly signatureBase64: string;
  readonly issuedAt: string;
  readonly expiresAt?: string;
}
```

Skill induction 的供应商中立 Proposal 固定为：

```ts
export interface SkillInductionProposal {
  readonly parameters: readonly SkillParameter[];
  readonly steps: readonly [ProposedSkillStep, ...ProposedSkillStep[]];
}

export interface ProposedSkillStep {
  readonly sourceRecordedStepOrdinal: number;
  readonly intent: IntentStep;
  readonly preconditions: readonly SkillAssertion[];
  readonly checkpoint: readonly SkillAssertion[];
  readonly recovery: "stop" | "reobserve";
}
```

Bundle canonical JSON 使用 UTF-8、排序键和明确数组顺序。签名覆盖 Manifest 中除签名字段外的内容及 Skill Payload hash。

## 5. 生命周期状态机

```text
Draft --compile--> Candidate --verify--> Verified --promote--> Promoted
  |                    |                    |                    |
  └--------------------┴--------------------┴----deprecate------> Deprecated
```

- Draft：模型 Proposal 已通过 Schema，但尚未编译。
- Candidate：确定性 Compiler 已生成，禁止自动执行可信任务。
- Verified：在固定正常/故障 Fixture 上全部必要 replay 通过，且签名有效。
- Promoted：人工或明确 Promotion Policy 批准用于默认检索。
- Deprecated：不可用于新 Job；历史 Bundle 和 Trace 不删除。

每个命令携带 expectedVersion 和 idempotencyKey。状态不可逆；新改动创建新 Skill Version，不把 Verified 改回 Candidate。

## 6. Induction、Compiler 和 Verifier

`skill.induction` Model Operation 输出参数、分支建议、语义目标和 checkpoint Proposal，不输出可执行 selector。`SkillCompiler`：

- 验证引用 Recording/Graph/Claim 存在且 hash 正确。
- 把具体值替换为声明的 parameter/valueRef。
- 拒绝 CSS/XPath/坐标和未知动作。
- 为每步生成稳定 stepId 和 semantic locator source。
- 保存 source recording、schema epoch、locator/compiler version。

`SkillVerifier` 在隔离 Fixture 上至少执行：两次正常 replay、一次目标文本轻微变化 replay、一次 precondition 不满足负例。任一运行 blocked、finding 或目标漂移则不进入 Verified。

## 7. Replay 语义

- 每个 Step 开始前重新观察并检查 preconditions。
- Action Resolver 依据 semantic target 定位，不复用 Recording nodeId。
- 多候选低置信时返回 `PlanDiverged`；不得随意选第一个。
- 动作后验证 checkpoint；失败停止后续步骤并保存 divergence。
- Bundle hash/签名/适用 Target/撤销状态/版本任一失败时硬拒绝。
- Runner 可缓存已签名 Bundle；离线只使用尚未过期且未在本地撤销列表中的缓存。

## 8. 安全与持久化

Local signer 使用数据目录中的 Ed25519 key，经 OS user-only 权限保护；公钥和 keyId 可公开。私钥不进入数据库/日志/Bundle。签名服务失败返回 `SkillSigningFailed`，禁止 unsigned fallback。

新增逻辑表：`recordings`、`recording_steps`、`skills`、`skill_versions`、`skill_evaluations`、`skill_bundles`、`skill_revocations`。原始 Observation/截图仍使用 Artifact 引用。

稳定错误：`RecordingIncomplete`、`InvalidSkillProposal`、`SelectorLeakRejected`、`SkillVersionConflict`、`SkillVerificationFailed`、`SkillSignatureInvalid`、`SkillRevoked`、`SkillTargetMismatch`、`PlanDiverged`。

## 9. 测试与出口 Gate

- Unit：状态机、canonical hash、签名、parameterization、selector 拒绝。
- Replay：DOM 文本/顺序变化仍重定位；precondition 变化安全停止。
- Component：Recording → Candidate → Verified → Promoted → replay。
- Security：篡改 Bundle、错 key、撤销、过期、跨项目重用均拒绝。

出口：一个购物车 Recording 可生成并验证 Tenant Private Procedure Skill；Runner 只执行签名有效的 Verified/Promoted Bundle；Intent Replay 在允许变化下成功，偏离时停止并给出证据。
