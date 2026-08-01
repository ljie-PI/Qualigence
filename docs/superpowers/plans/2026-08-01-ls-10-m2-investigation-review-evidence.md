# [LS-10] M2 Investigation Review and Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Findings into budgeted reproduction outcomes, Bug Episodes or Needs Human, with concurrent Review tasks and offline-safe encrypted Evidence Capsules.

**Architecture:** Core aggregates own state and budgets; Workers/Runner submit immutable Attempts/Results. Review uses expected-version commands. Runner encrypts bounded evidence for a declared recipient KMS; all decrypts are policy-checked/audited.

**Tech Stack:** TypeScript, Kysely stores, Node AES-256-GCM/RSA-OAEP-256 crypto, Model Gateway Intelligence Jobs, Vitest/fast-check.

**Direct Dependencies:** LS-05 and LS-09.

## Global Constraints

- No model or Worker writes an aggregate directly.
- Attempts and dispositions are append-only.
- Environment failures consume only environment budgets.
- KMS failure never degrades to plaintext.
- Tests stay under top-level `tests/`.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

### Task 1: Implement Investigation aggregate and budget ledger

**Files:**

- Create: `packages/core-modules/investigation/package.json`
- Create: `packages/core-modules/investigation/tsconfig.json`
- Create: `packages/core-modules/investigation/src/domain/investigation-case.ts`
- Create: `packages/core-modules/investigation/src/domain/investigation-budget.ts`
- Create: `packages/core-modules/investigation/src/domain/reproduction-attempt.ts`
- Create: `packages/core-modules/investigation/src/public.ts`
- Create: `packages/core-modules/investigation/src/index.ts`
- Test: `tests/unit/core-modules/investigation/investigation-case.test.ts`
- Test: `tests/unit/core-modules/investigation/investigation-budget.test.ts`

**Interfaces:** Produces exact `InvestigationStatus`, `InvestigationBudget`, `ReproductionAttempt`, `BugEpisode`, `HumanHandoff` types.

- [ ] **Step 1: Write state/budget matrix**

Candidate→Investigating→Reproducing→Confirmed/Refuted/Flaky/Needs Human; reject illegal reverse. Append Attempts with ordinal. Environment failure decrements only environment retries; reproduction outcome decrements attempt; any hard limit creates Needs Human/Handoff exactly once.

```ts
caseFile.startInvestigation(command);
caseFile.startReproduction(plan);
caseFile.appendAttempt(environmentFailedAttempt);
expect(caseFile.usage()).toMatchObject({ environmentRetries: 1, reproductionAttempts: 0 });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/core-modules/investigation`

Expected: package missing.

- [ ] **Step 3: Implement aggregate/ledger**

Use injected Clock, immutable usage snapshot per Attempt, expectedVersion/idempotency commands. Build BugEpisode only after confirmation threshold and at least one reproduced Attempt; Handoff includes all attempt IDs/limitation codes.

```ts
appendAttempt(command: AppendAttemptCommand): InvestigationTransition {
  this.assertExpectedVersion(command.expectedVersion);
  const usage = this.budget.consume(command.attempt.outcome);
  return usage.exhausted ? this.needsHuman(command, usage) : this.record(command, usage);
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 1 command; expect transition/exact-limit/idempotency/property tests pass.

- [ ] **Step 5: Commit**

```text
git add packages/core-modules/investigation tests/unit/core-modules/investigation
git commit -m "feat(investigation): add budgeted case lifecycle"
```

### Task 2: Add IntelligenceJob and Reproduction coordination

**Files:**

- Create: `packages/core-modules/intelligence/package.json`
- Create: `packages/core-modules/intelligence/tsconfig.json`
- Create: `packages/core-modules/intelligence/src/contracts.ts`
- Create: `packages/core-modules/intelligence/src/application/intelligence-result-applier.ts`
- Create: `packages/core-modules/investigation/src/application/reproduction-planner.ts`
- Create: `packages/core-modules/investigation/src/application/investigation-coordinator.ts`
- Test: `tests/unit/core-modules/intelligence/result-applier.test.ts`
- Test: `tests/component/investigation/reproduction-flow.test.ts`

**Interfaces:** Persistent `IntelligenceJob/IntelligenceResult` with the exact job type, budget, provenance, usage and terminal fields from the Design Spec; Coordinator dispatches versioned Reproduction plans and appends returned Attempt.

- [ ] **Step 1: Write stale/duplicate/result tests**

Valid result applies once; same idempotency is duplicate; stale base version returns recompute; over-budget/schema/policy/evidence mismatch rejects; reproduced attempt at threshold creates BugEpisode; divergence revises plan within budget.

```ts
expect(await applier.apply(job, validResult)).toMatchObject({ status: "applied" });
expect(await applier.apply(job, validResult)).toMatchObject({ status: "duplicate" });
expect(await applier.apply(job, { ...validResult, baseAggregateVersion: 0 })).toMatchObject({ status: "recompute" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/core-modules/intelligence tests/component/investigation/reproduction-flow.test.ts`

Expected: modules missing.

- [ ] **Step 3: Implement ports and deterministic applier**

Keep ExecutionJob/IntelligenceJob unions separate. Validate result schema, Job lease, usage, evidence refs and base aggregate version before invoking command handler. Plan Proposal cannot contain selector and is snapshotted per revision.

```ts
export class IntelligenceResultApplier {
  async apply(job: IntelligenceJob, result: IntelligenceResult): Promise<ApplyResult> {
    const checked = this.validator.validate(job, result);
    if (!checked.ok) return checked.result;
    return this.commands.execute(toAggregateCommand(job, result));
  }
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 2 command; expect all validation/reproduction outcomes pass.

- [ ] **Step 5: Commit**

```text
git add packages/core-modules/intelligence packages/core-modules/investigation tests/unit/core-modules/intelligence tests/component/investigation
git commit -m "feat(investigation): coordinate reproduction intelligence"
```

### Task 3: Implement concurrent Human Review Queue

**Files:**

- Create: `packages/core-modules/review/package.json`
- Create: `packages/core-modules/review/tsconfig.json`
- Create: `packages/core-modules/review/src/domain/review-task.ts`
- Create: `packages/core-modules/review/src/application/claim-review-task-handler.ts`
- Create: `packages/core-modules/review/src/application/resolve-review-task-handler.ts`
- Create: `packages/core-modules/review/src/public.ts`
- Test: `tests/unit/core-modules/review/review-task.test.ts`
- Test: `tests/component/review/concurrent-claim.test.ts`

**Interfaces:** Produces `ReviewTask`, `ClaimReviewTaskCommand`; open→claimed→resolved.

- [ ] **Step 1: Write two-writer claim test**

```ts
const [a, b] = await Promise.allSettled([claim("alice", 1), claim("bob", 1)]);
expect([a, b].filter((x) => x.status === "fulfilled")).toHaveLength(1);
expect(rejected(a, b)).toMatchObject({ code: "ReviewTaskVersionConflict", currentVersion: 2, assigneeId: expect.any(String) });
```

Resolve by non-assignee/stale version must fail; duplicate idempotency returns original.

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/core-modules/review tests/component/review/concurrent-claim.test.ts`

Expected: Review package missing.

- [ ] **Step 3: Implement aggregate and conditional repository write**

Use expected-version update in transaction; return current aggregate truth on conflict, never projection. Resolve stores disposition/evidence refs and actor.

```ts
const updated = await repository.claim(taskId, expectedVersion, assigneeId, idempotencyKey);
if (!updated) {
  const current = await repository.require(taskId);
  throw new ReviewTaskVersionConflict(current.version, current.assigneeId);
}
return updated;
```

- [ ] **Step 4: Confirm GREEN**

Run Task 3 command repeatedly; exactly one reviewer always owns the task.

- [ ] **Step 5: Commit**

```text
git add packages/core-modules/review tests/unit/core-modules/review tests/component/review
git commit -m "feat(review): add concurrent human review queue"
```

### Task 4: Implement Evidence Capsule encryption and KMS ports

**Files:**

- Create: `packages/core-modules/evidence/src/capsule/contracts.ts`
- Create: `packages/core-modules/evidence/src/capsule/envelope-encryptor.ts`
- Create: `packages/runner-components/evidence-capsule/package.json`
- Create: `packages/runner-components/evidence-capsule/tsconfig.json`
- Create: `packages/runner-components/evidence-capsule/src/capsule-builder.ts`
- Create: `packages/storage-providers/kms-self-hosted/package.json`
- Create: `packages/storage-providers/kms-self-hosted/tsconfig.json`
- Create: `packages/storage-providers/kms-self-hosted/src/in-memory-test-kms.ts`
- Test: `tests/contract/evidence-crypto/evidence-capsule.test.ts`
- Test: `tests/contract/evidence-crypto/evidence-policy.test.ts`

**Interfaces:** Exact `EvidenceEncryptionProfile`/`EvidenceCapsulePayload`/`EvidenceCapsuleManifest`; `KeyManagementProvider.encryptionProfile/wrapDek/unwrapDek/revoke`; builder selects/redacts/bounds.

- [ ] **Step 1: Write crypto/policy matrix**

Round trip allowed capsule; mutate ciphertext/tag/wrapped key; wrong tenant/case/purpose/region; expired TTL/revoked key; KMS unavailable; local_only. Every denial occurs before plaintext return and writes audit outcome.

```ts
const encrypted = await encryptor.encrypt(payload, profile);
expect(await decryptor.decrypt(encrypted, authorizedContext)).toEqual(payload);
await expect(decryptor.decrypt(tamper(encrypted), authorizedContext)).rejects.toMatchObject({ code: "EvidenceIntegrityViolation" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/evidence-crypto`

Expected: contracts/encryptor missing.

- [ ] **Step 3: Implement bounded envelope crypto**

Canonicalize/redact selected Trace slice/semantic subtree/local screenshot/log summary; enforce whitelist/window/max bytes; generate random 32-byte DEK/12-byte nonce; AES-256-GCM; RSA-OAEP-256 wrap; zero temporary DEK buffer in finally. Store ciphertext and Manifest only.

```ts
const dek = randomBytes(32);
try {
  const encrypted = aes256GcmEncrypt(dek, randomBytes(12), canonicalPayload, aad(manifest));
  return { manifest, encrypted, wrappedDek: await kms.wrapDek(profile, dek) };
} finally {
  dek.fill(0);
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 4 command; expect round-trip/tamper/scope/TTL/KMS/local_only and audit cases pass.

- [ ] **Step 5: Commit**

```text
git add packages/core-modules/evidence packages/runner-components/evidence-capsule packages/storage-providers/kms-self-hosted tests/contract/evidence-crypto
git commit -m "feat(evidence): encrypt bounded investigation capsules"
```

### Task 5: Persist/integrate offline investigation Gate

**Files:**

- Create: `packages/storage-providers/sqlite-runtime/src/migrations/005-investigation-review.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/sqlite-investigation-store.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/sqlite-review-store.ts`
- Test: `tests/contract/sqlite/investigation-review-store.test.ts`
- Test: `tests/component/investigation/offline-capsule-flow.test.ts`
- Modify: `docs/superpowers/implementation-status.md`

**Interfaces:** `SqliteInvestigationStore` and `SqliteReviewStore` implement the frozen repositories; the integration path exposes only encrypted Capsule manifests/artifact refs while Runner is offline.

- [ ] **Step 1: Write two end-to-end paths**

Finding→Attempts→Confirmed→BugEpisode; Finding→budget exhausted→Needs Human+ReviewTask. Prestage encrypted Capsule, disconnect Runner, decrypt as authorized Worker; without prestage assert `evidenceCompleteness:"limited"`.

```ts
const confirmed = await harness.investigate(reproducibleFinding);
expect(confirmed).toMatchObject({ status: "confirmed", bugEpisodeId: expect.any(String) });
runner.disconnect();
expect(await harness.openCapsule(confirmed.caseId)).toMatchObject({ schemaVersion: "evidence-capsule/v1" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/sqlite/investigation-review-store.test.ts tests/component/investigation/offline-capsule-flow.test.ts`

Expected: persistence/integration missing.

- [ ] **Step 3: Implement stores and transactional handoff**

Store Case version/status/budget structured; Attempts/BugEpisode/Handoff/Review/Capsule/Audit append-only; transition Needs Human and create ReviewTask in one transaction; ciphertext Artifact referenced by Manifest.

```ts
await db.transaction().execute(async (trx) => {
  const changed = await investigationStore.transition(trx, command);
  if (changed.status === "needs_human") {
    await reviewStore.create(trx, reviewTaskFrom(changed));
  }
});
```

- [ ] **Step 4: Run LS-10 Gate**

```text
pnpm build
pnpm test
pnpm typecheck
pnpm vitest run tests/component/investigation tests/component/review tests/contract/evidence-crypto
git diff --check
```

Expected: all exit 0; Runner-offline authorized flow works only for prestaged ciphertext and no plaintext/DEK appears in logs/database.

- [ ] **Step 5: Commit/status**

```text
git add packages tests docs/superpowers/implementation-status.md
git commit -m "feat(investigation): complete review and evidence loop"
```

## Plan Self-Review

- Spec coverage: state/budgets, Intelligence Result, Attempts/BugEpisode/Handoff, concurrent Review, envelope crypto/KMS/audit/offline flow map to Tasks 1–5.
- Placeholder scan: every budget/crypto/concurrency outcome is named.
- Type consistency: Workers submit Results; deterministic handlers update Case/Review; Capsule manifest references ciphertext only.
