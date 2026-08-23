# 02 — Implement offline PostgreSQL forward upgrades

**What to build:** Allow an operator to upgrade every persisted Self-hosted schema one version at a time through the existing Admin CLI, with an invocation-bound verified backup and owner-role migration.

**Blocked by:** 01 — Freeze remaining closure authority.

**Status:** resolved

**Execution protocol:** During edits run unit and migration/provider functional tests only. After each committed implementation/fix, run scoped `/code-review`; fix Critical/Important findings for at most five rounds. Provision upgrade/restore E2E only after a clean review.

- [x] The migration command creates and verifies a fresh target-bound backup after obtaining the offline lock.
- [x] Supported persisted versions upgrade sequentially without skips; runtime roles cannot execute DDL.
- [x] Failure injection leaves the source schema/data recoverable and prevents application startup.
- [x] Clean-review upgrade/restore E2E proves the target schema and bytes in a clean environment.

## Comments

Historical review finding: the original acceptance provisioned schema 7 directly and did not prove an older persisted schema upgraded sequentially before restore. Ticket 36 / PR #74 resolved it before Ticket 03 proceeded.

## Answer

Pull request: `https://github.com/ljie-PI/Qualigence/pull/71`

Merge commit: `17d9e875f6e4a12742ad9e69f28320839685c873`

Remediation pull request: `https://github.com/ljie-PI/Qualigence/pull/74`

Remediation merge commit: `d03179e8b6662a359485b4a1a71cec114eb173fc`

Final verification: focused Gate passed 10 files / 49 tests; real schema-1 forward-upgrade/backup/restore E2E passed 1 file / 3 tests; typecheck, diff check, and final review passed.
