# Domain Documentation

## Layout

Qualigence uses multi-context documentation. `CONTEXT-MAP.md` selects the context to read before implementation or review. Context documents define stable terms, ownership, seams, invariants, entrypoints, and test surfaces. They do not replace the approved architecture, LS Specs, or production-closure plan.

## Reading Rules

- Read the selected context before changing a production module or reviewing its diff.
- Read the architecture section and LS Spec linked by that context when a change affects a public contract, persistence, security, or deployment.
- Read the exact Task in `docs/superpowers/plans/2026-08-16-production-closure-temporary.md` before editing closure work.
- Treat `docs/production-closure-status.md` as evidence history, not as proof that wiring exists.
- Propose an ADR under `docs/adr/` before changing a stable ownership or dependency-direction rule. Do not create an ADR for an implementation detail already decided by the architecture or approved Task.

## Context Completion

A context is correctly applied when the change preserves its listed invariants, uses its named seam instead of bypassing it, and runs the context's focused verification before broader Gates.
