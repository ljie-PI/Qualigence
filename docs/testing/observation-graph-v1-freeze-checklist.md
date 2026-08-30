# Observation Graph v1 — Freeze Checklist (candidate)

Status: **candidate** — Observation Graph v1 is a candidate and MUST NOT be
frozen until Tickets 22-35 produce the Graph migration, Desktop, native Windows,
CI, release, and deterministic finalizer implementation, and integrated Ticket
48 validates the real Windows, provider, publication, and final release evidence.
Current migration tooling emits only `status: "candidate"` and
`gate.frozen: false`. Ticket 35 provides the deterministic serialized-evidence
finalizer; Ticket 48 alone selects the release version, supplies real evidence,
and invokes it for the final human-approved transition.

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

## Deterministic finalizer wiring

`finalizeGraphFreezeFromEvidence(...)` is the terminal public interface in
`@qualigence/observation-migration`. It reads immutable JSON bytes from
`artifacts/manual-acceptance/<version>/` and
`artifacts/release/<version>/`, recomputes every caller-pinned SHA-256, rejects
path traversal and symlinks, and validates repository/version/commit/timestamp
binding before any decision is published.

The decision covers these capabilities:

1. GitHub Issue #67's exact ticket dependency graph plus
   PR/review/check/commit closure.
2. Candidate migration inventory and Freeze Report.
3. Hash-linked command-produced Web/Desktop Graph v1 and lossless `uia/v1`
   conformance reports.
4. Hash-linked Ticket 29/30 native Windows reports.
5. Real-provider smoke and complete stdout/stderr/persisted-output redaction
   reports, plus Reference Model attempt-to-invocation evidence.
6. Ticket 34 release manifest, exact mandatory CI archives, signed local/RDP
   Windows checklist, SBOM, provenance, and attestations.

The finalizer reuses `scripts/verify-release-manifest.mjs`; it does not duplicate
or weaken Ticket 34's release authority. It atomically creates exactly
`artifacts/release/<version>/graph-freeze-decision.json`. Byte-identical replay is
idempotent, conflicting replay never overwrites the terminal artifact, and
cancellation or persistence failure cannot return success-shaped output.

Any missing or invalid capability yields `status: "candidate"` with exact stable
`blockingReasons[]` and no `signoff`. `signoff` is structurally present only when
every capability is verified and the result is `frozen`.

> **This repository still reports `candidate`.** Checked-in fixtures prove the
> complete finalizer path but are not release evidence. Integrated Ticket 48 must
> perform the real Windows/provider/publication work and invoke the merged
> finalizer before v1 can become `frozen`.
