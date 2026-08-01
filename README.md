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

