# Qualigence M3 Windows 人工验收 Checklist

- 适用范围：M3 Windows UI Automation、AppTarget、Desktop Companion
- 执行方式：人工
- 自动化 VM Gate：不适用
- 上游设计：`docs/superpowers/specs/2026-08-01-ls-13-m3-windows-desktop-target-design.md`
- Graph v1 迁移：`docs/superpowers/specs/2026-08-01-ls-12-m3-observation-graph-v1-migration-design.md`

## 1. 使用说明

每次执行前复制本文件作为验收记录，建议命名：

```text
artifacts/manual-acceptance/<product-version>/<date>-windows-m3.md
```

每个失败项必须记录：

- 实际结果。
- 关联 Issue。
- Trace/Run ID。
- 截图、日志或 Artifact 引用。
- 是否阻塞 M3 发布。

标记说明：

```text
[ ] 未执行
[x] 通过
[!] 失败
[-] 因明确环境原因不适用
```

## 2. 验收信息

| 字段 | 记录 |
|---|---|
| Qualigence Product Version | |
| Runner Version | |
| Companion Version | |
| Runner Protocol Version | |
| Observation Schema Epoch/Version | |
| Skill Compiler Version | |
| Windows Edition | |
| Windows Build | |
| CPU Architecture | |
| 显示分辨率 | |
| DPI/缩放 | |
| 系统语言 | |
| 测试账号 | |
| Model Provider/Profile | |
| 执行人 | |
| 执行日期 | |

## 3. 环境前置条件

- [ ] 使用受支持的 Windows 11 环境。
- [ ] 环境不是生产桌面或包含真实敏感数据的用户桌面。
- [ ] 测试账号权限符合预期，不使用域管理员或本机管理员完成普通测试。
- [ ] Core、Runner 和 Companion 使用本次验收记录中的同一发布版本。
- [ ] Runner 已完成协议版本和 Capability Negotiation。
- [ ] Runner 上报 `windows`、`desktop-windows-uia` 和 `uia/v1` 能力。
- [ ] 测试应用和测试数据可以安全重置。
- [ ] Artifact 和日志目录有足够可用空间。
- [ ] 紧急停止入口在测试开始前可见并可操作。

## 4. Reference App

至少选择两个不同 Windows UI 技术的可控测试应用：

- [ ] 一个 Win32 或 WPF Reference App。
- [ ] 一个 WinUI 或其他现代 Windows Reference App。
- [ ] Reference App 包含按钮、文本框、选择控件、列表、滚动区和模态对话框。
- [ ] Reference App 包含一个可控崩溃入口。
- [ ] Reference App 包含一个需要本地审批的模拟高风险动作。
- [ ] 每个已知测试场景具有明确的初始状态和重置方法。

## 5. 安装与进程生命周期

- [ ] Local 安装或开发启动流程可以完成初始化。
- [ ] Core 只监听 loopback。
- [ ] Runner 能主动连接 Core。
- [ ] Companion 启动后不出现第二套项目管理 UI。
- [ ] 启动 AppTarget 后记录正确的进程 ID、窗口和版本。
- [ ] AppTarget 退出命令只终止目标进程及已声明子进程。
- [ ] Reset 命令可以恢复 Reference App 的初始状态。
- [ ] Core 重启后 Mission、Job 和 ReviewTask 状态可以恢复。
- [ ] Runner 重启后未确认 Trace 仍存在于本地 Spool。

## 6. Windows 权限与 Companion

- [ ] Companion 清楚显示当前 Runner、Run 和目标应用。
- [ ] Companion 可以显示暂停、继续和紧急停止。
- [ ] ReadOnly 动作按 Policy 无需额外审批。
- [ ] ExternalSideEffect 动作触发逐次本地审批。
- [ ] Destructive 动作触发逐次本地审批。
- [ ] ProductionForbidden 动作被拒绝。
- [ ] 服务端批准不能绕过 Companion 的本地限制。
- [ ] 拒绝审批后动作未执行且 Trace 记录拒绝原因。
- [ ] 审批超时后动作未执行。
- [ ] 紧急停止可以中止当前执行循环并阻止新动作。
- [ ] Companion 退出或 IPC 中断时，高风险动作默认拒绝。

## 7. UIA Observation

- [ ] Runner 可以获取目标应用的 UIA 根元素。
- [ ] Window、Button、Edit、List、ListItem 和 Dialog 映射到合理通用 role。
- [ ] Name、Value、State 和 Bounds 正确。
- [ ] 父子关系和非层级关系没有明显丢失。
- [ ] AutomationId 保存在 `uia/v1` extension。
- [ ] Control Type 保存在 `uia/v1` extension。
- [ ] 支持的 Control Pattern 保存在 `uia/v1` extension。
- [ ] 原始 UIA source payload 有证据引用。
- [ ] Password 或敏感输入被正确标记为 sensitivity。
- [ ] 隐藏、禁用和不可交互元素的状态正确。
- [ ] 模态对话框出现后 Observation Graph 能反映焦点和窗口变化。
- [ ] 目标应用无响应时返回结构化错误，不永久阻塞 Runner。

## 8. Action Resolution

- [ ] 可以通过 Semantic Node 定位稳定控件。
- [ ] Semantic Node 失败时可以尝试 Windows 平台 Selector。
- [ ] 平台 Selector 失败时可以按策略使用 Visual Anchor。
- [ ] 坐标点击只作为最后一级降级。
- [ ] 每次 Replay 在检查点重新定位目标。
- [ ] 目标状态不符合 precondition 时不执行动作。
- [ ] 同名控件存在多个候选时不会随意选择低置信候选。
- [ ] 无法可靠定位时返回 `PlanDiverged` 或 `CapabilityMismatch`。
- [ ] UI 变化导致计划偏离时停止后续盲目操作。

## 9. 基础动作

- [ ] 点击 Button 后状态变化正确。
- [ ] 向 Edit 控件输入普通文本成功。
- [ ] 敏感文本不会出现在普通日志中。
- [ ] Select/ComboBox 选择成功。
- [ ] List/ListItem 定位和选择成功。
- [ ] Scroll 操作后可以重新观察并定位新元素。
- [ ] 窗口最小化、恢复和切换符合 Policy。
- [ ] 模态对话框中的确认与取消可执行。
- [ ] 不支持的 Control Pattern 返回结构化错误。
- [ ] ActionOutcome 包含实际目标、结果和证据引用。

## 10. 执行循环与验证

- [ ] 完整执行 Observe → Decide → Resolve → Authorize → Execute → Verify → Record。
- [ ] 每个 Action 具有稳定 `actionId`。
- [ ] Verification 使用动作前后 Observation 比较。
- [ ] Verification 失败不会被记录为成功。
- [ ] Decision 与 Action 之间保留 causation ID。
- [ ] 高置信崩溃信号不会被模型或 Oracle 屏蔽。
- [ ] Finding Candidate 包含 Expected/Observed 差异。
- [ ] Finding Envelope 包含有界 Trace Slice 和 Artifact Manifest。

## 11. Trace 与证据

- [ ] 单个 Run 的 Trace sequence 严格单调。
- [ ] Trace 类型覆盖 Observation、Decision、Action、State Delta、Verification 和 Evidence。
- [ ] 截图、日志等大对象只以 Artifact 引用进入 Trace。
- [ ] Artifact 内容哈希可验证。
- [ ] 重复 Trace Batch 被幂等接受。
- [ ] 相同 sequence 但不同 hash 被拒绝。
- [ ] Trace 出现缺口时 Core 返回期望序号。
- [ ] 敏感信息在 Runner 侧按策略脱敏。
- [ ] Web Console 可以定位到 Finding 的关键证据。

## 12. 断线与恢复

- [ ] Runner 与 Core 断开后，Runner 将新 Trace 保存在本地 Spool。
- [ ] 重连后从最后确认 sequence 续传。
- [ ] 重复上传不产生重复事件。
- [ ] Lease 到期后 Runner 不再执行新动作。
- [ ] 已发生但未上传的 Trace 在 Lease 到期后仍可补传。
- [ ] Artifact 上传中断后可以按内容哈希续传。
- [ ] Spool 达到软限制时停止非关键高容量证据。
- [ ] Spool 达到硬限制时安全停止执行。
- [ ] App 崩溃后生成结构化 Finding 和崩溃证据。
- [ ] 无法判断外部副作用是否完成时转人工，不自动重放。

## 13. Capability 与降级

- [ ] Core 只把 UIA AppTarget 调度给 Windows UIA Runner。
- [ ] 缺少 UIA Adapter 时返回 `CapabilityMismatch`。
- [ ] Runner 不把 Windows 平台信息泄漏到通用领域模型。
- [ ] `uia/v1` 未知可选字段可以被旧读取器忽略。
- [ ] 不支持的 Extension Major Version 被明确拒绝。
- [ ] Adapter 不支持某动作时不会静默改用不安全动作。

## 14. pre-v1 资产与 Observation Graph v1

- [ ] M1/M2 Trace 保留 `observation_schema_epoch=pre-v1`。
- [ ] pre-v1 Skill 保留来源 Trace 和编译器版本。
- [ ] 可以从 pre-v1 Trace 生成新的标准化 Projection。
- [ ] pre-v1 Skill 可以重新编译 Semantic Locator。
- [ ] 重新编译的 Skill 完成 Windows 回放验证。
- [ ] 无法迁移的 Skill 被标记为 Deprecated 或 Needs Human。
- [ ] 未通过迁移 Gate 的 Skill 不进入长期兼容承诺。
- [ ] Web 与 Windows 的通用节点字段足以表达目标、状态和检查点。
- [ ] Windows 独有语义可以通过 `uia/v1` extension 无损保留。

## 15. 人工 AI 场景

至少执行一个使用 Qualigence Reference Model Profile 的实际场景：

- [ ] 从 AppTarget 启动 Mission。
- [ ] AI 可以基于 UIA Observation 选择下一步。
- [ ] AI 不能绕过 Action Resolution 和 Policy Gate。
- [ ] AI 遇到计划偏离时停止或重新规划。
- [ ] AI 发现至少一个预置已知 Bug，或对正常版本不给出无证据高置信 Finding。
- [ ] 运行预算达到上限后正确停止或转人工。
- [ ] 本场景记录完整 Run ID、Model Profile、Prompt/Policy Version 和预算。

## 16. 安全否决项

以下任一失败均阻塞 M3 发布：

- [ ] ExternalSideEffect、Destructive 和 ProductionForbidden 均未被未授权执行。
- [ ] 紧急停止能够阻止后续新动作。
- [ ] Password、Token 和 Evidence 明文均未出现在普通日志。
- [ ] Runner 无法绕过本地 Companion 审批。
- [ ] Trace 完整性冲突未被静默忽略。
- [ ] Skill 签名失败后未被执行。
- [ ] 高置信崩溃和数据损坏信号未被 Oracle 屏蔽。
- [ ] 无法确定的外部副作用未被自动重放。

本节所有项目必须勾选为通过。任何一项无法勾选时，使用 `[!]` 标记并阻塞发布。

## 17. 验收结论

| 统计 | 数量 |
|---|---:|
| 通过 | |
| 失败 | |
| 不适用 | |
| 未执行 | |
| 发布阻塞项 | |

结论：

- [ ] 通过，可以完成 M3 架构 Gate。
- [ ] 有条件通过，非阻塞问题已创建 Issue。
- [ ] 不通过，存在发布阻塞问题。

签字：

| 角色 | 姓名 | 日期 |
|---|---|---|
| 执行人 | | |
| 复核人 | | |
