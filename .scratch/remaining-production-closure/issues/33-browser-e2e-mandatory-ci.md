# 33 — Deliver browser E2E and mandatory CI Gates

**What to build:** Add rendered Console product E2E and mandatory fast/Linux/Windows/Self-hosted Gate workflows with immutable action dependencies and named artifacts.

**Blocked by:** 32 — Restore cross-platform quarantines (implementation merge). **Final release-resolution dependencies:** Ticket 31 signed Windows evidence and Ticket 46 real-provider evidence, consumed at final convergence.

**Status:** claimed

## Tracked scope

Ticket 32 owns the four quarantine fixes; ticket 34 owns release image/SBOM/provenance/manifest production. This ticket owns rendered browser acceptance, root non-release Gates, pinned mandatory platform jobs, infrastructure preflight, and named evidence upload. Under the 2026-08-27 two-phase authority, implementation begins only after Ticket 32 merges because both tickets change CI/Gate composition. Missing signed Ticket 31 or real-provider Ticket 46 evidence must remain an explicit final release block in the resulting Gate/metadata contract; it does not authorize a synthetic substitute or prevent this CI implementation from being completed and merged.

## Migration

No relational migration is allocated; existing and allocated closure migrations and persisted product data are unchanged. CI adoption is additive: use Node 24, Corepack pnpm 11.7.0, frozen install, pinned Rust toolchain, and lock-hash caches. Missing Docker, Chromium, OpenSSL, Cargo, or Windows must exit non-zero with its stable infrastructure block code; it cannot become a skip or optional success. Under the approved two-phase authority, absent signed Ticket 31 evidence or real-provider Ticket 46 evidence is represented in the phase-1 `release-metadata` artifact as structured `release-blocked` metadata using `WindowsChecklistEvidenceUnavailable` and/or `RealProviderEvidenceUnavailable`; the metadata job may succeed only because it truthfully reports the block. Ticket 34 publication/manifest verification and Ticket 35 freeze validation must reject that blocked metadata, so it never constitutes release success. `Windows11Unavailable` remains reserved for a missing Windows 11 prerequisite, not a missing signed checklist.

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
- `apps/web-console/src/config.ts` — maintainer-approved 2026-08-28 single-file scope amendment: defensive built-browser `import.meta.env` absence handling needed by the test-owned runtime configuration proxy; existing runtime validation, OIDC authority, and security semantics remain unchanged.
- `apps/web-console/src/app.tsx` — maintainer-approved 2026-08-28 single-file scope amendment: serialize/deduplicate React StrictMode duplicate processing of one OIDC callback without weakening one-use authorization-code, PKCE, state, nonce, redirect URI, or token-verification behavior, and without adding token persistence.
- `apps/web-console/src/auth/oidc-session.ts` — maintainer-approved 2026-08-28 single-file scope amendment: bind the default browser `fetch` dependency so member invocation preserves the browser receiver; all existing OIDC protocol verification and security semantics remain unchanged.
- `apps/web-console/src/api/client.ts` — maintainer-approved 2026-08-28 scope extension, limited to existing Public API v1 Artifact metadata/authorized-byte client methods and reuse of existing PRD/Mission commands; no storage/KMS client or public contract change.
- `apps/web-console/src/routes/router.tsx`
- `apps/web-console/src/routes/query-keys.ts`
- `apps/web-console/src/features/projects/project-page.tsx` — visible PRD ingestion control using the existing Public API command only.
- `apps/web-console/src/features/projects/prd-plan-page.tsx` — maintainer-approved 2026-08-28 single-file scope amendment: read-only display of the existing PRD DTO identity required to author valid grounded Test Plan `sourceRefs` through visible UI; no API/DTO/persistence/authorization change.
- `apps/web-console/src/features/missions/mission-page.tsx` — visible Mission start control using existing expected-version/idempotency command behavior only.
- `apps/web-console/src/features/evidence/artifact-page.tsx` — new minimal visible Artifact metadata/authorized-download/denial surface; no new authorization model.
- `tests/component/web-console/product-intake-pages.test.ts` — directly affected visible-control coverage.
- `tests/unit/runner/job-executor.test.ts` — maintainer-approved 2026-08-28 Gate remediation: encrypted Runner Spool test fixture only.
- `tests/unit/benchmark-runner/run.test.ts` — maintainer-approved 2026-08-28 Gate remediation: explicit unverified edit-time test-double setup only.
- `apps/cli/src/config.ts` and `tests/unit/cli/config.test.ts` — maintainer-approved 2026-08-28 Gate remediation: preserve required finite positive model-token ceiling while providing stable missing/non-numeric configuration diagnostics and coverage.
- `tests/unit/runner-kernel/deterministic-policy-gate.test.ts` — maintainer-approved 2026-08-28 Gate remediation: update stale assertions to the existing immutable Plan/`ExternalSideEffect` policy only.
- `tests/unit/local-launcher/process-supervisor.test.ts` — maintainer-approved 2026-08-28 Gate remediation: only an isolated-evidence-backed test deadline consistent with existing bounded reap behavior; any production lifecycle change remains outside scope.
- `tests/smoke/node-entrypoints.test.ts` — maintainer-approved 2026-08-28 Gate remediation: current fail-closed configuration validation order assertions only.
- `tests/e2e/web-execution/multi-step-plan.test.ts` — maintainer-approved 2026-08-28 review-1 remediation: encrypted test spool fixture only; maintainer-approved 2026-08-28 sensitive-evidence remediation: safe failure-boundary diagnostic and same-document multi-step regression coverage.
- `packages/target-adapters/web-playwright/src/browser-session.ts`, `packages/target-adapters/web-playwright/src/playwright-action-executor.ts`, and `packages/target-adapters/web-playwright/src/playwright-observer.ts` — maintainer-approved 2026-08-28 sensitive-evidence remediation: retain an already-completed host-owned sensitive form-to-mask/backend-node binding only as long as later same-document evidence can fully revalidate it.
- `packages/target-adapters/web-playwright/src/sensitive-evidence-authority.ts` — maintainer-approved 2026-08-28 sensitive-evidence remediation only if the minimal explicit retained-binding validation primitive is necessary.
- `tests/e2e/web-execution/value-ref.test.ts`, `tests/component/web-execution/playwright-click.test.ts`, `tests/component/web-execution/playwright-observation.test.ts`, `tests/unit/target-adapters/web-playwright/action-resolution.test.ts`, and `tests/unit/target-adapters/web-playwright/browser-session.test.ts` — maintainer-approved 2026-08-28 direct positive multi-record retention and negative fail-closed/sink coverage.
- `tests/component/web-execution/reflected-secret-evidence.test.ts`, `tests/component/web-execution/shadow-dom-scheduler-log.test.ts`, `tests/component/web-execution/promise-owner-snapshot.test.ts`, `tests/component/web-execution/promise-owner-integrity.test.ts`, `tests/component/web-execution/cdp-screenshot-masking.test.ts`, and `tests/component/web-execution/promise-native-oracle.test.ts` — maintainer-approved 2026-08-28 cross-ticket sensitive-evidence reconciliation: retain coverage while aligning only assertions superseded by later accepted authority and proving active lifecycle defects are corrected.
- `tests/e2e/windows/companion-client.test.ts` and `tests/component/windows-uia/reference-app-pipeline.test.ts` — maintainer-approved 2026-08-28 review-1 remediation: deterministic nonmanual Windows Gate selection and stale fixture correction only; Ticket 31 human acceptance remains excluded from phase-1 Gate selection, not skipped.
- `tests/e2e/self-hosted/compose.test.ts`, `tests/e2e/self-hosted/evidence-api.test.ts`, and `tests/e2e/self-hosted/external-runner-harness.ts` — maintainer-approved 2026-08-28 review-1 remediation: test fixture corrections preserving existing Ticket 13/15 contracts only.
- `tests/helpers/gate-evidence.ts` and `tests/unit/helpers/gate-evidence.test.ts` — maintainer-approved 2026-08-28 review-1 remediation: test/CI-only scoped zero-skip and accepted-artifact verifier.
- `tests/unit/admin-cli/migrate.test.ts` and `tests/e2e/self-hosted/admin-cli-migrate.test.ts` — maintainer-approved 2026-08-28 review-1 remediation: relocate a Docker-only test from fast selection to executed Self-hosted selection, without deletion/skip.

Ticket 33 may define `gate:release` only as the stable command entrypoint expected by tickets 34-35; release implementation files and publishing remain outside this scope. The Console extension is limited to rendered workflow requirements already in this ticket: no backend endpoint, DTO, persistence, KMS, direct storage, or authorization-policy change is authorized. The Gate remediation extension is limited to restoring the required pre-existing pure-suite Gate: it must not remove/narrow its directory selection, add a skip, default/relax a finite budget, weaken encryption/OIDC/policy/ownership, alter protocol/public/persisted contracts, change dependencies/migrations/workflows, or implement Ticket 11/16/20/21/32/34/46.

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
- scope — 2026-08-28: Maintainer approved the smallest Console scope required for Ticket 33 rendered acceptance: existing Public API v1 client calls plus visible PRD ingestion, Mission start, and Artifact authorization route/page/control behavior in the explicitly listed Console files and direct component tests. This does not authorize backend/DTO/persistence/KMS/direct-storage/authorization-policy changes. Browser direct fetch/API-client substitution is prohibited for asserted user interactions.
- authority — 2026-08-28: Maintainer clarified phase-1 `release-metadata`: it may succeed only by emitting a structured `release-blocked` report identifying absent Ticket 31/Ticket 46 evidence with `WindowsChecklistEvidenceUnavailable` / `RealProviderEvidenceUnavailable`. Such metadata is CI evidence of a block, not release success; Ticket 34/35 must reject it. `Windows11Unavailable` denotes only missing Windows 11 infrastructure.
- scope — 2026-08-28: Maintainer approved `apps/web-console/src/config.ts` as a single-file addition after the actual built Console crashed before login because browser `import.meta.env` was absent under the test-owned static runtime-config proxy. The permitted correction is only a defensive env fallback (for example `meta.env ?? {}`); it must not alter runtime-config validation, OIDC authority, API/DTO contracts, or security behavior.
- scope — 2026-08-28: Maintainer approved `apps/web-console/src/app.tsx` as a single-file addition after real Chromium showed React StrictMode executing the OIDC callback effect twice: the first one-use code exchange correctly succeeded while the replay correctly failed and reset the UI to the login gate. The permitted correction is only effect serialization/deduplication for the same callback; it must preserve one-use code, PKCE, state, nonce, redirect URI, token verification, no-token-persistence, and existing API/security contracts.
- scope — 2026-08-28: Maintainer approved `apps/web-console/src/auth/oidc-session.ts` as a single-file addition after real Chromium proved that the default detached global `fetch` dependency failed before token POST when invoked as a member. The permitted correction is only a bound/default wrapper that preserves the browser fetch receiver. It must preserve authorization-code one-use, PKCE S256, state, nonce, redirect URI, token/JWKS verification, token-storage behavior, and existing API/security contracts.
- scope — 2026-08-28: Maintainer approved `apps/web-console/src/features/projects/prd-plan-page.tsx` as a single-file addition after real Chromium proved that a valid Test Plan `sourceRefs` must contain the server-assigned PRD UUID but the visible PRD page exposed only title/revision/hash. The permitted correction is read-only display of the identity already present in the existing DTO, so the browser flow reads it from rendered UI rather than seeding a known PRD value. No API/DTO/persistence/authorization change is permitted.
- blocker/scope — 2026-08-28: After `corepack pnpm typecheck`, required `gate:fast` suite selection reproduced exactly 21 failures / 877 passes / 898 tests at both fixed base `c22c4650ffd7319e15ac27647859697d548989f4` and implementation head `6cb7ee0720f6b6166f89da3bdbd11fee1c046e17`; the unbuilt-base missing-dist/import result was discarded as non-comparable. Maintainer approved only the explicitly listed fixture/assertion/CLI-diagnostic remediation files to restore this required Gate. The authority prohibits narrowing the Gate, skips, budget/encryption/policy/ownership relaxation, contract changes, unrelated production remediation, and any Local Launcher production lifecycle change. Isolated focused evidence must prove every proposed correction before final Gate rerun.
- scope — 2026-08-28: Following review-1, maintainer approved the explicitly listed Gate/browser/self-hosted/Windows fixture and CI-composition remediation files to complete every applicable Ticket 33 matrix row: bounded test deadline; encrypted test spool; deterministic nonmanual Windows selection while preserving Ticket 31 as phase-2 evidence; stale test fixtures only for Companion and Self-hosted Ticket 13/15 contracts; selection-scoped zero-skip/terminal-artifact verifier; Docker test relocation into the executed Self-hosted Gate; test-only issuer/proxy failure evidence; normal browser route navigation; and Artifact Blob cleanup. No production contract/seam change is authorized.
- standing authority — 2026-08-28: Maintainer authorizes further **similar, bounded Ticket 33 test/fixture/CI-composition remediation** that is necessary to satisfy this ticket's frozen required Gate and behavior matrix, provided it preserves existing product/security behavior and remains within Ticket 33 implementation authority. This does not authorize a new architecture seam; public/persisted/protocol/security contract; production lifecycle, policy, ownership, KMS/storage, or OIDC semantic change; dependency/migration change; narrowing/deleting/skipping a Gate test; Ticket 31/46 human/provider execution; Ticket 34 release work; or synthetic evidence. Any such boundary must stop for a specific maintainer decision.
- scope/authority — 2026-08-28: Maintainer approved a narrow production sensitive-evidence lifecycle correction for the reproduced same-document multi-step Chromium regression at `9a06c255c62abadf10c8230c578431946e430335`. It may retain only an already-completed host-owned input/select form-to-mask/backend-node binding for later same-document ordinary observations when every existing authority revalidates it. Ticket 39–45 limits and captured-intrinsic/DOM/CDP authority, one-recapture/second-race handling, zero plaintext in Graph/Trace/Artifact/log/Spool/model/PNG sinks, and `SensitiveEvidenceUnavailable` with zero newly accepted Graph/Artifact bytes on any uncertainty are mandatory and unchanged. No cross-session retention, protocol/public/persisted/storage/KMS/OIDC/Plan/policy/budget change is authorized.
- acceptance — 2026-08-28: Maintainer accepts the existing test-side in-session SPA route transition solely to prove an authenticated real server cross-tenant Artifact `404`/no-plaintext result while the Console token remains intentionally memory-only. The browser evidence must additionally use a hard `page.goto` reload to prove that no token persists and the resulting Login UI/response contains no plaintext. This does not authorize a production cross-tenant link, redirect-state seam, token persistence, or direct API substitute.
- scope/authority — 2026-08-28: Maintainer approved bounded cross-ticket Ticket 39–45 sensitive-evidence reconciliation at `6b27571a98bbdaf6b6b066e45c661eff18a7efb0`: production changes are limited to `browser-session.ts`, `playwright-action-executor.ts`, `playwright-observer.ts`, and `sensitive-evidence-authority.ts` only when strictly necessary; directly affected existing Ticket 39–45 unit/component/Chromium E2E tests may change. The correction must remove temporary page markers/listeners/records before dispatch when authorization/abort prevents dispatch; preserve the Ticket 44 unsafe owner latch across same-session navigation until close; make Ticket 45 hidden-to-visible classified regions succeed only after fully revalidated host/CDP masking with at most one recapture; and make Ticket 41 scheduler accounting deterministic at 1,024/4,096 while native callbacks still execute. Only stale assertions superseded by Ticket 41 below-bound scheduler/open-Shadow success authority may be aligned. No changed limits/global matching/cross-session retention/fail-closed weakening, test/Gate narrowing/skip, Plan/policy/budget/protocol/public/persisted/storage/KMS/OIDC/dependency change, Ticket 31/46 work, or release/freeze claim is authorized.
- authority — 2026-08-28: Maintainer resolves the post-retirement equal-text conflict in favor of later Ticket 45 fail-closed authority. A later same-page untrusted reflection of a host-known `valueRef` form without current trusted marker/mask/backend-node authority must produce `SensitiveEvidenceUnavailable`; genuinely unrelated nonmatching content remains ordinary. Updated tests must prove both predicates and retain zero-plaintext sink scans.
- scope — 2026-08-28: While verifying the approved OIDC binding in real Chromium, the first protected Console Public API call exposed the identical detached-default-fetch receiver failure in the already-approved `apps/web-console/src/api/client.ts`. Maintainer approved the smallest matching correction: bind only its default global fetch dependency, preserve injected custom fetch behavior and all Public API/DTO/auth/error contracts, and cover it through the real rendered workflow.
