# Qualigence Local 与 Self-hosted 实施设计

- 状态：用户审阅中
- 日期：2026-07-28
- 上游架构：
  - `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md`
- 不包含：
  - Qualigence Cloud 的实现
  - M3 的 Windows VM 自动化测试基础设施

## 1. 目标与范围

本设计把已批准的开源架构转化为可以继续拆解为代码实施计划的工程设计，覆盖：

- Community Local：单机 Core、Runner、Web Console 和嵌入式 Provider。
- Team Self-hosted：私有网络中的 Server、外部数据库、对象存储和一台或多台 Runner。
- WebTarget 的端到端 AI 测试闭环。
- Windows 原生桌面 Adapter 的首个抽象验证。
- 为 macOS、Linux 和未来移动端保留明确的 Adapter 边界。

Local 与 Self-hosted 使用同一套领域模块、公开接口、Runner Protocol 和 Web Console。部署差异只存在于 Composition Root、Provider 和配置中。

## 2. 实施里程碑

### 2.1 M1：Web Walking Skeleton

范围：

- WebTarget。
- Community Local。
- 一个 Local Runner。
- Playwright 浏览器语义与视觉观察。
- 一个实际 Model Provider。
- 正式的 ExecutionJob、IntelligenceJob、Trace 和 Finding 契约。

必须跑通：

```text
URL
→ Observation
→ Decision
→ Action
→ Verification
→ Finding
```

出口条件：

- Runner Protocol、Trace 顺序和 Capability Negotiation 可用。
- Policy Gate 可以阻止未授权动作。
- Finding Envelope 可以被 Core 接受和持久化。
- 至少一个已知 Bug 场景端到端通过。

### 2.2 M2：Web Skill 与调查闭环

增加：

- 测试流程录制。
- Procedure Skill 归纳、验证、签名和版本管理。
- 意图级重放。
- 有限探索式测试。
- Reproduction Attempt。
- Bug Episode。
- Human Review Queue。
- Evidence Capsule 信封加密。
- 断线恢复、预算耗尽和人工移交。
- Team Self-hosted 单节点正式部署。

必须跑通：

```text
Recording
→ Candidate Skill
→ Verified Skill
→ Regression + Exploration
→ Finding
→ Reproduction
→ Bug Episode / Needs Human
```

### 2.3 M3：Windows 原生桌面抽象验证

首个平台固定为 Windows，使用 Microsoft UI Automation。

增加：

- AppTarget 启动、退出和重置。
- Windows UIA Sensor/Action Adapter。
- Desktop Companion。
- 本地敏感动作逐次审批。
- 窗口、进程、焦点、系统弹窗和原生控件观察。
- `uia/v1` Observation typed extension。
- Observation Graph v1 冻结与 pre-v1 资产迁移验证。

M3 当前不建设 Windows VM 自动化测试，也不设置 VM Nightly 或 VM Release Gate。验证方式为：

- 普通 CI 中的确定性单元、Replay、协议和序列化测试。
- 在受支持的 Windows 11 开发机或专用测试机上执行人工 Checklist。
- Checklist 结果必须记录环境、证据和失败项。

人工验收清单位于：

```text
docs/testing/windows-m3-manual-checklist.md
```

### 2.4 M4：未来移动端扩展

M4 不属于当前实施计划，只作为目标架构扩展记录。

建议顺序：

- M4a：Android Emulator Walking Skeleton。
- M4b：Android 真机、安装、重置和断线恢复。
- M4c：iOS Simulator 与 XCUITest。
- M4d：iOS 真机、签名、混合 App 和设备池。

Android 采用 Appium/UiAutomator2/ADB Adapter；iOS 采用 Appium XCUITest/WebDriverAgent Adapter。Appium 和 WebDriver DTO 不能进入领域模型、Observation Graph 或 Skill Schema。

## 3. 技术选型

### 3.1 主技术栈

- Node.js 24 LTS。
- TypeScript 6.0.x。
- Rust stable，仅用于 M3 Desktop Companion 和原生系统边界。
- pnpm workspace。
- Fastify 5。
- React 19.2、Vite、TanStack Router 和 TanStack Query。
- Playwright 1.62。
- gRPC、Protocol Buffers 和 Buf。
- Kysely。
- SQLite：Community Local。
- PostgreSQL：Team Self-hosted。
- Local FS：Local Artifact Store。
- S3/MinIO：Self-hosted Artifact Store。
- Vitest、fast-check、Playwright Test 和 Testcontainers。
- OpenTelemetry 和 Pino。

### 3.2 技术约束

- 不使用 LangChain 作为核心工作流、状态机或重试层。
- 不在首个 Local/Self-hosted 闭环中引入 Kafka、RabbitMQ、Redis、Temporal 或独立 EventStoreDB。
- 不使用 Node 内置 `node:sqlite`，直到它从 Release Candidate 进入稳定状态并通过 Provider Contract Tests。
- TypeScript 7 的采用必须等待编程 API 和项目工具链兼容性成熟。
- ExecutionJob 与 IntelligenceJob 不抽象为同一个泛型 Job。

## 4. 进程架构

```text
Web Console / CLI
        │ HTTP / OpenAPI
        ▼
Core Daemon / Self-hosted Server
        │ Runner Protocol / gRPC
        ▼
Local Runner
        ├─ Playwright Adapter
        ├─ Execution Model Provider
        ├─ Runner Spool
        └─ Windows Desktop Adapter (M3)
                │ Local IPC
                ▼
        Desktop Companion (M3)
```

进程不变量：

- Core、Runner 和 Companion 是独立进程。
- Core 与同机 Runner 仍通过正式 Runner Protocol 通信。
- Web Console 不直接访问数据库。
- Companion 不提供项目、报告或 Skill 管理 UI。
- Runner 与 Intelligence Worker 只能提交 Event、Fact、Proposal 或 Result。
- 聚合写入只能经过确定性 Core Command Handler。

## 5. 仓库结构

```text
Qualigence/
├─ apps/
│  ├─ core-daemon/
│  ├─ runner/
│  ├─ web-console/
│  ├─ cli/
│  └─ companion/
├─ packages/
│  ├─ contracts/
│  │  ├─ runner-protocol/
│  │  ├─ model-provider/
│  │  ├─ public-api/
│  │  └─ event-schemas/
│  ├─ shared-kernel/
│  ├─ core-modules/
│  │  ├─ project-target/
│  │  ├─ mission/
│  │  ├─ application-model/
│  │  ├─ skill/
│  │  ├─ investigation/
│  │  ├─ review/
│  │  ├─ policy/
│  │  ├─ evidence/
│  │  └─ intelligence/
│  ├─ execution-application/
│  ├─ runner-kernel/
│  │  ├─ execution/
│  │  ├─ observation/
│  │  ├─ action/
│  │  ├─ environment/
│  │  ├─ trace/
│  │  ├─ policy/
│  │  └─ protocol/
│  ├─ runner-components/
│  │  └─ model-agent/
│  ├─ model-gateway/
│  ├─ desktop-contracts/
│  ├─ mobile-contracts/
│  ├─ target-adapters/
│  │  ├─ web-playwright/
│  │  ├─ desktop-windows-uia/
│  │  ├─ desktop-macos-ax/
│  │  ├─ desktop-linux-atspi/
│  │  ├─ mobile-android-uiautomator2/
│  │  └─ mobile-ios-xcuitest/
│  ├─ model-providers/
│  │  ├─ openai-compatible/
│  │  ├─ anthropic/
│  │  ├─ gemini/
│  │  └─ ollama/
│  ├─ protocol-adapters/
│  │  ├─ in-memory-runner-protocol/
│  │  └─ grpc-runner-protocol/
│  ├─ connectors/
│  │  └─ git/
│  ├─ storage-providers/
│  │  ├─ relational-kysely/
│  │  ├─ sqlite-runtime/
│  │  ├─ postgres-runtime/
│  │  ├─ artifact-fs/
│  │  ├─ artifact-s3/
│  │  ├─ search-local/
│  │  ├─ search-postgres/
│  │  ├─ kms-local/
│  │  └─ kms-self-hosted/
│  ├─ sdk/
│  └─ testkit/
├─ deployments/
│  ├─ local/
│  └─ self-hosted/
│     ├─ compose/
│     └─ helm/
├─ benchmarks/
│  └─ detection-v1/
├─ tests/
│  ├─ unit/
│  ├─ component/
│  ├─ contract/
│  ├─ conformance/
│  ├─ replay/
│  ├─ e2e/
│  └─ manual/
└─ docs/
```

所有测试均位于独立的 `tests/` 目录，不与 `src/` 同目录。`tests/unit` 镜像 `packages` 的模块结构。

## 6. 模块依赖与边界

允许的依赖方向：

```text
apps
├─→ core-modules
├─→ execution-application
├─→ runner-kernel
├─→ runner-components
├─→ model-gateway
├─→ target-adapters
├─→ model-providers
├─→ protocol-adapters
├─→ storage-providers
├─→ connectors
└─→ contracts

execution-application ─→ runner-kernel、contracts、shared-kernel
runner-components ─→ runner-kernel、model-gateway、contracts
model-gateway ─→ contracts/model-provider、shared-kernel
model-providers ─→ contracts/model-provider
target-adapters ─→ runner-kernel ports 与 target contracts
protocol-adapters ─→ runner-protocol contracts 与两端 ports
storage-providers ─→ 模块持久化 ports
connectors ─→ 对应模块 ports
core-modules ─→ shared-kernel
runner-kernel ─→ shared-kernel
contracts ─→ 不依赖领域模块
```

禁止：

- Core Domain 导入 Fastify、Kysely、Playwright、gRPC 或模型 SDK。
- Core 模块读取其他模块的 Repository。
- `core-modules` 导入 `storage-providers`。
- Model Provider 导入 Model Gateway 实现。
- Runner Kernel 导入具体 Model Provider、Playwright 或存储 Provider。
- Web/CLI 使用领域实体作为 DTO。
- Protobuf 生成类型直接进入 Domain。
- AI Worker 持有聚合 Repository。
- Runner Kernel 包含 Windows、macOS 或 Linux 的业务分支。

每个 Core 模块采用：

```text
src/
├─ domain/
├─ application/
├─ ports/
├─ events/
├─ public.ts
└─ index.ts
```

模块外部只能导入 `public.ts`。

## 7. 核心模块和类

### 7.1 Shared Kernel

```ts
abstract class AggregateRoot<TId> {
  readonly id: TId;
  protected version: number;
  protected raise(event: DomainEvent): void;
  pullEvents(): readonly DomainEvent[];
  currentVersion(): number;
}

interface Loaded<T> {
  aggregate: T;
  version: number;
}
```

Shared Kernel 只包含 ID、Version、Instant、Clock、Duration、Budget、IdempotencyKey、DomainEvent 和基础 Result 类型。

### 7.2 Core Command 单写者

```ts
interface CommandHandler<C, R> {
  execute(
    command: C,
    context: CommandContext,
    tx: Transaction,
  ): Promise<R>;
}

class CoreCommandExecutor {
  execute<C, R>(
    command: C,
    handler: CommandHandler<C, R>,
    context: CommandContext,
  ): Promise<R>;
}
```

`CoreCommandExecutor` 在同一事务中：

1. 检查命令幂等键。
2. 加载聚合与当前版本。
3. 执行确定性状态迁移。
4. 以 expected version 保存聚合。
5. 追加不可变 Domain Event。
6. 写入 Outbox。
7. 提交幂等结果。

### 7.3 Core 模块

| 模块 | 聚合/对象 | 应用服务 |
|---|---|---|
| Project & Target | `Project`、`WebTarget`、`AppTarget` | `ProjectService`、`TargetService` |
| Mission | `TestMission`、`ExecutionJob` | `MissionCompiler`、`MissionOrchestrator`、`RunnerScheduler` |
| Application Model | `ExpectedClaim`、`ObservedFact`、`Conflict`、`Disposition` | `ApplicationModelMerger`、`ProposalApplier` |
| Skill | `TestSkill`、`SkillBundle`、`SkillEvaluation` | `SkillCompiler`、`SkillVerifier`、`SkillPromotionPolicy` |
| Investigation | `InvestigationCase`、`ReproductionAttempt` | `InvestigationCoordinator`、`ReproductionPlanner` |
| Review | `ReviewTask` | `ClaimReviewTaskHandler`、`ResolveReviewTaskHandler` |
| Policy | `MissionPolicy`、`PolicyDecision` | `PolicyEngine`、`PolicyBundleSigner` |
| Evidence | `TraceEvent`、`ArtifactManifest`、`EvidenceCapsule` | `TraceIngestor`、`EvidenceService`、`EnvelopeEncryptor` |
| Intelligence | `IntelligenceJob`、`IntelligenceResult` | `IntelligenceDispatcher`、`IntelligenceResultApplier` |

### 7.4 ExecutionJob 与 IntelligenceJob

```ts
interface ExecutionJobStore {
  enqueue(job: ExecutionJob, tx: Transaction): Promise<void>;
  leaseForRunner(
    runner: RunnerDescriptor,
    now: Instant,
    duration: Duration,
  ): Promise<ExecutionJobLease | null>;
  renew(
    jobId: ExecutionJobId,
    leaseToken: LeaseToken,
    expiresAt: Instant,
  ): Promise<ExecutionJobLease>;
  complete(
    jobId: ExecutionJobId,
    leaseToken: LeaseToken,
    result: ExecutionCompletion,
  ): Promise<void>;
  recoverExpired(now: Instant): Promise<readonly ExecutionJobId[]>;
}

interface IntelligenceJobStore {
  enqueue(job: IntelligenceJob, tx: Transaction): Promise<void>;
  leaseForWorker(
    worker: IntelligenceWorkerDescriptor,
    acceptedTypes: readonly IntelligenceJobType[],
    now: Instant,
    duration: Duration,
  ): Promise<IntelligenceJobLease | null>;
  submitResult(
    leaseToken: LeaseToken,
    result: IntelligenceResult,
  ): Promise<void>;
  recoverExpired(now: Instant): Promise<readonly IntelligenceJobId[]>;
}
```

### 7.5 Model Gateway

Model Gateway 是 Core、Runner 和 Intelligence Worker 共享的跨运行时能力，不属于某一个 Core Domain 模块。

- `contracts/model-provider` 定义供应商无关的请求、响应、能力、错误和 `ModelProvider` port。
- 顶层 `model-gateway` 包负责 Profile 解析、Provider 选择、预算、超时、有限重试、结构化输出校验和用量记录。
- `model-providers/*` 只实现 `ModelProvider` contract，不依赖 Model Gateway 实现。
- `runner-components/model-agent` 将 Model Gateway 适配成 Runner 的 Decision Provider 和 Verifier。
- Composition Root 负责将具体 Provider 注入 Model Gateway。

```ts
interface ModelProvider {
  readonly capabilities: ModelCapabilities;
  invoke(request: ModelProviderRequest): Promise<ModelProviderResponse>;
}

interface ModelGateway {
  invokeStructured<T>(
    request: StructuredModelRequest,
    output: StructuredOutputContract<T>,
  ): Promise<ValidatedModelResult<T>>;
}

interface ModelProfileResolver {
  resolve(
    profile: ModelProfile,
    policy: DataPolicy,
  ): ResolvedModel;
}
```

模型输出只能是 Decision、Proposal 或 IntelligenceResult。模型不能直接调用 Repository、改变聚合状态、生成可执行 selector 或伪造 Evidence 引用。

## 8. Runner 设计

固定执行管线：

```text
Observe
→ Decide
→ Resolve
→ Authorize
→ Execute
→ Verify
→ Record
```

```ts
class ExecutionRuntime {
  run(job: AcceptedExecutionJob): Promise<ExecutionCompletion>;
}

class ObservationFusionService {
  capture(context: CaptureContext): Promise<ObservationGraph>;
}

interface ExecutionDecisionProvider {
  decide(context: AgentContext): Promise<ProposedAction>;
}

class ActionResolutionPipeline {
  resolve(
    action: ProposedAction,
    graph: ObservationGraph,
  ): Promise<ResolvedAction>;
}

class RunnerPolicyGate {
  authorize(
    action: ResolvedAction,
    context: RunnerPolicyContext,
  ): Promise<PolicyDecision>;
}

class VerificationEngine {
  verify(
    expectation: VerificationExpectation,
    before: ObservationGraph,
    after: ObservationGraph,
  ): Promise<VerificationResult>;
}

class TraceRecorder {
  append(event: TraceEvent): Promise<TraceSequence>;
}
```

Adapter：

```ts
interface SensorAdapter {
  capabilities(): SensorCapabilities;
  capture(context: CaptureContext): Promise<ObservationFragment>;
}

interface ActionAdapter {
  supports(action: ResolvedAction): boolean;
  execute(
    action: ResolvedAction,
    permit: ExecutionPermit,
  ): Promise<ActionOutcome>;
}
```

`ExecutionPermit` 只能由 RunnerPolicyGate 创建，避免 AI 或 Adapter 绕过本地 Policy。

## 9. 跨平台设计

### 9.1 支持边界

| 组件 | Windows | macOS | Linux |
|---|---:|---:|---:|
| Web Console | 支持 | 支持 | 支持 |
| Local Core | 支持 | 支持 | 支持 |
| Web Runner | 支持 | 支持 | 支持 |
| Self-hosted 开发 | Docker 可用 | Docker 可用 | 支持 |
| Self-hosted 生产 | 非官方目标 | 非官方目标 | 官方目标 |
| Companion 外壳 | 目标支持 | 目标支持 | 目标支持 |
| 原生桌面自动化 | UIA | AX | AT-SPI |
| 当前 M3 | 实现 | 不实现 | 不实现 |

### 9.2 Desktop Adapter

```ts
interface PlatformDesktopAdapter {
  id(): DesktopAdapterId;
  platform(): "windows" | "macos" | "linux";
  capabilities(): DesktopAdapterCapabilities;
  probe(target: AppTarget): Promise<AdapterSupport>;
  sensors(): readonly SensorAdapter[];
  actions(): readonly ActionAdapter[];
  createEnvironmentProvider(): DesktopEnvironmentProvider;
}
```

Windows 使用 `uia/v1`，macOS 使用 `ax/v1`，Linux 使用 `atspi/v1` typed extension。平台独有信息不能被压平或丢失。

## 10. Observation Graph

```ts
interface ObservationNode {
  id: ObservationNodeId;
  role: string;
  name?: string;
  value?: string;
  state: Readonly<Record<string, boolean | string | number>>;
  bounds?: Rectangle;
  relations: readonly ObservationRelation[];
  source: ObservationSource;
  confidence: number;
  sensitivity: Sensitivity;
  extensions: Readonly<Record<ExtensionType, VersionedExtension>>;
  evidenceRefs: readonly ArtifactRef[];
}
```

动作解析顺序：

```text
Semantic Node
→ Platform Selector
→ Visual Anchor
→ Coordinates
```

不存在相应能力时返回 `CapabilityMismatch`，不得静默退化。

## 11. 数据与事件模型

### 11.1 数据原则

- Local 与 Self-hosted 使用相同逻辑 Schema。
- Local 自动创建 `local` Tenant 和 Workspace。
- ID 由应用层生成 UUIDv7。
- 时间保存为 UTC。
- 聚合保存整数 `version`。
- 原始 Artifact 不进入关系数据库。
- 状态、版本和关联使用结构化列；版本化 Payload 使用 JSON。
- SQLite 和 PostgreSQL DDL 由同一 Schema Conformance Suite 验证。

### 11.2 主要表

```text
tenants
workspaces
projects
targets
target_versions
missions
mission_revisions
execution_jobs
execution_job_attempts
intelligence_jobs
intelligence_job_attempts
intelligence_results
runners
runner_sessions
runs
run_event_cursors
trace_events
artifacts
artifact_links
application_model_heads
application_model_proposals
expected_claims
observed_facts
model_conflicts
dispositions
skills
skill_versions
skill_evaluations
skill_bundles
findings
investigation_cases
reproduction_attempts
review_tasks
evidence_capsules
domain_events
outbox_messages
idempotency_records
audit_events
aggregate_snapshots
```

### 11.3 Domain Event Envelope

```ts
interface DomainEventEnvelope<TPayload> {
  eventId: EventId;
  eventType: string;
  schemaVersion: SchemaVersion;
  tenantId: TenantId;
  projectId?: ProjectId;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  causationId: string;
  correlationId: string;
  idempotencyKey: IdempotencyKey;
  actor: ActorRef;
  occurredAt: Instant;
  payload: TPayload;
}
```

聚合状态、Domain Event、Outbox 和幂等结果必须在同一关系数据库事务中提交。

### 11.4 Trace

`trace_events` 使用 `(run_id, sequence_number)` 主键，并保存 `payload_hash`。处理规则：

- 完全重复且哈希一致：幂等成功。
- 部分重叠且事件一致：只追加新事件。
- 相同序号但哈希不同：`TraceIntegrityViolation`。
- 出现缺口：返回 `SequenceGap` 和期望序号。
- Lease 过期后可以接受已经发生的 Trace，但 Runner 不得继续新动作。

### 11.5 Application Model

- Expected Claim 与 Observed Fact 分表追加。
- 相同 semantic key 但不同结论并存并创建 Conflict。
- Disposition 使用追加和 `supersedes_disposition_id`，不覆盖历史。
- Proposal 必须携带 `base_model_version`。
- 过期 Proposal 重新归并或重新计算。

## 12. 一致性与查询

- 聚合状态和安全判断读取写模型真相。
- 列表、搜索和分析使用异步 Projection。
- Projection 返回 `asOfEvent`、`asOfTime` 和 `lagMs`。
- ReviewTask 认领使用 `expectedVersion` 条件写。
- Event Store 保留原始不可变 Payload。
- Upcaster 只转换读取格式，不修改历史事件。
- Snapshot 和 Projection 可以重建。

## 13. 错误与恢复

### 13.1 错误分类

```ts
type ErrorCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "conflict"
  | "policy_denied"
  | "capability_mismatch"
  | "lease_lost"
  | "budget_exhausted"
  | "evidence_limited"
  | "dependency_unavailable"
  | "integrity_violation"
  | "internal";
```

错误必须包含稳定 `code`、安全消息、关联 ID 和明确 RetryDisposition。不得通过字符串决定重试。

### 13.2 恢复规则

- Expected Version 冲突：确定性命令重新加载并最多重放三次；AI Proposal 重新归并或重新计算。
- Runner 断线：本地持久化 Trace，重连后从最后确认序号续传。
- Execution Lease 到期：Runner 停止新动作，Server 从安全检查点决定恢复、重派或转人工。
- Intelligence Worker 中断：Lease 重新租用，Result 幂等应用。
- 模型超时：同 Provider 有界重试，再按 Profile 和 Data Policy 降级。
- Artifact 上传失败：保留 Manifest 并按内容哈希续传。
- KMS 不可用：停止加解密，不允许明文降级。
- 环境重置失败：只消耗环境预算。
- Projection 失败：Outbox 重放，不回滚已完成的业务命令。
- Skill 签名失败：硬拒绝并隔离。
- 外部副作用结果未知：不自动重放，转人工。

### 13.3 Runner Spool

Runner 使用持久化 Spool 保存未确认 Trace、Artifact Manifest 和待上传对象。达到软限制时停止非关键高容量证据；达到硬限制时停止执行，不能删除未确认 Trace。

## 14. 测试设计

### 14.1 目录

所有测试与源码分离：

```text
tests/
├─ unit/
├─ component/
├─ contract/
├─ conformance/
├─ replay/
├─ e2e/
└─ manual/
```

### 14.2 测试分层

- Unit：聚合、状态机、Budget、Policy、合并器、序列化、Upcaster。
- Component：Core、Runner 和 Intelligence Worker 的进程内组合。
- Provider Contract：SQLite/PostgreSQL、FS/S3、Work Store、KMS、Search 和 Model Provider。
- Protocol Conformance：版本协商、重连、去重、Lease、Artifact 和兼容性。
- Replay：固定 Observation/Action Trace，不启动真实桌面。
- E2E：Web 故障注入应用和 Detection Benchmark。
- Manual：M3 Windows UIA、Companion 和交互式桌面验收。

### 14.3 M3 测试决策

M3 不建设 Windows VM 测试环境。当前发布验证不包含：

- 自动化 Windows VM Provisioning。
- 交互式 CI Agent。
- VM Nightly UIA Smoke。
- VM Release Candidate LLM 场景。
- Windows VM 快照恢复。

这些能力只有在人工 Checklist 的频率、回归成本或缺陷量证明有必要时，才进入新的独立设计和实施计划。

## 15. Local 部署

```text
Qualigence Launcher
├─ Core Daemon
│  ├─ Web/API
│  ├─ SQLite
│  ├─ In-process Intelligence Workers
│  └─ Local Artifact Store
├─ Local Runner
│  ├─ Playwright
│  ├─ Runner Spool
│  └─ Execution Model Provider
├─ CLI
└─ Companion (M3)
```

Local 约束：

- Core 只监听 loopback。
- Runner Protocol 使用本地生成并固定的证书。
- Web 使用一次性 bootstrap token 建立本机会话。
- SQLite 使用 WAL、Foreign Keys、Busy Timeout 和批量 Trace 写入。
- 升级前创建可恢复数据库副本。
- Launcher 只负责初始化、进程生命周期、健康检查、日志和升级备份。

## 16. Self-hosted 部署

首个正式私有部署使用 Docker Compose：

```text
TLS Reverse Proxy
├─ qualigence-server
├─ qualigence-intelligence-worker
├─ PostgreSQL
├─ MinIO / External S3
├─ External OIDC
└─ Vault / Enterprise KMS
```

Server 与 Worker 使用同一个镜像，通过启动命令选择角色：

```text
qualigence server
qualigence worker
qualigence migrate
qualigence doctor
```

官方生产目标为 Linux 容器。Docker Desktop 仅用于开发和演示。单节点 Compose 不声明高可用。Helm 在 M2 稳定后提供，但不阻塞单节点闭环。

## 17. 配置、安全与可观测性

配置优先级：

```text
安全默认值
< 配置文件
< 环境变量
< CLI 参数
```

Secret 使用 `SecretProvider` 和 `credential_ref`，不得写入普通配置。

关键可观测指标：

- Mission 排队和完成时间。
- Execution/Intelligence Lease。
- Runner 在线率和重连。
- Trace 接收游标和 Spool 使用率。
- Projection Lag。
- 模型延迟、Token 和成本。
- Finding 确认率和自动复现率。
- Artifact、KMS 和 Evidence 错误。

日志不得记录完整 Prompt、截图内容、DOM/Accessibility 原文、API Key、明文 Lease Token 或 Evidence Capsule 明文。

## 18. 发布与兼容版本

独立版本：

- Product Version。
- Runner Protocol Version。
- Public API Version。
- Domain Event Schema Version。
- Bundle Manifest Version。
- Observation Graph Version。
- Skill Schema Version。
- Skill Compiler Version。

规则：

- Product 使用 SemVer。
- Server 至少兼容当前和一个受支持旧版 Runner。
- 新 Minor Protocol 字段必须可忽略。
- 新 Major Protocol 必须通过协商明确拒绝。
- 数据库迁移先备份与校验。
- Event 历史不原地修改。
- Self-hosted 不自动降级数据库 Schema。
- Runner、Companion、Skill Bundle 和安装包必须签名。

## 19. 已确认决策

1. 不实施 Cloud。
2. 采用 TypeScript 优先、Rust 补充的路线 A。
3. Local 与 Self-hosted 共享领域和协议。
4. M1、M2 后执行 Windows-first M3。
5. Web Runner 目标支持 Windows、macOS 和受支持 Linux。
6. Windows 使用 UIA；macOS 和 Linux 只保留 Adapter 边界。
7. 移动端记录为 M4，不进入当前实施计划。
8. 单元测试与源码目录分离。
9. M3 暂不建设 Windows VM 自动化测试。
10. M3 使用独立人工 Checklist 验收并留存证据。
11. 外部边界实现按 Target Adapter、Model Provider、Protocol Adapter、Storage Provider 和 Connector 分类，不再混放于通用 `packages/adapters`。
12. Model Gateway 是顶层跨运行时包；供应商中立接口位于 `contracts/model-provider`，具体 Provider 不依赖 Gateway 实现。
