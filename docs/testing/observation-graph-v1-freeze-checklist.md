# Observation Graph v1 — Freeze Checklist (candidate)

Status: **candidate** — Observation Graph v1 is a candidate and MUST NOT be
frozen until the LS-13 (M3 Gate) evidence below is attached and signed off. The
LS-12 migration tooling can only ever emit a report with `status: "candidate"`
and `gate.frozen: false`; the `frozen` transition happens in a later PR.

## What LS-12 delivered

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

## Freeze Gate — required before v1 may be frozen (LS-13)

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
