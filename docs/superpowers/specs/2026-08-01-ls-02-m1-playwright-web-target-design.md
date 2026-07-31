# [LS-02] M1 Playwright Web Target Adapter 设计

- 状态：批量设计草案，待整体审阅
- Milestone：M1
- 直接依赖：BASE-02、BASE-03
- 下游：LS-03、LS-04、LS-06

## 1. 目标与边界

本能力包用真实 Chromium 实现 WebTarget 的观察、语义节点解析、同源点击、截图和确定性资源关闭。Adapter 只把 Playwright 映射为 Runner Kernel ports，不包含模型、持久化、CLI 或测试业务 Oracle。

首版只支持：导航、语义观察、截图和 click。输入、上传、拖拽、多 Tab、自主探索和视觉定位不在 LS-02。

## 2. 技术与包结构

- Playwright 1.62，使用 `playwright` Library API，不使用 Playwright Test 作为产品运行时。
- Node.js 24、TypeScript、ESM。

```text
packages/target-adapters/web-playwright/
  src/browser-session.ts
  src/observation-builder.ts
  src/playwright-observer.ts
  src/playwright-action-resolver.ts
  src/playwright-action-executor.ts
  src/index.ts
tests/unit/target-adapters/web-playwright/
tests/component/web-execution/playwright-web-target.test.ts
```

公开模块不得导出 `Page`、`Locator`、`Browser` 等 Playwright 类型。Playwright 对象只存在于 Adapter 内。

## 3. 冻结公开接口

现有 `Observer`、`ActionResolver` 和 `ActionExecutor` 签名保持不变。Adapter 额外公开生命周期和截图能力：

```ts
export interface WebSessionOptions {
  readonly url: string;
  readonly headed: boolean;
  readonly navigationTimeoutMs: number;
  readonly actionTimeoutMs: number;
  readonly allowedOrigins: readonly string[];
}

export interface CapturedArtifact {
  readonly name: string;
  readonly mediaType: "image/png" | "application/json";
  readonly bytes: Uint8Array;
}

export interface WebTargetSession {
  start(): Promise<void>;
  captureArtifacts(graphId: string): Promise<readonly CapturedArtifact[]>;
  close(): Promise<void>;
}

export class PlaywrightWebTargetAdapter
  implements Observer, ActionResolver, ActionExecutor, WebTargetSession {}
```

`PlaywrightWebTargetAdapter` 是 Composition Root 使用的门面；内部仍分为 Session、Observer、Resolver 和 Executor，禁止把执行算法移入门面。

## 4. Observation 与 nodeId

每次 capture：

1. 确认 Session 已启动且页面仍活动。
2. 从 accessibility snapshot/role locator 和 `[data-qualigence-observe]` 构建候选。
3. 规范化 role、name、text、value、disabled 和 confidence。
4. 为本次 graph 分配 `graphId = <run-id>:observation:<ordinal>`。
5. 根据 DOM 顺序和规范化语义生成 `nodeId = n-<ordinal>-<short-hash>`。
6. 在 Session 内保存 `(graphId,nodeId) -> LocatorDescriptor`。
7. 返回 `ObservationGraph`；不返回 selector 给模型。

文本规范化为 Unicode NFC、连续空白折叠和 trim。节点 confidence 首版固定为 `1`，仅包含真实读取到的属性。密码输入值不进入 graph。

持久化 JSON 必须是 Graph 的序列化副本；Locator 和 ElementHandle 永不持久化。

## 5. 动作解析与执行

- `resolve` 只接受当前 Session 最近一次或仍登记的 graph；未知 graph 返回 `StaleObservation`。
- nodeId 不存在返回 `UnknownObservationNode`。
- Resolver 使用 Session 内 LocatorDescriptor 恢复 Locator，执行 `count()`；0 个返回 `TargetNotFound`，多于 1 个返回 `AmbiguousTarget`。
- ResolvedAction 的 `selector` 字段保存脱敏的内部 locator token（如 `pw:<graphId>:<nodeId>`），不是 CSS/XPath。
- Executor 验证 `ExecutionPermit`、graphId 和 token，再检查目标可见、启用且当前 URL origin 在 allowlist。
- click 导致离开 allowlist 时立即停止并返回 `OriginViolation`；不继续观察新 origin。
- Playwright timeout 映射为失败 `ActionOutcome`；Browser 崩溃或启动失败作为基础设施异常抛给应用层。

## 6. 生命周期、并发与恢复

- 一个 Adapter 实例只服务一个 Run，不跨 Run 共享 Page 或 BrowserContext。
- `start`、`close` 幂等；`capture/resolve/execute` 串行化，重入返回 `ConcurrentSessionOperation`。
- 每个 Run 使用隔离 BrowserContext；默认 headless。
- 首次导航仅允许 `http:`/`https:`，拒绝凭证 URL 和无 allowlist origin。
- Locator 失效时 Resolver 允许调用方重新观察一次；Adapter 自身不重新请求模型或自动点击。
- `close` 按 Page → Context → Browser 顺序尽力关闭，聚合首个错误并保证其余清理继续。

## 7. 安全与日志

- 不记录完整 DOM、截图 bytes、Cookie、Authorization header、表单值或 Playwright storage state。
- 默认阻止下载、弹窗外部导航和非 http(s) scheme。
- 同源 Policy 是本地硬边界，模型选择节点不能绕过。
- 稳定错误码：`BrowserLaunchFailed`、`NavigationFailed`、`NavigationTimedOut`、`StaleObservation`、`UnknownObservationNode`、`AmbiguousTarget`、`OriginViolation`、`ActionTimedOut`、`ConcurrentSessionOperation`。

## 8. 测试责任

- Unit：文本规范化、nodeId、token、origin 检查。
- Component：真实 Chromium 捕获按钮/文本、点击后状态变化、截图、关闭。
- Negative：未知节点、跨 graph、同名多节点、跨 origin、disabled、timeout。
- 不在 LS-02 测试模型措辞、数据库或 CLI。

## 9. 出口 Gate

在本地 Fixture 上，真实 Chromium 能返回可用语义 Graph；模型只需 nodeId；授权 click 改变页面；截图可由应用层取得；所有负路径结构化失败；测试结束没有残留 Browser 进程。

