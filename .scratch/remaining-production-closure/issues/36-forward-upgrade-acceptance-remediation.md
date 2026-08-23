# 36 — Prove forward-upgrade acceptance

**What to build:** Close Ticket 02's round-5 finding by making the real backup/restore acceptance start from an older persisted PostgreSQL schema, invoke the Admin CLI migration path, prove every intermediate version, and restore the invocation-bound backup into a clean target with identical source rows and object bytes.

**Historical dependency:** Ticket 02, now resolved.

**Status:** resolved

**Fixed points:** Base `8c1c06f`; Ticket 02 reviewed head `e2c66d1`.

**Finding:** Important Spec finding in `tests/e2e/self-hosted/backup-restore.test.ts`: fixture provisioned schema 7 directly and never invoked forward migration from a persisted older version.

**Affected Gates:** Ticket 02 focused Gate and post-review `tests/e2e/self-hosted/backup-restore.test.ts`.

- [x] Create a real supported old-version PostgreSQL state without modifying migrations 001–007.
- [x] Invoke the production migrate command and assert sequential version application with no skips.
- [x] Verify the pre-migration backup is invocation/target-bound and clean restore reproduces every seeded source-row column and object byte from independent expected literals.
- [x] Run affected focused Gates, typecheck, and diff check after the E2E fix.
- [x] Obtain a fresh coordinator review, then rerun E2E if authorized.

## Answer

Pull request: `https://github.com/ljie-PI/Qualigence/pull/74`

Merge commit: `d03179e8b6662a359485b4a1a71cec114eb173fc`

Final verification: focused Gate passed 10 files / 49 tests; real schema-1 forward-upgrade/backup/restore E2E passed 1 file / 3 tests; Compose rendering, typecheck, diff check, and final review passed.
