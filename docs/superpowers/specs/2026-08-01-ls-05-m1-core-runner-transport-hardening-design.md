# [LS-05] M1 Core/Runner Transport 硬化设计

- 状态：批量设计草案，待整体审阅
- Milestone：M1 Hardening
- 直接依赖：LS-04
- 下游：LS-06、LS-11、LS-13

## 1. 目标与边界

本能力包把 LS-03 的单进程 Composition Root 拆成独立 Core Daemon 和 Local Runner，并补齐正式 gRPC Runner Protocol、Capability Negotiation、Execution Lease、Trace 批量确认、断线重连和本地持久化 Spool。

保持不变：`ExecutionRuntime` 固定管线、Model Provider/Gateway、Target Adapter、TraceIngestor、Storage ports 和 `RunExecutionUseCase` 的调用语义。

范围外：Local Launcher、视觉模型输入、Self-hosted OIDC/PostgreSQL/S3、Windows Companion。

## 2. 进程与目录

```text
apps/core-daemon/
  src/api/run-controller.ts
  src/runner/runner-session-service.ts
  src/runner/execution-job-service.ts
  src/main.ts
apps/runner/
  src/runner-client.ts
  src/job-executor.ts
  src/main.ts
packages/contracts/runner-protocol/
  proto/qualigence/runner/v1/runner.proto
  src/capabilities.ts
  src/messages.ts
packages/protocol-adapters/grpc-runner-protocol/
  src/client.ts
  src/server.ts
  src/mappers.ts
packages/runner-components/runner-spool/
  src/sqlite-runner-spool.ts
tests/conformance/runner-protocol/
tests/component/core-runner/
```

Core 依赖 `RunnerConnectionPort`，Runner 依赖 `RunnerClientPort`；两端均不导入 gRPC DTO。`grpc-runner-protocol` 是唯一了解 Protobuf/gRPC 的包。

## 3. 协议与版本

```ts
export type RunnerProtocolMajor = 1;

export interface RunnerHello {
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly supportedProtocolMajors: readonly number[];
  readonly capabilities: RunnerCapabilities;
  readonly resumeToken?: string;
}

export interface RunnerCapabilities {
  readonly operatingSystem: "windows" | "macos" | "linux";
  readonly architecture: "x64" | "arm64";
  readonly targetAdapters: readonly string[];
  readonly observationExtensions: readonly string[];
  readonly actionKinds: readonly string[];
  readonly model: {
    readonly structuredOutput: boolean;
    readonly visionInput: boolean;
  };
  readonly maximumArtifactBytes: number;
}

export interface RunnerWelcome {
  readonly sessionId: string;
  readonly resumeToken: string;
  readonly selectedProtocolMajor: 1;
  readonly serverVersion: string;
  readonly heartbeatIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly traceBatchMaximumEvents: number;
  readonly traceBatchMaximumBytes: number;
  readonly maximumInFlightBatches: number;
  readonly maximumPendingWriteBytes: number;
}

export interface ExecutionJobOffer {
  readonly offerId: string;
  readonly job: AcceptedExecutionJob;
  readonly requiredCapabilities: readonly string[];
  readonly leaseDurationMs: number;
}

export interface ExecutionJobLease {
  readonly jobId: string;
  readonly runId: string;
  readonly leaseToken: string;
  readonly leaseEpoch: number;
  readonly expiresAt: string;
}

export interface ExecutionEventBatch {
  readonly batchId: string;
  readonly runId: string;
  readonly firstSequenceNumber: number;
  readonly events: readonly TraceEvent[];
}

export interface ExecutionEventAck {
  readonly batchId: string;
  readonly runId: string;
  readonly nextExpectedSequenceNumber: number;
}
```

Protobuf 字段号发布后不复用；未知 minor 字段必须可忽略。无法选择共同 major 返回 `ProtocolVersionMismatch` 并关闭连接。Capability 不匹配返回结构化 Offer rejection，不发送 Job Payload。

`runId` 在协议中固定表示一次执行尝试，不表示可由多个 Runner 接力执行的逻辑任务。需要重新执行时 Core 创建新的 `runId`，并在持久化 Job provenance 中记录 `recoveryOfRunId`；Trace schema 不把两个执行尝试合并为同一 Run。

## 4. 核心 Ports

```ts
export interface RunnerConnectionPort {
  offer(job: AcceptedExecutionJob, requirements: readonly string[]): Promise<ExecutionJobLease>;
  cancel(jobId: string, reason: string): Promise<void>;
}

export interface RunnerClientPort {
  connect(hello: RunnerHello): Promise<RunnerSession>;
}

export interface RunnerSession {
  nextOffer(signal: AbortSignal): Promise<ExecutionJobOffer>;
  accept(offerId: string): Promise<ExecutionJobLease>;
  renew(lease: ExecutionJobLease): Promise<ExecutionJobLease>;
  submit(batch: ExecutionEventBatch): Promise<ExecutionEventAck>;
  complete(lease: ExecutionJobLease, result: ExecutionCompletion): Promise<void>;
  close(): Promise<void>;
}

export interface SpoolBatchLimit {
  readonly maximumEvents: number;
  readonly maximumBytes: number;
}

export interface RunnerSpool {
  append(event: TraceEvent): Promise<void>;
  pending(runId: string, fromSequence: number, limit: SpoolBatchLimit): Promise<readonly TraceEvent[]>;
  acknowledge(runId: string, nextExpectedSequenceNumber: number): Promise<void>;
  usage(): Promise<{ readonly bytes: number; readonly events: number }>;
}
```

`RunExecutionUseCase` 的远程实现通过 `RunnerConnectionPort.offer` 调度，不感知 gRPC。

### 4.1 与 LS-03 RunResourceFactory 的集成

LS-03 的 `RunResourceFactory` 在本轮**保留而非替换**，它是 `RunExecutionUseCase` 唯一的资源构造缝（seam）。`RunExecutionUseCase` 始终只调用 `RunResourceFactory.open(runId, request)` 拿到 `RunResourceScope` 并驱动其 `runtime: ExecutionRuntime`，它不导入任何传输类型（`RunnerConnectionPort`、`RunnerSession`、`grpc-runner-protocol` DTO 或 Protobuf）。因此从 LS-03 的进程内资源切换到 LS-05 的远程 Runner 时，`RunExecutionUseCase` 的公开接口（`execute(RunExecutionRequest): Promise<RunExecutionResult>`）不变。

(a) **保留还是替换**：`RunResourceFactory` 保留。它不被 `RunnerConnectionPort` 替换，而是**包裹**后者——工厂在 Core Daemon 侧的实现内部持有 `RunnerConnectionPort`，并把它封装进返回的 `RunResourceScope`。

(b) **精确的缝**：切换仅发生在工厂产出的 `RunResourceScope.runtime`（`ExecutionRuntime`）内部：

- LS-03 进程内实现：`RunResourceFactory` 返回的 `RunResourceScope.runtime` 是直接驱动进程内 Playwright Target Adapter 的 `ExecutionRuntime`。
- LS-05 远程实现：Core Daemon 侧的 `RunResourceFactory` 返回的 `RunResourceScope.runtime` 是一个由 `RunnerConnectionPort` 支撑的远程 `ExecutionRuntime`——它通过 `RunnerConnectionPort.offer(job, requirements)` 把执行尝试派发给远程 Runner，并把远程回传的 `ExecutionEventBatch` 经 `TraceIngestor` 写入 `RunResourceScope.traces`；`ExecutionRuntime` 完成后返回同样的 `ExecutionCompletion`。

`RunnerConnectionPort`、`RunnerSession` 与 gRPC DTO 全部位于该工厂产出的 `RunResourceScope` 背后，`RunExecutionUseCase`、Model Agent 与应用层其它代码都不引用它们。`RunStore`、`TraceStore`、`ArtifactStore`、`ArtifactManifestStore` 的接口在两种实现下保持一致，Component Test 仍可用进程内内存实现替换该缝。

## 5. Lease、断线和交付语义

- Server 是 Job/Lease 状态的唯一写者；Runner 只能 accept、renew、complete。
- Offer 至少一次交付；`offerId` 和 `jobId` 幂等。
- Lease 绑定 `runId + runnerId + sessionId + leaseEpoch`；`leaseEpoch` 在一次 ownership grant 内保持不变，renew 只延长保守期限，任何重新授权都必须使用更大 epoch（同一 lost run 不重新授权）。Server 只保存 token hash，并用常量时间比较。任何其他 Session/Runner 即使知道 runId 也不能 renew、complete 或提交该 Run 的新 Trace。
- 同一 runId 在 LeaseLost 后永不自动换 Runner。原 Runner identity 只能通过受控 Session resume 补传已经写入 Spool 的 Trace，不能继续新动作；任何重新执行必须创建新 runId。无法确认外部副作用时转人工，不自动重放。
- Lease token 只保存在进程内安全状态和 Runner Spool metadata，日志中始终脱敏。
- Runner 每 `leaseDuration/3` renew。收到 Lease 时以单调时钟建立保守 action deadline，并减去配置的 safety margin；墙钟 `expiresAt` 只用于审计和 Server 判定。墙钟回拨、进程暂停恢复、renew deadline 超时或无法建立可信 action window 时立即停止新动作。
- 已发生 Trace 即使 Lease 过期仍可续传；Job completion 在 Lease 丢失后返回 `LeaseLost`，Server 根据已收 Trace 决定恢复或人工处理。
- Runner 先把 Trace 原子写入 Spool，再尝试网络提交；收到 Ack 后才删除/压缩已确认记录。
- Server 以 `TraceIngestor` 逐事件接收 batch；遇到缺口返回期望序号，Runner 从该序号重发。
- 同序号不同哈希立即隔离 Session，返回 `TraceIntegrityViolation`。

Server 不把 transport reconnect 等同于 execution recovery。Session resume 只恢复协议身份、Lease metadata 和 Trace cursor；它不延长 Lease，也不产生新的执行许可。

## 6. Spool 设计

Runner 使用独立 SQLite 文件：

```text
spool_events(run_id, sequence_number, payload_hash, envelope_json, size_bytes,
             created_at, PRIMARY KEY(run_id, sequence_number))
spool_cursors(run_id PK, next_ack_sequence, updated_at)
spool_leases(job_id PK, run_id, lease_epoch, expires_at, encrypted_token,
             token_nonce, token_tag, updated_at)
```

Lease token 使用 Runner 首次初始化生成的 256-bit 本地 spool key 以 AES-256-GCM 加密；key 文件与本地 CA 私钥同级，只允许当前 OS 用户读取，不进入 SQLite、日志或备份明文。key 丢失时废弃尚未过期的本地 Lease、保留 Trace，并通过新 Session 请求 Server 处理；禁止把 token 改成明文恢复。

每条 Lease metadata 使用独立随机 96-bit nonce 和 128-bit authentication tag；AAD 是 canonical UTF-8 JSON `{schemaVersion,jobId,runId,leaseEpoch,expiresAt}`。`encrypted_token` 保存 ciphertext，`token_tag` 单独保存；同一 spool key 下 nonce 不得复用。Unix 使用 owner-only mode，Windows 使用仅当前 logon SID 的显式 DACL，Contract Test 分平台验证。

默认软限制 512 MiB，硬限制 1 GiB。软限制后停止新 screenshot/video 等非关键 Artifact，但 Trace 继续；硬限制后在当前安全检查点停止执行，返回 `SpoolCapacityExceeded`。不得删除未确认 Trace。

## 7. Transport 安全

- Local 也强制双向 TLS；Core 首次初始化生成本地 CA、Server 和 Runner client certificate，并固定 CA 指纹。Server 在发送 `RunnerWelcome` 前校验 client certificate、有效期、用途和绑定的 runnerId。
- Runner 主动连接 loopback Core；Server 不反向连接 Runner。
- gRPC message 设大小上限；大 Artifact 不进入 Trace stream。
- 每个消息有 correlation/idempotency 标识；Pino interceptor 脱敏 token、证书和 Payload。
- 连接超时、心跳缺失和协议拒绝使用稳定错误码，不以字符串重试。
- `RunnerHello.resumeToken` 携带前一 Session credential；每次成功握手的 `RunnerWelcome.resumeToken` 都签发供下一次连接使用的新 credential。它是短期、单次轮换 credential；Server 只保存 hash，并绑定 Runner certificate fingerprint、runnerId、前一 sessionId、协议 major 和 TTL。成功 resume 后旧 token 与其 hash 在同一事务标记 consumed，并保存新 token hash；resume 失败只能重新握手，不能降低 mTLS 要求。
- 双向 stream 的应用层同时限制最大在途 batch 数、待写 bytes 和单 Session queue；gRPC flow control 只负责 transport backpressure，不替代持久化 Ack。

## 8. 测试责任

- Protocol conformance：major 协商、未知 minor、Capability mismatch、重复 Offer/Batch、缺口、哈希冲突、Lease renew/lost。
- Run ownership：LeaseLost 后同一 runId 不重新分配；新执行使用新 runId；旧 identity 只能补传 Trace；其他 identity/session 被拒绝。
- Component：真实独立 Core/Runner 子进程完成购物车场景。
- Failure injection：传输中断、Core 重启、Runner 重启、Ack 丢失、墙钟回拨、进程暂停恢复、Spool 软/硬限制。
- Security：错误/过期 client certificate、runnerId 与证书不匹配、resume replay、Spool AAD/tag 篡改、超大消息、日志脱敏。

## 9. 出口 Gate

Core 与 Runner 独立进程通过正式协议闭环；断线期间 Trace 不丢失且重连幂等；Lease 到期阻止新动作；同一 Run 不发生跨 Runner 自动重放；Capability 不匹配不静默降级；现有单进程 Component Tests 仍通过。
