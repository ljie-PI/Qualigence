# M1 Real Web Vertical Slice Design

- 日期：2026-07-31
- 状态：已确认，待实施计划
- 适用范围：Community Local 的真实 Web 单用例纵向闭环

## 1. 背景

仓库已经具备 M1 的 TypeScript workspace、Runner 固定执行管线、Runner Protocol Trace Envelope、Core Evidence Ingestor、内存协议 Adapter 和确定性测试。

当前实现仍是内存骨架，没有真实浏览器、真实模型调用、SQLite、文件证据或可启动 CLI。本设计增加一条最薄但真实的本地执行路径：

~~~text
CLI
→ Playwright Observation
→ Remote OpenAI-compatible Decision
→ Policy Gate
→ Playwright Action
→ Playwright Observation
→ Remote OpenAI-compatible Verification
→ Finding
→ SQLite + Local Artifact Store
~~~

本设计优先证明用户价值，不提前实现最终进程拓扑。完成本设计代表真实 Web 纵向闭环可运行，但不代表 M1 的独立 Core/Runner 进程、gRPC 和 Capability Negotiation 已全部完成。

## 2. 目标

本轮必须实现：

- 通过单进程 CLI 运行一个真实 Web 测试目标。
- 使用 Playwright 打开页面、观察、点击和再次观察。
- 通过供应商无关的 Model Gateway 调用远程 OpenAI-compatible Endpoint。
- 由模型分别产生 Decision 和 Verification。
- 对模型输出进行 Schema、节点引用和证据真实性校验。
- 确定性生成 Trace、Finding 和终止状态。
- 使用 SQLite 持久化 Run、Trace、Finding、Artifact Manifest 和模型调用摘要。
- 使用本地文件系统保存前后 Observation JSON 与截图。
- 在普通 CI 中以确定性模型替身完成黑盒 CLI E2E。
- 提供显式启用的真实远程模型 Smoke Test。

## 3. 非目标

本轮不实现：

- Web Console。
- 独立 Core Daemon 和 Runner 进程。
- gRPC Runner Protocol Transport。
- Runner Capability Negotiation。
- PostgreSQL、S3、OIDC 或 Docker Compose。
- Ollama、LM Studio、Anthropic 或 Gemini Adapter。
- 多步骤自主探索。
- 表单输入、拖拽、上传等 Click 之外的动作。
- PRD 解析、Test Case 生成或批量 Mission 调度。
- M2 的 Skill、Reproduction、Bug Episode 和 Human Review Queue。
- M3 的 Windows UI Automation。

## 4. 已确认决策

1. 首版采用单进程 CLI Composition Root。
2. 模块通过正式接口组合，后续可拆分为独立进程。
3. 首个真实 Provider 使用远程 OpenAI-compatible Endpoint。
4. 模型抽象独立于 OpenAI DTO，未来通过新 Provider 包支持其他供应商。
5. 产品运行时的 Decision 和 Verification 均由模型驱动。
6. 普通 CI 不调用真实模型；Live Model Smoke 不作为合并硬门槛。
7. 首个 Fixture 是购物车金额错误。
8. 模型只能选择 Observation nodeId，不能提供可执行 selector。
9. 模型给出的 Evidence 引用必须由代码验证。
10. CLI 只是应用入口；未来 PRD Planner 调用共享执行用例，不调用 CLI 进程。

## 5. 方案选择

### 5.1 采用：薄纵向闭环

单进程 CLI 内使用真实 Playwright、Model Gateway、OpenAI-compatible Adapter、SQLite 和文件存储。模块边界保持独立，省略跨进程 Transport。

### 5.2 不采用：极简 Demo

不把 Playwright、模型 SDK 和 JSON 文件写入直接堆叠在 CLI 内。该方案虽快，但无法复用现有 Runner 与 Evidence 边界。

### 5.3 暂缓：基础设施优先

本轮不先建设 Core Daemon、Runner 进程和 gRPC。它们属于真实纵向闭环之后的 M1 硬化步骤。

## 6. 运行架构

~~~text
apps/cli
  └─ LocalRunCompositionRoot
       ├─ RunExecutionUseCase
       │    └─ ExecutionRuntime
       ├─ PlaywrightBrowserSession
       ├─ PlaywrightObserver
       ├─ PlaywrightActionResolver
       ├─ PlaywrightActionExecutor
       ├─ ModelBackedDecisionProvider
       ├─ ModelBackedVerifier
       ├─ ModelGateway
       │    └─ OpenAICompatibleModelProvider
       ├─ InMemoryRunnerProtocolAdapter
       │    └─ TraceIngestor
       ├─ SqliteEvidenceStore
       └─ LocalArtifactStore
~~~

单进程仅是 Composition Root 的部署选择。ExecutionRuntime、Model Gateway、协议 Envelope、Evidence Ingestor 和 Store Port 不依赖 CLI。

## 7. 仓库结构

~~~text
apps/
└─ cli/

packages/
├─ contracts/
│  ├─ runner-protocol/
│  └─ model-provider/
├─ shared-kernel/
├─ execution-application/
├─ runner-kernel/
├─ runner-components/
│  └─ model-agent/
├─ model-gateway/
├─ target-adapters/
│  └─ web-playwright/
├─ model-providers/
│  └─ openai-compatible/
├─ protocol-adapters/
│  └─ in-memory-runner-protocol/
├─ storage-providers/
│  ├─ sqlite-runtime/
│  └─ artifact-fs/
└─ testkit/

tests/
├─ unit/
├─ contract/
├─ component/
├─ e2e/
├─ live/
└─ fixtures/
   └─ web-cart/
~~~

现有 packages/adapters/in-memory-runner-protocol 在本轮移动到 packages/protocol-adapters/in-memory-runner-protocol。移动只改变仓库分类和 workspace 路径，不改变公开包名。

## 8. 依赖方向

~~~text
apps/cli
  → execution-application
  → runner-components
  → model-gateway
  → concrete adapters/providers

execution-application
  → runner-kernel
  → runner-protocol contracts
  → shared-kernel

runner-components/model-agent
  → runner-kernel ports
  → model-gateway
  → model-provider contracts

model-gateway
  → model-provider contracts
  → shared-kernel

model-providers/openai-compatible
  → model-provider contracts

target-adapters/web-playwright
  → runner-kernel ports
  → runner-protocol contracts

protocol-adapters/in-memory-runner-protocol
  → runner-protocol contracts
  → runner TraceRecorder port
  → Core Evidence Ingestor port

storage-providers
  → Evidence and Artifact Store ports
~~~

禁止以下反向依赖：

- Runner Kernel 导入 Playwright、OpenAI SDK、Kysely 或 better-sqlite3。
- OpenAI-compatible Provider 导入 Model Gateway 实现。
- Model Gateway 导入任何具体 Provider。
- CLI 保存领域状态或包含执行算法。
- 模型供应商 DTO 进入 Runner Protocol 或领域对象。

## 9. 共享执行用例

CLI、未来的 Web API、Worker 和 PRD Planner 复用同一个应用接口。

~~~ts
interface RunExecutionRequest {
  readonly target: {
    readonly kind: "web";
    readonly url: string;
  };
  readonly objective: string;
  readonly executionProfile: {
    readonly modelProfileId: string;
    readonly headed: boolean;
    readonly navigationTimeoutMs: number;
    readonly actionTimeoutMs: number;
  };
}

interface RunExecutionResult {
  readonly runId: string;
  readonly status: "passed" | "finding" | "blocked" | "error";
  readonly finding?: FindingEnvelope;
  readonly errorCode?: string;
  readonly evidenceRefs: readonly string[];
}

interface RunExecutionUseCase {
  execute(request: RunExecutionRequest): Promise<RunExecutionResult>;
}
~~~

RunExecutionUseCase 负责资源生命周期、运行创建、终态记录和依赖调用。ExecutionRuntime 继续负责确定性的 Observe、Decide、Resolve、Authorize、Execute、Verify、Record 顺序。

## 10. CLI

首版用户命令：

~~~text
qualigence run
  --url <url>
  --objective "<测试目标>"
  --output human|json
  --headed
~~~

默认使用 headless 模式。模型密钥不接受命令行参数，避免进入 Shell History 和进程列表。

配置来源：

~~~text
QUALIGENCE_MODEL_BASE_URL
QUALIGENCE_MODEL_API_KEY
QUALIGENCE_MODEL_NAME
QUALIGENCE_DATA_DIR
~~~

退出码：

| Code | 含义 |
|---:|---|
| 0 | 执行完成，目标满足 |
| 1 | 执行完成，发现产品问题并生成 Finding |
| 2 | 执行被阻塞或结果不确定 |
| 3 | 配置或基础设施错误 |

human 输出提供短摘要、Run ID、Finding 和证据目录。json 输出提供稳定的 RunExecutionResult，不输出日志噪声。

## 11. Model Gateway

### 11.1 Contract

packages/contracts/model-provider 定义供应商中立接口：

~~~ts
type ModelOperation = "execution.decision" | "execution.verification";

interface ModelCapabilities {
  readonly structuredOutput: boolean;
  readonly visionInput: boolean;
  readonly toolCalling: boolean;
  readonly streaming: boolean;
}

interface ModelProviderRequest {
  readonly operation: ModelOperation;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly responseSchema: JsonSchema;
  readonly timeoutMs: number;
}

interface ModelProviderResponse {
  readonly output: unknown;
  readonly model: string;
  readonly providerRequestId?: string;
  readonly finishReason: string;
  readonly usage?: ModelUsage;
}

interface ModelProvider {
  readonly capabilities: ModelCapabilities;
  invoke(request: ModelProviderRequest): Promise<ModelProviderResponse>;
}
~~~

OpenAI message、content block、response_format 和错误对象只存在于 model-providers/openai-compatible 内。

### 11.2 Gateway

~~~ts
interface StructuredOutputContract<T> {
  readonly name: string;
  readonly jsonSchema: JsonSchema;
  parse(value: unknown): T;
}

interface StructuredOutputValidationIssue {
  readonly path: string;
  readonly reason: string;
}

interface ModelGateway {
  invokeStructured<T>(
    request: StructuredModelRequest,
    output: StructuredOutputContract<T>,
  ): Promise<ValidatedModelResult<T>>;
}
~~~

Contract Parser 只通过 `StructuredOutputValidationError` 暴露脱敏的 `path` 与 `reason`。Gateway 最多携带三项、限制长度并过滤字符后加入一次 correction message；任意异常消息和原始模型响应都不会进入纠错提示。

Model Gateway 负责：

- 根据 Model Profile 选择 Provider 和模型。
- 在调用前检查 structuredOutput 能力。
- 应用超时、有限重试和预算。
- 使用运行时 Schema 校验 Provider 输出。
- 归一化鉴权、限流、超时、协议和 Schema 错误。
- 记录模型、用量、延迟和错误摘要。

首版只注册一个 OpenAI-compatible Provider，但注册和 Profile 边界不绑定供应商。未来 Anthropic、Gemini 或 Ollama 只需实现 ModelProvider Contract。

Schema 或 Evidence 校验在一次修正后仍失败时，Model Agent 将 `InvalidStructuredOutput` 转换为 Runner Kernel 定义的 `ExecutionBlockedError`。ExecutionRuntime 只捕获这一供应商无关的阻塞信号并记录 `run_completed: blocked`；鉴权、限流、超时和 Provider 不可用等基础设施错误继续向应用层传播。

### 11.3 Decision

~~~ts
interface DecisionProposal {
  readonly action: {
    readonly kind: "click";
    readonly nodeId: string;
  };
  readonly reason: string;
}
~~~

模型只返回 nodeId。Action Resolver 根据当前 graphId 和 Session 内映射解析 Playwright Locator。

### 11.4 Verification

~~~ts
interface VerificationEvidenceValue {
  readonly graphId: string;
  readonly nodeId: string;
  readonly text: string;
}

interface VerificationClaim {
  readonly expected: VerificationEvidenceValue;
  readonly observed: VerificationEvidenceValue;
}

type VerificationJudgment =
  | {
      readonly status: "passed";
      readonly summary: string;
      readonly claims: readonly [];
    }
  | {
      readonly status: "failed";
      readonly summary: string;
      readonly claims: readonly VerificationClaim[];
      readonly severitySuggestion: "low" | "medium" | "high";
    };
~~~

Verification 是模型判断，不是最终 Finding。passed 必须包含空 claims；failed 必须至少包含一个 claim。代码检查 graphId 和 nodeId 是否存在，并要求返回的 text 与对应 Observation 节点的规范化可见文本一致。校验通过后，代码才确定性生成 Finding ID、Run ID、Evidence 引用和终态。

## 12. Playwright Target Adapter

一个 PlaywrightBrowserSession 被 Observer、Resolver 和 Executor 共享。

~~~ts
interface WebObserver {
  capture(session: BrowserSession): Promise<ObservationCapture>;
}

interface WebActionResolver {
  resolve(
    action: DecisionProposal["action"],
    observation: ObservationCapture,
  ): Promise<ResolvedWebAction>;
}

interface WebActionExecutor {
  execute(
    session: BrowserSession,
    action: ResolvedWebAction,
    permit: ExecutionPermit,
  ): Promise<ActionOutcome>;
}
~~~

ObservationGraph 首版包含：

- graphId、URL、页面标题和 capturedAt。
- 可交互元素和完成目标所需的关键文本节点。
- role、name、text、value、disabled 等语义属性。
- 当前 Session 和 graphId 范围内稳定的 nodeId。
- Observation JSON 与截图的 Artifact 引用。

nodeId 到 Playwright Locator 的映射只存在于 Browser Session，不持久化 Playwright 对象。持久化证据保留语义信息和原始 Observation。

首版模型判断使用语义 Observation。截图作为证据保存，但不要求模型具备视觉能力；视觉模型输入留给后续 M1 硬化。

## 13. 执行数据流

~~~text
1. CLI 解析参数并校验配置
2. Composition Root 打开 SQLite 和 Artifact Store
3. RunExecutionUseCase 创建 Execution Run
4. Playwright 打开目标页面
5. 采集 Before Observation JSON 和截图
6. Trace Recorder 提交 Observation Event
7. Model Gateway 执行 Decision 调用
8. 校验 Decision Schema 和 nodeId
9. Resolver 将 nodeId 解析为 Locator
10. Policy Gate 授予 ExecutionPermit
11. Playwright 执行 Click
12. 采集 After Observation JSON 和截图
13. Model Gateway 执行 Verification 调用
14. 校验 Verification Schema、Claim 和 Evidence 节点
15. 确定性代码生成 Finding 或 Passed Result
16. Trace Ingestor 写入终止 Event
17. CLI 输出结果
18. finally 关闭 Browser、数据库和临时资源
~~~

Runner 产生的 Trace 仍经过 Runner Protocol Envelope 和 TraceIngestor。单进程模式使用 InMemoryRunnerProtocolAdapter，不绕开消息哈希、幂等键、序号和完整性校验。

## 14. Trace 与终止状态

成功发现 Bug 的标准 Trace 顺序：

~~~text
observation
decision
action_resolved
policy_authorized
action_executed
observation
verification
finding
run_completed
~~~

协议增加统一终止 Payload：

~~~ts
interface RunCompletedTracePayload {
  readonly status: "passed" | "finding" | "blocked" | "error";
  readonly findingId?: string;
  readonly errorCode?: string;
}
~~~

每个已经创建的 Run 必须产生且只产生一个 run_completed Event。配置在 Run 创建前失败时不产生 Trace。

产品 Finding 与运行错误严格区分：

- Verification 发现有证据支持的产品偏差时才生成 Finding。
- 策略拒绝、模型无效输出和节点失效产生 blocked，不生成产品 Finding。
- 数据库、浏览器或 Provider 基础设施失败产生 error，不生成产品 Finding。

## 15. SQLite 与 Artifact Store

### 15.1 SQLite

首版表：

- schema_migrations
- execution_runs
- trace_events
- findings
- artifact_manifests
- model_invocations

关键约束：

- trace_events 对 run_id 和 sequence_number 唯一。
- Trace idempotency_key 唯一。
- findings 以 finding_id 为主键并保持内容哈希幂等。
- Artifact Manifest 保存 artifact_id、run_id、kind、media_type、relative_path、sha256 和 size。
- model_invocations 保存 operation、模型标识、用量、延迟、状态和错误摘要。
- SQLite 启用 WAL、Foreign Keys 和 Busy Timeout。
- Trace 追加与 Run 当前序号更新在同一事务中完成。
- Migration 在 CLI 创建 Composition Root 时运行。

不使用 Node 内置 node:sqlite。首版使用 Kysely 和 better-sqlite3。

### 15.2 Artifact Store

默认目录：

~~~text
.qualigence/
├─ qualigence.db
└─ artifacts/
   └─ <run-id>/
      ├─ before-observation.json
      ├─ before.png
      ├─ after-observation.json
      └─ after.png
~~~

Artifact 先写临时文件，完成后原子重命名，再写入带 SHA-256 的 Manifest。SQLite 不保存截图或大块 Observation 正文。

模型原始响应和完整 Prompt 默认不落盘。只保存校验后的结构化结果、模型标识、Token 用量、延迟和脱敏错误摘要。

## 16. 错误与有限恢复

本轮禁止静默降级：

| 故障 | 行为 |
|---|---|
| 缺少模型配置 | Run 创建前失败，退出码 3 |
| Provider 401/403 | 不重试，error |
| Provider 其他 4xx | 归一化为 `InvalidRequest`，不重试，error |
| Provider 429、5xx 或超时 | 最多重试两次，指数退避；耗尽后 error |
| 模型输出不符合 Schema | 携带校验错误修正一次；仍失败则 blocked |
| Decision 引用不存在的 nodeId | 拒绝执行，blocked |
| Locator 在执行前失效 | 重新观察一次，不自动重新规划，blocked |
| 页面导航或 Action 超时 | 记录 Action Outcome，blocked |
| Verification 引用虚假证据 | 修正一次；仍失败则 blocked |
| SQLite 写入失败 | error，不生成产品 Finding |
| Artifact 写入失败 | error，不提交引用缺失的 Finding |

所有已创建 Run 的失败路径都尝试记录 run_completed。若 SQLite 本身不可写，CLI 仍输出脱敏错误并返回退出码 3。

## 17. Fixture

tests/fixtures/web-cart 提供同一页面的两个确定性模式。

正常模式：

- 商品价格为 $19。
- 点击加入购物车后总价为 $19。
- Verification 应为 passed。

故障模式：

- 商品价格为 $19。
- 点击加入购物车后总价错误显示 $29。
- Verification 应为 failed。
- Finding 应包含期望 $19、实际 $29 及对应 Evidence 节点。

Fixture 自带代码 Oracle，只用于测试评分，不参与产品运行时判断。

## 18. 测试设计

所有测试继续位于顶层 tests 目录。

~~~text
tests/
├─ unit/
│  ├─ execution-application/
│  ├─ model-gateway/
│  ├─ runner-kernel/
│  └─ target-adapters/
├─ contract/
│  ├─ model-providers/
│  ├─ sqlite/
│  └─ artifact-fs/
├─ component/
│  └─ web-execution/
├─ e2e/
│  └─ cli-web-cart/
├─ live/
│  └─ remote-model-smoke/
└─ fixtures/
   └─ web-cart/
~~~

### 18.1 Unit

- Model Gateway 能力检查、Schema 校验、Retry 和错误归一化。
- Observation 构建和 nodeId 稳定性。
- Action Resolver 拒绝跨 graphId 或不存在的节点。
- Verification Evidence 校验。
- Run 终态和 CLI 退出码映射。

### 18.2 Contract

- OpenAI-compatible HTTP 请求和响应映射。
- Provider 的鉴权、限流、超时、5xx 和无效 JSON 行为。
- SQLite Trace/Finding 幂等、事务和重开数据库后的读取。
- Artifact 原子写入、哈希和 Manifest。

### 18.3 Component

使用内存 Target、确定性 Model Provider 和真实 ExecutionRuntime 验证 RunExecutionUseCase 的成功、Finding、blocked 和 error 路径。

### 18.4 CLI E2E

普通 CI 启动：

- 购物车 Fixture Server。
- 模拟 OpenAI-compatible HTTP Endpoint。
- 真实 CLI 子进程。
- 真实 Playwright Chromium。
- 临时 SQLite 数据库。
- 临时 Artifact 目录。

模拟 Endpoint 根据请求中的 Observation 动态返回对应 nodeId 和 Verification，不写死运行期节点 ID。E2E 分别验证正常与故障模式，并从 SQLite 和 Artifact Store 重读结果。

### 18.5 Live Model Smoke

只有显式提供远程模型配置时运行。它复用故障 Fixture 和真实 CLI，但不进入普通 PR 合并硬门槛，不断言模型措辞，只断言结构化输出、证据真实性和最终 Finding。

## 19. 技术依赖

- commander：CLI 参数解析。
- playwright：浏览器 Session、Locator、Observation 和截图。
- openai：OpenAI-compatible Provider Adapter。
- zod：配置与模型结构化输出校验，并导出 JSON Schema。
- kysely 与 better-sqlite3：SQLite Provider。
- pino：结构化日志和敏感字段脱敏。
- fastify：Fixture Server。
- vitest：Unit、Contract、Component 和 CLI E2E。

依赖版本在实施计划中锁定并通过 Node.js 24 验证。本设计不引入 LangChain、队列、工作流引擎或新的常驻服务。

## 20. 安全与数据边界

- API Key 不进入命令参数、日志、Trace、Finding 或 Artifact。
- 日志不输出完整 Prompt、模型原始响应、完整 DOM 或截图内容。
- URL 在导航前校验为 http 或 https。
- 首版 Policy Gate 只允许当前页面 Origin 的 click。
- 模型不能直接执行工具、访问 Store 或改变领域状态。
- Finding 只能引用已登记且哈希有效的 Artifact。
- CLI JSON 输出和日志输出分离。

## 21. 未来 PRD 流程

未来从 PRD 生成产品测试时，链路为：

~~~text
PRD
→ 需求理解
→ Expected Claims
→ Structured Test Cases
→ Test Mission
→ Execution Jobs
→ RunExecutionUseCase
→ Runner
→ Trace / Finding / Evidence
~~~

PRD Planner 不启动 CLI。CLI、Web API、Worker 和 PRD Planner 都调用共享应用接口。

生成的 Test Case 必须是结构化意图，不包含 CSS 或 XPath：

~~~ts
interface TestCase {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly IntentStep[];
  readonly expectedClaims: readonly ExpectedClaim[];
  readonly sourceRefs: readonly PrdSourceRef[];
  readonly priority: "low" | "medium" | "high";
}
~~~

PRD 解析、多步骤执行和批量 Mission 不属于本轮范围，但本轮的 RunExecutionUseCase 和供应商中立模型边界必须允许它们后续接入。

## 22. 完成标准

以下条件全部满足才视为本纵向闭环完成：

1. CLI 可以运行正常与故障购物车场景。
2. 正常场景返回 passed 和退出码 0。
3. 故障场景发现 $19 与 $29 冲突，生成 Finding 并返回退出码 1。
4. Decision 和 Verification 均经过 Model Gateway。
5. 模型不能提供 selector 或伪造 Evidence。
6. Trace 顺序完整，且每个 Run 只有一个 run_completed。
7. Run、Trace、Finding、Artifact Manifest 和模型调用摘要可从 SQLite 重读。
8. Before/After Observation JSON 和截图可通过 Manifest 定位并通过哈希校验。
9. 普通 CI 不依赖真实 API Key。
10. 显式配置后可以运行真实远程模型 Smoke Test。
11. CLI 与未来入口复用 RunExecutionUseCase。
12. Unit、Contract、Component、CLI E2E、类型检查和 Node Package Import Smoke 全部通过。

## 23. 后续 M1 硬化

本纵向闭环完成后，M1 仍需按总体设计补齐：

- Core Daemon 与 Local Runner 独立进程。
- gRPC Runner Protocol Transport。
- Capability Negotiation。
- Runner Spool 与断线提交。
- 视觉模型输入。
- Local Launcher、健康检查和升级备份。

这些工作不会改变本设计冻结的 Runner Kernel、Model Provider、Target Adapter、Evidence Store 和 RunExecutionUseCase 边界。
