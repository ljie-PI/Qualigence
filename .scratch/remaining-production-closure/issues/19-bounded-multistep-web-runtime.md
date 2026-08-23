# 19 — Complete bounded multi-step Web Runtime

**What to build:** Execute immutable Web plans step by step through the established Runtime, including observation, decision, authorization, action, verification, and terminal Trace.

**Blocked by:** 18 — Deliver safe valueRef input.

**Status:** resolved

**Execution protocol:** Run Runtime/Agent/adapter component tests on every change; scoped review before full multi-step Chromium E2E; maximum five rounds.

- [x] Mission plan reaches the accepted Runner Job unchanged.
- [x] Every step enforces kind-specific model schema, policy, budget, stepIndex, and stale-descriptor invalidation.
- [x] Unknown action outcome is never automatically retried.
- [x] Old single-click compatibility form is removed only after all callers migrate and the final Gate is green.

## Answer

Pull request: `https://github.com/ljie-PI/Qualigence/pull/86`

Merge commit: `4ec4ebd5df46dc8ba2f658dd90065f20c9daf130`

Final verification: focused Gate passed 13 files / 293 tests with one existing Task 21 skip; post-review Chromium acceptance passed 1 file / 10 tests; build, typecheck, diff check, and scoped review passed. Browser-normalization hardening was outside this primary workflow and is not an active dependency.
