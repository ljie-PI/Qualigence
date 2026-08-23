# Observation Graph v1 — Freeze Checklist (candidate)

Status: **candidate** — Observation Graph v1 is a candidate and MUST NOT be
frozen until tickets 22-35 produce and validate the Graph migration, Desktop,
native Windows, manual, CI, and release evidence below. Current migration
tooling emits only `status: "candidate"` and `gate.frozen: false`; ticket 35
owns the deterministic `frozen` transition.

## Candidate Baseline

- [x] Single Observation Graph v1 contract + JSON Schema
      (`@qualigence/observation-contracts`), re-exported additively from
      `@qualigence/runner-protocol`.
- [x] Canonical/extension validation: canonical fields strict, unknown
      non-extension fields rejected, `extensions` namespace (`<name>/v<major>`)
      accepted and round-tripped.
- [x] Deterministic, non-destructive pre-v1 → v1 projection tagging migrated
      assets with `pre-v1` provenance; historical sources are never mutated.
- [x] Skill recompilation against migrated v1 data with replay-oracle behavioral
      equivalence to the pre-v1 baseline.
- [x] Idempotent, resumable admin migration command
      (`qualigence migrate-observation`) with a durable JSONL ledger and an
      atomic candidate Freeze Report.

## Freeze Gate

- [ ] Web Playwright and Windows UIA conformance pass on the shared
      node/state/checkpoint fields.
- [ ] `uia/v1` extension losslessly preserves Windows-only semantics.
- [ ] 100% of representative pre-v1 Trace samples read successfully; every
      migration result is `migrated`/`deprecated`/`needs_human` with **zero
      unexplained `failed`**.
- [ ] Every active pre-v1 Skill has a Verified v1 version or an explicit
      Deprecated/Needs-Human disposition.
- [ ] Runner Protocol capability negotiation declares Graph/extension versions
      and rejects incompatible majors.
- [ ] JSON Schema, canonical examples, breaking-change check and migration
      report are versioned.
- [ ] Human signoff on schema stability.

Only when every box above is checked — in the LS-13 M3 Gate PR — may the graph
lifecycle move from `candidate` to `frozen`. After freeze, the
`observation-graph/v1` major is under a compatibility promise and platform
targets must extend (via typed extensions) rather than modify the common core.

## LS-13 wiring: how the checklist above is enforced in code

LS-13 (PR-27) delivered the auditable machinery that turns the boxes above into
a pure, testable decision — but it deliberately does **not** flip the status.
The `frozen` transition is only reachable through
`decideGraphFreeze(candidateReport, windowsChecklistEvidence, schemaConformanceEvidence)`
in `packages/observation-migration/src/freeze-decision.ts`, which returns
`status: "frozen"` **only** when all three inputs are present and valid:

1. **Candidate Freeze Report** (LS-12) with zero unexplained migration failures.
2. **`WindowsChecklistEvidence`** — the signed result of a human running
   `docs/testing/windows-m3-manual-checklist.md` on real Windows 11 hardware
   (see that file's Section 18 for the exact record shape and the Section 16
   security-veto item ids that must all be `pass`).
3. **`SchemaConformanceEvidence`** — proof that both Web (PR-02/M1) and Desktop
   (PR-27 Reference App tests) validate the SAME v1 schema on the shared core
   fields (`role`, `name`, `value`, `state`, `relations`).

Any missing/invalid input yields `status: "candidate"` with `blockingReasons[]`.

> **This automated environment reports `candidate`, always.** No real signed
> `WindowsChecklistEvidence` exists in this repository, so
> `generateAutomatedFreezeGateReport()`
> (`packages/observation-migration/src/freeze-gate.ts`) is structurally unable to
> emit `frozen` — it has no parameter to inject Windows evidence. A dedicated
> test asserts the generated artifact never contains `"status":"frozen"` (the
> "cannot lie about being frozen" invariant). v1 becomes `frozen` only after a
> human completes the manual checklist and someone invokes `decideGraphFreeze`
> with that real evidence in a follow-up action.
