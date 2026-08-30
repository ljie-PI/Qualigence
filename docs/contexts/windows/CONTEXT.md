# Windows Context

## Terms

- **Companion** is the only local authority for UIA, process lifecycle, and permits.
- **Permit** is a one-time, action-bound local authorization consumed before UIA dispatch.
- **Certificate proof** is challenge-response possession of the enrolled Runner mTLS private key after Windows peer identity succeeds; a claimed fingerprint is not proof.

## Ownership

`packages/contracts/desktop`, `packages/target-adapters/desktop-windows-uia`, `apps/companion`, and Windows reference fixtures own native desktop adaptation. Companion is the only process that holds UIA, process, Job Object, and local permit state.

## Seams

- Typed Companion IPC separates TypeScript Runner code from Win32 handles.
- Named Pipe authentication validates OS peer identity and certificate challenge-response before command admission.
- `DesktopProcessHost` and UIA worker abstractions isolate Win32 implementation from lifecycle and policy rules.
- Runner selects Desktop resources through the Target Runtime boundary and advertises Desktop capability only after Companion authentication and probe.

## Invariants

- Named Pipe uses first-instance, local-only framing and a DACL limited to the current logon SID and LocalSystem. It rejects remote, network, anonymous, other-user, wrong-session, and unbounded clients.
- Before commands, Companion verifies client PID, token SID, interactive session, approved image/signature, certificate chain and expiry, client-auth EKU, SAN, fingerprint, Runner scope, and one-use nonce proof using the certificate's ECDSA P-256 or RSA-PSS key.
- IPC frames, queues, concurrency, correlations, and deadlines are bounded; disconnect, timeout, partial, oversized, flooded, unknown, or out-of-order messages fail closed.
- Desktop actions require a valid one-time Permit bound to decision, policy, session, Run, action, Graph, risk, expiry, nonce, and any `valueRef` plus plaintext hash and byte length. Companion verifies and atomically consumes it before UIA dispatch, then clears transient plaintext buffers.
- Interactive Desktop requires per-action local approval for external or destructive effects and always rejects production-forbidden actions. Pause, Companion loss, and Emergency Stop deny new work; Emergency Stop remains latched until a new session.
- UIA passwords are masked before serialization.
- UIA runs in a bounded restartable MTA child. Timeout kills only the child; an unknown action outcome is never automatically replayed and Companion permit/process authority remains alive.
- Applications launch suspended, enter a kill-on-close Job Object, and only then resume. Reset and shutdown verify canonical image, creation time, and Job membership; they never act by image name or reusable PID.
- Synthetic and portable fixtures are supporting contract evidence only. Native completion requires real WPF and WinUI scenarios on supported Windows 11 local-console and required RDP sessions, all security vetoes passing, and two-person signed manual evidence with Run/Trace/Artifact references.
- Observation Graph v1 remains `candidate` until serialized migration, shared Web/Desktop schema, native Windows, signed manual, CI, and release evidence all validate; caller-supplied booleans cannot freeze it.

## Entrypoints

- `apps/companion/src/main.rs`
- `apps/companion/src/ipc/`
- `apps/companion/src/uia/`
- `packages/target-adapters/desktop-windows-uia/src/`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.8, 6.2-6.5, and 7.
- Related contexts: `docs/contexts/execution/CONTEXT.md`, `docs/contexts/protocol/CONTEXT.md`, `docs/contexts/evidence/CONTEXT.md`, and `docs/contexts/deployment/CONTEXT.md`.
- Tracked work: legacy Tickets 26 ([#159](https://github.com/ljie-PI/Qualigence/issues/159)), 27 ([#160](https://github.com/ljie-PI/Qualigence/issues/160)), 28 ([#167](https://github.com/ljie-PI/Qualigence/issues/167)), 29 ([#168](https://github.com/ljie-PI/Qualigence/issues/168)), 30 ([#161](https://github.com/ljie-PI/Qualigence/issues/161)), 31 ([#164](https://github.com/ljie-PI/Qualigence/issues/164)), 32 ([#158](https://github.com/ljie-PI/Qualigence/issues/158)), and 35 ([#165](https://github.com/ljie-PI/Qualigence/issues/165)).
- Checklists: `docs/testing/windows-m3-manual-checklist.md` and `docs/testing/observation-graph-v1-freeze-checklist.md`.

## Verification

Run `corepack pnpm vitest run tests/contract/desktop tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts` and `corepack pnpm gate:companion`. Native completion also requires `docs/testing/windows-m3-manual-checklist.md`.
