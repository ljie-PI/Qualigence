# [LS-13] M3 Windows Desktop Target 与人工发布验收设计

- 状态：批量设计草案，待整体审阅
- Milestone：M3
- 直接依赖：LS-12
- 下游：未来 macOS/Linux Desktop 与 M4 Mobile 路线

## 1. 目标与边界

本能力包使用 Windows UI Automation 验证 AppTarget、Observation Graph v1、Action Resolution、Trace、Finding、Policy 和 Skill Replay 的跨平台抽象，并提供 Rust Desktop Companion 完成本地审批、暂停/继续和紧急停止。

当前只支持 Windows 11。macOS AX、Linux AT-SPI、Android/iOS 不实施。M3 不建设交互式 Windows VM CI、Nightly 或 Release Gate；自动测试覆盖纯逻辑/协议/Replay，真实 UI 以受支持 Windows 11 开发机或专用测试机执行现有人工 Checklist。

## 2. 进程和仓库结构

```text
apps/companion/                         # Rust binary
  Cargo.toml
  src/main.rs
  src/ipc/server.rs
  src/ipc/security.rs
  src/permit.rs
  src/approval.rs
  src/emergency_stop.rs
  src/process/job_object.rs
  src/process/app_session.rs
  src/uia/worker.rs
  src/uia/worker_supervisor.rs
packages/contracts/desktop/
  src/app-target.ts
  src/companion-ipc.ts
  src/uia-extension.ts
packages/target-adapters/desktop-windows-uia/
  src/windows-desktop-adapter.ts
  src/companion-client.ts
  src/app-environment-provider.ts
packages/core-modules/project-target/
tests/unit/target-adapters/desktop-windows-uia/
tests/replay/windows-uia/
tests/conformance/observation/windows-uia.test.ts
tests/fixtures/windows-reference-wpf/
tests/fixtures/windows-reference-winui/
docs/testing/windows-m3-manual-checklist.md
```

Rust Companion 使用 `windows` crate 调用 UIA/Win32，Tokio Named Pipe 本地 IPC，serde JSON DTO。TypeScript Adapter 不使用 FFI，避免 Runner 崩溃污染用户会话。Companion 不是项目/报告/Skill UI。

Companion 是 App process、UIA capture 和 UIA action 的唯一 broker。TypeScript 只能发送类型化 IPC 请求，不能直接导入 `windows`、启动/结束目标 PID 或持有 UIA handle。Companion 主进程持有审批、Session、Named Pipe 和 Job Object；所有可能挂死的 UIA COM 调用在同一 binary 的隐藏 `--uia-worker` 子进程中执行。

## 3. AppTarget 与生命周期

```ts
export interface AppTarget {
  readonly targetId: string;
  readonly platform: "windows";
  readonly launch: { readonly executable: string; readonly args: readonly string[]; readonly workingDirectory?: string };
  readonly process: { readonly expectedImageName: string; readonly allowedChildImageNames: readonly string[] };
  readonly window: { readonly titlePattern?: string; readonly automationId?: string };
  readonly reset: { readonly command: string; readonly args: readonly string[]; readonly timeoutMs: number };
  readonly shutdown: { readonly gracefulTimeoutMs: number; readonly forceAfterTimeout: boolean };
}

export interface DesktopEnvironmentProvider {
  launch(target: AppTarget): Promise<AppSession>;
  reset(session: AppSession): Promise<void>;
  shutdown(session: AppSession): Promise<void>;
}

export interface AppSession {
  readonly sessionId: string;
  readonly processId: number;
  readonly processCreationTime: string;
  readonly processGroupId: string;
  readonly rootWindowHandle: string;
  readonly startedAt: string;
}
```

Executable/working directory 在配置批准时 canonicalize；不接受 shell 字符串执行。Companion 使用 `CreateProcessW` argv 和 Windows Job Object 启动目标，启用 kill-on-job-close 并只允许 canonical executable 与声明的 child image。`processGroupId` 是 Companion 生成的 opaque ID，不暴露 native Job handle。Shutdown/Reset 先校验 Job membership、PID creation time 和 image path，再只影响该 Job；禁止按宽泛名称 kill，也禁止 PID reuse 误杀。Reset 是显式 argv 并受 Policy/timeout，reset helper 使用独立受控 Job。若 packaged/受保护应用不能在不 breakaway 的条件下加入 Job，`probe/launch` 返回 `AppLifecycleUnsupported`/Needs Human，绝不降级为按 image name 终止。

## 4. `uia/v1` Extension

```ts
export interface UiaPatternDescriptor {
  readonly pattern:
    | "Invoke"
    | "Value"
    | "Selection"
    | "SelectionItem"
    | "Scroll"
    | "ExpandCollapse"
    | "Toggle"
    | "Window";
  readonly available: boolean;
  readonly readOnly?: boolean;
}

export interface UiaExtensionV1 {
  readonly type: "uia/v1";
  readonly version: "1.0";
  readonly payload: {
    readonly automationId?: string;
    readonly controlTypeId: number;
    readonly frameworkId?: string;
    readonly className?: string;
    readonly nativeWindowHandle?: string;
    readonly processId: number;
    readonly isOffscreen: boolean;
    readonly isKeyboardFocusable: boolean;
    readonly hasKeyboardFocus: boolean;
    readonly patterns: readonly UiaPatternDescriptor[];
  };
}
```

UIA ControlType 映射到通用 role；AutomationId/Pattern/Framework 等无损保留在 extension。原始 UIA 属性快照写 Artifact。Password/Edit 节点标为 secret/sensitive 且 value 掩码。

## 5. Adapter 与动作

```ts
export interface DesktopAdapterCapabilities {
  readonly observationExtensions: readonly ["uia/v1"];
  readonly actionKinds: readonly ("click" | "input" | "select" | "scroll" | "window")[];
  readonly visualFallback: boolean;
  readonly coordinateFallback: boolean;
  readonly localApproval: true;
}

export interface AdapterSupport {
  readonly status: "supported" | "unsupported";
  readonly reasonCode?: string;
  readonly capabilities?: DesktopAdapterCapabilities;
}

// These two ports live in @qualigence/runner-kernel, not desktop-contracts.
export interface SensorAdapter {
  capture(session: AppSession, signal: AbortSignal): Promise<ObservationGraphV1>;
}

export interface ActionAdapter {
  supports(action: ResolvedAction): boolean;
  execute(action: ResolvedAction, permit: ExecutionPermit, signal: AbortSignal): Promise<ActionOutcome>;
}

export interface PlatformDesktopAdapter {
  id(): "desktop-windows-uia";
  platform(): "windows";
  capabilities(): DesktopAdapterCapabilities;
  probe(target: AppTarget): Promise<AdapterSupport>;
  sensors(): readonly SensorAdapter[];
  actions(): readonly ActionAdapter[];
  createEnvironmentProvider(): DesktopEnvironmentProvider;
}
```

`SensorAdapter`、`ActionAdapter`、`ExecutionPermit` 和 `ActionOutcome` 由 Runner Kernel 定义；`contracts/desktop` 不导入 Runner Kernel。Windows Action Adapter 的 `supports` 对 `targetKind:"web"` 必须返回 false。

M3 动作联合扩展为 `click | input | select | scroll | window`。解析顺序固定：Semantic Node → UIA Selector → Visual Anchor（只有 LS-06 capability/policy 允许）→ Coordinates（最后降级且需明确 policy）。

Runner Kernel 的动作 contract 固定为：

```ts
export type ProposedAction =
  | { readonly kind: "click"; readonly target: { readonly nodeId: string }; readonly reason: string }
  | { readonly kind: "input"; readonly target: { readonly nodeId: string }; readonly valueRef: string; readonly reason: string }
  | { readonly kind: "select"; readonly target: { readonly nodeId: string }; readonly option: string; readonly reason: string }
  | { readonly kind: "scroll"; readonly target: { readonly nodeId: string }; readonly direction: "up" | "down" | "left" | "right"; readonly amount: "page" | "small"; readonly reason: string }
  | { readonly kind: "window"; readonly target: { readonly nodeId: string }; readonly operation: "focus" | "minimize" | "restore" | "close"; readonly reason: string };

export interface ResolvedDesktopActionBase {
  readonly targetKind: "desktop";
  readonly actionId: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly resolution: "semantic" | "uia" | "visual" | "coordinate";
  readonly uiaPattern?: UiaPatternDescriptor["pattern"];
}

export type ResolvedDesktopAction =
  | (ResolvedDesktopActionBase & { readonly kind: "click" })
  | (ResolvedDesktopActionBase & { readonly kind: "input"; readonly valueRef: string })
  | (ResolvedDesktopActionBase & { readonly kind: "select"; readonly option: string })
  | (ResolvedDesktopActionBase & { readonly kind: "scroll"; readonly direction: "up" | "down" | "left" | "right"; readonly amount: "page" | "small" })
  | (ResolvedDesktopActionBase & { readonly kind: "window"; readonly windowOperation: "focus" | "minimize" | "restore" | "close" });

export interface ResolvedWebAction {
  readonly targetKind: "web";
  readonly kind: "click";
  readonly target: { readonly nodeId: string; readonly selector: string };
  readonly graphId: string;
}

export type ResolvedAction = ResolvedWebAction | ResolvedDesktopAction;

export type ExecutionRisk = "Normal" | "ExternalSideEffect" | "Destructive" | "ProductionForbidden";

// Lives in @qualigence/runner-kernel.
export interface ExecutionPermitDescriptor {
  readonly decisionId: string;
  readonly policyId: string;
  readonly actionDigestSha256: string;
  readonly risk: ExecutionRisk;
  readonly expiresAt: string;
}
```

LS-13 migration 必须让现有 Playwright Resolver 在所有输出增加 `targetKind:"web"`；Trace mapper 新增可忽略字段并保持旧 M1 click 语义。所有 Action Adapter 先按 `targetKind` 再按 `kind` 穷尽分支，避免 Web click 被 UIA Executor 接收。Runner Kernel 的 branded `ExecutionPermit` 同时冻结 `ExecutionPermitDescriptor`，在 Policy allow 时绑定 RFC 8785 action digest、risk、policy/decision 和 TTL；Windows Executor 只能从该 branded permit 取得 descriptor，不能从普通 JSON 自建 Core permit。

- Invoke/Selection/Value/Scroll Pattern 优先；不支持返回 `CapabilityMismatch`。
- 每次 Replay checkpoint 重新捕获并定位，不保存原生 UIA element 跨 Observation。
- 同名多候选必须根据窗口、关系、状态和 confidence 消歧；低于阈值返回 `PlanDiverged`。
- UIA 调用设 deadline；应用无响应返回 `TargetUnresponsive`，不永久阻塞 Runner。
- 高置信崩溃/进程退出信号直接产生 deterministic Finding Candidate，模型/Oracle 不能屏蔽。
- UIA capture/action 只能由 Companion 的 child worker 执行。Worker 使用 MTA 初始化 COM；每个请求有 deadline。超时后 Supervisor 终止并重建 worker，Companion tray/审批/deny latch 和 App Job 保持存活。Action timeout 视为 `ActionOutcomeUnknown`，禁止自动重放。

## 6. Companion IPC、本地 Permit 与审批

Named Pipe 名称包含当前 Windows logon SID。Server 以 `FILE_FLAG_FIRST_PIPE_INSTANCE`、overlapped I/O、`PIPE_REJECT_REMOTE_CLIENTS` 创建，并设置显式 DACL：仅当前 logon SID 和 LocalSystem；拒绝 network/anonymous。连接后用 `GetNamedPipeClientProcessId` 校验 client PID，再检查进程 token 的 user SID、interactive session ID、image path 和签名/allowlist。消息使用 32-bit length prefix，单帧、连接 queue、并发请求和 deadline 都有固定上限；超限先返回稳定错误再断开。

OS identity 之后仍必须完成 challenge-response：Companion 发送随机 256-bit nonce，Runner 用 LS-05/LS-11 client certificate 对 `{protocolMajor,companionInstanceId,nonce,runnerId}` 签名；Companion 校验证书链、有效期、client-auth EKU、fingerprint、runnerId 和签名。握手不允许只比较客户端声称的 fingerprint。

```ts
export type CompanionRequest =
  | { readonly type: "handshake.begin"; readonly protocolMajor: 1; readonly runnerId: string; readonly certificatePem: string }
  | { readonly type: "handshake.prove"; readonly challengeId: string; readonly signatureBase64: string }
  | { readonly type: "session.show"; readonly runId: string; readonly targetName: string }
  | { readonly type: "session.pause"; readonly runId: string }
  | { readonly type: "session.resume"; readonly runId: string }
  | { readonly type: "session.stop"; readonly runId: string }
  | { readonly type: "session.close"; readonly runId: string }
  | { readonly type: "app.launch"; readonly target: AppTarget }
  | { readonly type: "app.reset"; readonly sessionId: string }
  | { readonly type: "app.shutdown"; readonly sessionId: string }
  | { readonly type: "uia.capture"; readonly sessionId: string; readonly deadlineMs: number }
  | { readonly type: "permit.request"; readonly request: LocalPermitRequest }
  | { readonly type: "action.execute"; readonly sessionId: string; readonly action: ResolvedDesktopAction; readonly permit: LocalExecutionPermit; readonly deadlineMs: number };

export interface LocalPermitRequest {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly action: ResolvedDesktopAction;
  readonly authorization: LocalPermitAuthorization;
  readonly safeSummary: string;
  readonly expiresAt: string;
}

// IPC DTO; desktop-contracts does not import runner-kernel.
export type LocalActionRisk = "Normal" | "ExternalSideEffect" | "Destructive" | "ProductionForbidden";

export interface LocalPermitAuthorization {
  readonly decisionId: string;
  readonly policyId: string;
  readonly actionDigestSha256: string;
  readonly risk: LocalActionRisk;
  readonly expiresAt: string;
}

export type LocalApprovalDecision =
  | { readonly status: "approved"; readonly approvalId: string; readonly decidedAt: string; readonly permit: LocalExecutionPermit }
  | { readonly status: "denied" | "timed_out" | "emergency_stopped"; readonly approvalId: string; readonly decidedAt: string };

export interface LocalExecutionPermit {
  readonly permitToken: string;
  readonly nonceBase64: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly actionDigestSha256: string;
  readonly graphId: string;
  readonly risk: LocalActionRisk;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
```

每次 `action.execute` 都必须带 Companion 刚签发的一次性 Permit。Companion 在 `permit.request` 时用 RFC 8785 canonical action bytes 重算 digest，并要求它与 `ExecutionPermitDescriptor.actionDigestSha256` 相同；缺少/过期 authorization 或 ProductionForbidden 直接拒绝。随后生成独立随机 256-bit token 与 nonce，只在内存保存 token hash 和完整 binding；执行时用常量时间比较并校验 session/run/action/graph/digest/risk/nonce/TTL/active-unpaused session/deny latch，原子消费 token 后才提交给 UIA worker。任何字段替换、重复使用、过期、跨 Session 或动作变化都 fail closed。TypeScript/Server `ExecutionPermit` 不能生成或替代 `LocalExecutionPermit`。

Interactive Desktop 中 ExternalSideEffect/Destructive 逐次本地弹窗批准；Normal 可在 active/unpaused Session 内由 Companion 无弹窗签发单次 Permit；ProductionForbidden 永远拒绝。Companion 退出、IPC 断开或 timeout 都 fail closed。Emergency Stop 设置持久的本 Session deny latch，立即取消 UIA worker 请求并阻止后续 Permit/动作，直到用户显式开始新 Session。

Companion manifest 固定 `uiAccess=false`，不请求管理员权限，不用 UIAccess 绕过 UIPI。目标 elevated、其他 user/session、锁屏或不受支持的 RDP/remote session 时返回 `UiaAccessDenied`/`InteractiveSessionUnavailable`，不尝试提升或切换桌面。

## 7. Reference Apps 与测试边界

- WPF Reference App（.NET 10）覆盖 Button/Edit/ComboBox/List/Scroll/Dialog/Crash/Reset。
- WinUI 3 Reference App（Windows App SDK）覆盖现代控件、模态和高风险模拟动作。
- Fixture 只使用假数据，不需管理员权限，不访问公网。

普通 CI：Rust compile/unit、IPC schema/length limits、Permit binding/replay、Job Object state、UIA worker timeout/restart、UIA source payload parser、Graph conformance、Action Resolution replay、Policy matrix、protocol/capability、migration tests。可以使用非交互 Windows CI 编译，但不把真实 UIA 交互结果作为自动 Gate。

人工：严格执行 `docs/testing/windows-m3-manual-checklist.md`，复制到 `artifacts/manual-acceptance/<version>/<date>-windows-m3.md`，记录环境、Run/Trace/Artifact、失败 Issue 与双人签字。

## 8. 安全否决与错误

发布否决：无/重复/错绑定 Permit 仍执行、未授权高风险动作、Emergency Stop 无效、secret 明文日志、Runner 绕过 Companion 直接 UIA/管理 PID、Named Pipe 可被其他 user/remote client 接入、UIA hang 拖死 Companion、Trace 冲突静默接受、无效 Skill 被执行、确定性崩溃被屏蔽、未知外部副作用自动重放。

稳定错误：`AppLaunchFailed`、`AppResetFailed`、`AppLifecycleUnsupported`、`TargetUnresponsive`、`ActionOutcomeUnknown`、`UiaAccessDenied`、`InteractiveSessionUnavailable`、`UiaElementStale`、`UiaPatternUnsupported`、`PlanDiverged`、`LocalPermitInvalid`、`LocalPermitConsumed`、`LocalApprovalDenied`、`LocalApprovalTimedOut`、`CompanionIdentityRejected`、`CompanionMessageTooLarge`、`CompanionUnavailable`、`EmergencyStopped`。

## 9. 出口 Gate

Web/UIA 共用 Graph v1/Action/Trace/Finding 核心；Windows 语义通过 `uia/v1` 无损保留；Companion 独占 Job Object/UIA/Action，Named Pipe 身份与一次性 Permit、UIA worker hang recovery、App 生命周期/审批/停止/断线均可验证；pre-v1 migration Gate 完成；人工 Checklist 无安全否决失败并形成发布记录。满足后 M3 完成，其他平台通过 Adapter/extension 扩展。
