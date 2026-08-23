# 17 — Propagate execution budget and model usage

**What to build:** Enforce deterministic step, time, output-token, and consumed-token budgets across Provider, Gateway, Agent, and Runner Runtime.

**Blocked by:** 16 — Expand multi-step Plan and action contracts.

**Status:** resolved

**Execution protocol:** Use unit/contract/property tests during edits; review cleanly before model/provider E2E. Five-round remediation applies.

- [x] Provider output limits and usage flow losslessly through every model seam.
- [x] Missing usage is `ModelUsageUnavailable`, never zero.
- [x] Step/time/token exhaustion produces the approved stable terminal classification.
- [x] Retry and correction consume budget deterministically without double counting.

## Comments

Historical review finding: audit observer rejection/hang could prevent known usage from reaching the budget and trigger duplicate reporting. Ticket 37 / PR #73 resolved it before Ticket 18 proceeded.

## Answer

Pull request: `https://github.com/ljie-PI/Qualigence/pull/72`

Merge commit: `9df95b17a25e206b20a4f964694e42ebf18906c8`

Remediation pull request: `https://github.com/ljie-PI/Qualigence/pull/73`

Remediation merge commit: `87b8d5a1ba8bacb15ee70b9cf7d4daf932a962e9`

Final verification: focused Gate passed 11 files / 125 tests; typecheck, diff check, and final review passed. No product E2E was run for this model/budget ticket.
