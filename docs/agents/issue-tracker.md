# Issue Tracker

## System

Qualigence uses GitHub Issues in `ljie-PI/Qualigence` as its issue tracker. Use `gh issue` for issue creation, inspection, and updates. Pull requests are not an issue-tracker intake surface.

## Closure Tasks

The production-closure plan is the task authority. Create or update an Issue when a task is blocked, when review identifies work outside its approved Files block, or when a deferred non-blocking finding needs an owner.

Every closure Issue must record:

- Closure task and plan section.
- A precise fixed point: base SHA and reviewed head SHA.
- Affected context from `CONTEXT-MAP.md`.
- Finding severity: Critical, Important, Minor, or Suggestion.
- Source citation: plan, architecture, spec, contract, or Gate.
- File and line reference when applicable.
- Required fix, owner, status, fix commit, and verification command.

## Review Findings

`/code-review` has separate Standards and Spec axes. Record each blocking finding independently. Critical and Important findings block merge and all dependent work. After a fix or restack, update the Issue with the new head SHA, re-run the affected Gates, and run a new two-axis review.

## Commands

```powershell
gh issue create --repo ljie-PI/Qualigence --title "..." --body-file <file>
gh issue view <number> --repo ljie-PI/Qualigence
gh issue comment <number> --repo ljie-PI/Qualigence --body "..."
```

Never put secrets, PRD plaintext, raw evidence, tokens, certificates, connection strings, or customer identifiers in an Issue.
