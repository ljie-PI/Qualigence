# [LS-04] M1 Fixture、CLI E2E 与发布 Gate 设计

- 状态：批量设计草案，待整体审阅
- Milestone：M1
- 直接依赖：LS-03
- 下游：LS-05、LS-07、LS-08

## 1. 目标

本能力包提供确定性的购物车缺陷 Fixture、OpenAI-compatible 模拟 Endpoint、CLI 黑盒 E2E、显式 Live Smoke 和 M1 纵向闭环发布 Gate。它不新增产品架构，只验证 LS-01～LS-03 作为一个系统工作。

## 2. 测试资产

```text
tests/fixtures/web-cart/server.ts
tests/fixtures/web-cart/page.ts
tests/fixtures/openai-compatible/mock-server.ts
tests/fixtures/openai-compatible/responses.ts
tests/e2e/cli-web-cart.test.ts
tests/live/remote-model-smoke.test.ts
tests/helpers/cli-process.ts
tests/helpers/temp-data-dir.ts
```

Fixture 使用 Fastify 5，绑定 `127.0.0.1` 随机端口。测试进程负责启动、health probe、终止和端口回收。

## 3. 场景与 Oracle

同一页面支持 `normal` 和 `fault` 两种启动模式：

- 商品单价始终 `$19`。
- 点击 `Add to cart` 后，normal 总价 `$19`，fault 总价 `$29`。
- 页面包含 `data-qualigence-observe` 的价格和购物车总价；按钮可由 role/name 观察。

代码 Oracle 只存在于测试断言。产品运行时仍由 Decision/Verification 模型接口产生结构化结果。

Mock Endpoint 必须解析每次请求中的 Observation：Decision 动态寻找 Add button 的 nodeId；Verification 动态寻找 before `$19` 和 after `$19/$29` 的 graphId/nodeId/text。禁止把运行期 nodeId 写死在 fixture response。

## 4. E2E 黑盒契约

每个场景启动真实 CLI 子进程、Chromium、SQLite 和 FS Artifact，注入临时数据目录与 Mock Endpoint：

```text
normal → exit 0 → status passed → no Finding
fault  → exit 1 → status finding → expected $19 / observed $29
```

随后测试直接通过公开存储读取器重开数据库并验证：

- Run 终态与 CLI 一致。
- Trace stage 顺序正确且只有一个 `run_completed`。
- Finding 内容和证据引用存在。
- before/after Observation JSON 与 PNG Manifest 齐全。
- 每个 Artifact 的 size 和 SHA-256 有效。
- model_invocations 仅含摘要，无 Prompt、API Key 或原始响应。

失败断言还必须验证 blocked 返回 2 且不写 Finding；Provider 401 返回 3 且不重试。

## 5. Live Smoke

只有 `QUALIGENCE_LIVE_MODEL_SMOKE=true` 且四个模型环境变量齐全时运行。Live Smoke 使用 fault Fixture 和真实远程 Provider，只断言：

- 输出可解析为稳定结果。
- Decision 引用当前 Observation 节点。
- Finding 证据引用真实存在且文本匹配。
- 没有 selector 或伪造 Artifact。

Live Smoke 不断言模型措辞，不进入普通 PR 合并 Gate，不在 CI Secret 不可用时失败。

## 6. 发布 Gate 与命令

普通 PR Gate：

```text
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm test
pnpm typecheck
pnpm smoke:node-imports
pnpm test:e2e
git diff --check
```

M1 纵向闭环发布必须在 Windows、macOS 和受支持 Linux 的至少一个真实开发环境各完成一次 CLI smoke；CI 可按项目成本选择矩阵，但平台手工记录不能替代普通自动测试。

## 7. Flake 与清理规则

- 不使用固定端口、固定 sleep 或公网 URL。
- 等待服务使用 health probe 和明确 deadline。
- 每个测试独立临时目录、BrowserContext 和 Run ID。
- `afterEach` 关闭子进程与 Server；残留进程视为测试失败。
- 失败时保存 stdout/stderr、Fixture mode、Run ID 和临时目录路径；通过时删除临时目录。
- 普通 E2E 禁止自动重跑掩盖 flake；先诊断再决定重试策略。

## 8. 出口 Gate

normal、fault、blocked 和 Provider error 黑盒结果确定；SQLite/Artifact 可重读；普通 CI 无真实 Key；README 包含安装 Chromium、配置、运行、退出码和数据位置；M1 状态台账有命令与日期证据。

