# Issue Tracker: Local Markdown

Implementation issues and specs for this repo are tracked Markdown files under `.scratch/`. GitHub pull requests and GitHub Issues are not general request or triage surfaces. The sole exception is a deferred, non-blocking advanced-hardening finding produced by scoped review: create one GitHub Issue for that follow-up and do not implement it in the current ticket.

## Conventions

- One effort per directory: `.scratch/<feature-slug>/`.
- The specification is `.scratch/<feature-slug>/spec.md`.
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`; never combine all tickets in one file.
- Triage state is a `Status:` line near the top of each issue file. Use the role strings in `docs/agents/triage-labels.md`.
- Comments and conversation history append under a `## Comments` heading.

When a skill says to publish tracked work, create or update the corresponding Markdown file instead of calling a remote issue tracker.

When a skill says to fetch a ticket, read the referenced path. The user will normally provide either that path or its issue number.

## Closure Tasks

The tracked umbrella spec and ticket files are the production-closure authority. Create or update a ticket when implementation work is planned or a core blocker stops its owning ticket. Do not create recursive local remediation tickets after review.

Every closure issue must record:

- Closure ticket and legacy allocation, when applicable.
- A precise fixed point: base SHA and reviewed head SHA.
- Affected context from `CONTEXT-MAP.md`.
- Finding severity: Critical, Important, Minor, or Suggestion.
- Source citation: plan, architecture, spec, contract, or Gate.
- File and line reference when applicable.
- Required fix, owner, status, fix commit, and verification command.

## Review Findings

`/code-review` has separate Standards and Spec axes. Every round reviews the complete applicable behavior matrix and whole diff. Critical findings block. Important findings block only when they violate explicit acceptance, an applicable existing architecture/security invariant, a public or persisted contract, a required Gate, or primary-workflow correctness/data integrity. After a core fix, rerun affected Gates and a fresh complete-matrix review.

## Deferred Follow-ups

Advanced hardening is a new threat model, environment, exhaustive defense-in-depth requirement, or protection beyond the current ticket and existing invariants. A Critical finding is always a core blocker. Non-Critical advanced hardening is non-blocking unless the user promotes it into scope.

For each deferred advanced-hardening finding:

- Create one GitHub Issue in `ljie-PI/Qualigence` after the scoped review.
- Include source ticket, branch or PR, fixed/reviewed head SHA, severity/risk, authority citation, affected files/Gates, and acceptance criteria.
- Do not add it as a blocker, change the current branch for it, or begin implementation automatically.
- Keep core implementation tickets and their dependency graph in Local Markdown.

Never put secrets, PRD plaintext, raw evidence, tokens, certificates, connection strings, or customer identifiers in a local issue.

## Wayfinding

- Map: `.scratch/<effort>/map.md`.
- Child ticket: `.scratch/<effort>/issues/<NN>-<slug>.md`.
- `Type:` records `research`, `prototype`, `grilling`, or `task`.
- `Status:` records the canonical triage role, or `claimed`/`resolved` for active wayfinding work.
- `Blocked by: NN, NN` lists prerequisite tickets.
- A ticket is unblocked when every listed blocker is `resolved`.
- The frontier is the first numbered open, unblocked, unclaimed ticket under `.scratch/<effort>/issues/`.
- Claim a ticket by setting `Status: claimed` before work.
- Resolve it by adding `## Answer`, setting `Status: resolved`, and adding a context pointer to the map.
