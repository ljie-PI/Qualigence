# [LS-11] M2 Self-hosted Runtime 与正式私有部署设计

- 状态：批量设计草案，待整体审阅
- Milestone：M2
- 直接依赖：LS-08、LS-10
- 下游：LS-12

## 1. 目标与边界

本能力包将 Local 领域/应用代码部署为 Team Self-hosted：Linux 单节点 Docker Compose 中的 Server、Intelligence Worker、共享 Web Console、PostgreSQL、对象存储、外部 OIDC 和企业 KMS；外部 Runner 只更换 Endpoint/证书即可连接。Web Console 同时接入 Community Local 的 Core API，补齐 Local 与 Self-hosted 共用的项目、执行、Skill、调查和人工审阅界面。

首版正式目标是 Linux x86_64/arm64 单节点，不声明高可用。Docker Desktop 只用于开发/演示。Helm、Cloud 多租户、计费、托管模型和自动跨区灾备不进入本包。

## 2. 进程与镜像

```text
TLS Reverse Proxy
├─ qualigence server
│  ├─ Fastify Public API
│  ├─ gRPC Runner Endpoint
│  └─ Core Command/Projection
├─ qualigence web-console
├─ qualigence worker
│  └─ IntelligenceJob consumer
├─ PostgreSQL 17
├─ MinIO / External S3
├─ External OIDC
└─ Vault / Enterprise KMS
```

Server 与 Worker 使用同一 OCI image，通过命令选择角色：`qualigence server|worker|migrate|doctor`。Migration 是显式一次性命令；Server 启动不暗中执行破坏性 migration。

Web Console 产物是静态 SPA，由 Reverse Proxy 或 Server static route 提供；它不与 Server/Worker 共用 Node 运行时代码，也不直连数据库。

## 3. 仓库结构

```text
apps/server/
apps/intelligence-worker/
apps/admin-cli/
apps/web-console/
  src/routes/
  src/features/projects/
  src/features/missions/
  src/features/runs/
  src/features/skills/
  src/features/investigations/
  src/features/reviews/
packages/contracts/public-api/
packages/core-application/
packages/storage-providers/relational-kysely/
packages/storage-providers/postgres-runtime/
packages/storage-providers/artifact-s3/
packages/storage-providers/kms-self-hosted/
packages/auth/oidc/
packages/observability/
deployments/self-hosted/compose/
  compose.yaml
  .env.example
  Caddyfile
  README.md
tests/contract/postgres/
tests/contract/artifact-s3/
tests/contract/kms-self-hosted/
tests/e2e/self-hosted/
```

`relational-kysely` 保存共享逻辑 schema/migrations/query 实现；SQLite/PostgreSQL runtime 只提供方言、连接和数据库特有锁语义。领域模块不依赖 Fastify/Kysely/OIDC/S3。

## 4. Public API 和认证

Public API v1 只暴露 DTO，不返回领域实体：projects/targets、PRD/test plans、missions/runs、skills、findings/cases、review tasks 和 evidence metadata。所有 route 通过 OIDC issuer/audience/JWKS 校验，并映射到：

```ts
export interface RequestPrincipal {
  readonly subject: string;
  readonly tenantId: string;
  readonly roles: readonly ("admin" | "tester" | "reviewer" | "viewer")[];
}
```

每个 Repository 查询显式接收 tenantId；禁止依赖全局当前租户。Local 自动使用 `local` tenant，但共享应用接口相同。

Runner gRPC 使用独立 mTLS identity，不使用用户 OIDC token。Worker 使用服务身份和最小数据库/KMS权限。

## 5. Web Console 边界

Web Console 使用 React 19.2、Vite、TanStack Router 和 TanStack Query，唯一后端是 Public API v1。首版页面固定为：

- Project/Target 与 PRD revision。
- Draft Test Plan 审阅和 expected-version 批准。
- Mission 创建、Run 状态和 Trace/Artifact 链接。
- Skill version、verification、签名状态和 promotion/deprecation。
- Finding/Investigation、Reproduction Attempt、Evidence limitation。
- Review Queue 的 open/claim/resolve，并显示并发冲突后的真实 assignee/version。

浏览器不持有 KMS/Runner/数据库凭证，不下载未获授权的 Evidence Capsule 明文。Local 首次启动使用一次性 bootstrap token 建立 loopback session；Self-hosted 使用 OIDC Authorization Code + PKCE。Web DTO 与领域实体分离，所有 mutation 携带 idempotency key 和 expected version（适用时）。

## 6. Intelligence Worker 与 Durable Work

首版不用 Redis/RabbitMQ/Kafka。`intelligence_jobs` 使用 PostgreSQL `FOR UPDATE SKIP LOCKED` 租用：

```ts
export interface IntelligenceJobLease {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly workerId: string;
  readonly expiresAt: string;
  readonly attempt: number;
}
```

Worker 每 lease/3 renew，Result 通过幂等键提交。Worker 崩溃后过期 Job 可重租；结果应用仍由 Core Command Handler 执行。ExecutionJob 与 IntelligenceJob 的表、Lease 类型和状态机严格分开。

## 7. PostgreSQL/S3/KMS Provider

- PostgreSQL 17，默认 `READ COMMITTED`；聚合 expected version 条件写；Outbox 同事务。
- Migration 同时运行 SQLite/PostgreSQL Schema Conformance Suite；方言差异集中在 runtime 包。
- Artifact S3 key 为 `<tenant>/<project>/<sha256-prefix>/<sha256>`，先 put，再登记 Manifest；HEAD/GET 校验 size/hash metadata。
- S3 重复 hash 幂等；跨 tenant 不共享逻辑引用。
- KMS Provider 发布 Encryption Profile、wrap/unwrap、rotate/revoke 和 audit；Vault Transit 或企业实现通过同一 contract。
- Secret 只通过 environment/secret file/SecretProvider，Compose 示例不含真实 secret。

## 8. Compose、安全和运维

- Reverse Proxy 是唯一公开入口；PostgreSQL/MinIO 只在内部 network。
- Server/Worker 非 root、read-only root filesystem、drop capabilities、显式 writable volumes。
- TLS 必须配置；示例开发证书不能标为 production。
- OIDC、KMS、对象存储任一生产依赖缺失时 doctor 失败，不自动改成本地弱实现。
- 提供 `/health/live`、`/health/ready`、Prometheus metrics 和 OTLP traces；Pino JSON 脱敏。
- Migration 前运行数据库备份和 Artifact Manifest export；失败停止 rollout。
- Compose 升级文档给出 backup→migrate→start→verify，回滚只回二进制，不自动降级数据库 schema。

## 9. 可观测指标

Mission/Job queue、Lease、Runner session/reconnect、Trace cursor、Spool usage、Projection lag、模型 latency/token/cost、Finding confirmation/reproduction、Artifact/KMS/Evidence errors。指标标签不得包含 prompt、URL query、用户文本或高基数 artifact ID。

## 10. 测试责任

- Provider Contract：PostgreSQL 与 SQLite 同套逻辑语义；FS/S3、Local/Self-hosted KMS。
- Auth：issuer/audience/tenant/role、过期 token、JWKS rotation。
- Web Console：MSW contract fixtures、路由/查询状态、Plan approval、Review 并发冲突、Artifact 授权；Browser E2E 只走 Public API。
- Component：Server/Worker 进程、Job lease/重启/幂等 Result。
- Compose E2E：启动依赖、migrate、doctor、外部 Runner、Skill/Investigation 全闭环、备份校验。
- Security：无 TLS、默认 secret、跨 tenant、错误 mTLS、KMS/S3 unavailable 均 fail closed。

## 11. 出口 Gate

Linux 单节点 Compose 在私有网络通过 Web Console/Public API 完成 PRD→Mission→Runner→Skill/Investigation/Human Review；同一 Web Console 可连接 Local Core；Runner 只改 Endpoint/证书即可连接；PostgreSQL/S3/KMS/OIDC Provider tests 通过；迁移/备份/doctor/metrics/日志脱敏有证据；部署不依赖 Cloud。
