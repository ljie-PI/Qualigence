# [LS-06] M1 Local 运维与视觉模型输入设计

- 状态：批量设计草案，待整体审阅
- Milestone：M1 Hardening
- 直接依赖：LS-05
- 下游：LS-11、LS-13

## 1. 目标与边界

本能力包把独立 Core/Runner 组合包装成可日常使用的 Community Local 产品：统一 Launcher、初始化、进程生命周期、health/doctor、升级前备份和可恢复启动；同时在不破坏纯语义路径的前提下增加显式视觉模型输入。

范围外：自动在线更新服务、安装器签名发布、Web Console 功能、Self-hosted Compose、Windows UIA。

## 2. 目录和依赖

```text
apps/local-launcher/
  src/config.ts
  src/process-supervisor.ts
  src/health-client.ts
  src/backup-manager.ts
  src/doctor.ts
  src/main.ts
packages/contracts/local-control/
  src/health.ts
packages/model-gateway/
  src/data-policy.ts
packages/contracts/model-provider/
  src/content.ts
deployments/local/
  config.example.yaml
tests/component/local-launcher/
tests/contract/model-providers/vision-input.test.ts
```

Launcher 只依赖进程/health/backup ports，不导入领域模块。它不得访问业务表或修改 Trace。

## 3. Local 配置

```ts
export interface LocalConfig {
  readonly dataDir: string;
  readonly core: { readonly host: "127.0.0.1"; readonly port: number };
  readonly runner: { readonly id: string; readonly spoolSoftBytes: number; readonly spoolHardBytes: number };
  readonly modelProfile: {
    readonly provider: "openai-compatible";
    readonly baseUrl: string;
    readonly model: string;
    readonly credentialRef: string;
    readonly visualInput: "disabled" | "on-demand";
  };
}
```

优先级：安全默认值 < YAML 配置 < 环境变量 < 非 Secret CLI 参数。`credentialRef` 由 `SecretProvider` 解析；YAML 不允许 `apiKey` 字段。

## 4. Launcher 行为

命令：

```text
qualigence-local init
qualigence-local start [--foreground]
qualigence-local stop
qualigence-local status [--json]
qualigence-local doctor [--json]
qualigence-local backup --reason <text>
```

`start` 顺序：获得 data-dir 单实例锁 → 校验配置/权限/DB version → 启动 Core → 等待 `/health/ready` → 启动 Runner → 等待 Runner registered → 输出本地 URL/bootstrap token。任一步失败按反序关闭已启动进程。

`stop` 先阻止新 Job，再给 Runner 30 秒安全停止并 flush Spool，最后停止 Core。超时后才发送强制终止，并记录 PID 与原因。

## 5. Health 与 Doctor

```ts
export interface HealthReport {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly version: string;
  readonly checks: readonly HealthCheck[];
}

export interface HealthCheck {
  readonly name: "database" | "artifact_store" | "runner" | "spool" | "model_provider" | "disk";
  readonly status: "pass" | "warn" | "fail";
  readonly code?: string;
  readonly safeMessage: string;
}
```

Liveness 不调用模型或数据库重操作；readiness 检查 Schema、Artifact 可写、Runner capability；doctor 可以显式进行 Provider probe，但不发送用户数据。

## 6. 备份与升级恢复

- 任何数据库 migration 前强制创建 `<dataDir>/backups/<timestamp>-<product-version>/`。
- 使用 SQLite online backup API 生成一致副本；复制配置时移除 Secret；记录 Artifact root 清单但默认不复制大对象。
- `backup-manifest.json` 保存 product/schema/version、文件 size/hash、创建原因和完成标志。
- 只有 Manifest 完成且校验通过才允许 migration。
- migration 失败停止启动，保留原数据库和备份，不自动降级 Schema。
- `qualigence-local restore --backup <path>` 不在本能力公开为普通命令；恢复按 README 的离线人工流程执行，要求 Core/Runner 已停止并先另存当前数据。

## 7. 视觉输入契约

在 `ModelMessage` 保持 `content: string` 向后兼容的同时增加可选附件：

```ts
export interface ModelImageInput {
  readonly mediaType: "image/png" | "image/jpeg";
  readonly dataBase64: string;
  readonly sha256: string;
  readonly sensitivity: "public" | "internal" | "sensitive";
  readonly sourceArtifactId: string;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly images?: readonly ModelImageInput[];
}
```

视觉输入只有同时满足以下条件才发送：Profile=`on-demand`、Provider `visionInput=true`、Mission Data Policy 允许对应 sensitivity 出站、Artifact 哈希校验通过、调用方明确请求。否则继续语义路径或返回 `CapabilityMismatch`，不得暗中发送截图。

OpenAI-compatible Provider 将附件映射为供应商 DTO；Gateway 在 Provider 前完成 capability、最大 bytes、media type 和 Data Policy 校验。日志只记录 artifactId/hash/size，不记录 base64。

## 8. 错误与测试

稳定错误：`AlreadyRunning`、`StartupTimedOut`、`CoreUnhealthy`、`RunnerUnhealthy`、`BackupFailed`、`BackupIntegrityFailed`、`MigrationBlocked`、`VisionNotAllowed`、`VisionCapabilityMismatch`、`ImageIntegrityViolation`。

- Unit：配置优先级/Secret 拒绝、进程状态机、health 聚合、视觉 policy。
- Component：fake 子进程验证启动/回滚/停止；临时 SQLite 验证 backup/migration failure。
- Contract：OpenAI-compatible vision DTO 映射，不支持视觉时拒绝。
- Manual smoke：Windows/macOS/Linux 各执行 init/start/status/doctor/stop；不要求平台原生桌面自动化。

## 9. 出口 Gate

Local 用户可用一个 Launcher 管理 Core/Runner；异常启动可回滚；migration 有已校验备份；health/doctor 可诊断；视觉附件只在能力与政策同时允许时发送；语义-only 配置无行为回归。

