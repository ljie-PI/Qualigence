# [LS-01] M1 本地持久化设计

- 状态：批量设计草案，待整体审阅
- Milestone：M1
- 直接依赖：BASE-02
- 下游：LS-03、LS-04、LS-05

## 1. 目标与边界

本能力包把当前内存 `TraceStore` 替换为可重启、可校验的 SQLite 实现，并提供文件 Artifact Store。完成后，Run、Trace、Finding、Artifact Manifest 和模型调用摘要都可以在进程退出后重读；大对象不进入数据库。

范围内：

- SQLite migration、Run/Trace/Finding/Manifest/Model Invocation 存取。
- Trace 顺序、幂等、哈希冲突和 Finding 内容哈希语义。
- JSON/二进制 Artifact 原子写入和 SHA-256 校验。
- SQLite WAL、Foreign Keys、Busy Timeout 和显式事务。
- Provider Contract Tests 和损坏/重开测试。

范围外：PostgreSQL、S3、Runner Spool、数据库升级备份、CLI Composition Root。

## 2. 技术选型

- TypeScript、Node.js 24、ESM。
- Kysely 0.28.x 作为类型化 SQL 层。
- better-sqlite3 12.x 作为 SQLite 驱动；不使用 `node:sqlite`。
- Node `crypto`、`fs/promises` 和同目录原子 `rename`；不增加 Artifact SDK。
- Vitest Contract Tests，测试文件只放在顶层 `tests/`。

实际安装时锁定 pnpm 解析出的精确版本并提交 `pnpm-lock.yaml`；不得在业务包中暴露 Kysely 或 better-sqlite3 类型。

## 3. 仓库与模块边界

```text
packages/core-modules/evidence
  └─ 定义 TraceStore；不依赖数据库
packages/storage-providers/sqlite-runtime
  ├─ SqliteRuntime
  ├─ SqliteTraceStore
  ├─ SqliteRunStore
  ├─ SqliteArtifactManifestStore
  └─ SqliteModelInvocationStore
packages/storage-providers/artifact-fs
  └─ LocalArtifactStore
tests/contract/sqlite
tests/contract/artifact-fs
```

`sqlite-runtime` 可以依赖 `@qualigence/evidence`、`@qualigence/runner-protocol` 和 `@qualigence/shared-kernel` 的持久化 ports/types；反向依赖禁止。LS-01 在 `@qualigence/evidence` 定义通用 Artifact/Run ports，LS-03 只消费这些 ports；如需增加应用字段，只能向后兼容扩展。

## 4. 冻结公开接口

```ts
export type RunStatus = "running" | "passed" | "finding" | "blocked" | "error";

export interface ExecutionRunRecord {
  readonly runId: string;
  readonly jobId: string;
  readonly targetKind: "web" | "app";
  readonly objective: string;
  readonly status: RunStatus;
  readonly nextSequenceNumber: number;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly errorCode?: string;
}

export interface RunTerminalUpdate {
  readonly status: Exclude<RunStatus, "running">;
  readonly completedAt: string;
  readonly errorCode?: string;
}

export interface RunStore {
  create(record: ExecutionRunRecord): Promise<void>;
  complete(runId: string, terminal: RunTerminalUpdate): Promise<"completed" | "duplicate">;
  get(runId: string): Promise<ExecutionRunRecord | undefined>;
}

export interface ArtifactWriteRequest {
  readonly artifactId: string;
  readonly runId: string;
  readonly name: string;
  readonly kind: "observation" | "screenshot" | "log" | "other";
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ArtifactManifest {
  readonly artifactId: string;
  readonly runId: string;
  readonly kind: ArtifactWriteRequest["kind"];
  readonly mediaType: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly createdAt: string;
}

export interface ArtifactStore {
  write(request: ArtifactWriteRequest): Promise<ArtifactManifest>;
  read(manifest: ArtifactManifest): Promise<Uint8Array>;
  verify(manifest: ArtifactManifest): Promise<boolean>;
}

export interface ArtifactManifestStore {
  append(manifest: ArtifactManifest): Promise<"accepted" | "duplicate">;
  listForRun(runId: string): Promise<readonly ArtifactManifest[]>;
}

export interface ModelInvocationSummary {
  readonly invocationId: string;
  readonly runId: string;
  readonly operation: string;
  readonly model: string;
  readonly status: "succeeded" | "failed";
  readonly latencyMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly providerRequestId?: string;
  readonly errorCode?: string;
  readonly occurredAt: string;
}

export interface ModelInvocationStore {
  append(summary: ModelInvocationSummary): Promise<void>;
  listForRun(runId: string): Promise<readonly ModelInvocationSummary[]>;
}
```

`TraceStore` 和 `TraceIngestor` 的现有签名不改变。`SqliteTraceStore` 必须直接实现该 port。

## 5. SQLite Schema v1

```text
schema_migrations(version PK, name UNIQUE, applied_at)
execution_runs(run_id PK, job_id, target_kind, objective, status,
               next_sequence_number, created_at, completed_at NULL, error_code NULL)
trace_events(run_id, sequence_number, message_id UNIQUE, idempotency_key UNIQUE,
             stage, occurred_at, payload_hash, envelope_json,
             PRIMARY KEY(run_id, sequence_number), FK run_id)
findings(finding_id PK, run_id, payload_hash, envelope_json, created_at, FK run_id)
artifact_manifests(artifact_id PK, run_id, kind, media_type, relative_path UNIQUE,
                   sha256, size_bytes, created_at, FK run_id)
model_invocations(invocation_id PK, run_id, operation, model, status, latency_ms,
                  input_tokens NULL, output_tokens NULL, provider_request_id NULL,
                  error_code NULL, occurred_at, FK run_id)
```

Migration 版本只单调增加。启动时事务性执行未应用 migration；数据库版本高于二进制支持版本时以 `DatabaseVersionTooNew` 失败，禁止猜测兼容。

## 6. 一致性与资源生命周期

- `appendTraceEvent` 在 `BEGIN IMMEDIATE` 事务中读取 `next_sequence_number`、判断重复/冲突、插入事件并更新游标。
- 相同 `(run_id, sequence_number)` 且 `payload_hash` 相同返回 `duplicate`；不同返回 `TraceIntegrityViolation`。
- `idempotency_key` 已存在但指向不同事件时返回 `TraceIntegrityViolation`。
- `appendFinding` 按 `finding_id + payload_hash` 幂等；同 ID 不同哈希拒绝。
- `LocalArtifactStore.write` 校验 `name` 只能是单个相对文件名；写 `<name>.<uuid>.tmp`、`fsync`、rename，再计算最终文件的哈希和长度。
- 文件写成功但 Manifest 入库失败时保留孤儿文件并记录结构化错误；清理由显式 reconciliation 完成，绝不返回未登记引用。
- `SqliteRuntime.close()` 幂等；关闭后所有 store 调用返回 `StorageClosed`。

## 7. 安全、隐私和错误

- 数据目录默认 `<QUALIGENCE_DATA_DIR>/qualigence.db` 与 `artifacts/<run-id>/`。
- `relativePath` 必须经 `path.resolve` 验证仍在 Artifact 根目录内。
- 不保存 API Key、完整 Prompt、模型原始响应、DOM 原文或图片数据库 BLOB。
- 稳定错误码：`DatabaseOpenFailed`、`DatabaseVersionTooNew`、`StorageBusy`、`StorageClosed`、`TraceIntegrityViolation`、`SequenceGap`、`ArtifactPathRejected`、`ArtifactWriteFailed`、`ArtifactHashMismatch`。
- `SQLITE_BUSY` 不在 Provider 内无限重试；Busy Timeout 到期后映射为 `StorageBusy`。

## 8. 测试责任

- Unit：路径校验、哈希、migration 排序。
- Contract：新建/重开数据库、Trace 重复/缺口/冲突、Finding 冲突、Manifest、模型摘要。
- Failure injection：rename 失败、数据库关闭、损坏 Artifact、版本过新。
- Concurrency：两个连接并发追加同一 Run，只有一个序号被接受。

## 9. 入口与出口 Gate

入口：BASE-02 的 `TraceStore`、Trace hash 和 Finding 幂等语义通过。

出口：所有公开 port 有真实 SQLite/FS 实现；进程重启后数据可重读；Artifact 可定位并通过哈希；普通测试无外部服务；不存在原始模型敏感内容落盘。
