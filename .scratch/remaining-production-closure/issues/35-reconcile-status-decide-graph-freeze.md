# 35 — Reconcile tracked closure and decide Graph freeze

**What to build:** Reconcile the authoritative local tickets, architecture/contexts, merged GitHub PR/Issue evidence, and serialized Graph/native/release evidence, then deterministically decide whether Observation Graph v1 remains `candidate` or becomes `frozen`.

**Blocked by:** 34 — Build minimal images, SBOM, provenance, and release manifest.

**Status:** ready-for-agent

## Tracked scope

This ticket owns final closure reconciliation and the deterministic Graph freeze decision. Current closure state comes from tickets 01-35, durable architecture/contexts, current contracts and tests, checklists, merged GitHub PR/Issue records, and serialized evidence artifacts.

## Migration

No relational migration is allocated; existing and allocated closure migrations and historical pre-v1 payloads remain immutable. The evidence migration is additive and deterministic:

- Read every tracked closure ticket under `.scratch/remaining-production-closure/issues/*.md`; require the canonical 01-35 dependency graph to be resolved by merged PR evidence and classify every later remediation/hardening record by current status, parent ticket, merge evidence, and blocking/non-blocking authority.
- Resolve each ticket's PR URL, reviewed code head, remote head, merge commit, Gate/E2E evidence, and any deferred non-blocking GitHub Issue; unresolved or contradictory state becomes an explicit blocker.
- Read serialized candidate migration, Web/Desktop schema conformance, native Windows, signed manual checklist, mandatory CI, SBOM/provenance, and release-manifest records from exact versioned paths.
- Validate paths, schemas, signatures, commit/repository/version binding, artifact names, and SHA-256 hashes from bytes. Caller-supplied booleans, untracked prose, and synthetic fixture claims are not evidence.
- Emit a versioned `graph-freeze-decision.json` atomically. Missing/invalid/contradictory input produces `candidate` plus exact blockers; only complete valid input produces `frozen`.

## Affected contexts

- `docs/contexts/deployment/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/intelligence/CONTEXT.md`
- `docs/contexts/product/CONTEXT.md`
- `docs/contexts/protocol/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`
- `docs/contexts/windows/CONTEXT.md`

## Authority

These are the durable authorities and evidence sources:

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 3-15, especially 6.2-6.5, 7, 9.2, 13, 14.3, and 15.
- `CONTEXT-MAP.md` and all affected context documents above.
- `.scratch/remaining-production-closure/spec.md` and every tracked ticket under `.scratch/remaining-production-closure/issues/*.md` for current dependency/status/acceptance state. Tickets after 35 do not alter the canonical graph unless a maintainer explicitly promoted them; they must still be reconciled rather than ignored.
- `docs/testing/observation-graph-v1-freeze-checklist.md` and `docs/testing/windows-m3-manual-checklist.md` for candidate/freeze and signed security-veto requirements.
- `packages/contracts/observation/schemas/observation-graph-v1.schema.json` and current public Graph/Runner/Desktop contracts.
- Merged GitHub Pull Requests and GitHub Issues in `ljie-PI/Qualigence`, queried by URL/API and bound to repository, reviewed head, merged head/commit, required checks, and deferred-hardening disposition.
- Serialized evidence under `artifacts/manual-acceptance/<version>/**` and `artifacts/release/<version>/**`, including the ticket-34 release manifest and its named Gate/SBOM/provenance/native/manual inputs.

## Allowed Files

This is the complete edit/output scope. The tracked `.scratch` tickets are read-only inputs except this ticket itself.

- `.scratch/remaining-production-closure/issues/35-reconcile-status-decide-graph-freeze.md`
- `docs/testing/observation-graph-v1-freeze-checklist.md`
- `docs/testing/windows-m3-manual-checklist.md`
- `README.md`
- `packages/observation-migration/src/freeze-decision.ts`
- `packages/observation-migration/src/freeze-gate.ts`
- `packages/observation-migration/src/index.ts`
- `tests/migration/observation-v1/freeze-decision.test.ts`
- `tests/migration/observation-v1/freeze-gate-report.test.ts`
- `artifacts/release/<version>/graph-freeze-decision.json`

`<version>` is the exact release version selected from ticket 34. `artifacts/release/<version>/release-manifest.json`, all other serialized release/native/manual/Gate inputs, all prior local tickets, and GitHub records are read-only evidence. Reading them is required; editing them is not permitted merely to make freeze pass.

## Requirements

- [ ] Every capability records component, production wiring, verification, blocker, exact command, commit, and evidence artifact in the serialized decision/report, with the public result summarized in README/checklist.
- [ ] Undefined or untracked `implemented` claims and evidence contradictions are reconciled without rewriting evidence history.
- [ ] Freeze decision reads serialized migration, Web/Desktop schema, native Windows, signed checklist, CI, and release-manifest evidence and rejects synthetic booleans.
- [ ] Graph remains `candidate` unless every required input validates; release documentation matches the deterministic decision.
- [ ] Every tracked closure ticket has internally consistent status/dependencies/TODOs and, when resolved, cites its merged PR URL/merge commit and exact reviewed/Gate/E2E evidence; incomplete work remains unchecked.
- [ ] Only the authorities and evidence sources listed above may influence ticket-35 completion.
- [ ] Architecture/context invariants agree with the selected release contracts; any contradiction is an explicit `candidate` blocker requiring its owning authority change, not an invisible ticket-35 rewrite.
- [ ] GitHub evidence proves every required ticket PR is merged into the selected release commit, remote code/test diff matches its reviewed head except an allowed documentation-only evidence commit, required checks passed, and deferred Issues are non-blocking advanced hardening rather than unresolved core blockers.
- [ ] The freeze decision reads serialized bytes for candidate migration inventory/report, Graph schema/version, Web/Desktop conformance, ticket-29/30 native reports, ticket-31 signed local-console/RDP evidence, ticket-33 named CI/browser artifacts, and ticket-34 release manifest/SBOM/provenance/attestations.
- [ ] Every serialized input is schema/version validated, SHA-256 recomputed, path-confined, repository/commit/version bound, non-duplicated, non-stale, and classified as real rather than synthetic evidence.
- [ ] Signed Windows evidence retains distinct operator/reviewer, exact checklist version, local and RDP scenarios, every required Section 16 veto as pass, no failed item, exact commit/version/environment, evidence refs, and the hash bound by the release manifest.
- [ ] Required CI artifacts are exactly `gate-linux`, `gate-windows-rust`, `gate-self-hosted`, and `browser-e2e`; each passes, has zero forbidden skips, and binds the selected commit. Native/manual reports cannot be replaced by portable/synthetic tests.
- [ ] Candidate migration has every active pre-v1 Trace/Skill classified as migrated, deprecated, or needs-human with source hashes/provenance, zero unexplained failures, immutable historical payloads, and verified/reclassified active Skills.
- [ ] Web and Desktop validate the same `observation-graph/v1` schema and required shared core fields; `uia/v1` remains lossless and incompatible extension/Graph majors are explicitly rejected.
- [ ] `graph-freeze-decision.json` is atomic, versioned, deterministic from serialized evidence, lists every capability status, evidence path/hash, and blocker, and contains signoff only when frozen.
- [ ] Graph remains `candidate` and README/checklist say candidate whenever any required ticket, authority, GitHub record, serialized input, signature, hash, native/manual/CI/release artifact, or final Gate is absent/invalid. No incomplete checkbox is checked.
- [ ] Graph becomes `frozen` only when every input validates; the decision references the immutable release-manifest hash and both bind the same release commit/version without a hash cycle. Historical pre-v1 payloads remain immutable; projections and recompiled Skill records retain provenance.

## Focused Gate

Run during implementation and after every code/test review fix:

```bash
corepack pnpm vitest run tests/migration/observation-v1/freeze-decision.test.ts tests/migration/observation-v1/freeze-gate-report.test.ts
corepack pnpm typecheck
git diff --check
```

Tests must deserialize real fixture files and cover missing, malformed, duplicated, path-escaping, stale, synthetic, unsigned, cross-commit, hash-mismatched, failed-veto, unexplained-migration, schema-major, native-report, CI-artifact, SBOM/provenance, release-manifest, GitHub-status, and terminal-write cases. In-memory booleans alone do not satisfy the Gate.

## Post-review acceptance

Only after exact-base complete-matrix review has no core Critical or Important finding:

- Automated final Gates: run `corepack pnpm gate:fast`, `corepack pnpm gate:self-hosted`, `corepack pnpm benchmark:detection`, and `corepack pnpm gate:release -- --manifest artifacts/release/<version>/release-manifest.json` on/against the selected release commit. Recompute all referenced SHA-256 values and validate required remote GitHub checks/artifacts rather than pretending one host executed every platform.
- Automated decision: execute the reviewed freeze Gate against the selected serialized inputs and atomically write `artifacts/release/<version>/graph-freeze-decision.json`; rerun the focused tests against that exact artifact. If any validation or final Gate is absent/failed, the artifact must be `candidate` with exact blockers.
- Manual acceptance: do not rerun or modify ticket 31. Validate the independently signed record's bytes, identities, local/RDP coverage, veto outcomes, commit/version, refs, and release-manifest hash.
- Release acceptance: verify the release workflow/manifest, image digests, SBOM/provenance/attestation, named platform/browser Gate hashes, signed Windows evidence hash, benchmark result, and freeze decision all bind the same repository/version/commit. Update `README.md` and the Graph checklist to exactly the deterministic decision. A `candidate` result is an honest non-completion and keeps this ticket/deployment milestone open; it is not a release success.

## Delivery and review

Record base/reviewed SHAs, evidence version, and decision artifact hash in `## Comments`. Review the whole code/test/doc diff, every authority/evidence source, and every Behavior Matrix row. Any code/test change after final Gates requires affected focused tests and a fresh complete-matrix review before all final Gates/decision are rerun. After five rounds with a core blocker, set this ticket to `needs-info`, record exact blockers, and request a maintainer scope/ownership decision. Do not create recursive remediation tickets. Record only non-Critical advanced hardening as a linked GitHub Issue. Do not resolve this ticket or check any incomplete requirement when the deterministic result is `candidate`.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary | Public result | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| All tickets, authority, GitHub, migration, schema, native/manual, CI, benchmark, and release evidence validate | `started` only at atomic decision-artifact write after read-only validation | `frozen` | Versioned decision binds every path/hash, repository/version/commit, signoff, and zero blockers | Same bytes produce the same semantic decision; no re-execution of product/native actions | Frozen decision hash, final Gate reports, release manifest |
| Any required tracked ticket is unresolved, dependency-blocked, lacks merged PR evidence, or has unchecked acceptance | `not_started` | `candidate` with ticket-specific blocker | Candidate decision/status docs retain exact open item; no frozen signoff | Re-evaluate after the owning ticket validly resolves | Ticket/PR/dependency inventory |
| Ticket says resolved but GitHub PR is unmerged, wrong repo/base/head/diff, missing checks, or not in release ancestry | `not_started` | `candidate` with GitHub mismatch | No trusted closure for that ticket | Refresh remote evidence; never trust local prose alone | GitHub API/PR/check/ancestry record |
| Core blocker is hidden as deferred Issue or deferred Issue is Critical | `not_started` | `candidate` | Blocking Issue reference retained | Owning ticket/maintainer resolves classification; no automatic remediation ticket | Issue severity/authority audit |
| Untracked prose disagrees with tracked evidence | `not_started` | Ignore it as authority; record ambiguity only if it affects a durable contract | No evidence rewrite and no freeze inference from untracked prose | Resolve through ticket/architecture/public contract owners if substantive | Source classification report |
| Candidate migration report missing/malformed/stale/hash-mismatched/has unexplained failure or unclassified active asset | `not_started` | `candidate` with exact migration blocker | Historical payloads unchanged; candidate artifact records failure | Rerun migration through owning workflow; never alter history here | Serialized report validation and source hashes |
| Web/Desktop schema evidence missing, mismatched, synthetic, or incompatible major | `not_started` | `candidate` | No compatibility promise | Produce real conformance through owning ticket; no boolean override | Serialized conformance reports/schema hash |
| Native Named Pipe/UIA report missing, skipped, non-Windows, synthetic, stale, or failing | `not_started` | `candidate` | No native-completion claim | Rerun tickets 29/30 on exact commit/environment | Native report/tool/environment validation |
| Windows checklist unsigned, same-person signed, incomplete, stale, hash-mismatched, lacks local/RDP, or has failed/not-run veto | `not_started` | `candidate` with exact manual blocker | Signed/failed record remains immutable; no signoff in decision | New human acceptance after reviewed fix; never synthesize/patch pass | Checklist bytes/hash/item/signature validation |
| Required CI/browser artifact missing, skipped, duplicated, failed, wrong name/hash/commit | `not_started` | `candidate` | No release/freeze acceptance | Rerun owning Gate on exact commit | Named artifact validation |
| SBOM/provenance/attestation/image digest/release manifest missing or mismatched | `not_started` | `candidate` | No deployable/frozen release claim | Rerun ticket 34 release workflow; do not repair evidence in place | Manifest/verifier report |
| Final fast/Self-hosted/benchmark/release Gate fails or infrastructure is unavailable | `not_started` | `candidate` with Gate/stable environment blocker | Failed Gate evidence retained | Rerun complete Gate after valid fix/provisioning | Exact command, artifact, and failure code |
| Duplicate evidence paths or conflicting records claim the same identity/version | `not_started` | `candidate` with conflict | No arbitrary winner selected | Owning producer emits one unambiguous versioned record | Duplicate/conflict validation test |
| Path escape/symlink/unsafe external input is referenced | `not_started` | `candidate`/invalid evidence | No out-of-root read is trusted or included | Correct manifest/evidence path through owner | Path-confinement test |
| Evidence changes between validation and decision write | `not_started` or write aborted | `candidate`/validation failure; never frozen from mixed snapshot | No accepted frozen artifact; temp output removed | Re-read and hash one coherent snapshot | Snapshot/hash race test |
| Cancel/timeout before decision write | `not_started` | No new accepted decision; current public status remains candidate | Existing decision, if any, unchanged | Safe full revalidation/retry | Atomic temp cleanup and unchanged prior hash |
| Cancel/timeout or I/O failure during atomic decision write | `outcome_unknown` until path/hash checked | No frozen claim unless complete file validates | Prior valid file retained or new complete file verified; partial file rejected | Revalidate all inputs and atomically rewrite; never infer success | Failure-injection and file/hash check |
| Duplicate invocation with identical immutable inputs | `not_started` or atomic equivalent write | Same semantic `candidate`/`frozen` decision | No contradictory second decision | Idempotent; timestamp policy must not alter evidence validity | Byte/semantic determinism test |
| Conflicting invocation for an already frozen version/commit | `not_started` | Stable conflict; no downgrade/overwrite | Existing immutable frozen decision retained | New release/version required through owning release process | Conflict test and retained hash |
| README/checklist update fails after decision artifact write | `outcome_unknown` for public release status | Ticket/release remains incomplete; do not announce frozen | Decision artifact may exist but public acceptance is blocked until consistent reviewed commit | Reconcile docs on same ticket, rerun diff/focused review and final validation | Consistency check across artifact/README/checklist |
