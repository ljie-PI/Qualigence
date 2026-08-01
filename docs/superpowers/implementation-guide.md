# Qualigence Local 与 Self-hosted 实施指南

- 日期：2026-08-01
- 适用范围：BASE-01～04 之上的 LS-01～LS-13
- 目标读者：具备 TypeScript/Node.js 工程能力，但不要求先掌握本仓库整体架构

## 1. 从哪里开始

实施者每次只领取一个 LS 能力包，并按以下顺序阅读：

1. `docs/superpowers/implementation-status.md`：确认上游依赖已完成。
2. 对应 `docs/superpowers/specs/*-ls-XX-*-design.md`：理解边界、不变量和公开接口。
3. 对应 `docs/superpowers/plans/*-ls-XX-*.md`：逐 Task/Step 实施。
4. 任务中列出的现有源码/测试：确认当前代码仍与计划假设一致。

不要从总体架构文档直接开始写代码，也不要同时实施相互依赖的两个 LS。

## 2. 实施顺序

```text
LS-01 + LS-02 → LS-03 → LS-04 → LS-05 → LS-06
LS-03 + LS-04 → LS-07
LS-04 + LS-07 → LS-08 → LS-09
LS-05 + LS-09 → LS-10
LS-05 + LS-06 + LS-08 + LS-10 → LS-11 → LS-12 → LS-13
```

LS-01 与 LS-02 可以并行；合并前分别通过自身 Gate。其余按依赖执行。LS-07 可以在 LS-04 后开发，但在 M2 集成前必须与已完成的 LS-05/06 契约重新跑全量验证。

## 3. 不需要实施者重新决定的事项

- 主语言是 TypeScript/Node.js 24；Rust 仅用于 M3 Companion/Windows 原生边界。
- Core、Runner、Companion 是独立进程；单进程只保留在 M1 Component Tests。
- Model Gateway 顶层共享；具体 Provider 只实现 `contracts/model-provider`。
- 外部实现分别位于 Target/Model/Protocol/Storage Provider 或 Connector，不创建通用 `packages/adapters`。
- Core Domain 不导入 Fastify/Kysely/Playwright/gRPC/模型 SDK。
- Runner Kernel 不导入具体 Target/Model/Storage Provider。
- 模型只产生 Decision/Proposal/IntelligenceResult；确定性代码负责权限、预算、状态和写入。
- 测试与 `src/` 分离。Rust 测试用 Cargo `[[test]]` 指向顶层 `tests/rust/`。
- Cloud 与 M4 Mobile 不在当前代码实施范围。

## 4. 每个 Task 的标准工作法

1. 预检 `node --version` 为 `v24.x`、`pnpm --version` 为 `11.7.x`，并确认 `pnpm install --frozen-lockfile` 能通过当前供应链策略；任一不满足先修复环境，不改业务代码。
2. 从干净分支开始，确认 `git status --short` 无意外修改。
3. 只创建 Task 的 Files 列表；发现需要新跨包依赖时停止并核对 Spec。
4. 先写计划给出的失败测试，运行精确命令并确认失败原因就是缺失能力。
5. 实现最小代码使该测试通过；不要提前实现下一个 Task。
6. 运行该 Task 的 GREEN 命令和受影响的现有回归测试。
7. 对照 Interfaces 检查输入/输出字段名，不在内部文件上建立跨包导入。
8. 按 Task 提交；提交中不要混入其他能力包。
9. 最后运行该 LS 的完整 Gate，并更新状态台账证据。

## 5. 何时必须暂停并请求架构审阅

出现以下任一情况时，不要自行改变方案：

- 计划中的公开类型无法表达需求，需要改字段名、状态机或协议 major。
- 需要让 Domain 导入基础设施、让 Provider 反向依赖 Gateway，或让 CLI/Web Console 直连数据库。
- 需要绕过 Policy、签名、Data Policy、Evidence hash、expectedVersion 或幂等检查才能完成场景。
- 需要增加 Redis/Kafka/Temporal/独立 Event Store 或新的常驻进程。
- Migration 需要修改历史 Event/Trace，或 Windows 信息无法通过 typed extension 表达。
- 自动恢复无法判断外部副作用是否已经发生。

普通实现细节（局部私有函数名、同包文件拆分、测试 fixture 小调整）不需要架构审阅，但不能改变公开契约和 Gate。

## 6. Pull Request 最小证据

每个 LS PR 必须包含：

- 对应 Plan 的 Task 完成记录或 PR 描述映射。
- 精确 Gate 命令、执行日期、通过数量/失败数量。
- 新依赖及其所属 package 的理由。
- Schema/migration/协议变更的兼容说明。
- 安全/Secret/隐私检查结果。
- 人工步骤（仅适用时）的环境与 Artifact/Run/Issue 引用。
- `docs/superpowers/implementation-status.md` 更新。

“测试应该通过”“本地看起来正常”或只有截图不算验证证据。

## 7. Milestone 合并策略

- 每个 LS 独立 PR；LS-01/02 可并行，其余不把多个 Gate 混在一个大 PR。
- M1 纵向闭环在 LS-04 后形成首个用户价值；M1 完整 Gate 还需 LS-05/06。
- M2 只有 LS-08～11 以及依赖的 M1 Hardening 全部完成才对外声明。
- M3 Graph v1 先是 candidate；只有 LS-13 自动/人工证据完整才 freeze。
- 任何 Gate 未满足时保持实际状态，不通过修改台账文字宣称完成。
