# Local 与 Self-hosted 至 M3 文档可实施性审查

- 日期：2026-08-01
- 审查对象：LS-01～LS-13 Design Specs 与 Implementation Plans
- 审查标准：能否由会写代码、但不负责整体架构设计的工程师按包实施

## 1. 结论

结论为“可实施，但必须按能力包顺序和 PR Gate 执行”，而不是把 13 个能力包一次性交给一个人在没有审查点的情况下连续实现。

实施者不需要自行决定技术栈、包归属、依赖方向、公开接口、主状态机、存储/协议边界、错误终止、安全降级或测试分层。每个 Plan 已给出精确文件、相邻任务接口、失败测试、最小实现行为、验证命令和提交点。

仍然需要的工程能力：TypeScript/Node.js、异步/事务/测试基础；LS-05/10/11/13 分别需要 gRPC/密码学/容器与 Windows/Rust 领域经验。经验不足可以通过代码审阅控制风险，但不能省略相应 Specialist Review。

## 2. 审查矩阵

| ID | 文件/模块明确 | 接口明确 | 状态/失败明确 | 自动测试 Oracle | 人工边界 | 可交接结论 |
|---|---|---|---|---|---|---|
| LS-01 | 是 | 是 | 是 | 重开、幂等、并发、哈希 | 无 | 可直接实施 |
| LS-02 | 是 | 是 | 是 | Graph、click、origin、cleanup | 跨平台 smoke | 可直接实施 |
| LS-03 | 是 | 是 | 是 | 四终态、单 terminal、stdout | 无 | 可直接实施 |
| LS-04 | 是 | 是 | 是 | 四场景黑盒、存储重读 | 平台 smoke | 可直接实施 |
| LS-05 | 是 | 是 | 是 | 协议/Lease/Spool/断线 | 证书部署检查 | 需协议审阅 |
| LS-06 | 是 | 是 | 是 | Supervisor/backup/vision policy | 三平台 Local smoke | 可实施，需运维审阅 |
| LS-07 | 是 | 是 | 是 | source/hash/selector/版本/E2E | Plan 人工批准 | 可直接实施 |
| LS-08 | 是 | 是 | 是 | 生命周期/签名/Replay/篡改 | Promotion 审阅 | 可实施，需安全审阅 |
| LS-09 | 是 | 是 | 是 | 预算/对抗/评分算例/Gate | Benchmark 结果复核 | 可直接实施 |
| LS-10 | 是 | 是 | 是 | 预算/并发/crypto/offline | Needs Human | 需密码学审阅 |
| LS-11 | 是 | 是 | 是 | Provider/Auth/Worker/Console/Compose | 生产配置审阅 | 需部署安全审阅 |
| LS-12 | 是 | 是 | 是 | Schema/property/golden/migration | Freeze 签字 | 可实施，需兼容审阅 |
| LS-13 | 是 | 是 | 是 | Contract/Replay/controlled apps | 完整 Windows Checklist | 需 Windows/Rust 审阅 |

## 3. 自审中发现并已修正的问题

- 补齐 LS-11 共享 Web Console，避免 Local/Self-hosted 只有 API 没有产品入口。
- 明确 LS-05 Spool Lease token 使用本地 AES-256-GCM key，避免“encrypted_token”没有密钥来源。
- 修正 LS-10 对 LS-05、LS-11 对 LS-05/06 的真实依赖。
- 移除 Plan 中通配符文件路径，列出 Server route、Console page、Migration fixture 和 Windows Reference App 文件。
- 把 Rust 测试固定到顶层 `tests/rust/`，不与 `src/` 混放。
- 修正三个无效 Vitest matcher 示例。
- 消除未定义的 `TraceQuery`，统一复用现有 `TraceStore` 游标/事件查询。
- 补齐 `RunTerminalUpdate`，让类型系统禁止把 `running` 当作终态。
- 补齐 PRD Proposal、Mission Budget/Job、Skill Assertion/Parameter、Exploration Budget/Report、Investigation Usage/Intelligence Job/Evidence Payload、Graph JSON 和 Windows Action/Adapter 等辅助类型字段。
- 冻结 Self-hosted Public API 的 Method/Path/权限/应用接口、响应 envelope、资源 DTO 和 Web Console route，避免 API/前端实施者自行设计另一套边界。
- 明确 Graph v1 在 LS-12 只能是 candidate，LS-13 证据完整后才 frozen。

## 4. 实施者不应自行填补的空白

本批文档未保留需要编码者自行补架构的占位项。版本选择以已批准的 major/minor 技术约束和 pnpm/Cargo lock 为准；安装时提交精确 lockfile。公开接口若与实施时真实库能力冲突，按实施指南暂停并发起 Spec 修订，而不是在代码中静默改名或跨层导入。

## 5. 建议的 Review 配置

- LS-01～04、07、09：一名熟悉 TypeScript/测试的 reviewer。
- LS-05：增加协议/分布式交付语义 reviewer。
- LS-06/11：增加运维与部署安全 reviewer。
- LS-08/10：增加签名/密码学与隐私 reviewer。
- LS-12：增加 Schema 兼容/迁移 reviewer。
- LS-13：增加 Windows UIA 与 Rust reviewer，并由另一人复核人工 Checklist。

这些 reviewer 是风险控制，不负责重新设计能力包；任何结构变化仍先修订对应 Design Spec。

## 6. 当前环境预检记录

2026-08-01 本机只读检查显示已安装 TypeScript 6.0.3、pnpm 11.7.0，但当前 shell 的 Node 是 v25.2.1；正式实施必须切换到文档要求的 Node 24 LTS。

同次检查中，`pnpm exec` 触发企业镜像的 lockfile 供应链校验，因多个 Visual Studio package feed 分片 URL 与当前 metadata URL 不一致而失败。Git 跟踪文件未因此改变。该问题不影响文档/架构完整性，但会阻塞新增依赖的 RED/GREEN 循环；实施前应由仓库维护者确认镜像策略或 lockfile 恢复方式，不能由实施者自行执行 lockfile 清理或放宽策略。

## 7. 技术版本基线复核

- [Node.js 24 官方发布说明](https://nodejs.org/en/blog/release/v24.18.0)确认其为 LTS；当前计划坚持 LTS major，不跟随 Current major。
- [React 官方版本页](https://react.dev/versions)列出的当前稳定文档为 19.2，与 LS-11 Web Console 选型一致。
- [Fastify v5 官方迁移说明](https://fastify.dev/docs/v5.0.x/Guides/Migration-Guide-V5/)要求 Node.js 20 以上，与 Node.js 24 基线兼容；API 计划已要求完整 request/response schema。
- [PostgreSQL 官方版本策略](https://www.postgresql.org/support/versioning/)显示 17 仍在支持期内；计划选择 17 是有意固定部署基线，不要求为了“最新”切换 major，镜像应使用当时最新的 17.x 安全修订版。

正式实施时只更新 patch/minor 与 lockfile；任何 major 切换都先修订相应 Design Spec 和兼容测试。

## 8. 机器审计结果

本次审计覆盖 13 份 Design Spec、13 份 Implementation Plan、共 66 个 Task。每个 Task 都有明确 Interfaces、五个执行步骤、RED 测试示例、实现骨架、GREEN/Gate 命令和提交边界；未发现未决占位标记、模糊实现措辞或 Files 通配路径。此结果证明文档结构完整，不替代实施时的编译、测试和 Specialist Review。
