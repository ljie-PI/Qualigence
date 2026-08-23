# 27 — Implement the TypeScript Companion client

**What to build:** Connect Runner to a local Companion over bounded authenticated Named Pipe framing with correlated request/response semantics.

**Blocked by:** 26 — Add Desktop Target protocol.

**Status:** ready-for-agent

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

No app composition, package manifest, lockfile, Runner Kernel, Runner Protocol, Rust Companion, Windows component fixture, or other E2E file is in scope.

## Authority

Resolve conflicts in this order: security/public contracts, architecture and context invariants, current interfaces/contracts/tests, then the umbrella spec and this ticket's client scope.

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.5, 7, 10, 11, and 14.3. Companion is the local desktop broker; TypeScript uses typed IPC, does not hold native authority, and fails closed on connection/model errors.
- Context authority: all ownership, seams, invariants, and verification surfaces in **Affected context paths**.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` user stories 44 and 46-50; Implementation Decisions on Runner certificate reuse and Desktop secret binding; Testing Decisions on framing/correlation/deadlines and complete matrices.
- Tracked predecessor authority: `.scratch/remaining-production-closure/issues/26-desktop-target-protocol.md` and its merged GitHub PR/check evidence establish the Desktop Target/protocol behavior inherited here. Tickets 29-30 remain the tracked downstream owners of native server identity and do not supply client completion evidence.
- Current public contracts and tests: `packages/contracts/desktop/src/{companion-ipc,app-target,index}.ts` (`CompanionRequest`, new `CompanionResponse`, limits, stable IPC errors); `packages/target-adapters/desktop-windows-uia/src/{companion-client,index}.ts` (`CompanionClient` port); Runner mTLS certificate/key profile consumed through an injected signer interface; and the contract fixture under `tests/contract/desktop`.
- Ticket-local and GitHub evidence: this ticket's `## Comments` and `## Answer`, merged predecessor and final ticket PRs, required checks, reviewed-head and merge-commit bindings, and any deferred advanced-hardening Issues in `ljie-PI/Qualigence` are the durable execution evidence.

## Authority ambiguity

Current authority binds the signature to `{ protocolMajor, companionInstanceId, nonce, runnerId }` but does not specify an interoperable byte encoding, and the existing request union has no request-ID envelope or frozen response payload shapes. Before implementation, freeze one versioned byte encoding plus exact request/response envelope/DTO shapes in contract tests and record the decision here for tickets 29-30. Do not independently choose encodings in TypeScript and Rust.

## Execution protocol

- Start only after ticket 26 is truly resolved, including any scope decision that affects the Desktop Job contract, from the latest merged predecessor. Record exact base SHA, matrix pointer, and planned Gates under `## Comments`, citing the predecessor's merged PR and merge commit as current execution-base evidence.
- Obtain and record the reviewed handshake-byte/envelope decision before production edits because it is a cross-language public security contract for downstream native tickets.
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

- [ ] Request/response unions validate all fields, request IDs, frame sizes, order, deadlines, and unknown variants.
- [ ] Authentication proves Runner certificate possession and binds protocol/instance/nonce/Runner identity.
- [ ] No app/capture/permit/action request is admitted before authentication.
- [ ] Disconnect, timeout, partial, oversized, flood, and correlation errors fail closed.
