# [LS-03] M1 Execution Application 与 CLI 设计

- 状态：批量设计草案，待整体审阅
- Milestone：M1
- 直接依赖：LS-01、LS-02、BASE-03
- 下游：LS-04、LS-07

## 1. 目标与非目标

本能力包建立所有入口共享的 `RunExecutionUseCase`，在单进程 Composition Root 中串联 Runner Runtime、Playwright、Model Gateway、Trace Ingestor、SQLite 和 Artifact Store，并提供稳定 CLI。

CLI 只解析输入、构造依赖、调用用例、格式化输出和映射退出码。它不实现执行循环、领域判断或数据库 SQL。

非目标：独立进程、gRPC、Web API、PRD 规划、多步骤探索、Self-hosted。

## 2. 目录与依赖方向

```text
packages/execution-application/
  src/contracts.ts
  src/run-execution-use-case.ts
  src/artifact-recording-observer.ts
  src/terminal-trace-ensurer.ts
  src/index.ts
apps/cli/
  src/config.ts
  src/output.ts
  src/exit-code.ts
  src/local-run-composition-root.ts
  src/index.ts
tests/unit/execution-application/
tests/unit/cli/
tests/component/web-execution/
```

`execution-application` 只依赖 ports 与稳定 contracts。`apps/cli` 是唯一导入全部具体 Provider 的 Composition Root。

## 3. 冻结应用接口

```ts
export interface RunExecutionRequest {
  readonly target: { readonly kind: "web"; readonly url: string };
  readonly objective: string;
  readonly executionProfile: {
    readonly modelProfileId: string;
    readonly headed: boolean;
    readonly navigationTimeoutMs: number;
    readonly actionTimeoutMs: number;
  };
}

export interface RunExecutionResult {
  readonly runId: string;
  readonly status: "passed" | "finding" | "blocked" | "error";
  readonly finding?: FindingEnvelope;
  readonly errorCode?: string;
  readonly evidenceRefs: readonly string[];
}

export interface RunExecutionUseCase {
  execute(request: RunExecutionRequest): Promise<RunExecutionResult>;
}

export interface RunResourceScope {
  readonly runtime: ExecutionRuntime;
  readonly artifacts: ArtifactStore;
  readonly manifests: ArtifactManifestStore;
  readonly runs: RunStore;
  readonly traceQuery: TraceQuery;
  close(): Promise<void>;
}

export interface RunResourceFactory {
  open(runId: string, request: RunExecutionRequest): Promise<RunResourceScope>;
}
```

`RunResourceFactory` 让 Component Test 注入内存依赖，也让 LS-05 在不改用例接口的情况下切换到远程 Runner。

## 4. 应用数据流

1. 在创建 Run 前校验 URL、objective、timeout 和 model profile。
2. 生成 UUIDv7 `runId`/`jobId`，打开 Resource Scope。
3. `RunStore.create(status=running,nextSequenceNumber=1)`。
4. 创建单 Run Playwright Session；导航目标。
5. Artifact Recording Observer 在每次 capture 后写 Graph JSON、截图和 Manifest，再把 `artifactRefs` 加入 Graph。
6. `ExecutionRuntime.run` 完成固定执行管线；Trace 经 InMemory Protocol Adapter 与 `TraceIngestor` 写 SQLite。
7. 依据 `ExecutionCompletion` 完成 Run，并从 Manifest Store 汇总证据。
8. 基础设施异常映射为稳定错误码；`TerminalTraceEnsurer` 仅在 Trace 中没有终态时追加一次 `run_completed:error`。
9. `finally` 关闭浏览器与存储；清理错误不能覆盖已有业务终态，但进入 stderr 日志。

Run 已创建后必须恰好有一个 `run_completed`。`TerminalTraceEnsurer` 先通过 `TraceQuery.terminalEvent(runId)` 检查，依赖数据库唯一约束防止竞态。

## 5. CLI 契约

```text
qualigence run --url <url> --objective <text> [--output human|json] [--headed]
```

环境变量：

```text
QUALIGENCE_MODEL_BASE_URL
QUALIGENCE_MODEL_API_KEY
QUALIGENCE_MODEL_NAME
QUALIGENCE_DATA_DIR
```

API Key 只从 Secret 环境读取，不提供命令参数。配置优先级为安全默认值 < 环境变量 < 非 Secret CLI 参数。

退出码：passed=0、finding=1、blocked=2、error/配置失败=3。JSON 模式 stdout 只输出一行 `RunExecutionResult`；Pino 日志只写 stderr。Human 模式输出状态、Run ID、Finding 摘要和证据目录。

## 6. 错误与终止语义

- 创建 Run 前配置失败：不创建 Trace，返回 CLI 3。
- Policy、模型无效结构、节点失效、Action 失败：blocked，不生成 Finding。
- 有证据支持的 Verification failed：finding。
- Browser、Provider、SQLite、Artifact 基础设施故障：error，不生成 Finding。
- Artifact 失败发生在 Finding 前时禁止产生引用缺失的 Finding。
- 用户可见错误只含稳定 code、correlation/run ID 和安全消息；底层 stack 仅在受控 debug 日志。

稳定应用错误码包括 `InvalidConfiguration`、`InvalidTargetUrl`、`ModelAuthenticationFailed`、`ModelUnavailable`、`BrowserUnavailable`、`PersistenceUnavailable`、`ArtifactUnavailable` 和 `CleanupFailed`。

## 7. 测试责任

- Unit：Request 校验、error mapping、exit code、human/json 输出。
- Component：内存 Target + 确定性模型 + 真实 Runtime 验证 passed/finding/blocked/error 和 finally。
- Integration：真实 Playwright + SQLite/FS + mock HTTP Provider。
- JSON 输出用 snapshot/schema 检查，不断言日志行顺序。

## 8. 出口 Gate

一个应用接口完成真实 Web Run；正常/缺陷/阻塞/基础设施错误有稳定终态；所有已创建 Run 只有一个终止事件；CLI 结果与日志隔离；后续 PRD Planner 可直接调用用例而非启动 CLI。

