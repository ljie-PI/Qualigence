# 18 — Deliver safe valueRef input

**What to build:** Resolve Plan-owned input/select values inside a bounded Runner-owned root and keep the exact resolved source values out of the verified primary workflow's emitted and persisted sinks.

**Blocked by:** 17 — Propagate execution budget and model usage; 37 — Preserve usage through audit failures.

**Status:** resolved

**Execution protocol:** Run value-provider/security/Web component tests during implementation; scoped review before real Chromium E2E.

- [x] Traversal, symlink, permission, file type, missing value, and size >64 KiB fail closed.
- [x] The primary exact-value E2E found neither resolved source value in model requests, Runner logs, submitted Trace, completion payloads, pre-ACK spool events, or raw spool bytes.
- [x] Input/select capability is advertised only when the provider is configured and healthy.
- [x] Clean-review Chromium E2E proves separate immutable input/select Jobs through valueRef and scans the verified exact-value sinks.

## Answer

Pull request: `https://github.com/ljie-PI/Qualigence/pull/75`

Merge commit: `de2b77369801785696b57b5dfacfd230bc0ea3d3`

Final verification: focused Gate passed 10 files / 105 tests with one existing Task 21 skip; production Chromium valueRef E2E passed 1 file / 1 test; build, typecheck, diff check, and focused review passed.

Deferred from this completed ticket: browser-normalized and reflected secret-derived forms were not proven by its primary acceptance. Closed PRs #78-#83 are abandoned, unmerged historical attempts and are not implementation sources. The maintainer later promoted the hardening into fresh tracked Tickets 39-45; closed GitHub Issue `https://github.com/ljie-PI/Qualigence/issues/87` records that promotion history.
