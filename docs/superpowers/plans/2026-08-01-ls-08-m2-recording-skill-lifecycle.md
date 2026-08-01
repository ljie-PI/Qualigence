# [LS-08] M2 Recording and Procedure Skill Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record approved Web actions, compile source-grounded Procedure Skills, verify/sign/version them, and replay intent safely.

**Architecture:** Recording is immutable Runner output; Skill is a Core aggregate; model induction returns only a Proposal; deterministic Compiler/Verifier/Signer produce executable Bundles; Runner replay accepts only valid signed Verified/Promoted versions.

**Tech Stack:** TypeScript, Model Gateway, Zod, Node Ed25519 crypto, SQLite providers, Vitest/Replay tests.

**Direct Dependencies:** LS-04 and LS-07.

## Global Constraints

- No recorded password/plain secret; use `valueRef`.
- No CSS/XPath/coordinates in a Skill.
- Every executable Bundle is signed; signing failure has no unsigned fallback.
- State transitions use expectedVersion and idempotency; versions are immutable.
- Tests stay under top-level `tests/`.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

### Task 1: Record immutable approved action sequences

**Files:**

- Create: `packages/runner-components/recording/package.json`
- Create: `packages/runner-components/recording/tsconfig.json`
- Create: `packages/runner-components/recording/src/recording-session.ts`
- Create: `packages/runner-components/recording/src/recording-recorder.ts`
- Create: `packages/runner-components/recording/src/index.ts`
- Test: `tests/unit/runner-components/recording/recording-recorder.test.ts`

**Interfaces:** Produces `RecordingSession`, `RecordedStep`, `RecordedSemanticNode`, `RecordedCheckpoint` exactly as the Design Spec.

- [ ] **Step 1: Write acceptance/rejection tests**

```ts
recorder.start(meta);
recorder.record(approvedStep);
expect(recorder.complete()).toMatchObject({ steps: [{ ordinal: 1 }] });
try {
  recorder.record(unpermittedStep);
  expect.unreachable("unpermitted action must fail");
} catch (error) {
  expect(error).toMatchObject({ code: "RecordingActionNotAuthorized" });
}
```

Assert incomplete/cancelled recording cannot be induction input and input values are `valueRef` only.

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/runner-components/recording`

Expected: recording package missing.

- [ ] **Step 3: Implement recorder state**

Use `idle|recording|completed|cancelled`; accept events only after Policy authorization and successful outcome; require monotonic ordinals/before-after Graph refs; hash checkpoint normalized state.

```ts
export class RecordingRecorder {
  record(input: ApprovedActionResult): void {
    assertRecording(this.state);
    assertAuthorizedSuccess(input);
    this.steps.push(toRecordedStep(input, this.steps.length + 1));
  }
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 1 command; expect state/auth/secret/hash cases pass.

- [ ] **Step 5: Commit**

```text
git add packages/runner-components/recording tests/unit/runner-components/recording
git commit -m "feat(skill): record approved web procedures"
```

### Task 2: Implement Skill aggregate and lifecycle

**Files:**

- Create: `packages/core-modules/skill/package.json`
- Create: `packages/core-modules/skill/tsconfig.json`
- Create: `packages/core-modules/skill/src/domain/test-skill.ts`
- Create: `packages/core-modules/skill/src/domain/skill-bundle.ts`
- Create: `packages/core-modules/skill/src/ports/skill-repository.ts`
- Create: `packages/core-modules/skill/src/ports/skill-signer.ts`
- Create: `packages/core-modules/skill/src/public.ts`
- Create: `packages/core-modules/skill/src/index.ts`
- Test: `tests/unit/core-modules/skill/test-skill.test.ts`

**Interfaces:** Produces `ProcedureSkillVersion`, `SkillStep`, `SkillBundleManifest`; states draft→candidate→verified→promoted/deprecated.

- [ ] **Step 1: Write transition/version tests**

Create draft; compile once; reject promotion before verify; verify; promote; deprecate; reject state reversal. Same idempotency returns prior result; stale expectedVersion returns `SkillVersionConflict`; modifications create version N+1.

```ts
const skill = TestSkill.draft(draftInput);
expect(() => skill.promote(commandAt(skill.currentVersion()))).toThrow("SkillNotVerified");
skill.markCandidate(candidate); skill.verify(evaluation); skill.promote(commandAt(skill.currentVersion()));
expect(skill.state()).toBe("promoted");
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/core-modules/skill/test-skill.test.ts`

Expected: Skill aggregate missing.

- [ ] **Step 3: Implement deterministic aggregate**

No model call/repository inside entity. Record source Recording IDs/schema epoch/locator/compiler/content hash. Keep historical versions addressable and prevent deprecated versions from new dispatch.

```ts
export class TestSkill {
  promote(command: PromoteSkillCommand): SkillTransition {
    this.assertExpectedVersion(command.expectedVersion);
    if (this.current.state !== "verified") throw skillError("SkillNotVerified");
    return this.transition("promoted", command.idempotencyKey);
  }
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 2 command; expect legal/illegal/idempotent/version paths pass.

- [ ] **Step 5: Commit**

```text
git add packages/core-modules/skill tests/unit/core-modules/skill/test-skill.test.ts
git commit -m "feat(skill): add versioned skill lifecycle"
```

### Task 3: Implement induction Proposal and deterministic Compiler

**Files:**

- Create: `packages/runner-components/model-agent/src/skill-induction-agent.ts`
- Create: `packages/core-modules/skill/src/application/skill-compiler.ts`
- Modify: `packages/contracts/model-provider/src/index.ts`
- Modify: `packages/runner-components/model-agent/src/index.ts`
- Test: `tests/unit/runner-components/model-agent/skill-induction-agent.test.ts`
- Test: `tests/unit/core-modules/skill/skill-compiler.test.ts`

**Interfaces:** Adds `skill.induction`; Agent returns `SkillInductionProposal`; `SkillCompiler.compile(recording, proposal)` returns Candidate payload using the exact `SkillParameter`, `SkillAssertion` and `ProposedSkillStep` unions from the Design Spec.

- [ ] **Step 1: Write Proposal/compiler tests**

Valid proposal parameterizes cart quantity and emits semantic target/checkpoint. Reject nonexistent recording refs, CSS/XPath/coordinates, unknown action, raw input secret and unstable nodeId as executable locator.

```ts
const candidate = compiler.compile(recording, validInductionProposal);
expect(candidate.parameters[0]?.valueRef).toBe("test-data.cart.quantity");
expect(() => compiler.compile(recording, selectorProposal)).toThrow("SelectorLeakRejected");
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/runner-components/model-agent/skill-induction-agent.test.ts tests/unit/core-modules/skill/skill-compiler.test.ts`

Expected: operation/Agent/Compiler missing.

- [ ] **Step 3: Implement strict boundaries**

Agent uses strict Zod output and no Repository. Compiler validates source hashes, generates stable step IDs, carries source node only as provenance, canonicalizes JSON and computes content SHA-256.

```ts
export class SkillCompiler {
  compile(recording: RecordingSession, proposal: SkillInductionProposal): SkillCandidate {
    assertProposalReferences(recording, proposal);
    assertNoExecutableSelectors(proposal);
    return candidateFrom(recording, proposal, canonicalSha256);
  }
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 3 command; expect Proposal schema and all deterministic rejection cases pass.

- [ ] **Step 5: Commit**

```text
git add packages/contracts/model-provider packages/runner-components/model-agent packages/core-modules/skill tests/unit
git commit -m "feat(skill): induce and compile procedure skills"
```

### Task 4: Implement Local signing and Registry checks

**Files:**

- Create: `packages/storage-providers/kms-local/package.json`
- Create: `packages/storage-providers/kms-local/tsconfig.json`
- Create: `packages/storage-providers/kms-local/src/local-skill-signer.ts`
- Create: `packages/storage-providers/kms-local/src/index.ts`
- Create: `packages/core-modules/skill/src/application/skill-promotion-policy.ts`
- Test: `tests/contract/kms-local/skill-signing.test.ts`
- Test: `tests/unit/core-modules/skill/skill-promotion-policy.test.ts`

**Interfaces:** `LocalSkillSigner.sign/verify`; Promotion policy accepts only complete evaluation and valid signature.

- [ ] **Step 1: Write crypto/policy failures**

Generate key, sign canonical Bundle, verify; mutate one byte/wrong key/expired/revoked/cross-project and assert exact rejection. Force signer failure; assert Bundle is not saved executable.

```ts
const signed = await signer.sign(bundle);
expect(await signer.verify(signed, projectScope)).toEqual({ status: "valid" });
await expect(signer.verify(tamper(signed), projectScope)).resolves.toMatchObject({ status: "invalid", code: "SkillSignatureInvalid" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/kms-local/skill-signing.test.ts tests/unit/core-modules/skill/skill-promotion-policy.test.ts`

Expected: signer/policy missing.

- [ ] **Step 3: Implement Ed25519 signing**

Create user-only key file atomically; keyId=SHA-256 public key prefix; sign canonical manifest-without-signature + payload hash; use Node crypto verify; keep private key bytes outside logs/database.

```ts
export class LocalSkillSigner implements SkillSigner {
  async sign(bundle: UnsignedSkillBundle): Promise<SignedSkillBundle> {
    const payload = canonicalSigningPayload(bundle);
    return attachSignature(bundle, this.keyId, sign(null, payload, this.privateKey));
  }
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 4 command; expect tamper/scope/revocation/failure tests pass.

- [ ] **Step 5: Commit**

```text
git add packages/storage-providers/kms-local packages/core-modules/skill tests/contract/kms-local tests/unit/core-modules/skill/skill-promotion-policy.test.ts
git commit -m "feat(skill): sign and promote local skill bundles"
```

### Task 5: Verify and replay intent

**Files:**

- Create: `packages/core-modules/skill/src/application/skill-verifier.ts`
- Create: `packages/runner-components/skill-replay/package.json`
- Create: `packages/runner-components/skill-replay/tsconfig.json`
- Create: `packages/runner-components/skill-replay/src/skill-replay-controller.ts`
- Create: `packages/runner-components/skill-replay/src/index.ts`
- Test: `tests/replay/procedure-skill/cart-procedure.test.ts`
- Test: `tests/replay/procedure-skill/divergence.test.ts`

**Interfaces:** Verifier produces immutable evaluation; Replay controller executes only signed Verified/Promoted Bundle and re-observes each checkpoint.

- [ ] **Step 1: Write four Replay oracles**

Two normal runs pass; changed DOM order/text still locates by semantics; unsatisfied precondition returns `PlanDiverged` before action; tampered Candidate Bundle returns `SkillSignatureInvalid` before Target access.

```ts
expect((await replay.run(verifiedBundle, normalTarget)).status).toBe("passed");
expect((await replay.run(verifiedBundle, changedDomTarget)).status).toBe("passed");
expect((await replay.run(verifiedBundle, divergentTarget))).toMatchObject({ status: "blocked", errorCode: "PlanDiverged" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/replay/procedure-skill`

Expected: verifier/replay missing.

- [ ] **Step 3: Implement step loop**

Verify Bundle scope/signature/state first; for each step capture, check preconditions, resolve semantic target, authorize, execute, recapture/check checkpoint; `reobserve` occurs once, then stop. Save divergence evidence.

```ts
for (const step of bundle.steps) {
  const before = await target.capture();
  const resolved = await resolver.resolve(step.target, before);
  await policy.authorize(toActionRequest(step, resolved));
  await target.execute(toResolvedAction(step, resolved));
  await assertCheckpoint(step.checkpoint, await target.capture());
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 5 command; expect all four oracles pass deterministically.

- [ ] **Step 5: Commit**

```text
git add packages/core-modules/skill packages/runner-components/skill-replay tests/replay/procedure-skill
git commit -m "feat(skill): verify and replay procedure skills"
```

### Task 6: Persist and close lifecycle Gate

**Files:**

- Create: `packages/storage-providers/sqlite-runtime/src/migrations/003-skill.ts`
- Create: `packages/storage-providers/sqlite-runtime/src/sqlite-skill-store.ts`
- Test: `tests/contract/sqlite/skill-store.test.ts`
- Test: `tests/component/skill-lifecycle/recording-to-replay.test.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/index.ts`
- Modify: `docs/superpowers/implementation-status.md`

**Interfaces:** `SqliteSkillStore` implements the frozen `SkillRepository`; migration 003 persists immutable versions, evaluations, signed Bundles and revocations without persisting signing private keys.

- [ ] **Step 1: Write reopen/full-flow test**

Recording→Proposal→Candidate→evaluation→Verified→signed→Promoted→reopen→Replay. Assert all revisions/evaluations/Bundle/revocation/source refs remain and no private key/plain secret is in DB.

```ts
const promoted = await lifecycle.complete(recording);
const reopened = await openSkillStore(databaseFile);
expect(await reopened.version(promoted.skillId, promoted.version)).toMatchObject({ state: "promoted" });
expect(readFileSync(databaseFile).includes(privateKeyBytes)).toBe(false);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/sqlite/skill-store.test.ts tests/component/skill-lifecycle/recording-to-replay.test.ts`

Expected: migration/store missing.

- [ ] **Step 3: Implement six logical tables/store**

Use structured ID/version/state/hash/key columns and versioned JSON payload; optimistic expected version; immutable evaluations/Bundle; revocation append only.

```ts
await db.transaction().execute(async (trx) => {
  await updateSkillVersion(trx, command.skillId, command.expectedVersion, nextVersion);
  await appendSkillEvent(trx, nextEvent);
  await appendBundleRevision(trx, immutableBundle);
});
```

- [ ] **Step 4: Run LS-08 Gate**

```text
pnpm build
pnpm test
pnpm typecheck
pnpm smoke:node-imports
pnpm vitest run tests/replay/procedure-skill tests/component/skill-lifecycle
git diff --check
```

Expected: all exit 0 and only valid signed Verified/Promoted Bundles execute.

- [ ] **Step 5: Commit/status**

```text
git add packages tests docs/superpowers/implementation-status.md
git commit -m "feat(skill): complete recording skill lifecycle"
```

## Plan Self-Review

- Spec coverage: recording, aggregate/version, induction/compiler, signature/promotion, verifier/replay, persistence and security map to Tasks 1–6.
- Placeholder scan: every transition, negative oracle, file and command is explicit.
- Type consistency: Recording→Proposal→Candidate→Evaluation→signed Bundle→Replay is one directional chain.
