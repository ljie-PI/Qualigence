# 03 — Deliver versioned Target and Test Plan product paths

**What to build:** Let a tester create and approve immutable Web/Desktop Target revisions and Test Plan revisions through the Public API and Console, including explicit Runner binding.

**Blocked by:** 02 — Implement offline PostgreSQL forward upgrades; 36 — Prove forward-upgrade acceptance.

**Status:** resolved

**Execution protocol:** Use focused API/domain/provider tests during edits; scoped review before E2E; maximum five review rounds, then create a remediation ticket if blocking findings remain.

- [x] Target revisions persist execution configuration, project provenance, version, snapshot hash, and explicit Runner ID without secrets.
- [x] Test Plan approval uses expected-version and immutable revision semantics.
- [x] API and Console expose tenant-isolated read/mutation workflows with stable conflict envelopes.
- [x] After clean review, rendered/API E2E proves an approved Target/Test Plan can feed Mission creation.

## Comments

Historical review findings: PR #76 acceptance was API-client-only rather than rendered Console, and E2E had not been rerun after the final idempotency fix. Ticket 38 / PR #77 resolved both before Ticket 04 proceeded.

## Answer

Pull request: `https://github.com/ljie-PI/Qualigence/pull/76`

Merge commit: `454f96a055053e15dd24a9c85762bd83046c68e0`

Remediation pull request: `https://github.com/ljie-PI/Qualigence/pull/77`

Remediation merge commit: `fe30bfc8add4a7db38e4a81bc7701d44e9bf4c15`

Final verification: remediation focused Gate passed 4 files / 52 tests; rendered Console E2E passed 1 test and schema-8 backup/restore E2E passed 3 tests; typecheck, diff check, and final review passed.
