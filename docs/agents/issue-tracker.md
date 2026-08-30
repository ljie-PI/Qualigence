# Issue Tracker: GitHub

New issues and specs for this repo live as GitHub Issues in `ljie-PI/Qualigence`. Use the `gh` CLI for issue operations.

## Conventions

- Create: `gh issue create --title "..." --body "..."`.
- Read: `gh issue view <number> --comments` and fetch labels when triage state matters.
- List: `gh issue list --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- Comment: `gh issue comment <number> --body "..."`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull Requests as a Triage Surface

**PRs as a request surface: no.** Set this to `yes` only if the repo later treats external pull requests as feature requests.

GitHub shares one number space across issues and pull requests. Resolve an ambiguous `#42` with `gh pr view 42`, then fall back to `gh issue view 42`.

## Publishing and Fetching

When a skill says to publish tracked work, create a GitHub Issue. When it says to fetch a ticket, run `gh issue view <number> --comments`.

## Production-Closure Authority

GitHub Issue [#67](https://github.com/ljie-PI/Qualigence/issues/67) contains the complete production-closure specification and is the umbrella for its 47 native sub-issues. Those issues preserve the legacy ticket number in their titles, full ticket bodies, completion evidence, triage state, and direct implementation dependencies.

Read the umbrella and complete selected sub-issue before closure work. Use the native sub-issue and dependency relationships for navigation; explicit phase-two or final-resolution dependencies remain authoritative in each issue body when representing them as native dependencies would create a cycle.

## Review Findings and Deferred Follow-ups

Critical findings block. Important findings block only when they violate explicit acceptance, an applicable architecture or security invariant, a public or persisted contract, a required Gate, or primary-workflow correctness or data integrity.

Create one GitHub Issue for each deferred, non-blocking advanced-hardening finding. Include its source ticket, branch or pull request, fixed and reviewed head SHA, severity and risk, authority citation, affected files and Gates, and acceptance criteria. Do not implement it in the current ticket unless the user promotes it into scope.

## Wayfinding Operations

- Map: one issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog.
- Child: a GitHub sub-issue linked to the map and labelled `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`). If sub-issues are unavailable, use a task list and put `Part of #<map>` at the top of the child.
- Blocking: use native issue dependencies; if unavailable, maintain a `Blocked by: #<n>, #<n>` line.
- Frontier: choose the first open child in map order that has no open blocker and no assignee.
- Claim: `gh issue edit <n> --add-assignee @me` before work.
- Resolve: comment with the answer, close the child, and append a context pointer to the map's Decisions-so-far.

Never put secrets, PRD plaintext, raw evidence, tokens, certificates, connection strings, or customer identifiers in an issue.
