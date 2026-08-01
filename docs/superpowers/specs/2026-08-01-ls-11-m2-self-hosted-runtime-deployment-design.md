# [LS-11] M2 Self-hosted Runtime 与正式私有部署设计

- 状态：批量设计草案，待整体审阅
- Milestone：M2
- 直接依赖：LS-05、LS-06、LS-08、LS-10
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
├─ static Web Console assets
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
packages/auth/runner-mtls/
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

Runner 不复用用户身份，使用独立注册和证书 Principal：

```ts
export interface RunnerPrincipal {
  readonly runnerId: string;
  readonly tenantId: string;
  readonly projectIds: readonly string[];
  readonly certificateFingerprintSha256: string;
  readonly certificateUriSan: string;
  readonly enrollmentId: string;
  readonly status: "active" | "suspended" | "revoked";
  readonly certificateNotAfter: string;
}

export interface RunnerEnrollment {
  readonly enrollmentId: string;
  readonly tenantId: string;
  readonly runnerId: string;
  readonly projectIds: readonly string[];
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

export interface IssuedRunnerCertificate {
  readonly runnerId: string;
  readonly certificatePem: string;
  readonly caCertificatePem: string;
  readonly certificateFingerprintSha256: string;
  readonly certificateNotAfter: string;
}
```

管理员通过受审计命令创建短期、单次 enrollment token；Runner 用该 token 和本地生成的 key/CSR 换取 client certificate。URI SAN 固定为 `spiffe://qualigence.local/tenants/<tenantId>/runners/<runnerId>`，Server 在解析 `RunnerHello` 前完成链、有效期、EKU、吊销状态、fingerprint、URI SAN 和 enrollment binding 校验。Token 只保存 hash，成功签发后原子标记 consumed。Runner 被 suspend/revoke、证书过期、tenant/project scope 不匹配时，gRPC 在接收 Job Payload 前 fail closed。

Runner gRPC 使用独立 mTLS identity，不使用用户 OIDC token。Worker 使用服务身份和最小数据库/KMS权限。

Public API v1 的最小路由冻结为：

| Method | Path | 权限 | 应用接口 |
|---|---|---|---|
| GET | `/api/v1/projects` | viewer | `ProjectQuery` |
| POST | `/api/v1/projects` | tester | `CreateProject` |
| POST | `/api/v1/runner-enrollments` | admin | `CreateRunnerEnrollment` |
| POST | `/api/v1/runner-enrollments/:enrollmentId/certificate` | one-time enrollment token | `IssueRunnerCertificate` |
| GET | `/api/v1/projects/:projectId/targets` | viewer | `TargetQuery` |
| POST | `/api/v1/projects/:projectId/targets` | tester | `CreateTarget` |
| GET | `/api/v1/projects/:projectId/prd-revisions` | viewer | `PrdQuery` |
| POST | `/api/v1/projects/:projectId/prd-revisions` | tester | `IngestPrd` |
| GET | `/api/v1/test-plans/:planId` | viewer | `TestPlanQuery` |
| POST | `/api/v1/test-plans/:planId/approve` | tester | `ApproveTestPlan` |
| GET | `/api/v1/missions` | viewer | `MissionQuery` |
| POST | `/api/v1/missions` | tester | `CreateMission` |
| POST | `/api/v1/missions/:missionId/start` | tester | `StartMission` |
| GET | `/api/v1/runs/:runId` | viewer | `RunQuery` |
| GET | `/api/v1/runs/:runId/trace` | viewer | `TraceProjectionQuery` |
| GET | `/api/v1/artifacts/:artifactId` | viewer + evidence policy | `EvidenceService` |
| GET | `/api/v1/skills/:skillId/versions` | viewer | `SkillQuery` |
| POST | `/api/v1/skills/:skillId/versions/:version/promote` | tester | `PromoteSkill` |
| POST | `/api/v1/skills/:skillId/versions/:version/deprecate` | tester | `DeprecateSkill` |
| GET | `/api/v1/investigations/:caseId` | viewer | `InvestigationQuery` |
| GET | `/api/v1/review-tasks` | reviewer | `ReviewTaskQuery` |
| POST | `/api/v1/review-tasks/:taskId/claim` | reviewer | `ClaimReviewTask` |
| POST | `/api/v1/review-tasks/:taskId/resolve` | reviewer | `ResolveReviewTask` |

列表响应统一为 `{items, nextCursor?, asOfEvent, asOfTime, lagMs}`；命令响应统一为 `{resource, version, correlationId}`；错误统一为 `{code, safeMessage, correlationId, details?}`，其中冲突 `details` 只包含当前 version/assignee 等安全字段。mutation 请求头必须包含 `Idempotency-Key`，需要乐观并发的 body 必须包含 `expectedVersion`。

Public DTO 只使用以下最小资源形状；较大的 Trace/Plan/Skill Payload 通过带 `schemaVersion` 的 `payload` 字段承载，不能直接序列化 Domain class：

```ts
export interface ProjectDto { readonly projectId: string; readonly name: string; readonly version: number }
export interface TargetDto { readonly targetId: string; readonly projectId: string; readonly kind: "web" | "app"; readonly displayName: string; readonly version: number }
export interface PrdRevisionDto { readonly prdId: string; readonly projectId: string; readonly revision: number; readonly title: string; readonly contentSha256: string; readonly ingestedAt: string }
export type IntentStepDto =
  | { readonly kind: "navigate"; readonly path: string }
  | { readonly kind: "click"; readonly target: { readonly role?: string; readonly name?: string; readonly purpose: string } }
  | { readonly kind: "input"; readonly target: { readonly role?: string; readonly name?: string; readonly purpose: string }; readonly valueRef: string }
  | { readonly kind: "verify"; readonly claimIds: readonly string[] };
export interface TestCaseDto { readonly testCaseId: string; readonly title: string; readonly objective: string; readonly preconditions: readonly string[]; readonly steps: readonly IntentStepDto[]; readonly expectedClaimIds: readonly string[]; readonly priority: "low" | "medium" | "high" }
export interface TestPlanDto { readonly planId: string; readonly prdId: string; readonly prdRevision: number; readonly status: "draft" | "approved"; readonly version: number; readonly payload: { readonly schemaVersion: "test-plan/v1"; readonly testCases: readonly TestCaseDto[] } }
export interface MissionDto { readonly missionId: string; readonly projectId: string; readonly revision: number; readonly targetId: string; readonly status: "draft" | "approved" | "running" | "completed" | "blocked"; readonly version: number }
export interface RunDto { readonly runId: string; readonly missionId?: string; readonly status: "running" | "passed" | "finding" | "blocked" | "error"; readonly findingIds: readonly string[]; readonly evidenceRefs: readonly string[]; readonly createdAt: string; readonly completedAt?: string }
export interface SkillVersionDto { readonly skillId: string; readonly version: number; readonly state: "draft" | "candidate" | "verified" | "promoted" | "deprecated"; readonly contentSha256: string; readonly signatureStatus: "valid" | "invalid" | "revoked"; readonly evaluationStatus: "pending" | "passed" | "failed" }
export interface InvestigationDto { readonly caseId: string; readonly findingId: string; readonly status: "candidate" | "investigating" | "reproducing" | "confirmed" | "refuted" | "flaky" | "needs_human" | "resolved" | "regression_verified"; readonly attemptIds: readonly string[]; readonly evidenceCompleteness: "complete" | "limited" | "unavailable"; readonly version: number }
export interface ReviewTaskDto { readonly taskId: string; readonly caseId: string; readonly status: "open" | "claimed" | "resolved"; readonly priority: "low" | "medium" | "high" | "urgent"; readonly assigneeId?: string; readonly version: number }
export interface ArtifactMetadataDto { readonly artifactId: string; readonly runId: string; readonly kind: string; readonly mediaType: string; readonly size: number; readonly sha256: string; readonly downloadAllowed: boolean }
export interface RunnerEnrollmentDto { readonly enrollmentId: string; readonly runnerId: string; readonly tenantId: string; readonly projectIds: readonly string[]; readonly expiresAt: string; readonly enrollmentToken: string }
export interface RunnerCertificateDto { readonly runnerId: string; readonly certificatePem: string; readonly caCertificatePem: string; readonly certificateFingerprintSha256: string; readonly certificateNotAfter: string }
```

`RunnerEnrollmentDto.enrollmentToken` 只在创建响应出现一次，不进入查询 DTO、日志或数据库明文。Certificate exchange 接受 PEM CSR，首版仅允许 ECDSA P-256 或 RSA-3072+，并验证 CSR signature；Server 从 enrollment 生成 SAN/scope，忽略 CSR 中自带的 subject/SAN。签发 CA key 只由 `SecretProvider` 读取，或通过可替换 `RunnerCertificateIssuer` 调企业 PKI，应用数据库不保存 CA private key。

`contracts/public-api` 不导入 Core aggregate 实现或领域包；Server mapper 显式把领域公开值转换为上列 DTO，不暴露方法/私有状态。

## 5. Web Console 边界

Web Console 使用 React 19.2、Vite、TanStack Router 和 TanStack Query，唯一后端是 Public API v1。首版页面固定为：

- Project/Target 与 PRD revision。
- Draft Test Plan 审阅和 expected-version 批准。
- Mission 创建、Run 状态和 Trace/Artifact 链接。
- Skill version、verification、签名状态和 promotion/deprecation。
- Finding/Investigation、Reproduction Attempt、Evidence limitation。
- Review Queue 的 open/claim/resolve，并显示并发冲突后的真实 assignee/version。

浏览器不持有 KMS/Runner/数据库凭证，不下载未获授权的 Evidence Capsule 明文。Local 首次启动使用一次性 bootstrap token 建立 loopback session；Self-hosted 使用 OIDC Authorization Code + PKCE S256。每次授权生成并校验独立 `state`、`nonce` 和 `code_verifier`；redirect URI 必须与部署配置完全匹配；临时授权状态只进入有 TTL 的 `sessionStorage`，access token 只保存在内存，绝不写 localStorage。角色/tenant claim 名称和允许值由部署配置明确映射，未知 tenant、role 或 issuer fail closed；Server 仍独立验证签名、issuer、audience、expiry、部署允许的 `RS256 | ES256` 算法和有 timeout/cache 上限的 JWKS rotation。

静态站点 CSP 最低为 `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' <oidc-issuer>; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`，不允许 inline/eval；同时发送 `Referrer-Policy: no-referrer`，代理日志必须移除授权 code/token query。Web DTO 与领域实体分离，所有 mutation 携带 idempotency key 和 expected version（适用时）。

路由固定为 `/projects`、`/projects/:projectId/prd/:revision`、`/test-plans/:planId`、`/missions/:missionId`、`/runs/:runId`、`/skills/:skillId`、`/investigations/:caseId`、`/reviews` 和 `/reviews/:taskId`。

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

export interface IntelligenceJobStore {
  lease(input: { readonly workerId: string; readonly acceptedTypes: readonly IntelligenceJobType[]; readonly now: string; readonly leaseDurationMs: number }): Promise<{ readonly job: IntelligenceJob; readonly lease: IntelligenceJobLease } | undefined>;
  renew(input: { readonly jobId: string; readonly leaseToken: string; readonly workerId: string; readonly now: string; readonly leaseDurationMs: number }): Promise<IntelligenceJobLease>;
}

export interface IntelligenceResultInbox {
  append(input: { readonly tenantId: string; readonly jobId: string; readonly leaseToken: string; readonly leaseAttempt: number; readonly workerId: string; readonly baseAggregateVersion: number; readonly result: IntelligenceResult }): Promise<{ readonly disposition: "accepted" | "duplicate" }>;
}
```

Worker 每 lease/3 renew，Result 通过幂等键追加到 PostgreSQL `intelligence_result_inbox`。Inbox append 在同一事务校验 tenant/job、lease token hash、worker、attempt、lease expiry、baseAggregateVersion 和 result idempotency。Worker 崩溃后过期 Job 可重租。Server 独占消费 Inbox，在事务中调用 LS-10 的 `IntelligenceResultApplier`，成功后记录 applied disposition；Worker 永远不持有聚合 Repository 或业务表写权限。Worker 数据库角色只对 `intelligence_jobs` 的租约列和 `intelligence_result_inbox` 有最小 SELECT/INSERT/UPDATE 权限。ExecutionJob 与 IntelligenceJob 的表、Lease 类型和状态机严格分开。

## 7. PostgreSQL/S3/KMS Provider

- PostgreSQL 17，默认 `READ COMMITTED`；聚合 expected version 条件写；Outbox 同事务。
- 每个 tenant-owned 表以 `(tenant_id, entity_id)` 为主键或候选唯一键；所有 tenant 内引用都用包含 `tenant_id` 的复合外键，禁止仅凭全局样式 ID 跨租户引用。
- PostgreSQL 对所有 tenant-owned 表启用并 `FORCE ROW LEVEL SECURITY`。请求事务首先执行参数化 `SELECT set_config('app.tenant_id', $1, true)`；policy 使用 `tenant_id = current_setting('app.tenant_id', true)`。Server runtime role 不是 owner 且无 `BYPASSRLS`；未设置 tenant context 时返回零行/拒绝写入。Migration/backup 使用独立离线 role，不能被应用进程取得。
- Worker 使用独立 non-owner/non-`BYPASSRLS` role，只能跨租户 lease `intelligence_jobs` 和 append `intelligence_result_inbox`；专用 policy 以已认证的 `app.worker_id` 和表级 grant 限制操作，不授予其他 tenant 表权限。
- Migration 同时运行 SQLite/PostgreSQL Schema Conformance Suite；方言差异集中在 runtime 包。
- Artifact S3 key 为 `<tenant>/<project>/<sha256-prefix>/<sha256>`，先 put，再登记 Manifest；HEAD/GET 校验 size/hash metadata。
- S3 重复 hash 幂等；跨 tenant 不共享逻辑引用。
- KMS Provider 发布 Encryption Profile、wrap/unwrap、rotate/revoke 和 audit；Vault Transit 或企业实现通过同一 contract。
- 生产 Secret 只通过 Docker Compose secrets 挂载到 `/run/secrets/*` 并由 `SecretProvider` 读取；普通 environment 只保存 secret file path 和非敏感配置。`.env.example` 不出现 secret 值或弱默认值。

## 8. Compose、安全和运维

- Reverse Proxy 是唯一公开入口；PostgreSQL/MinIO 只在内部 network。
- Server/Worker 非 root、read-only root filesystem、drop capabilities、`security_opt: ["no-new-privileges:true"]`、显式 writable volumes，并设置 CPU、memory、PID 和日志轮转限制。
- TLS 必须配置；示例开发证书不能标为 production。
- OIDC、KMS、对象存储任一生产依赖缺失时 doctor 失败，不自动改成本地弱实现。
- 提供 `/health/live`、`/health/ready`、Prometheus metrics 和 OTLP traces；Pino JSON 脱敏。
- 所有第三方镜像以 digest 固定；Qualigence image 产出 SBOM 和 provenance，部署记录不可变 digest。禁止 `latest`。
- Migration 前运行 PostgreSQL 逻辑备份和完整 Artifact backup：获取阻止 Artifact GC 的短期 backup lease，在 `REPEATABLE READ` 事务中 `pg_export_snapshot()`；`pg_dump --snapshot` 和 Manifest 枚举共享该快照。对象 key 内容不可变，按快照中的 Manifest 下载 MinIO/S3 的真实 object bytes，逐个校验 metadata 与实际 SHA-256/size，并把数据库 dump、Manifest、bytes 和 canonical backup index 一起保存；任何阶段失败都不发布完成标记并停止 rollout。
- Restore Gate 必须在空 PostgreSQL/MinIO target 中恢复数据库和所有 object bytes，逐个 GET 重新计算 SHA-256/size，并运行跨租户引用/Manifest 完整性检查。只导出 Manifest 不算备份成功。
- 上述内置 backup/restore Gate 对 bundled MinIO 是发布要求。External S3 必须在部署配置中声明客户管理的 versioning/backup/restore contract 并由 `doctor` 检查必填配置；未执行客户演练时不得把 Qualigence 的 bundled-MinIO restore 证据宣传为 External S3 恢复保证。
- Compose 升级文档给出 backup→migrate→start→verify，回滚只回二进制，不自动降级数据库 schema。

## 9. 可观测指标

Mission/Job queue、Lease、Runner session/reconnect、Trace cursor、Spool usage、Projection lag、模型 latency/token/cost、Finding confirmation/reproduction、Artifact/KMS/Evidence errors。指标标签不得包含 prompt、URL query、用户文本或高基数 artifact ID。

## 10. 测试责任

- Provider Contract：PostgreSQL 与 SQLite 同套逻辑语义；FS/S3、Local/Self-hosted KMS。
- Auth：OIDC state/nonce/PKCE S256、issuer/audience/tenant/role mapping、过期 token、JWKS rotation、token 不持久化、CSP。
- Runner identity：单次 enrollment、CSR/SAN/fingerprint、过期/吊销/suspend、tenant/project scope、证书与 claimed runnerId 不一致。
- Tenant isolation：复合外键、FORCE RLS、未设置 tenant context、应用 owner/BYPASSRLS 拒绝、Worker 仅 Job/Result 表。
- Web Console：MSW contract fixtures、路由/查询状态、Plan approval、Review 并发冲突、Artifact 授权；Browser E2E 只走 Public API。
- Component：Server/Worker 进程、Job lease/重启、Result Inbox 幂等和仅由 Server 应用。
- Compose E2E：启动依赖、migrate、doctor、外部 Runner、Skill/Investigation 全闭环、真实 object bytes clean restore 校验。
- Security：无 TLS、默认 secret、跨 tenant、错误 mTLS、KMS/S3 unavailable 均 fail closed。

## 11. 出口 Gate

Linux 单节点 Compose 在私有网络通过 Web Console/Public API 完成 PRD→Mission→Runner→Skill/Investigation/Human Review；同一 Web Console 可连接 Local Core；Runner 只改 Endpoint/已注册证书即可连接；PostgreSQL RLS/S3/KMS/OIDC/Runner identity Provider tests 通过；迁移、真实对象 clean restore、doctor、metrics、SBOM 和日志脱敏有证据；部署不依赖 Cloud。
