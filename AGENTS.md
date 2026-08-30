# Agent Guide

## Agent Skills

### Issue Tracker

Issues and specs are tracked in GitHub Issues for `ljie-PI/Qualigence`; production closure uses umbrella Issue [#67](https://github.com/ljie-PI/Qualigence/issues/67) and its sub-issues. Before creating, reviewing, or resolving tracked work, read `docs/agents/issue-tracker.md`.

### Triage Labels

Use the five canonical GitHub issue labels. See `docs/agents/triage-labels.md`.

### Domain Docs

This repo uses multi-context domain documentation selected by `CONTEXT-MAP.md`. Before changing or reviewing any production module, read `docs/agents/domain.md` and every selected context.

### Preserve Existing Design

Before editing code, inspect the surrounding module and its callers, adapters, tests, and documented context. Extend the existing interfaces, seams, dependency direction, naming, error semantics, and test patterns rather than introducing a parallel structure. Keep changes local and compatible with established invariants. If the requested change conflicts with the existing design or requires a new architectural seam, stop and obtain explicit approval before editing.

## Closure Work

Before a closure task, read umbrella Issue [#67](https://github.com/ljie-PI/Qualigence/issues/67), the complete selected sub-issue, and every architecture/context reference named by that issue. The umbrella spec and its sub-issues are the current execution authority; the coordinator or reviewer owns later ticket dependencies and authority changes.

For stateful, side-effecting, concurrent, retrying, timeout-sensitive, or terminal work, freeze the applicable behavior matrix in the selected GitHub issue before editing; simple docs/static/leaf work may mark it `N/A`. Every `/code-review` round covers the complete matrix and whole code/test diff and reports every row as `pass | finding | N/A`.

Create the non-draft pull request only after the documented focused Gate, `corepack pnpm typecheck`, `git diff --check`, complete-matrix `/code-review`, required E2E, and final status evidence are clean. The PR may add one final documentation-only evidence commit after the reviewed code head; verify its code/test diff is unchanged, then merge directly after required checks. Documentation-only tickets/commits do not run `/code-review` or product E2E; verify document consistency, authority/reference coverage, and `git diff --check`.

Critical findings always block. Important findings block only when they violate explicit acceptance, an applicable existing architecture/security invariant, a public/persisted contract, a required Gate, or primary-workflow correctness/data integrity. Record non-Critical advanced hardening as a deferred GitHub Issue and do not implement it in the current ticket unless the user promotes it.
