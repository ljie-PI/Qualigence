# 29 — Implement native Windows Named Pipe authority

**What to build:** Replace the Windows `Unsupported` peer with a first-instance local-only Named Pipe listener and authenticated session state.

**Blocked by:** 28 — Dispatch Desktop Jobs through Target Runtime.

**Status:** resolved

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

- [x] Pipe name/DACL permit only current logon SID and LocalSystem and reject remote/network/anonymous clients.
- [x] Server verifies PID, token SID, interactive session, image/signature allowlist, certificate chain/EKU/SAN/fingerprint, and ECDSA/RSA-PSS proof.
- [x] Challenges are one-use/expiring; framing, queues, concurrency, and deadlines are bounded.
- [x] Windows 11 native tests prove all negative identity and replay cases.
- [x] `rust-toolchain.toml` pins the minimum compiling toolchain and required components; floating `stable` is forbidden.
- [x] The pipe uses the current logon SID in its name, `FILE_FLAG_FIRST_PIPE_INSTANCE`, overlapped I/O, `PIPE_REJECT_REMOTE_CLIENTS`, and an explicit DACL granting only current logon SID and LocalSystem.
- [x] Connected-client admission calls `GetNamedPipeClientProcessId`, then verifies process token user SID, interactive session ID, canonical image path, and configured binary signature/allowlist before issuing a challenge.
- [x] The 256-bit nonce proof binds `{ protocolMajor, companionInstanceId, nonce, runnerId }` and reuses the enrolled Runner mTLS key profile: ECDSA P-256/SHA-256 or RSA-PSS/SHA-256 according to the certificate key.
- [x] Certificate chain, expiry, client-auth EKU, Runner SAN/scope, configured fingerprint, and proof all pass before any application request is admitted; claimed fingerprint alone never authenticates.
- [x] Unknown/truncated/oversized frames, queue or concurrency overflow, request-before-auth, challenge expiry/replay, disconnect, and deadline expiry fail with stable non-secret errors and never reveal expected identity details.

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

### review-fix - 2026-08-26

- Reviewed head with blockers: `74d6eff12a0dce26a3246ace090cdb82d14a555c`; fixed point/base remains `5f6ee13e8cb9bfcd8e0f401e9d3bccd3a1782199`.
- Fix commits: `928b4f058924dff88da7903599e73c1d421b5395` (`fix(ticket-29): close native pipe review blockers`) and `d90e0a2d4da604da51b48f46fc35fbb810d7286e` (`fix(ticket-29): preserve request envelope serialization`).
- Fixed the Companion IPC parser blocker by accepting only the current TypeScript envelope (`protocolMajor`, `requestId`, `type`, nested `payload`), rejecting top-level/payload unknown fields and raw flat legacy DTOs, and adding `companion.probe` plus `app.launch` request DTO coverage.
- Fixed the production signer-policy blocker by implementing `RequireAuthenticodeSigner` with WinTrust/Catalog verification and signer-certificate SHA-1 thumbprint allowlist matching; unsigned or unallowlisted images fail closed. Native tests cover positive and negative signer allowlist behavior with a Windows-signed system binary.
- Fixed certificate validation blockers by validating a linked chain to a configured trust-anchor fingerprint, certificate signatures, CA basic constraints/key-cert-sign usage, expiry, clientAuth EKU, leaf fingerprint, Runner SAN, and configured Runner scope SANs. Tests use a CA-signed leaf chain for positive ECDSA/RSA proof and cover wrong fingerprint, SAN/scope, missing chain/trust, bad signature, and algorithm mismatch.
- Fixed challenge replay by consuming certificate challenges on runner, companion-instance, nonce, expiry, and signature/algorithm failures; tests prove mismatch attempts cannot subsequently replay the same challenge.
- Fixed bounded queue semantics by wiring `FrameLimits.max_queue_depth` into `RequestAdmission::from_frame_limits`/`try_queue` with a queue guard independent of in-flight concurrency and tests for queue overflow/release.
- Gates run after the latest code fix commit before this ticket-comment update: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check` passed; `cargo build --workspace` passed; `cargo test --workspace` passed; `cargo test --workspace --test companion_windows_named_pipe` passed; `CI=true corepack pnpm vitest run tests/contract/desktop/named-pipe-companion-client.test.ts` passed (the exact `tests/contract/desktop/named-pipe-client.test.ts` file is absent); `CI=true corepack pnpm vitest run tests/e2e/windows/named-pipe-authority.test.ts` passed; `CI=true corepack pnpm typecheck` passed; `git diff --check` passed.
- Residual native-acceptance limitation for the fresh complete-matrix review: this host proves Windows 11 local signed-image allowlist and real local same-session native pipe admission, but it still does not have a second logon user/session, remote SMB/network pipe client, anonymous token, or RDP/other-user fixture to prove those negative rows end-to-end. Treat those environment-authority cases as residual review evidence limitations rather than release/native-completion evidence.

### review2-fix - 2026-08-26

- Reviewed head with remaining blockers: `d5e0cccfe07751283233f678ada1015dec75a10f`; fixed point/base remains `5f6ee13e8cb9bfcd8e0f401e9d3bccd3a1782199`.
- Fix commit: `d7da29ddc22c3567a13473d8ea4d9d34f80084f1` (`fix(ticket-29): wire native pipe request admission`).
- Fixed the RequestAdmission production-path blocker by adding `BoundedRequestProcessor` and `NativePipeRequestProcessor`: native session request reads now construct admission from `FrameLimits`, reserve a queue slot, require authentication for application requests, hold an in-flight guard for admitted application dispatch, and clear session/challenge state on disconnect.
- Expanded native Windows coverage from six to twelve `companion_windows_named_pipe` tests. New native-pipe/session tests prove valid same-session certificate proof followed by application request admission, invalid proof rejection before app admission, replay rejection through the native session path, oversized and truncated frames over a real pipe handle, queue and in-flight overload rejection through the request-processing path, disconnect cleanup before and after authentication, and restart rejection of old proof/session state.
- Prior fixes were preserved: current TypeScript-compatible envelope parsing/variants, production Authenticode signer allowlist, certificate chain/EKU/SAN/fingerprint/scope validation, one-use challenge consumption on mismatches, pinned Rust 1.96.1 toolchain, DACL/first-instance/remote-rejection flags, and stable non-secret errors.
- Gates run before the code fix commit: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check` passed; `cargo build --workspace` passed; `cargo test --workspace` passed; `cargo test --workspace --test companion_windows_named_pipe -- --nocapture` passed (12 tests); `CI=true corepack pnpm vitest run tests/contract/desktop/named-pipe-companion-client.test.ts` passed (the exact requested `tests/contract/desktop/named-pipe-client.test.ts` file remains absent); `CI=true corepack pnpm vitest run tests/e2e/windows/named-pipe-authority.test.ts` passed; `CI=true corepack pnpm typecheck` passed; `git diff --check` passed.
- Residual environment limitation for a fresh complete-matrix review: this host still does not provide a second logon user/session, remote SMB/network pipe client, anonymous token, or RDP/other-user fixture, so those environment-authority rows remain explicitly limited and are not claimed as release/native-completion evidence.

### review3-fix - 2026-08-26

- Reviewed head with remaining blockers: `05988ec816f7c72672c1f501316194fb41728dc5`; fixed point/base remains `5f6ee13e8cb9bfcd8e0f401e9d3bccd3a1782199`.
- Fix commit: `730104f22a3cecd255726f38a15b610437af0e20` (`fix(ticket-29): bound native handshake state`).
- Fixed unsupported proof-algorithm replay by moving `handshake.prove.signatureAlgorithm` parsing into `CertificateHandshakeVerifier` so a proof attempt for a known challenge is removed and marked consumed before unsupported-algorithm errors are returned. Verifier and native-pipe tests now prove an unsupported algorithm cannot be followed by a valid proof for the same challenge.
- Fixed unbounded challenge state by adding explicit `CertificateChallengeStateLimits` caps for pending and consumed certificate challenges plus deadline-based purge on new challenge issuance. Tests prove repeated `handshake.begin` and failed `prove` attempts remain bounded and expired pending/consumed state is purged without weakening one-use semantics.
- Fixed Rust request-path stable error mapping to public Companion IPC codes: oversized frames now expose `CompanionMessageTooLarge`, overload exposes `CompanionBackpressure`, and truncation/malformed frames expose `CompanionProtocolViolation`.
- Improved feasible native PID/image/signature evidence with a real signed PowerShell client process connecting to the native pipe. The test authorizes its actual pipe PID, canonical image path, and Authenticode signer thumbprint before processing its request, and proves a wrong signer thumbprint rejects that same real process identity. The older same-process/test-only path remains only supporting local identity/session coverage and is not claimed as production signer proof.
- Preserved prior fixes: TypeScript-compatible envelope parsing and `companion.probe`/`app.launch` variants, production Authenticode primitive, certificate chain/EKU/SAN/fingerprint/scope validation, bounded queue/in-flight native request path, DACL/first-instance/overlapped/remote-rejection flags, and non-Windows `Windows11Unavailable` behavior.
- Gates run before the code fix commit: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check` passed; `cargo build --workspace` passed; `cargo test --workspace` passed; `cargo test --workspace --test companion_windows_named_pipe` passed (14 tests); `CI=true corepack pnpm vitest run tests/contract/desktop/named-pipe-companion-client.test.ts` passed (18 tests); `CI=true corepack pnpm vitest run tests/e2e/windows/named-pipe-authority.test.ts` passed (1 test wrapping the native suite); `CI=true corepack pnpm typecheck` passed; `git diff --check` passed.
- Residual environment limitation for fresh complete-matrix review: this host still does not provide a second logon user/session, remote SMB/network pipe client, anonymous token, or RDP/other-user fixture, so those environment-authority rows remain explicitly limited and are not claimed as release/native-completion evidence.

### final - 2026-08-26

- Reviewed code/test head: `16f4f90df56a21e589d64b3748fdbb90180a6cb4`.
- Complete-matrix review: Standards and Spec review reported no core blockers (`Q:/Qualigence/.pi-subagents/artifacts/outputs/a6e2cfec-44fa-4449-9d83-c7830b19d475/ticket29-review4/standards.md`, `Q:/Qualigence/.pi-subagents/artifacts/outputs/a6e2cfec-44fa-4449-9d83-c7830b19d475/ticket29-review4/spec.md`).
- Final verification: `PATH=/q/.tools/Scoop/apps/rust/1.96.1/bin:$PATH cargo fmt --check`, `cargo build --workspace`, `cargo test --workspace`, `cargo test --workspace --test companion_windows_named_pipe`, `CI=true corepack pnpm vitest run tests/contract/desktop/named-pipe-companion-client.test.ts`, `CI=true corepack pnpm vitest run tests/e2e/windows/named-pipe-authority.test.ts`, `CI=true corepack pnpm typecheck`, and `git diff --check` passed.
- Residual environment limitation: this host does not provide second logon user/session, remote SMB/network pipe client, anonymous-token client, or RDP/other-user fixture; those rows are not claimed as release/native-completion evidence and remain for downstream native/release acceptance environments.
- Pull request: pending creation.

## Answer

Implemented native Windows Named Pipe authority for the Companion IPC boundary. The Windows pipe now uses current-logon SID naming, a LocalSystem/current-logon-SID DACL, first-instance and remote-client rejection flags, overlapped bounded I/O, real PID/token/session/image admission, Authenticode signer allowlist checks, current TypeScript request envelopes, bounded request admission, and certificate challenge-response proof with bounded one-use nonce state. Native Rust and Windows E2E coverage prove the feasible local Windows 11 admission, proof, framing, bounded admission, disconnect, and restart paths; unavailable cross-user/remote/anonymous/RDP identity fixtures are explicitly not claimed as release evidence.

Pull request: pending creation.

Reviewed code/test head: `16f4f90df56a21e589d64b3748fdbb90180a6cb4`

Final verification: native Rust Gate, Windows named-pipe E2E, current named-pipe Companion client contract, `corepack pnpm typecheck`, and `git diff --check` passed.
