# Qualigence 开源架构设计

- 状态：已批准
- 日期：2026-07-21
- 范围：Local Runner、Local Core、Runner Protocol、Self-hosted Server
- 目标用户：个人开发者与中小团队

## 1. 目标与边界

Qualigence 开源版是一套可以独立完成端到端 AI 软件测试的本地优先系统。用户可以选择：

1. 在一台开发机上同时运行 Core、Runner 与 Web Console；或
2. 在企业网络内部署共享 Server，再连接一台或多台本地 Runner。

Local 与 Self-hosted 是并列的部署选择，不是开源版向云端版演进的中间阶段。两者共享相同领域模型、API、Runner Protocol、Web Console 和 AI 工作流。

开源版必须在不连接 Qualigence Cloud 的情况下完成：

- 从网站 URL、应用启动命令、录制流程、PRD、代码仓库或已有测试资产创建测试任务。
- 执行回归测试与探索式测试。
- 归纳、验证、注册和检索 Test Skill。
- 构建并增量维护 Application Model。
- 生成 Finding、自动复现、迭代调查并转人工确认。
- 形成可描述、可解释、可回放的 Bug Episode。
- 使用本地模型、用户自带模型 API 或企业内部模型 API。

## 2. 架构原则

- **本地优先**：完整原始轨迹默认留在 Runner 或企业存储内。
- **端到端开源可用**：云端不是核心测试流程的必需依赖。
- **模块化单体 Core**：逻辑模块边界清晰，本地不承担微服务运维成本。
- **Runner 与 Server 解耦**：即使同机运行，也只通过版本化协议通信。
- **双 AI 系统**：Runner 的 Execution Agent 与 Server 的 Test Intelligence 独立部署、独立配置模型。
- **异步 Intelligence 契约**：所有服务端 AI 操作都表现为持久化 `IntelligenceJob` 和幂等 `IntelligenceResult`，本地进程内执行也不绕过该边界。
- **模型可替换**：所有模型调用通过 Model Provider 和 Model Profile 完成。
- **预期与实际分离**：Expected Claim 不覆盖 Observed Fact，冲突进入调查流程。
- **确定性控制 AI**：权限、预算、状态迁移、重试和发布门禁由确定性服务执行。
- **证据优先**：LLM 结论必须关联可追溯的结构化轨迹和原始证据。
- **可扩展平台**：浏览器、桌面、未来移动端和游戏通过 Adapter/Provider 扩展。

## 3. 部署形态

### 3.1 Community Local

```text
Developer Machine
├─ Web Console（localhost）
├─ CLI / Local API
├─ Core Daemon
├─ Local Runner
├─ Desktop Companion / Session Agent
├─ Embedded Relational Store
├─ Local Artifact Store
├─ Embedded Durable Work Store
└─ Local/BYO Model Providers
```

Community Local 使用一个安装包完成初始化。Core 默认只监听回环接口；Desktop Companion 按需启动，不提供第二套项目管理 UI。

### 3.2 Team Self-hosted

```text
Private Network
├─ Web Console / CLI / CI
├─ Qualigence Server
│  ├─ Open-source Core Modules
│  ├─ External Relational Store
│  ├─ Object Storage
│  ├─ Durable Queue
│  └─ Local/Enterprise Model Gateway
└─ One or More Local Runners
   └─ Optional Desktop Companion per User Session
```

Self-hosted Server 使用与 Local Core 相同的业务模块，通过 Provider 替换存储、队列、身份认证和模型服务。小团队可以单节点部署；增加 Runner 不要求拆分 Core。

## 4. 系统上下文

```text
Web Console / CLI / CI / API
              │
              ▼
┌──────────────────────────────────────┐
│ Qualigence Core / Self-hosted Server │
│ Mission · App Model · Skill · Bug    │
│ Policy · Model · Evidence · Adapter  │
└──────────────────────────────────────┘
              │ Runner Protocol
              ▼
┌──────────────────────────────────────┐
│ Local Runner                         │
│ Execution Agent · Sensors · Actions  │
│ Environment · Recording · Artifacts  │
└──────────────────────────────────────┘
              │ Local IPC
              ▼
┌──────────────────────────────────────┐
│ Desktop Companion / Session Agent    │
│ Permissions · Overlay · Approval     │
└──────────────────────────────────────┘
```

## 5. Core 逻辑模块

Core 是模块化单体。模块可以在同一进程运行，但只能通过公开应用接口、命令和领域事件协作。

### 5.1 Project & Target

管理项目、被测目标和版本：

- `WebTarget`：入口 URL、允许域名、浏览器与登录策略。
- `AppTarget`：启动命令、工作目录、环境变量、目标进程、退出和重置命令。
- 未来 `GameTarget`、`MobileTarget` 通过相同接口扩展。

### 5.2 Context Intake & Mission Compiler

接收并归一化：

- URL 或应用启动命令。
- Record & Replay 轨迹。
- PRD、用户故事和验收标准。
- Git 仓库、PR、Commit 和代码差异。
- API Schema、历史 Bug、测试用例和已有 Skill。

`Mission Compiler` 将输入编译成版本化 `Test Mission`，包含目标、风险区域、Seed Skill、探索策略、环境矩阵、数据策略、安全策略、执行预算和调查预算。

### 5.3 Application Model

Application Model 按项目持久化并按构建版本演化：

- `Project Model`：长期业务概念、角色、页面、流程和不变量。
- `Build Model`：具体版本观察到的状态、转换和能力。
- `Runtime State`：Runner 当前任务中的临时状态。

模型分别保存：

- `Expected Claim`：来自 PRD、验收标准、人工确认或可信 Skill。
- `Observed Fact`：来自 Runner、日志、语义树或执行结果。
- `Conflict`：预期与实际不一致，尚未完成定性。
- `Disposition`：Bug、需求过期、环境差异、Flaky 或误报等最终结论。

每项事实或声明必须保存来源、适用版本、置信度、创建者和证据引用。

Application Model 不使用简单的 Last-Write-Wins。Runner 和 Intelligence Worker 只能提交带 `base_model_version` 的变更 Proposal；确定性合并器使用乐观并发控制应用变更：

- Observed Fact 与 Expected Claim 以追加方式保存，不互相覆盖。
- 相同来源、相同版本和相同语义身份的重复事实可以幂等合并。
- 不同来源或不同结论的事实并存，并产生 Conflict。
- 已确认 Disposition 只约束其明确适用的构建版本和上下文。
- Proposal 基于过期版本时重新归并或重新计算，不能静默覆盖新事实。

### 5.4 Skill Intelligence

Skill 类型包括：

- Procedure Skill
- Navigation Skill
- Exploration Skill
- Oracle Skill
- Recovery Skill
- Evidence Skill

Skill 生命周期固定为：

```text
Draft → Candidate → Verified → Promoted → Deprecated
```

Server 从录制、成功执行、探索和人工修正中完成参数、分支、检查点、Oracle 和恢复策略归纳。未经验证的 Skill 不能自动提升为可信资产。

Registry 分三层：

1. Qualigence Official：签名发布的官方 Skill。
2. Community：用户明确贡献、脱敏并审核后的公共 Skill。
3. Tenant Private：项目或组织私有 Skill，默认禁止跨租户传播。

Runner 在任务开始前预取 Skill，执行中可按当前状态再次检索；离线时使用已签名的本地缓存。

所有可执行 Skill Bundle 都必须签名，而不只是 Official Skill：

- Tenant Private Skill 由企业或本地 Registry 签名。
- Community 投稿保留贡献者签名；审核通过后由 Community Registry 再签名。
- Official Skill 由 Qualigence 发布密钥签名。
- Runner 验证 Bundle 内容哈希、签名链、适用范围、版本和撤销状态。

Oracle Skill 不能屏蔽崩溃、权限违规、数据损坏等确定性高置信信号，只能增加、解释或降低非确定性 Finding 的置信度。Oracle 晋升到 Verified 或 Promoted 前，必须在包含已知真 Bug 的回归集上证明不会引入不可接受的假阴性。

### 5.5 Mission Orchestration & Runner Scheduling

负责：

- 将 Mission 分解为回归、探索、复现和补证任务。
- 按操作系统、传感器、应用版本、环境和模型能力匹配 Runner。
- 发放有期限的 `ExecutionJob` Lease。
- 维护检查点、暂停、恢复、取消和人工接管状态。
- 根据执行预算终止任务。

Core 的确定性 Application Service 是 Mission、Skill、Investigation、Reproduction、ReviewTask 聚合状态以及 Application Model 的唯一写入者。Runner 只追加 Observation、Execution Event 和 Fact Event。调度器不执行 LLM 决策；Agent 只能在调度器允许的状态迁移中工作。Cloud 部署中，该 Application Service 由 Cloud Control Plane 承载。

### 5.6 Trace & Evidence

统一 Trace 事件格式为：

```text
Observation → Decision → Action → State Delta → Verification → Evidence
```

完整轨迹采用追加写事件记录。截图、录像、日志、DOM、Accessibility Tree、崩溃文件等大对象进入 Artifact Store，事件只保存内容哈希、位置、敏感级别和生命周期策略。

### 5.7 Finding & Bug Investigation

Runner 先产生 `Finding Candidate`，Server 创建内部 `Investigation Case`：

```text
Candidate → Investigating → Reproducing
          → Confirmed / Refuted / Flaky / Needs Human
          → Resolved → Regression Verified
```

Server 根据 Finding Envelope 生成版本化复现计划，下发 Runner 并根据反馈修订。每次 `Reproduction Attempt` 不可覆盖，保存计划、检查点、偏离位置、结果、环境和证据。

可配置预算包括：

- `max_reproduction_attempts`
- `max_planning_revisions`
- `max_environment_retries`
- `max_wall_clock_duration`
- `max_model_tokens_or_cost`
- `max_environment_resets`
- `max_destructive_actions`
- `confidence_threshold`

预算耗尽后转为 `Needs Human`，并生成包含最佳假设、尝试历史、失败位置、关键证据和建议动作的人工交接包。只有 Confirmed 或 Needs Human Case 才按策略同步外部缺陷系统。

Core 提供最小 `Human Review Queue`：每个 `ReviewTask` 是由确定性 Application Service 管理的正式聚合，保存原因、优先级、Case 引用、证据完整度、负责人和处理状态。首期只支持 `Open → Claimed → Resolved`，复杂排班、SLA 和运营路由不属于开源首个闭环。

`ClaimReviewTask` 命令必须携带 `expected_version`、`reviewer_id` 和幂等键。只有最新状态为 Open 且版本匹配时才能认领；并发认领的失败方获得当前负责人和最新聚合版本，不能用滞后投影覆盖认领结果。

### 5.8 Policy & Approval

动作风险分类：

```text
ReadOnly
LocalMutation
RecoverableMutation
ExternalSideEffect
Destructive
ProductionForbidden
```

Policy Engine 根据环境、目标、账号、动作、授权和数据策略做确定性判断。Runner 是最终执行闸门。隔离且可恢复环境可预授权部分高风险动作；外部副作用仍需审批；生产环境默认禁止探索式测试。

`Interactive Desktop` 是不可恢复的真实用户会话：`ExternalSideEffect`、`Destructive` 和 `ProductionForbidden` 动作不得预授权，必须逐次获得本地人工确认或被拒绝。服务端批准不能替代该本地不变量。

### 5.9 Model Gateway

模型配置分为独立 `Model Profile`：

- Execution
- Vision
- Planning
- Skill Induction
- Bug Review
- Retrieval/Embedding

Model Provider 支持本地模型、用户 API、企业内部 API 和兼容网关。Profile 声明视觉、工具调用、结构化输出、上下文和数据出站能力。路由、降级、预算和凭证由配置控制；Runner 与 Server 可以使用完全不同的模型。

### 5.10 Integrations

通过 Connector 接入 Git、PR、PRD、CI/CD、Issue Tracker、API Schema 和可观测性系统。灰盒上下文增强测试，但黑盒工作流不依赖任何 Connector。

### 5.11 IntelligenceJob Contract

`IntelligenceJob` 专指服务端 AI 工作，不通过 Runner Protocol 下发；Runner 实际操作软件的工作统一称为 `ExecutionJob`。Mission Planning、Application Model 归纳、Skill Induction/Evaluation、Bug Analysis 和 Retrieval 等服务端 AI 操作统一提交为持久化 `IntelligenceJob`：

```text
IntelligenceJob
├─ job_id / job_type / schema_version
├─ tenant / project / aggregate_ref
├─ base_aggregate_version
├─ input_refs / model_profile
├─ data_policy / budget / priority
├─ idempotency_key / causation_id
└─ expected_result_schema

IntelligenceResult
├─ job_id / result_schema_version
├─ proposals / evidence_refs
├─ confidence / provenance
├─ usage / terminal_status
└─ idempotency_key
```

Local Core 可以由进程内 Worker 消费 `IntelligenceJob`，Self-hosted 可以使用外部队列，Cloud 可以使用独立 Worker Plane；三种部署都必须走相同 `IntelligenceJob` / `IntelligenceResult` 契约。`IntelligenceResult` 不能直接修改聚合，只能由确定性 Application Service 在校验 Schema、Budget、Policy、幂等键和 `base_aggregate_version` 后应用。

## 6. Runner 架构

### 6.1 Execution Agent

Execution Agent 在 Runner 内完成低延迟的观察、决策、操作、验证和证据采集。Server 负责高层 Test Mission、Skill Intelligence、Bug Investigation 和跨任务分析。

### 6.2 Observation Fusion

Runner 通过 Sensor Adapter 采集：

- 屏幕、局部图像和 OCR。
- DOM 与浏览器 Accessibility Tree。
- Windows UI Automation、macOS Accessibility、Linux AT-SPI。
- 窗口、进程、焦点和系统弹窗。
- 控制台、网络、应用日志、Tracing、崩溃和性能数据。
- 未来游戏 Scene Tree、引擎状态和调试接口。

所有观察转换成统一 `Observation Graph`，节点至少具有：

```text
id · role · name · value · state · bounds
relations · source · confidence · sensitivity
```

上述字段只构成跨平台交互核心，不要求把平台全部语义压平。每个节点可以携带版本化的 typed extension 和原始证据引用，例如 DOM 属性、UIA Pattern、AX Attribute 或游戏引擎组件；平台 Adapter 必须保留无损 source payload，通用规划器只消费其理解的核心字段和扩展能力。Observation Graph v1 在 Web 与至少一个原生 Desktop Adapter 的共同基准通过前不得冻结。冻结前生成的 Trace、Semantic Locator 和 Skill 必须标记 `observation_schema_epoch=pre-v1`、Locator Schema Version 与 Skill Compiler Version。

### 6.3 Action Resolution

动作目标按以下顺序解析：

```text
Semantic Node → Platform Selector → Visual Anchor → Coordinates
```

Replay 是意图级重放。Runner 在每个检查点重新定位目标和验证状态；偏离时重新规划或返回 `Plan Diverged`，不会盲目继续坐标操作。

### 6.4 Environment Provider

隔离环境包括：

- 独立 Browser Profile。
- 虚拟机或可重置 Desktop Sandbox。
- 用户授权的 Interactive Desktop。
- 未来设备、模拟器和 Game Rig。

每个环境声明能力、初始快照、账号、网络条件、重置和销毁策略。

### 6.5 Desktop Companion / Session Agent

Desktop Companion 是轻量原生用户会话组件，仅负责：

- 屏幕与 Accessibility 权限引导。
- 托盘状态。
- 录制悬浮条。
- 当前操作提示。
- 敏感动作确认。
- 暂停、继续和紧急停止。

项目管理、报告和 Skill 管理只存在于 Web Console。Headless 浏览器或 CI 任务不需要启动 Companion。

## 7. Runner Protocol

Runner Protocol 是开源版与 Qualigence Cloud 共同遵守的兼容边界。

### 7.1 连接模型

- Runner 主动建立出站 TLS 连接，Server 不主动进入客户网络。
- Local 模式使用相同协议连接回环地址。
- 长连接承载命令、心跳和事件流；大对象通过独立 Artifact Transfer 接口传输。
- 每次连接先完成协议版本、Runner 版本和 Capability Negotiation。

### 7.2 核心消息

- `RunnerHello` / `RunnerCapabilities`
- `ExecutionJobOffer` / `ExecutionJobAccept` / `ExecutionJobLeaseRenew`
- `MissionContext`
- `SkillBundle`
- `ExecutionEventBatch`
- `FindingEnvelope`
- `ArtifactManifest`
- `EvidenceRequest` / `EvidenceResponse`
- `ReproductionPlan` / `ReproductionResult`
- `ApprovalRequest` / `ApprovalDecision`
- `Pause` / `Resume` / `Cancel`
- `ExecutionJobComplete` / `ExecutionJobFailed`

消息包含唯一 ID、租户/项目范围、协议版本、因果 ID、幂等键、序号和时间戳。

### 7.3 交付语义

- `ExecutionJob` 使用 Runner Lease，Runner 失联后由 Server 在 Lease 过期后回收。`IntelligenceJob` 不属于 Runner Protocol，使用 Intelligence Worker Lease 和独立的 `IntelligenceResult` 幂等应用语义。
- 命令按至少一次交付设计，接收方通过幂等键去重。
- Trace Event 在单个 Run 内保持单调序号；断线重连从最后确认序号继续。
- Artifact 通过内容哈希校验，重复上传不产生新对象。
- 不兼容能力返回结构化拒绝，不允许静默降级。

## 8. Finding Envelope 与证据上传

完整 trajectory 默认保留本地。Runner 默认上传紧凑 Finding Envelope：

- 软件、构建和环境。
- 异常触发信号。
- Expected/Observed 差异。
- 异常前后的结构化 Trace Slice。
- 相关动作和语义目标。
- DOM/Accessibility 差异摘要。
- Artifact Manifest。
- 数据敏感级别和允许的处理位置。

Server 通过 `Evidence Request` 按需请求轨迹片段、截图、日志或语义子树。Runner 根据策略自动提供、脱敏后提供、请求人工审批、拒绝，或改成本地 Bug Analysis。

为避免 Runner 离线阻塞调查，Mission 可以配置以下证据预暂存策略：

- `manifest_only`：只上传 Finding Envelope 和 Artifact Manifest。
- `bounded_on_finding`：Finding 达到本地触发规则后，预上传有界 Evidence Capsule。
- `local_only`：原始证据始终留在本地，Server 只能继续请求结构化结论。

Evidence Capsule 在 Runner 侧完成脱敏和信封加密，并受类型白名单、最大字节数、Trace 时间窗口和 TTL 约束。它只包含调查所需的有限 Trace Slice、语义子树、局部截图和日志摘要，不包含完整 trajectory。Server 后续 Evidence Request 仍受同一数据策略限制。

签名的 Mission Policy Bundle 必须携带 `EvidenceEncryptionProfile`，声明接收方 Server、数据区域、包装密钥 ID、公钥/证书、允许算法和有效期。Runner 为每个 Capsule 生成一次性 Data Encryption Key（DEK），使用 AEAD 加密 Capsule，再使用目标 Local Core、Self-hosted Server 或 Cloud 区域 KMS 的包装公钥加密 DEK。Runner 上传密文、Wrapped DEK、Key ID 和策略元数据，不上传明文 DEK。

授权的 Server 调查 Worker 可以在 Runner 离线后，通过目标区域的 Key Management Provider 解包 DEK 并受限解密；每次解密必须校验 Tenant、Case、Purpose、数据策略和 TTL，并写入审计事件。Self-hosted 使用企业自己的 KMS 或 Server wrapping key；Cloud 只能使用数据驻留区域内的 KMS。`local_only` 不生成任何面向远端 Server 的 Wrapped DEK。TTL 到期时删除密文并撤销对应解包能力。

## 9. 数据与存储

定义 Provider 接口而不把领域逻辑绑定到具体数据库：

- Relational Store：项目、Mission、Skill、Case 和状态机。
- Event Store：追加 Trace、领域事件和审计事件。
- Artifact Store：截图、视频、日志和导出包。
- Search/Vector Index：Skill、Application Model 和 Finding 检索。
- Durable Work Store：分别保存 `ExecutionJob` 与 `IntelligenceJob` 的 Lease、重试和延迟执行状态，不混用二者的消息类型与状态机。
- Key Management Provider：发布 Evidence Encryption Profile、执行密钥包装/解包、轮换、撤销和解密审计。

Local 使用嵌入式实现；Self-hosted 可切换为外部实现。Project Bundle 包含结构化数据、事件、Skill 和经过选择的 Artifact，可在两种部署之间导入导出。

### 9.1 状态一致性

- 聚合状态写入使用 expected version 和乐观并发控制。
- Runner Event 在单个 Run 内按序号有序；跨 Run 事件不承诺全局顺序。
- 领域事件先与聚合状态原子提交，再通过 Outbox 投递给投影与 `IntelligenceJob` 队列。
- Web Console 的列表、搜索和分析投影采用最终一致性，并暴露 `as_of_event` 与 projection lag。
- 命令响应和安全关键判断读取聚合真相，不依赖可能滞后的分析投影。
- 重复、乱序和延迟事件必须通过幂等键、聚合版本和因果 ID 被检测或拒绝。

### 9.2 Event 与 Project Bundle 版本

- 每种 Event、Snapshot 和 Bundle Manifest 都携带独立 Schema Version。
- Event Store 保留原始不可变事件；读取侧通过 upcaster 转换旧版本，不原地重写历史事件。
- 同一 major 版本内新增字段必须可选，旧读取器可以忽略未知 minor 字段。
- 新 major Bundle 导入旧 Self-hosted 时明确拒绝，并返回最低兼容版本；不承诺任意新 Cloud Bundle 可被任意旧版本读取。
- 支持的导出器可以显式生成目标旧版本 Bundle，但必须报告被降级、遗漏或无法转换的能力。
- 升级先在副本上运行迁移与完整性校验，成功后再切换活动版本。
- Event upcaster 只负责历史事件的读取兼容，不能自动修复已编译 Skill 中的 Semantic Locator。Observation Graph v1 冻结时，pre-v1 Trace 保持不可变并重新生成标准化投影；pre-v1 Skill 必须从来源 Trace 重新编译、重定位和回放验证。无法迁移的 Skill 进入 Deprecated 或 Needs Human，pre-v1 Skill 不承诺二进制前向兼容。

## 10. 安全与合规

- Runner、Server、模型和 Connector 分别使用最小权限凭证。
- 原始证据、语义树和 DOM 均按潜在敏感数据处理。
- 脱敏优先发生在 Runner。
- Tenant Private Skill 不包含可跨租户传播的原始 Artifact。
- 公共 Skill 晋升必须经过主动贡献、脱敏、来源与许可证检查、自动验证和人工审核。
- 所有动作、模型调用、数据请求、审批和状态迁移写入审计日志。
- 私有部署可以完全禁用互联网访问和公共 Registry 同步。

## 11. 错误处理与恢复

- Runner 失联：保留本地事件，重连后续传；ExecutionJob Lease 到期后 Server 决定重试或转移。只有已按目标 Server/KMS 的 Evidence Encryption Profile 完成信封加密并预暂存的 Capsule 才能继续受限调查，否则明确标记 `Evidence Limited` 并等待 Runner。
- KMS 或 wrapping key 不可用：停止 Capsule 解密或预暂存，不得退化为 Runner 独有密钥后仍声称支持离线调查；Case 标记密钥或证据受限。
- `IntelligenceJob` 中断：持久化任务重新租用，重复 `IntelligenceResult` 由幂等键去重；基于过期聚合版本的 `IntelligenceResult` 重新归并或重新计算。
- 模型不可用：按 Profile 降级；没有合规替代模型时暂停任务，不绕过数据策略。
- 环境故障：计入独立环境重试预算，不消耗 Bug 复现预算。
- 计划偏离：返回偏离节点和观察差异，由 Server 修订计划。
- Artifact 不可上传：保留 Manifest 和本地引用，Case 标记证据受限。
- Skill 失效：降低可信度、隔离版本并触发重新验证，不直接覆盖历史版本。
- Core 重启：所有长流程从持久化状态和检查点恢复。

## 12. 扩展边界

首期支持 WebTarget 与 AppTarget。未来游戏支持通过以下现有边界扩展：

- Game Environment Provider
- Game Sensor Adapter
- Game Action Adapter
- Engine-specific Observation Graph enrichers
- Game-specific Exploration/Oracle Skills

游戏扩展不能改变 Mission、Trace、Skill、Finding 和 Runner Protocol 的核心语义。

## 13. 验证策略

- Provider Contract Tests：同一套测试验证本地与外部 Provider。
- Runner Protocol Conformance：版本协商、重连、去重、`ExecutionJob` Lease 和 Artifact 校验。
- Deterministic Workflow Tests：Mission、Skill 和 Investigation 状态机。
- Adapter Replay Tests：使用固定 Observation/Action Trace 验证跨版本行为。
- Policy Tests：风险动作、数据出站和审批矩阵。
- Evidence Crypto Tests：Runner 侧 AEAD、区域包装密钥、Runner 离线解密、KMS 拒绝、轮换、TTL 和跨区域禁止。
- IntelligenceJob Conformance：进程内、外部队列和远程 Worker 对 `IntelligenceJob` / `IntelligenceResult`、幂等应用、超时和重放保持相同语义。
- Model Evaluation：Skill 归纳、Bug 判断、复现步骤和误报率使用固定数据集评测。
- Detection Effectiveness：在带 Ground Truth 的正常版本与故障注入版本上评估 known-bug recall、Finding precision、严重缺陷漏报率、自动复现率、步骤正确率和单位确认 Bug 成本。
- Oracle Adversarial Tests：受污染、过宽或错误 Oracle 不得压制确定性高置信 Finding，并在已知真 Bug 集上执行假阴性回归。
- Concurrency Tests：并发 Proposal、ReviewTask 认领、过期 base version、投影延迟和乱序 Event 不得覆盖事实或产生不可解释状态。
- Migration Tests：Event upcaster、Snapshot、Bundle 同 major 兼容、跨 major 拒绝、目标版本降级导出，以及 pre-v1 Skill 重编译/重定位/重验证。
- Failure Injection：断网、Core 重启、模型超时、Runner 崩溃和存储失败。
- End-to-end Acceptance：Local 与 Self-hosted 必须运行同一组端到端场景。

### 13.1 Detection Benchmark v1

首个可发布版本使用版本化 Benchmark Manifest 固定应用版本、缺陷标签、运行预算和 `Qualigence Reference Model Profile`。Reference Profile 同时固定模型/Provider、Prompt、Policy、Skill Pack、浏览器或应用环境、最大步骤和重复运行次数。最低出口条件为：

- P0/安全类确定性已知缺陷召回率为 100%。
- 全部已知缺陷 recall 不低于 80%。
- Finding precision 不低于 60%。
- 对标记为稳定可复现的已知缺陷，自动复现成功率不低于 70%。
- 正常基准版本每个 30 分钟 Mission 的高置信误报不超过 1 个。
- 每次发布不得在相同 Benchmark、Reference Profile 和预算下使任一关键指标跌破上述下限。

生产环境未知 Bug 的绝对 recall 不可直接观测，因此只在带 Ground Truth 的 Benchmark 上声明 recall；真实项目使用确认率、复现率、人工推翻率和单位有效 Bug 成本监控。

上述发布效果承诺只适用于 Qualigence Reference Model Profile。BYO、本地或企业模型保证 Provider、Schema 和工作流契约兼容，但不自动获得官方检测效果保证；它们可以运行同一 Benchmark 并保存独立结果，未达到发布门槛的配置标记为 `Unverified Model Profile`。

## 14. 架构验证里程碑

这些里程碑是实现顺序和抽象验证 Gate，不缩减目标架构或最终产品范围。

M1/M2 产生的 Observation、Trace、Semantic Locator 和 Skill 均属于 pre-v1 验证资产。它们必须保存原始证据和编译来源，以便 M3 冻结 Observation Graph v1 时重新投影、重编译、重定位和验证；未经该迁移 Gate 的 pre-v1 Skill 不进入长期 Official/Community 兼容承诺。

### 14.1 Milestone 1：Web Walking Skeleton

范围限制为 WebTarget、Community Local、一个 Local Runner、浏览器语义/视觉观察和一个实际 Model Provider。多个逻辑 Model Profile 可以暂时映射到同一模型，但 `ExecutionJob`、`IntelligenceJob` 及其 Event/Result Schema 仍使用正式契约。

必须跑通：

```text
URL → Observation → Decision → Action → Verification → Finding
```

出口条件：Runner Protocol、Trace 顺序、Policy、Finding Envelope 和至少一个已知 Bug 场景端到端通过。

### 14.2 Milestone 2：Web Skill 与调查闭环

增加录制核心流程、单一 Procedure Skill、意图级重放、有限探索、Reproduction Attempt 和 Human Review Queue。

必须跑通：

```text
Recording → Candidate Skill → Verified Skill
→ Regression + Exploration
→ Finding → Reproduction → Bug Episode / Needs Human
```

出口条件：Detection Benchmark v1 达到最低阈值，且断网重连、Runner 离线后的 Evidence Capsule 调查和预算耗尽转人工均通过。

### 14.3 Milestone 3：原生 Desktop 抽象验证

只选择 Windows UI Automation 或 macOS Accessibility 其中一个原生平台，复用相同 Observation Graph、Action Resolution、Trace 和 Finding 契约。

出口条件：Web 与原生 Desktop 的共同交互核心可以表达目标、状态和检查点；平台独有信息通过 typed extension 无损保留。满足后冻结 Observation Graph v1，并完成 pre-v1 Trace 重新投影与 Skill 重编译/重验证；其他桌面平台和游戏继续通过 Adapter 扩展。

## 15. 架构验收条件

本设计满足以下条件才算实现正确：

1. Local 模式无需外部基础设施即可完成端到端测试。
2. Self-hosted 与 Local 共享业务代码和数据契约。
3. Runner 可以只修改 Server Endpoint 连接兼容的 Self-hosted 或 Cloud 实现。
4. Execution Agent 与 Server AI 使用独立 Model Profile。
5. 完整轨迹默认不上传，Server 可以通过受控协议按需补证。
6. Skill 归纳、三层 Registry、Bug 复现迭代和人工移交在开源版可用。
7. Application Model 永久区分 Expected Claim 与 Observed Fact。
8. 权限、预算和状态迁移不由 LLM 单独决定。
9. Web 与桌面 Adapter 不向领域核心泄漏平台特有逻辑。
10. Qualigence Cloud 可以在不修改 Runner Protocol 和核心领域契约的前提下实现相同接口。
11. 所有 Server Intelligence 在 Local、Self-hosted 和 Cloud 中使用相同的持久化 `IntelligenceJob` / `IntelligenceResult` 契约与幂等应用语义。
12. Detection Benchmark v1 达到规定的 recall、precision、复现率和误报下限。
13. 所有层级 Skill 均经过签名验证，Oracle Skill 不能压制确定性高置信信号。
14. Interactive Desktop 不允许预授权外部副作用、破坏性或生产禁止动作。
15. Application Model 并发 Proposal 不使用 LWW，冲突事实可追溯并存。
16. Evidence Capsule 使用目标 Server/区域 KMS 的信封加密，Runner 离线时授权 Worker 仍可解密，且 local-only 数据不能被远端解密。
17. M3 冻结 Observation Graph v1 时完成 pre-v1 Trace 投影和 Skill 重编译/重验证。
18. ReviewTask 并发认领遵守聚合 expected version，不能通过滞后投影覆盖当前负责人。
19. 官方 Detection Benchmark 承诺绑定 Qualigence Reference Model Profile，不误用于未经验证的 BYO 配置。
