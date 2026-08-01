# [LS-12] M3 Observation Graph v1 与 pre-v1 迁移设计

- 状态：批量设计草案，待整体审阅
- Milestone：M3
- 直接依赖：LS-11
- 下游：LS-13、未来 M4

## 1. 目标与边界

本能力包在 Web 与 Windows 原生共同实现前冻结 Observation Graph v1 候选契约，提供 JSON Schema、typed extension 规则、版本协商、pre-v1 Trace 重投影和 Skill 重编译/重验证管线。Graph v1 只有在 LS-13 Web/Windows conformance 与迁移 Gate 全部通过后才标记 frozen。

范围外：自动“修复”不可迁移 Skill、修改历史 Event payload、移动端 extension、把平台字段压平成不完整通用字段。

## 2. Contract 包与兼容策略

```text
packages/contracts/observation/
  schemas/observation-graph-v1.schema.json
  src/core.ts
  src/extensions.ts
  src/canonical.ts
  src/index.ts
packages/contracts/runner-protocol/
  src/index.ts              # 从 observation 包 re-export 兼容类型
packages/observation-migration/
  src/pre-v1-projector.ts
  src/skill-recompiler.ts
  src/migration-runner.ts
apps/admin-cli/src/commands/migrate-observation.ts
tests/conformance/observation/
tests/migration/observation-v1/
```

新包 `@qualigence/observation-contracts` 成为 Graph 真相；`@qualigence/runner-protocol` 在一个兼容周期内 re-export 现有类型，避免同名第二套接口。平台 Adapter 依赖 observation contracts，领域模块只保存版本化 Graph/引用。

## 3. Observation Graph v1

```ts
export type ObservationJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ObservationJsonValue[]
  | { readonly [key: string]: ObservationJsonValue };

export type ObservationSchema =
  | { readonly epoch: "pre-v1"; readonly version: string }
  | { readonly epoch: "v1"; readonly version: "observation-graph/v1" };

export interface ObservationGraphV1 {
  readonly schema: { readonly epoch: "v1"; readonly version: "observation-graph/v1" };
  readonly graphId: string;
  readonly target: { readonly kind: "web" | "app"; readonly targetId: string };
  readonly capturedAt: string;
  readonly rootNodeIds: readonly string[];
  readonly nodes: readonly ObservationNodeV1[];
  readonly evidenceRefs: readonly string[];
}

export interface ObservationNodeV1 {
  readonly id: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly state: Readonly<Record<string, boolean | string | number>>;
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly relations: readonly ObservationRelationV1[];
  readonly source: { readonly adapterId: string; readonly sourceKind: string };
  readonly confidence: number;
  readonly sensitivity: "public" | "internal" | "sensitive" | "secret";
  readonly extensions: Readonly<Record<string, VersionedExtension>>;
  readonly evidenceRefs: readonly string[];
}

export interface ObservationRelationV1 {
  readonly type: "child" | "labelled_by" | "described_by" | "controls" | "owns" | "focuses";
  readonly targetNodeId: string;
}

export interface VersionedExtension {
  readonly type: string;
  readonly version: string;
  readonly payload: Readonly<Record<string, ObservationJsonValue>>;
}
```

`role/name/value/state/bounds/relations/source/confidence/sensitivity/evidenceRefs` 是跨平台核心。未知 extension type 或已支持 major 内未知字段可保留/忽略；未知 extension major 不能由依赖该 extension 的 Action Resolver 使用，返回 `ExtensionVersionUnsupported`。

## 4. Canonical 与验证不变量

- `graphId` 在单 Run 唯一；Node ID 在 Graph 内唯一且只能被本 Graph 引用。
- rootNodeIds 和所有 relation target 必须存在。
- confidence 为 `[0,1]`；bounds width/height 非负，数值有限。
- secret 节点 `value` 必须省略或掩码；不能靠日志层补救。
- evidenceRefs 指向已登记、哈希有效 Artifact。
- canonical JSON 采用排序对象键、保留数组顺序、UTF-8/NFC；hash 算法 SHA-256。
- Schema minor 只增可选字段；major 改动必须新设计和协商。

## 5. pre-v1 资产分类

所有 M1/M2 新写入必须标记：

```ts
export interface PreV1AssetMetadata {
  readonly observationSchemaEpoch: "pre-v1";
  readonly sourceSchemaVersion: string;
  readonly locatorSchemaVersion?: string;
  readonly skillCompilerVersion?: string;
  readonly sourceArtifactRefs: readonly string[];
}
```

历史 payload 不原地修改。迁移产生新的 projection/Skill version，并保存 source event IDs、source hash、migrator version 和结果。

## 6. 迁移管线

```text
inventory pre-v1 assets
→ validate source hashes
→ project Trace Observation to Graph v1 candidate
→ validate JSON Schema/conformance
→ recompile each Skill semantic locator from source Trace
→ replay on Web and Windows reference targets where applicable
→ Verified new version / Deprecated / Needs Human
→ write immutable Migration Report
```

```ts
export interface ObservationMigrationResult {
  readonly assetId: string;
  readonly sourceHash: string;
  readonly status: "migrated" | "deprecated" | "needs_human" | "failed";
  readonly outputRef?: string;
  readonly reasonCode?: string;
  readonly migratorVersion: string;
}
```

Migration 命令按 assetId 幂等，可断点续跑。相同 source hash + migrator version 返回已有结果；source 变化必须创建新 attempt。批量失败不回滚已成功的新 projection，因为历史未变；Report 明确每项状态。

## 7. Freeze Gate

Graph v1 状态为 `candidate` 直到满足：

- Web Playwright 与 Windows UIA 对共同节点/状态/checkpoint 的 conformance tests 通过。
- `uia/v1` 可无损保留 Windows 专属语义。
- pre-v1 Trace 样本 100% 可读取，迁移结果全部为 migrated/deprecated/needs_human，无未解释 failed。
- 所有 active pre-v1 Skill 已生成 Verified v1 或显式 Deprecated/Needs Human。
- Runner Protocol capability 可声明 Graph/extension version 并明确拒绝不兼容 major。
- JSON Schema、canonical examples、breaking-change check 和 migration report 已版本化。

Freeze 后 `observation-graph/v1` major 受兼容承诺；移动端必须扩展而非修改通用核心。

## 8. 错误与测试

错误：`ObservationSchemaInvalid`、`DanglingNodeReference`、`EvidenceReferenceInvalid`、`ExtensionVersionUnsupported`、`SourceAssetCorrupted`、`ProjectionUnsupported`、`SkillRecompileFailed`、`MigrationSourceChanged`。

- Conformance：Web/UIA fixtures 对共同字段、extension round-trip、unknown minor/major。
- Migration：代表性 M1/M2 Trace/Skill golden files、断点续跑、幂等、损坏 source。
- Property：任意节点顺序 canonical hash 稳定；无 dangling relation。
- Replay：重新编译 Skill 在目标版本运行且 checkpoint 一致。

## 9. 出口 Gate

Graph v1 Contract/Schema/版本协商存在；pre-v1 资产有不可变迁移报告；Active Skill 有明确去向；LS-13 conformance 通过后可冻结；未来 macOS/Linux/Mobile 只需新 typed extension/Target Adapter。
