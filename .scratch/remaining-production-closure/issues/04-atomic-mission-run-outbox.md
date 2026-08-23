# 04 — Atomically schedule Mission, Run, and dispatch outbox

**What to build:** Make Mission start atomically reserve idempotency and create the logical Job attempt, Runner Job, Run, immutable provenance, dispatch outbox, and tenant wakeup.

**Blocked by:** 03 — Deliver versioned Target and Test Plan product paths; 38 — Prove rendered product intake acceptance.

**Status:** resolved

**Execution protocol:** Run domain/provider contract and failure-injection tests on every change. Review exact diff before provisioning E2E. Stop after five blocked review rounds and create remediation work.

- [x] Semantic idempotency replay returns original generated identities without invoking allocators.
- [x] Stale plan version or Mission revision/hash/status returns a stable conflict and writes nothing.
- [x] Failure after any write rolls back Mission, Run, attempt, outbox, provenance, and wakeup together.
- [x] Shared SQLite/PostgreSQL contract proves concurrency, restart, tenant isolation, and immutable lineage.

## Answer

Pull request: `https://github.com/ljie-PI/Qualigence/pull/85`

Merge commit: `14bcf76cc686244775a127c86cfaa2b19e4ad4a2`

Final verification: Ticket Gate passed 4 files / 71 tests and storage/provider Gate passed 15 files / 141 tests; typecheck, diff check, and exact-head review passed. No product E2E was run for this provider-contract ticket.
