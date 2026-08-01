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
| Task 5：SQLite 与 Artifact | 未实现 | LS-01 |
| Task 6：Playwright Web Adapter | 未实现 | LS-02 |
| Task 7：Application 与 CLI | 未实现 | LS-03 |
| Task 8：Fixture 与 CLI E2E | 未实现 | LS-04 |

## 4. 待实施能力包

2026-08-01 已按用户要求批量起草并自审全部 Plan；LS-05、LS-10、LS-11、LS-13 又完成协议、密码学、部署安全和 Windows/Rust 专项审查，用户已接受推荐路线并将修订写回对应 Spec/Plan。由于十三份 Spec/Plan 仍待整体审阅，状态继续保持 `spec_draft`；用户批准本批文档后才统一切换为 `plan_ready`，不能因文件或专项修订已存在而提前标记批准。

| ID | Milestone | 能力 | 状态 | Spec | Plan | 代码证据 |
|---|---|---|---|---|---|---|
| LS-01 | M1 | SQLite 与 Artifact 本地持久化 | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-01-m1-local-persistence-design.md` | `docs/superpowers/plans/2026-08-01-ls-01-m1-local-persistence.md` | — |
| LS-02 | M1 | Playwright Web Target Adapter | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-02-m1-playwright-web-target-design.md` | `docs/superpowers/plans/2026-08-01-ls-02-m1-playwright-web-target.md` | — |
| LS-03 | M1 | Execution Application 与 CLI | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-03-m1-execution-application-cli-design.md` | `docs/superpowers/plans/2026-08-01-ls-03-m1-execution-application-cli.md` | — |
| LS-04 | M1 | Fixture、CLI E2E 与发布 Gate | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-04-m1-e2e-release-gate-design.md` | `docs/superpowers/plans/2026-08-01-ls-04-m1-e2e-release-gate.md` | — |
| LS-05 | M1 Hardening | Core/Runner 进程、gRPC、Capability、Spool | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-05-m1-core-runner-transport-hardening-design.md` | `docs/superpowers/plans/2026-08-01-ls-05-m1-core-runner-transport-hardening.md` | — |
| LS-06 | M1 Hardening | Launcher、健康检查、备份升级、视觉输入 | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-06-m1-local-operations-visual-input-design.md` | `docs/superpowers/plans/2026-08-01-ls-06-m1-local-operations-visual-input.md` | — |
| LS-07 | PRD Bridge | PRD、Expected Claims、Test Case、Mission、Execution Job | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-07-prd-test-planning-design.md` | `docs/superpowers/plans/2026-08-01-ls-07-prd-test-planning.md` | — |
| LS-08 | M2 | Recording 与 Procedure Skill 生命周期 | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-08-m2-recording-skill-lifecycle-design.md` | `docs/superpowers/plans/2026-08-01-ls-08-m2-recording-skill-lifecycle.md` | — |
| LS-09 | M2 | Regression、Exploration、Detection Benchmark v1 | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-09-m2-exploration-benchmark-design.md` | `docs/superpowers/plans/2026-08-01-ls-09-m2-exploration-benchmark.md` | — |
| LS-10 | M2 | Reproduction、Bug Episode、Human Review、Evidence Capsule | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-10-m2-investigation-review-evidence-design.md` | `docs/superpowers/plans/2026-08-01-ls-10-m2-investigation-review-evidence.md` | — |
| LS-11 | M2 | Self-hosted Server、Worker 与正式部署 | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-11-m2-self-hosted-runtime-deployment-design.md` | `docs/superpowers/plans/2026-08-01-ls-11-m2-self-hosted-runtime-deployment.md` | — |
| LS-12 | M3 | Observation Graph v1 与 pre-v1 迁移 | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-12-m3-observation-graph-v1-migration-design.md` | `docs/superpowers/plans/2026-08-01-ls-12-m3-observation-graph-v1-migration.md` | — |
| LS-13 | M3 | Windows AppTarget、UIA、Companion 与人工验收 | `spec_draft` | `docs/superpowers/specs/2026-08-01-ls-13-m3-windows-desktop-target-design.md` | `docs/superpowers/plans/2026-08-01-ls-13-m3-windows-desktop-target.md` | — |

## 5. Milestone Gate 状态

| Gate | 状态 | 未满足条件 |
|---|---|---|
| M1 真实 Web 纵向闭环 | 未完成 | LS-01、LS-02、LS-03、LS-04 |
| M1 硬化 | 未完成 | LS-05、LS-06 |
| PRD 到执行 | 未完成 | LS-07 |
| M2 Web Skill 与调查闭环 | 未完成 | LS-08、LS-09、LS-10、LS-11 |
| M3 Windows 原生抽象验证 | 未完成 | LS-12、LS-13 |

## 6. 路线外能力

| 能力 | 当前处理 |
|---|---|
| Qualigence Cloud | 仅保留架构兼容和未来路线，不生成当前实施计划 |
| M4 Android/iOS | 仅保留 Target Adapter 路线，等待 Observation Graph v1 冻结 |
| macOS/Linux 原生 Desktop | 保留 Adapter 边界；当前 M3 只实施 Windows |
| Windows VM 自动化 | 当前不建设；使用普通 CI 与人工 Checklist |

## 7. 更新规则

- Spec 文件创建时，将状态改为 `spec_draft` 并填写路径。
- 用户批准 Spec 后改为 `spec_approved`。
- Plan 完成自审后改为 `plan_ready`。
- 开始代码实施或创建 PR 后改为 `in_progress`。
- 只有代码合并且验证证据完整后改为 `complete`。
- `blocked` 必须填写具体阻塞和解除条件，不能只写“等待后续”。
