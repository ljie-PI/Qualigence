# [LS-06] M1 Local Operations and Visual Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide one safe Local Launcher with health/doctor/backup behavior and add policy-gated visual model attachments.

**Architecture:** Launcher supervises processes through ports and never touches domain tables. Visual attachments extend the provider-neutral model message while Gateway enforces capability, integrity, size and Data Policy before a provider sees bytes.

**Tech Stack:** Node.js 24, TypeScript, YAML/Zod, Pino, SQLite online backup, existing OpenAI SDK.

**Direct Dependencies:** LS-05.

## Global Constraints

- Core listens only on loopback in Local mode.
- No API key field in YAML/CLI and no base64 image in logs.
- Migration cannot start without a complete verified backup.
- Vision is disabled by default and never silently enabled.
- Tests stay under top-level `tests/`.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

### Task 1: Add Local config and control contracts

**Files:**

- Create: `packages/contracts/local-control/package.json`
- Create: `packages/contracts/local-control/tsconfig.json`
- Create: `packages/contracts/local-control/src/health.ts`
- Create: `packages/contracts/local-control/src/index.ts`
- Create: `apps/local-launcher/src/config.ts`
- Test: `tests/unit/local-launcher/config.test.ts`
- Modify: `tests/smoke/node-package-imports.mjs`

**Interfaces:** Produces `LocalConfig`, `HealthReport`, `HealthCheck`; config loader implements default < YAML < env < non-secret CLI.

- [ ] **Step 1: Write config precedence/rejection tests**

```ts
expect(loadLocalConfig({ yaml: { core: { port: 4000 } }, env: { QUALIGENCE_CORE_PORT: "5000" } }).core.port).toBe(5000);
try {
  loadYaml("modelProfile:\n  apiKey: secret");
  expect.unreachable("inline secret must fail");
} catch (error) {
  expect(error).toMatchObject({ code: "SecretInConfiguration" });
}
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/local-launcher/config.test.ts`

Expected: contracts/config missing.

- [ ] **Step 3: Implement exact schemas**

Use strict Zod objects; reject unknown secret-like keys; canonicalize dataDir; force host `127.0.0.1`; validate spool soft<hard and nonempty credentialRef.

```ts
export function loadLocalConfig(input: ConfigSources): LocalConfig {
  return localConfigSchema.parse(mergeConfigSources(input));
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 1 command; expect precedence, unknown key, secret and invalid limits pass.

- [ ] **Step 4b: Register public package smoke import**

`local-control` is a new public contracts package. Append one `[packageName, exportName]` pair to the `packages` array in `tests/smoke/node-package-imports.mjs`, keeping the array ordered alphabetically by package name: add `["@qualigence/local-control", "healthReportSchema"]` (bind `exportName` to the package's stable runtime export from `src/health.ts` — a Zod schema or guard, not an erased type). Match the existing pair syntax; the smoke loader imports the package and asserts the named runtime export exists.

- [ ] **Step 5: Commit**

```text
git add packages/contracts/local-control apps/local-launcher/src/config.ts tests/unit/local-launcher/config.test.ts tests/smoke/node-package-imports.mjs
git commit -m "feat(local): define launcher configuration"
```

### Task 2: Implement process supervisor, health and doctor

**Files:**

- Create: `apps/local-launcher/package.json`
- Create: `apps/local-launcher/tsconfig.json`
- Create: `apps/local-launcher/src/process-supervisor.ts`
- Create: `apps/local-launcher/src/health-client.ts`
- Create: `apps/local-launcher/src/doctor.ts`
- Test: `tests/unit/local-launcher/process-supervisor.test.ts`
- Test: `tests/component/local-launcher/start-stop.test.ts`
- Modify: `package.json`, `tsconfig.json`

**Interfaces:** `ProcessSupervisor.start/stop/status`; `LocalDoctor.run(includeProviderProbe)` returns `HealthReport`.

- [ ] **Step 1: Write fake-process rollback tests**

Core ready→Runner fail must stop Core; normal stop drains Runner then Core; timeout escalates only target PID; liveness avoids database/model; readiness checks database/artifact/runner/spool/disk.

```ts
runner.failStart("RunnerUnhealthy");
await expect(supervisor.start()).rejects.toMatchObject({ code: "RunnerUnhealthy" });
expect(core.stop).toHaveBeenCalledOnce();
expect(supervisor.events()).toEqual(["core:start", "core:ready", "runner:start", "core:stop"]);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/local-launcher/process-supervisor.test.ts tests/component/local-launcher/start-stop.test.ts`

Expected: supervisor missing.

- [ ] **Step 3: Implement condition-driven supervision**

Acquire exclusive data-dir lock; spawn with explicit argv and hidden window on Windows; poll health with deadline; reverse rollback; SIGTERM/CTRL_BREAK then scoped force; emit safe status. Provider probe sends only a static string when explicitly requested.

```ts
export class ProcessSupervisor {
  start(): Promise<HealthReport>;
  stop(): Promise<void>;
  status(): Promise<HealthReport>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 2 command; expect start/rollback/drain/timeout/health cases pass without fixed sleep.

- [ ] **Step 5: Commit**

```text
git add apps/local-launcher tests/unit/local-launcher tests/component/local-launcher package.json tsconfig.json
git commit -m "feat(local): supervise and diagnose local processes"
```

### Task 3: Implement backup/migration guard

**Files:**

- Create: `apps/local-launcher/src/backup-manager.ts`
- Create: `apps/local-launcher/src/migration-guard.ts`
- Test: `tests/component/local-launcher/backup-manager.test.ts`

**Interfaces:** `BackupManager.create(reason)` returns verified `BackupManifest`; `MigrationGuard.run(migration)` requires it.

- [ ] **Step 1: Write backup integrity and failure tests**

Create active WAL database, back it up, reopen backup and verify hash/version. Inject copy failure and hash mismatch; migration callback must remain uncalled.

```ts
const manifest = await backups.create("before schema 2");
expect(await backups.verify(manifest)).toBe(true);
await guard.run(manifest, migrate);
expect(migrate).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/component/local-launcher/backup-manager.test.ts`

Expected: manager missing.

- [ ] **Step 3: Implement online backup and Manifest**

Write backup into staging directory, redact config, create Artifact manifest inventory, hash all included files, write completion marker last, rename directory atomically. On failure preserve failed staging with an error marker and block migration.

```ts
export class BackupManager {
  create(reason: string): Promise<BackupManifest>;
  verify(manifest: BackupManifest): Promise<boolean>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 3 command; expect live backup, reopen, incomplete, mismatch and migration-block cases pass.

- [ ] **Step 5: Commit**

```text
git add apps/local-launcher/src/backup-manager.ts apps/local-launcher/src/migration-guard.ts tests/component/local-launcher/backup-manager.test.ts
git commit -m "feat(local): guard migrations with verified backups"
```

### Task 4: Extend Model contract with gated images

**Files:**

- Create: `packages/contracts/model-provider/src/content.ts`
- Create: `packages/model-gateway/src/data-policy.ts`
- Modify: `packages/contracts/model-provider/src/index.ts`
- Modify: `packages/model-gateway/src/model-gateway.ts`
- Modify: `packages/model-providers/openai-compatible/src/openai-compatible-model-provider.ts`
- Test: `tests/unit/model-gateway/visual-input-policy.test.ts`
- Test: `tests/contract/model-providers/openai-compatible-vision.test.ts`

**Interfaces:** `ModelMessage.content` stays string; optional `images: ModelImageInput[]`; `StructuredModelRequest.dataPolicy?: ModelDataPolicy` carries explicit allowed sensitivity/maximum bytes; image request without policy fails.

- [ ] **Step 1: Write capability/policy/hash tests**

```ts
await expect(invokeWithImage({ visualInput: "disabled" })).rejects.toMatchObject({ code: "VisionNotAllowed" });
await expect(invokeWithImage({ providerVision: false })).rejects.toMatchObject({ code: "VisionCapabilityMismatch" });
await expect(invokeWithImage({ badHash: true })).rejects.toMatchObject({ code: "ImageIntegrityViolation" });
```

Contract test asserts OpenAI content parts only after allowed input and captured logs contain no base64.

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/model-gateway/visual-input-policy.test.ts tests/contract/model-providers/openai-compatible-vision.test.ts`

Expected: images are not supported.

- [ ] **Step 3: Implement policy before provider mapping**

Validate media type, SHA-256, maximum bytes, sensitivity/Data Policy and Provider capability in Gateway. Map to OpenAI image content only in Provider. Keep existing text-only requests byte-for-byte equivalent.

```ts
function validateImages(request: StructuredModelRequest, capabilities: ModelCapabilities): void {
  if (request.messages.some(hasImages) && request.dataPolicy === undefined) throw new ModelGatewayError("VisionNotAllowed", safeMessage);
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 4 command; expect allowed/rejected/redaction/text-regression cases pass.

- [ ] **Step 5: Commit**

```text
git add packages/contracts/model-provider packages/model-gateway packages/model-providers/openai-compatible tests/unit/model-gateway/visual-input-policy.test.ts tests/contract/model-providers/openai-compatible-vision.test.ts
git commit -m "feat(model): add policy-gated visual input"
```

### Task 5: Wire Launcher commands and Gate

**Files:**

- Create: `apps/local-launcher/src/main.ts`
- Create: `deployments/local/config.example.yaml`
- Test: `tests/e2e/local-launcher.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/implementation-status.md`

**Interfaces:** Freezes `qualigence up|down|status|doctor|backup|restore` command arguments, JSON output and exit codes; composes existing Supervisor, health, backup and visual-input ports without exposing Provider internals.

- [ ] **Step 1: Write init/start/status/doctor/stop E2E**

Run launcher against temporary Core/Runner binaries, parse JSON status, assert bootstrap token appears once, stop cleanly, and assert second start returns `AlreadyRunning`.

```ts
expect(await launcher("start", "--foreground")).toMatchObject({ exitCode: 0 });
expect(JSON.parse((await launcher("status", "--json")).stdout).status).toBe("healthy");
expect(await launcher("start")).toMatchObject({ exitCode: 3, stderr: expect.stringContaining("AlreadyRunning") });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/e2e/local-launcher.test.ts`

Expected: command shell missing.

- [ ] **Step 3: Implement exact commands and docs**

Expose `init|start|stop|status|doctor|backup`; connect command handlers only to supervisor/doctor/backup; document offline manual restore with Core/Runner stopped and preservation of current data.

```ts
program.command("start").action(() => launcher.start());
program.command("doctor").option("--json").action((options) => launcher.doctor(options));
program.command("backup").requiredOption("--reason <text>").action((options) => launcher.backup(options.reason));
```

- [ ] **Step 4: Run LS-06 Gate**

```text
pnpm build
pnpm test
pnpm typecheck
pnpm smoke:node-imports
pnpm vitest run tests/e2e/local-launcher.test.ts
git diff --check
```

Expected: all exit 0; test logs/config/backup contain no API key or image base64.

- [ ] **Step 5: Commit/status**

```text
git add apps/local-launcher deployments/local packages tests README.md docs/superpowers/implementation-status.md
git commit -m "feat(local): complete launcher and visual hardening"
```

## Plan Self-Review

- Spec coverage: config/secret, supervision/health/doctor, backup/migration, image capability/policy/provider and CLI commands map to Tasks 1–5.
- Placeholder scan: exact commands, states, error oracles and content mapping are named.
- Type consistency: optional `images` extends existing `ModelMessage`; Launcher stays outside domain/storage internals.
