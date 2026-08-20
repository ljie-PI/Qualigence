# Agent Guide

## Agent Skills

### Issue Tracker

Issues and specs live as Local Markdown under `.scratch/<feature>/`. Before creating, reviewing, or resolving tracked work, read `docs/agents/issue-tracker.md`.

### Triage Labels

Use the five canonical local issue status labels. See `docs/agents/triage-labels.md`.

### Domain Docs

This repo uses multi-context domain documentation selected by `CONTEXT-MAP.md`. Before changing or reviewing any production module, read `docs/agents/domain.md` and every selected context.

### Preserve Existing Design

Before editing code, inspect the surrounding module and its callers, adapters, tests, and documented context. Extend the existing interfaces, seams, dependency direction, naming, error semantics, and test patterns rather than introducing a parallel structure. Keep changes local and compatible with established invariants. If the requested change conflicts with the existing design or requires a new architectural seam, stop and obtain explicit approval before editing.

## Closure Work

Before a closure task, read `docs/superpowers/plans/2026-08-16-production-closure-temporary.md` sections **Status and authority**, **Global Constraints**, **Current execution state**, and **Dependency order**, the complete selected Task, and its cited architecture sections. The coordinator or reviewer owns later Task dependencies and plan changes.

For a pull request, run the documented focused Gate, `corepack pnpm typecheck`, and `git diff --check`. Run `/code-review` against the exact merge-base after the final commit. A Critical or Important finding blocks the dependent task until a new fix commit passes the affected Gates and a fresh review.
