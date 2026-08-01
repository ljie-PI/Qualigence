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

2026-08-01（PR-13 / LS-08）：在 `feat/ls-08-skill-lifecycle` 分支完成全部 LS-08 Recording 与 Procedure Skill 生命周期（Task 1–6）。新增 `packages/runner-components/recording/**`（`RecordingRecorder` 把一次真实执行 Run 的 Trace 捕获为不可变 `RecordingSession`，仅接受 Policy Gate 授权且成功的动作，拒绝未授权/泄密/空/未完成录制）；`packages/core-modules/skill/**`（`TestSkill` 聚合的前向单写乐观并发生命周期 `draft → candidate → verified → promoted`，外加可从任一非废弃态到达的 `deprecated`——`version` 兼任乐观并发令牌，逐次转移递增，命令携带 `expectedVersion`+`idempotencyKey`，陈旧版本抛 `SkillVersionConflict`、幂等重放返回既有 `SkillTransition`；确定性 `SkillCompiler` 把已批准 proposal 编译为 `SkillCandidate`，做 grounding 校验——引用不存在的录制步骤、步骤 kind 不匹配、未声明的 `valueRef`、以及 CSS/XPath/坐标/脚本注入/URL 凭据 selector 泄漏一律拒绝，`sourceNodeId` 仅作 provenance 绝不作回放定位；`SkillPromotionPolicy` 门控，要求 verified 态 + 合法签名 + 评估通过 + 全部必需 oracle 通过，无绕过通道；`SkillVerifier` 由回放结果折叠出四个独立 oracle 产出不可变 `SkillEvaluation`）；`packages/runner-components/model-agent/src/skill-induction-agent.ts`（`SkillInductionAgent` 经 `model-provider` 追加的 `skill.induction` 操作向模型网关取候选动作序列 proposal，模型只产出 proposal，绝不写持久化端口、绝不绕过确定性 `SkillCompiler` 校验，均为纯增量扩展）；`packages/storage-providers/kms-local/**`（`LocalSkillSigner` 用真实 Ed25519——Node `crypto.generateKeyPair`/`sign`/`verify`——签名/验证 Skill Bundle，私钥 PEM PKCS8 以 `0o600` 原子落盘、公钥派生 `keyId`，验证覆盖签名有效性、内容哈希、scope、有效期，无未签名回退）；`packages/runner-components/skill-replay/**`（`SkillReplayController` 只回放已签名 Bundle：先验签再触达目标，逐步重新观测、检查前置条件、按语义定位、执行、校验 checkpoint，`reobserve` 恢复一次后停止）；SQLite 迁移 `003-skill`（七张表 `recordings`、`recording_steps`、`skills`、`skill_versions`、`skill_evaluations`、`skill_bundles`、`skill_revocations`，严格增量、不改动迁移 001/002）与实现 `SkillRepository` 的 `SqliteSkillStore`（版本快照乐观并发写、撤销 append-only、绝不落私钥）。回放四 oracle（`tests/replay/procedure-skill/**`）：`signature-integrity`（Bundle 签名有效，被篡改 Bundle 在触达目标前即返回 `SkillSignatureInvalid`）、`exact-trace-replay`（两次正常回放均 passed）、`semantic-tolerant-replay`（DOM 重排/文案微调仍按语义定位并 passed）、`precondition-safety`（前置条件不满足在动作前安全 `PlanDiverged`）。Component E2E `tests/component/skill-lifecycle/recording-to-replay.test.ts` 走通 Recording→induce/compile→draft/candidate→签名→四 oracle 验证→verified→promoted→重开库→回放，并断言库内字节绝无私钥/明文 Secret。验证证据：`pnpm build`、`pnpm test`（432 passed / 1 skipped，75 文件，较基线 378 新增 54 用例、无既有回归，含 PR-01/PR-12 的 `tests/contract/sqlite/**` 与 `prd-mission-store.test.ts` 未改动通过）、`pnpm typecheck`、`pnpm smoke:node-imports`（新增 `@qualigence/recording`、`@qualigence/skill`、`@qualigence/skill-replay`、`@qualigence/kms-local`）、`git --no-pager diff --check` 均通过。偏差：因引入版本化迁移 003，`SUPPORTED_SCHEMA_VERSION` 升为 3（`tests/contract/sqlite/sqlite-runtime.test.ts` 早已引用该常量且以子集断言表存在，无需改动）；Skill 内容哈希有两个用途——`SkillCompiler` 产出的 `contentSha256` 是身份无关的编译内容摘要，而 Bundle 签名完整性用 `bundlePayloadContentSha256`（含身份）在签名前重算并写入 manifest，二者按 PR-12 后既定约定并存。

2026-08-01（PR-15 / LS-09）：在 `feat/ls-09-benchmark-gate` 分支完成 LS-09 最后一环——Detection Benchmark v1 与发布 Gate（Task 3/4），接续 PR-14 已合并的探索引擎（`packages/runner-components/exploration/**`、`packages/core-modules/mission/src/exploration-policy.ts`、`packages/runner-components/model-agent/src/exploration-agent.ts`，本 PR 未改动），至此 LS-09 全部实现。Task 3 新增冻结基准库 `packages/benchmarking/detection/**`：不可变、可哈希的 `Manifest`（`ReferenceModelProfile` + `BenchmarkScenario[]` + `DetectionThresholds`）、`GroundTruth`（已知缺陷按 `scenarioId+defectId` 定位、标注 P0/严重度/是否稳定复现）、确定性 `scoreBenchmark()` 与不可变 `DetectionBenchmarkReport`，配套真实合成 fixtures `benchmarks/detection-v1/**`（cart-known-bugs 3 状态 5 缺陷 + cart-normal 正常任务，每场景重复 3 次）。Scorer 计算五项指标——`knownBugRecall`、`p0Recall`、`findingPrecision`（仅 high-confidence）、`stableReproductionRate`、按 normal mission 分组的 `highConfidenceFalsePositivesByNormalMission`——并对五道阈值逐一判定。**不可伪造的 provenance**：每个 `BenchmarkAttempt` 携带 `profileSha256`，Scorer 要求全部 attempt 共享同一哈希并与 `referenceProfileSha256(manifest.referenceProfile)` 比对；匹配则 `profileStatus="reference"`，否则 `"unverified"`；`profileStatus` 恒由代码派生、绝不接受调用方传入，Unverified Profile 结果的 gate 恒为 `"unverified"`（永不 `"passed"`），无论指标多好——即“未经验证的探索结果永不能被当作发布级 Reference Profile 结果计分/上报”这条硬不变量的代码级强制。**确定性**：`reportId` 由 `sha256(canonicalJson({manifestHash,profileHash,truthHash,已排序 attemptIds}))` 折叠，`attemptId=${runId}:${scenarioId}:${repetition}`，默认时间戳采用 `1970-01-01T00:00:00.000Z` 哨兵，故相同输入恒产出逐字节相同的报告。Task 4 新增可运行应用 `apps/benchmark-runner/**`（`qualigence-benchmark run --manifest <dir> [--output <file>] [--db <path>]`）：加载冻结 manifest，经 PR-14 冻结的 `ExplorationController` 对每个 fixture 场景×重复真实驱动有界探索会话（确定性 `ScenarioExplorationTarget`/`ScenarioWalkAgent` + `FROZEN_CLOCK`），采集 findings、构造 attempts、经 Task 3 Scorer 计分、产出 Report，gate 通过方 `exitCode=0`；durable 存储层为严格增量的 SQLite 迁移 `004-exploration-benchmark`（`benchmark_runs`、`benchmark_attempts`、`exploration_checkpoints`、`benchmark_reports`，不改动迁移 001–003）与 append-only `SqliteBenchmarkStore`。E2E `tests/e2e/detection-benchmark/{reference-profile,unverified-profile}.test.ts`（6 用例）覆盖：已知良好 fixture 上五道 Reference 阈值全过（发布 Gate 核心断言）、Scorer 确定性（同输入同报告）、真实召回不足时 reference 运行如实 `gate=failed`、持久化往返、以及 Unverified Profile 结果在被当作发布级结果呈现时被显式拒绝/标注。冻结阈值：`p0RecallMinimum=1`、`knownBugRecallMinimum=0.8`、`findingPrecisionMinimum=0.6`、`stableReproductionRateMinimum=0.7`、`maximumHighConfidenceFalsePositivesPerNormalMission=1`。验证证据：`pnpm build`、`pnpm test`（480 passed / 1 skipped，84 文件，较基线 465 新增 15 用例——9 scorer 单测 + 6 detection-benchmark E2E，无既有回归）、`pnpm typecheck`、`pnpm smoke:node-imports`（新增 `@qualigence/benchmarking-detection`）、`git --no-pager diff --check` 均通过。偏差：因引入版本化迁移 004，`SUPPORTED_SCHEMA_VERSION` 升为 4（延续 PR-12/PR-13 先例，`tests/contract/sqlite/sqlite-runtime.test.ts` 早已引用该常量且以子集断言表存在，无需改动）；`scoreBenchmark(manifest, attempts, groundTruth)` 三参位置签名保持不变，仅追加可选第四参 `ScoreOptions{createdAt?}`（向后兼容，且不影响计分/reportId）；`runId`/`attemptId` 采用确定性推导（append-only 存储以 `onConflict doNothing` 幂等），以“确定性”硬不变量优先于设计文档“每次执行新 attempt”的措辞。

2026-08-01（PR-16 / LS-10）：在 `feat/ls-10-investigation-review` 分支完成 LS-10 的调查/审阅领域与持久化（Task 1/2/3 + Task 5 的 Investigation/Review/IntelligenceJob 部分），Evidence Capsule 密码学业务逻辑仍归 PR-17，本 PR 仅按设计 §6 预留其 schema-only 元数据表。Task 1 新增 `packages/core-modules/investigation/**`：`InvestigationCase` 聚合（单写者 + expected-version 乐观并发 + idempotencyKey，`FORWARD_ORDER` 禁止生命周期回退，绝不 last-writer-wins）、显式 `InvestigationBudget` 台账（有界复现尝试/计划修订/环境重试等维度，任一维度达上限即 `exhausted`，`environment_failed` 仅消耗环境预算）、append-only `ReproductionAttempt`，以及终态 `BugEpisode`（可复现、带根因叙述，`confirm()` 要求 confidence≥阈值且存在 outcome=`reproduced` 的确认尝试）与 `HumanHandoff`（预算耗尽或歧义时携 `budget_exhausted:<dimension>` 等 limitationCodes 转人工）。Task 2 新增 `packages/core-modules/intelligence/**`：`IntelligenceJob`/`IntelligenceResult` 契约与确定性 `IntelligenceResultApplier`（校验顺序 envelope→去重(ledger)→base version→terminalStatus→budget→evidence→policy→execute+record，模型绝不直接写聚合，只有校验后的确定性协调逻辑写），并在 `packages/core-modules/investigation/src/application/**` 增设协调器/复现规划器；additively 扩展 `packages/contracts/model-provider/src/index.ts`（新增 `investigation.reproduction-planning`、`investigation.bug-analysis` 操作）与 `packages/runner-components/model-agent/src/investigation-agent.ts`。Task 3 新增 `packages/core-modules/review/**`：`ReviewTask`（open→claimed→resolved，`version`）与并发 claim 语义——claim/resolve 需 expected-version + idempotencyKey，两并发 claim 绝不同时成功，落败者显式收到 `ReviewTaskVersionConflict`（携 currentVersion+assigneeId）而非被滞后投影静默覆盖。Task 5 新增严格增量 SQLite 迁移 `005-investigation-review`（不改动迁移 001–004，`SUPPORTED_SCHEMA_VERSION` 升为 5）：investigation_cases/attempts/bug_episodes/handoffs、review_tasks/claims/resolutions、intelligence_jobs/results/applied_results，以及 schema-only Evidence Capsule 元数据表 evidence_encryption_profiles、evidence_capsule_manifests（含 revision/parent_revision、protected header 字段、ciphertext_sha256/bytes、wrapped_dek/nonce/auth_tag、revocation_state）、evidence_capsule_entries、evidence_key_rotations、evidence_local_only_records（**独立表**，绝不进入远端上传查询）、evidence_audit_events；配套 `SqliteInvestigationStore`（快照 + append-only + 乐观并发）、`SqliteReviewStore`（单条原子 `UPDATE ... WHERE version=? AND status=?` CAS，autocommit 保证并发下恰好一名胜者）、`SqliteIntelligenceStore`（AppliedResultLedger 幂等）。PR-17 将在这些表之上新增 Evidence Capsule store，不得修改迁移 005。测试：`tests/unit/core-modules/{investigation,review}/**`、`tests/unit/core-modules/intelligence/result-applier.test.ts`、`tests/component/{investigation,review}/**`、`tests/contract/sqlite/investigation-review-store.test.ts`（含双连接真实并发 claim、乐观并发陈旧写拒绝、幂等 Result 应用）。偏差：因引入迁移 005，`SUPPORTED_SCHEMA_VERSION` 升为 5；`offline-capsule-flow` 组件测试聚焦本 PR 拥有的持久化交接与 local-only 隔离不变量，Capsule 加解密逐字节比对留待 PR-17；为持久化在 `InvestigationCase`/`InvestigationBudgetLedger` 上新增只读 `budget()`/`limits()` getter（纯增量）。

2026-08-01（PR-08 / LS-05）：在 `feat/ls-05-process-integration-gate` 分支完成 LS-05 最后一环——独立进程集成 Gate（Task 4/5/6），接续 PR-05/06/07 已合并的协议契约、gRPC mTLS 传输与加密 Runner Spool。新增 `apps/core-daemon/**`：真实独立 Core 进程托管 `GrpcRunnerProtocolServer`（mTLS），并实现权威的会话/所有权状态机——`RunnerSessionService`（协议大版本协商 + 单次轮换 resume 凭据 + 经 `TraceIngestor` 持久化后才 Ack）、`RunOwnershipService`（Lease 绑定 `runId+runnerId+sessionId+leaseEpoch`，单一所有权、`mayStartAction` 按显式过期拒绝、`createRecoveryRun` 用新 `runId` 恢复且永不改判原 run 归属、`authorizeTraceUpload` 拒绝跨 Runner 上传）、`ExecutionJobService`、`RunnerResumeTokenService`（哈希存储 + 常量时间比较 + TTL + 证书指纹绑定）；以及任务书要求的 Core 侧 `RunnerBackedRunResourceFactory`——其 Observer/ActionExecutor 由经 `RunnerConnectionPort` 派发到已租约 Runner 的 `RemoteRunnerTarget` 支撑，保持 `RunExecutionUseCase`/`RunResourceFactory` 接口不变。新增 `apps/runner/**`：真实独立 Runner 进程，经 `GrpcRunnerProtocolClient`（mTLS）连接并握手；`LeaseWindow`（单调时钟推导的防御性动作窗口，wall-clock 回拨即关闭且不因后续读数复开）、`SpoolingTraceRecorder`（提交前先落 `SqliteRunnerSpool`）、`TraceUploadPump`（仅在 Core Ack 后才 `acknowledge` spool）、`LeasedJobExecutor`（先做 capability 协商再 accept，本地二次拦截过期 Lease 动作）、`RunnerClient`（用 resume token 重连并按原序重放 spool）。集成 Gate `tests/component/core-runner/{independent-process,disconnect-recovery}.test.ts` 用真实 loopback gRPC + 真实 mTLS 证书 + 真实加密 Spool 验证四条不变量：断连不丢任何已接受 Trace 且按原序恰好一次重放、过期 Lease 双侧（Runner `LeaseWindow` + Core `RunOwnershipService`）拒绝新动作、跨 Runner 无法重放他人 resume token 或上传他人 run、capability 不匹配为显式拒绝而非静默降级。验证证据：`pnpm build`、`pnpm test`（313 passed / 1 skipped，58 文件，无既有 269 用例回归）、`pnpm typecheck`、`pnpm smoke:node-imports`（新增 `@qualigence/core-daemon`、`@qualigence/runner`）、`git diff --check`、`pnpm exec vitest run tests/conformance/runner-protocol tests/contract/runner-spool tests/component/core-runner`（56 passed）、`pnpm exec buf lint` 均通过。偏差：冻结的 `GrpcRunnerProtocolServer` 内部自处理 offer/lease/trace-Ack/resume 轮换且不向应用层暴露接收到的批次或完成，故 Task 4 领域服务作为并行、单测覆盖的权威状态机，而冻结 server 提供 Task 6 的线级传输；Core 侧 `RunnerBackedRunResourceFactory` 采用逐调用（per-call）远程代理绑定 Observer/Executor（贴合任务书措辞），并在 Core 侧经 `TraceIngestor` 记录 Trace（冻结协议为整 Job 粒度，per-call 需协议扩展，超出本 PR 范围）；集成 Gate 采用同进程但完全解耦的真实 gRPC-over-loopback + 真实 mTLS + 真实加密 Spool（任务书允许的等价形态），比子进程 + Playwright + 模型更确定，`apps/*/src/main.ts` 提供可运行二进制（env 配置 + SIGINT/SIGTERM 优雅关闭 + 结构化就绪日志）以备真实子进程部署。

2026-08-01（PR-10 / LS-06）：在 `feat/ls-06-local-operations` 分支完成 LS-06 最后一环——本地运维 Gate（Task 1/2/3/5），接续 PR-09 已合并的视觉输入契约（Task 4：`packages/contracts/model-provider/src/content.ts`、`packages/core-modules/model-gateway/src/data-policy.ts`，本 PR 未改动），至此 LS-06 全部实现，M1 硬化完成。新增 `packages/contracts/local-control/**`：Provider 中立的 `LocalConfig`（`dataDir`、Core loopback host/port、`runner` spool 软/硬阈值、`modelProfile.credentialRef` 引用而非内联 Secret）与分层 `HealthReport`/`HealthCheck`（`aggregateHealthStatus`：任一 fail→unhealthy、任一 warn→degraded、否则 healthy），`healthReportSchema` 作为 `tests/smoke/node-package-imports.mjs` 的运行时导入（按 PR-00 的 smoke-import 步骤追加）。新增 `apps/local-launcher/**`：`config.ts`（按 安全默认 < YAML < 环境 < 非 Secret CLI 的优先级合并、Core host 强制 127.0.0.1、拒绝内联 Secret 键 `SecretInConfiguration`、并对 PEM 私钥形状做 `[redacted]` 冗余脱敏）；`ProcessSupervisor` + `ChildProcessUnit`（用 Node `child_process` 生成、监督、重启真实 Core/Runner 子进程：有界指数退避重启、挂起启动的超时检测 `StartupTimedOut`、SIGTERM→宽限→SIGKILL 的干净停机且不泄漏子进程）；`HealthClient`（廉价 liveness：core 端口 + Runner pid；深度 readiness：数据库、Artifact 可写、Runner、磁盘、Spool）；`LocalDoctor`（一次性诊断：配置有效性、端口占用、数据库可达、磁盘余量、X509 证书有效期，可选静态 Provider 探针且不发送用户数据）；`BackupManager`（用 SQLite online backup API `db.backup()` 生成一致时间点副本，复制配置时脱敏 Secret，记录 Artifact 清单但默认不复制大对象，完成标记最后写入 + 目录原子改名，`verify()` 复算哈希 + 校验 schema 版本）；`MigrationGuard`（硬不变量：任何 pending schema 迁移前必须存在一份新鲜且经校验的备份，校验失败即 `MigrationBlocked` 拒绝迁移，不存在“无备份即迁移”的路径）；`main.ts` 将上述端口组装为 `qualigence-local init|start|stop|status|doctor|backup` 命令（`init` 生成本地 mTLS 证书 + 写 `config.yaml` + 初始化/受保护迁移数据库；`start` 后台化生成 Core→Runner、写 `runtime-state.json` 并打印一次 bootstrap token；二次 `start` 返回 `AlreadyRunning`/退出码 3；`stop` 先 Runner 后 Core 优雅停机）。新增部署脚手架 `deployments/local/config.example.yaml`。E2E `tests/e2e/local-launcher.test.ts` 用真实 CLI 子进程逐命令走通 init→start→status(healthy)→二次 start(AlreadyRunning=3)→doctor→backup→stop→status(非 healthy)，并断言 Secret 绝不出现在日志/配置/备份清单中。验证证据：`pnpm build`、`pnpm test`（351 passed / 1 skipped，63 文件，较 PR-08 基线 313 新增 38 用例、无既有回归）、`pnpm typecheck`、`pnpm smoke:node-imports`（新增 `@qualigence/local-control`）、`git --no-pager diff --check` 均通过。偏差：`apps/local-launcher` 应用脚手架（package.json/tsconfig）随 Task 1 建立（因 `config.ts` 位于该 app 且需参与编译）；`start` 默认后台化（daemon）而非 Plan 片段的 `--foreground`——阻塞式前台 start 无法既返回退出码 0 又为独立进程的后续 status 保留运行拓扑，故 `--foreground` 改为可选的前台监督模式（不在 E2E 中行使）；受冻结的 `HealthCheck.name` 枚举（`database|artifact_store|runner|spool|model_provider|disk`）约束，进程/端口/证书/配置类诊断复用既有名（Core 端口/DB/配置→`database`、TLS 证书→`runner`、Provider 探针→`model_provider`）。


| ID | Milestone | 能力 | 状态 | Spec | Plan | 代码证据 |
|---|---|---|---|---|---|---|
| LS-01 | M1 | SQLite 与 Artifact 本地持久化 | `implemented` | `docs/superpowers/specs/2026-08-01-ls-01-m1-local-persistence-design.md` | `docs/superpowers/plans/2026-08-01-ls-01-m1-local-persistence.md` | `packages/storage-providers/sqlite-runtime/**`、`packages/storage-providers/artifact-fs/**`、`packages/core-modules/evidence/src/persistence-ports.ts` |
| LS-02 | M1 | Playwright Web Target Adapter | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-02-m1-playwright-web-target-design.md` | `docs/superpowers/plans/2026-08-01-ls-02-m1-playwright-web-target.md` | — |
| LS-03 | M1 | Execution Application 与 CLI | `implemented` | `docs/superpowers/specs/2026-08-01-ls-03-m1-execution-application-cli-design.md` | `docs/superpowers/plans/2026-08-01-ls-03-m1-execution-application-cli.md` | `packages/execution-application/**`、`apps/cli/**` |
| LS-04 | M1 | Fixture、CLI E2E 与发布 Gate | `implemented` | `docs/superpowers/specs/2026-08-01-ls-04-m1-e2e-release-gate-design.md` | `docs/superpowers/plans/2026-08-01-ls-04-m1-e2e-release-gate.md` | `tests/fixtures/**`、`tests/helpers/**`、`tests/e2e/cli-web-cart.test.ts`、`tests/live/remote-model-smoke.test.ts` |
| LS-05 | M1 Hardening | Core/Runner 进程、gRPC、Capability、Spool | `implemented` | `docs/superpowers/specs/2026-08-01-ls-05-m1-core-runner-transport-hardening-design.md` | `docs/superpowers/plans/2026-08-01-ls-05-m1-core-runner-transport-hardening.md` | `packages/contracts/runner-protocol/**`、`packages/protocol-adapters/grpc-runner-protocol/**`、`packages/runner-components/runner-spool/**`、`apps/core-daemon/**`、`apps/runner/**`、`tests/component/core-runner/**`、`tests/unit/{core-daemon,runner}/**` |
| LS-06 | M1 Hardening | Launcher、健康检查、备份升级、视觉输入 | `implemented` | `docs/superpowers/specs/2026-08-01-ls-06-m1-local-operations-visual-input-design.md` | `docs/superpowers/plans/2026-08-01-ls-06-m1-local-operations-visual-input.md` | `packages/contracts/local-control/**`、`apps/local-launcher/**`、`packages/contracts/model-provider/src/content.ts`、`packages/core-modules/model-gateway/src/data-policy.ts`、`deployments/local/config.example.yaml`、`tests/unit/local-launcher/**`、`tests/component/local-launcher/**`、`tests/e2e/local-launcher.test.ts` |
| LS-07 | PRD Bridge | PRD、Expected Claims、Test Case、Mission、Execution Job | `implemented` | `docs/superpowers/specs/2026-08-01-ls-07-prd-test-planning-design.md` | `docs/superpowers/plans/2026-08-01-ls-07-prd-test-planning.md` | `packages/core-modules/{context-intake,application-model,mission}/**`、`packages/runner-components/model-agent/src/prd-planning-agent.ts`、`packages/contracts/{model-provider,runner-protocol}/src/index.ts`、`packages/storage-providers/sqlite-runtime/src/{migrations/002-prd-mission.ts,sqlite-prd-mission-store.ts}`、`packages/execution-application/src/mission-execution-use-case.ts`、`tests/component/prd-planning/prd-to-run.test.ts` |
| LS-08 | M2 | Recording 与 Procedure Skill 生命周期 | `implemented` | `docs/superpowers/specs/2026-08-01-ls-08-m2-recording-skill-lifecycle-design.md` | `docs/superpowers/plans/2026-08-01-ls-08-m2-recording-skill-lifecycle.md` | `packages/runner-components/{recording,skill-replay}/**`、`packages/core-modules/skill/**`、`packages/storage-providers/kms-local/**`、`packages/contracts/model-provider/src/index.ts`、`packages/runner-components/model-agent/src/skill-induction-agent.ts`、`packages/storage-providers/sqlite-runtime/src/{migrations/003-skill.ts,sqlite-skill-store.ts}`、`tests/replay/procedure-skill/**`、`tests/component/skill-lifecycle/recording-to-replay.test.ts` |
| LS-09 | M2 | Regression、Exploration、Detection Benchmark v1 | `implemented` | `docs/superpowers/specs/2026-08-01-ls-09-m2-exploration-benchmark-design.md` | `docs/superpowers/plans/2026-08-01-ls-09-m2-exploration-benchmark.md` | `packages/runner-components/exploration/**`、`packages/core-modules/mission/src/exploration-policy.ts`、`packages/runner-components/model-agent/src/exploration-agent.ts`（PR-14）、`packages/benchmarking/detection/**`、`benchmarks/detection-v1/**`、`apps/benchmark-runner/**`、`packages/storage-providers/sqlite-runtime/src/{migrations/004-exploration-benchmark.ts,sqlite-benchmark-store.ts}`、`tests/unit/benchmarking/detection/**`、`tests/e2e/detection-benchmark/**`（PR-15） |
| LS-10 | M2 | Reproduction、Bug Episode、Human Review、Evidence Capsule | `plan_ready` | `docs/superpowers/specs/2026-08-01-ls-10-m2-investigation-review-evidence-design.md` | `docs/superpowers/plans/2026-08-01-ls-10-m2-investigation-review-evidence.md` | （PR-16 已交付调查/审阅领域与持久化）`packages/core-modules/{investigation,intelligence,review}/**`、`packages/runner-components/model-agent/src/investigation-agent.ts`、`packages/storage-providers/sqlite-runtime/src/{migrations/005-investigation-review.ts,sqlite-investigation-store.ts,sqlite-review-store.ts,sqlite-intelligence-store.ts}`；Evidence Capsule 密码学（PR-17）与集成 Gate（PR-18）待续 |
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
| M1 硬化 | 完成 | LS-05、LS-06 均已完成（PR-05/06/07/08 交付 LS-05；PR-09/10 交付 LS-06） |
| PRD 到执行 | 已完成 | — |
| M2 Web Skill 与调查闭环 | 未完成 | LS-10、LS-11（LS-08 已完成，PR-13 交付；LS-09 已完成，PR-14/15 交付） |
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
