# [LS-13] M3 Windows Desktop Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run AppTarget tests on Windows 11 through UI Automation and a Rust Companion, preserve `uia/v1`, enforce local approvals/emergency stop, and complete the manual M3 release Gate.

**Architecture:** Rust Companion is the sole broker for Windows process lifecycle, UIA capture and UIA actions. Its main process owns user-scoped authenticated Named Pipe IPC, Job Objects, approvals and one-time local permits; cancellable UIA COM work runs in a restartable child worker. TypeScript only maps typed Companion DTOs to generic Runner ports/Graph v1. Core owns AppTarget configuration; Policy requires fail-closed local approval for interactive high-risk actions.

**Tech Stack:** TypeScript/Node.js 24, Rust stable, `windows` crate, Tokio Named Pipes/processes, serde plus RFC 8785 canonical JSON, .NET 10 WPF and Windows App SDK test fixtures, Vitest/Replay/manual checklist.

**Direct Dependencies:** LS-12.

## Global Constraints

- Windows 11 is the only native platform implemented in M3.
- No Windows VM interactive automation/Nightly/Release Gate is created.
- Service approval cannot replace local Companion approval.
- No desktop action executes without a fresh Companion-issued one-time `LocalExecutionPermit`; TypeScript has no direct UIA or target-process control path.
- A hung UIA call may terminate only the hidden UIA worker, never the Companion main process or approval/deny-latch state.
- UIA element handles never survive an Observation; every checkpoint re-resolves.
- All Rust and TypeScript tests stay outside `src/`. Configure Cargo `[[test]]` entries that point to top-level `tests/rust/companion/*.rs`; do not add inline `#[cfg(test)] mod tests` to production Rust files.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

### Task 1: Add AppTarget and desktop/IPC contracts

**Files:**

- Create: `packages/contracts/desktop/package.json`
- Create: `packages/contracts/desktop/tsconfig.json`
- Create: `packages/contracts/desktop/src/app-target.ts`
- Create: `packages/contracts/desktop/src/companion-ipc.ts`
- Create: `packages/contracts/desktop/src/uia-extension.ts`
- Create: `packages/contracts/desktop/src/index.ts`
- Create: `packages/core-modules/project-target/package.json`
- Create: `packages/core-modules/project-target/tsconfig.json`
- Create: `packages/core-modules/project-target/src/domain/app-target.ts`
- Test: `tests/unit/core-modules/project-target/app-target.test.ts`
- Test: `tests/contract/desktop/companion-ipc-schema.test.ts`

**Interfaces:** Exact `AppTarget`, `AppSession`, full `CompanionRequest` union, `LocalActionRisk`, `LocalPermitAuthorization`, `LocalPermitRequest`, `LocalApprovalDecision`, `LocalExecutionPermit`, `UiaPatternDescriptor`, `DesktopAdapterCapabilities`, `AdapterSupport` and `UiaExtensionV1`; strict versioned JSON schema for IPC. Runner `ExecutionRisk`/`ExecutionPermitDescriptor`, Sensor/Action ports and branded permit construction are added in Task 4, not this contracts package.

- [ ] **Step 1: Write config/IPC rejection tests**

Valid canonical executable/argv passes. Shell command string, broad kill image, missing reset deadline and non-Windows platform fail. Parse every handshake/session/app/UIA/permit/action discriminant. Reject unknown type, oversized declared frame, missing deadline, malformed certificate proof, expired Permit, Permit/action digest mismatch and ProductionForbidden approval with exact errors. Assert `AppSession` exposes only opaque `processGroupId`, PID and creation time—not a native Job handle.

```ts
expect(AppTarget.create(validTarget).platform).toBe("windows");
expect(() => AppTarget.create({ ...validTarget, launch: { command: "app.exe --flag" } })).toThrow("InvalidLaunchConfiguration");
expect(parseCompanionDecision(productionForbiddenApproval)).toMatchObject({ status: "denied" });
expect(() => parseCompanionRequest({ ...executeRequest, permit: undefined })).toThrow("LocalPermitInvalid");
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/core-modules/project-target/app-target.test.ts tests/contract/desktop/companion-ipc-schema.test.ts`

Expected: packages missing.

- [ ] **Step 3: Implement contracts and aggregate**

Use argv arrays, canonical absolute executable/workdir, explicit allowed child image list and versioned JSON IPC discriminants. Add exact maximum lengths/ranges for every string, list, frame and deadline. `ExecutionPermitDescriptor` binds policy decision/risk/action digest/TTL; `LocalExecutionPermit` additionally binds session/run/action/graph/nonce/issued/expiry. Aggregate changes use expectedVersion; never execute commands inside domain.

```ts
export class AppTargetAggregate {
  update(command: UpdateAppTargetCommand): AppTargetChanged {
    this.assertExpectedVersion(command.expectedVersion);
    return AppTargetChanged.from(validateAppTarget(command.target), this.version + 1);
  }
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 1 command; expect config/security/schema cases pass.

- [ ] **Step 5: Commit**

```text
git add packages/contracts/desktop packages/core-modules/project-target tests/unit/core-modules/project-target tests/contract/desktop
git commit -m "feat(desktop): define app target and companion contracts"
```

### Task 2: Build authenticated Companion IPC, one-time permits and emergency stop

**Files:**

- Create: `Cargo.toml`
- Create: `apps/companion/Cargo.toml`
- Create: `apps/companion/src/main.rs`
- Create: `apps/companion/src/ipc/mod.rs`
- Create: `apps/companion/src/ipc/server.rs`
- Create: `apps/companion/src/ipc/security.rs`
- Create: `apps/companion/src/permit.rs`
- Create: `apps/companion/src/approval.rs`
- Create: `apps/companion/src/emergency_stop.rs`
- Create: `apps/companion/src/tray.rs`
- Create: `tests/rust/companion/approval_state.rs`
- Create: `tests/rust/companion/emergency_stop.rs`
- Create: `tests/rust/companion/ipc_acl.rs`
- Create: `tests/rust/companion/ipc_limits.rs`
- Create: `tests/rust/companion/permit_binding.rs`
- Test: `tests/contract/desktop/companion-process.test.ts`

**Interfaces:** First-instance, local-only, logon-SID-scoped Named Pipe; process-token checks plus certificate challenge-response; bounded request/response types from Task 1; in-memory one-time Permit store.

- [ ] **Step 1: Write process contract and Rust state tests**

Start Companion test mode and complete a valid nonce-signature handshake. Reject remote client, wrong logon SID/session, unallowlisted image, invalid/expired certificate, wrong EKU/fingerprint/runnerId/signature and replayed challenge. Assert a second pipe server cannot claim the same name. Send partial/oversized/flooded frames and assert bounded failure.

Exercise approval approved/denied/timed_out, ProductionForbidden denied, IPC disconnect denied, pause and emergency-stop latches. Issue a Normal and an approved high-risk Permit; mutate each bound session/run/action/digest/graph/risk/nonce/TTL field independently, replay the token and assert no action dispatch. Emergency stop invalidates every pending Permit until a new Session.

```rust
let mut approvals = ApprovalState::new("run-1");
approvals.emergency_stop();
assert_eq!(approvals.decide(request()), Decision::EmergencyStopped);
assert!(handshake(wrong_fingerprint()).is_err());
let permit = permits.issue(original_action());
assert_eq!(permits.consume(&permit.token, changed_action()), Err(PermitError::BindingMismatch));
assert_eq!(permits.consume(&permit.token, original_action()), Ok(()));
assert_eq!(permits.consume(&permit.token, original_action()), Err(PermitError::AlreadyConsumed));
```

- [ ] **Step 2: Confirm RED**

Run: `cargo test --workspace && pnpm vitest run tests/contract/desktop/companion-process.test.ts`

Expected: Cargo workspace/process missing.

- [ ] **Step 3: Implement Companion**

Use Win32/Tokio Named Pipe with `FILE_FLAG_FIRST_PIPE_INSTANCE`, overlapped I/O, `PIPE_REJECT_REMOTE_CLIENTS` and an explicit DACL for current logon SID plus LocalSystem, denying network/anonymous. After accept, use `GetNamedPipeClientProcessId` and process-token APIs to validate user SID, interactive session, image and signature/allowlist. Then run a 256-bit nonce challenge whose exact `{protocolMajor,companionInstanceId,nonce,runnerId}` bytes are signed by the Runner certificate key; validate chain/expiry/client-auth EKU/fingerprint/runnerId before other messages.

Use a 32-bit length prefix with fixed maximum frame, queue, connection, concurrent-request and deadline limits. Deserialize into strict versioned serde DTOs. `PermitStore` computes the RFC 8785 action digest itself, generates a random 256-bit token, stores only its hash and binding in memory, and atomically marks it consumed before returning an action dispatch authorization. Tray shows run/target/pause/resume/stop only; approval deadline uses a monotonic timer; disconnect/emergency sets deny latch and cancels pending requests; redact summaries/logs. Set Windows manifest `uiAccess=false` and do not request elevation.

```rust
pub fn decide(&self, request: ApprovalRequest) -> ApprovalDecision {
    if self.emergency_stopped { return ApprovalDecision::EmergencyStopped; }
    if request.risk == Risk::ProductionForbidden { return ApprovalDecision::Denied; }
    self.prompt_with_deadline(request)
}
pub fn authorize_action(&mut self, permit: &LocalExecutionPermit, session: &Session, action: &ResolvedDesktopAction) -> Result<(), PermitError> {
    self.permits.consume_once(permit, session, action, self.clock.now())
}
```

- [ ] **Step 4: Confirm GREEN on Windows**

Run Task 2 command on Windows 11. Expected: Rust and process contract tests pass; all identity/frame/Permit negative cases fail before dispatch; no project-management screen or plaintext secret appears.

- [ ] **Step 5: Commit**

```text
git add Cargo.toml apps/companion tests/rust/companion tests/contract/desktop/companion-process.test.ts
git commit -m "feat(companion): enforce local desktop approvals"
```

### Task 3: Implement restartable UIA child worker and `uia/v1` capture

**Files:**

- Create: `apps/companion/src/uia/mod.rs`
- Create: `apps/companion/src/uia/protocol.rs`
- Create: `apps/companion/src/uia/worker.rs`
- Create: `apps/companion/src/uia/worker_supervisor.rs`
- Create: `apps/companion/src/uia/mapping.rs`
- Create: `packages/target-adapters/desktop-windows-uia/package.json`
- Create: `packages/target-adapters/desktop-windows-uia/tsconfig.json`
- Create: `packages/target-adapters/desktop-windows-uia/src/companion-client.ts`
- Create: `packages/target-adapters/desktop-windows-uia/src/windows-desktop-adapter.ts`
- Create: `packages/target-adapters/desktop-windows-uia/src/index.ts`
- Test: `tests/replay/windows-uia/uia-payload-mapping.test.ts`
- Test: `tests/conformance/observation/windows-uia.test.ts`
- Create: `tests/rust/companion/uia_worker_protocol.rs`
- Create: `tests/rust/companion/uia_worker_timeout.rs`

**Interfaces:** The same Companion binary accepts hidden `--uia-worker` mode. `UiaWorkerSupervisor.capture/execute` owns a bounded child-process protocol and returns lossless source/outcome DTOs; TS sees only Companion IPC and maps common fields plus exact `uia/v1` into Graph v1.

- [ ] **Step 1: Add golden UIA payloads**

Window/Button/Edit/Password/List/ListItem/Dialog with patterns/focus/offscreen/bounds/relations. Assert role/state/sensitivity mapping, raw source Artifact ref and all UIA-specific fields preserved; unknown minor field round-trips; unsupported major rejects action consumer. In Rust, use a fake child that replies, exits, emits oversized output or hangs. Assert a hang reaches its monotonic deadline, only that child is terminated, a replacement handles the next request, and Companion Session/approval/emergency-stop state remains unchanged.

```ts
const graph = mapUiaPayload(goldenPayload);
expect(node(graph, "password")).toMatchObject({ sensitivity: "secret", value: undefined });
expect(node(graph, "button").extensions["uia/v1"]).toMatchObject({ payload: { patterns: expect.any(Array) } });
```

```rust
assert_eq!(supervisor.capture(hanging_request()).await, Err(UiaError::TargetUnresponsive));
assert!(supervisor.capture(valid_request()).await.is_ok());
```

- [ ] **Step 2: Confirm RED**

Run: `cargo test --workspace && pnpm vitest run tests/replay/windows-uia/uia-payload-mapping.test.ts tests/conformance/observation/windows-uia.test.ts`

Expected: adapter/mapping missing.

- [ ] **Step 3: Implement bounded UIA capture**

Add a hidden `--uia-worker` entrypoint that initializes COM as MTA and owns all UIA objects on its worker threads. The main Companion launches it with an allowlisted same-binary path, a private bounded framed channel and a child-only Job Object. `UiaWorkerSupervisor` serializes requests, enforces a monotonic deadline, kills the worker Job on timeout/protocol corruption/exit and lazily starts a clean replacement; it never kills the main Companion or App Job. Capture root/subtree, Patterns and raw properties; mask password before returning. TS calls `companion.capture`, creates Graph nodes/relations/source/evidence/extension and validates Graph v1 before return; no TypeScript file imports `windows` or holds a UIA element.

```ts
const source = await companion.capture({ sessionId, deadlineMs });
const graph = mapUiaPayloadToObservationV1(source, { adapterId: "desktop-windows-uia" });
validateObservationGraphV1(graph);
return graph;
```

- [ ] **Step 4: Confirm GREEN**

Run Task 3 command on any platform for golden mapping; on Windows also `cargo test --workspace`. Expected: conformance and Rust protocol/timeout/restart tests pass without leaving worker processes.

- [ ] **Step 5: Commit**

```text
git add apps/companion packages/target-adapters/desktop-windows-uia tests/rust/companion tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts
git commit -m "feat(windows): capture uia observation graph v1"
```

### Task 4: Implement Job Object lifecycle and Companion-brokered UIA actions

**Files:**

- Create: `packages/target-adapters/desktop-windows-uia/src/app-environment-provider.ts`
- Create: `packages/target-adapters/desktop-windows-uia/src/uia-action-resolver.ts`
- Create: `packages/target-adapters/desktop-windows-uia/src/uia-action-executor.ts`
- Create: `apps/companion/src/process/mod.rs`
- Create: `apps/companion/src/process/job_object.rs`
- Create: `apps/companion/src/process/app_session.rs`
- Create: `apps/companion/src/uia/action.rs`
- Modify: `packages/runner-kernel/src/execution-runtime.ts`
- Modify: `packages/target-adapters/web-playwright/src/playwright-action-resolver.ts`
- Modify: `packages/target-adapters/web-playwright/src/playwright-action-executor.ts`
- Modify: `packages/contracts/runner-protocol/src/index.ts`
- Test: `tests/unit/target-adapters/desktop-windows-uia/app-environment-provider.test.ts`
- Test: `tests/replay/windows-uia/action-resolution.test.ts`
- Test: `tests/contract/desktop/companion-action.test.ts`
- Create: `tests/rust/companion/job_object_lifecycle.rs`
- Create: `tests/rust/companion/uia_action_timeout.rs`

**Interfaces:** Extend Runner action union with the exact click/input/select/scroll/window variants; replace the current resolved interface with the frozen `ResolvedWebAction | ResolvedDesktopAction` discriminated union; add `ExecutionRisk`/`ExecutionPermitDescriptor` plus the frozen `SensorAdapter`/`ActionAdapter` Runner ports. The Windows adapter explicitly maps `ExecutionPermitDescriptor` to the structurally equal `LocalPermitAuthorization` DTO. `DesktopEnvironmentProvider` and `UiaActionExecutor` are IPC clients only; Companion owns native `AppSessionState`, Job Object and action dispatch.

- [ ] **Step 1: Write lifecycle/action hierarchy tests**

Launch records exact PID creation time/window/opaque process group. Assert the process is created suspended, assigned to a kill-on-close Job, then resumed; declared children stay in the Job, an unexpected child is rejected, reset uses declared argv/deadline, and shutdown affects only verified Job members. Simulate PID reuse and same image name outside the Job; neither may be terminated. A packaged/protected process that cannot join the Job returns `AppLifecycleUnsupported`/Needs Human and never falls back to name-based kill.

Resolution is semantic→UIA selector→visual only if capability/policy→coordinate only explicit. Multi-candidate/unsupported Pattern/stale element return exact errors. Assert only an allowed Policy decision can construct the branded Core Permit and its descriptor binds the RFC 8785 action digest/risk/policy/decision/TTL. TypeScript cannot execute without requesting a local Permit; missing/mutated/expired descriptor, permit/action binding and replay fail before the worker; pause/stop/emergency blocks; UIA action timeout returns `ActionOutcomeUnknown`, restarts the worker and is never retried automatically. Locked desktop, elevated target and another interactive/RDP session return stable access errors.

```ts
const session = await environment.launch(target);
expect(session.processId).toBe(targetProcess.pid);
await expect(resolver.resolve(ambiguousProposal, graph)).rejects.toMatchObject({ code: "PlanDiverged" });
expect(windowsExecutor.supports(webResolvedClick)).toBe(false);
await expect(companion.execute(desktopAction, replayedPermit)).rejects.toMatchObject({ code: "LocalPermitConsumed" });
expect(await processInspector.isRunning(unrelatedSameNamePid)).toBe(true);
```

- [ ] **Step 2: Confirm RED**

Run: `cargo test --workspace && pnpm vitest run tests/unit/target-adapters/desktop-windows-uia/app-environment-provider.test.ts tests/replay/windows-uia/action-resolution.test.ts tests/contract/desktop/companion-action.test.ts`

Expected: lifecycle/action union missing.

- [ ] **Step 3: Implement action extension safely**

Add discriminated action payloads and trace mappers exhaustively. Add `targetKind:"web"` to every existing Playwright resolved action and narrow both executors on `targetKind`. `AppEnvironmentProvider` sends `app.launch/reset/shutdown` requests; it never calls Node process APIs for the target. Companion canonicalizes paths, calls `CreateProcessW` with argv and `CREATE_SUSPENDED`, assigns the process to a Job configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, records PID creation time/image, then resumes it. Monitor Job notifications and reject children outside `allowedChildImageNames`; shutdown/reset operate by stored Job membership and identity, never by broad process-name lookup.

Reobserve/re-resolve each desktop step. Extend allowed `PolicyDecision` and the private-constructor/branded `ExecutionPermit` with `ExecutionPermitDescriptor`, computed from the resolved action by the policy gate. `UiaActionExecutor` extracts that descriptor, sends the full action/authorization to `permit.request`, then sends `action.execute` with the returned token. Companion recomputes and compares the action digest, atomically consumes the local Permit and delegates Invoke/Value/Selection/Scroll/Window to `UiaWorkerSupervisor`; TS never invokes UIA. Fallback occurs only per capabilities/policy. Timeout kills/restarts only the child worker and returns `ActionOutcomeUnknown`; no automatic replay. Target process exit emits a deterministic crash Finding signal.

```ts
export type ResolvedAction = ResolvedWebAction | ResolvedDesktopAction;

if (action.targetKind !== "desktop") return unsupportedTarget(action.targetKind);
const graph = await sensor.capture(action.sessionId);
const resolved = await resolver.reresolve(action, graph);
const local = await companion.requestPermit({ sessionId, runId, action: resolved, authorization: executionPermit.descriptor, safeSummary, expiresAt });
return companion.execute({ sessionId, action: resolved, permit: local, deadlineMs });
```

- [ ] **Step 4: Confirm GREEN**

Run `cargo test --workspace` plus the Task 4 command and existing Web Runner tests; expect Job/PID/Permit/timeout cases, new actions and replay pass while M1 click behavior remains.

- [ ] **Step 5: Commit**

```text
git add apps/companion packages/target-adapters/desktop-windows-uia packages/runner-kernel packages/contracts/runner-protocol tests/rust/companion tests/unit/target-adapters/desktop-windows-uia tests/replay/windows-uia/action-resolution.test.ts tests/contract/desktop/companion-action.test.ts
git commit -m "feat(windows): manage app lifecycle and uia actions"
```

### Task 5: Add Reference Apps and deterministic Windows tests

**Files:**

- Create: `tests/fixtures/windows-reference-wpf/WindowsReferenceWpf.csproj`
- Create: `tests/fixtures/windows-reference-wpf/App.xaml`
- Create: `tests/fixtures/windows-reference-wpf/App.xaml.cs`
- Create: `tests/fixtures/windows-reference-wpf/MainWindow.xaml`
- Create: `tests/fixtures/windows-reference-wpf/MainWindow.xaml.cs`
- Create: `tests/fixtures/windows-reference-winui/WindowsReferenceWinUi.csproj`
- Create: `tests/fixtures/windows-reference-winui/Package.appxmanifest`
- Create: `tests/fixtures/windows-reference-winui/App.xaml`
- Create: `tests/fixtures/windows-reference-winui/App.xaml.cs`
- Create: `tests/fixtures/windows-reference-winui/MainWindow.xaml`
- Create: `tests/fixtures/windows-reference-winui/MainWindow.xaml.cs`
- Create: `tests/component/windows-uia/reference-app.test.ts`
- Create: `tests/component/windows-uia/local-approval.test.ts`
- Modify: `docs/testing/windows-m3-manual-checklist.md`

**Interfaces:** Each Reference App exposes reset fixture data and controls required by Checklist, including crash and simulated high-risk action. The integration harness talks only to the public Companion IPC and records permit/action/worker/process evidence.

- [ ] **Step 1: Write fixture manifest/compile tests**

Assert both projects compile; fixture manifest lists Button/Edit/Combo/List/Scroll/Dialog/Crash/Reset/high-risk; no network/admin requirement. Component test runs only on explicit Windows integration flag, not normal cross-platform CI. In enabled mode, assert every actual action has exactly one consumed local Permit, stop/deny/timeout causes zero UIA dispatch, forced UIA-worker hang restarts the worker while tray/App remain alive, and a same-name unrelated process remains untouched after shutdown.

```ts
expect(await dotnetBuild(wpfProject)).toMatchObject({ exitCode: 0 });
expect(await dotnetBuild(winuiProject)).toMatchObject({ exitCode: 0 });
expect(referenceFixtureCapabilities()).toEqual(expect.arrayContaining(["Button", "Edit", "Dialog", "Crash", "Reset"]));
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/component/windows-uia/reference-app.test.ts tests/component/windows-uia/local-approval.test.ts`

Expected: fixtures/tests missing or skipped until explicit Windows flag.

- [ ] **Step 3: Implement fixtures and controlled integration**

WPF uses .NET 10 standard controls; WinUI uses Windows App SDK controls; both use local JSON state reset and fake high-risk action. Tests exercise capture/click/input/select/scroll/dialog/crash, approval allow/deny/timeout/stop, one-time Permit consumption, worker hang/restart and Job Object isolation with generated evidence paths. Elevated/locked/RDP cases remain explicit manual checks because the normal fixture never asks for elevation or changes desktop/session state.

```ts
if (process.env.QUALIGENCE_WINDOWS_UIA_TEST !== "true") {
  return skipWindowsIntegration("set QUALIGENCE_WINDOWS_UIA_TEST=true on Windows 11");
}
await referenceApp.reset();
await expect(runDesktopScenario(referenceApp.target())).resolves.toMatchObject({ status: "passed" });
```

- [ ] **Step 4: Confirm GREEN in both modes**

Normal CI command returns explicit skip with reason; on Windows 11 with `QUALIGENCE_WINDOWS_UIA_TEST=true`, both component files pass and reset leaves clean state.

- [ ] **Step 5: Commit**

```text
git add tests/fixtures/windows-reference-wpf tests/fixtures/windows-reference-winui tests/component/windows-uia docs/testing/windows-m3-manual-checklist.md
git commit -m "test(windows): add controlled uia reference apps"
```

### Task 6: Freeze Graph v1 and execute manual M3 release Gate

**Files:**

- Create: `artifacts/manual-acceptance/<product-version>/<date>-windows-m3.md` (release evidence, not committed if repository policy excludes artifacts)
- Modify: `docs/testing/observation-graph-v1-freeze-checklist.md`
- Modify: `docs/superpowers/implementation-status.md`
- Modify: `README.md`

**Interfaces:** Adds no runtime API; produces the versioned manual acceptance record and changes Observation Graph v1 status from `candidate` to `frozen` only when every automatic, migration and human-review prerequisite is evidenced.

- [ ] **Step 1: Run automatic Gate freshly**

```text
pnpm build
pnpm test
pnpm typecheck
pnpm smoke:node-imports
cargo test --workspace
pnpm vitest run tests/conformance/observation tests/replay/windows-uia tests/migration/observation-v1
git diff --check
```

Expected: all commands exit 0. This proves logic/protocol/replay/compile, not real interactive UI.

- [ ] **Step 2: Run explicit Windows integration**

Run on supported Windows 11 PowerShell:

```powershell
$env:QUALIGENCE_WINDOWS_UIA_TEST = "true"
pnpm vitest run tests/component/windows-uia
Remove-Item Env:QUALIGENCE_WINDOWS_UIA_TEST
```

Expected: WPF and WinUI controlled components pass with reset evidence.

- [ ] **Step 3: Execute the full manual Checklist**

Copy `docs/testing/windows-m3-manual-checklist.md` to the versioned evidence path. Fill every environment field; mark every item `[x]`, `[!]` or `[-]` with reason; link Run/Trace/Artifact/Issue; both executor and reviewer sign. In addition to the reference scenarios, execute the Named Pipe wrong-user/remote/spoof proof, Permit binding/replay, pause/stop/deny latch, locked desktop, elevated target, local-console versus RDP behavior, UIA worker hang/restart, unrelated same-name process/PID-reuse safety and Companion `uiAccess=false` checks. Any Section 16 failure blocks release.

```powershell
$evidencePath = "artifacts/manual-acceptance/$env:QUALIGENCE_VERSION/$(Get-Date -Format yyyy-MM-dd)-windows-m3.md"
New-Item -ItemType Directory -Force (Split-Path $evidencePath) | Out-Null
Copy-Item -LiteralPath docs/testing/windows-m3-manual-checklist.md -Destination $evidencePath
```

- [ ] **Step 4: Freeze v1 only after evidence review**

Update Freeze checklist from candidate to frozen only if automatic Gate, controlled Windows integration, pre-v1 migration report and manual checklist all satisfy their exits. Otherwise keep candidate and record the exact blocking item; do not change Schema version.

- [ ] **Step 5: Commit product docs/status after a passing Gate**

```text
git add docs/testing/observation-graph-v1-freeze-checklist.md docs/superpowers/implementation-status.md README.md
git commit -m "feat(windows): complete m3 desktop abstraction gate"
```

## Plan Self-Review

- Spec coverage: contracts/AppTarget, authenticated bounded Named Pipe, one-time Permit/approvals/stop, restartable UIA child capture/action, Job Object lifecycle, two Reference Apps, automatic/manual/freeze Gate map to Tasks 1–6.
- Placeholder scan: platform, tools, controls, actions, error oracles and commands are explicit.
- Type consistency: Rust Companion owns native lifecycle/UIA and emits DTOs → desktop contracts → Windows Adapter → Graph/Runner ports; Core remains platform-neutral and TypeScript never becomes an alternate UIA broker.
