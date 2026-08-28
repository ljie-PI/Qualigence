# 34 — Build minimal images, SBOM, provenance, and release manifest

**What to build:** Produce deploy-only immutable application images and a verifiable release manifest binding every binary and Gate artifact to one commit.

**Blocked by:** 33 — Deliver browser E2E and mandatory CI Gates (implementation merge). **Phase-2 release-artifact dependencies:** Ticket 31 signed Windows evidence and Ticket 46 real-provider evidence. Ticket 35 consumes this ticket's immutable artifacts for the final deterministic decision.

**Status:** ready-for-agent

## Tracked scope

Ticket 33 owns mandatory CI/Gate artifacts; this ticket owns deploy-only image construction, SBOM/provenance/attestation, digest-only release Compose, release-manifest schema/generation/verification, and release workflow acceptance. Under the 2026-08-27 two-phase authority, implementation, verifier tests, and non-publishing deterministic validation may complete after Ticket 33 merges. Actual registry publication, signed-manual-evidence binding, and immutable selected-version release-manifest generation occur only during phase 2 on the selected integration candidate; their absence is an explicit blocked release result, never a synthetic pass. Existing production readiness behavior is an input, not editable scope.

## Migration

No relational schema migration is allocated; existing and allocated closure migrations are unchanged. Packaging migrates application, Worker, and Admin runtime images from workspace/source copying to isolated `corepack pnpm deploy --prod` roots. `pnpm-workspace.yaml` and `pnpm-lock.yaml` may change only to enable `injectWorkspacePackages: true` and synchronize that packaging shape with Corepack pnpm 11.7.0; no dependency upgrade is in scope. Release Compose migrates from mutable tags to explicit image name plus `sha256:` digest.

## Affected contexts

- `docs/contexts/deployment/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/intelligence/CONTEXT.md`
- `docs/contexts/product/CONTEXT.md`
- `docs/contexts/protocol/CONTEXT.md`
- `docs/contexts/storage/CONTEXT.md`
- `docs/contexts/windows/CONTEXT.md`

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 3.2, 8-11, 13, 14, and 15.
- `CONTEXT-MAP.md` and every affected context document above.
- The exact Gate artifact contracts produced by ticket 33 and signed manual evidence produced by ticket 31.
- `README.md` as the durable operator-facing release/deployment contract after this ticket; mutable-tag deployment instructions are forbidden.

## Allowed Files

This is the complete edit scope, including exact generated post-review release evidence paths:

- `.scratch/remaining-production-closure/issues/34-release-sbom-provenance-manifest.md` for ticket-local final evidence only
- `.github/workflows/release.yml`
- `Dockerfile`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `deployments/self-hosted/docker/**`
- `deployments/self-hosted/compose/compose.release.yaml`
- `deployments/self-hosted/compose/release-manifest.schema.json`
- `scripts/verify-release-manifest.mjs`
- `tests/release/image-contents.test.ts`
- `tests/release/release-manifest.test.ts`
- `README.md`
- `artifacts/release/<version>/release-manifest.json`
- `artifacts/release/<version>/sbom.spdx.json`

`<version>` is one release-version directory selected for acceptance, not a wildcard permission to modify prior release evidence.

`artifacts/release/<version>/release-manifest.json` is generated atomically by the allowed release workflow and verifier from the schema and evidence above; once generated, it is immutable release evidence rather than a manually editable file.

## Requirements

- [ ] Runtime images contain no source, tests, development store, or dev-only dependencies.
- [ ] Server/Worker/Admin/Console images use immutable digests and produce SPDX plus provenance attestations.
- [ ] Release manifest binds repository, commit, image digests, SBOM hash, attestation IDs, named Gate hashes, and signed Windows evidence hash.
- [ ] Release Compose accepts digest-only references and verifier rejects tags, missing/duplicate/mismatched artifacts, or unsigned evidence.
- [ ] Build stage uses exactly `corepack pnpm --filter @qualigence/server deploy --prod /out/server`, `corepack pnpm --filter @qualigence/intelligence-worker deploy --prod /out/worker`, and `corepack pnpm --filter @qualigence/admin-cli deploy --prod /out/admin`; runtime stages copy only deployed roots and required entrypoints/static Console output.
- [ ] A subsequent `corepack pnpm install --frozen-lockfile` succeeds after the workspace/lock update. Source workspace, pnpm store, test files, root development `node_modules`, and development-only packages are absent from runtime images.
- [ ] Release images and digest-only Compose preserve the existing Server/Worker/Console/proxy healthchecks and readiness semantics; this ticket does not create or weaken a second readiness state machine.
- [ ] BuildKit runs with `--provenance=mode=max --sbom=true`, pushes application and Console images, captures immutable `sha256:` digests from build metadata, emits SPDX JSON, and uses the repository's official artifact-attestation flow.
- [ ] Every third-party release action is pinned to a full commit SHA with a reviewed release-tag comment and least-privilege permissions.
- [ ] The manifest includes schema version, Git commit, repository, application digest, Console digest, SBOM path/SHA-256, provenance/attestation identifier, exact Gate artifact names/SHA-256, and ticket-31 Windows evidence path/SHA-256.
- [ ] Required Gate names are exactly `gate-linux`, `gate-windows-rust`, `gate-self-hosted`, and `browser-e2e`; all bind the same commit as the images/manifest.
- [ ] The verifier rejects mutable tags, non-`sha256:` references, wrong repository/commit, missing files, digest/hash mismatch, duplicate/missing Gate names, stale/cross-commit evidence, and unsigned/mismatched Windows evidence.

## Focused Gate

Run during implementation and after every code/test review fix without publishing images:

```bash
corepack pnpm vitest run tests/release/image-contents.test.ts tests/release/release-manifest.test.ts
corepack pnpm typecheck
git diff --check
```

Also prove `corepack pnpm install --frozen-lockfile` after any workspace/lockfile change before the focused Gate is considered complete.

## Post-review acceptance

- Automated release E2E: on the exact reviewed head, execute `.github/workflows/release.yml` using BuildKit to build and publish immutable application/Console digests with SBOM and provenance/attestations. Generate only `artifacts/release/<version>/sbom.spdx.json` and `artifacts/release/<version>/release-manifest.json` for the selected version.
- Manifest verification: run `corepack pnpm gate:release -- --manifest artifacts/release/<version>/release-manifest.json`. It must download/recompute every named artifact hash, validate image digest/commit/repository, validate attestation and SBOM binding, validate ticket-31 signed evidence hash, and render digest-only release Compose.
- Manual acceptance: N/A. Consume the immutable signed ticket-31 record; do not edit or regenerate it.
- Release acceptance: publication succeeds only if the same-commit `gate-linux`, `gate-windows-rust`, `gate-self-hosted`, and `browser-e2e` artifacts plus signed Windows evidence all validate. Missing infrastructure/evidence is a failed release, not a successful candidate artifact. Record the release workflow URL/run ID, immutable image digests, manifest/SBOM hashes, attestation IDs, and reviewed commit under this ticket's `## Comments`.

## Delivery and review

Record base/reviewed SHAs in `## Comments`. Review Docker contexts, image contents, workflow permissions/pins, readiness transitions, manifest schema/verifier, artifact trust boundaries, and every matrix row. A code/workflow change after release E2E requires focused tests, fresh complete-matrix review, and complete release E2E rerun with new immutable digests. After five rounds with a core blocker, set this ticket to `needs-info`, block ticket 35, and request a maintainer decision. Do not create recursive remediation tickets. Only non-Critical advanced hardening may be deferred as a linked GitHub Issue.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary | Public result | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Frozen install and deploy roots succeed | `started` at install/build workspace creation | Build inputs ready | Lockfile/workspace and isolated deploy trees bind exact commit | Rebuild from clean context; never reuse unverified mutable tree | Frozen-install log and deploy-tree inventory |
| Frozen install/deploy dependency resolution fails | `not_started` for image publication | Stable build failure | No accepted image/manifest | Fix reviewed lock/workspace issue, then clean rebuild | Failed install/deploy report |
| Runtime image contains only allowed production files | `started` at image build | Image-content Gate passes | Immutable local image metadata identifies commit | Rebuild yields content-addressed digest | Forbidden-file/package scan |
| Runtime image contains source/tests/store/dev dependency | `started` | Image-content Gate/release fails | Image is not published/manifested as valid | Fix build context and rebuild; never allowlist broad paths | Exact forbidden path/package evidence |
| Existing Worker/Server/Console/proxy healthchecks report ready in release Compose | `started` at release Compose startup | Readiness succeeds | Release evidence reflects existing production health semantics | Probes are repeatable; ticket 34 does not alter their state machines | Release Compose health report |
| Existing dependency healthcheck fails or shutdown begins | `started` | Release Compose readiness fails | No false-ready release acceptance | Recovery follows the owning component contract | Release Compose failure/recovery evidence |
| BuildKit image/SBOM/provenance creation succeeds | `started` at build/push | Immutable digests and attestation IDs returned | Registry/artifact store holds digest-addressed images, SPDX, provenance | Rerun creates/reuses content-addressed output but emits a new auditable run | Build metadata, digests, attestation refs |
| Build/push cancelled before registry side effect | `not_started` | Release job fails/cancels | No accepted release manifest | Clean rerun | Registry/build metadata absence |
| Build/push/attestation times out after registry side effect | `outcome_unknown` | Release job fails; no release acceptance | Orphan digest may exist but is not referenced by a valid manifest | Reconcile registry/attestation, then rerun; never publish a guessed manifest | Registry lookup and absent/invalid manifest |
| Required Gate/manual artifact missing, duplicated, stale, unsigned, wrong-commit, or hash-mismatched | `not_started` for manifest acceptance | Verifier/release fails with exact reason | No valid release manifest | Regenerate source Gate/evidence correctly; do not substitute artifacts | Negative verifier matrix |
| Mutable tag/non-sha image reference supplied | `not_started` | Verifier/Compose rejects | No deployable release config | Supply immutable digest from build metadata | Rejection and rendered-Compose test |
| Valid manifest generated | `started` at manifest write after all inputs validated | Manifest accepted | One immutable versioned JSON binds repository, commit, digests, SBOM, attestations, Gates, and Windows evidence | Identical semantic replay must produce equivalent bindings; conflicting existing version fails closed | Schema validation and recomputed hashes |
| Duplicate manifest generation for same version with identical inputs | `not_started` or controlled atomic replace before publication | Idempotent verification; no divergent manifest | Existing immutable record remains authoritative | Do not overwrite signed/published evidence with changed bytes | Byte/hash equality evidence |
| Conflicting manifest generation for same version | `not_started` | Stable conflict/failure | Existing manifest retained | Choose a new version only through release policy; never overwrite | Conflict test and retained hash |
| Manifest/SBOM write or upload fails | `outcome_unknown` | Release fails | Partial temp/output is not accepted; no published completion | Recompute all hashes and rerun atomic generation/upload | Missing/invalid artifact and no success marker |
| Attestation service fails after image push | `outcome_unknown` | Release fails | Image digest may exist; manifest cannot validate without attestation | Retry attestation/release workflow against verified digest per official flow; no mutable tag fallback | Registry digest and absent attestation binding |
| Release verifier succeeds | `started` only for reads/downloads; publication already occurred | `gate:release` passes | Valid manifest/reports retained as ticket-35 input | Reverification is read-only and must reproduce hashes | Successful verifier report and workflow run ID |

## Comments

- update - 2026-08-27: Maintainer authorized code-first closure. Ticket 34 implementation stays ordered after Ticket 33. BuildKit publication, final manifest/SBOM/provenance generation, and binding of Ticket 31/46 evidence are deferred to the integrated phase-2 release run; Ticket 35 validates those immutable outputs and makes no premature frozen/release claim.
