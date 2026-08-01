# [LS-01] M1 Local Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist M1 runs, traces, findings, artifact manifests, model summaries, and file artifacts with restart-safe integrity.

**Architecture:** Add storage ports to the Evidence public boundary, implement them with Kysely/better-sqlite3 and the local filesystem, and keep database/driver types out of consumers. Preserve the existing `TraceStore` signatures exactly.

**Tech Stack:** Node.js 24, TypeScript ESM, Kysely 0.28.x, better-sqlite3 12.x, Vitest.

**Direct Dependencies:** BASE-02.

## Global Constraints

- Tests remain under top-level `tests/`; never place tests beside `src/`.
- Do not use `node:sqlite`, store large artifacts as BLOBs, or persist prompts/raw model responses.
- Export only package `src/index.ts`; no consumer imports internal source paths.
- Every migration, trace append, and terminal update uses explicit transactions and stable error codes from the Design Spec.
- Complete this plan on top of BASE-02; do not change current Trace/Finding hash semantics.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

## File Structure

```text
packages/core-modules/evidence/src/persistence-ports.ts  # provider-neutral records/ports
packages/storage-providers/artifact-fs/                 # atomic local files
packages/storage-providers/sqlite-runtime/              # connection, migrations, stores
tests/contract/artifact-fs/                             # ArtifactStore contract
tests/contract/sqlite/                                  # SQLite contracts/concurrency
```

### Task 1: Freeze persistence ports

**Files:**

- Create: `packages/core-modules/evidence/src/persistence-ports.ts`
- Modify: `packages/core-modules/evidence/src/index.ts`
- Test: `tests/type/persistence-ports.types.ts`

**Interfaces:**

- Consumes: existing `TraceStore`, `FindingEnvelope`, string Run IDs.
- Produces: `RunStore`, `RunTerminalUpdate`, `ArtifactStore`, `ArtifactManifestStore`, `ModelInvocationStore` and the exact record types from the LS-01 Design Spec.

- [ ] **Step 1: Add a compile-time consumer test**

```ts
import type { ArtifactStore, RunStore } from "@qualigence/evidence";

declare const runs: RunStore;
declare const artifacts: ArtifactStore;
void runs.get("run-1");
void artifacts.verify({
  artifactId: "a1", runId: "run-1", kind: "screenshot",
  mediaType: "image/png", relativePath: "run-1/a.png",
  sha256: "0".repeat(64), size: 1, createdAt: "2026-08-01T00:00:00.000Z",
});
```

- [ ] **Step 2: Run the typecheck and confirm RED**

Run: `pnpm typecheck`

Expected: TypeScript reports that `ArtifactStore` and `RunStore` are not exported.

- [ ] **Step 3: Add the provider-neutral interfaces**

Copy the interfaces from `docs/superpowers/specs/2026-08-01-ls-01-m1-local-persistence-design.md` without renaming fields. Re-export every public type from `src/index.ts`; import no Kysely or filesystem type.

```ts
export interface RunStore {
  create(record: ExecutionRunRecord): Promise<void>;
  complete(runId: string, terminal: RunTerminalUpdate): Promise<"completed" | "duplicate">;
  get(runId: string): Promise<ExecutionRunRecord | undefined>;
}
```

- [ ] **Step 4: Run the typecheck and confirm GREEN**

Run: `pnpm typecheck`

Expected: the consumer file compiles without internal imports.

- [ ] **Step 5: Commit**

```text
git add packages/core-modules/evidence tests/type/persistence-ports.types.ts
git commit -m "feat(evidence): define local persistence ports"
```

### Task 2: Implement atomic LocalArtifactStore

**Files:**

- Create: `packages/storage-providers/artifact-fs/package.json`
- Create: `packages/storage-providers/artifact-fs/tsconfig.json`
- Create: `packages/storage-providers/artifact-fs/src/local-artifact-store.ts`
- Create: `packages/storage-providers/artifact-fs/src/index.ts`
- Test: `tests/contract/artifact-fs/local-artifact-store.test.ts`
- Modify: `tsconfig.json`

**Interfaces:**

- Consumes: `ArtifactWriteRequest`, `ArtifactManifest`, `ArtifactStore`.
- Produces: `new LocalArtifactStore(rootDir, clock)` implementing atomic write/read/verify.

- [ ] **Step 1: Write the failing Artifact contract**

```ts
it("writes, reopens, and verifies bytes", async () => {
  const store = new LocalArtifactStore(root, fixedClock);
  const manifest = await store.write({
    artifactId: "a1", runId: "run-1", name: "before.png",
    kind: "screenshot", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]),
  });
  expect(manifest.relativePath).toBe("run-1/before.png");
  expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await store.verify(manifest)).toBe(true);
});

it.each(["../x", "x/y", "C:\\x", "/x"])("rejects unsafe name %s", async (name) => {
  await expect(store.write(validRequest(name))).rejects.toMatchObject({ code: "ArtifactPathRejected" });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run tests/contract/artifact-fs/local-artifact-store.test.ts`

Expected: module `@qualigence/artifact-fs` is missing.

- [ ] **Step 3: Implement the atomic write sequence**

```ts
export class LocalArtifactStore implements ArtifactStore {
  async write(request: ArtifactWriteRequest): Promise<ArtifactManifest> {
    const finalPath = this.resolveSafePath(request.runId, request.name);
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(temporaryPath, request.bytes, { flag: "wx" });
    await rename(temporaryPath, finalPath);
    return this.manifestFor(request, finalPath, request.bytes);
  }
}
```

Implement `finally` cleanup for a remaining temporary file, `read`, final-file hash verification, and structured `ArtifactWriteFailed`/`ArtifactHashMismatch` errors.

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm vitest run tests/contract/artifact-fs/local-artifact-store.test.ts`

Expected: write/read/path traversal/corruption/failure-injection cases pass and the temp directory contains no `.tmp` file.

- [ ] **Step 5: Commit**

```text
git add packages/storage-providers/artifact-fs tests/contract/artifact-fs tsconfig.json
git commit -m "feat(storage): add atomic local artifact store"
```

### Task 3: Add SQLite runtime and migrations

**Files:**

- Create: `packages/storage-providers/sqlite-runtime/package.json`
- Create: `packages/storage-providers/sqlite-runtime/tsconfig.json`
- Create: `packages/storage-providers/sqlite-runtime/src/database.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/migrations.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/schema.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/errors.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/index.ts`
- Test: `tests/contract/sqlite/sqlite-runtime.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`

**Interfaces:**

- Consumes: filesystem database path and busy timeout.
- Produces: `SqliteRuntime.open(options)`, `runtime.db`, `runtime.close()` and migration version 1.

- [ ] **Step 1: Write failing runtime tests**

```ts
it("opens with required pragmas and reopens schema v1", async () => {
  const first = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
  expect(await first.pragma("journal_mode")).toBe("wal");
  expect(await first.schemaVersion()).toBe(1);
  await first.close();
  expect(await (await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 })).schemaVersion()).toBe(1);
});
```

Also write version-too-new and close-idempotency cases.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run tests/contract/sqlite/sqlite-runtime.test.ts`

Expected: `SqliteRuntime` does not exist.

- [ ] **Step 3: Implement connection and migration v1**

Install `kysely@0.28` and `better-sqlite3@12`; configure `foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=5000`. Create all six tables and constraints exactly as listed in the Design Spec. Reject `MAX(schema_migrations.version) > 1` with `DatabaseVersionTooNew`.

```ts
export class SqliteRuntime {
  static open(options: SqliteRuntimeOptions): Promise<SqliteRuntime>;
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
}
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm vitest run tests/contract/sqlite/sqlite-runtime.test.ts`

Expected: pragma, migration, reopen, version rejection, and double-close cases pass.

- [ ] **Step 5: Commit**

```text
git add package.json pnpm-lock.yaml tsconfig.json packages/storage-providers/sqlite-runtime tests/contract/sqlite/sqlite-runtime.test.ts
git commit -m "feat(storage): add sqlite runtime and schema v1"
```

### Task 4: Implement transactional Trace and Finding stores

**Files:**

- Create: `packages/storage-providers/sqlite-runtime/src/sqlite-trace-store.ts`
- Test: `tests/contract/sqlite/sqlite-trace-store.test.ts`
- Test: `tests/contract/sqlite/sqlite-trace-concurrency.test.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/index.ts`

**Interfaces:**

- Consumes: unchanged `TraceStore` and canonical hashes.
- Produces: `SqliteTraceStore` with the same result unions as `InMemoryTraceStore`.

- [ ] **Step 1: Write failing ordering/integrity tests**

```ts
expect(await store.appendTraceEvent(event(1))).toMatchObject({ status: "accepted", nextSequenceNumber: 2 });
expect(await store.appendTraceEvent(event(1))).toMatchObject({ status: "duplicate" });
expect(await store.appendTraceEvent(event(3))).toMatchObject({ status: "sequence_gap", expectedSequenceNumber: 2 });
expect(await store.appendTraceEvent(changedEvent(1))).toMatchObject({ status: "integrity_violation" });
```

Add concurrent appends from two runtime connections and Finding same-ID/different-hash cases.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run tests/contract/sqlite/sqlite-trace*.test.ts`

Expected: `SqliteTraceStore` is missing.

- [ ] **Step 3: Implement one `BEGIN IMMEDIATE` append transaction**

Inside the transaction: read Run cursor; inspect existing sequence/idempotency rows; return duplicate/conflict/gap without update; insert envelope JSON; update cursor. Map Busy Timeout to `StorageBusy`, never retry indefinitely.

```ts
export class SqliteTraceStore implements TraceStore {
  appendTraceEvent(event: TraceEvent): Promise<TraceAppendResult>;
  appendFinding(finding: FindingEnvelope, payloadHash: string): Promise<FindingAppendResult>;
  eventAt(runId: string, sequenceNumber: number): Promise<TraceEvent | undefined>;
  nextTraceSequenceNumber(runId: string): Promise<number>;
}
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm vitest run tests/contract/sqlite/sqlite-trace*.test.ts`

Expected: contract and concurrency suites pass repeatedly with one accepted writer and no unexplained database exception.

- [ ] **Step 5: Commit**

```text
git add packages/storage-providers/sqlite-runtime tests/contract/sqlite/sqlite-trace-store.test.ts tests/contract/sqlite/sqlite-trace-concurrency.test.ts
git commit -m "feat(storage): persist trace and finding integrity"
```

### Task 5: Implement remaining stores and full Gate

**Files:**

- Create: `packages/storage-providers/sqlite-runtime/src/sqlite-run-store.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/sqlite-artifact-manifest-store.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/sqlite-model-invocation-store.ts`
- Test: `tests/contract/sqlite/sqlite-record-stores.test.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/index.ts`
- Modify: `tests/smoke/node-package-imports.mjs`

**Interfaces:**

- Produces: all LS-01 store ports; consumers can reopen and query without SQL.

- [ ] **Step 1: Write failing create/complete/reopen tests**

Create one Run, complete it twice with the same `RunTerminalUpdate`, append Manifest/model summary, close/reopen, and assert exact records. Complete with a different terminal value must return a conflict error; a compile-time test must reject `status:"running"` as a terminal update.

```ts
await runs.create(runningRun("run-1"));
expect(await runs.complete("run-1", passedAt(clock.now()))).toBe("completed");
expect(await runs.complete("run-1", passedAt(clock.now()))).toBe("duplicate");
expect(await reopen().runs.get("run-1")).toMatchObject({ status: "passed" });
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm vitest run tests/contract/sqlite/sqlite-record-stores.test.ts`

Expected: record store constructors are missing.

- [ ] **Step 3: Implement the stores and package exports**

Use JSON only for versioned envelopes; use structured columns for status, sequence, size, hash, timestamps, model usage, and error codes. Do not add raw prompt/response columns.

```ts
export class SqliteRunStore implements RunStore {}
export class SqliteArtifactManifestStore implements ArtifactManifestStore {}
export class SqliteModelInvocationStore implements ModelInvocationStore {}
```

- [ ] **Step 4: Run the LS-01 Gate**

```text
pnpm build
pnpm vitest run tests/contract/artifact-fs tests/contract/sqlite
pnpm typecheck
pnpm smoke:node-imports
git diff --check
```

Expected: all commands exit 0; reopening proves persistence and a deliberate file corruption makes `verify()` return false.

- [ ] **Step 5: Commit and update status**

```text
git add packages tests package.json pnpm-lock.yaml tsconfig.json docs/superpowers/implementation-status.md
git commit -m "feat(storage): complete m1 local persistence"
```

## Plan Self-Review

- Spec coverage: ports, six tables, transactions, idempotency, concurrency, atomic files, hashes, safe paths, privacy, reopening and error codes map to Tasks 1–5.
- Placeholder scan: every code-producing step names the exact class, file, behavior, and test command.
- Type consistency: all providers implement types exported by `@qualigence/evidence`; `TraceStore` remains unchanged.
