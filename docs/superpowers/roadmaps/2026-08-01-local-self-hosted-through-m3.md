# Local 与 Self-hosted 至 M3 实施路线

- 状态：结构已确认；编号能力文档批量审阅中
- 日期：2026-08-01
- 实施状态：`docs/superpowers/implementation-status.md`
- 文档规则：`docs/superpowers/specs/2026-08-01-local-self-hosted-through-m3-documentation-design.md`

## 1. 路线边界

本路线覆盖 Community Local、Team Self-hosted、PRD/Test Case、M1、M2 和 Windows-first M3。

Cloud 与 M4 Mobile 不进入当前实施序列，只保留未来入口：

- Cloud 必须复用开源协议和 Intelligence 契约，不能成为 Local 或 Self-hosted 的必经依赖。
- M4 Mobile 必须等待 M3 冻结 Observation Graph v1，并通过新的 Target Adapter 扩展。

## 2. 已实现基线

```text
BASE-01  M1 Web Walking Skeleton
BASE-02  Runner Protocol、Trace、终态和阻塞语义
BASE-03  Model Provider、Gateway、Decision 与 Verification
BASE-04  Provider/Parser/Decision/Evidence 错误状态硬化
```

基线详细证据记录在 `docs/superpowers/implementation-status.md`。

## 3. 编号实施序列

### M1 纵向闭环

| ID | 名称 | 入口 | 出口 |
|---|---|---|---|
| LS-01 | SQLite 与 Artifact 本地持久化 | BASE-02 | Run、Trace、Finding、Artifact、模型摘要可重读且哈希有效 |
| LS-02 | Playwright Web Target Adapter | BASE-02、BASE-03 | 真实 Chromium 可观察、解析、授权点击、截图和关闭 |
| LS-03 | Execution Application 与 CLI | LS-01、LS-02 | 共享 RunExecutionUseCase 串联所有组件，CLI 有稳定结果与退出码 |
| LS-04 | Fixture、CLI E2E 与发布 Gate | LS-03 | 正常与缺陷购物车场景确定性端到端通过 |

LS-01 和 LS-02 可以独立开发；LS-03 必须等待二者的公开契约稳定。

### M1 硬化

| ID | 名称 | 入口 | 出口 |
|---|---|---|---|
| LS-05 | Core/Runner 进程、gRPC、Capability 与 Spool | LS-04 | 独立进程可断线提交、恢复并协商兼容能力 |
| LS-06 | Local Launcher、健康检查、升级备份与视觉输入 | LS-05 | 本地产品可启动、诊断、备份升级，并可显式启用视觉模型输入 |

### PRD 到执行桥接

| ID | 名称 | 入口 | 出口 |
|---|---|---|---|
| LS-07 | PRD、Expected Claims、Test Case、Mission 与 Execution Job | LS-03、LS-04 | PRD Planner 通过共享应用接口生成可追溯结构化测试并执行 |

PRD Planner 不启动 CLI 子进程，也不生成 CSS/XPath selector。

### M2 Web Skill 与调查闭环

| ID | 名称 | 入口 | 出口 |
|---|---|---|---|
| LS-08 | 录制与 Procedure Skill 生命周期 | LS-04、LS-07 | Recording 可形成经过验证、签名和版本化的 Skill |
| LS-09 | Regression、有限探索与 Detection Benchmark v1 | LS-08 | Skill 可回归与探索，效果达到冻结的 Benchmark Gate |
| LS-10 | Reproduction、Bug Episode、Human Review、Evidence Capsule | LS-05、LS-09 | Finding 可复现或确定性转人工，证据可受控调查 |
| LS-11 | Self-hosted Server、Worker 与正式私有部署 | LS-05、LS-06、LS-08、LS-10 | 单节点 Linux Compose 在私有网络完成 Server/Worker/Runner 闭环 |

### M3 Windows 原生抽象验证

| ID | 名称 | 入口 | 出口 |
|---|---|---|---|
| LS-12 | Observation Graph v1 与 pre-v1 迁移 | LS-11 | Graph v1 冻结，旧 Trace 与 Skill 可重新投影、编译和验证 |
| LS-13 | Windows AppTarget、UIA、Companion 与人工验收 | LS-12 | Windows 原生闭环通过人工发布 Checklist，平台扩展边界成立 |

M3 不建设 Windows VM 自动化测试。自动验证保留在普通 CI；原生交互使用 Windows 11 开发机或专用测试机执行人工 Checklist。

## 4. 依赖图

```text
BASE-02 + BASE-03 → LS-01 / LS-02
LS-01 + LS-02 + BASE-03 → LS-03 → LS-04 → LS-05 → LS-06
LS-03 + LS-04 → LS-07
LS-04 + LS-07 → LS-08 → LS-09
LS-05 + LS-09 → LS-10
LS-05 + LS-06 + LS-08 + LS-10 → LS-11 → LS-12 → LS-13
```

## 5. M1/M2/M3 Gate

### M1 Gate

- URL 到 Finding 的真实浏览器闭环通过。
- SQLite 和 Artifact 证据可重读、定位和校验。
- 独立 Core/Runner 支持能力协商、Spool 和恢复。
- Local Launcher 支持健康检查和可恢复升级备份。
- 普通 CI 不依赖真实 API Key，Live Smoke 显式启用。

### M2 Gate

- Recording 到 Verified Skill、Regression/Exploration、Finding、Reproduction 和 Human Review 全链路通过。
- Detection Benchmark v1 达到冻结阈值。
- Runner 离线后的 Evidence Capsule 调查、预算耗尽转人工和断线恢复通过。
- Team Self-hosted 单节点正式部署通过安全、迁移、备份和可观测性检查。

### M3 Gate

- Web 和 Windows 原生目标共享核心 Observation、Action、Trace 和 Finding 契约。
- Windows 专属信息只通过 typed extension 表达。
- Observation Graph v1 冻结，pre-v1 资产迁移完成。
- Windows 人工 Checklist 有环境、证据、失败项和发布结论。

## 6. 计划中的文档包

每个 ID 将产生一份 Design Spec 和一份 Implementation Plan：

```text
LS-01  m1-local-persistence
LS-02  m1-playwright-web-target
LS-03  m1-execution-application-cli
LS-04  m1-e2e-release-gate
LS-05  m1-core-runner-transport-hardening
LS-06  m1-local-operations-visual-input
LS-07  prd-test-planning
LS-08  m2-recording-skill-lifecycle
LS-09  m2-exploration-benchmark
LS-10  m2-investigation-review-evidence
LS-11  m2-self-hosted-runtime-deployment
LS-12  m3-observation-graph-v1-migration
LS-13  m3-windows-desktop-target
```
