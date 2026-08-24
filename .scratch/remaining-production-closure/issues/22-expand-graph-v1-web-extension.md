# 22 — Expand Graph v1 and web/v1 extension

**What to build:** Freeze canonical Graph v1 ordering and a privacy-safe Web extension beside legacy observation types so live producers can migrate incrementally.

**Blocked by:** 19 — Complete bounded multi-step Web Runtime.

**Status:** resolved

## Tracked scope

This ticket owns the Graph expand phase and candidate-contract completion: the additive Graph v1 canonical/validator/schema contract, typed `web/v1` extension, capability vocabulary, and ordering corrections needed before live producers migrate in ticket 23. It does not migrate producers/consumers, inventory historical assets, or freeze v1.

## Migration

- Replace the current Graph v1 "all arrays preserve order" implementation with the umbrella spec's semantic-set/business-order rule: sort `nodes` by NFC-normalized `id`; each node's `relations` by NFC-normalized `(type, targetNodeId)`; `rootNodeIds` and Graph `evidenceRefs` by NFC-normalized value. Equal keys require byte-identical entries or validation fails; input order is never a hash tie-breaker.
- Preserve order for business arrays and undeclared extension arrays. Sort an extension array only when its schema explicitly declares set semantics.
- Add typed `web/v1` with canonical origin, pathname, title, bounded viewport, and only Target-policy-allowlisted query keys. Every retained value is one fixed redaction marker; omit fragments and raw query values. Graph hashing covers this redacted representation.
- Keep the legacy `ObservationGraph` and candidate v1 contract side by side for the expand phase. Do not change live `Observer`/Trace/consumer types; tickets 23-25 own migration and contraction.
- Freeze this rule unambiguously in the current Graph v1 public contracts and conformance/property tests. Graph status remains `candidate`. This ticket has no persistence migration allocation.

## Affected context paths

`docs/contexts/execution/CONTEXT.md`; `docs/contexts/product/CONTEXT.md`; `docs/contexts/protocol/CONTEXT.md`; `docs/contexts/evidence/CONTEXT.md`.

## Allowed Files

This is the complete edit scope.

- `packages/contracts/observation/**`
- `packages/contracts/runner-protocol/src`
- `tests/{conformance/observation,property/observation-graph.test.ts}`
- `.scratch/remaining-production-closure/issues/22-expand-graph-v1-web-extension.md`
- Post-review acceptance only: `tests/e2e/web-execution/graph-v1-canonical.test.ts`

No Web adapter, Runner Runtime, consumer, observation-migration package, other documentation, or status file is in scope.

## Authority

Resolve conflicts in this order: applicable security/public-contract invariants, architecture and context invariants, current public interfaces and conformance tests, then the umbrella spec and this ticket's migrated rule/scope.

- Architecture: `docs/architecture/2026-07-21-qualigence-open-source-architecture-design.md` sections 6.2, 9.2, 10, 13, and 14.3. Graph core is cross-platform, typed extensions retain platform semantics, sensitive observations are redacted at Runner, and v1 cannot freeze before native Desktop/migration evidence.
- Context authority: the ownership, seams, invariants, and verification surfaces in every path under **Affected context paths**.
- Umbrella authority: `.scratch/remaining-production-closure/spec.md` user stories 38-42 and 68; Implementation Decisions on canonical semantic sets, `web/v1`, and candidate status; Testing Decisions on conformance/property/live capture and matrices.
- Tracked predecessor authority: `.scratch/remaining-production-closure/issues/19-bounded-multistep-web-runtime.md` and its merged GitHub PR/check evidence establish the bounded Web Runtime inherited by the additive contract.
- Current public contracts and tests: `packages/contracts/observation/src/{core,extensions,canonical,validator,index}.ts`, `packages/contracts/observation/schemas/observation-graph-v1.schema.json`, the v1 re-export/capability surface in `packages/contracts/runner-protocol/src/{index,capabilities}.ts`, and the conformance/property tests named here. `ObservationGraphV1`, validation, canonical bytes/hash, required-extension-major behavior, and stable errors are public compatibility boundaries.
- Ticket-local and GitHub evidence: this ticket's `## Comments` and `## Answer`, merged predecessor and final ticket PRs, required checks, reviewed-head and merge-commit bindings, and any deferred advanced-hardening Issues in `ljie-PI/Qualigence` are the durable execution evidence.

## Authority decisions

- The fixed `web/v1` query-value redaction marker is `[redacted]`, matching the existing log/adapter sentinel. Allowlisted query keys are retained with this exact value only; raw query values and fragments are never represented.
- The `web/v1` extension is Graph-level, not node-level. Add a Graph `extensions` map alongside existing node extensions. The typed `web/v1` payload is `{ origin, pathname, title, viewport, query }`, where `viewport` is `{ width, height, devicePixelRatio }`, `width` and `height` are finite positive safe integers in CSS pixels no greater than `32768`, and `devicePixelRatio` is finite, positive, and no greater than `16`.
- Capability vocabulary is `observation:observation-graph/v1` for the core Graph major and `observation:web/v1` for the Web extension major, matching the existing `advertisedCapabilityTokens` `observation:${extension}` convention. Ticket 22 defines the vocabulary and contract; ticket 23 owns live producer advertisement and admission.
- The allocated real-Chromium acceptance may exercise the pure additive contract with browser-observed origin/path/title/viewport/query inputs and no production Web adapter edits. If acceptance cannot satisfy the ticket without editing the Web adapter reserved for ticket 23, stop for a scope/ownership decision. Do not edit ticket 23 files implicitly or count a synthetic Graph with invented browser values as the required capture.

## Execution protocol

- This ticket is the execution entrypoint for the expand phase. Start after blockers resolve from the latest merged predecessor and record exact base SHA, matrix applicability, and planned Gates under `## Comments`, citing the predecessor's merged PR and merge commit as current execution-base evidence.
- Preserve the `web/v1` redaction-marker, viewport, Graph-level extension, and capability-token decisions above. These are public hash/capability contracts and cannot become adapter-local implementation choices.
- Use Node.js 24 and Corepack pnpm exactly `11.7.0`; install frozen in a fresh worktree. Do not change the lockfile or dependencies.
- Start with failing conformance/property tests. During edits/review fixes run only the focused non-E2E Gate, root typecheck, and diff check. Preserve strict TypeScript, a single Graph truth, stable errors, unknown-minor round trip, unsupported-major rejection, and redaction before serialization.
- No required Gate may skip. Chromium absence in acceptance is `ChromiumUnavailable`, not evidence. Preserve unrelated changes and stop before any file outside **Allowed Files**.
- Record start, optional actual blocker, review rounds, Gate/acceptance results, and final PR evidence under `## Comments`; summarize resolution under `## Answer`. Commit before each exact-head Standards/Spec review. Every review covers the whole diff and every matrix row with `pass | finding | N/A`, N/A reasons, and reviewed head recorded under `## Comments`.
- Critical always blocks. Important blocks only for explicit acceptance, applicable architecture/security, public/persisted contract, required Gate, or primary correctness/data integrity. Fix core findings, rerun affected non-E2E Gates, and rerun complete-matrix review.
- Stop after five review rounds. A remaining core blocker sets this ticket to `needs-info`, blocks dependents, and requires a maintainer scope/ownership decision. Do not create recursive local remediation tickets.
- Defer non-Critical advanced hardening unless promoted: create one GitHub Issue in `ljie-PI/Qualigence` with source/fixed/reviewed heads, severity/risk, authority, affected files/Gates, and acceptance; do not implement or block on it here.
- Provision post-review Chromium acceptance only after clean review. If the additive acceptance cannot be implemented without editing the Web adapter reserved for ticket 23, stop and request a scope/ownership decision rather than crossing scope.
- Create one non-draft PR only after focused Gate, typecheck, diff check, clean review, acceptance, and final ticket evidence. A final ticket-evidence-only commit may follow reviewed code if code/test diff is byte-identical. Keep `claimed` until merge, then record PR/SHA under `## Answer`, resolve, and clean branch/worktree.

## Focused non-E2E Gate

```text
corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts
corepack pnpm typecheck
git diff --check
```

## Post-review acceptance

```text
corepack pnpm vitest run tests/e2e/web-execution/graph-v1-canonical.test.ts
```

Run a real Chromium Web capture through the additive candidate-contract acceptance and prove schema validity, privacy-safe `web/v1`, semantic-set permutation stability, and business-order sensitivity. This ticket may not migrate the production Web adapter; if the exact acceptance needs that edit, record the scope conflict and stop rather than treating ticket 23 work as implicit scope.

## Behavior Matrix

| Scenario / precondition | Side-effect boundary (`not_started \| started \| outcome_unknown`) | Public result/error | Durable state | Retry/replay rule | Terminal evidence |
|---|---|---|---|---|---|
| Valid v1 Graph and valid typed `web/v1` payload | `not_started` | Validation succeeds; canonical bytes/hash are returned | N/A: pure contract operation writes no durable state | Repeated call over equivalent input returns identical bytes/hash | Schema/conformance example and canonical hash |
| Semantic-set inputs differ only in node/relation/root/Graph-evidence order | `not_started` | Same canonical bytes/hash | N/A: pure | Freely repeatable; normalized result is deterministic | Property evidence over all four semantic-set classes |
| Business-order or undeclared extension-array order changes | `not_started` | Canonical bytes/hash changes | N/A: pure | Repeated exact input is stable; different business order is not collapsed | Property evidence proving order sensitivity |
| Equal normalized semantic key has non-byte-identical entries, duplicate node, or dangling reference | `not_started` | `ObservationSchemaInvalid` or `DanglingNodeReference` | N/A: invalid value is not registered | Retry only with corrected graph; no input-order tie-breaker | Rejection and zero hash-as-valid evidence |
| Secret value, invalid evidence ref, non-finite bounds, invalid confidence, malformed schema/version | `not_started` | Stable observation validation error | N/A: invalid value is not registered | Correct input and retry; never sanitize a forbidden secret after hashing | Negative conformance evidence |
| `web/v1` contains raw/disallowed query value/key, fragment, noncanonical origin/path, or invalid viewport | `not_started` | Stable schema/extension validation error | N/A: no serialization as valid Graph | Correct from authoritative Target policy; never log/hash raw query data | Privacy negative tests prove forbidden values absent |
| Unknown optional extension/minor fields are present | `not_started` | Round-trip and ignore where not required | N/A: pure | Preserve bytes/values through supported serialization | Extension round-trip evidence |
| Consumer requires absent or unsupported extension major | `not_started` | `ExtensionVersionUnsupported` | N/A: pure | No downgrade; retry only with a compatible extension/capability | Required-major rejection evidence |
| Validation/auth/policy/capability rejection beyond schema/extension checks | `not_started` | N/A: this additive pure contract owns no caller authentication or action policy; capability-major rejection is covered above | N/A | Owned by producer/admission tickets 23 and 26-28 | N/A reason recorded in review |
| Timeout/cancel before or after dispatch | `not_started` | N/A: canonicalization/validation is synchronous and dispatches no external effect | N/A | Call may be repeated | N/A reason recorded in review |
| Unknown outcome | `not_started` | N/A: no side-effect boundary exists | N/A | Call may be repeated | N/A reason recorded in review |
| Idempotent replay | `not_started` | Same exact input returns same validation/hash result | N/A | Unlimited pure replay | Deterministic property evidence |
| Conflicting replay | `not_started` | N/A as replay protocol; distinct semantic input deterministically validates/hashes or rejects | N/A | Caller treats changed bytes/hash as a distinct value | N/A replay reason plus property evidence |
| Concurrency/restart | `not_started` | Same result across callers/process restart | N/A: no mutable singleton state | Safe to recompute | Parallel/pure determinism review evidence |
| Terminal persistence failure | `not_started` | N/A: this ticket has no persistence boundary | N/A | Producer/migration tickets own persistence | N/A reason recorded in review |

- [ ] Nodes, relations, root IDs, and Graph evidence refs sort by stable keys; business-order arrays preserve order.
- [ ] `web/v1` carries origin/path/title/viewport and only policy-allowlisted query keys with redacted values; fragment is omitted.
- [ ] Extension arrays declare set semantics explicitly; unspecified arrays preserve order.
- [ ] Legacy and v1 contracts coexist without ambiguous hashes.

## Comments

Start evidence: claimed on branch `closure-22-graph-v1-web-extension` at base SHA `6f930940b490b11dc0345f6393f811e272c06a21`. Behavior matrix applies as frozen above; this is pure contract validation/canonicalization/capability vocabulary work with no durable side-effect boundary. Planned focused Gates: `corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts`, `corepack pnpm typecheck`, and `git diff --check`. Predecessor ticket 19 evidence: PR `https://github.com/ljie-PI/Qualigence/pull/86`, merge commit `4ec4ebd5df46dc8ba2f658dd90065f20c9daf130`, final focused Gate/post-review Chromium acceptance/build/typecheck/diff check/scoped review passed per ticket 19.

- final: Reviewed code/test head `11bea8e679d4838cf5aa8dca4db2a60525548256` with complete matrix coverage; Standards findings 0 and Spec findings 0. Clean focused Gate: `corepack pnpm vitest run tests/conformance/observation tests/property/observation-graph.test.ts`. Clean post-review acceptance: `corepack pnpm vitest run tests/e2e/web-execution/graph-v1-canonical.test.ts`. `corepack pnpm typecheck` and `git diff --check` passed. Graph v1 remains `candidate`; no live producer/consumer migration was performed. PR `https://github.com/ljie-PI/Qualigence/pull/90` merged as `7ef31db708612ddc5c020e6e2bb2758d763fba85`.

## Answer

Implemented candidate Graph v1 semantic-set canonicalization, strict validation, JSON Schema alignment, Graph-level privacy-safe `web/v1`, extension set semantics, runner-protocol capability vocabulary, conformance/property coverage, and real-Chromium additive acceptance without migrating production Web adapters.

Pull request: `https://github.com/ljie-PI/Qualigence/pull/90`

Merge commit: `7ef31db708612ddc5c020e6e2bb2758d763fba85`
