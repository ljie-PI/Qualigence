# Agent Guide

## Agent Skills

### Issue Tracker

Qualigence tracks implementation and review findings in GitHub Issues. Read `docs/agents/issue-tracker.md` before creating, reviewing, or resolving tracked work.

### Domain Docs

Qualigence uses multi-context domain documentation. Read `docs/agents/domain.md` and then the context selected by `CONTEXT-MAP.md` before changing a production seam or reviewing its implementation.

## Closure Work

Before working on Local, Self-hosted, or Windows M3 closure, read `docs/superpowers/plans/2026-08-16-production-closure-temporary.md`. It defines task scope, dependency order, security constraints, required evidence, and release acceptance.

For a pull request, run the documented focused Gate, typecheck, and `git diff --check`. Run `/code-review` against the exact merge-base after the final commit. A Critical or Important finding blocks the dependent task until a new fix commit passes the affected Gates and a fresh review.
