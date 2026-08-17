# Windows Context

## Ownership

`packages/contracts/desktop`, `packages/target-adapters/desktop-windows-uia`, `apps/companion`, and Windows reference fixtures own native desktop adaptation. Companion is the only process that holds UIA, process, Job Object, and local permit state.

## Seams

- Typed Companion IPC separates TypeScript Runner code from Win32 handles.
- Named Pipe authentication validates OS peer identity and certificate challenge-response before command admission.
- `DesktopProcessHost` and UIA worker abstractions isolate Win32 implementation from lifecycle and policy rules.

## Invariants

- Desktop actions require a valid one-time, action-bound permit.
- Named Pipe access is local, authenticated, and bound to the interactive session.
- UIA passwords are masked before serialization.
- Job Object lifecycle acts only on verified member processes; never by image name or reusable PID.
- Synthetic fixtures are contract evidence only. Native completion requires Windows 11, Cargo, real WPF/WinUI evidence, and the signed manual checklist.

## Verification

Use desktop contracts, Rust tests, Windows UIA components, observation conformance, and the manual checklist. Read Architecture sections 5.8, 6.2-6.5, 7, and LS-13 before changing this context.
