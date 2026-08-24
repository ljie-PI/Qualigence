# Remaining Production Closure: Tasks 12-22

Status: ready-for-agent

## Problem Statement

Qualigence has completed its deterministic Local execution authority through Task 11 and its required execution policy/project provenance through Task 15, but the remaining production loop is incomplete. Team Self-hosted cannot yet schedule a Mission into a tenant-bound external Runner and consume its Result through the same deterministic application model; the Runner still executes only one Web action on the legacy Observation Graph; Desktop jobs cannot traverse the production Runner/Companion path; the Windows Companion remains non-native; and CI/release evidence is not strong enough to declare production completion or freeze Observation Graph v1.

The remaining work must preserve the approved open-source architecture: Core and deterministic Application Services remain the only business-state writers; Runner and Intelligence Worker submit protocol events/results rather than mutating aggregates; Local and Self-hosted share domain/application contracts; tenant isolation is explicit in Self-hosted; transport adapters stay thin; unknown side effects fail closed; Evidence security revokes access before deleting ciphertext; and Graph v1 remains `candidate` until serialized Web/Desktop/native/manual/release evidence passes.

The tracked ticket set is the current execution authority. Each ticket carries its own dependencies, migration allocation, contexts, Files scope, focused Gate, post-review acceptance, behavior matrix, status, and final evidence so no parallel plan or status ledger is required.

## Solution

Complete production closure through two dependency-ordered implementation lanes and a release convergence phase.

Lane A completes Team Self-hosted. It adds the product/API scheduling loop, durable tenant wakeups and Intelligence Result application, tenant-bound Runner protocol composition, resumable Artifact upload, and a final LS-11 deployment closure for Evidence APIs, S3/KMS, JWKS rotation, observability, migration/backup/restore, and real Compose acceptance.

Lane B completes bounded execution, closes LS-09 residuals, migrates every live observer/consumer to Observation Graph v1, wires Desktop targets and the TypeScript Companion client, then implements the native Windows Named Pipe, UIA worker, Job Object host, and Companion daemon with real Windows evidence.

The lanes converge at release engineering: remove platform quarantines, add Linux/Windows/Self-hosted/browser Gates, harden runtime images, generate SBOM/provenance/release manifests, reconcile all status documents, and freeze Graph v1 only when every serialized prerequisite is valid.

## User Stories

1. As a Community Local user, I want Local to continue using an implicit `local` tenant, so that single-user operation stays simple without weakening shared application contracts.
2. As a Self-hosted administrator, I want every request, store operation, Runner connection, Result, Artifact, and log to carry explicit tenant scope, so that tenant isolation is enforceable and auditable.
3. As a tester, I want to create a Mission from an approved Test Plan and Target revision, so that execution uses immutable reviewed inputs rather than mutable latest state.
4. As a tester, I want a Mission to bind an explicit Runner ID, so that dispatch is deterministic and never silently switches machines.
5. As a tester, I want Mission start to be idempotent, so that retries return the original Runs and do not create duplicate attempts.
6. As a tester, I want stale Mission starts to return an expected-version conflict, so that concurrent planning changes cannot be overwritten.
7. As a Self-hosted user, I want Mission, Run, Trace, Test Plan, and Skill APIs to be available through the Public API, so that the Console reflects the real product state.
8. As a Self-hosted user, I want Skill promotion and deprecation to execute domain transitions, so that HTTP requests cannot bypass signatures, evaluation, or version rules.
9. As a Mission dispatcher, I want scheduling to atomically persist Mission state, Run, attempt, outbox, provenance, and wakeup, so that crashes never leave partial dispatch authority.
10. As a Mission dispatcher, I want an offline Runner to leave work durably pending for that same Runner, so that execution is deterministic and recoverable.
11. As a Mission dispatcher, I want capability mismatch to block explicitly rather than select another Runner, so that policy and target compatibility are never downgraded.
12. As a Self-hosted operator, I want schema upgrades to run offline through Admin CLI with a fresh target-bound backup, so that every persisted deployment can be recovered.
13. As a Self-hosted operator, I want every released schema version to migrate forward one version at a time, so that upgrades never skip required transformations.
14. As an Intelligence Worker, I want durable leases with renewal, attempts, owner binding, and expiry, so that Worker crashes cannot create duplicate aggregate effects.
15. As an Intelligence Worker, I want to append only Intelligence Results, so that I never receive aggregate mutation authority.
16. As a Server, I want to apply Intelligence Results through deterministic aggregate handlers, so that model proposals cannot bypass policy, budget, idempotency, or expected versions.
17. As a Server, I want applied, duplicate, rejected, and recompute Result dispositions to be durable, so that Results are neither lost nor processed forever.
18. As a Server operator, I want payload-free tenant wakeups with leases, fencing, bounded batches, and backoff, so that one tenant cannot monopolize or busy-spin the consumer.
19. As a Self-hosted Runner, I want one mTLS endpoint compatible with Local Runner Protocol, so that only endpoint and enrolled certificate differ between deployments.
20. As a Self-hosted Runner, I want my authenticated tenant/project/capability scope checked before Job payload admission, so that I cannot receive unauthorized work.
21. As a Self-hosted Server, I want a tenant-bound Runner application graph resolved from authenticated identity, so that no global or expired transaction-backed store crosses tenants.
22. As a Runner registry, I want connections keyed by tenant and Runner ID, so that identical Runner IDs in different tenants cannot collide.
23. As a Runner, I want Artifact manifests and chunks to upload resumably and idempotently, so that large evidence survives reconnects without entering Trace payloads.
24. As Core, I want to ACK an Artifact only after bytes and manifest are durable and hash-verified, so that Trace references never point at missing evidence.
25. As a lost-lease Runner, I want to finish uploading only Artifacts whose manifests were durably registered while I owned the Run, so that lost work cannot create new evidence authority.
26. As a Self-hosted user, I want Run completion to atomically update the matching Run, attempt, logical Job, and Mission, so that terminal state is consistent across projections.
27. As a Self-hosted operator, I want readiness to reflect PostgreSQL, object storage, KMS, OIDC, Runner gRPC, dispatch, Result consumption, and Console dependencies, so that an open port is never mistaken for service readiness.
28. As a Self-hosted operator, I want a real Compose acceptance test with an external Runner, so that production wiring is proven rather than simulated in process.
29. As a Runner, I want immutable multi-step plans containing navigate, click, input, select, scroll, and verify steps, so that the model cannot invent unapproved action kinds.
30. As a Runner, I want each action and Trace event bound to a plan step index, so that execution provenance is auditable.
31. As a Runner, I want deterministic step, time, token, and output budgets, so that execution remains bounded even when providers retry or omit usage.
32. As a Runner, I want missing model usage reported as `ModelUsageUnavailable`, so that a finite token budget cannot silently become unlimited.
33. As a Runner, I want `ActionValueProvider` to resolve input values inside a configured root with traversal, symlink, permission, and size checks, so that secrets cannot escape their intended scope.
34. As a user, I want input plaintext excluded from Trace, Finding, logs, and public DTOs, so that value references do not leak credentials.
35. As a Web Target, I want stale graph descriptors invalidated after state-changing actions, so that a previous observation cannot authorize a later click or input.
36. As a benchmark operator, I want exploration to execute its seed Skill, persist checkpoints, resume after crash, enforce recovery budget, and use real model usage, so that benchmark results represent the specified controller.
37. As a release reviewer, I want the Reference benchmark to execute the frozen Reference Model Profile rather than a fixture walker, so that release thresholds constitute real model evidence.
38. As an observer, I want all live Web and Desktop observations represented as Observation Graph v1, so that one contract serves every target.
39. As a Web observer, I want a typed `web/v1` extension containing origin, path, title, viewport, and allowlisted redacted query keys, so that Web state remains useful without exposing query values.
40. As a Graph consumer, I want semantic set fields sorted canonically while business-order fields retain order, so that hashes are stable without destroying sequence meaning.
41. As a Runner, I want Graph v1 and extension capabilities negotiated explicitly, so that incompatible schema majors fail rather than silently degrade.
42. As a migration operator, I want every active pre-v1 Trace and Skill classified as migrated, deprecated, or needs-human, so that historical assets are never silently abandoned.
43. As a Desktop test author, I want a typed Desktop Target transported losslessly through Core and Runner Protocol, so that every AppTarget field reaches the intended Runner.
44. As a Runner, I want a bounded authenticated Companion client with request correlation, frame limits, deadlines, and connection failure semantics, so that Desktop IPC cannot corrupt execution state.
45. As a Runner, I want target-specific runtime resources selected through one Target Runtime Factory, so that Web and Desktop implementations cannot accept each other's actions.
46. As a Desktop user, I want Runner to resolve `valueRef`, bind plaintext hash and length into the Permit/action digest, and transmit only a bounded short-lived value, so that Companion cannot execute an unbound secret.
47. As Companion, I want to verify the plaintext hash/length, consume the one-use Permit, execute, and clear the value buffer, so that sensitive values cannot be replayed.
48. As a Windows administrator, I want Companion's Named Pipe restricted to current logon SID and LocalSystem, so that remote or other-user processes cannot connect.
49. As Companion, I want to verify client PID, token SID, interactive session, image, allowlist, certificate chain, EKU, SAN, fingerprint, and challenge signature, so that local pipe access alone is insufficient authority.
50. As a Runner operator, I want Companion proof to use the existing Runner mTLS certificate profile with ECDSA P-256 or RSA-PSS, so that no second Runner identity system is introduced.
51. As a Desktop user, I want UIA work executed in a bounded restartable MTA child, so that a hung COM call does not destroy Companion authority.
52. As a Desktop user, I want applications launched suspended, assigned to a Job Object, and then resumed, so that process lifecycle is contained from first instruction.
53. As a Desktop user, I want reset and shutdown to verify image, creation time, and Job membership, so that PID reuse cannot terminate unrelated processes.
54. As a Desktop user, I want Emergency Stop to cancel in-flight work and reject all later actions until a new session, so that stop is an authoritative latch.
55. As a security reviewer, I want permit binding to include action, value hash/length, decision, policy, session, run, expiry, and nonce, so that authorization cannot be replayed or substituted.
56. As a Windows release reviewer, I want real WPF and WinUI scenarios on a local interactive Windows 11 session plus required RDP cases, so that native completion is not inferred from synthetic fixtures.
57. As a Windows release reviewer, I want two-person signed checklist evidence with every security veto, so that native acceptance is independently reviewed.
58. As a maintainer, I want the four Windows quarantines restored with separate Linux and Windows evidence, so that required platform Gates contain no hidden skips.
59. As a Console user, I want a rendered-browser E2E covering login through Mission, Run, Review, Skill, and Artifact authorization, so that the UI is proven independently of API client tests.
60. As a CI maintainer, I want explicit fast, Linux, Windows, Self-hosted, and release Gates, so that each environment produces a named mandatory artifact.
61. As a CI maintainer, I want required infrastructure absence reported as stable failure codes, so that Docker, OpenSSL, Chromium, Cargo, or Windows evidence cannot become silent skips.
62. As a release engineer, I want minimal production images built from deploy roots, so that source, tests, stores, and development dependencies are absent.
63. As a release engineer, I want images addressed by immutable digests with SBOM and provenance attestations, so that releases are reproducible and auditable.
64. As a release engineer, I want a schema-validated release manifest binding commit, image digests, SBOM, attestations, Gate hashes, and Windows evidence, so that release metadata cannot be assembled from unrelated artifacts.
65. As an Evidence owner, I want lifecycle `active -> revoking -> revoked -> deleting -> deleted`, so that ciphertext is never deleted before access is revoked.
66. As an Evidence owner, I want revoke failure to retain ciphertext and delete failure to retain a revoked auditable record, so that retries remain fail closed.
67. As a maintainer, I want every capability status recorded independently as component, production wiring, verification, blocker, and exact evidence, so that `implemented` never substitutes for proof.
68. As a release reviewer, I want Graph v1 to remain `candidate` until serialized migration, Web/Desktop schema, native Windows, manual, and release evidence all validate, so that freeze cannot be manufactured from booleans.
69. As an open-source user, I want Local and Self-hosted to pass the same end-to-end product scenarios, so that deployment choice does not change domain semantics.
70. As a contributor, I want every remaining Task delivered through RED, focused Gate, typecheck, diff check, status update, and scoped exact-base review, so that future work does not repeat historical scope drift.

## Implementation Decisions

- The open-source architecture, security invariants, public contracts, existing domain interfaces/contracts, affected context documents, this umbrella spec, and the selected tracked ticket form implementation authority in that order.
- Community Local uses an implicit `local` tenant supplied by composition. Team Self-hosted always uses explicit tenant scope, even in a single-node local-network deployment.
- Complete LS-11 architecture exit is required. Tasks 12-14 deliver the core Self-hosted product/data plane; an explicit LS-11 closure follow-up delivers remaining Evidence API, S3/KMS composition, remote JWKS rotation, metrics/OTLP, backup/restore proof, real Compose acceptance, and status reconciliation.
- PostgreSQL production adapters belong in the PostgreSQL storage runtime module, not Server route/application modules.
- PostgreSQL schema upgrades are offline, owner-role, backup-gated, target-bound, and strictly sequential across every persisted release. Runtime Server/Worker roles have no DDL authority.
- A Self-hosted Runner connection resolves through a tenant application resolver. Application graphs may be cached by tenant, but each store operation opens a short tenant transaction; no connection holds a long-lived transaction and no unscoped business store is exposed.
- Self-hosted Mission/Target state binds an approved Test Plan revision, Target ID/version/snapshot hash, project ID, and explicit Runner ID. HTTP never supplies executable policy, plan selectors, or generated execution IDs.
- Mission scheduling atomically reserves idempotency, creates Runs/attempts/outbox/provenance/wakeup, and changes aggregate state. Semantic replay returns original IDs without calling allocators.
- Runner selection is deterministic: work waits for its bound Runner. Another Runner is never selected implicitly.
- Intelligence Worker leases and Result dispositions are durable. Worker submits proposals only. Server applies Results through deterministic aggregate application handlers.
- Artifact upload is part of Task 14's Runner data plane. It is an independent resumable manifest/chunk/ACK protocol with 256 KiB chunks, hash/size verification, tenant/project/run binding, and Runner Spool recovery. Trace references only durably ACKed Artifacts.
- Lease-lost Runner identity may finish only Artifacts whose manifests were registered while ownership was live; it cannot create new manifests or execute new actions.
- Tenant-local Artifact deduplication is allowed; cross-tenant physical/logical deduplication is forbidden.
- Task 16 extends immutable Plan steps to navigate, click, input, select, scroll, and verify. The model may choose only current-graph node IDs and narrowly permitted parameters; it cannot choose action kind, selectors, URLs, or plaintext values.
- `select` uses a Plan-owned `valueRef`; `scroll` uses an optional semantic target plus fixed direction and `small|page` amount. Arbitrary pixels and model-provided option text are forbidden.
- Deterministic execution budgets own step count, wall-clock, provider output limit, and model token usage. Missing usage is an infrastructure error rather than zero usage.
- Terminal classification is fixed: budget/policy denial is blocked, missing model usage is error, unknown action outcome is error/no automatic retry, and malformed plan is rejected before queue/offer.
- Task 16 provides shared budget/model-usage infrastructure. A separate LS-09 closure task completes seed Skill replay, checkpoint resume, recovery budget, and a real Reference Model benchmark before Task 21.
- Graph v1 canonicalization sorts semantic sets (`nodes`, `relations`, `rootNodeIds`, Graph evidence references) by stable keys. Business-order fields retain order. Extensions must explicitly identify set-valued arrays; unspecified arrays preserve order.
- `web/v1` contains origin, pathname, title, viewport, and only Target-policy-allowlisted query keys. Query values are fixed redaction markers and fragments are omitted. Graph hashes use the redacted representation.
- Graph v1 remains `candidate` after Task 17; only Task 22 may freeze it from validated serialized evidence.
- Runner resolves Desktop input values through the Task 16 value provider. Permit/action digest binds `valueRef`, value SHA-256 and byte length. IPC carries bounded short-lived plaintext only; Companion verifies and clears it. Trace/logs carry no plaintext.
- Companion challenge-response reuses the existing Runner mTLS identity and supports ECDSA P-256/SHA-256 and RSA-PSS/SHA-256 according to the certificate key. Certificate chain, expiry, clientAuth EKU, SAN, fingerprint and Runner scope are validated before proof acceptance.
- Companion owns UIA/process/permit state. Named Pipe identity, Job Objects, worker restart, action-bound one-use permits, Emergency Stop, and `uiAccess=false` are native Windows responsibilities.
- Evidence lifecycle is fixed as `active -> revoking -> revoked -> deleting -> deleted`. Revocation succeeds before deletion starts. Revoke failure retains ciphertext; delete failure retains revoked retryable state; audit failure fails sensitive operations closed.
- Runtime Lane and Self-hosted Lane may proceed in parallel, but shared contract/protocol/storage-schema changes merge serially. The closure schema sequence is `010-skill-lifecycle-commands` (ticket 06), `011-exploration-attempt-progress` (ticket 20), `012-intelligence-leases-results` (ticket 07), `013-intelligence-result-wakeups-dispositions` (ticket 08), `014-artifact-upload` (ticket 11), and `015-evidence-lifecycle` (ticket 13). Ticket 20 may not merge schema work before ticket 06; ticket 07 may not merge schema work before ticket 20. Both lanes must complete before release Tasks 21-22.
- Current executable frontier is tickets 05, 06, and 22 in isolated branches/worktrees. After 06 resolves, ticket 20 may start; after 22 resolves, ticket 23 may start. Ticket 07 waits for 05, 06, and 20 because of both product dependencies and serialized storage schema. Ticket 24 waits for 21 and 23; tickets 32-35 are final convergence after 15, 21, and 31. The `Blocked by` line in each ticket remains the authoritative dependency edge; this paragraph only records the current parallelization plan.
- Every Task stays within an approved exact Files scope. If implementation needs a new architectural seam or file, the plan is amended and reviewed before editing.

## Testing Decisions

- Every ticket is delivered on its own branch and through exactly one dedicated pull request. A pull request may not combine multiple tickets, even when their implementation ran in parallel. Parallel tickets use isolated branches/worktrees and merge shared contract, protocol, plan, or status files serially.
- Do not create a pull request while implementation, review fixes, or E2E are still in progress. After the implementation and complete-matrix review are clean, required E2E passes, and final status evidence is committed, create one non-draft pull request. The PR head may differ from the reviewed code head only by a final documentation-only evidence commit. Verify the remote code/test diff equals the reviewed code/test diff, then merge directly after required remote checks. If code or tests change after review or E2E, rerun focused tests, complete-matrix review, and E2E before merge.
- A ticket remains `claimed` until its dedicated pull request is merged. After merge, the ignored local ticket records the PR URL and merge commit and becomes `resolved`; then its remote/local branches and worktree are deleted. No second closure PR is created solely to record the merge SHA.
- Before editing a stateful, side-effecting, concurrent, retrying, timeout-sensitive, or terminal workflow, freeze an applicable behavior matrix in the local ticket under `## Behavior Matrix`. Its columns are: scenario/precondition, side-effect boundary (`not_started | started | outcome_unknown`), public result/error, durable state, retry/replay rule, and terminal evidence. Cover success, validation/auth/policy/capability rejection, timeout/cancel before and after dispatch, unknown outcome, idempotent replay, conflicting replay, concurrency/restart, and terminal persistence failure where applicable. Mark genuinely inapplicable rows `N/A` with a reason. The tracked `start` ledger entry records matrix applicability and points to the local ticket. Docs-only, static mapping, and simple leaf changes may declare the matrix `N/A`.
- Each ticket follows one review protocol. During implementation and review-fix rounds, run focused unit tests plus relevant functional, contract, component, property, or replay tests. Do not provision or run the ticket's external E2E environment during routine code edits.
- After a scoped exact-base `/code-review` reports no core Critical or Important findings, provision the required E2E environment and run the ticket's E2E Gate. If E2E failure requires a code change, rerun focused non-E2E tests and a fresh complete-matrix `/code-review`; rerun E2E only after that review is clean.
- A review round is one exact-head Standards and Spec review after a committed implementation or fix. Every round reviews the complete applicable behavior matrix and the whole code/test diff, not only previous findings. The review report contains a `Behavior Matrix Coverage` section listing every row as `pass | finding | N/A`, with each `N/A` reason, plus the reviewed head SHA. Append the round number, reviewed head, and core findings to the local ticket's `## Comments`; documentation-only commits do not count as review rounds.
- Classify each finding before fixing it. A **core blocker** violates an explicit ticket acceptance criterion, an existing documented architecture/security invariant applicable to the feature, a public/persisted contract, an existing required Gate, or the primary workflow's correctness/data integrity. **Advanced hardening** introduces a new threat model, environment, exhaustive defense-in-depth requirement, or protection beyond the ticket and existing invariants. Every Critical finding is a core blocker regardless of whether it resembles hardening. Only non-Critical advanced hardening is non-blocking unless the user explicitly promotes it into scope.
- Core Critical/Important findings require a fix commit, affected non-E2E tests, and a fresh complete-matrix review. Stop after five review rounds. If a core blocker remains, set the original ticket to `needs-info`, record it on that ticket, stop dependent work, and request a scope/ownership decision; do not recursively create or immediately implement remediation tickets. Non-blocking advanced-hardening findings create GitHub follow-up Issues only, linked to the reviewed head and source PR/branch, and are not implemented in the current ticket.
- A ticket records at most three evidence updates: `start` (fixed point, scope, behavior matrix, planned Gates), `blocked` (optional, only when execution actually stops), and `final` (reviewed code head plus clean Gate/E2E and PR evidence). Do not append per-review-round narratives or one evidence commit per finding. The final evidence update is documentation-only and is added after clean code review and E2E.
- Do not split work by a fixed file-count or context-count threshold. Split only where each ticket has a stable seam, independently valid and testable behavior, explicit dependency edges, and no invalid intermediate production state. Keep a cross-context vertical slice together when one end-to-end invariant spans those contexts; read and review every affected context.
- This Testing Decisions protocol supersedes shorter per-ticket execution-protocol wording where the two conflict.
- Documentation-only tickets and documentation-only commits do not run `/code-review`, do not count toward the five review rounds, and do not run product E2E. Verify document consistency, exact authority/reference coverage, and `git diff --check`. If one commit mixes code/tests with documentation, it is not documentation-only and the complete code/test diff follows the normal review protocol.
- Tests assert external behavior at the highest existing seam. Internal implementation details are tested only where security/state-machine invariants cannot be observed higher.
- Provider-neutral repository contracts run unchanged against SQLite and PostgreSQL. PostgreSQL tests include forced RLS, tenant-inclusive keys/FKs, owner/runtime role separation, concurrency, restart and rollback injection.
- Public API/Console tests use real HTTP envelopes, roles, tenant isolation, idempotency, expected-version conflicts, and rendered-browser workflows.
- Mission scheduling tests inject failure after each write and prove one atomic outcome, stable replay IDs, no allocator use on replay, and no network call in transactions.
- Intelligence tests prove lease renewal, worker identity, bounded batches, durable dispositions, wakeup generation/epoch fencing, backoff, restart, and no aggregate writes by Worker.
- Runner Protocol conformance tests prove tenant/project/capability admission, lossless fields, Artifact manifest/chunk/ACK recovery, lease-lost upload boundaries, malformed frames and bounded queues.
- Task 14 acceptance uses real Docker Compose, PostgreSQL, MinIO/S3, Server, Worker, Console, proxy, and an external Runner. In-process substitutes and Docker skips do not satisfy the Gate.
- Task 16 tests exercise real Chromium multi-step plans, exact step indices, every budget, model usage propagation, valueRef confinement/redaction, stale graph rejection and action-outcome uncertainty.
- LS-09 closure tests interrupt and resume exploration from durable checkpoints, exercise seed Skills and recovery budgets, and execute the configured Reference Model Profile rather than a deterministic fixture walker.
- Observation Graph v1 tests combine JSON Schema/conformance, property tests for canonicalization, live Web capture, model/resolver/exploration consumers, replay/migration, capability negotiation and a full legacy-import inventory.
- Task 18 tests include protobuf schema/mappers/round-trip, malformed Target oneof, Companion framing/correlation/deadlines, Target Runtime discrimination and fail-closed Desktop capability handling.
- Tasks 19-20 require Windows-only Rust integration tests, WPF and WinUI reference applications, local-console plus RDP scenarios, native process/UIA evidence and a two-person signed checklist. Portable/synthetic tests are supporting evidence only.
- Task 21 restores all quarantines without skips on Windows and Linux, adds rendered-browser E2E, and executes mandatory CI jobs with named uploaded Gate artifacts.
- Release tests inspect runtime images for forbidden source/tests/dev dependencies and verify SBOM/provenance/release-manifest hashes and immutable image digests.
- Task 22 reads serialized evidence records rather than caller-supplied booleans. Graph freeze tests reject missing, malformed, mismatched, unsigned, stale or synthetic evidence.
- Prior art includes the existing Runner-control shared provider contract, Local built-process/Chromium E2E, protocol conformance suites, evidence crypto contracts, Self-hosted Docker fixtures, Observation migration/property tests and Windows portable state-machine tests.
- Before pull-request creation, every implementation ticket runs its focused Gate, `corepack pnpm typecheck`, `git diff --check`, complete-matrix scoped review, and required post-review E2E. The pull request must contain exactly that reviewed head and diff.

## Out of Scope

- Qualigence Cloud implementation or Cloud-specific Runner behavior.
- Mobile, macOS Desktop and Linux Desktop adapters.
- A second Runner identity/enrollment system for Companion.
- Cross-tenant Artifact deduplication.
- Runtime SQL migration by Server or Worker.
- Implicit Runner reassignment or policy/capability downgrade.
- Model-authored selectors, action kinds, URLs, plaintext input values, IDs, policy, budget or terminal state.
- Graph v1 freeze before complete serialized native/manual/release evidence.
- Treating current synthetic Windows fixtures as native completion.
- Reopening already-completed Tasks 1-11/15 except for a separately approved regression fix.
- Using the frozen PR5 forensic branch as an implementation source.

## Further Notes

- Fixed point: `dbc2db8a8854a5559624fa7a7434d75c654f6b82` on `main` after Task 11 and the .NET intermediate-output ignore cleanup.
- Primary authority: the approved open-source architecture, affected context documents, existing public interfaces/contracts, this tracked spec, and the selected tracked ticket.
- Completed work is proven by ticket-local PR/merge/Gate evidence, GitHub checks, and serialized artifacts. Historical planning prose is not an authority source.
- Known architecture conflict: Evidence context and LS-10 require revoke-before-delete, while architecture prose currently says delete then revoke. The architecture must be corrected to the fail-closed state machine approved in this spec.
- Known Graph conflict: array ordering rules are inconsistent across LS-12 prose/property tests. The semantic-set/business-order rule approved here supersedes that ambiguity for Task 17 and must be documented before implementation.
- Known Task 19 status drift: Cargo is available on the current host, but toolchain components and local-console native evidence remain prerequisites.
- Current platform quarantine and Graph freeze remain release blockers even when component tests pass.
- This umbrella spec authorizes decomposition and dependency order; each implementation Task still needs its own exact plan mapping, Gate evidence, status update and scoped review.
