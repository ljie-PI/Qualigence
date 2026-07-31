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
  src/ipc.rs
  src/approval.rs
  src/emergency_stop.rs
  src/uia/service.rs
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
  readonly rootWindowHandle: string;
  readonly startedAt: string;
}
```

Executable/working directory 在配置批准时 canonicalize；不接受 shell 字符串执行。Shutdown 只终止记录的 PID 和声明的 child image，禁止按宽泛名称 kill。Reset 是显式命令并受 Policy/timeout。

## 4. `uia/v1` Extension

```ts
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

M3 动作联合扩展为 `click | input | select | scroll | window`。解析顺序固定：Semantic Node → UIA Selector → Visual Anchor（只有 LS-06 capability/policy 允许）→ Coordinates（最后降级且需明确 policy）。

- Invoke/Selection/Value/Scroll Pattern 优先；不支持返回 `CapabilityMismatch`。
- 每次 Replay checkpoint 重新捕获并定位，不保存原生 UIA element 跨 Observation。
- 同名多候选必须根据窗口、关系、状态和 confidence 消歧；低于阈值返回 `PlanDiverged`。
- UIA 调用设 deadline；应用无响应返回 `TargetUnresponsive`，不永久阻塞 Runner。
- 高置信崩溃/进程退出信号直接产生 deterministic Finding Candidate，模型/Oracle 不能屏蔽。

## 6. Companion IPC 与本地审批

Named Pipe 名称包含当前 Windows user SID，ACL 只允许该用户与当前 Runner identity。握手验证 product version、nonce 和本地证书指纹。

```ts
export type CompanionRequest =
  | { readonly type: "session.show"; readonly runId: string; readonly targetName: string }
  | { readonly type: "approval.request"; readonly request: LocalApprovalRequest }
  | { readonly type: "session.close"; readonly runId: string };

export interface LocalApprovalRequest {
  readonly approvalId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly risk: "ExternalSideEffect" | "Destructive" | "ProductionForbidden";
  readonly safeSummary: string;
  readonly expiresAt: string;
}

export type LocalApprovalDecision =
  | { readonly status: "approved"; readonly approvalId: string; readonly decidedAt: string }
  | { readonly status: "denied" | "timed_out" | "emergency_stopped"; readonly approvalId: string; readonly decidedAt: string };
```

Interactive Desktop 中 ExternalSideEffect/Destructive 逐次本地批准；ProductionForbidden 永远拒绝。服务端 Approval 不能替代本地 Gate。Companion 退出、IPC 断开或 timeout 都 fail closed。Emergency Stop 设置持久的本 Session deny latch，阻止后续新动作，直到用户显式开始新 Session。

## 7. Reference Apps 与测试边界

- WPF Reference App（.NET 10）覆盖 Button/Edit/ComboBox/List/Scroll/Dialog/Crash/Reset。
- WinUI 3 Reference App（Windows App SDK）覆盖现代控件、模态和高风险模拟动作。
- Fixture 只使用假数据，不需管理员权限，不访问公网。

普通 CI：Rust compile/unit、IPC schema、UIA source payload parser、Graph conformance、Action Resolution replay、Policy matrix、protocol/capability、migration tests。可以使用非交互 Windows CI 编译，但不把 UIA 交互结果作为自动 Gate。

人工：严格执行 `docs/testing/windows-m3-manual-checklist.md`，复制到 `artifacts/manual-acceptance/<version>/<date>-windows-m3.md`，记录环境、Run/Trace/Artifact、失败 Issue 与双人签字。

## 8. 安全否决与错误

发布否决：未授权高风险动作、Emergency Stop 无效、secret 明文日志、Runner 绕过 Companion、Trace 冲突静默接受、无效 Skill 被执行、确定性崩溃被屏蔽、未知外部副作用自动重放。

稳定错误：`AppLaunchFailed`、`AppResetFailed`、`TargetUnresponsive`、`UiaAccessDenied`、`UiaElementStale`、`UiaPatternUnsupported`、`PlanDiverged`、`LocalApprovalDenied`、`LocalApprovalTimedOut`、`CompanionUnavailable`、`EmergencyStopped`。

## 9. 出口 Gate

Web/UIA 共用 Graph v1/Action/Trace/Finding 核心；Windows 语义通过 `uia/v1` 无损保留；App 生命周期/基础动作/审批/停止/断线可验证；pre-v1 migration Gate 完成；人工 Checklist 无安全否决失败并形成发布记录。满足后 M3 完成，其他平台通过 Adapter/extension 扩展。

