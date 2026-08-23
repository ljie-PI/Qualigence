# 38 — Prove rendered product intake acceptance

**What to build:** Close Ticket 03's final findings with a real rendered Console workflow that creates/revises Web and Desktop Targets, creates/approves a Test Plan, creates a valid Mission, displays real conflict state, and reruns all acceptance after the final idempotency fix.

**Historical dependency:** Ticket 03 / PR #76, now resolved.

**Status:** resolved

**Fixed points:** Base `17d9e87`; Ticket 03 reviewed head `f8a819a`.

**Affected Gates:** Ticket 03 focused Gate; rendered `tests/e2e/web-console/target-test-plan.test.ts`; schema-8 backup/restore acceptance.

- [x] Render actual Console routes/components rather than calling only `PublicApiClient`.
- [x] Exercise Web/Desktop revision, Test Plan approval, Mission creation, and real conflict reload.
- [x] Rerun focused Gates and all post-review acceptance after the final production head.
- [x] Pass clean review and dedicated remediation PR.

## Answer

Pull request: `https://github.com/ljie-PI/Qualigence/pull/77`

Merge commit: `fe30bfc8add4a7db38e4a81bc7701d44e9bf4c15`

Final verification: focused Gate passed 4 files / 52 tests; rendered Console E2E passed 1 file / 1 test and schema-8 backup/restore E2E passed 1 file / 3 tests; typecheck, diff check, and final review passed.
