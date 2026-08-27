# 31 — Complete Windows native acceptance

**What to build:** Produce independently reviewed native Windows evidence for the complete Desktop Runner/Companion path.

**Blocked by:** None. Ticket 47 is resolved; this ticket remains human-owned (`ready-for-human`) for signed local-console/RDP native acceptance.

**Status:** ready-for-human

## Tracked scope

This ticket owns native acceptance and is intentionally human-owned. It remains `ready-for-human`: automation may prepare the environment and reports, but it cannot execute, attest, review, or sign the local-console/RDP checklist. Ticket 47 resolved the required automated native harness prerequisite by providing a real `QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS` executable path.

## Migration

No relational or source migration is allocated. The only new durable record is immutable version/date-scoped manual acceptance under `artifacts/manual-acceptance/**`. Never overwrite, delete, synthesize, or reuse a signed record for another product commit/version/environment.

## Affected contexts

- `docs/contexts/execution/CONTEXT.md`
- `docs/contexts/deployment/CONTEXT.md`
- `docs/contexts/evidence/CONTEXT.md`
- `docs/contexts/protocol/CONTEXT.md`
- `docs/contexts/windows/CONTEXT.md`

## Authority

- `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.2-6.5, 7, 8, 10, 11, 13, 14.3, and 15.
- `CONTEXT-MAP.md` and the affected context documents above.
- `docs/testing/windows-m3-manual-checklist.md` in full, including its Section 16 release vetoes, Section 17 two-person signatures, and Section 18 machine-readable evidence mapping.
- `docs/testing/observation-graph-v1-freeze-checklist.md` for the downstream candidate/frozen boundary.

## Allowed Files

This is the complete edit/evidence scope:

- `.scratch/remaining-production-closure/issues/31-windows-native-acceptance.md` for ticket-local final evidence only
- `docs/testing/windows-m3-manual-checklist.md`
- `artifacts/manual-acceptance/**`

Production code and automated test code are not in scope. Any automated failure that requires such a change returns to ticket 30 or Ticket 47, or sets this ticket to `needs-info`; it is not fixed here.

## Requirements

- [ ] WPF and WinUI fixtures pass launch/capture/action/reset/shutdown and UIA worker restart scenarios.
- [ ] Local-console and required RDP/rejection scenarios execute on Windows 11 with `uiAccess=false`.
- [ ] Every security veto and PID-reuse/unrelated-process case passes.
- [ ] Executor and independent reviewer sign the checklist with Run/Trace/Artifact references.
- [ ] The copied record identifies product/Runner/Companion/Runner Protocol/Graph/Skill compiler versions, exact Git commit, Windows edition/build, architecture, display/DPI/language, account privilege, session type, certificate fingerprint, pipe/logon SID, model profile, date, operator, and reviewer.
- [ ] Every failed, not-run, or genuinely not-applicable item records actual result, stable reason, linked GitHub Issue where appropriate, Run/Trace/Artifact evidence, and release-blocking disposition; no security-veto item may be `not_applicable`.
- [ ] Local-console and RDP evidence are both present. An explicitly unsupported RDP policy must be exercised as a deterministic rejection, not omitted.
- [ ] The operator and reviewer are distinct humans and sign only after reviewing the complete record and referenced artifacts.
- [ ] The signed Markdown embeds the complete machine-readable Section 18 `WindowsChecklistEvidence` JSON record required by ticket 35; its hash is recorded without copying secret/evidence plaintext into the ticket.
- [ ] Any failed security veto keeps Graph v1 `candidate`, blocks tickets 32-35, and cannot be waived by automated green results.

## Focused Gate

An agent or operator prepares the exact automated baseline on the same Windows 11 release candidate before manual execution:

```bash
cargo fmt --check
cargo build --workspace
cargo test --workspace
corepack pnpm vitest run tests/component/windows-uia tests/replay/windows-uia tests/conformance/observation/windows-uia.test.ts
corepack pnpm typecheck
git diff --check
```

The source/test head then receives one exact-base complete-matrix review. Automated success does not change this ticket from `ready-for-human` or satisfy the signed evidence requirement.

## Post-review acceptance

- Automated prerequisite: after Ticket 47 is resolved, rerun the focused Gate above on the exact reviewed release-candidate commit with `QUALIGENCE_WINDOWS_UIA_TEST=true` and `QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS` set to the real harness executable for the native WPF/WinUI portions, and retain the reports. Any skip, `Windows11Unavailable`, `WindowsUiaPrerequisiteUnavailable`, `CargoUnavailable`, missing harness, or fixture absence blocks manual sign-off.
- Manual local-console/RDP acceptance: copy the checklist to `artifacts/manual-acceptance/<version>/<date>-windows-m3.md`; execute every applicable section on the exact reviewed commit; record Run/Trace/Artifact references and actual outcomes; complete all Section 16 vetoes; embed the corresponding machine-readable `WindowsChecklistEvidence` JSON; have the executor and an independent reviewer sign Section 17; retain the signed record unchanged.
- Release evidence handoff: run `Get-FileHash -Algorithm SHA256 "artifacts/manual-acceptance/<version>/<date>-windows-m3.md"`, record the SHA-256 and reviewed commit under this ticket's `## Comments`, and supply that exact path/hash to ticket 34's release manifest and ticket 35's serialized freeze decision. Ticket 31 itself does not publish a release or set Graph v1 to `frozen`.

## Delivery and review

The ticket remains `ready-for-human` until a human claims execution and remains unresolved until the signed artifact exists and is independently reviewed. Record the base/reviewed head and artifact hash in `## Comments`; never place secret plaintext or raw customer evidence there. If automated review has a core blocker after five rounds, set this same ticket to `needs-info`, block dependents, and obtain a maintainer decision before manual execution. If manual execution finds a core product blocker, record it on this ticket, set `needs-info`, and return ownership to the source ticket. Do not create recursive remediation tickets. Non-Critical advanced hardening alone may become a linked GitHub Issue.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary | Public result | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Automated native prerequisite is fully green on exact reviewed commit | `not_started` for manual actions | Manual execution may begin | Immutable automated reports identify commit/environment | Rerun whole prerequisite if source/test head changes | Reviewed SHA and native report hashes |
| Automated prerequisite fails, skips, or lacks required environment | `not_started` | Acceptance blocked with stable environmental/product reason | Ticket records blocker; no signed pass record | Retry only after environment restoration or reviewed product fix | Failed report and `needs-info`/block evidence |
| Valid local-console WPF/WinUI workflow | `started` at App launch/action | Recorded pass/fail per checklist item | Signed record links exact Run/Trace/Artifact evidence | Repeat creates a new dated record; never overwrite | Local-session metadata and item evidence |
| Supported RDP workflow succeeds | `started` | Recorded pass/fail | Same immutable record includes RDP session evidence | New session/run for retry | RDP metadata and referenced run |
| RDP/other/elevated/locked session is unsupported by policy | `not_started` for UI action | Required stable rejection such as `InteractiveSessionUnavailable`/`UiaAccessDenied` | Rejection is recorded as the expected scenario result | No silent desktop/session switching; retry only in supported session | Zero-action Trace and checklist item |
| Wrong SID/PID/image/signature/certificate or remote Named Pipe client | `not_started` | Identity rejection | No authenticated session/action; checklist records proof | Never retry by weakening identity; corrected client starts fresh | Native rejection artifact |
| Missing/expired/consumed/mismatched Permit or unauthorized risk | `not_started` | Stable denial | No UIA action; Permit state and Trace prove rejection | Never replay the Permit | Section 16 pass evidence |
| Valid authorized action | `started` after one-use Permit consumption | Observed action outcome and verification | Trace binds one action to one consumed Permit and evidence refs | Duplicate Permit/action must fail | Exactly-once action/Permit evidence |
| Approval denied or times out | `not_started` | `LocalApprovalDenied`/`LocalApprovalTimedOut` | Denial Trace; no target mutation | New explicit proposal/approval only | Zero-action UIA evidence |
| Emergency Stop before/during action | `not_started` or `outcome_unknown` after dispatch | Stop/unknown outcome, never fabricated success | Deny latch blocks subsequent actions; evidence captures worker cancellation | New Session required; no action replay | Stop interaction, post-stop denial, and Trace |
| UIA worker hangs/exits/corrupts | `not_started` for capture or `outcome_unknown` for dispatched action | `TargetUnresponsive` or `ActionOutcomeUnknown` | Companion/App Job survives; worker generation advances | Capture may retry; action never auto-replays | Worker restart and no duplicate action |
| PID reuse or same-name non-Job process exists during reset/shutdown | `not_started` for unrelated process | Stable mismatch rejection or contained Job shutdown | Unrelated process remains alive | Re-identify valid Job member; never kill by name/PID alone | Before/after process identity evidence |
| Trace/Artifact upload disconnects | `started` for already executed native action | Evidence-limited/recovering status, not false completion | Local Spool retains ordered Trace/Artifact data | Upload resumes idempotently; action does not replay | Sequence/hash/resume evidence |
| Any Section 16 security veto fails/not-run/not-applicable | Boundary according to scenario; release decision is `not_started` | Manual acceptance fails and release/Graph freeze is blocked | Signed failure record is retained, not rewritten as pass | New acceptance only after reviewed fix; old record remains | Failed veto, signatures, linked issue/evidence |
| Checklist complete but operator/reviewer signature, distinction, metadata, or hash is missing | `not_started` for release use | Evidence invalid; ticket cannot resolve | Unsigned/incomplete record retained as non-acceptance evidence | Complete a new valid record or validly finish the same unsigned draft before signing | Validation report with exact missing fields |
| Signed evidence persistence/hash verification fails | `outcome_unknown` for acceptance record, release remains `not_started` | Acceptance invalid/blocked | No release manifest may reference it as valid | Recreate and re-execute as necessary; never infer pass from memory | File/hash failure and absent release binding |

## Comments

- blocked - 2026-08-26: Ticket 30 merged the production Companion daemon/UIA/Job Object implementation, but the required native daemon E2E prerequisite cannot run because no real `QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS` executable exists in the repo or environment. By maintainer direction, Ticket 47 now owns the missing harness. Ticket 31 remains human-owned and cannot proceed to signed local-console/RDP acceptance until Ticket 47 resolves and the automated native prerequisite passes on the exact reviewed commit.
- update - 2026-08-27: Ticket 47 merged in PR #127 (`808fd0f639acafe2eb287456ea64a368db338219`) and provides the repo-owned Windows UIA daemon harness. Ticket 31 is no longer blocked by missing harness infrastructure, but remains `ready-for-human`; agents still cannot execute, attest, review, or sign the local-console/RDP checklist.
