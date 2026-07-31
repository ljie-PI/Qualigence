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
  readonly selectedProtocolMajor: 1;
  readonly serverVersion: string;
  readonly heartbeatIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly traceBatchMaximumEvents: number;
  readonly traceBatchMaximumBytes: number;
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

export interface RunnerSpool {
  append(event: TraceEvent): Promise<void>;
  pending(runId: string, fromSequence: number, limit: SpoolBatchLimit): Promise<readonly TraceEvent[]>;
  acknowledge(runId: string, nextExpectedSequenceNumber: number): Promise<void>;
  usage(): Promise<{ readonly bytes: number; readonly events: number }>;
}
```

`RunExecutionUseCase` 的远程实现通过 `RunnerConnectionPort.offer` 调度，不感知 gRPC。

## 5. Lease、断线和交付语义

- Server 是 Job/Lease 状态的唯一写者；Runner 只能 accept、renew、complete。
- Offer 至少一次交付；`offerId` 和 `jobId` 幂等。
- Lease token 只保存在进程内安全状态和 Runner Spool metadata，日志中始终脱敏。
- Runner 每 `leaseDuration/3` renew；renew 失败且本地时间超过 `expiresAt` 时停止新动作。
- 已发生 Trace 即使 Lease 过期仍可续传；Job completion 在 Lease 丢失后返回 `LeaseLost`，Server 根据已收 Trace 决定恢复或人工处理。
- Runner 先把 Trace 原子写入 Spool，再尝试网络提交；收到 Ack 后才删除/压缩已确认记录。
- Server 以 `TraceIngestor` 逐事件接收 batch；遇到缺口返回期望序号，Runner 从该序号重发。
- 同序号不同哈希立即隔离 Session，返回 `TraceIntegrityViolation`。

## 6. Spool 设计

Runner 使用独立 SQLite 文件：

```text
spool_events(run_id, sequence_number, payload_hash, envelope_json, size_bytes,
             created_at, PRIMARY KEY(run_id, sequence_number))
spool_cursors(run_id PK, next_ack_sequence, updated_at)
spool_leases(job_id PK, run_id, expires_at, encrypted_token, token_nonce, updated_at)
```

Lease token 使用 Runner 首次初始化生成的 256-bit 本地 spool key 以 AES-256-GCM 加密；key 文件与本地 CA 私钥同级，只允许当前 OS 用户读取，不进入 SQLite、日志或备份明文。key 丢失时废弃尚未过期的本地 Lease、保留 Trace，并通过新 Session 请求 Server 处理；禁止把 token 改成明文恢复。

默认软限制 512 MiB，硬限制 1 GiB。软限制后停止新 screenshot/video 等非关键 Artifact，但 Trace 继续；硬限制后在当前安全检查点停止执行，返回 `SpoolCapacityExceeded`。不得删除未确认 Trace。

## 7. Transport 安全

- Local 也使用 TLS；Core 首次初始化生成本地 CA、Server 和 Runner 证书并固定 CA 指纹。
- Runner 主动连接 loopback Core；Server 不反向连接 Runner。
- gRPC message 设大小上限；大 Artifact 不进入 Trace stream。
- 每个消息有 correlation/idempotency 标识；Pino interceptor 脱敏 token、证书和 Payload。
- 连接超时、心跳缺失和协议拒绝使用稳定错误码，不以字符串重试。

## 8. 测试责任

- Protocol conformance：major 协商、未知 minor、Capability mismatch、重复 Offer/Batch、缺口、哈希冲突、Lease renew/lost。
- Component：真实独立 Core/Runner 子进程完成购物车场景。
- Failure injection：传输中断、Core 重启、Runner 重启、Ack 丢失、Spool 软/硬限制。
- Security：错误证书、错误 CA、超大消息、日志脱敏。

## 9. 出口 Gate

Core 与 Runner 独立进程通过正式协议闭环；断线期间 Trace 不丢失且重连幂等；Lease 到期阻止新动作；Capability 不匹配不静默降级；现有单进程 Component Tests 仍通过。
