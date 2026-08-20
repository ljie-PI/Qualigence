# [LS-12] M3 Observation Graph v1 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the candidate Observation Graph v1 contract, preserve typed platform extensions, migrate pre-v1 Trace projections and recompile/reverify pre-v1 Skills before freezing v1.

**Architecture:** A new observation-contracts package is the single Graph truth; runner-protocol temporarily re-exports it. Migration is append-only and idempotent: historical events remain immutable while new projections, Skill versions and reports cite source hashes.

**Tech Stack:** TypeScript, JSON Schema, Zod/Ajv-compatible validation, SHA-256 canonical JSON, Kysely stores, Vitest/fast-check/golden files.

**Direct Dependencies:** LS-11.

## Global Constraints

- Do not rewrite historical Event/Trace payloads.
- Do not create a second same-name Graph contract; runner-protocol re-exports the new package.
- Unknown extension minor fields round-trip; unsupported major is explicit.
- Graph remains candidate until LS-13 Web/UIA conformance and migration Gate pass.
- Tests stay under top-level `tests/`.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

### Task 1: Add Observation Graph v1 types and JSON Schema

**Files:**

- Create: `packages/contracts/observation/package.json`
- Create: `packages/contracts/observation/tsconfig.json`
- Create: `packages/contracts/observation/src/core.ts`
- Create: `packages/contracts/observation/src/extensions.ts`
- Create: `packages/contracts/observation/schemas/observation-graph-v1.schema.json`
- Create: `packages/contracts/observation/src/index.ts`
- Modify: `packages/contracts/runner-protocol/package.json`
- Modify: `packages/contracts/runner-protocol/src/index.ts`
- Test: `tests/type/observation-graph-v1.types.ts`
- Test: `tests/conformance/observation/json-schema.test.ts`

**Interfaces:** Exact `ObservationJsonValue`, `ObservationSchema`, `ObservationGraphV1`, `ObservationNodeV1`, relation and extension types from Design; observation-contracts does not import model-provider JSON types.

- [ ] **Step 1: Write type/schema examples**

```ts
const graph: ObservationGraphV1 = {
  schema: { epoch: "v1", version: "observation-graph/v1" },
  graphId: "g1", target: { kind: "web", targetId: "t1" },
  capturedAt: "2026-08-01T00:00:00.000Z", rootNodeIds: ["n1"],
  nodes: [{ id: "n1", role: "window", state: {}, relations: [], source: { adapterId: "web-playwright", sourceKind: "accessibility" }, confidence: 1, sensitivity: "public", extensions: {}, evidenceRefs: [] }],
  evidenceRefs: [],
};
```

Validate good example; reject confidence 1.1, negative bounds, missing root/relation, invalid secret value.

- [ ] **Step 2: Confirm RED**

Run: `pnpm typecheck && pnpm vitest run tests/conformance/observation/json-schema.test.ts`

Expected: package/schema missing.

- [ ] **Step 3: Implement single contract and re-export**

Move/adapt existing Observation types into new package, preserving current fields through a pre-v1 compatibility type. runner-protocol imports/re-exports, then remove duplicate declarations. Add strict JSON Schema with extension payload object.

```ts
export interface ObservationGraphV1 {
  readonly schema: ObservationSchema;
  readonly graphId: string;
  readonly target: ObservationTarget;
  readonly nodes: readonly ObservationNodeV1[];
  readonly evidenceRefs: readonly string[];
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 1 command plus current Runner tests; expect no consumer break and schema cases pass.

- [ ] **Step 5: Commit**

```text
git add packages/contracts/observation packages/contracts/runner-protocol tests/type/observation-graph-v1.types.ts tests/conformance/observation/json-schema.test.ts
git commit -m "feat(observation): define graph v1 candidate contract"
```

### Task 2: Implement canonical validation and extension compatibility

**Authority amendment (2026-08-20):** 以下早期“array/node order remains meaningful”和“preserves arrays”步骤仅保留为设计历史。当前规则是：对象键排序并规范化 NFC；nodes 按 NFC-normalized `id`，relations 按 NFC-normalized `(type, targetNodeId)` tuple，root IDs 与 Graph evidence refs 按 NFC-normalized string 排序；相同 key 必须是 byte-identical entry，否则验证失败，不得使用输入顺序作为 hash tie-breaker。业务顺序数组保序；extension 数组仅在 schema 明确声明 set 语义时排序，未声明数组保序。Task 22 in the remaining-closure authority owns implementation and property-test migration.

**Files:**

- Create: `packages/contracts/observation/src/canonical.ts`
- Create: `packages/contracts/observation/src/validator.ts`
- Test: `tests/conformance/observation/canonical.test.ts`
- Test: `tests/conformance/observation/extensions.test.ts`
- Test: `tests/property/observation-graph.test.ts`

**Interfaces:** `validateObservationGraphV1`, `canonicalObservationJson`, `observationGraphHash`, `requireExtensionMajor`.

- [ ] **Step 1: Write invariants/properties**

Object key insertion order yields same hash; array/node order remains meaningful; all relation targets exist; node IDs unique; secret value must be omitted/masked; unknown `uia/v1` payload minor field survives serialize/parse; `uia/v2` consumer requirement returns `ExtensionVersionUnsupported`.

```ts
expect(observationGraphHash(graphWithKeyOrder("ab"))).toBe(observationGraphHash(graphWithKeyOrder("ba")));
expect(() => validateObservationGraphV1(graphWithDanglingRelation)).toThrow("DanglingNodeReference");
expect(roundTrip(graphWithUnknownUiaMinor)).toEqual(graphWithUnknownUiaMinor);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/conformance/observation/canonical.test.ts tests/conformance/observation/extensions.test.ts tests/property/observation-graph.test.ts`

Expected: validator/canonical functions missing.

- [ ] **Step 3: Implement deterministic checks**

Canonical JSON sorts object keys, normalizes strings NFC, preserves arrays and rejects non-finite numbers. Validator performs graph-level uniqueness/reference/evidence callback checks after JSON Schema. Extension lookup parses `<name>/v<major>`.

```ts
export function observationGraphHash(graph: ObservationGraphV1): string {
  validateObservationGraphV1(graph);
  return createHash("sha256").update(canonicalObservationJson(graph), "utf8").digest("hex");
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 2 command; expect property and round-trip cases pass for fixed seed.

- [ ] **Step 5: Commit**

```text
git add packages/contracts/observation tests/conformance/observation tests/property/observation-graph.test.ts
git commit -m "feat(observation): validate canonical graph v1"
```

### Task 3: Inventory and project pre-v1 Trace assets

**Files:**

- Create: `packages/observation-migration/package.json`
- Create: `packages/observation-migration/tsconfig.json`
- Create: `packages/observation-migration/src/pre-v1-projector.ts`
- Create: `packages/observation-migration/src/migration-runner.ts`
- Create: `packages/observation-migration/src/index.ts`
- Create: `tests/fixtures/migration/pre-v1/m1-web-observation.json`
- Create: `tests/fixtures/migration/pre-v1/m2-procedure-skill.json`
- Create: `tests/fixtures/migration/pre-v1/corrupted-artifact.json`
- Create: `tests/migration/observation-v1/pre-v1-projector.test.ts`
- Create: `tests/migration/observation-v1/resume-idempotency.test.ts`

**Interfaces:** Produces `PreV1AssetMetadata`, `ObservationMigrationResult`; Projector creates v1 projection with source event/hash/migrator version.

- [ ] **Step 1: Add golden asset tests**

Representative M1 Graph, M2 Skill source and corrupted Artifact. Valid assets project to schema-valid candidate with evidence refs; corrupted source returns `SourceAssetCorrupted`; duplicate source hash+migrator returns existing result; changed source creates new attempt.

```ts
expect(await projector.project(m1Fixture)).toMatchObject({ schema: { version: "observation-graph/v1" } });
await expect(projector.project(corruptedFixture)).rejects.toMatchObject({ code: "SourceAssetCorrupted" });
expect(await runner.migrate(m1Fixture)).toEqual(await runner.migrate(m1Fixture));
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/migration/observation-v1/pre-v1-projector.test.ts tests/migration/observation-v1/resume-idempotency.test.ts`

Expected: migration package missing.

- [ ] **Step 3: Implement inventory/projector/runner**

Read via repositories, verify Artifact/event hash before transform, map legacy text/disabled into v1 value/state, set source adapter/kind/sensitivity defaults from evidence policy, validate result, append immutable migration attempt. Batch cursor is assetId; one failure does not undo prior projection.

```ts
const existing = await projections.find(source.traceId, mapper.version);
if (existing) return assertSameSourceHash(existing, source.sha256);
const graph = validateObservationGraphV1(mapper.project(source));
return projections.append(projectionRecord(source, graph, mapper.version));
```

- [ ] **Step 4: Confirm GREEN**

Run Task 3 command; expect golden/corruption/restart/idempotency cases pass.

- [ ] **Step 5: Commit**

```text
git add packages/observation-migration tests/fixtures/migration tests/migration/observation-v1
git commit -m "feat(migration): project pre-v1 observations"
```

### Task 4: Recompile/reverify pre-v1 Skills

**Files:**

- Create: `packages/observation-migration/src/skill-recompiler.ts`
- Test: `tests/migration/observation-v1/skill-recompiler.test.ts`
- Test: `tests/replay/observation-v1/recompiled-skill.test.ts`

**Interfaces:** `SkillRecompiler.recompile(skillVersion, sourceTrace)` returns new Candidate v1 version or explicit Deprecated/Needs Human result; standard Skill Verifier promotes only after replay.

- [ ] **Step 1: Write three asset outcomes**

Resolvable semantic source→new Candidate→Verified v1; missing unique locator→Needs Human; unsupported action/schema→Deprecated. Original pre-v1 Skill bytes/state remain unchanged and new version cites source hash/compiler.

```ts
expect(await recompiler.recompile(resolvableSkill, sourceTrace)).toMatchObject({ status: "migrated" });
expect(await recompiler.recompile(ambiguousSkill, sourceTrace)).toMatchObject({ status: "needs_human" });
expect(hash(originalSkillBytes)).toBe(originalHash);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/migration/observation-v1/skill-recompiler.test.ts tests/replay/observation-v1/recompiled-skill.test.ts`

Expected: recompiler missing.

- [ ] **Step 3: Implement through existing Compiler/Verifier**

Do not patch Bundle. Reconstruct Recording-like input from source Trace, call current SkillCompiler with compiler version, then standard signature/evaluation path. Map deterministic unsupported to Deprecated and ambiguity/missing evidence to Needs Human.

```ts
const recording = recordingFromMigratedTrace(sourceTrace, migratedGraph);
const candidate = compiler.compile(recording, proposalFrom(previousSkill));
const evaluation = await verifier.verify(candidate, verificationFixture);
return evaluation.passed ? signer.sign(promote(candidate, evaluation)) : classifyFailure(evaluation);
```

- [ ] **Step 4: Confirm GREEN**

Run Task 4 command; expect all three outcomes and source immutability pass.

- [ ] **Step 5: Commit**

```text
git add packages/observation-migration tests/migration/observation-v1/skill-recompiler.test.ts tests/replay/observation-v1
git commit -m "feat(migration): recompile pre-v1 skills for graph v1"
```

### Task 5: Add admin command, persistence and candidate Freeze report

**Files:**

- Create: `apps/admin-cli/src/commands/migrate-observation.ts`
- Create: `packages/storage-providers/relational-kysely/src/migrations/006-observation-v1.ts`
- Create: `packages/storage-providers/relational-kysely/src/observation-migration-store.ts`
- Test: `tests/migration/observation-v1/admin-command.test.ts`
- Create: `docs/testing/observation-graph-v1-freeze-checklist.md`
- Modify: `docs/superpowers/implementation-status.md`

**Interfaces:** `qualigence migrate observation-v1 --dry-run|--execute --report <path>`; report counts every asset outcome and hashes inputs.

- [ ] **Step 1: Write dry-run/execute/resume/report tests**

Dry-run writes no projection; execute resumes after injected crash; Report includes inventory/migrated/deprecated/needsHuman/failed and no unexplained failed; command refuses unbacked migration.

```ts
expect(await runMigration(["--dry-run"])).toMatchObject({ writes: 0 });
const report = await runMigration(["--execute", "--report", reportPath]);
expect(report.counts.failed).toBe(0);
expect(report.counts.inventory).toBe(report.counts.migrated + report.counts.deprecated + report.counts.needsHuman);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/migration/observation-v1/admin-command.test.ts`

Expected: command/store/checklist missing.

- [ ] **Step 3: Implement candidate Gate**

Use backup guard, transaction per asset, atomic JSON Report. Checklist has Web/UIA conformance, schema/breaking, all active Skill outcomes, protocol capability and human signoff. Mark Graph `candidate`, not frozen, until LS-13 evidence is attached.

```ts
const inventory = await migration.inventory();
for (const asset of inventory) await migration.migrateOne(asset, options);
const report = await migration.buildReport(inventory);
await atomicReportWriter.write(options.reportPath, report);
```

- [ ] **Step 4: Run LS-12 Gate**

```text
pnpm build
pnpm test
pnpm typecheck
pnpm vitest run tests/conformance/observation tests/migration/observation-v1 tests/replay/observation-v1
git diff --check
```

Expected: all exit 0; migration Report has no unexplained failure; status remains candidate pending LS-13.

- [ ] **Step 5: Commit/status**

```text
git add apps/admin-cli packages tests docs/testing/observation-graph-v1-freeze-checklist.md docs/superpowers/implementation-status.md
git commit -m "feat(observation): complete graph v1 migration gate"
```

## Plan Self-Review

- Spec coverage: single contract/schema, canonical/extension, pre-v1 projection, Skill recompile/outcomes, persistence/report/freeze candidate map to Tasks 1–5.
- Placeholder scan: every migration result, compatibility behavior and Gate command is explicit.
- Type consistency: runner-protocol re-exports observation-contracts; migration outputs current Skill/Graph versions without rewriting history.
