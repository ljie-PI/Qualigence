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
| Task 7：Application 与 CLI | 已实现 | LS-03 |
| Task 8：Fixture 与 CLI E2E | 已实现 | LS-04 |

## 4. 待实施能力包

2026-08-01 已按用户要求批量起草并自审全部 Plan；LS-05、LS-10、LS-11、LS-13 又完成协议、密码学、部署安全和 Windows/Rust 专项审查，用户已接受推荐路线并将修订写回对应 Spec/Plan。两份审阅文档（`docs/superpowers/reviews/2026-08-01-local-self-hosted-through-m3-readiness-review.md` 与 `docs/superpowers/reviews/2026-08-01-ls-05-ls-10-ls-11-ls-13-specialist-review.md`）均判定 Spec/Plan 可实施且发现项已写回。

2026-08-01（PR-00 对齐）：PR-00「Align authoritative Specs and Plans」修复了上述审阅与跨文档分析识别出的剩余缺口（历史文档清单、跨文档章节引用、LS-03→LS-05 `RunResourceFactory`/`RunnerConnectionPort` 交接、LS-08 表计数、LS-11 target/PRD 路由与迁移 001–005 抽取、LS-05/LS-06/LS-07 smoke-import 步骤）。据此，LS-01 至 LS-13 由 `spec_draft` 统一切换为 `plan_ready`；BASE 能力与 Milestone Gate 状态不变。

2026-08-01（PR-04 / LS-04）：在 `feat/ls-04-e2e-release-gate` 分支实现确定性购物车 Fixture、本地 OpenAI-compatible 模拟 Endpoint、CLI 黑盒 E2E（normal→exit 0/passed、fault→exit 1/finding 且 `$19` vs `$29`、blocked→exit 2、Provider 401→exit 3/`ModelAuthenticationFailed` 且不重试）、进程/临时目录诊断 helper，以及显式 opt-in 的 Live Smoke（`pnpm test:live`，默认跳过）。验证证据：`pnpm build`、`pnpm test`、`pnpm test:e2e`、`pnpm typecheck`、`pnpm smoke:node-imports`、`git diff --check` 均通过；Live Smoke 需 `QUALIGENCE_LIVE_MODEL_SMOKE=true` 加四个模型变量方运行，不进入普通 Gate。

2026-08-01（PR-12 / LS-07）：在 `feat/ls-07-prd-integration` 分支完成 LS-07 规划/执行集成 Gate，接续 PR-11 已合并的领域基础（`context-intake`、`application-model`、`mission`）。新增：`PrdPlanningAgent`（`packages/runner-components/model-agent/src/prd-planning-agent.ts`，`model-provider` 追加 `planning.prd-test-cases` 操作，模型仅产出 proposal，绝不生成 ID / 写 Repository / 绕过确定性 `TestPlanProposalValidator`）；`runner-protocol` 的 `AcceptedExecutionJob` 追加可选 `plan?`（不可变 Mission 计划快照，纯增量、向后兼容）；SQLite 迁移 `002-prd-mission`（八张 PRD/Plan/Mission/Job 表，不改动迁移 001）与 `SqlitePrdMissionStore`；`execution-application` 的 `MissionExecutionUseCase`——将已批准的 `CompiledMission` 逐 Job 组合进既有 `RunExecutionUseCase`（不启动任何 CLI 子进程），并把结果聚合为可复读、可追溯回 PRD source range 的 Mission 执行记录。Component E2E `tests/component/prd-planning/prd-to-run.test.ts` 用真实 Playwright + SQLite 走通 PRD 文本→intake→proposal→校验→批准编译 Mission→执行→durable provenance 全链路。验证证据：`pnpm build`、`pnpm test`（236 passed / 1 skipped，含 PR-01 的 `tests/contract/sqlite/**` 未改动通过）、`pnpm typecheck`、`pnpm smoke:node-imports`、`git diff --check` 均通过。偏差：因引入版本化迁移 002，`SUPPORTED_SCHEMA_VERSION` 升为 2，仅相应更新了 `tests/contract/sqlite/sqlite-runtime.test.ts` 中与版本号强耦合的两处断言（改为引用 `SUPPORTED_SCHEMA_VERSION`），迁移 001 的表结构未被触碰。

2026-08-01（PR-08 / LS-05）：在 `feat/ls-05-process-integration-gate` 分支完成 LS-05 最后一环——独立进程集成 Gate（Task 4/5/6），接续 PR-05/06/07 已合并的协议契约、gRPC mTLS 传输与加密 Runner Spool。新增 `apps/core-daemon/**`：真实独立 Core 进程托管 `GrpcRunnerProtocolServer`（mTLS），并实现权威的会话/所有权状态机——`RunnerSessionService`（协议大版本协商 + 单次轮换 resume 凭据 + 经 `TraceIngestor` 持久化后才 Ack）、`RunOwnershipService`（Lease 绑定 `runId+runnerId+sessionId+leaseEpoch`，单一所有权、`mayStartAction` 按显式过期拒绝、`createRecoveryRun` 用新 `runId` 恢复且永不改判原 run 归属、`authorizeTraceUpload` 拒绝跨 Runner 上传）、`ExecutionJobService`、`RunnerResumeTokenService`（哈希存储 + 常量时间比较 + TTL + 证书指纹绑定）；以及任务书要求的 Core 侧 `RunnerBackedRunResourceFactory`——其 Observer/ActionExecutor 由经 `RunnerConnectionPort` 派发到已租约 Runner 的 `RemoteRunnerTarget` 支撑，保持 `RunExecutionUseCase`/`RunResourceFactory` 接口不变。新增 `apps/runner/**`：真实独立 Runner 进程，经 `GrpcRunnerProtocolClient`（mTLS）连接并握手；`LeaseWindow`（单调时钟推导的防御性动作窗口，wall-clock 回拨即关闭且不因后续读数复开）、`SpoolingTraceRecorder`（提交前先落 `SqliteRunnerSpool`）、`TraceUploadPump`（仅在 Core Ack 后才 `acknowledge` spool）、`LeasedJobExecutor`（先做 capability 协商再 accept，本地二次拦截过期 Lease 动作）、`RunnerClient`（用 resume token 重连并按原序重放 spool）。集成 Gate `tests/component/core-runner/{independent-process,disconnect-recovery}.test.ts` 用真实 loopback gRPC + 真实 mTLS 证书 + 真实加密 Spool 验证四条不变量：断连不丢任何已接受 Trace 且按原序恰好一次重放、过期 Lease 双侧（Runner `LeaseWindow` + Core `RunOwnershipService`）拒绝新动作、跨 Runner 无法重放他人 resume token 或上传他人 run、capability 不匹配为显式拒绝而非静默降级。验证证据：`pnpm build`、`pnpm test`（313 passed / 1 skipped，58 文件，无既有 269 用例回归）、`pnpm typecheck`、`pnpm smoke:node-imports`（新增 `@qualigence/core-daemon`、`@qualigence/runner`）、`git diff --check`、`pnpm exec vitest run tests/conformance/runner-protocol tests/contract/runner-spool tests/component/core-runner`（56 passed）、`pnpm exec buf lint` 均通过。偏差：冻结的 `GrpcRunnerProtocolServer` 内部自处理 offer/lease/trace-Ack/resume 轮换且不向应用层暴露接收到的批次或完成，故 Task 4 领域服务作为并行、单测覆盖的权威状态机，而冻结 server 提供 Task 6 的线级传输；Core 侧 `RunnerBackedRunResourceFactory` 采用逐调用（per-call）远程代理绑定 Observer/Executor（贴合任务书措辞），并在 Core 侧经 `TraceIngestor` 记录 Trace（冻结协议为整 Job 粒度，per-call 需协议扩展，超出本 PR 范围）；集成 Gate 采用同进程但完全解耦的真实 gRPC-over-loopback + 真实 mTLS + 真实加密 Spool（任务书允许的等价形态），比子进程 + Playwright + 模型更确定，`apps/*/src/main.ts` 提供可运行二进制（env 配置 + SIGINT/SIGTERM 优雅关闭 + 结构化就绪日志）以备真实子进程部署。

| ID | Milestone | 能力 | 状态 | Spec | Plan | 代码证据 |
|---|---|---|---|---|---|---|
| LS-01 | M1 | SQLite 与 Artifact 本地持久化 | `implemented` | `docs/superpowers/specs/2026-08-01-ls-01-m1-local-persistence-design.md` | `docs/superpowers/plans/2026-08-01-ls-01-m1-local-persistence.md` | `packages/storage-providers/sqlite-runtime/**`、`packages/storage-providers/artifact-fs/**`、`packages/core-modules/evidence/src/persistence-ports.ts` |
| LS-02 | M1 | Playwright Web Target Adapter | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-02-m1-playwright-web-target-design.md` | `docs/superpowers/plans/2026-08-01-ls-02-m1-playwright-web-target.md` | — |
| LS-03 | M1 | Execution Application 与 CLI | `implemented` | `docs/superpowers/specs/2026-08-01-ls-03-m1-execution-application-cli-design.md` | `docs/superpowers/plans/2026-08-01-ls-03-m1-execution-application-cli.md` | `packages/execution-application/**`、`apps/cli/**` |
| LS-04 | M1 | Fixture、CLI E2E 与发布 Gate | `implemented` | `docs/superpowers/specs/2026-08-01-ls-04-m1-e2e-release-gate-design.md` | `docs/superpowers/plans/2026-08-01-ls-04-m1-e2e-release-gate.md` | `tests/fixtures/**`、`tests/helpers/**`、`tests/e2e/cli-web-cart.test.ts`、`tests/live/remote-model-smoke.test.ts` |
| LS-05 | M1 Hardening | Core/Runner 进程、gRPC、Capability、Spool | `implemented` | `docs/superpowers/specs/2026-08-01-ls-05-m1-core-runner-transport-hardening-design.md` | `docs/superpowers/plans/2026-08-01-ls-05-m1-core-runner-transport-hardening.md` | `packages/contracts/runner-protocol/**`、`packages/protocol-adapters/grpc-runner-protocol/**`、`packages/runner-components/runner-spool/**`、`apps/core-daemon/**`、`apps/runner/**`、`tests/component/core-runner/**`、`tests/unit/{core-daemon,runner}/**` |
| LS-06 | M1 Hardening | Launcher、健康检查、备份升级、视觉输入 | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-06-m1-local-operations-visual-input-design.md` | `docs/superpowers/plans/2026-08-01-ls-06-m1-local-operations-visual-input.md` | — |
| LS-07 | PRD Bridge | PRD、Expected Claims、Test Case、Mission、Execution Job | `implemented` | `docs/superpowers/specs/2026-08-01-ls-07-prd-test-planning-design.md` | `docs/superpowers/plans/2026-08-01-ls-07-prd-test-planning.md` | `packages/core-modules/{context-intake,application-model,mission}/**`、`packages/runner-components/model-agent/src/prd-planning-agent.ts`、`packages/contracts/{model-provider,runner-protocol}/src/index.ts`、`packages/storage-providers/sqlite-runtime/src/{migrations/002-prd-mission.ts,sqlite-prd-mission-store.ts}`、`packages/execution-application/src/mission-execution-use-case.ts`、`tests/component/prd-planning/prd-to-run.test.ts` |
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
| M1 硬化 | 未完成 | LS-06（LS-05 已完成，M1 硬化仅余 LS-06 本地运维 Gate） |
| PRD 到执行 | 已完成 | — |
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
