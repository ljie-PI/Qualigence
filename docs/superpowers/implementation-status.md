# Qualigence Local 与 Self-hosted 实施状态

- 更新时间：2026-08-01
- 范围：Community Local、Team Self-hosted、M1、PRD Bridge、M2、Windows-first M3
- 路线：`docs/superpowers/roadmaps/2026-08-01-local-self-hosted-through-m3.md`

## 1. 状态定义

| 状态 | 含义 |
|---|---|
| `backlog` | 已进入路线，但 Spec 尚未批准 |
| `spec_draft` | Design Spec 编写或审阅中 |
| `spec_approved` | Design Spec 已批准，Plan 尚未完成 |
| `plan_ready` | Implementation Plan 已完成并自审 |
| `in_progress` | 已有代码分支或 PR 正在实施 |
| `blocked` | 存在明确阻塞条件，台账必须记录恢复条件 |
| `complete` | 代码已合并、要求的验证通过且证据已记录 |

## 2. 已实现基础能力

| ID | 能力 | 状态 | 代码/合并证据 | 验证证据 |
|---|---|---|---|---|
| BASE-01 | M1 Web Walking Skeleton：Observation、Decision、Action、Verification、Trace、Finding 内存闭环 | `complete` | `ea6a4d5` | Walking Skeleton component test、Runner unit tests |
| BASE-02 | Runner Protocol Envelope、协议 Adapter 分类、终态 Trace、policy/action/model blocked 语义 | `complete` | PR #4，merge `6ba7703`；主要提交 `2c5c419`、`11780be` | Runner、Protocol、Evidence tests |
| BASE-03 | Model Provider contract、Model Gateway、OpenAI-compatible Provider、Model-backed Decision/Verification | `complete` | PR #4，merge `6ba7703`；主要提交 `2c5c419`、`a3b8713`、`70d34de` | Model Gateway unit、Provider contract、Model Agent tests |
| BASE-04 | 408/409 分类、Provider/Parser 边界、Decision/Evidence grounding、可见文本证据 | `complete` | PR #4，merge `6ba7703`；主要提交 `3f9226b`、`b1114dc`、`64023ef`、`ff6a888` | 2026-08-01：build、41 tests、test typecheck、Node import smoke、diff check 通过 |

## 3. 当前 M1 Plan 对应状态

`docs/superpowers/plans/2026-07-31-m1-real-web-vertical-slice.md` 的兼容映射：

| 原 Task | 当前状态 | 后续编号 |
|---|---|---|
| Task 1：协议 Adapter 归类 | 已实现 | BASE-02 |
| Task 2：Runner Protocol 与终态语义 | 已实现 | BASE-02 |
| Task 3：Model contract、Gateway、Model Agent | 已实现 | BASE-03、BASE-04 |
| Task 4：OpenAI-compatible Provider | 已实现 | BASE-03、BASE-04 |
| Task 5：SQLite 与 Artifact | 已实现 | LS-01 |
| Task 6：Playwright Web Adapter | 未实现 | LS-02 |
| Task 7：Application 与 CLI | 未实现 | LS-03 |
| Task 8：Fixture 与 CLI E2E | 未实现 | LS-04 |

## 4. 待实施能力包

2026-08-01 已按用户要求批量起草并自审全部 Plan；LS-05、LS-10、LS-11、LS-13 又完成协议、密码学、部署安全和 Windows/Rust 专项审查，用户已接受推荐路线并将修订写回对应 Spec/Plan。两份审阅文档（`docs/superpowers/reviews/2026-08-01-local-self-hosted-through-m3-readiness-review.md` 与 `docs/superpowers/reviews/2026-08-01-ls-05-ls-10-ls-11-ls-13-specialist-review.md`）均判定 Spec/Plan 可实施且发现项已写回。

2026-08-01（PR-00 对齐）：PR-00「Align authoritative Specs and Plans」修复了上述审阅与跨文档分析识别出的剩余缺口（历史文档清单、跨文档章节引用、LS-03→LS-05 `RunResourceFactory`/`RunnerConnectionPort` 交接、LS-08 表计数、LS-11 target/PRD 路由与迁移 001–005 抽取、LS-05/LS-06/LS-07 smoke-import 步骤）。据此，LS-01 至 LS-13 由 `spec_draft` 统一切换为 `plan_ready`；BASE 能力与 Milestone Gate 状态不变。

| ID | Milestone | 能力 | 状态 | Spec | Plan | 代码证据 |
|---|---|---|---|---|---|---|
| LS-01 | M1 | SQLite 与 Artifact 本地持久化 | `implemented` | `docs/superpowers/specs/2026-08-01-ls-01-m1-local-persistence-design.md` | `docs/superpowers/plans/2026-08-01-ls-01-m1-local-persistence.md` | `packages/storage-providers/sqlite-runtime/**`、`packages/storage-providers/artifact-fs/**`、`packages/core-modules/evidence/src/persistence-ports.ts` |
| LS-02 | M1 | Playwright Web Target Adapter | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-02-m1-playwright-web-target-design.md` | `docs/superpowers/plans/2026-08-01-ls-02-m1-playwright-web-target.md` | — |
| LS-03 | M1 | Execution Application 与 CLI | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-03-m1-execution-application-cli-design.md` | `docs/superpowers/plans/2026-08-01-ls-03-m1-execution-application-cli.md` | — |
| LS-04 | M1 | Fixture、CLI E2E 与发布 Gate | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-04-m1-e2e-release-gate-design.md` | `docs/superpowers/plans/2026-08-01-ls-04-m1-e2e-release-gate.md` | — |
| LS-05 | M1 Hardening | Core/Runner 进程、gRPC、Capability、Spool | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-05-m1-core-runner-transport-hardening-design.md` | `docs/superpowers/plans/2026-08-01-ls-05-m1-core-runner-transport-hardening.md` | — |
| LS-06 | M1 Hardening | Launcher、健康检查、备份升级、视觉输入 | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-06-m1-local-operations-visual-input-design.md` | `docs/superpowers/plans/2026-08-01-ls-06-m1-local-operations-visual-input.md` | — |
| LS-07 | PRD Bridge | PRD、Expected Claims、Test Case、Mission、Execution Job | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-07-prd-test-planning-design.md` | `docs/superpowers/plans/2026-08-01-ls-07-prd-test-planning.md` | — |
| LS-08 | M2 | Recording 与 Procedure Skill 生命周期 | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-08-m2-recording-skill-lifecycle-design.md` | `docs/superpowers/plans/2026-08-01-ls-08-m2-recording-skill-lifecycle.md` | — |
| LS-09 | M2 | Regression、Exploration、Detection Benchmark v1 | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-09-m2-exploration-benchmark-design.md` | `docs/superpowers/plans/2026-08-01-ls-09-m2-exploration-benchmark.md` | — |
| LS-10 | M2 | Reproduction、Bug Episode、Human Review、Evidence Capsule | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-10-m2-investigation-review-evidence-design.md` | `docs/superpowers/plans/2026-08-01-ls-10-m2-investigation-review-evidence.md` | — |
| LS-11 | M2 | Self-hosted Server、Worker 与正式部署 | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-11-m2-self-hosted-runtime-deployment-design.md` | `docs/superpowers/plans/2026-08-01-ls-11-m2-self-hosted-runtime-deployment.md` | — |
| LS-12 | M3 | Observation Graph v1 与 pre-v1 迁移 | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-12-m3-observation-graph-v1-migration-design.md` | `docs/superpowers/plans/2026-08-01-ls-12-m3-observation-graph-v1-migration.md` | — |
| LS-13 | M3 | Windows AppTarget、UIA、Companion 与人工验收 | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-13-m3-windows-desktop-target-design.md` | `docs/superpowers/plans/2026-08-01-ls-13-m3-windows-desktop-target.md` | — |

## 5. PR 分解与归属（28-PR 模型）

本仓库采用会话计划文件 `.copilot/session-state/67dc9af5-a9f1-4323-8162-78f0350aeb9f/plan.md`（"Local/Self-hosted Through M3 PR Implementation Plan"）确定的 28-PR 分解为既定 PR 拆分方案。PR-00 是先行文档/契约对齐 PR；LS-05、LS-07、LS-10、LS-11、LS-13 因契约、传输、密码学、部署安全或 Windows/Rust 风险被拆成多个 PR。下表把 `docs/superpowers/plans/2026-08-01-ls-*.md` 映射到具体 PR 编号，供后续贡献者定位归属；完整依赖波次、合并顺序与 Gate 见会话计划文件，不在此重复。

| PR | 归属 LS / Plan | 说明 |
|---|---|---|
| PR-00 | 全部（本对齐 PR） | 对齐权威 Spec/Plan、修复跨文档缺口 |
| PR-01 | LS-01 | 本地持久化 |
| PR-02 | LS-02 | Playwright Web Target |
| PR-03 | LS-03 | Execution Application 与 CLI |
| PR-04 | LS-04 | E2E 发布 Gate |
| PR-05 | LS-05 | 协议契约基础 |
| PR-06 | LS-05 | gRPC 传输 |
| PR-07 | LS-05 | 加密 Runner Spool |
| PR-08 | LS-05 | 进程集成 Gate |
| PR-09 | LS-06 | 视觉输入契约 |
| PR-10 | LS-06 | 本地运维 Gate |
| PR-11 | LS-07 | 无冲突领域基础 |
| PR-12 | LS-07 | 规划/执行集成 Gate |
| PR-13 | LS-08 | Recording 与 Skill 生命周期 |
| PR-14 | LS-09 | 探索引擎 |
| PR-15 | LS-09 | Benchmark 与发布 Gate |
| PR-16 | LS-10 | 调查/审阅领域 |
| PR-17 | LS-10 | Evidence Capsule 密码学 |
| PR-18 | LS-10 | 集成 Gate |
| PR-19 | LS-11 | 存储基础（迁移 001–005 抽取） |
| PR-20 | LS-11 | Runner 身份基础 |
| PR-21 | LS-11 | Service Plane |
| PR-22 | LS-11 | Web Console |
| PR-23 | LS-11 | 部署与 M2 Gate |
| PR-24 | LS-12 | Observation Graph v1 candidate 与迁移 |
| PR-25 | LS-13 | Desktop 契约与 Companion 安全 |
| PR-26 | LS-13 | UIA Adapter 与生命周期 |
| PR-27 | LS-13 | Windows 发布与 Graph 冻结 Gate |

拆分 LS 只在其最终 Gate PR 更新本台账状态行；一次性单 PR 的 LS 更新自身行。

## 6. Milestone Gate 状态

| Gate | 状态 | 未满足条件 |
|---|---|---|
| M1 真实 Web 纵向闭环 | 未完成 | LS-01、LS-02、LS-03、LS-04 |
| M1 硬化 | 未完成 | LS-05、LS-06 |
| PRD 到执行 | 未完成 | LS-07 |
| M2 Web Skill 与调查闭环 | 未完成 | LS-08、LS-09、LS-10、LS-11 |
| M3 Windows 原生抽象验证 | 未完成 | LS-12、LS-13 |

## 7. 路线外能力

| 能力 | 当前处理 |
|---|---|
| Qualigence Cloud | 仅保留架构兼容和未来路线，不生成当前实施计划 |
| M4 Android/iOS | 仅保留 Target Adapter 路线，等待 Observation Graph v1 冻结 |
| macOS/Linux 原生 Desktop | 保留 Adapter 边界；当前 M3 只实施 Windows |
| Windows VM 自动化 | 当前不建设；使用普通 CI 与人工 Checklist |

## 8. 更新规则

- Spec 文件创建时，将状态改为 `spec_draft` 并填写路径。
- 用户批准 Spec 后改为 `spec_approved`。
- Plan 完成自审后改为 `plan_ready`。
- 开始代码实施或创建 PR 后改为 `in_progress`。
- 只有代码合并且验证证据完整后改为 `complete`。
- `blocked` 必须填写具体阻塞和解除条件，不能只写“等待后续”。
