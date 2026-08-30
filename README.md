# Qualigence
AI-native Software Quality Intelligence

## Architecture And Tracked Work

- Open-source architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md`
- Context map: `CONTEXT-MAP.md`
- Current production-closure spec: GitHub umbrella Issue [#67](https://github.com/ljie-PI/Qualigence/issues/67)
- Current production-closure tickets: the native sub-issues of [#67](https://github.com/ljie-PI/Qualigence/issues/67)
- Graph and Windows acceptance: `docs/testing/`

The tracked tickets cover Community Local and Team Self-hosted through the Windows-first M3 closure. Merged GitHub pull requests/checks and serialized Gate artifacts are the evidence history; deferred advanced hardening is tracked as GitHub Issues.

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

## 本地 Launcher（`@qualigence/local-launcher`）

`apps/local-launcher` 把独立的 Core Daemon 与 Runner 包装成可日常使用的 Community Local 产品：统一的初始化、进程生命周期监督、分层 health/doctor 诊断，以及升级前强制备份。Launcher 只依赖进程/health/backup 端口，不导入领域模块、不访问业务表、不修改 Trace。

命令（`qualigence-local <command>`，数据目录由 `--data-dir` 或 `QUALIGENCE_DATA_DIR` 决定）：

```bash
qualigence-local init                 # 首次安装：创建数据目录、生成本地 mTLS 证书、写入 config.yaml、初始化数据库
qualigence-local start [--foreground] # 有监督地依次启动 Core→Runner；默认后台化并打印一次 bootstrap token
qualigence-local status [--json]      # 输出分层 HealthReport（core 端口、数据库、Artifact、Runner、磁盘）
qualigence-local doctor [--json]      # 一次性诊断：配置有效性、端口占用、数据库可达、磁盘余量、证书有效期
qualigence-local stop                 # 优雅停机：先停 Runner 再停 Core（SIGTERM，超时后 SIGKILL）
qualigence-local backup --reason <text> # 用 SQLite online backup API 生成一致、可校验的时间点备份
```

Secret 处理：任何 API Key、私钥、口令等 Secret 绝不写入 `config.yaml`。配置里只保存 `credentialRef` 引用，真实密钥在运行时从环境变量解析（`QUALIGENCE_MODEL_API_KEY` 或 `QUALIGENCE_SECRET_<REF>`）。Launcher 会拒绝加载内联了 Secret 键的配置，且日志、健康报告与备份清单中的 Secret 一律以 `[redacted]` 呈现。示例配置见 `deployments/local/config.example.yaml`。

备份与迁移不变量：任何数据库 schema 迁移之前，`MigrationGuard` 都会强制先创建并校验一份新鲜备份（校验完成标记与文件哈希、并确认备份数据库可在记录的 schema 版本下重新打开）。校验失败时迁移被拒绝（`MigrationBlocked`），不存在“无备份即迁移”的路径。

离线人工恢复：`restore` 不作为普通命令公开。要从 `<dataDir>/backups/<timestamp>-<version>/` 恢复，请先 `qualigence-local stop` 确保 Core 与 Runner 均已停止，另存当前 `qualigence.db` 与 `artifacts/`，再将备份目录中的 `database.db` 覆盖回 `<dataDir>/qualigence.db`；Artifact 大对象按备份清单（`backup-manifest.json` 的 `artifactInventory`）从原始位置保留或复制。恢复完成后重新 `start`。

稳定错误码：`AlreadyRunning`（`start` 退出码 3）、`StartupTimedOut`、`CoreUnhealthy`、`RunnerUnhealthy`、`BackupFailed`、`BackupIntegrityFailed`、`MigrationBlocked`、`InvalidConfiguration`。

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

## Self-hosted Release Artifacts

Release deployment uses immutable image digests, not mutable tags. The production
Compose file remains the local build/development entrypoint; release candidates
are rendered from `deployments/self-hosted/compose/compose.release.yaml` only
after `scripts/verify-release-manifest.mjs` validates a
`qualigence-release-manifest/v1` record.

A valid release manifest binds exactly one repository commit to:

- the application image reference `name@sha256:<digest>` for Server, Worker, and
  Admin CLI roles;
- the Console static image reference `name@sha256:<digest>`;
- an SPDX JSON SBOM path and SHA-256;
- provenance/attestation identifiers for the pushed images;
- the mandatory same-commit Gate artifacts `gate-linux`, `gate-windows-rust`,
  `gate-self-hosted`, and `browser-e2e`;
- the signed Ticket 31 Windows native acceptance evidence path and SHA-256.

Verify a generated manifest and render digest-only Compose with:

```bash
GH_TOKEN="$(gh auth token)" GITHUB_REPOSITORY=ljie-PI/Qualigence \
  QUALIGENCE_VERIFY_ATTESTATIONS=true \
  pnpm gate:release -- --manifest artifacts/release/<version>/release-manifest.json \
    --repository ljie-PI/Qualigence \
    --commit <40-char-commit> \
    --render-compose artifacts/release/<version>/compose.release.rendered.yaml
```

If the manifest carries repository-relative `artifactPath` values for local Gate
archives, `GH_TOKEN` is not required; otherwise the verifier downloads each
named artifact by immutable artifact ID and recomputes its SHA-256.

The release verifier rejects mutable tags, non-`sha256:` image references,
wrong repository/commit, duplicate or missing Gate names, cross-commit Gate
artifacts, mismatched SBOM or Windows-evidence hashes, and unsigned Windows
evidence. Ticket 31 and Ticket 46 evidence are phase-2 release dependencies;
missing human/provider evidence is a blocked release, never a synthetic pass.

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
