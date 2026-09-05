# 人工发布验收指南

本指南配合 GitHub Issue [#181](https://github.com/ljie-PI/Qualigence/issues/181)
使用，面向实际执行验收的人。它尽量用用户视角描述“要确认什么”和“怎么一步步做”，而不是要求你先理解项目内部术语。

目标很简单：选定一个准备发布的代码版本，在真实环境里确认主要功能、安全边界、真实 AI 服务、发布包和最终结论文件都可信。只要有任何一步失败，就不要宣布发布完成；记录失败原因，修复后重新选择或重新验证受影响的版本。

## 验收前先记住三条规则

1. **只验一个固定版本。** 开始前先选定一个完整 commit SHA 和 release version。后续所有命令、截图、日志、签字和发布文件都必须对应这个版本。
2. **不要泄露密钥或用户数据。** API key、证书私钥、密码、客户数据、原始敏感日志都不能贴到 issue、PR、终端输出截图或提交文件里。Issue 里只记录脱敏后的说明、文件路径、hash、运行链接和结论。
3. **失败就是失败。** 缺机器、缺凭据、网络失败、测试跳过、人工未签字，都不能写成通过。它们只能记录为阻塞项。

## 一次完整验收要做什么

### 1. 选定要验收的版本

先确定两个值，并在 #181 里记录：

```bash
export CANDIDATE_SHA="<40-character-git-commit>"
export RELEASE_VERSION="<version-or-rc-name>"
```

这两个变量只是本指南里的占位写法；项目脚本不会自动读取它们。后面运行命令或填写 GitHub Actions 表单时，把它们替换成同一个值。

确认点：

- [ ] `CANDIDATE_SHA` 是完整 40 位 commit，不是分支名或短 SHA。
- [ ] `RELEASE_VERSION` 本次只使用一次，不复用已有 release 目录。
- [ ] 后续所有证据都写明同一个 commit 和 version。

### 2. 确认自动化检查已经跑过

在 GitHub 上找到这个 commit 对应的检查结果，确认这些检查都通过，且没有被静默跳过：

- `gate-linux`
- `gate-windows-rust`
- `gate-self-hosted`
- `browser-e2e`

如果你在本机或 CI 环境里补跑，可以使用：

```bash
corepack pnpm gate:fast
corepack pnpm gate:self-hosted
```

确认点：

- [ ] 每个检查都对应同一个 `CANDIDATE_SHA`。
- [ ] 每个检查都有可下载或可引用的结果文件。
- [ ] 如果检查失败或缺少运行环境，在 #181 记录失败原因，不要继续当作通过。

### 3. 在真实 Windows 11 桌面上验证桌面操作

这一步确认：程序能在真实 Windows 11 桌面上操作测试应用，并且不会绕过用户确认、误杀无关进程、泄露敏感输入，或在结果不确定时自动重试危险操作。

使用非生产 Windows 11 机器或虚拟机。不要用真实办公桌面或含真实用户数据的环境。

先构建 Windows 桌面验证工具：

```powershell
cargo build --workspace
```

然后运行自动化桌面验证入口：

```powershell
$env:QUALIGENCE_WINDOWS_UIA_TEST = "true"
$env:QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS = "<repo>\target\debug\companion-daemon-harness.exe"
corepack pnpm vitest run tests/e2e/windows/companion-daemon.test.ts
```

如果需要指定验证结果保存目录，可以加：

```powershell
$env:QUALIGENCE_WINDOWS_UIA_HARNESS_EVIDENCE_DIR = "<path-to-empty-evidence-dir>"
```

执行后，复制并填写完整人工清单：

```text
docs/testing/windows-m3-manual-checklist.md
```

建议保存为：

```text
artifacts/manual-acceptance/<RELEASE_VERSION>/<date>-windows-m3.md
```

确认点：

- [ ] 使用真实 Windows 11。
- [ ] 使用两个测试应用：一个 WPF 或 Win32，一个 WinUI 或现代 Windows 应用。
- [ ] 验证启动、识别界面、点击、输入、选择、滚动、重置和关闭。
- [ ] 验证本地用户拒绝、超时、暂停、继续和紧急停止。
- [ ] 验证程序不会操作错误窗口、错误用户、远程连接或无关进程。
- [ ] 验证密码、token 和敏感内容不会出现在普通日志里。
- [ ] 验证本地桌面场景和要求的 RDP 场景；如果某个 RDP 场景按策略不支持，必须记录它被明确拒绝，而不是跳过。

### 4. 两个人检查并签署 Windows 记录

完成 Windows 清单后，需要两个人：

- 执行人：实际跑验证的人。
- 复核人：独立检查记录和证据的人，不能和执行人是同一个人。

他们需要确认清单里每个安全否决项都是通过。以下任意一项失败，都不能发布：

- 没有授权、授权被篡改、授权已用过或过期时，不能执行动作。
- 高风险或破坏性动作必须要求本地确认，不能偷偷执行。
- 紧急停止后不能继续执行新动作。
- 密码、token 和敏感证据不能进入普通日志。
- 桌面操作必须经过本地桌面验证程序，不能被后台代码绕过。
- 本地通信只能接受正确用户、正确程序和正确证书。
- 桌面操作卡住时，不能拖死整个程序，也不能自动重放危险动作。
- 关闭或重置应用时，不能误杀同名但无关的进程。
- 运行记录冲突、未签名脚本、高置信崩溃或数据损坏都不能被静默忽略。

签署后计算文件 hash：

```powershell
Get-FileHash -Algorithm SHA256 "artifacts/manual-acceptance/<RELEASE_VERSION>/<date>-windows-m3.md"
```

在 #181 里只记录：

- 文件路径
- SHA-256
- 执行人和复核人
- 签字记录 hash
- 关键运行链接或证据引用

不要把敏感日志或原始证据内容贴进 issue。

### 5. 用真实 AI 服务验证模型调用

这一步确认：连接真实 AI 服务时，程序能正常调用模型、保存必要证据，并且不会泄露 API key。

只在人工控制的环境里设置凭据。不要把 API key 写进命令历史、配置文件、issue 或提交。

需要准备：

```bash
export QUALIGENCE_REFERENCE_MODEL_BASE_URL="<model-service-base-url>"
export QUALIGENCE_REFERENCE_MODEL_API_KEY="<secret-api-key>"
export QUALIGENCE_LIVE_MODEL_SMOKE=true
export QUALIGENCE_MODEL_BASE_URL="<model-service-base-url>"
export QUALIGENCE_MODEL_API_KEY="<secret-api-key>"
export QUALIGENCE_MODEL_NAME="<model-name>"
export QUALIGENCE_DATA_DIR="<local-output-dir>"
```

运行：

```bash
CI=true corepack pnpm vitest run tests/e2e/detection-benchmark/reference-model-profile.test.ts
CI=true QUALIGENCE_LIVE_MODEL_SMOKE=true corepack pnpm vitest run tests/live/remote-model-smoke.test.ts
```

确认点：

- [ ] 使用的是真实 AI 服务，不是 fixture 或 mock。
- [ ] 测试报告显示模型调用成功，且结果可解析。
- [ ] API key 不出现在 stdout、stderr、保存的摘要、artifact 或本地文件里。
- [ ] 记录服务名称、模型名称、调用次数、报告 hash 和证据位置；不要记录 API key。

### 6. 生成不可变发布文件

这一步确认：发布用的镜像、清单和证明文件都绑定同一个 commit，之后不能被分支名或 mutable tag 偷换。

在 GitHub Actions 里手动运行 release workflow：

```text
.github/workflows/release.yml
```

表单字段按本次验收填写：

| 字段 | 用用户角度理解 |
|---|---|
| `version` | 本次要发布或候选发布的版本名，例如 `v0.1.0-rc.1` |
| `commit` | 本次验收选定的完整 commit SHA |
| `windows_evidence_path` | 第 4 步签字后的 Windows 验收记录路径 |
| `windows_evidence_sha256` | 该 Windows 验收记录文件的 SHA-256 |
| `windows_evidence_operator` | 执行人名字 |
| `windows_evidence_operator_signature_sha256` | 执行人签字记录的 SHA-256 |
| `windows_evidence_reviewer` | 复核人名字 |
| `windows_evidence_reviewer_signature_sha256` | 复核人签字记录的 SHA-256 |

workflow 成功后应产生：

- `artifacts/release/<RELEASE_VERSION>/release-manifest.json`
- `artifacts/release/<RELEASE_VERSION>/sbom.spdx.json`
- 四个自动化检查的压缩包证据
- 镜像 digest
- provenance / attestation 链接或文件

### 7. 复核发布清单

如果在本地复核发布清单，设置：

```bash
export GH_TOKEN="<github-token-that-can-read-actions-artifacts>"
export GITHUB_REPOSITORY="ljie-PI/Qualigence"
export QUALIGENCE_VERIFY_ATTESTATIONS=true
```

运行：

```bash
corepack pnpm gate:release -- \
  --manifest artifacts/release/<RELEASE_VERSION>/release-manifest.json \
  --repository ljie-PI/Qualigence \
  --commit <CANDIDATE_SHA> \
  --render-compose artifacts/release/<RELEASE_VERSION>/compose.release.rendered.yaml
```

确认点：

- [ ] 清单里的 commit 等于 `CANDIDATE_SHA`。
- [ ] 镜像用 `name@sha256:<digest>`，不是 `latest` 或其他可变 tag。
- [ ] 自动化检查证据、Windows 签字记录、SBOM 和 attestation 的 hash 都能重算匹配。
- [ ] 生成的 Compose 文件只使用 digest，不使用 mutable tag。

### 8. 生成最终结论文件

最后运行已合并的最终检查器，让它读取前面所有证据并生成：

```text
artifacts/release/<RELEASE_VERSION>/graph-freeze-decision.json
```

你只需要按结果处理：

- 如果结果是 `frozen`：说明所有必需证据都通过并绑定同一个 commit/version，可以在 #181 记录最终通过。
- 如果结果是 `candidate`：说明还有缺失或失败项。把 JSON 中列出的 blockers 复制成简短中文说明，记录在 #181；不要宣布发布完成。

确认点：

- [ ] 最终结论文件是脚本生成的，不是人工手写。
- [ ] 文件 hash 已记录。
- [ ] 结果和 README/checklist 中的公开状态一致。

## 环境变量说明

| 变量 | 什么时候用 | 用户角度含义 | 是否敏感 |
|---|---|---|---|
| `QUALIGENCE_WINDOWS_UIA_TEST` | Windows 桌面验证 | 明确告诉测试：我正在真实 Windows 11 桌面上运行，允许执行桌面验证 | 否 |
| `QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS` | Windows 桌面验证 | 指向桌面验证工具 exe 的完整路径 | 否 |
| `QUALIGENCE_WINDOWS_UIA_HARNESS_EVIDENCE_DIR` | Windows 桌面验证，可选 | 验证工具把结果文件写到哪里 | 否 |
| `QUALIGENCE_COMPANION_DAEMON` | Windows 桌面验证，可选 | 如果默认找不到桌面助手程序，用这个指定 exe 路径 | 否 |
| `QUALIGENCE_REFERENCE_MODEL_BASE_URL` | 真实 AI benchmark | AI 服务的 API 地址 | 否，但不要贴内部地址到公开 issue |
| `QUALIGENCE_REFERENCE_MODEL_API_KEY` | 真实 AI benchmark | 调用 AI 服务的密钥 | 是 |
| `QUALIGENCE_LIVE_MODEL_SMOKE` | 真实 AI smoke test | 设置为 `true` 才会真的调用外部 AI 服务 | 否 |
| `QUALIGENCE_MODEL_BASE_URL` | 真实 AI smoke test | AI 服务的 API 地址；通常和 `QUALIGENCE_REFERENCE_MODEL_BASE_URL` 相同 | 否，但不要公开内部地址 |
| `QUALIGENCE_MODEL_API_KEY` | 真实 AI smoke test | 调用 AI 服务的密钥；也兼容部分旧命令 | 是 |
| `QUALIGENCE_MODEL_NAME` | 真实 AI smoke test | 要测试的模型名字，例如某个供应商模型 ID | 否 |
| `QUALIGENCE_DATA_DIR` | 真实 AI smoke test | 本次运行保存本地数据和报告的位置 | 否 |
| `GH_TOKEN` | 发布清单复核 | 读取 GitHub Actions artifact 或调用 GitHub API 的 token | 是 |
| `GITHUB_REPOSITORY` | 发布清单复核 | 仓库名，本项目固定为 `ljie-PI/Qualigence` | 否 |
| `QUALIGENCE_VERIFY_ATTESTATIONS` | 发布清单复核 | 设置为 `true` 时，要求检查镜像和 SBOM 的证明材料 | 否 |

## #181 里应该记录什么

记录这些即可：

- 选定的 commit SHA 和 release version。
- 自动化检查的运行链接、artifact 名称和 hash。
- Windows 签字记录路径、SHA-256、执行人、复核人和签字记录 hash。
- 真实 AI 服务测试的脱敏环境说明、模型名字、调用次数、报告 hash。
- release workflow URL、镜像 digest、SBOM hash、attestation 链接、release manifest hash。
- 最终结论文件路径、SHA-256 和结果：`candidate` 或 `frozen`。

不要记录这些：

- API key、证书私钥、密码、token。
- 原始客户数据。
- 原始敏感日志或截图。
- 任何没有 hash 或无法追溯到选定 commit 的“口头通过”结论。
