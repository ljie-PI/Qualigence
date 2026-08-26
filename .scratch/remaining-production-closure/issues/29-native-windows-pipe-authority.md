# 29 — Implement native Windows Named Pipe authority

**What to build:** Replace the Windows `Unsupported` peer with a first-instance local-only Named Pipe listener and authenticated session state.

**Blocked by:** 28 — Dispatch Desktop Jobs through Target Runtime.

**Status:** claimed

## Tracked scope

This ticket owns the pinned Rust toolchain, native Windows Named Pipe identity, restrictive listener, authenticated Companion session admission, and native negative/process E2E.

## Migration

No relational migration is allocated; existing and allocated closure migrations are unchanged. The native migration replaces only the Windows `NamedPipePeer` error seam. Portable framing/security state machines remain valid and no alternate identity system, insecure compatibility listener, or non-Windows completion claim is introduced.

## Affected contexts

- `docs/contexts/protocol/CONTEXT.md`
- `docs/contexts/windows/CONTEXT.md`

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 4, 6.5, 7, 10, 11, 13, 14.3, and 15.
- `CONTEXT-MAP.md` and the affected context documents above.
- `packages/contracts/desktop/src/**` for the bounded framing and challenge-response DTO contract.
- `docs/testing/windows-m3-manual-checklist.md` sections 6, 12, 13, and 16.

## Allowed Files

This is the complete edit scope, including post-review native acceptance files:

- `.scratch/remaining-production-closure/issues/29-native-windows-pipe-authority.md` for ticket-local final evidence only
- `rust-toolchain.toml`
- `Cargo.lock`
- `apps/companion/Cargo.toml`
- `apps/companion/src/ipc/**`
- `tests/rust/companion/ipc_acl.rs`
- `tests/rust/companion/handshake.rs`
- `tests/rust/companion/windows_named_pipe.rs`
- `tests/e2e/windows/named-pipe-authority.test.ts`

## Requirements

- [ ] Pipe name/DACL permit only current logon SID and LocalSystem and reject remote/network/anonymous clients.
- [ ] Server verifies PID, token SID, interactive session, image/signature allowlist, certificate chain/EKU/SAN/fingerprint, and ECDSA/RSA-PSS proof.
- [ ] Challenges are one-use/expiring; framing, queues, concurrency, and deadlines are bounded.
- [ ] Windows 11 native tests prove all negative identity and replay cases.
- [ ] `rust-toolchain.toml` pins the minimum compiling toolchain and required components; floating `stable` is forbidden.
- [ ] The pipe uses the current logon SID in its name, `FILE_FLAG_FIRST_PIPE_INSTANCE`, overlapped I/O, `PIPE_REJECT_REMOTE_CLIENTS`, and an explicit DACL granting only current logon SID and LocalSystem.
- [ ] Connected-client admission calls `GetNamedPipeClientProcessId`, then verifies process token user SID, interactive session ID, canonical image path, and configured binary signature/allowlist before issuing a challenge.
- [ ] The 256-bit nonce proof binds `{ protocolMajor, companionInstanceId, nonce, runnerId }` and reuses the enrolled Runner mTLS key profile: ECDSA P-256/SHA-256 or RSA-PSS/SHA-256 according to the certificate key.
- [ ] Certificate chain, expiry, client-auth EKU, Runner SAN/scope, configured fingerprint, and proof all pass before any application request is admitted; claimed fingerprint alone never authenticates.
- [ ] Unknown/truncated/oversized frames, queue or concurrency overflow, request-before-auth, challenge expiry/replay, disconnect, and deadline expiry fail with stable non-secret errors and never reveal expected identity details.

## Focused Gate

Run on Windows 11 during implementation and after every code/test review fix:

```bash
cargo fmt --check
cargo build --workspace
cargo test --workspace
corepack pnpm vitest run tests/contract/desktop/named-pipe-client.test.ts
corepack pnpm typecheck
git diff --check
```

`Windows11Unavailable`, `CargoUnavailable`, or a missing pinned toolchain is a blocking result, not a skip and not native completion.

## Post-review acceptance

- Automated native E2E, Windows 11 only: run `cargo test --workspace --test companion_windows_named_pipe`, then `corepack pnpm vitest run tests/e2e/windows/named-pipe-authority.test.ts`. The tests must use real processes and the native pipe to prove valid same-session admission plus every remote, SID, session, PID/image/signature, certificate/proof, replay, malformed-frame, and bounded-admission rejection.
- Manual acceptance: N/A for ticket completion. Ticket 31 independently repeats the operator-visible identity/security vetoes.
- Release acceptance: preserve the native test report with reviewed-head SHA for the downstream `gate-windows-rust` artifact, and record its exact path/hash under this ticket's `## Comments`. Do not claim a release or Graph freeze here.

## Delivery and review

Record the base SHA and each reviewed head in `## Comments`. Every review covers the whole Rust/TypeScript diff and all matrix rows. Core fixes remain on this ticket and require affected focused Gates plus a fresh complete-matrix review. After five rounds with a core blocker, set this ticket to `needs-info`, block tickets 30-35, and request a maintainer scope/ownership decision. Do not create recursive remediation tickets. Only non-Critical advanced hardening may be deferred to a linked GitHub Issue.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary | Public result | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Valid same-logon, same-session, allowlisted Runner with valid certificate proof | `started` after OS identity passes; application side effects remain `not_started` until auth completes | `handshake.accepted` and authenticated session | Session/challenge state is bounded in memory; no business aggregate is written | New connection requires a new nonce; requests correlate only within authenticated session | Native PID/token/cert proof and accepted request log without secret material |
| Remote, network, anonymous, or disallowed DACL principal | `not_started` | Connection denied/stable identity rejection | No challenge or session | Retry remains denied unless OS identity changes legitimately | Native ACL/remote-client evidence |
| Wrong logon SID or interactive session | `not_started` | `CompanionIdentityRejected` | No challenge or session | No automatic downgrade/switch to another desktop | Token/session negative test |
| Wrong PID, canonical image, or signature/allowlist | `not_started` | `CompanionIdentityRejected` without expected-path disclosure | No challenge or session | New process is re-evaluated from OS identity; prior claim has no authority | Real-process negative evidence |
| Invalid/expired certificate, EKU/SAN/fingerprint/scope, or ECDSA/RSA-PSS proof | `not_started` | `CompanionIdentityRejected` | Challenge becomes failed/expired; no session | A failed challenge is never reused; reconnect obtains a fresh nonce | Certificate matrix and zero-admission assertion |
| Replayed, expired, unknown, or cross-instance challenge | `not_started` | Stable authentication rejection | One-use nonce remains consumed/expired | Never replayable; fresh connection/challenge required | Replay/instance-binding test |
| Request arrives before handshake acceptance | `not_started` | Stable authentication/order error | No application request admitted | Client must authenticate on a fresh/valid session | Zero-dispatch assertion |
| Truncated, unknown, oversized, or declared-length-abusive frame | `not_started` | Stable frame/size error followed by bounded close where required | No unbounded allocation and no session promotion | Malformed frame is not replayed; reconnect starts clean | Allocation/frame-limit evidence |
| Admission queue/concurrency limit reached | `not_started` for rejected request | Stable busy/limit error | Existing authenticated sessions remain bounded and usable | Caller may retry with backoff before any application dispatch | Concurrency count and service-survival evidence |
| Timeout/cancel before OS identity or proof completes | `not_started` | Stable timeout/closed result | Challenge/session cleaned up | Fresh connection only; old nonce invalid | Deadline and cleanup evidence |
| Disconnect after authentication but before application dispatch | `not_started` | `CompanionUnavailable` to client | Session/challenges removed | Reconnect and fully reauthenticate; no request replay | Disconnect cleanup and zero-dispatch evidence |
| Disconnect after an application request is dispatched | `outcome_unknown` for that request | Connection loss; caller classifies action uncertainty | Pipe server does not fabricate outcome or persist business success | Never automatically replay a side-effecting request | Correlated dispatch count and absent duplicate |
| Server/process restart | `not_started` for old sessions | Old connection invalid; new authentication required | All in-memory nonces/sessions are lost safely | No resume token or challenge survives restart | Restart test proving old proof/session rejection |
| Terminal persistence failure | N/A: this ticket owns no durable terminal/business store | N/A | Authentication state is intentionally process-local | N/A | Review records this row N/A for the stated ownership reason |

## Comments

### start - 2026-08-26

- Fixed base: `5f6ee13e8cb9bfcd8e0f401e9d3bccd3a1782199` (`main` after Ticket 28 PR #118 merge), verified as the current worktree head before edits.
- Predecessor evidence: Ticket 28 is `resolved`; PR #118 merged as `5f6ee13e8cb9bfcd8e0f401e9d3bccd3a1782199`; reviewed code/test head `e255a7b1fe3459ebf06ec58c107fe112c76be530`; final Ticket 28 gates recorded in `.scratch/remaining-production-closure/issues/28-dispatch-desktop-target-runtime.md` passed, including `tests/e2e/windows/desktop-runner.test.ts`, focused Vitest suites, `corepack pnpm typecheck`, and `git diff --check`.
- Behavior Matrix applicability: applicable. The frozen matrix in this ticket governs native Windows Named Pipe listener/DACL/first-instance/local-only admission, peer PID/token/logon/session/image/signature admission, certificate chain/EKU/SAN/fingerprint/private-key proof, one-use challenge lifecycle, authenticated request ordering, bounded frames/queues/concurrency/deadlines, disconnect/timeout/restart cleanup, and no durable terminal-store ownership.
- Planned focused Gate: `cargo fmt --check`, `cargo build --workspace`, `cargo test --workspace`, `CI=true corepack pnpm vitest run tests/contract/desktop/named-pipe-client.test.ts` (or closest current named-pipe desktop contract if absent), `CI=true corepack pnpm typecheck`, and `git diff --check`.
- Scope guard: implementation is limited to the Ticket 29 Allowed Files. UIA worker/Job Object daemon production completion (Ticket 30), manual Windows native acceptance (Ticket 31), Runner Protocol/storage/public contract changes, and any files outside the allowed list require explicit maintainer authorization before editing.

### implementation - 2026-08-26

- Implemented the Windows Named Pipe IPC authority seam under `apps/companion/src/ipc/windows_pipe.rs`: Windows 11 guard, current-logon-SID pipe naming, explicit SDDL DACL for LocalSystem plus current logon SID, `FILE_FLAG_FIRST_PIPE_INSTANCE`, `FILE_FLAG_OVERLAPPED`, `PIPE_REJECT_REMOTE_CLIENTS`, bounded buffers, overlapped connect timeout/cancel, `GetNamedPipeClientProcessId`, token user SID/logon SID/session verification, canonical image allowlist checks, and stable non-secret error codes.
- Replaced the prior Windows `NamedPipePeer` unsupported placeholder with a PID-capable adapter and kept full Windows SID/session/image admission in the native pipe module.
- Added production mTLS-certificate challenge verification primitives: 256-bit one-use/expiring nonces, exact Ticket 27 proof bytes, certificate PEM/chain fingerprint policy, expiry, clientAuth EKU, Runner SAN, configured fingerprint, ECDSA P-256/SHA-256 and RSA-PSS/SHA-256 proof verification, replay and instance/nonce binding rejection.
- Tightened Rust IPC DTO parsing for current Desktop value-binding/action-execute fields and added authenticated-session gating so non-handshake requests before proof produce `CompanionUnauthenticated` without dispatch.
- Added native Rust coverage in `tests/rust/companion/windows_named_pipe.rs`, updated `ipc_acl.rs` and `handshake.rs`, and added `tests/e2e/windows/named-pipe-authority.test.ts` to execute the native Windows Rust suite through Vitest.
- Validation evidence in this worktree: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check` passed; `cargo build --workspace` passed; `cargo test --workspace` passed; `CI=true corepack pnpm vitest run tests/contract/desktop/named-pipe-companion-client.test.ts` passed as the closest current named-pipe desktop contract because `tests/contract/desktop/named-pipe-client.test.ts` is absent; `CI=true corepack pnpm vitest run tests/e2e/windows/named-pipe-authority.test.ts` passed; `CI=true corepack pnpm typecheck` passed; `git diff --check` passed.
- Note: the default shell PATH lacked a `cargo-fmt` shim even though the pinned Rust 1.96.1 toolchain's `cargo-fmt.exe` and `rustfmt.exe` exist under `/q/.tools/Scoop/apps/rust/1.96.1/bin`; the recorded fmt gate was run with that directory prepended to PATH.
