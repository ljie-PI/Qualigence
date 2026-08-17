# Agent Guide

## Agent Skills

### Issue Tracker

Before creating, reviewing, or resolving tracked work, read `docs/agents/issue-tracker.md`.

### Domain Docs

Before changing or reviewing any production module, read `docs/agents/domain.md` and every context selected by `CONTEXT-MAP.md`.

## Closure Work

Before working on Local, Self-hosted, or Windows M3 closure, read `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`. It defines task scope, dependency order, security constraints, required evidence, and release acceptance.

For a pull request, run the documented focused Gate, `corepack pnpm typecheck`, and `git diff --check`. Run `/code-review` against the exact merge-base after the final commit. A Critical or Important finding blocks the dependent task until a new fix commit passes the affected Gates and a fresh review.
