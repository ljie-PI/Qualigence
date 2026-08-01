# [LS-10] M2 Investigation Review and Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Findings into budgeted reproduction outcomes, Bug Episodes or Needs Human, with concurrent Review tasks and offline-safe encrypted Evidence Capsules.

**Architecture:** Core aggregates own state and budgets; Workers/Runner submit immutable Attempts/Results. Review uses expected-version commands. Runner builds a closed evidence payload containing the actual selected bytes, binds a canonical protected header as AEAD AAD, and encrypts for a scope-bound recipient KMS profile; all decrypts are policy-checked/audited. Local-only evidence is a separate non-uploadable result type.

**Tech Stack:** TypeScript, Kysely stores, Node AES-256-GCM/RSA-OAEP-256 crypto, `json-canonicalize` for RFC 8785 bytes, Model Gateway Intelligence Jobs, Vitest/fast-check.

**Direct Dependencies:** LS-05 and LS-09.

## Global Constraints

- No model or Worker writes an aggregate directly.
- Attempts and dispositions are append-only.
- Environment failures consume only environment budgets.
- KMS failure never degrades to plaintext.
- `RemoteEvidenceCapsuleManifest` and `LocalOnlyEvidenceRecord` are disjoint; local-only data cannot enter an upload queue.
- Capsule Payloads contain actual bounded evidence bytes. A local path or Artifact ref alone is never sufficient for offline evidence.
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
- Create: `packages/core-modules/evidence/src/capsule/protected-header.ts`
- Create: `packages/core-modules/evidence/src/capsule/capsule-entry.ts`
- Create: `packages/core-modules/evidence/src/capsule/envelope-encryptor.ts`
- Create: `packages/runner-components/evidence-capsule/package.json`
- Create: `packages/runner-components/evidence-capsule/tsconfig.json`
- Create: `packages/runner-components/evidence-capsule/src/capsule-builder.ts`
- Create: `packages/storage-providers/kms-self-hosted/package.json`
- Create: `packages/storage-providers/kms-self-hosted/tsconfig.json`
- Create: `packages/storage-providers/kms-self-hosted/src/in-memory-test-kms.ts`
- Test: `tests/contract/evidence-crypto/evidence-capsule.test.ts`
- Test: `tests/contract/evidence-crypto/evidence-policy.test.ts`

**Interfaces:** Exact `EvidenceEncryptionProfile`, `EvidenceCapsuleProtectedHeader`, `EvidenceCapsuleEntry`, `EvidenceCapsulePayload`, `RemoteEvidenceCapsuleManifest`, `LocalOnlyEvidenceRecord`, `EvidenceCapsuleBuildResult` and `EvidenceAuditEvent`; `KeyManagementProvider.encryptionProfile/wrapDek/unwrapDek/revoke`; builder selects/redacts/bounds actual content.

- [ ] **Step 1: Write crypto/policy matrix**

Round trip an allowed capsule. Independently mutate every protected-header scope/profile/plaintext field, ciphertext, tag and wrapped key; use wrong tenant/case/recipient/purpose/region/policy, expired TTL/revoked key, KMS unavailable and `local_only`. Exceed allowed kinds, per-entry, total plaintext and ciphertext limits. Assert two capsules use distinct 12-byte nonces, tags are 16 bytes, semantically equal headers canonicalize to identical bytes, and no caller value can override a profile-bound field. Every denial occurs before plaintext return and writes one exact `EvidenceAuditEvent`. Decode a screenshot Entry and compare its bytes/hash after its source file has been deleted.

```ts
const encrypted = await encryptor.encrypt(payload, profile);
expect(await decryptor.decrypt(encrypted, authorizedContext)).toEqual(payload);
await expect(decryptor.decrypt(tamper(encrypted), authorizedContext)).rejects.toMatchObject({ code: "EvidenceIntegrityViolation" });
expect(canonicalProtectedHeader(encrypted.manifest.protectedHeader))
  .toEqual(canonicalProtectedHeader(reorderedHeader(encrypted.manifest.protectedHeader)));
expect(await builder.build(localOnlyInput)).toMatchObject({ disposition: "local_only", record: { disposition: "local_only" } });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/evidence-crypto`

Expected: contracts/encryptor missing.

- [ ] **Step 3: Implement bounded envelope crypto**

Read, redact and encode the actual selected Trace slice, semantic graph, screenshot and log-summary bytes as `EvidenceCapsuleEntry`; recompute every entry hash/size and enforce per-entry plus total plaintext/ciphertext limits before allocation or upload. Use `json-canonicalize` for both Payload bytes and the complete protected header. Build the header only from the authenticated profile plus server-issued capsule ID/timestamps; reject profile/request scope mismatch.

For `remote_capsule`, generate a random 32-byte DEK and 12-byte nonce, AES-256-GCM encrypt with canonical protected-header bytes as the only AAD and require a 16-byte tag. Wrap with RSA-OAEP whose OAEP and MGF1 hashes are SHA-256 and label is empty; zero the temporary DEK buffer in `finally`. Store ciphertext and immutable Manifest only. For `local_only`, return only `LocalOnlyEvidenceRecord` and make the upload port accept `RemoteEvidenceCapsuleManifest` so the compiler rejects the local branch.

```ts
const dek = randomBytes(32);
try {
  const nonce = randomBytes(12);
  const protectedHeader = headerFromProfile(profile, serverFields);
  const aad = canonicalProtectedHeader(protectedHeader);
  const encrypted = aes256GcmEncrypt(dek, nonce, canonicalPayload(payload), aad, 16);
  return remoteCapsule(protectedHeader, encrypted, await kms.wrapDek(profile, dek));
} finally {
  dek.fill(0);
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 4 command; expect canonicalization, attachment closure, round-trip/tamper/scope/TTL/KMS/local-only and audit cases pass.

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

**Interfaces:** `SqliteInvestigationStore` and `SqliteReviewStore` implement the frozen repositories; the integration path exposes only remote Capsule manifests/ciphertext while Runner is offline. Local-only records stay in a separate table/store and are never returned by the remote upload query.

- [ ] **Step 1: Write two end-to-end paths**

Finding→Attempts→Confirmed→BugEpisode; Finding→budget exhausted→Needs Human+ReviewTask. Prestage an encrypted Capsule containing Trace, Graph, Screenshot and Log Summary bytes, disconnect Runner, delete its source Artifact directory, then decrypt and compare all bytes as an authorized Worker. Without prestage assert `evidenceCompleteness:"limited"`. Build a local-only record and assert neither manifest nor upload-queue row exists. Expire a remote Capsule and assert KMS revocation plus audit commit happens before ciphertext deletion; inject revoke failure and assert ciphertext is retained.

```ts
const confirmed = await harness.investigate(reproducibleFinding);
expect(confirmed).toMatchObject({ status: "confirmed", bugEpisodeId: expect.any(String) });
runner.disconnect();
expect(await harness.openCapsule(confirmed.caseId)).toMatchObject({ schemaVersion: "evidence-capsule/v1" });
expect(await harness.recoveredScreenshot(confirmed.caseId)).toEqual(originalScreenshotBytes);
expect(await harness.remoteUploads(localOnlyCase.caseId)).toEqual([]);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/sqlite/investigation-review-store.test.ts tests/component/investigation/offline-capsule-flow.test.ts`

Expected: persistence/integration missing.

- [ ] **Step 3: Implement stores and transactional handoff**

Store Case version/status/budget structured; Attempts/BugEpisode/Handoff/Review/Capsule/Audit append-only; transition Needs Human and create ReviewTask in one transaction. Store protected header, ciphertext and immutable Manifest revision together. Rotation appends a revision with parent revision, actor, reason and old/new key IDs. Expiry first commits successful KMS revocation/audit, then deletes ciphertext in a retryable cleanup step. Store local-only records separately and never hand them to the remote upload repository.

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

Expected: all exit 0; Runner-offline authorized flow works from Capsule-contained bytes after local source deletion; local-only records never upload; revoke precedes delete; no plaintext/DEK appears in logs/database.

- [ ] **Step 5: Commit/status**

```text
git add packages tests docs/superpowers/implementation-status.md
git commit -m "feat(investigation): complete review and evidence loop"
```

## Plan Self-Review

- Spec coverage: state/budgets, Intelligence Result, Attempts/BugEpisode/Handoff, concurrent Review, scope-bound profile, canonical header/AAD, encrypted attachment bytes, explicit local-only branch, revoke-before-delete and offline flow map to Tasks 1–5.
- Placeholder scan: every budget/crypto/concurrency outcome is named.
- Type consistency: Workers submit Results; deterministic handlers update Case/Review; Capsule manifest references ciphertext only.
