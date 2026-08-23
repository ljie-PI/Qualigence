# 16 — Expand multi-step Plan and action contracts

**What to build:** Add the new immutable plan/action forms beside existing forms so navigate, click, input, select, scroll, verify, and step-indexed Trace can migrate without breaking current callers.

**Blocked by:** 01 — Freeze remaining closure authority.

**Status:** resolved

**Execution protocol:** This is an expand phase. Run type/conformance/unit tests during changes; scoped review before any E2E. Maximum five review rounds, then remediation ticket.

- [x] Plan/protobuf/types support all six step kinds losslessly with explicit step index.
- [x] Select uses Plan-owned valueRef; scroll uses fixed direction and `small|page` amount.
- [x] Existing callers remain green until migration tickets complete.
- [x] Malformed/unsupported plans fail before queue or offer.

## Answer

Pull request: `https://github.com/ljie-PI/Qualigence/pull/70`

Merge commit: `8c1c06f5f3bd10b0255d06a6b347e4d89a25d7fa`

Final verification: clean-worktree focused Gate passed 8 files / 112 tests; build, typecheck, diff check, and final Standards/Spec review passed. Browser E2E was not applicable to this contract-expand ticket.
