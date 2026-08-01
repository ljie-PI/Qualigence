# Qualigence
AI-native Software Quality Intelligence

## Local 与 Self-hosted 实施文档

- 实施入口：`docs/superpowers/implementation-guide.md`
- 路线与依赖：`docs/superpowers/roadmaps/2026-08-01-local-self-hosted-through-m3.md`
- 当前事实状态：`docs/superpowers/implementation-status.md`
- 编号 Design Specs：`docs/superpowers/specs/2026-08-01-ls-*-design.md`
- 编号 Implementation Plans：`docs/superpowers/plans/2026-08-01-ls-*.md`
- 可实施性审查：`docs/superpowers/reviews/2026-08-01-local-self-hosted-through-m3-readiness-review.md`

当前完整计划覆盖 Community Local 与 Team Self-hosted 到 Windows-first M3。Cloud 与 M4 Mobile 只保留路线说明，不在当前代码实施范围。

## 本地 CLI（`@qualigence/cli`）

`apps/cli` 是本地执行的唯一 Composition Root，将 SQLite/Artifact 持久化、Playwright Web Target 与 Model Gateway 组合成一次 `observe→decide→act→verify→finding` 闭环。

模型连接密钥只从环境变量读取，绝不接受 `--api-key` 之类命令行参数，也绝不写入日志、stdout 或持久化：

```bash
export QUALIGENCE_MODEL_BASE_URL="https://api.example.com/v1"
export QUALIGENCE_MODEL_API_KEY="…"      # 仅环境变量
export QUALIGENCE_MODEL_NAME="gpt-4o-mini"
export QUALIGENCE_DATA_DIR=".qualigence/data"   # 可选，默认即此值

qualigence run --url "https://example.com" --objective "add one item" --output json
```

退出码：`0` 通过、`1` 存在 Finding、`2` 被阻断（blocked）、`3` 配置或执行错误（error）。

### 安装 Chromium

Playwright Web Target 使用 Chromium。首次使用前安装浏览器：

```bash
pnpm exec playwright install chromium
```

数据位置：Run 记录与 Artifact 写入 `QUALIGENCE_DATA_DIR`（默认 `.qualigence/data`），其中
`qualigence.db` 是 SQLite 数据库，`artifacts/` 保存 Observation JSON 与截图 PNG。

## 测试与发布 Gate

| 命令 | 作用 |
|---|---|
| `pnpm build` | 增量 TypeScript 构建（`tsc -b`） |
| `pnpm test` | 构建后运行全部默认 Vitest 套件（含 E2E；不含 Live Smoke） |
| `pnpm test:e2e` | 只运行 `tests/e2e` 的 CLI 黑盒场景（normal/fault/blocked/401） |
| `pnpm typecheck` | 对测试工程做 `tsc --noEmit` |
| `pnpm smoke:node-imports` | 校验公开包的 Node 导入 |

E2E 用确定性本地 Fixture 与本地 OpenAI-compatible 模拟 Endpoint（Fastify，绑定 `127.0.0.1`
随机端口），普通 CI 不需要真实 API Key，也不访问公网。

发布 Gate（普通 PR，全部需退出 0）：

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm test
pnpm typecheck
pnpm smoke:node-imports
pnpm test:e2e
git diff --check
```

### Live Smoke（显式 opt-in，不在普通 Gate）

`pnpm test:live` 默认全部跳过，只有同时满足以下条件才对真实远程 Provider 运行 fault Fixture：

```bash
export QUALIGENCE_LIVE_MODEL_SMOKE=true
export QUALIGENCE_MODEL_BASE_URL="https://api.example.com/v1"
export QUALIGENCE_MODEL_API_KEY="…"
export QUALIGENCE_MODEL_NAME="gpt-4o-mini"
export QUALIGENCE_DATA_DIR=".qualigence/live"
pnpm test:live
```

Live Smoke 只断言结果可解析、Decision 引用当前 Observation 节点、Finding 证据真实、无伪造
Artifact，且 API Key 绝不出现在输出或持久化数据中；它不断言模型措辞，缺少凭据时不失败（跳过）。
