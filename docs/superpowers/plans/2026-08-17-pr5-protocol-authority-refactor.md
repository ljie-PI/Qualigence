# PR5 Protocol Authority Delivery

This document is the delivery authority for Tasks 8-9 packaging. It does
not replace LS-05, architecture sections 7/10/11, or the Tasks 8-9
Interfaces and Files unions in
`docs/superpowers/plans/2026-08-16-production-closure-temporary.md`.

Resolve conflicts in this order:

1. Security invariants and public contracts in the architecture and LS-05.
2. Existing Tasks 8-9 Interfaces, Files unions, and PR5-ATOMIC production
   composition rule.
3. This delivery document.
4. Older LS implementation plans.

## Compatibility lock

These remain identical after every stacked PR, including activation:

- Public `RunnerProtocolApplication` methods and signatures:
  `openSession`, `createOffer`, `accept`, `renew`, `ingest`, `complete`,
  `closeSession`.
- Public `RunnerConnectionPort` and `RunnerClientPort` signatures.
- Required `AuthenticatedRunnerContext.scope`.
- Neutral leaf package `@qualigence/runner-control`.
- No compatibility default, insecure fallback, or fake in any production
  Composition Root.
- Task 10 owns durable `RunnerControlStore`, crash recovery of consumed
  resume credentials, and restart-authoritative leases.
- Task 14 owns Self-hosted principal mapping.
- Task 15 owns required `AcceptedExecutionJob.policy` and policy wire
  fields.
- Task 18 owns desktop Target dispatch and remaining lossless gRPC
  mapping beyond Task 8's existing `RenewLease.leaseToken` addition.

Stop and run `/grill` before editing if a stacked PR would change any
item above, add a protobuf message or field number, or edit a file
outside that PR's Files block.

## Terms

- **Connection** is one authenticated transport generation. It is not a
  session identity and must not outlive its stream.
- **Session** is the logical Runner identity restored by resume. Resume
  keeps the same `sessionId` and increments only the connection
  generation.
- **commandId** is the durable idempotency key for Offer, Lease, Trace
  batch, and Completion.
- **correlationId** identifies one client attempt and one waiter. It is
  not an idempotency key.
- **Reserve/commit/abort** is the in-process implementation of
  `openSession` and later lifecycle methods. It is not a public port and
  not a wire handshake.

`openSession` still returns `RunnerWelcome` after the application has
committed the in-process admission. The adapter sends that Welcome and
must call `closeSession` if the send fails in-process. A crash after
durable token consume and before Welcome send is Task 10.

## State machines

| Module | Legal states |
|---|---|
| Connection | Accepted → Authenticating → Reserved → Active → Draining → Closed |
| Session | Absent → AdmissionPending → Active → Detached → Active / Closed |
| Offer | Dispatchable → Offered → Accepted / Expired / Cancelled |
| Lease | None → Prepared → Active → Lost / Completed |
| Trace | Healthy(cursor) → Healthy(next) / Quarantined |
| Completion | Open → Recorded → Applied / Conflict |
| Shutdown | Running → Quiescing → Draining → Closed |

Invariants that implement Tasks 8-9 without changing their contracts:

- Transport never issues leases, resume tokens, Trace acknowledgements,
  or completions.
- Network write is not the authority commit. The application method
  resolves first; the adapter writes the exact returned value.
- Resume restores protocol identity, lease metadata, and Trace cursor. It
  does not extend a lease or grant a new action permit.
- A rejected resume must not move run ownership.
- `createOffer` is idempotent for `{ jobId, runId }` inside one live
  process. Different content for either identity throws
  `RunIdentityMismatch` and sends no second frame.
- An unaccepted offer is not durable. After Core restart it may be
  recreated; an accepted run waits for Task 10 persistence.
- Renew validates the exact presented `leaseToken`. A mismatch returns
  `LeaseLost` and mints no replacement.
- Trace acknowledgement follows durable ingest. Same sequence and
  different hash quarantines the session.
- Completion is unique per `runId`. A lost lease may still upload already
  spooled Trace and must not accept a new completion as a new action
  permit.

## Race matrix

Each case is a deterministic test owned by the named stacked PR. A later
PR may add coverage; it must not weaken an earlier case.

| Case | Required outcome | Owner |
|---|---|---|
| Duplicate client `correlationId` while a waiter is pending | Share the existing Promise or reject the second attempt; never overwrite the waiter | PR5-R1 |
| Concurrent `Hello` for the same runner | One admission proceeds; the other receives a stable protocol error | PR5-R3 |
| Frame after connection generation increment | Old-generation frame is ignored or closes only that generation | PR5-R3 |
| Queue overflow of handshake or frame mailbox | Fail-stop that connection; do not drop silently or block the process | PR5-R3 |
| Shutdown during offer, Trace, or completion | In-flight work fails closed; no new admission | PR5-R3 |
| Resume versus `createOffer` | Offer uses the live session identity; a rejected resume does not steal the run | PR5-R4 |
| Exact canonical offer replay | Same offer returned; no second frame | PR5-R4 |
| Different content for same `{ jobId, runId }` | `RunIdentityMismatch`; no second frame | PR5-R4 |
| Double accept | Second accept is idempotent or a stable conflict; one lease exists | PR5-R4 |
| Renew versus expiry | Expired lease returns `LeaseLost`; no new epoch for the same lost run | PR5-R4 |
| Renew versus completion | Completed run cannot renew | PR5-R4 |
| Overlapping Trace batches | Arrival order is preserved; ACK follows ingest | PR5-R4 |
| Completion ACK loss | Replay records once | PR5-R4 |
| Unaccepted offer after Core restart | Offer may be recreated; no stranded run ownership | PR5-R4 |
| Interrupted in-process Welcome send | `closeSession` rolls back reservation; ownership is not stranded | PR5-R4 |
| Real mTLS disconnect and resume | Session id is stable; lease is not extended; Trace resumes from ACK | PR5-R5 |

GitHub Issues `#48`, `#49`, `#50`, and `#51` are acceptance aliases for
the resume-ownership, unaccepted-offer, waiter-collision, and
interrupted-admission rows. They close only after the owning PR's Gate
and both review axes pass.

## Stacked delivery

Tasks 8-9 remain one product unit. Their Files unions are unchanged and
are the complete set that must exist when PR5-R5 merges. Each stacked PR
commits a subset and keeps production Core/gRPC composition inactive
until PR5-R5.

| PR | Product change | Production activation | Commit |
|---|---|---|---|
| PR5-R0 | This delivery document plus plan/status pointers | No | `docs(plan): authorize stacked runner protocol delivery` |
| PR5-R1 | Client waiter registry and Task 8 wire/error/type files required for exact `leaseToken` renew | No | one commit inside the Task 8 Files union |
| PR5-R2 | Neutral port package and the four lifecycle-module moves, with Core Daemon re-exporting previous paths | No | one commit inside the Tasks 8-9 Files union |
| PR5-R3 | gRPC bounded mailbox, fail-stop queue, generation fencing, and serialized frame handling. Existing production constructor remains valid | No | one commit inside the Task 8 Files union |
| PR5-R4 | `CoreRunnerProtocolApplication` and in-process authority tests. Production `main.ts` still uses the pre-activation constructor | No | one commit inside the Task 9 Files union except `apps/core-daemon/src/main.ts` |
| PR5-R5 | Required `application` and `authenticator`, real SQLite/Trace composition, readiness/shutdown order, and the joint Gate | Yes | the Task 9 union commit `feat(core): delegate and compose authoritative runner protocol` |

PR5-R1 must not add `AcceptedExecutionJob.plan` or policy field mapping.
Those remain Task 15 and Task 18.

The forensic branch `codex/pr5-core-protocol-application` at `230b6cd`
is reference only. Do not commit to it, do not open it as the product PR,
and do not cherry-pick a whole commit. A later PR may copy a proven test
or helper only when that snippet sits inside the PR's Files block.

## Review and stop

Each stacked PR runs its focused Gate, `corepack pnpm typecheck` when
the production graph still typechecks, `git diff --check`, and
`/code-review` against the exact merge-base.

- Critical or Important on either axis blocks push and merge.
- After a fix commit, rerun the affected Gate and a fresh two-axis
  review.
- If three review rounds on the same stacked PR still leave an
  Important finding, stop coding and run `/grill`.
- If the next edit would expand Files, change a locked interface, or
  activate production before PR5-R5, stop and run `/grill`.
- A skipped Gate is not a pass.
- A later PR does not start until its predecessor merges.
- Restack invalidates prior Gates and reviews.

PR5-ATOMIC remains the production-composition rule. This document
replaces only its single-commit packaging.
