# LS-05、LS-10、LS-11、LS-13 专项设计审查

- 日期：2026-08-01
- 范围：协议与交付语义、密码学与 KMS、Self-hosted 部署安全、Windows/Rust/UIA
- 审查对象：四份 Design Spec、对应 Implementation Plan、现有 Runner/Trace contracts
- 状态：推荐路线已获用户接受并写入 Spec/Plan；四份文档仍待整体审阅，不提前切换为 `plan_ready`

## 1. 结论

四个能力包的分层方向正确：协议 DTO 被限制在 Adapter、模型与确定性状态分离、Self-hosted Provider 不进入 Domain、Windows 平台语义通过 typed extension 表达。当前主要问题不是模块归属，而是若干安全边界尚未冻结，编码者仍会被迫自行决定交付、密钥绑定、服务身份和本地审批的真实执行语义。

本轮未发现需要推翻总体分层的缺陷，但发现 11 组 P1 问题。用户已接受第 6 节的四条合并路线，LS-05/10/11/13 的 Design Spec、Implementation Plan 和 Windows 人工 Checklist 已按这些路线修订。另有 4 个非架构文档错误已直接修正。

严重度：P0 表示当前已实现代码存在立即风险；P1 表示实施前必须解决；P2 表示对应 Task 合并前必须补齐；P3 表示可维护性改进。本轮没有 P0。

## 2. LS-05 协议与交付语义

### [P1][T-01] Lease 丢失后的 Run 所有权与重新执行没有冻结

当前 `ExecutionEventBatch` 只按 `runId` 和 sequence 标识，TraceStore 也以 `(runId, sequenceNumber)` 保证唯一；同时文档允许 Lease 丢失后继续补传 Trace，并让 Server 决定恢复。若 Server 把同一 Run 自动交给另一个 Runner，旧 Runner 的迟到 Trace、新 Runner 的新动作和同一 sequence 会发生冲突，外部副作用还可能执行两次。

建议采用不扩张核心 Trace schema 的方案：明确 `runId` 就是一次执行尝试；同一 Run 在 LeaseLost 后不得自动分配给另一 Runner。仅允许同一 Runner identity 通过受控 resume 继续上传已产生 Trace；需要重新执行时创建新 runId，并引用原 Run 作为 recovery causation。无法确认副作用时直接转人工。Server 必须把 Run、Runner identity、Session 和 Lease 绑定，并在旧 Lease 可行动窗口结束前禁止新执行。

同时，Runner 不能只比较本地墙钟与 Server 的 `expiresAt`。动作停止必须使用单调时钟和保守安全余量；系统时钟回拨、暂停恢复和过度延迟都要进入 fake-clock 测试。gRPC 官方也明确建议使用 timeout/deadline 语义避免时钟偏差。

### [P2][T-02] mTLS、resume token 与 Spool AEAD 细节不足

- 必须明确双向 TLS，而不只是 Server TLS；Runner client certificate 需绑定 runnerId，错误 identity 在 `RunnerWelcome` 前拒绝。
- `resumeToken` 应为短期、单次轮换、Server 只存 hash，并绑定 Runner certificate、前一 Session、协议 major 和 TTL；不能成为长期 bearer credential。
- Spool AES-GCM 使用每条 Lease 随机 96-bit nonce、128-bit tag，并把 jobId、runId、expiresAt、schema version 作为 AAD。Unix mode 与 Windows DACL 分别验证当前用户独占；`encrypted_token` 必须明确是否包含 tag。
- 双向 stream 需要应用层最大在途 batch/写队列边界；gRPC transport flow control 不等于 Trace 的持久化 Ack。

## 3. LS-10 密码学、KMS 与离线证据

### [P1][C-01] Capsule 安全元数据没有形成可验证的 Protected Header

Manifest 缺少明确的内容算法、包装算法、profileId、recipient、region、purpose 和 AAD schema；设计也没有冻结哪些字段进入 AES-GCM AAD。仅校验 ciphertext/tag 不能防止攻击者替换 tenant/case/policy/expiry 等未绑定 metadata。

建议为 v1 定义 canonical protected header，至少包含：schemaVersion、profileId、tenantId、caseId、recipient、region、purpose、policyId、payload schema、`enc=A256GCM`、`alg=RSA-OAEP-256`、wrappingKeyId、createdAt、expiresAt。其 canonical UTF-8 bytes 是唯一 AAD。AES-GCM 固定 256-bit DEK、96-bit nonce、128-bit tag；RSA-OAEP 固定 SHA-256、MGF1-SHA-256、空 label。任何 protected 字段变化必须在解包和明文返回前失败。

`EvidenceEncryptionProfile` 还需要包含并绑定 tenant/case/purpose，且只能从经过认证的 Core/KMS 通道取得；过期或 scope 不匹配的 profile 不得用于 wrap。

### [P1][C-02] “离线可调查”与 screenshot/log 引用不闭合

Payload 目前只有 `localScreenshotRefs`。Runner 下线后，Worker 拿到引用并不代表能取得截图或相关本地 Artifact，因此无法保证设计目标。

建议 Capsule 包含有界的 encrypted entries：Trace slice、Graph subtree、被选截图 bytes 和必要日志摘要都作为内容寻址 entry 进入同一个加密 payload，或作为分别加密但受同一 protected header/index 约束的 attachment。外部 Artifact ref 只能作为 provenance，不能作为离线调查唯一数据源。总明文/密文 bytes、单 entry 大小、media type 和 hash 必须在加密前冻结并在解密后验证。

### [P1][C-03] `local_only` 与 Manifest/KMS contract 矛盾

Manifest 当前强制 `wrappedDekBase64`，但设计又规定 `local_only` 不创建远端 wrapped DEK。应采用显式联合：`remote_capsule` 具有 recipient wrapped DEK；`local_only` 要么完全不产生可上传 Capsule，要么使用本地 key reference 并保证 API/Worker 永远无法取得。不能用空字符串伪装 wrapped key。

### [P2][C-04] 密钥生命周期与删除语义需可审计

TTL 应先撤销 unwrap authorization，再触发对象生命周期删除；备份中的旧 ciphertext 仍必须因 KMS policy 失效。Rewrap 创建 immutable Manifest revision，不修改原记录。Audit 至少记录 actor/service、tenant、case、capsule、key version、purpose、decision 和 correlationId，绝不记录 DEK/明文。Node Buffer 清零只能视为 best effort，代码不得制造“内存已彻底擦除”的安全声明。

## 4. LS-11 多租户与部署安全

### [P1][D-01] 外部 Runner certificate 没有映射到租户和项目权限

“只更换 Endpoint/证书即可连接”不足以定义授权。Self-hosted 必须增加 Runner enrollment/identity：runnerId、tenantId、project scopes、certificate fingerprint/SAN、状态、签发与到期时间。短期 enrollment token 只用于首次签发；证书轮换、吊销和审计必须有确定流程。gRPC 在认证 RunnerPrincipal、租户和 capability 前不得发送 Job payload。

这不是用户 OIDC 的复用；Runner、Worker 和用户仍保持三种独立 principal。

### [P1][D-02] Intelligence Worker 的 Result 提交边界不明确

Plan 一方面让 Worker 直接从 PostgreSQL lease Job，另一方面要求 Result 进入 Server deterministic application endpoint/store，但没有冻结端口、认证和持久化顺序。建议单节点 v1 使用 DB inbox：Worker 只拥有 `intelligence_jobs` lease/renew 与 append-only `intelligence_results` 写权限；Server 独占 result claim/apply 和所有 aggregate tables。Result 的 lease token、attempt、baseAggregateVersion 和 idempotency 在同一事务验证。这样不新增内部 HTTP 服务，也不会让 Worker 获得聚合 Repository。

### [P1][D-03] 仅靠 Repository 参数不足以形成多租户纵深防御

所有租户表需要 `(tenant_id, resource_id)` 唯一键和包含 tenant_id 的复合外键，避免跨租户关系被数据库接受。建议 PostgreSQL production runtime 再启用 `FORCE ROW LEVEL SECURITY`，应用连接使用非 owner、非 BYPASSRLS role，并在 transaction-local context 设置 tenant；migration/backup 使用独立受审计 role。Worker 跨租户 lease role 只接触 Job/Result inbox，不读取领域表。

若产品决定一个 Self-hosted deployment 永远只有一个 tenant，可删除伪多租户承诺；不能同时保留跨租户 API 测试又把数据库隔离留给编码者决定。

### [P1][D-04] 当前 backup 只覆盖数据库和 Artifact Manifest

Manifest export 不是 MinIO object bytes 的备份。内置 MinIO 模式必须冻结 bucket/object/version、配置和凭证恢复方案，并执行数据库 + object store 一致性恢复演练；External S3 模式则明确由客户提供的 versioning/backup/durability contract。Gate 必须在全新数据目录恢复后抽样 GET 并重新校验 size/SHA-256，而不是只检查 Manifest 存在。

### [P2][D-05] OIDC、SPA 和容器安全要求需写成测试 Oracle

- OIDC 固定 issuer、audience、允许算法、精确 redirect URI、state、nonce、PKCE S256、JWKS rotation/cache timeout；tenant/roles 必须通过部署配置映射，不信任任意同名 claim。
- SPA token 只保存在内存，不进入 localStorage；配置 CSP、frame-ancestors、Referrer-Policy，并避免授权 code/token 进入日志和浏览历史。
- Compose production secret 使用按 service 授权的 secret files，不用普通 environment 保存密码/API key。
- 容器增加 `no-new-privileges`、resource limits 和生产镜像 digest/SBOM 记录；数据库/MinIO 不发布 host port。
- 本轮已把 GET/POST 合并行拆开，明确 viewer 只读、tester 才能 mutation。

## 5. LS-13 Windows、Rust、UIA 与 IPC

### [P1][W-01] Companion 目前不是不可绕过的执行 Gate

现有 IPC 只有 session/approval 消息，没有 UIA capture/action、pause/resume、emergency command；approved decision 也没有绑定 action digest、graph、session 或一次性消费语义。Runner 可以复用旧批准，或直接调用另一路 UIA 执行逻辑，无法证明安全否决项“Runner 无法绕过 Companion”。

建议 Companion 成为 UIA 执行 broker，并冻结完整 IPC discriminated union：handshake、session show/pause/resume/stop/close、uia capture、approval request、action execute、result/error。Companion 生成一次性 local permit，绑定 sessionId、runId、actionId、canonical action digest、graphId、risk、issuedAt/expiresAt 和 nonce；permit 只消费一次。UIA action 必须在 Companion 内验证 permit 后执行，ProductionForbidden 永不签发。TypeScript Adapter 只能发 typed request，不能持有另一条 Win32/UIA 执行路径。

### [P1][W-02] App 进程终止不能依赖 PID + child image name

同名 image 可能属于无关应用，PID 也会复用。Windows 应在 launch 时创建 Job Object，把目标进程及不允许 breakaway 的子进程作为一个 securable unit；正常关闭失败后只终止该 Job Object。allowed child image 仍可用于观测/拒绝异常子进程，但不能作为 kill 范围。WinUI packaged app 无法安全加入 Job 时必须返回明确 unsupported/Needs Human，不能退回按名称 kill。

### [P1][W-03] UIA deadline 不能只包一层异步超时

Microsoft 要求 desktop-wide UIA client 在无窗口的独立 MTA thread 上调用；但已进入的 COM/UIA call 不会因为 JavaScript/Rust future timeout 自动停止。若 Companion 中唯一 UIA thread 卡住，后续 emergency stop 和 capture 可能一起失效。

建议同一 Companion binary 增加隐藏 `uia-worker` child-process role：Companion 保留 tray、approval 和 session latch；短命/可重启 Worker 拥有 MTA UIA objects。deadline 后 Companion 终止并重建 Worker，返回 `TargetUnresponsive`，而不是继续复用可能已污染的 COM apartment。UIA element/interface pointer 永不跨 Worker 生命周期。

### [P2][W-04] Named Pipe 与 Windows 权限需要更具体

- 使用当前 logon SID（不只是 account SID）的显式 DACL，不使用默认 security descriptor。
- 设置 `FILE_FLAG_FIRST_PIPE_INSTANCE`、`PIPE_REJECT_REMOTE_CLIENTS`、overlapped I/O、消息大小/深度上限；拒绝其他登录会话。
- 握手 nonce 必须由 certificate private key 签名，单报 fingerprint 不是 possession proof；同时核验客户端 PID/token/session。
- 默认 `uiAccess=false`，不自动提权；elevated target、secure desktop、locked/RDP-disconnected desktop 返回 `UiaAccessDenied`/`CompanionUnavailable`，不建议关闭 UIPI。
- Task 2 的提交命令已补上 `tests/rust/companion`；人工 Checklist 的上游链接已更新为 LS-12/13。

## 6. 已确认的架构选择

用户已接受以下推荐路线，并已统一写入四份 Spec/Plan：

1. LeaseLost 后同一 runId 永不自动换 Runner；重试创建新 runId，旧 Run 只允许原 identity 补传 Trace。
2. Evidence Capsule v1 增加 canonical protected header/AAD、scope-bound profile、encrypted attachment entries，并把 local-only 设计为显式联合。
3. Self-hosted 增加 RunnerPrincipal/enrollment；Worker 使用 PostgreSQL Job/Result inbox；PostgreSQL 使用复合 tenant keys + FORCE RLS；MinIO 备份包含真实 object bytes。
4. Companion 成为唯一 UIA action broker，签发一次性 local permit；App 用 Job Object 管理；UIA COM 放入可终止重启的 child worker process。

这些修改扩展公开 contract 和部署/进程语义，但不改变既定的 Core、Runner、Provider、Adapter 分层，也不引入 Cloud、消息队列或 Windows VM。

修订落点：

| Finding | 已冻结的 Spec/Plan 落点 |
|---|---|
| T-01 | `runId` 单次尝试、单 Runner ownership、新 run recovery、单调时钟 action deadline、旧 identity 只补传 Trace |
| T-02 | mandatory mTLS、certificate-bound runnerId、single-use resume token、canonical Spool AEAD、应用层在途上限 |
| C-01 | scope-bound profile、RFC 8785 protected header/AAD、A256GCM/RSA-OAEP-256 精确参数 |
| C-02 | Trace/Graph/Screenshot/Log 的实际 bytes 进入 encrypted entries，offline test 删除本地源后还原 |
| C-03 | `remote_capsule | local_only` 显式联合，local-only 无 Manifest/upload row |
| C-04 | immutable rewrap revision、revoke-before-delete、失败保留 ciphertext、审计字段 |
| D-01 | RunnerPrincipal、单次 enrollment、CSR/SAN/fingerprint/scope、gRPC pre-payload authorization |
| D-02 | Worker PostgreSQL Job lease/Result Inbox，Server 独占 deterministic apply |
| D-03 | composite tenant keys/FKs、FORCE RLS、non-owner roles、transaction-local tenant context |
| D-04 | PostgreSQL + 全量 object bytes backup，空环境 clean restore 后逐对象 hash/size 校验 |
| D-05 | OIDC state/nonce/PKCE、memory token、CSP、Compose secret files、container limits、digest/SBOM |
| W-01 | Companion sole action broker、完整 IPC、一次性 action-bound LocalExecutionPermit |
| W-02 | Create-suspended + Job Object、PID creation-time/membership 校验、禁止按名称 kill |
| W-03 | hidden MTA UIA worker child、deadline kill/restart、Companion/deny latch 保持存活 |
| W-04 | logon-SID DACL、first-instance/local-only pipe、PID/token/session + certificate proof、uiAccess=false/locked/elevated/RDP fail closed |

## 7. 本轮直接修正

- LS-10 Plan 将不存在的 `profile.keyRef` 修正为 `kms.wrapDek(profile, dek)`。
- LS-11 Public API 权限表拆分 GET/POST，消除 viewer 是否可 mutation 的歧义。
- LS-13 Task 2 提交列表补入顶层 Rust tests。
- Windows M3 Checklist 更新为 LS-12/LS-13 上游设计。

## 8. 标准依据

- gRPC：[Deadlines](https://grpc.io/docs/guides/deadlines/)、[Cancellation](https://grpc.io/docs/guides/cancellation/)、[Flow Control](https://grpc.io/docs/guides/flow-control/)、[Authentication](https://grpc.io/docs/guides/auth/)
- Protobuf：[Proto3 compatibility/reserved fields](https://protobuf.dev/programming-guides/proto3/)
- Cryptography：[NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final)、[RFC 8017](https://www.rfc-editor.org/info/rfc8017/)、[RFC 7518](https://www.rfc-editor.org/info/rfc7518/)、[Node.js Crypto](https://nodejs.org/api/crypto.html)
- Identity：[OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)、[RFC 9700](https://www.rfc-editor.org/info/rfc9700)、[RFC 10017](https://www.rfc-editor.org/info/rfc10017)
- Data/deployment：[PostgreSQL Row Security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)、[Docker Compose Secrets](https://docs.docker.com/compose/how-tos/use-secrets/)、[S3 object integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html)
- Windows：[UIA threading](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)、[Named Pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)、[CreateNamedPipe flags](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[UIA security/UIPI](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)
