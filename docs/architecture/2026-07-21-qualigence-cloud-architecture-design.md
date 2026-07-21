# Qualigence Cloud 架构设计

- 状态：已批准
- 日期：2026-07-21
- 范围：使用开源协议与接口实现的 Qualigence 托管云服务
- 依赖：[Qualigence 开源架构设计](2026-07-21-qualigence-open-source-architecture-design.md)

## 1. 目标与定位

Qualigence Cloud 是开源架构的兼容服务端实现，不是另一个测试产品，也不是 Local Core 的必经演进阶段。

Cloud 必须遵守相同的：

- Runner Protocol
- Mission、Application Model、Skill、Trace、Finding 和 Bug Case 契约
- Adapter、Connector、Model Provider 和存储 Provider 接口
- 风险策略、调查预算与状态机语义
- 数据导入导出格式

用户可以让 Runner 连接 Local Core、Self-hosted Server 或 Qualigence Cloud。Runner 不包含 Cloud 专用业务分支，只通过能力协商发现服务端提供的高级能力。

Cloud 的商业价值来自托管运维、规模、协作、更强智能和服务保障，不来自破坏协议兼容或阻断开源端到端工作流。

## 2. 与开源架构的依赖方向

```text
Open Contracts / SDK / Domain Schemas
               ▲
               │ implements
       Qualigence Cloud
```

依赖只能从 Cloud 指向开源契约：

- 开源 Core 和 Runner 不导入 Cloud 模块。
- Cloud 可以复用开源领域模块，也可以用分布式实现替换 Provider。
- Cloud 的高级 Intelligence 可以使用专有模型或算法，但输入输出必须符合开源 Schema。
- Cloud 新增协议能力时，先以向后兼容方式发布到开放协议，再由 Runner 选择性启用。
- Mission Planning、Application Model、Skill、Bug Analysis 和 Retrieval 必须实现开源 `IntelligenceJob` / `IntelligenceResult` 契约；Cloud 只能改变任务的执行位置和实现质量，不能重定义调用语义。

## 3. 使用模式

### 3.1 Fully Managed Workspace

Runner 直接连接 Qualigence Cloud。Cloud 托管项目、Mission、Skill、Application Model、Bug Case、团队协作、模型和数据服务。

```text
Web Console / CLI / CI
          │
Qualigence Cloud Endpoint
          │
Local Runner(s)
```

### 3.2 Hybrid Intelligence

用户继续运行 Self-hosted Server，只按 Provider 配置使用 Qualigence Cloud 的高级模型、Skill Intelligence 或 Bug Investigation 服务。

```text
Self-hosted Server
├─ Private Project Data
├─ Private Skill Registry
└─ Optional Cloud Intelligence Provider
          │ policy-controlled request
          ▼
Qualigence Cloud Intelligence API
```

Hybrid 模式不允许 Cloud 绕过 Self-hosted Policy Engine 主动获取数据。

## 4. 总体架构

```text
Local Runners
     │ outbound TLS / Runner Protocol
     ▼
┌──────────────────────────────────────┐
│ Runner Gateway & API Edge            │
└──────────────────────────────────────┘
     │
     ├───────────────┐
     ▼               ▼
┌───────────────┐  ┌──────────────────┐
│ Control Plane │  │ Intelligence     │
│               │  │ Worker Plane     │
│ Tenant        │  │ Mission Planning │
│ Mission       │  │ Skill            │
│ Fleet         │  │ App Model        │
│ Policy        │  │ Bug Analysis     │
│ Billing       │  │ Model Gateway    │
└───────────────┘  └──────────────────┘
     │               │
     └───────┬───────┘
             ▼
┌──────────────────────────────────────┐
│ Evidence, Search & Analytics Plane    │
└──────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────┐
│ Managed Data Plane                    │
│ Relational · Event · Object · Index   │
└──────────────────────────────────────┘
```

## 5. API Edge 与 Runner Gateway

### 5.1 API Edge

负责 Web Console、CLI、CI 和 Connector 的公共 API：

- 认证、租户解析和授权。
- 配额、速率限制和请求大小控制。
- API 与 Schema 版本协商。
- 区域选择和数据驻留路由。
- 审计上下文和关联 ID 注入。

### 5.2 Runner Gateway

负责大量 Runner 长连接，不承载测试业务决策：

- 接受 Runner 主动建立的 TLS 连接。
- 完成 Runner 身份、协议版本和能力协商。
- 维护会话、心跳和连接路由。
- 将 `ExecutionJobOffer`、事件流和审批消息转发到 Control Plane。
- 为 Artifact Transfer 签发短期、最小权限上传/下载凭证。
- 对单个租户、Runner 和 Run 实施背压。

Gateway 是无状态或弱状态入口；可恢复业务状态只保存在持久化服务中。

## 6. Cloud Control Plane

Control Plane 管理确定性产品状态和长流程，不执行高成本模型推理。它承载开源 Core 定义的确定性 Application Service，并保持相同的聚合单写者、expected version 和幂等应用语义。

### 6.1 Identity, Tenant & Billing

- 用户、组织、Workspace 和项目。
- SSO、RBAC、服务账号和审计策略。
- 套餐、额度、用量、账单和预算预警。
- Tenant、Region 和 Data Policy 绑定。

### 6.2 Mission Control

- 接收手动、PR、Build、定时和 API 触发。
- 编译版本化 Test Mission。
- 持久化 Mission 状态机和检查点。
- 调用 Intelligence Worker 生成或修订高层计划。
- 执行总时间、模型成本和风险预算。

### 6.3 Runner Fleet & Scheduler

- Runner 注册、标签、健康状态和版本。
- 按操作系统、Adapter、传感器、网络位置、环境和模型能力调度。
- `ExecutionJob` Lease、续约、回收和公平排队。
- Workspace 并发限制和优先级。
- 私有 Runner Pool 与共享 Cloud Runner Pool 隔离。

### 6.4 Policy & Approval

- 保存组织和项目策略。
- 生成签名的 Mission Policy Bundle。
- 接收 Runner 的 Approval Request。
- 支持人工审批、超时、委派和紧急停止。
- Server 与 Runner 双重执行策略；Cloud 不能覆盖 Runner 的本地限制。

### 6.5 Integrations

管理 Git、PRD、CI/CD、Issue Tracker、通知和可观测性 Connector。Connector 凭证按租户、区域和最小权限隔离。

### 6.6 Human Review Queue

接收预算耗尽、证据不足、敏感动作审批和 Skill 晋升审核产生的 `ReviewTask` 聚合。基础状态与开源版一致：`Open → Claimed → Resolved`；`ClaimReviewTask` 使用 expected version、reviewer ID 和幂等键完成条件认领，并发失败方获得当前负责人和最新版本。Cloud 可以增加 Claim Lease、团队路由、优先级、通知和 Enterprise SLA，但不得改变聚合单写者与确定性状态迁移语义。

## 7. Intelligence Worker Plane

所有服务端 AI 操作都以开源 `IntelligenceJob` 持久化运行，而不只限于高成本任务。Worker 无权自行改变确定性业务状态，只能返回 `IntelligenceResult`；Control Plane 校验 Schema、Policy、Budget、幂等键和 `base_aggregate_version` 后应用 Proposal。Cloud Worker 与 Local 进程内 Worker 必须通过同一 Conformance Suite。

### 7.1 Mission Planning Workers

- 综合 PRD、代码变化、Application Model 和 Skill。
- 生成风险导向测试目标与探索 Charter。
- 将回归、探索、补证和复现任务组合成执行图。
- 根据 Runner 反馈修订计划。

### 7.2 Application Model Workers

- 从轨迹、版本差异、PRD 和源码更新 Project/Build Model。
- 归纳状态、转换、角色、业务实体和不变量。
- 分别输出 Expected Claim 与 Observed Fact。
- 检测冲突并创建 Requirement Conflict 或 Finding 建议。
- 不覆盖已有人工作出的 Disposition。
- Application Model Worker 只提交带 base version 的 Proposal；过期 Proposal 重新归并或重新计算，不使用 LWW 覆盖并发事实。

### 7.3 Skill Intelligence Workers

- 对录制和成功轨迹分段。
- 归纳参数、分支、检查点、Oracle 和 Recovery。
- 在历史 Trace 与沙箱任务中评估候选 Skill。
- 合并重复 Skill、检测冲突并计算可信度。
- 生成签名 Skill Bundle 和兼容性范围。

Cloud Registry 仍严格分层：

1. Official Registry
2. Community Registry
3. Tenant Private Registry

Tenant Private 数据不会自动用于其他租户或公共 Registry。进入 Community 层必须经过显式贡献、脱敏、来源检查和审核。

所有三层 Skill Bundle 都必须签名：Tenant Registry 签名私有 Skill，Community 保留贡献者签名并由 Registry 再签名，Official 使用 Qualigence 发布密钥。Runner 验证内容哈希、签名链、撤销状态和适用范围。

Oracle Skill 不能屏蔽崩溃、权限违规和数据损坏等确定性高置信信号。任何 Oracle 晋升必须通过已知真 Bug 回归与对抗性测试；出现假阴性回归时自动撤销或隔离对应版本。

### 7.4 Bug Investigation Workers

- 根据 Finding Envelope 生成 Bug 假设。
- 创建版本化 Reproduction Plan。
- 分析 Reproduction Result 和偏离点。
- 决定补证、改计划、换环境、标记 Flaky 或转人工的建议。
- 聚类与历史 Finding 查重。
- 生成严重度、影响范围和根因建议。

`max_reproduction_attempts` 等预算由 Control Plane 强制执行，Worker 不能自行增加额度。

### 7.5 Model Gateway

Cloud Model Gateway 提供：

- 按任务类型和数据策略路由模型。
- 视觉、规划、归纳、复核和 Embedding 独立 Profile。
- Prompt/Policy 版本和评测状态。
- Token、延迟、成功率和单位 Bug 成本监控。
- 缓存、批处理、降级、熔断和供应商切换。
- 客户自带密钥、Qualigence 托管模型和企业专属 Endpoint。

模型请求必须携带数据分类与允许处理区域；Gateway 不得将数据发送给未获授权的 Provider。

## 8. Evidence & Analytics Plane

### 8.1 Finding Ingestion

Cloud 默认接收 Finding Envelope，而不是完整 trajectory：

- 异常前后的结构化 Trace Slice。
- Expected/Observed 差异。
- 语义树差异摘要。
- Artifact Manifest。
- 敏感级别和处理权限。

### 8.2 Evidence Request

Investigation Worker 需要更多上下文时生成结构化 Evidence Request。Runner 或 Self-hosted Server 可以自动提供、脱敏后提供、要求人工审批或拒绝。

### 8.3 Evidence Capsule Escrow

当 Mission Policy 为 `bounded_on_finding` 时，Runner 可以在 Finding 产生后主动预暂存一份有界 Evidence Capsule，使调查不依赖开发者笔记本持续在线。Cloud 只接受符合以下约束的 Capsule：

- Runner 侧先完成脱敏，并按照签名 Policy Bundle 中的 `EvidenceEncryptionProfile` 执行信封加密。
- Artifact 类型白名单、最大字节数和 Trace 时间窗口固定在 Policy Bundle 中。
- 每个对象携带租户、区域、敏感级别、内容哈希和 TTL。
- 到期自动删除；续期需要新的策略授权。
- Capsule 不包含完整 trajectory，且不能被后台 Worker 扩大读取范围。

Runner 为每个 Capsule 生成一次性 DEK，使用 AEAD 加密内容，再使用目标数据区域 KMS 的包装公钥加密 DEK。上传对象包含密文、Wrapped DEK、KMS Key ID 和策略元数据，不包含明文 DEK。授权 Worker 在 Runner 离线后通过同一区域 KMS 解包，且每次解密必须校验 Tenant、Case、Purpose、TTL 和数据策略并写入审计事件。

KMS 私钥和解包操作不得跨数据区域；密钥轮换通过 Key ID 保持存量 Capsule 的受控读取。TTL 到期时删除密文并撤销解包能力。Hybrid Intelligence 中，Self-hosted Server 使用自身 KMS 解密，再按策略向 Cloud 提供脱敏派生数据；Cloud 不得取得企业 KMS 的解密能力。

`manifest_only` 和 `local_only` 策略继续可用；Cloud 不得为了提高调查质量强制开启预暂存。

### 8.4 Processing

按策略异步执行：

- 图像裁剪、OCR 和视觉差异。
- DOM/Accessibility 子树比较。
- 日志、网络和崩溃信息提取。
- 视频关键片段与 Bug Episode 生成。
- 内容哈希、去重和恶意内容扫描。

### 8.5 Analytics

仅在租户范围内默认计算：

- 跨 Run、Build 和版本的质量趋势。
- Skill 成功率和失效位置。
- Finding 确认率、误报率和复现率。
- 测试覆盖、风险区域和 Flaky 模式。
- Runner、模型和单位有效 Bug 的成本。

所有效果指标关联版本化 Benchmark、Mission Policy、模型和预算，避免通过增加成本或缩小任务范围制造表面提升。

跨租户统计只能使用用户明确允许的聚合、匿名数据，且不能反推出客户业务、界面或 Skill 内容。

## 9. Managed Data Plane

Cloud Provider 实现与开源接口一致：

- Relational Store：租户、项目、Mission、Skill Metadata、Case 和计费。
- Event Broker/Store：领域事件、Trace 流、工作任务和审计。
- Object Store：截图、录像、日志、导出包和 Skill Bundle。
- Search/Vector Index：Skill、Application Model、Bug 和文档检索。
- Analytical Store：长期趋势、成本和质量指标。
- Secret Store：Connector、模型和 Runner 凭证。
- Regional Key Management：发布 Evidence Encryption Profile，管理包装密钥、解包授权、轮换、撤销和审计。

数据按租户和区域分区。对象引用包含租户、区域、敏感级别、保留期和内容哈希；任何后台任务都必须在读取前再次授权。

## 10. 关键数据流

### 10.1 Test Mission

```text
Trigger
→ API Edge
→ Mission Control
→ Mission Planning Worker
→ Skill/Application Model Retrieval
→ Scheduler
→ Runner Gateway
→ Local Runner
→ Execution Events / Finding Envelope
→ Control Plane Projection
```

### 10.2 Bug Investigation

```text
Finding Envelope
→ Investigation Case
→ Bug Analysis Worker
→ Reproduction Plan
→ Scheduler / Runner
→ Reproduction Result
→ Revise / Confirm / Refute / Flaky / Needs Human
```

### 10.3 Skill Learning

```text
Eligible Trace References
→ Skill Induction Worker
→ Candidate Skill
→ Skill Evaluation IntelligenceJobs
→ Validation Result
→ Tenant/Community/Official Registry
→ Runner Retrieval and Cache
→ Execution Feedback
```

## 11. 兼容性与协议治理

- Runner Protocol 使用语义版本和 Capability Negotiation。
- Cloud 至少支持当前版本与一个受支持旧版本的 Runner。
- 新字段默认可忽略；破坏性语义通过新消息或新能力标识引入。
- 开源仓库提供 Protocol Conformance Suite，Cloud 持续运行相同测试。
- Cloud 专用 UI 不得生成开源 Schema 无法表达的 Mission 或 Case。
- Project Bundle 可以从 Cloud 导出到兼容的 Self-hosted Server；用户原始数据不被产品锁定。
- Event、Snapshot 和 Bundle Manifest 分别携带 Schema Version。Cloud 使用与开源版相同的 upcaster 读取历史 Event，不原地重写不可变事件。
- 同 major Bundle 可以通过可选字段保持 minor 兼容；新 major 导入旧 Self-hosted 时明确拒绝并返回最低兼容版本。
- Cloud 可以提供目标旧版本导出，但必须列出被降级、遗漏或无法转换的能力；“可导出”不等于任意新版本都向后兼容。
- Cloud 对 pre-v1 Observation Trace 保留原始事件并重新生成 v1 投影；pre-v1 Skill 必须按开源迁移规则重新编译 Semantic Locator、回放和验证。未通过迁移 Gate 的 Skill 不得进入长期 Official/Community 兼容承诺。

## 12. 多租户、安全与合规

- API、任务、索引、对象和缓存都携带 Tenant Context。
- Runner 凭证绑定 Workspace、Runner ID、能力和有效期。
- Artifact Transfer 使用短期、对象级权限。
- Tenant Private Skill 和 Application Model 使用租户隔离密钥与索引。
- 高风险管理员操作使用双重确认和独立审计。
- Cloud 不能为 Interactive Desktop 预授权 `ExternalSideEffect`、`Destructive` 或 `ProductionForbidden` 动作；这类动作必须由 Runner 本地逐次确认或拒绝。
- 支持区域驻留、保留期、Legal Hold 和按项目删除。
- 支持客户禁用云端原始证据处理，只使用脱敏 Finding Envelope。
- 支持 Hybrid 模式在企业内部执行模型推理，仅向 Cloud 返回结构化结论。

## 13. 可靠性与扩展

### 13.1 持久化工作流

Mission、Skill、Investigation、Reproduction 和 ReviewTask 均使用持久化状态机。Control Plane 承载的确定性 Application Service 是这些聚合状态以及 Application Model 的唯一写入者，Runner 和 Worker 只提交 Event、Fact 或 Proposal。Worker 可以重复执行，但 `IntelligenceResult` 通过幂等键应用一次。

- 聚合使用 expected version 和乐观并发控制。
- 状态与 Outbox Event 原子提交，再异步更新搜索、分析和 Web Console 投影。
- 投影是最终一致的，并暴露 `as_of_event` 与 projection lag；安全判断和命令执行读取聚合真相。
- Application Model 冲突通过来源化 Claim/Fact 并存和确定性合并器处理，不使用 LWW。
- 乱序、重复和基于过期版本的 `IntelligenceResult` 被拒绝、重新归并或重新计算。

### 13.2 扩缩容单位

分别按以下工作负载扩缩容：

- Runner 长连接
- Mission Planning
- Skill Induction/Evaluation
- Bug Analysis/Reproduction
- Evidence Processing
- Search/Embedding
- Analytics Projection

### 13.3 背压与配额

- 每租户并发 Mission、Runner 和 `IntelligenceJob` 配额。
- 每类模型、Artifact 和分析任务使用预算。
- 低优先级归纳和分析任务可以延迟，但实时执行和审批优先。
- 超出额度时产生明确状态，不静默丢弃事件或降低合规级别。

## 14. 故障处理

- Runner Gateway 故障：Runner 重连其他实例，并从最后确认序号恢复。
- Control Plane 重启：从持久化工作流恢复，不重复外部副作用。
- Intelligence Worker 超时：`IntelligenceJob` 重新租用，按任务策略重试或换模型；重复 `IntelligenceResult` 幂等去重，达到预算后转人工。
- 模型 Provider 故障：熔断并按数据策略降级；没有合规替代时暂停。
- Evidence Processor 故障：原始 Artifact 保持不可变，处理任务可重放。
- Regional KMS 故障：暂停 Capsule 解包和新的 bounded-on-finding 预暂存，不跨区域降级解密；Case 标记 Key/Evidence Limited。
- 区域服务故障：已固定数据区域的租户不得跨区复制原始证据作为自动恢复手段。
- Cloud 不可用：Runner 保留本地执行事件；如果 Mission Policy 允许，可完成当前安全检查点后暂停或继续离线任务。已预暂存 Capsule 的 Case 可以继续受限调查，否则标记 `Evidence Limited`。
- 计费服务故障：已接受任务按预算继续，新的高成本任务进入延迟队列，不影响数据导出。

## 15. 商业能力映射

### Cloud Free

- 托管 Workspace 和有限项目。
- 有限 Mission、模型、存储和保留期。
- 单用户或小规模 Runner。
- 全流程体验，不人为删除基础环节。

### Cloud Pro / Team

- Workspace 基础订阅加模型、调查、执行和存储用量。
- 多用户协作、CI、定时任务和 Runner Fleet。
- 高级 Skill Intelligence 与 Bug Investigation。
- 更长保留期、趋势、质量门禁和集成。

### Enterprise

- SSO、精细 RBAC、审计、区域驻留和 SLA。
- BYOC、专属模型 Endpoint 和 Hybrid Intelligence。
- 私有网络连接、企业支持和合规能力。
- Self-hosted 的升级保障、企业智能包和支持服务可以单独商业化。

Cloud 不采用纯席位计费，因为主要可变成本来自模型、证据处理、调查迭代和存储。

## 16. 可观测性与运营

Cloud 需要按租户和工作负载观察：

- Mission 排队、执行和完成时间。
- Runner 在线率、重连和协议错误。
- 模型延迟、失败率、Token 和成本。
- Finding 确认率、复现率和人工接管率。
- Skill 检索命中率、成功率和版本退化。
- Evidence 上传、处理延迟和拒绝原因。
- 单个确认 Bug 的端到端成本。

运营日志不得记录未脱敏 Prompt、截图、DOM 或 Accessibility 内容。

## 17. 验证策略

- Open Protocol Conformance：使用开源测试套件验证 Cloud Gateway。
- ExecutionJob Conformance：Cloud Runner Gateway 对 `ExecutionJobOffer`、Lease、续约、完成、失败和断线回收保持开放协议语义。
- IntelligenceJob Conformance：Cloud Worker 与开源进程内 Worker 对 `IntelligenceJob` / `IntelligenceResult`、幂等应用、过期版本、超时和重放保持相同语义。
- Provider Contract Tests：Cloud 存储、队列、索引和模型实现遵守开放接口。
- Tenant Isolation Tests：API、队列、缓存、搜索、对象和日志全链路隔离。
- Workflow Replay Tests：Mission、Skill 和 Investigation 在重试、重启后保持一致。
- Consistency Tests：聚合单写者、ReviewTask 并发认领、Outbox、投影延迟、乱序 `IntelligenceResult` 和 Application Model 并发 Proposal。
- Scale Tests：Runner 长连接、事件吞吐、Evidence 和 AI Worker 分别压测。
- Data Policy Tests：区域、脱敏、拒绝、Envelope Encryption、Runner 离线解包、KMS 轮换/故障、Evidence Capsule TTL、人工审批和 Hybrid 模式。
- Billing Tests：预算、配额、重试和失败任务不重复计费。
- Model Evaluation：高级智能必须在相同 Benchmark、Policy 和归一化预算下相对开源基线展示可量化提升。
- Skill Supply-chain Tests：三层签名链、撤销、篡改、Oracle 假阴性和跨租户污染。
- Disaster Tests：区域、队列、数据库、对象存储和模型 Provider 故障演练。
- Export Compatibility：Event upcaster、同 major Bundle、跨 major 拒绝、目标旧版本降级导出，以及 pre-v1 Skill 重编译/重定位/重验证。

### 17.1 Cloud Intelligence Effect Gate

Cloud 高级智能发布必须使用开源 Benchmark Manifest 固定的 Qualigence Reference Model Profile、Prompt/Policy、Skill Pack、环境和归一化预算，并满足：

- 达到开源 Detection Benchmark v1 的全部绝对下限。
- 在相同数据集和归一化预算下，至少一项核心指标相对开源基线提升 10%：Finding precision、known-bug recall、自动复现成功率或确认 Bug 中位耗时。
- P0/安全类 recall 不得下降，其他关键率指标不得下降超过 2 个百分点。
- 提升结果必须关联模型、Prompt/Policy、Skill Pack、预算和样本规模，不能用更宽数据权限掩盖算法差异。

客户 BYO、本地或企业模型的结果单独评估；未通过相同 Benchmark 的配置标记为 Unverified，不继承 Qualigence Cloud 的效果承诺。

### 17.2 商业化实现 Gate

Cloud 是对开放接口的并列实现，但生产商业化按以下 Gate 推进：

1. 开源 Milestone 1 稳定 Runner Protocol 与 IntelligenceJob Conformance。
2. 开源 Milestone 2 达到 Detection Benchmark v1 并证明用户闭环成立。
3. 开源 Milestone 3 冻结 Observation Graph v1，并完成 pre-v1 Trace 投影与 Skill 重编译/重验证后，Cloud 才承诺长期 Skill/Trace 兼容。
4. Cloud 通过协议、数据导出、租户隔离和 Effect Gate 后，才对外声明高级智能价值。

## 18. 架构验收条件

1. 未修改的开源 Runner 可以通过 Endpoint 配置连接 Cloud。
2. Cloud 通过开源 Runner Protocol Conformance Suite。
3. Cloud Mission、Skill、Application Model 和 Bug Case 可以导出为开放格式。
4. Tenant Private 数据默认不进入公共 Skill 或跨租户智能学习。
5. Cloud 默认接收 Finding Envelope，而非完整 trajectory。
6. 高级 Intelligence 不能绕过确定性 Policy、Budget 和状态机。
7. Fully Managed 与 Hybrid Intelligence 使用相同数据策略语义。
8. 高计算 Worker 可以独立扩缩容，不要求拆分全部事务型 Core。
9. 云端高级能力通过开放接口暴露，不要求 Runner 包含 Cloud 专用逻辑。
10. Cloud 的付费价值可以用效果、规模、运维和服务指标衡量，而不是依赖开源版缺失基础工作流。
11. Cloud 与开源版对所有 Intelligence 操作使用相同的持久化 `IntelligenceJob` / `IntelligenceResult` 与幂等应用契约。
12. Evidence Capsule 使用目标区域 KMS 的信封加密，在 Runner 离线时仍允许授权 Worker 受限解密，并严格执行大小、类型、区域和 TTL 策略。
13. Application Model 并发 Proposal、过期 `IntelligenceResult` 和最终一致投影具有明确、可测试的处理语义。
14. Tenant、Community 和 Official Skill 全部签名，Oracle 回归不得引入不可接受的假阴性。
15. Cloud 高级智能达到开源绝对效果门槛，并通过相对提升 Gate。
16. ExecutionJob 与 IntelligenceJob 在协议、Lease、队列和指标中保持明确分离。
17. ReviewTask 并发认领遵守开源聚合 expected version 语义。
18. pre-v1 Trace/Skill 在 Observation Graph v1 兼容承诺前完成投影、重编译和重验证。
19. Cloud 官方效果承诺只绑定 Qualigence Reference Model Profile，不误用于未经验证的 BYO 配置。
