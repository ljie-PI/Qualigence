# Issue Tracker: Local Markdown

Issues and specs for this repo live as Markdown files under `.scratch/`. GitHub pull requests and GitHub Issues are not request or triage surfaces for this workflow.

## Conventions

- One effort per directory: `.scratch/<feature-slug>/`.
- The specification is `.scratch/<feature-slug>/spec.md`.
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`; never combine all tickets in one file.
- Triage state is a `Status:` line near the top of each issue file. Use the role strings in `docs/agents/triage-labels.md`.
- Comments and conversation history append under a `## Comments` heading.

When a skill says to publish tracked work, create or update the corresponding Markdown file instead of calling a remote issue tracker.

When a skill says to fetch a ticket, read the referenced path. The user will normally provide either that path or its issue number.

## Closure Tasks

The production-closure plan is the task authority. Create or update a local issue when a task is blocked, review identifies work outside its approved Files block, or a deferred non-blocking finding needs an owner.

Every closure issue must record:

- Closure task and plan section.
- A precise fixed point: base SHA and reviewed head SHA.
- Affected context from `CONTEXT-MAP.md`.
- Finding severity: Critical, Important, Minor, or Suggestion.
- Source citation: plan, architecture, spec, contract, or Gate.
- File and line reference when applicable.
- Required fix, owner, status, fix commit, and verification command.

## Review Findings

`/code-review` has separate Standards and Spec axes. Record each blocking finding independently. Critical and Important findings block merge and dependent work owned by that finding's task. After a fix or restack, update the local issue with the new head SHA, rerun the affected Gates, and run a fresh scoped review.

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
