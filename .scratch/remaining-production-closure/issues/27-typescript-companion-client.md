# 27 — Implement the TypeScript Companion client

**What to build:** Connect Runner to a local Companion over bounded authenticated Named Pipe framing with correlated request/response semantics.

**Blocked by:** 26 — Add Desktop Target protocol.

**Status:** resolved

## Tracked scope

This ticket owns the TypeScript authenticated IPC client phase: strict Companion response contracts/parsing and a real bounded TypeScript `NamedPipeCompanionClient` behind the existing `CompanionClient` port. It authenticates before any app/capture/permit/action request. Ticket 28 owns Runner Target Runtime composition/capability advertisement; tickets 29-30 own the native Rust authority and daemon.

## Migration

- Add a bounded `CompanionResponse` discriminated union covering handshake challenge/accepted, session/app lifecycle, UIA capture, approval decision, action outcome, and stable error. Every request/response carries a request ID; validate all DTO fields before resolving a caller.
- Implement 32-bit big-endian length framing over only the configured local Named Pipe, with maximum frame/queue/concurrency limits, per-request monotonic deadlines, bounded correlation registry, partial-frame handling, and fail-stop close behavior for malformed/oversized/unknown/correlation violations.
- Authenticate in strict order: receive a Companion challenge, sign exact `{protocolMajor, companionInstanceId, nonce, runnerId}` bytes with the Runner's existing mTLS client certificate key (ECDSA P-256/SHA-256 or RSA-PSS/SHA-256 according to key), and require accepted identity/instance before any other request.
- Reject certificate/instance mismatch and replayed/out-of-order handshake. Never log certificate material, private key, signatures, tokens, permits, resolved values, or raw frames containing them.
- The fake/separate-process contract fixture proves the client protocol only. It is not native Named Pipe ACL/peer identity or native Companion evidence; those remain tickets 29-30. Do not add Runner composition, UIA/process control, production capability advertisement, or native Rust code.

## Affected context paths

`docs/contexts/windows/CONTEXT.md`; `docs/contexts/protocol/CONTEXT.md`; `docs/contexts/execution/CONTEXT.md`.

## Allowed Files

This is the complete edit scope.

- `packages/{contracts/desktop,target-adapters/desktop-windows-uia}/src`
- `tests/contract/desktop/**`
- `.scratch/remaining-production-closure/issues/27-typescript-companion-client.md`
- Post-review acceptance only: `tests/e2e/windows/companion-client.test.ts`

Maintainer/user-authorized narrow continuation scope expansion (2026-08-26): `tests/type/desktop-contracts.types.ts` may be edited only to align the compile-time public `CompanionRequest` contract with the Ticket 27 envelope request shape `{ protocolMajor, requestId, type, payload }`. This authorization does not permit reintroducing a legacy raw DTO `CompanionRequest` union or weakening the public IPC envelope contract.

No app composition, package manifest, lockfile, Runner Kernel, Runner Protocol, Rust Companion, Windows component fixture, or other E2E file is in scope.

## Authority

Resolve conflicts in this order: security/public contracts, architecture and context invariants, current interfaces/contracts/tests, then the umbrella spec and this ticket's client scope.

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.5, 7, 10, 11, and 14.3. Companion is the local desktop broker; TypeScript uses typed IPC, does not hold native authority, and fails closed on connection/model errors.
- Context authority: all ownership, seams, invariants, and verification surfaces in **Affected context paths**.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` user stories 44 and 46-50; Implementation Decisions on Runner certificate reuse and Desktop secret binding; Testing Decisions on framing/correlation/deadlines and complete matrices.
- Tracked predecessor authority: `.scratch/remaining-production-closure/issues/26-desktop-target-protocol.md` and its merged GitHub PR/check evidence establish the Desktop Target/protocol behavior inherited here. Tickets 29-30 remain the tracked downstream owners of native server identity and do not supply client completion evidence.
- Current public contracts and tests: `packages/contracts/desktop/src/{companion-ipc,app-target,index}.ts` (`CompanionRequest`, new `CompanionResponse`, limits, stable IPC errors); `packages/target-adapters/desktop-windows-uia/src/{companion-client,index}.ts` (`CompanionClient` port); Runner mTLS certificate/key profile consumed through an injected signer interface; and the contract fixture under `tests/contract/desktop`.
- Ticket-local and GitHub evidence: this ticket's `## Comments` and `## Answer`, merged predecessor and final ticket PRs, required checks, reviewed-head and merge-commit bindings, and any deferred advanced-hardening Issues in `ljie-PI/Qualigence` are the durable execution evidence.

## Authority decisions

The signature payload is the UTF-8 bytes of `qualigence-companion-proof/v1\n${protocolMajor}\n${companionInstanceId}\n${nonceBase64}\n${runnerId}\n`, with no JSON or whitespace normalization. `protocolMajor` is the decimal ASCII value `1`; `companionInstanceId`, `nonceBase64`, and `runnerId` are the already-validated exact strings. TypeScript and Rust must share this byte-vector contract in tests.

Every IPC frame is a 32-bit big-endian unsigned byte length followed by UTF-8 JSON. Frames use a request/response envelope instead of raw DTOs: requests are `{ protocolMajor: 1, requestId, type, payload }`; successful responses are `{ protocolMajor: 1, requestId, type, status: "ok", payload }`; failed responses are `{ protocolMajor: 1, requestId, type, status: "error", error: { code, safeMessage } }`. `requestId` is a non-empty bounded string unique among in-flight requests. `payload` is the exact typed body for the named request or response, with the existing request DTO fields moved under `payload`. Unknown envelope fields, wrong protocol major, missing/duplicate request IDs, unknown response types, and mismatched response/request type fail closed. Ticket 27 must freeze the complete `CompanionResponse` union and validators in `packages/contracts/desktop/src` contract tests for tickets 29-30 to consume.

## Execution protocol

- Start only after ticket 26 is truly resolved, including any scope decision that affects the Desktop Job contract, from the latest merged predecessor. Record exact base SHA, matrix pointer, and planned Gates under `## Comments`, citing the predecessor's merged PR and merge commit as current execution-base evidence.
- Preserve the handshake-byte and request/response envelope decisions above because they are cross-language public security contracts for downstream native tickets.
- Use Node.js 24 and Corepack pnpm exactly `11.7.0`; frozen install in a fresh worktree. No dependency/lockfile change is allowed; use Node's existing Named Pipe/network and crypto APIs.
- Begin with failing fake-pipe contract tests. During implementation/review fixes run only the focused Gate, root typecheck, and diff check. Preserve strict TypeScript, bounded memory/concurrency/deadlines, cryptographic algorithm/profile requirements, local-only endpoint configuration, fail-stop semantics, redaction, and Companion-only native authority.
- Do not skip required tests. Post-review fixture unavailability is an explicit block, not native evidence. Preserve unrelated changes and stop before editing outside **Allowed Files**.
- Record start, optional actual blocker, review rounds, Gate/acceptance results, and final PR evidence under `## Comments`; summarize resolution under `## Answer`. Commit before each exact-head Standards/Spec review. Every round covers whole diff and every matrix row and records row-level `pass | finding | N/A`, reasons, reviewed head, and core findings under `## Comments`.
- Critical always blocks. Important blocks only for explicit acceptance, applicable architecture/security, public/persisted contract, required Gate, or primary correctness/data integrity. Fix core findings, rerun affected non-E2E tests, and rerun fresh complete-matrix review.
- Stop after five rounds. A remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requests maintainer scope/ownership. Do not create recursive local remediation tickets.
- Defer non-Critical advanced hardening unless promoted. Create one GitHub Issue in `ljie-PI/Qualigence` with source ticket/branch/PR, fixed/reviewed heads, severity/risk, authority, affected files/Gates, and acceptance; do not implement or add as dependency.
- Run the built-client separate-process fixture only after review is clean. Any later code/test change requires focused Gate, fresh complete-matrix review, then acceptance again.
- Create one non-draft PR only after focused Gate, typecheck, diff check, clean review, acceptance, and final ticket evidence. A final ticket-evidence-only commit may follow only if code/test diff is byte-identical. Keep `claimed` until merge; then record PR/SHA under `## Answer`, resolve, and remove branch/worktree.

## Focused non-E2E Gate

```text
corepack pnpm vitest run tests/contract/desktop
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

```text
corepack pnpm vitest run tests/e2e/windows/companion-client.test.ts
```

Run the built TypeScript client against a separate-process authenticated Named Pipe contract fixture. Prove real framing/correlation/deadlines/handshake and negative disconnect/partial/oversized/flood cases. This is explicitly not native Companion, ACL, OS peer-token, UIA, process, or release evidence.

## Comments

### start - 2026-08-26

- Fixed base: `cff217f68f0b3bcaffe517aaed11e3e302abb964` (`ticket-27-typescript-companion-client`, based on current `main` and including merged Ticket 26 PR #112).
- Predecessor evidence: Ticket 26 is `resolved` with PR #112; reviewed code head `fcd5b2926a20f428ce0009da704022144bb80ea9`, merged in `cff217f68f0b3bcaffe517aaed11e3e302abb964`, and final verification evidence are recorded in `.scratch/remaining-production-closure/issues/26-desktop-target-protocol.md` and are present in this worktree base.
- Behavior Matrix applicability: applicable. The frozen matrix in this ticket governs the TypeScript Companion IPC envelope, proof-byte contract, local Named Pipe framing, authentication ordering, bounded correlation/deadline registry, validation, backpressure, and fail-stop close behavior. The terminal persistence row remains N/A because this client owns no durable persistence.
- Planned focused non-E2E Gate: `CI=true corepack pnpm vitest run tests/contract/desktop`, then `CI=true corepack pnpm typecheck`, then `git diff --check`.
- Scope guard: implementation is limited to `packages/{contracts/desktop,target-adapters/desktop-windows-uia}/src`, `tests/contract/desktop/**`, and this ticket evidence. No app composition, package manifest, lockfile, Runner Kernel, Runner Protocol, Rust Companion, Windows component fixture, or E2E file is in scope for this implementation pass.

### blocked - 2026-08-26

- In-scope implementation reached a safe point: `CompanionRequest` is now the Ticket 27 envelope-only public type, `CompanionResponse` is a bounded discriminated union with validators, the proof byte-vector contract is frozen, and `NamedPipeCompanionClient` implements local Named Pipe endpoint validation, 32-bit BE framing, bounded in-flight correlation, handshake proof signing through an injected Runner certificate signer, deadlines, and fail-stop handling for malformed/oversized/correlation violations.
- Temporary compatibility note: an earlier local iteration kept `CompanionRequest = CompanionRequestEnvelope | LegacyCompanionRequestPayload` only to avoid touching the existing type test outside scope. Per supervisor direction, that compatibility union was removed because it weakens Ticket 27's public request contract. The legacy raw helper was also removed from the public desktop-contract export surface; `CompanionRequest` is envelope-only.
- Focused contract/diff evidence now passes within the authorized scope: `CI=true corepack pnpm vitest run tests/contract/desktop` (3 files / 36 tests) and `git diff --check`.
- Root typecheck is blocked by the pre-existing compile-time type test outside Ticket 27's Allowed Files still constructing the old raw `CompanionRequest` shape:
  - `tests/type/desktop-contracts.types.ts(73,3): error TS2353: Object literal may only specify known properties, and 'sessionId' does not exist in type 'CompanionRequest'.`
- Minimal scope expansion needed: authorize a narrow update to `tests/type/desktop-contracts.types.ts` so the compile-time contract test constructs the new `{ protocolMajor: 1, requestId, type, payload }` Companion request envelope and keeps the runner-protocol re-export assertion. No production code outside `packages/contracts/desktop/src` or `packages/target-adapters/desktop-windows-uia/src` is needed.
- Hard exclusions preserved: no app composition, package manifest, lockfile, Runner Kernel, Runner Protocol source, Rust Companion, Windows component fixture, or E2E file was edited.

### continuation - 2026-08-26

- Maintainer/user authorization recorded under `## Allowed Files` for the single additional type-test file `tests/type/desktop-contracts.types.ts` only.
- The compile-time desktop contract test now constructs `CompanionRequest` through the public `{ protocolMajor, requestId, type, payload }` envelope and asserts legacy raw DTOs plus mismatched request/response payloads are rejected at the public type boundary.
- Focused non-E2E Gate is clean on this continuation: `CI=true corepack pnpm vitest run tests/contract/desktop` (3 files / 36 tests), `CI=true corepack pnpm typecheck`, and `git diff --check`.
- No PR was created. Ticket 27 is ready for exact-head complete-matrix review before any post-review acceptance fixture or PR work.

### review-fix - 2026-08-26

- Reviewed head fixed: `024e0f058cbce77d7fc073f046bea988083f3287`; fixed point/base remains `cff217f68f0b3bcaffe517aaed11e3e302abb964`.
- Review blockers fixed from the Standards/Spec complete-matrix artifacts:
  - close/cancel during pending `socketFactory`/connect/auth now rejects the in-flight caller with stable `CompanionUnavailable`, rechecks the closed latch after connect/auth and before writes, destroys sockets that arrive after close, and sends zero frames when closed before dispatch;
  - handshake `CompanionIdentityRejected`, handshake error responses, and handshake timeouts now fail-stop/destroy the socket so no authenticated or reusable session remains and no later application frame is admitted on the rejected connection;
  - `permit.request` is classified as side-effecting, so a timeout/disconnect after dispatch surfaces `outcomeUnknown: true` and is not replay-safe;
  - minor local cleanup removed the unused `performance` import and the unread `PendingRequest.requestType` field.
- Fix commit: `2432d06307a65eb28d720df845bf727f88fe5abf` (`fix ticket 27 companion fail-closed semantics`).
- Gates run before the fix commit: `CI=true corepack pnpm vitest run tests/contract/desktop` (3 files / 41 tests passed), `CI=true corepack pnpm typecheck` (passed), and `git diff --check` (passed).
- No PR was created, no post-review E2E/acceptance fixture was run, and the ticket remains `claimed` pending a fresh complete-matrix review.

### review2-fix - 2026-08-26

- Reviewed head fixed: `5559846d246f40b059a4b8295230fbc984136d03`; fixed point/base remains `cff217f68f0b3bcaffe517aaed11e3e302abb964`.
- Review2 core blockers fixed from the Standards/Spec complete-matrix artifacts:
  - TypeScript IPC `uia.capture` response validation now exports and enforces the native fixed UIA password mask token (`••••`) for `isPassword: true` nodes, rejects plaintext/unmasked or absent password values at the contract seam, and keeps non-password values unchanged;
  - Companion proof signing now races the Runner mTLS signer against the handshake deadline, maps signer/key-profile rejection to a stable non-secret `CompanionIdentityRejected`, fail-stops/destroys the connection on signer timeout or rejection, clears handshake state, and sends no `handshake.prove` or application frame after a stalled or failed signer;
  - stale socket `data`/`error`/`close` callbacks from a failed connection are ignored after fail-stop so a later reconnect cannot reuse or be killed by the rejected connection.
- Fix commit: `6b2435051e08745022b2b6029503e512e5a90c92` (`fix ticket 27 review2 core blockers`).
- Gates run before the fix commit: `CI=true corepack pnpm vitest run tests/contract/desktop` (3 files / 44 tests passed), `CI=true corepack pnpm typecheck` (passed), and `git diff --check` (passed). A fresh post-evidence status/diff check remains required before handoff.
- No PR was created, no post-review E2E/acceptance fixture was run, and the ticket remains `claimed` pending a fresh complete-matrix review.

### review3-fix - 2026-08-26

- Reviewed head fixed: `4d7cd9d1eefbd122763872c941942663b8608722`; fixed point/base remains `cff217f68f0b3bcaffe517aaed11e3e302abb964`.
- Review3 Spec core blocker fixed: non-handshake request deadlines now fail-stop/destroy the Companion socket when any inbound response frame bytes are partially buffered, clearing the stale buffer and authenticated state before a later caller can proceed. This prevents truncated bodies from being resumed as part of a later response frame.
- Contract coverage added for a valid 32-bit frame length followed by only part of the response body: the first request times out, the original socket is destroyed and pending capacity is cleared, and the next caller reconnects/authenticates on a fresh stream instead of reusing stale bytes.
- Fix commit: `7cf6b87126ff59959eb805e49e81f7c40aeea60f` (`fix ticket 27 partial frame timeout`).
- Gates run before the fix commit: `CI=true corepack pnpm vitest run tests/contract/desktop` (3 files / 45 tests passed), `CI=true corepack pnpm typecheck` (passed), and `git diff --check` (passed). A fresh post-evidence status/diff check remains required before handoff.
- No PR was created, no post-review E2E/acceptance fixture was run, and the ticket remains `claimed` pending a fresh complete-matrix review.

### post-review-e2e - 2026-08-26

- Clean complete-matrix review authority for the acceptance start point: reviewed head `d5246d632ee290f270bd2c4a9662e2832c2b2b9b`, fixed point/base `cff217f68f0b3bcaffe517aaed11e3e302abb964`, with no core blockers in review4 Standards/Spec artifacts.
- Added the required post-review acceptance file `tests/e2e/windows/companion-client.test.ts` only. The fixture is a separate Node process listening on a real local Windows Named Pipe via `node:net`; the client under test imports the built `@qualigence/desktop-windows-uia` package and uses the production `NamedPipeCompanionClient`.
- Acceptance coverage: authenticated challenge/proof/accepted handshake with ECDSA P-256 proof verification over the exact Ticket 27 proof bytes, 32-bit big-endian frame parsing with declared-length evidence, request ordering before privileged frames, out-of-order request/response correlation, deadline timeout, post-dispatch disconnect outcome-unknown classification, partial-frame timeout/fail-close behavior, oversized-frame rejection, and bounded in-flight flood/backpressure.
- Evidence commands passed after adding the E2E file: `CI=true corepack pnpm vitest run tests/e2e/windows/companion-client.test.ts` (1 file / 4 tests), `CI=true corepack pnpm vitest run tests/contract/desktop` (3 files / 45 tests), `CI=true corepack pnpm typecheck`, and `git diff --check`.
- Scope and evidence limits: this is still TypeScript client/separate-process contract acceptance only. It is not native Companion ACL, Windows peer-token, UIA, process/Job Object, RDP/manual, or release evidence; those remain downstream Tickets 29-31. Because this acceptance adds a test file after the clean review head, Ticket 27 needs a fresh complete-matrix review before PR/final acceptance.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Local pipe connects, challenge proof is valid, accepted instance matches | `started` at pipe connect/handshake frames | Authenticated client session; later typed requests may proceed | N/A: client session/correlation state is bounded in memory; Companion owns durable/native authority | Reconnect requires a fresh nonce/challenge and new session; never reuse proof | Ordered connect/challenge/proof/accepted transcript with redacted payloads |
| Endpoint is nonlocal/invalid or connection fails before handshake | `not_started` for authenticated/application requests | `CompanionUnavailable` or stable connection error | No authenticated session/pending application requests | Bounded reconnect by owning Runner (ticket 28); client creates fresh connection | Endpoint validation/error and zero app/capture/permit/action frames |
| Wrong certificate/key/algorithm, runner ID, protocol major, instance, nonce, signature, or replayed challenge | `started` for handshake only | `CompanionIdentityRejected`/stable handshake error; connection fails closed | In-memory handshake state cleared; no authenticated session | Never retry same challenge/proof; reconnect starts fresh | Rejection and zero post-auth request admission |
| Authenticated Companion reports policy denial, capability mismatch, unsupported request, or stable application error | `started` for the request | Exact typed stable error is returned; client does not downgrade, reinterpret, or issue an alternate request | Matching correlation is removed; no client-side success state | Owning ticket 28 decides whether a distinct authorized request may follow; never auto-replay a side effect | Correlated error response and zero fallback request |
| App/capture/permit/action request is attempted before authentication | `not_started` | Stable unauthenticated/order error | No outbound privileged frame or pending entry | Authenticate first; no queueing for later implicit send | Contract test proves zero server receipt |
| Valid authenticated request receives matching valid response | `started` | Typed response resolves exactly its request | Correlation entry removed; no durable client state | Caller may issue a new request; same request ID cannot remain live/reuse ambiguously | Request/response ID and one Promise resolution |
| Request DTO or response DTO/variant is malformed or unknown | `not_started` for invalid outbound request; `started` for invalid inbound response | Stable validation/unknown-variant error; connection fails closed when stream trust is lost | All pending correlations reject and clear | Reconnect fresh; never coerce/default unknown data | Parser error and pending-registry cleanup |
| Declared frame is zero/negative/oversized or body is partial/truncated | `started` once bytes/length arrive | `CompanionMessageTooLarge` or stable framing error; disconnect | Buffer and pending registry are bounded/cleared | Never wait unbounded or resume corrupt frame; fresh reconnect only | Bound assertion, disconnect, and all pending rejection |
| Queue/concurrency/flood limit is exceeded | `not_started` for rejected request or `started` when peer flood arrives | Stable backpressure/limit error; offending connection may close | No unbounded buffer/registry growth | Caller retries later on fresh capacity; peer flood does not gain admission | Peak bound and deterministic rejection evidence |
| Deadline/cancel before request frame dispatch | `not_started` | Stable timeout/cancel | Pending entry removed; no frame sent | Caller may retry with a new request ID if operation is safe | Zero server receipt and cleared timer/entry |
| Deadline/cancel after full request dispatch but before response, for read-only capture/session query | `started` | Stable timeout/cancel; late response is rejected | Pending entry removed; no inferred result | Caller may issue a new request under owning workflow policy; old ID is not resurrected | Dispatch, timeout, late-response rejection |
| Deadline/disconnect after app/permit/action request dispatch without response | `outcome_unknown` | Stable `ActionOutcomeUnknown`/Companion unavailable classification as appropriate | Client stores no success and clears pending entry | Never automatically replay side-effecting request; owning Runtime must terminalize/reconcile | Dispatch evidence, absent matching response, unknown outcome |
| Duplicate response for an already completed request ID | `started` | Correlation protocol error/fail-stop | No second Promise resolution | Never accept duplicate; reconnect if stream trust is lost | One resolution plus duplicate rejection |
| Response uses unknown/wrong request ID or wrong response kind | `started` | Correlation error; fail closed | Pending entries reject/clear; no cross-request delivery | No remapping; fresh reconnect | Wrong-ID/type evidence and zero misdelivery |
| Concurrent valid requests complete out of order | `started` | Each Promise resolves only from matching ID/type | Bounded registry removes each exactly once | Safe within configured concurrency; no ordering inference | Out-of-order fixture evidence with exact correlations |
| Pipe process/client restarts | `not_started` until fresh connect | New unauthenticated session | Old in-memory challenges/requests are gone | Fresh challenge/auth required; callers receive failure for old pending operations | Restart evidence and no proof/request replay |
| Terminal response persistence fails | `not_started` | N/A: TypeScript client owns no durable persistence | N/A | Owning Runtime/Companion persistence is downstream | N/A reason recorded in review |

- [x] Request/response unions validate all fields, request IDs, frame sizes, order, deadlines, and unknown variants.
- [x] Authentication proves Runner certificate possession and binds protocol/instance/nonce/Runner identity.
- [x] No app/capture/permit/action request is admitted before authentication.
- [x] Disconnect, timeout, partial, oversized, flood, and correlation errors fail closed.

### final - 2026-08-26

- Reviewed code/test head: `6874749192c4da480c71aa6a3a121a9e02a67f8d`.
- Complete-matrix review: Standards and Spec review reported no core blockers (`Q:/Qualigence/.pi-subagents/artifacts/outputs/820a071d-01e4-4cd0-8c7a-23b86416496c/ticket27-review5/standards.md`, `Q:/Qualigence/.pi-subagents/artifacts/outputs/820a071d-01e4-4cd0-8c7a-23b86416496c/ticket27-review5/spec.md`).
- Final verification: `CI=true corepack pnpm vitest run tests/e2e/windows/companion-client.test.ts` (1 file / 4 tests), `CI=true corepack pnpm vitest run tests/contract/desktop` (3 files / 45 tests), `CI=true corepack pnpm typecheck`, and `git diff --check` passed.
- Pull request: `https://github.com/ljie-PI/Qualigence/pull/116`.

## Answer

Implemented the TypeScript Companion client. Desktop contracts now use envelope-only Companion request/response IPC with strict validators, exact proof bytes, password-mask enforcement, stable errors, bounded local Named Pipe framing, correlated request/response handling, handshake authentication through the Runner certificate signer, deadline/backpressure limits, and fail-stop behavior for malformed, oversized, partial, unknown, and correlation failures. The production TypeScript `NamedPipeCompanionClient` sits behind the existing `CompanionClient` port and authenticates before app/capture/permit/action requests. The post-review Windows separate-process E2E proves the built client over a real local Named Pipe contract fixture; native Companion ACL/peer/UIA/process evidence remains downstream scope.

Pull request: `https://github.com/ljie-PI/Qualigence/pull/116`

Reviewed code/test head: `6874749192c4da480c71aa6a3a121a9e02a67f8d`

Final verification: focused Ticket 27 Gate, Windows Companion client E2E, `corepack pnpm typecheck`, and `git diff --check` passed.
