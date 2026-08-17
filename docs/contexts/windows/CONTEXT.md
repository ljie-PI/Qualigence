# Windows Context

## Terms

- **Companion** is the only local authority for UIA, process lifecycle, and permits.
- **Permit** is a one-time, action-bound local authorization consumed before UIA dispatch.

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

## Entrypoints

- `apps/companion/src/main.rs`
- `apps/companion/src/ipc/`
- `apps/companion/src/uia/`
- `packages/target-adapters/desktop-windows-uia/src/`

## References

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 5.8, 6.2-6.5, and 7.
- Spec: `docs/superpowers/specs/2026-08-01-ls-13-m3-windows-desktop-target-design.md`.

## Verification

Run `corepack pnpm vitest run tests/contract/desktop tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts` and `corepack pnpm gate:companion`. Native completion also requires `docs/testing/windows-m3-manual-checklist.md`.
