# Windows Reference App (WPF) — fixture

This directory contains **two distinct kinds of artifact**. Read this before
changing anything here.

## 1. The reference app source (specification only, does NOT build on Linux)

`WindowsReferenceWpf.csproj`, `App.xaml(.cs)`, `MainWindow.xaml(.cs)`,
`app.manifest` are a **real, buildable .NET 10 / WPF desktop application** that a
human operator compiles and runs **on Windows 11**. They are checked in as the
authoritative specification of the reference app's UI structure (controls,
`AutomationId`s, control types, and the destructive/crash/reset capabilities the
manual checklist exercises).

They are **not** compiled or executed by this repository's automated test suite,
which runs on Linux and has no .NET Desktop SDK, WPF runtime, or UIA provider.

## 2. `reference-app.fixture.json` (machine-readable, USED by the Linux tests)

This is a **synthetic-but-realistic** capture that is, field for field, the
`UiaSource` DTO the Rust Companion returns from a real UIA capture on Windows. It
drives the Linux-runnable pipeline tests in
`tests/component/windows-uia/*.test.ts`, which exercise the **entire production
software stack** — Companion IPC client → Desktop adapter → Observation Graph v1
→ Runner Kernel executor → LS-08 Skill compiler/replay — using the same
fake/test-double boundary established in PR-26.

This is the **maximum realism achievable without a real Windows machine**: it
proves the software *logic* is correct end to end. It does **not** and cannot
prove that a real UIA capture of the compiled app produces this exact tree — that
is a separate manual step.

## What still requires a real Windows 11 machine (manual, operator-performed)

See the `manualWindowsVerification` block in `reference-app.fixture.json` and
`docs/testing/windows-m3-manual-checklist.md`. In short, a human must, on real
Windows 11 hardware against the compiled app:

- Confirm a real UIA capture produces the `AutomationId`s / control types above.
- Confirm the password field is captured **masked**, never in cleartext.
- Confirm the destructive "Delete all" click triggers a per-action local approval
  prompt, and a denial changes nothing.
- Confirm the crash button yields a deterministic crash Finding.
- Confirm Job Object cleanup: after shutdown no `WindowsReferenceWpf.exe`
  survives (verified via Task Manager / Process Explorer), and an unrelated
  same-named process started outside the Job is untouched.

The signed result of that manual run is the `WindowsChecklistEvidence` record
that `decideGraphFreeze` requires before Observation Graph v1 may move from
`candidate` to `frozen`. This automated PR never produces that evidence and never
reports `frozen`.
