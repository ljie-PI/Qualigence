# Domain Documentation

## Layout

Qualigence uses multi-context domain documentation. `CONTEXT-MAP.md` maps change areas to context-specific `CONTEXT.md` files. System-wide ADRs live under `docs/adr/`; a context may also own ADRs under its documented context directory.

Context documents define stable terms, ownership, seams, invariants, entrypoints, and focused test surfaces. They do not replace approved architecture, LS Specs, or the production-closure plan.

## Reading Rules

- Before exploring, changing, or reviewing a production area, read `CONTEXT-MAP.md` and every selected context.
- Read system-wide and context-scoped ADRs that affect the area. If no ADR directory exists, proceed silently; create ADRs lazily only when a resolved decision warrants one.
- Read the architecture sections and LS Specs referenced by the selected contexts when work affects a public contract, persistence, security, deployment, or stable ownership.
- Read the complete selected Task in `docs/superpowers/plans/2026-08-16-production-closure-temporary.md` before editing closure work.
- Treat `docs/production-closure-status.md` as evidence history, not proof that production wiring exists.
- Use the glossary's exact domain vocabulary in issue titles, specifications, tests, hypotheses, and code. Avoid synonyms that blur established concepts.
- If a required concept is absent from the glossary, first check whether the proposed term conflicts with existing language; record a genuine gap through `/domain-modeling`.
- If proposed work contradicts an ADR, identify that conflict explicitly rather than silently overriding it.
- Propose an ADR before changing a stable ownership or dependency-direction rule. Do not create an ADR for an implementation detail already decided by architecture or an approved Task.

## Context Completion

A context is correctly applied when the change preserves its invariants, uses its named seam rather than bypassing it, follows established dependency direction and error semantics, and passes the context's focused verification before broader Gates.
