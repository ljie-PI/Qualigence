# 33 — Deliver browser E2E and mandatory CI Gates

**What to build:** Add rendered Console product E2E and mandatory fast/Linux/Windows/Self-hosted Gate workflows with immutable action dependencies and named artifacts.

**Blocked by:** 32 — Restore cross-platform quarantines (implementation merge). **Final release-resolution dependencies:** Ticket 31 signed Windows evidence and Ticket 46 real-provider evidence, consumed at final convergence.

**Status:** claimed

## Tracked scope

Ticket 32 owns the four quarantine fixes; ticket 34 owns release image/SBOM/provenance/manifest production. This ticket owns rendered browser acceptance, root non-release Gates, pinned mandatory platform jobs, infrastructure preflight, and named evidence upload. Under the 2026-08-27 two-phase authority, implementation begins only after Ticket 32 merges because both tickets change CI/Gate composition. Missing signed Ticket 31 or real-provider Ticket 46 evidence must remain an explicit final release block in the resulting Gate/metadata contract; it does not authorize a synthetic substitute or prevent this CI implementation from being completed and merged.

## Migration

No relational migration is allocated; existing and allocated closure migrations and persisted product data are unchanged. CI adoption is additive: use Node 24, Corepack pnpm 11.7.0, frozen install, pinned Rust toolchain, and lock-hash caches. Missing Docker, Chromium, OpenSSL, Cargo, Windows, or signed native evidence must exit non-zero with a stable block code; it cannot become a skip or optional success.

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

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 3, 4, 7, 8, 10, 11, 13, 14, and 15.
- `CONTEXT-MAP.md` and every affected context document above.
- `package.json` as the public command surface for `gate:fast`, `gate:linux`, `gate:windows`, `gate:self-hosted`, and the downstream `gate:release` entrypoint.
- Existing Public API/OIDC/Console contracts and required platform test suites; CI does not redefine product semantics.

## Allowed Files

This is the complete edit scope, including the post-review browser/CI acceptance files:

- `.scratch/remaining-production-closure/issues/33-browser-e2e-mandatory-ci.md` for ticket-local final evidence only
- `.github/workflows/ci.yml`
- `.github/workflows/windows-companion.yml`
- `.github/workflows/self-hosted.yml`
- `package.json`
- `tests/e2e/web-console/browser-workflow.test.ts`
- `tests/helpers/server-fixture.ts`
- `tests/helpers/oidc-jwt.ts`
- `tests/helpers/infrastructure-preflight.ts`

Ticket 33 may define `gate:release` only as the stable command entrypoint expected by tickets 34-35; release implementation files and publishing remain outside this scope.

## Requirements

- [ ] Rendered browser flow covers login, Project/PRD/Test Plan/Mission/Run/Review/Skill/Artifact authorization.
- [ ] Root Gates fail with stable infrastructure codes instead of skips.
- [ ] Linux, Windows/Rust, Self-hosted, browser, and release-metadata jobs are required and upload named evidence.
- [ ] Third-party actions are pinned to full commit SHA with reviewed release comments.
- [ ] The browser test builds/serves the React app, uses a real Fastify API and test OIDC provider, drives Chromium through visible routes and controls, and asserts visible UI/navigation rather than substituting `PublicApiClient` calls.
- [ ] The workflow covers OIDC callback, Project and PRD, approved Test Plan/Mission start, Run status, Review concurrency conflict, Skill lifecycle/status, and authorized/denied Artifact access.
- [ ] `gate:fast` runs build/typecheck and pure unit/replay/migration/property/smoke suites. `gate:linux` adds Chromium/OpenSSL and Web E2E. `gate:windows` adds Windows Node tests and `gate:companion`. `gate:self-hosted` requires Docker and runs PostgreSQL/MinIO/Compose/backup/external-Runner acceptance.
- [ ] Linux and Windows assert Node 24 and `corepack pnpm --version` exactly `11.7.0`, run `corepack pnpm install --frozen-lockfile`, and install Chromium with `corepack pnpm --filter @qualigence/web-playwright exec playwright install chromium`.
- [ ] Windows resolves `C:\Program Files\Git\usr\bin\openssl.exe` explicitly when present and otherwise returns `OpenSslUnavailable`.
- [ ] Rust installs `rust-toolchain.toml` and runs fmt/build/test. Self-hosted provisions required Docker services. Cache keys are bound to pnpm/Cargo/Playwright lock inputs.
- [ ] Required job/artifact names are exactly `gate-linux`, `gate-windows-rust`, `gate-self-hosted`, `browser-e2e`, and `release-metadata`; artifacts contain command, commit, counts, environment/tool versions, and hashes.
- [ ] Signed ticket-31 manual evidence is uploaded/referenced, and its absence keeps M3/release verification blocked rather than making the CI implementation itself optional.

## Focused Gate

Run during implementation and after every code/test review fix:

```bash
corepack pnpm vitest run tests/component/web-console/workflow.test.ts
corepack pnpm typecheck
git diff --check
```

Workflow syntax/render checks required by changed workflow files are part of the focused implementation tests and must not provision external CI before review.

## Post-review acceptance

- Automated browser E2E: run `corepack pnpm vitest run tests/e2e/web-console/browser-workflow.test.ts` with real Chromium, React, Fastify, and test OIDC processes. `ChromiumUnavailable` is a block, not a skip.
- Automated CI-equivalent Gates: run `corepack pnpm gate:fast` locally; then execute the exact reviewed commit through `.github/workflows/ci.yml`, `.github/workflows/windows-companion.yml`, and `.github/workflows/self-hosted.yml`. Require successful named jobs/artifacts `gate-linux`, `gate-windows-rust`, `gate-self-hosted`, `browser-e2e`, and `release-metadata` with matching commit SHA.
- Manual acceptance: N/A. Consume ticket 31's signed evidence; do not regenerate or sign it.
- Release acceptance: no image publication. The release-metadata job validates the availability, names, commit binding, and hashes of prerequisite Gate/manual artifacts for ticket 34. Record the accepted job URLs/run IDs, artifact hashes, and reviewed commit under this ticket's `## Comments`. Missing/mismatched evidence blocks ticket 34.

## Delivery and review

Record base and reviewed SHAs in `## Comments`. Review every workflow permission, action pin, secret boundary, Gate command, browser process boundary, and matrix row. A code/test/workflow change after E2E requires affected focused checks and a fresh complete-matrix review before E2E/CI reruns. After five rounds with a core blocker, set this ticket to `needs-info`, block tickets 34-35, and request a maintainer decision. Do not create recursive remediation tickets. Only non-Critical advanced hardening may be deferred as a linked GitHub Issue.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary | Public result | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Rendered login-to-Artifact workflow succeeds | `started` at test OIDC/API/UI process startup and product mutations | Browser E2E passes | Isolated fixture records expected product state and audit/evidence references | Whole isolated workflow may rerun with fresh tenant/project IDs | Visible UI assertions, API/audit state, process cleanup |
| OIDC token/signature/nonce/tenant/role invalid | `not_started` for protected mutation | Safe authentication/authorization failure in UI | No protected product mutation; transient auth state cleaned | Corrected fresh login only; callback replay rejected | Browser-visible denial and server audit evidence |
| Stale expected version/concurrent Review claim | `not_started` for losing mutation | Public conflict with actual version and visible reload state | Winning mutation remains authoritative | Semantic replay/conflict handling follows public contract | Two-browser/request conflict evidence |
| Artifact authorization denied | `not_started` for plaintext/evidence return | Safe denied response/UI | No plaintext or unauthorized Artifact bytes emitted | Retry only after valid authorization; no cached bypass | Network/UI assertion and secret scan |
| Browser/server/OIDC setup fails before workflow | `not_started` | Stable setup/infrastructure failure | No passing browser artifact | Retry after provisioning; no skip conversion | Failed E2E report and cleaned processes |
| Browser/API timeout before product command dispatch | `not_started` | Stable timeout/failure | No fabricated product success | Whole isolated scenario may rerun | Request/command absence and cleanup evidence |
| Timeout/disconnect after product command dispatch | `outcome_unknown` until authoritative read | Browser test reconciles by idempotency/authoritative state, never blindly resubmits a conflicting command | Actual domain/idempotency state remains authoritative | Same idempotency key may be replayed only per public contract | Reconciliation response and no duplicate aggregate |
| Duplicate workflow/job delivery for same commit | `started` independently | Deterministic duplicate CI run | Separate immutable artifacts bind the same commit | Rerun is allowed; artifacts never merge across commits | Run IDs and matching SHA/hashes |
| Required infrastructure absent | `not_started` | `ChromiumUnavailable`, `OpenSslUnavailable`, `DockerUnavailable`, `CargoUnavailable`, or `Windows11Unavailable`; job fails | No successful Gate artifact | Retry only after provisioning | Stable code in failed job |
| Required test is skipped/quarantined | `not_started` for accepted Gate | Gate fails | Artifact records failure, never green | Remove skip/fix authority; rerun complete Gate | Zero-skip enforcement output |
| Third-party action is mutable/unpinned or workflow permission is excessive | `not_started` for accepted CI | Validation/review failure | Workflow cannot produce accepted release evidence | Pin/restrict, review, rerun | Workflow diff/pin verification |
| Linux Gate succeeds | `started` | `gate-linux` success | Immutable report includes commit/tool versions/counts/hashes | Rerun yields a new artifact for same exact commit | Named artifact hash |
| Windows/Rust Gate succeeds | `started` | `gate-windows-rust` success | Native/platform report and signed-evidence reference bind commit | Rerun on exact commit allowed; no synthetic substitution | Named artifact plus Rust/native counts |
| Self-hosted Gate succeeds | `started` at Docker provisioning | `gate-self-hosted` success | Compose/DB/object-store/Runner reports bind commit | Teardown then fresh isolated rerun | Named artifact and clean teardown |
| Browser E2E succeeds | `started` | `browser-e2e` success | Browser report binds commit and screenshots/logs remain redacted | Fresh isolated rerun | Named artifact and secret scan |
| Job cancelled before product/Gate dispatch | `not_started` | Cancelled job, not success | No valid named Gate artifact | Rerun whole job | Absent success artifact |
| Job cancelled/times out after side-effecting E2E dispatch | `outcome_unknown` | Failed/cancelled job | Partial artifact is not accepted | Recreate clean environment and rerun whole job; never infer success | Teardown/reconciliation and failed job |
| Artifact upload/hash/terminal job-status write fails | `outcome_unknown` for release evidence | Job fails | No accepted named artifact, even if tests ran | Rerun complete job; do not hand-assemble success | Missing/mismatched artifact blocks release |

## Comments

- update - 2026-08-27: Maintainer authorized code-first closure. Ticket 33 remains implementation-blocked by Ticket 32, not by human/provider evidence. Its implementation PR must preserve explicit failing/blocking behavior for absent final evidence; Ticket 35 consumes the real final evidence after Ticket 31 and Ticket 46 complete.
- start - 2026-08-28: Fixed base `c22c4650ffd7319e15ac27647859697d548989f4`; branch/worktree `ticket-33-browser-e2e-mandatory-ci` / `C:/Users/jieliu1/AppData/Local/Temp/pi-ticket-33`. Ticket 32 implementation is merged, satisfying this ticket's implementation dependency. Under the 2026-08-27 two-phase authority, complete Ticket 33 code/workflow/browser implementation and deterministic automated evidence may proceed, while Ticket 31 signed Windows evidence and Ticket 46 real-provider evidence remain final release-resolution inputs, never synthetic substitutes. Behavior Matrix: all rows are applicable; none is N/A. Planned focused Gate: `tests/component/web-console/workflow.test.ts`, typecheck, diff check, plus workflow syntax/render validation; post-review browser E2E and exact reviewed commit CI artifacts remain required.
