# Windows Reference App (WinUI 3) — fixture

This directory mirrors `../windows-reference-wpf` but for a **WinUI 3 / Windows
App SDK** reference app, so the pipeline is proven against two different UI
frameworks (`frameworkId` `WPF` vs `WinUI`).

It contains **two distinct kinds of artifact**:

## 1. The reference app source (specification only, does NOT build on Linux)

`WindowsReferenceWinUi.csproj`, `Package.appxmanifest`, `App.xaml(.cs)`,
`MainWindow.xaml(.cs)` are a **real, buildable WinUI 3 desktop application** a
human operator compiles and runs **on Windows 11**. They are the authoritative
specification of the reference app's UI structure and are **not** compiled or
executed by the Linux automated test suite.

## 2. `reference-app.fixture.json` (machine-readable, USED by the Linux tests)

A **synthetic-but-realistic** `UiaSource` capture that drives the Linux-runnable
pipeline tests in `tests/component/windows-uia/*.test.ts`. It proves the full
software stack (Companion → Desktop adapter → Observation Graph v1 → Runner
Kernel → LS-08 Skill compiler/replay) works end to end via the PR-26 fake
boundary. It is the maximum realism achievable off Windows and proves the
software *logic*, not a real UIA capture.

## What still requires a real Windows 11 machine (manual, operator-performed)

See the `manualWindowsVerification` block in `reference-app.fixture.json` and
`docs/testing/windows-m3-manual-checklist.md`. The signed result of that manual
run is the `WindowsChecklistEvidence` record that `decideGraphFreeze` requires
before Observation Graph v1 may move from `candidate` to `frozen`. This automated
PR never produces that evidence and never reports `frozen`.
