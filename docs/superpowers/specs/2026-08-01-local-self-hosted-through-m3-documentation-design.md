# Local 与 Self-hosted 至 M3 实施文档设计

- 状态：文档结构与编号已确认；编号能力文档批量审阅中
- 日期：2026-08-01
- 范围：Community Local、Team Self-hosted、M1、PRD/Test Case、M2、Windows-first M3
- 路线外：Qualigence Cloud、M4 Mobile 的具体实施

## 1. 目标

本设计规定从当前 M1 未完成部分到 M3 出口条件的实施文档结构。目标不是重写已经批准的架构，而是把现有设计拆成可以独立编码、测试、审查和合并的能力切片。

完成本轮文档工作后，工程人员应能从路线索引确定实施顺序，从状态台账确认已经完成的能力，并从每个编号能力包的 Design Spec 与 Implementation Plan 直接执行代码工作。

## 2. 已确认范围

本轮必须完整覆盖：

1. 当前 M1 纵向闭环剩余的 Storage、Playwright、Application/CLI 和 E2E。
2. M1 的独立 Core/Runner、gRPC、Capability、Spool、Launcher、备份和视觉输入硬化。
3. PRD 到 Expected Claims、Test Case、Mission 和 Execution Job 的共享应用链路。
4. M2 的录制、Skill、探索、Benchmark、复现、Bug Episode、人工审阅和 Evidence Capsule。
5. Team Self-hosted 的 Server、Worker、PostgreSQL、对象存储、OIDC、KMS 和单节点 Docker Compose。
6. M3 的 Observation Graph v1、pre-v1 迁移、Windows UIA、AppTarget、Desktop Companion、审批和人工发布验收。

Qualigence Cloud 和 M4 Mobile 只在路线文档中记录边界、前置条件和未来入口，不生成当前 Implementation Plan。

## 3. 与现有 M1 的兼容原则

现有文档继续作为架构和历史来源：

- `docs/superpowers/specs/2026-07-28-local-self-hosted-implementation-design.md`
- `docs/superpowers/specs/2026-07-31-m1-real-web-vertical-slice-design.md`
- `docs/superpowers/plans/2026-07-28-m1-web-walking-skeleton.md`（产出 BASE-01：内存版 M1 Walking Skeleton，已完成）
- `docs/superpowers/plans/2026-07-31-m1-real-web-vertical-slice.md`
- `docs/superpowers/plans/2026-08-01-model-error-state-machine-hardening.md`

新编号文档必须遵守以下规则：

- 不修改已经冻结的 Runner Kernel、Runner Protocol、Model Provider、Model Gateway、Model Agent、Target Adapter、Storage Provider 和 RunExecutionUseCase 分层方向。
- 不创建与现有公开类型同义但不同名的第二套接口。
- LS-01 至 LS-04 是现有 M1 Plan Task 5 至 Task 8 的代码级细化，不是替代实现。
- LS-05 至 LS-06 对应 `docs/superpowers/specs/2026-07-31-m1-real-web-vertical-slice-design.md` 第 23 节「后续 M1 硬化」的后续硬化。
- LS-07 对应 `docs/superpowers/specs/2026-07-31-m1-real-web-vertical-slice-design.md` 第 21 节「未来 PRD 流程」的未来 PRD 流程。
- LS-08 至 LS-11 实现现有 M2 设计。
- LS-12 至 LS-13 实现现有 Windows-first M3 设计。
- 发现冲突时先修订上游 Design Spec 并记录决策，不能在下游 Plan 中静默改变架构。

## 4. 文档层级和权威顺序

文档按以下顺序解释，后层不能推翻前层：

1. `docs/architecture/*`：产品与开源/Cloud 架构边界。
2. `docs/superpowers/specs/2026-07-28-local-self-hosted-implementation-design.md`：Local 与 Self-hosted 总体实施设计。
3. `docs/superpowers/roadmaps/2026-08-01-local-self-hosted-through-m3.md`：编号、依赖和阶段 Gate。
4. `docs/superpowers/specs/*-ls-XX-*-design.md`：单个能力包的冻结设计。
5. `docs/superpowers/plans/*-ls-XX-*.md`：单个能力包的代码实施步骤。
6. `docs/superpowers/implementation-status.md`：实施事实、验证证据和当前状态，不承载新设计。

若状态台账与 Git 历史不一致，以已合并代码和验证证据为准，并修正台账。

## 5. 编号规则

未来能力使用稳定 ID `LS-01` 至 `LS-13`。编号表达依赖顺序，不随日期或文件重命名而复用。

已完成的基础工作使用 `BASE-01` 至 `BASE-04`，仅记录在实施状态文件中，不为历史代码重新生成实施计划。

文件命名采用：

```text
docs/superpowers/specs/YYYY-MM-DD-ls-XX-<slug>-design.md
docs/superpowers/plans/YYYY-MM-DD-ls-XX-<slug>.md
```

文档标题必须以 `[LS-XX]` 开头，正文必须列出直接依赖、产生的公开接口和出口 Gate。

## 6. 十三个能力包

| ID | Milestone | 能力包 | 直接依赖 |
|---|---|---|---|
| LS-01 | M1 | SQLite 与 Artifact 本地持久化 | BASE-02 |
| LS-02 | M1 | Playwright Web Target Adapter | BASE-02、BASE-03 |
| LS-03 | M1 | Execution Application 与 CLI | LS-01、LS-02、BASE-03 |
| LS-04 | M1 | Fixture、CLI E2E 与 M1 纵向闭环发布 Gate | LS-03 |
| LS-05 | M1 Hardening | Core Daemon、Local Runner、gRPC、Capability 与 Spool | LS-04 |
| LS-06 | M1 Hardening | Local Launcher、健康检查、升级备份与视觉模型输入 | LS-05 |
| LS-07 | PRD Bridge | PRD、Expected Claims、Test Case、Mission 与 Execution Job | LS-03、LS-04 |
| LS-08 | M2 | 流程录制与 Procedure Skill 生命周期 | LS-04、LS-07 |
| LS-09 | M2 | Regression、有限探索与 Detection Benchmark v1 | LS-08 |
| LS-10 | M2 | Reproduction、Bug Episode、Human Review 与 Evidence Capsule | LS-05、LS-09 |
| LS-11 | M2 | Self-hosted Server、Intelligence Worker 与正式私有部署 | LS-05、LS-06、LS-08、LS-10 |
| LS-12 | M3 | Observation Graph v1 冻结与 pre-v1 资产迁移 | LS-11 |
| LS-13 | M3 | Windows AppTarget、UIA、Desktop Companion 与人工发布验收 | LS-12 |

## 7. 每个 Design Spec 的必备内容

每份编号 Design Spec 必须完整定义：

- 问题、用户价值、范围和明确排除项。
- 与上游能力包的依赖及向下游提供的契约。
- 仓库目录、模块边界和依赖方向。
- 核心 TypeScript/Rust 类型、接口、状态机或 SQL/协议 Schema。
- 主数据流、幂等、并发、重试和资源生命周期。
- 安全、Secret、隐私、证据和日志边界。
- 失败分类和终止语义。
- Unit、Contract、Component、E2E、Replay、Manual 的测试责任。
- 平台支持、兼容和迁移策略。
- 入口条件、出口条件和不阻塞的未来能力。

Design Spec 不包含“待实现”“适当处理”等占位语句。

## 8. 每个 Implementation Plan 的必备内容

每份编号 Plan 必须：

- 使用与 Design Spec 完全一致的公开类型和字段名。
- 列出精确 Create/Modify/Test 文件路径和文件职责。
- 以独立可审查任务拆分，每项任务都产生可验证软件。
- 使用测试先行步骤，写明预期 RED、最小 GREEN 和回归命令。
- 给出需要新增的依赖及其所在 package，不允许临时跨层导入。
- 写明数据 migration、回滚/恢复和兼容步骤。
- 写明本地、跨平台、Self-hosted 或人工环境的验证边界。
- 在最后包含全量验证、文档同步、PR 和状态台账更新步骤。

## 9. 实施状态文件

`docs/superpowers/implementation-status.md` 是独立事实台账，必须记录：

- BASE-01 至 BASE-04 已实现能力和合并证据。
- LS-01 至 LS-13 当前状态。
- 对应 Spec、Plan、代码 PR、merge commit 和最近验证日期。
- 阻塞原因和恢复条件。
- M1/M2/M3 出口 Gate 是否满足。

允许的状态只有：

```text
backlog
spec_draft
spec_approved
plan_ready
in_progress
blocked
complete
```

只有代码已合并、要求的验证通过且台账有证据时，能力包才能标记为 `complete`。

## 10. 文档编写和审阅顺序

1. 创建路线索引和实施状态台账。
2. 按 LS-01 至 LS-13 顺序编写 Design Spec；可以并行起草，但必须按依赖顺序批准。
3. 每份 Spec 完成占位符、矛盾、范围和歧义自审。
4. 默认由用户批准 Spec 后生成对应 Implementation Plan；2026-08-01 用户明确要求一次性批量起草全部 Spec/Plan，因此本批 Plan 可以先起草和自审，但在用户整体批准前不得把能力状态标为 `plan_ready`。
5. Plan 完成 Spec Coverage、Placeholder 和 Type Consistency 自审。
6. 代码实施前确认上游能力包满足入口条件。
7. 每个 PR 合并后更新状态台账，不修改历史结论来掩盖偏差。

## 11. 路线外说明

Cloud 路线说明只记录协议兼容、托管价值和开放契约，不为 Cloud Control Plane、租户、计费或托管智能生成当前任务。

M4 Mobile 路线说明只记录 Android Emulator、Android 真机和 iOS Simulator/XCUITest 的建议顺序。M3 冻结 Observation Graph v1 之前不编写移动端代码实施计划。

## 12. 本文档出口条件

- 路线索引存在且包含 LS-01 至 LS-13 的依赖和 Gate。
- 独立状态台账准确记录已实现基础能力和待实施能力。
- 现有 M1 Plan 明确指向 LS-01 至 LS-04 的细化关系。
- 用户已批准本文档结构与编号；十三份详细 Design Spec 和 Implementation Plan 按批量审阅例外生成。
