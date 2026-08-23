# 37 — Preserve usage through audit failures

**What to build:** Close Ticket 17's round-5 finding so audit observer rejection or delay cannot discard typed model usage, cause duplicate reports, or outlive the execution wall deadline.

**Historical dependency:** Ticket 17, now resolved.

**Status:** resolved

**Fixed points:** Base `8c1c06f`; Ticket 17 reviewed head `9f413f9`.

**Finding:** Important Spec finding in Model Gateway/Agent reporting: observer rejection/hang can prevent known usage from reaching ExecutionBudget and successful invocations may report twice.

**Affected Gates:** Ticket 17 focused model-gateway/model-agent/runtime Gate.

- [x] Return typed invocation outcome/usage independently of audit observer success.
- [x] Emit one logical report per invocation and bound reporting by the same wall deadline.
- [x] Charge every known attempt exactly once; missing finite usage remains `ModelUsageUnavailable`.
- [x] Run focused Gates, typecheck, diff check, and clean exact-base review.

## Answer

Pull request: `https://github.com/ljie-PI/Qualigence/pull/73`

Merge commit: `87b8d5a1ba8bacb15ee70b9cf7d4daf932a962e9`

Final verification: focused Gate passed 11 files / 125 tests; typecheck, diff check, and final Standards/Spec review passed. No product E2E was run for this remediation.
