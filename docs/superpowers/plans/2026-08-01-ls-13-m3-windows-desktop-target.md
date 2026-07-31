# [LS-13] M3 Windows Desktop Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run AppTarget tests on Windows 11 through UI Automation and a Rust Companion, preserve `uia/v1`, enforce local approvals/emergency stop, and complete the manual M3 release Gate.

**Architecture:** Rust Companion owns Windows UIA/session UI and exposes user-scoped Named Pipe JSON messages. TypeScript Windows Adapter maps Companion DTOs to generic Runner ports/Graph v1. Core owns AppTarget configuration; Policy requires fail-closed local approval for interactive high-risk actions.

**Tech Stack:** TypeScript/Node.js 24, Rust stable, `windows` crate, Tokio Named Pipes, serde, .NET 10 WPF and Windows App SDK test fixtures, Vitest/Replay/manual checklist.

**Direct Dependencies:** LS-12.

## Global Constraints

- Windows 11 is the only native platform implemented in M3.
- No Windows VM interactive automation/Nightly/Release Gate is created.
- Service approval cannot replace local Companion approval.
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

**Interfaces:** Exact `AppTarget`, `AppSession`, Companion Request/Decision, `UiaPatternDescriptor`, `DesktopAdapterCapabilities`, `AdapterSupport` and `UiaExtensionV1`; strict JSON schema for IPC. Runner Sensor/Action ports are added in Task 4, not this contracts package.

- [ ] **Step 1: Write config/IPC rejection tests**

Valid canonical executable/argv passes. Shell command string, broad kill image, missing reset deadline, non-Windows platform fail. Companion unknown message/expired approval/ProductionForbidden approval returns exact error.

```ts
expect(AppTarget.create(validTarget).platform).toBe("windows");
expect(() => AppTarget.create({ ...validTarget, launch: { command: "app.exe --flag" } })).toThrow("InvalidLaunchConfiguration");
expect(parseCompanionDecision(productionForbiddenApproval)).toMatchObject({ status: "denied" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/core-modules/project-target/app-target.test.ts tests/contract/desktop/companion-ipc-schema.test.ts`

Expected: packages missing.

- [ ] **Step 3: Implement contracts and aggregate**

Use argv arrays, canonical absolute executable/workdir, explicit allowed child image list and versioned JSON IPC discriminants. Aggregate changes use expectedVersion; never execute commands inside domain.

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

### Task 2: Build Rust Companion IPC, approvals and emergency stop

**Files:**

- Create: `Cargo.toml`
- Create: `apps/companion/Cargo.toml`
- Create: `apps/companion/src/main.rs`
- Create: `apps/companion/src/ipc.rs`
- Create: `apps/companion/src/approval.rs`
- Create: `apps/companion/src/emergency_stop.rs`
- Create: `apps/companion/src/tray.rs`
- Create: `tests/rust/companion/approval_state.rs`
- Create: `tests/rust/companion/emergency_stop.rs`
- Create: `tests/rust/companion/ipc_acl.rs`
- Test: `tests/contract/desktop/companion-process.test.ts`

**Interfaces:** User-SID-scoped Named Pipe; handshake version/nonce/cert fingerprint; request/decision types from Task 1 serialized exactly.

- [ ] **Step 1: Write process contract and Rust state tests**

Start Companion test mode, valid handshake, approval approved/denied/timed_out, ProductionForbidden denied, IPC disconnect denied, emergency stop latches and blocks later approval until new session. Wrong user/fingerprint rejected.

```rust
let mut approvals = ApprovalState::new("run-1");
approvals.emergency_stop();
assert_eq!(approvals.decide(request()), Decision::EmergencyStopped);
assert!(handshake(wrong_fingerprint()).is_err());
```

- [ ] **Step 2: Confirm RED**

Run: `cargo test --workspace && pnpm vitest run tests/contract/desktop/companion-process.test.ts`

Expected: Cargo workspace/process missing.

- [ ] **Step 3: Implement Companion**

Use Tokio Windows named pipe ACL for current SID/Runner identity; serde strict DTO; tray shows run/target/pause/resume/stop only; approval deadline uses monotonic timer; disconnect/emergency sets deny latch; redact summaries/logs.

```rust
pub fn decide(&self, request: ApprovalRequest) -> ApprovalDecision {
    if self.emergency_stopped { return ApprovalDecision::EmergencyStopped; }
    if request.risk == Risk::ProductionForbidden { return ApprovalDecision::Denied; }
    self.prompt_with_deadline(request)
}
```

- [ ] **Step 4: Confirm GREEN on Windows**

Run Task 2 command on Windows 11. Expected: Rust and process contract tests pass; no project-management screen or plaintext secret appears.

- [ ] **Step 5: Commit**

```text
git add Cargo.toml apps/companion tests/contract/desktop/companion-process.test.ts
git commit -m "feat(companion): enforce local desktop approvals"
```

### Task 3: Implement UIA service and `uia/v1` capture

**Files:**

- Create: `apps/companion/src/uia/mod.rs`
- Create: `apps/companion/src/uia/service.rs`
- Create: `apps/companion/src/uia/mapping.rs`
- Create: `packages/target-adapters/desktop-windows-uia/package.json`
- Create: `packages/target-adapters/desktop-windows-uia/tsconfig.json`
- Create: `packages/target-adapters/desktop-windows-uia/src/companion-client.ts`
- Create: `packages/target-adapters/desktop-windows-uia/src/windows-desktop-adapter.ts`
- Create: `packages/target-adapters/desktop-windows-uia/src/index.ts`
- Test: `tests/replay/windows-uia/uia-payload-mapping.test.ts`
- Test: `tests/conformance/observation/windows-uia.test.ts`

**Interfaces:** Rust returns lossless UIA source DTO; TS maps common fields plus exact `uia/v1` extension into Graph v1.

- [ ] **Step 1: Add golden UIA payloads**

Window/Button/Edit/Password/List/ListItem/Dialog with patterns/focus/offscreen/bounds/relations. Assert role/state/sensitivity mapping, raw source Artifact ref and all UIA-specific fields preserved; unknown minor field round-trips; unsupported major rejects action consumer.

```ts
const graph = mapUiaPayload(goldenPayload);
expect(node(graph, "password")).toMatchObject({ sensitivity: "secret", value: undefined });
expect(node(graph, "button").extensions["uia/v1"]).toMatchObject({ payload: { patterns: expect.any(Array) } });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/replay/windows-uia/uia-payload-mapping.test.ts tests/conformance/observation/windows-uia.test.ts`

Expected: adapter/mapping missing.

- [ ] **Step 3: Implement bounded UIA capture**

Use Windows UI Automation COM through `windows` crate on a dedicated apartment/thread with deadline. Capture root/subtree, Patterns and raw properties; mask password; TS creates Graph nodes/relations/source/evidence/extension and validates Graph v1 before return.

```ts
const source = await companion.capture({ sessionId, root, deadlineMs });
const graph = mapUiaPayloadToObservationV1(source, { adapterId: "desktop-windows-uia" });
validateObservationGraphV1(graph);
return graph;
```

- [ ] **Step 4: Confirm GREEN**

Run Task 3 command on any platform for golden mapping; on Windows also `cargo test --workspace`. Expected: conformance and Rust parser/mapping pass.

- [ ] **Step 5: Commit**

```text
git add apps/companion packages/target-adapters/desktop-windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts
git commit -m "feat(windows): capture uia observation graph v1"
```

### Task 4: Implement App lifecycle and UIA actions

**Files:**

- Create: `packages/target-adapters/desktop-windows-uia/src/app-environment-provider.ts`
- Create: `packages/target-adapters/desktop-windows-uia/src/uia-action-resolver.ts`
- Create: `packages/target-adapters/desktop-windows-uia/src/uia-action-executor.ts`
- Modify: `packages/runner-kernel/src/execution-runtime.ts`
- Modify: `packages/target-adapters/web-playwright/src/playwright-action-resolver.ts`
- Modify: `packages/target-adapters/web-playwright/src/playwright-action-executor.ts`
- Modify: `packages/contracts/runner-protocol/src/index.ts`
- Test: `tests/unit/target-adapters/desktop-windows-uia/app-environment-provider.test.ts`
- Test: `tests/replay/windows-uia/action-resolution.test.ts`

**Interfaces:** Extend Runner action union with the exact click/input/select/scroll/window variants; replace the current resolved interface with the frozen `ResolvedWebAction | ResolvedDesktopAction` discriminated union; add the frozen `SensorAdapter`/`ActionAdapter` Runner ports; implement `DesktopEnvironmentProvider` and Windows adapters.

- [ ] **Step 1: Write lifecycle/action hierarchy tests**

Launch records exact PID/window; reset uses declared argv/deadline; shutdown terminates only PID/allowed child. Resolution semantic→UIA selector→visual only if capability/policy→coordinate only explicit. Multi-candidate/unsupported Pattern/stale element/timeout return exact errors; no action after emergency stop.

```ts
const session = await environment.launch(target);
expect(session.processId).toBe(targetProcess.pid);
await expect(resolver.resolve(ambiguousProposal, graph)).rejects.toMatchObject({ code: "PlanDiverged" });
expect(windowsExecutor.supports(webResolvedClick)).toBe(false);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/target-adapters/desktop-windows-uia/app-environment-provider.test.ts tests/replay/windows-uia/action-resolution.test.ts`

Expected: lifecycle/action union missing.

- [ ] **Step 3: Implement action extension safely**

Add discriminated action payloads and trace mappers exhaustively. Add `targetKind:"web"` to every existing Playwright resolved action and narrow both executors on `targetKind`. Reobserve/re-resolve each desktop step; use Invoke/Value/Selection/Scroll Patterns; fallback only per capabilities/policy; deadline UIA calls; return deterministic crash Finding signal on target process exit.

```ts
export type ResolvedAction = ResolvedWebAction | ResolvedDesktopAction;

if (action.targetKind !== "desktop") return unsupportedTarget(action.targetKind);
const graph = await sensor.capture(action.sessionId);
return executeUiaPattern(await resolver.reresolve(action, graph), signal);
```

- [ ] **Step 4: Confirm GREEN**

Run Task 4 command plus existing Web Runner tests; expect new actions/replay pass and click M1 behavior remains.

- [ ] **Step 5: Commit**

```text
git add packages/target-adapters/desktop-windows-uia packages/runner-kernel packages/contracts/runner-protocol tests/unit/target-adapters/desktop-windows-uia tests/replay/windows-uia/action-resolution.test.ts
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

**Interfaces:** Each Reference App exposes reset fixture data and controls required by Checklist, including crash and simulated high-risk action.

- [ ] **Step 1: Write fixture manifest/compile tests**

Assert both projects compile; fixture manifest lists Button/Edit/Combo/List/Scroll/Dialog/Crash/Reset/high-risk; no network/admin requirement. Component test runs only on explicit Windows integration flag, not normal cross-platform CI.

```ts
expect(await dotnetBuild(wpfProject)).toMatchObject({ exitCode: 0 });
expect(await dotnetBuild(winuiProject)).toMatchObject({ exitCode: 0 });
expect(referenceFixtureCapabilities()).toEqual(expect.arrayContaining(["Button", "Edit", "Dialog", "Crash", "Reset"]));
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/component/windows-uia/reference-app.test.ts tests/component/windows-uia/local-approval.test.ts`

Expected: fixtures/tests missing or skipped until explicit Windows flag.

- [ ] **Step 3: Implement fixtures and controlled integration**

WPF uses .NET 10 standard controls; WinUI uses Windows App SDK controls; both use local JSON state reset and fake high-risk action. Tests exercise capture/click/input/select/scroll/dialog/crash and approval deny/timeout/stop with generated evidence paths.

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

Copy `docs/testing/windows-m3-manual-checklist.md` to the versioned evidence path. Fill every environment field; mark every item `[x]`, `[!]` or `[-]` with reason; link Run/Trace/Artifact/Issue; both executor and reviewer sign. Any Section 16 failure blocks release.

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

- Spec coverage: contracts/AppTarget, Rust IPC/approvals/stop, UIA capture/extension, lifecycle/actions, two Reference Apps, automatic/manual/freeze Gate map to Tasks 1–6.
- Placeholder scan: platform, tools, controls, actions, error oracles and commands are explicit.
- Type consistency: Rust DTO→desktop contracts→Windows Adapter→Graph/Runner ports; Core remains platform-neutral.
