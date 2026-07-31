# [LS-05] M1 Core Runner Transport Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Core and Runner into independent processes with versioned gRPC, capability negotiation, leases, acknowledged Trace batches and a durable encrypted Runner Spool.

**Architecture:** Stable TypeScript domain messages live in runner-protocol; Protobuf DTO mapping lives only in grpc-runner-protocol. Server owns leases, Runner writes Trace to Spool before network, and existing ExecutionRuntime remains unchanged.

**Tech Stack:** Node.js 24, TypeScript, Protocol Buffers/Buf, `@grpc/grpc-js`, `@grpc/proto-loader`, Kysely/better-sqlite3, TLS.

**Direct Dependencies:** LS-04.

## Global Constraints

- No Protobuf-generated/loaded DTO enters Runner Kernel or Core Domain.
- Local transport still uses TLS and an outbound Runner connection.
- At-least-once messages must be idempotent; Trace remains ordered per Run.
- Lease expiry stops new actions but never discards already-created Trace.
- Tests stay under top-level `tests/` and ordinary CI uses no external service.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

## File Structure

The exact directory map is the one in the LS-05 Design Spec. Add focused files; do not combine Core server, Runner client and Spool into one package.

### Task 1: Freeze protocol domain messages and Protobuf schema

**Files:**

- Create: `packages/contracts/runner-protocol/src/capabilities.ts`
- Create: `packages/contracts/runner-protocol/src/messages.ts`
- Create: `packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto`
- Create: `buf.yaml`
- Create: `buf.lock`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/contracts/runner-protocol/src/index.ts`
- Test: `tests/type/runner-protocol-v1.types.ts`
- Test: `tests/conformance/runner-protocol/proto-schema.test.ts`

**Interfaces:** Produces `RunnerHello`, `RunnerCapabilities`, `RunnerWelcome`, Offer/Lease/EventBatch/Ack and protocol major 1 exactly as specified.

- [ ] **Step 1: Write type/schema failures**

```ts
const hello: RunnerHello = {
  runnerId: "runner-1", runnerVersion: "0.1.0", supportedProtocolMajors: [1],
  capabilities: capabilities({ targetAdapters: ["web-playwright"] }),
};
hello satisfies RunnerHello;
```

Conformance test parses proto descriptors and asserts published field numbers are unique and reserved fields are not reused.

- [ ] **Step 2: Confirm RED**

Run: `pnpm typecheck`

Expected: new protocol messages are not exported.

- [ ] **Step 3: Add domain/proto schemas**

Add `@bufbuild/buf@1` as a root dev dependency. Use snake_case in proto and camelCase in domain; define bidirectional stream service `Connect(stream RunnerFrame) returns (stream ServerFrame)`. Large Artifact bytes are absent. Run `pnpm exec buf lint` and commit the lock.

```proto
service RunnerService {
  rpc Connect(stream RunnerFrame) returns (stream ServerFrame);
}
```

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm typecheck && pnpm exec buf lint && pnpm vitest run tests/conformance/runner-protocol/proto-schema.test.ts`

Expected: all exit 0.

- [ ] **Step 5: Commit**

```text
git add packages/contracts/runner-protocol tests/type/runner-protocol-v1.types.ts tests/conformance/runner-protocol/proto-schema.test.ts buf.yaml buf.lock package.json pnpm-lock.yaml
git commit -m "feat(protocol): define runner transport v1"
```

### Task 2: Implement domain/DTO mapping and gRPC loopback

**Files:**

- Create: `packages/protocol-adapters/grpc-runner-protocol/package.json`
- Create: `packages/protocol-adapters/grpc-runner-protocol/tsconfig.json`
- Create: `packages/protocol-adapters/grpc-runner-protocol/src/mappers.ts`
- Create: `packages/protocol-adapters/grpc-runner-protocol/src/server.ts`
- Create: `packages/protocol-adapters/grpc-runner-protocol/src/client.ts`
- Create: `packages/protocol-adapters/grpc-runner-protocol/src/index.ts`
- Test: `tests/conformance/runner-protocol/grpc-round-trip.test.ts`
- Test: `tests/conformance/runner-protocol/grpc-tls.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`

**Interfaces:** Implements `RunnerConnectionPort`/`RunnerClientPort`; maps every v1 frame explicitly.

- [ ] **Step 1: Write round-trip and rejection tests**

Connect with protocol `[1]`, assert selected 1; connect with `[2]`, assert `ProtocolVersionMismatch`; send unknown optional proto field, assert accepted; use wrong CA, assert TLS failure.

```ts
expect((await connect(client([1]), server)).selectedProtocolMajor).toBe(1);
await expect(connect(client([2]), server)).rejects.toMatchObject({ code: "ProtocolVersionMismatch" });
await expect(connectWithCa(wrongCa)).rejects.toMatchObject({ code: "TlsPeerRejected" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/conformance/runner-protocol/grpc-*.test.ts`

Expected: gRPC adapter package missing.

- [ ] **Step 3: Implement adapter**

Install gRPC libraries, load schema, validate each frame with an explicit discriminant mapper, set receive/send byte limits and deadlines, and redact token/cert/Payload in interceptors. Export ports/domain values only.

```ts
export class GrpcRunnerProtocolServer implements RunnerConnectionPort {}
export class GrpcRunnerProtocolClient implements RunnerClientPort {
  connect(hello: RunnerHello): Promise<RunnerSession>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run the Task 2 command; expect handshake, unknown minor, version rejection, TLS and size-limit cases pass.

- [ ] **Step 5: Commit**

```text
git add packages/protocol-adapters/grpc-runner-protocol tests/conformance/runner-protocol package.json pnpm-lock.yaml tsconfig.json
git commit -m "feat(protocol): add grpc runner adapter"
```

### Task 3: Implement durable encrypted Runner Spool

**Files:**

- Create: `packages/runner-components/runner-spool/package.json`
- Create: `packages/runner-components/runner-spool/tsconfig.json`
- Create: `packages/runner-components/runner-spool/src/spool-key.ts`
- Create: `packages/runner-components/runner-spool/src/sqlite-runner-spool.ts`
- Create: `packages/runner-components/runner-spool/src/index.ts`
- Test: `tests/contract/runner-spool/sqlite-runner-spool.test.ts`
- Test: `tests/contract/runner-spool/spool-capacity.test.ts`

**Interfaces:** Implements `RunnerSpool`; consumes exact `SpoolBatchLimit {maximumEvents,maximumBytes}`; exports soft/hard capacity state and encrypted lease save/load.

- [ ] **Step 1: Write ordering/encryption/capacity tests**

```ts
await spool.append(event(1));
await spool.append(event(2));
expect(await spool.pending("r", 1, { maximumEvents: 10, maximumBytes: 4096 })).toEqual([event(1), event(2)]);
await spool.acknowledge("r", 2);
expect(await spool.pending("r", 1, limits)).toEqual([event(2)]);
expect(readDatabaseBytes()).not.toContain(Buffer.from("lease-secret"));
```

Add duplicate/different-hash, restart, lost key, 512 MiB logical soft and 1 GiB hard states using injected size accounting.

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/runner-spool`

Expected: Spool package missing.

- [ ] **Step 3: Implement Spool**

Use the three Design Spec tables. Write event before returning to TraceRecorder; encrypt lease token with AES-256-GCM and user-only key file; Ack deletes only sequence `< nextExpected`. Lost key drops lease metadata, preserves events and returns `SpoolKeyUnavailable`.

```ts
export class SqliteRunnerSpool implements RunnerSpool {
  append(event: TraceEvent): Promise<void>;
  pending(runId: string, from: number, limit: SpoolBatchLimit): Promise<readonly TraceEvent[]>;
  acknowledge(runId: string, nextExpected: number): Promise<void>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 3 command; expect restart/order/encryption/capacity tests pass.

- [ ] **Step 5: Commit**

```text
git add packages/runner-components/runner-spool tests/contract/runner-spool
git commit -m "feat(runner): add durable encrypted spool"
```

### Task 4: Implement Server session, Capability and Lease state

**Files:**

- Create: `apps/core-daemon/package.json`
- Create: `apps/core-daemon/tsconfig.json`
- Create: `apps/core-daemon/src/runner/runner-session-service.ts`
- Create: `apps/core-daemon/src/runner/execution-job-service.ts`
- Create: `apps/core-daemon/src/main.ts`
- Test: `tests/unit/core-daemon/runner-session-service.test.ts`
- Test: `tests/unit/core-daemon/execution-job-service.test.ts`

**Interfaces:** Server matches required capabilities, owns Offer/accept/renew/complete, and sends Trace batches through `TraceIngestor`.

- [ ] **Step 1: Write state machine tests**

Assert a web Job is offered only to web-playwright; duplicate accept returns same Lease; renew with wrong token returns `LeaseLost`; expired Lease cannot complete; duplicate Event batch returns same Ack; hash conflict isolates Session.

```ts
expect(await sessions.offer(webJob, ["web-playwright"])).toMatchObject({ jobId: webJob.jobId });
expect(await sessions.accept(offer.id)).toEqual(await sessions.accept(offer.id));
await expect(sessions.renew({ ...lease, leaseToken: "wrong" })).rejects.toMatchObject({ code: "LeaseLost" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/core-daemon`

Expected: services missing.

- [ ] **Step 3: Implement deterministic services**

Keep state behind repository/clock ports; do not put it in gRPC callbacks. Compare capabilities before payload offer. Hash lease tokens at rest Server-side and use constant-time comparison. Ingest batch sequentially and return first expected sequence.

```ts
export class RunnerSessionService {
  register(hello: RunnerHello): Promise<RunnerWelcome>;
  ingest(sessionId: string, batch: ExecutionEventBatch): Promise<ExecutionEventAck>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 4 command; expect all state/clock/capability cases pass.

- [ ] **Step 5: Commit**

```text
git add apps/core-daemon tests/unit/core-daemon
git commit -m "feat(core): manage runner sessions and leases"
```

### Task 5: Implement Runner client and safe lease loss

**Files:**

- Create: `apps/runner/package.json`
- Create: `apps/runner/tsconfig.json`
- Create: `apps/runner/src/runner-client.ts`
- Create: `apps/runner/src/job-executor.ts`
- Create: `apps/runner/src/main.ts`
- Test: `tests/unit/runner/runner-client.test.ts`
- Test: `tests/unit/runner/job-executor.test.ts`

**Interfaces:** Runner accepts compatible Offers, writes Trace to Spool, batches/Acks, renews at lease/3 and stops new actions after expiry.

- [ ] **Step 1: Write fake-clock disconnect tests**

Run a Job, disconnect after action event, advance beyond lease, assert no next action starts; reconnect, assert Trace from last Ack is resent and completion reports LeaseLost without deletion.

```ts
transport.disconnectAfterAck(3);
await executor.start(job, lease);
clock.advanceTo(lease.expiresAt);
expect(target.actionsAfter(clock.now())).toHaveLength(0);
expect(await spool.pending(job.runId, 4, limits)).not.toHaveLength(0);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/runner`

Expected: Runner client missing.

- [ ] **Step 3: Implement client/executor**

Wrap Runtime TraceRecorder with Spool-first append. Batch by negotiated event/byte limits. Renew on fake-clock schedule; feed AbortSignal to job executor when lease expires/cancel arrives; allow upload loop to continue.

```ts
export class RunnerClient {
  run(signal: AbortSignal): Promise<void>;
}
export class LeasedJobExecutor {
  execute(offer: ExecutionJobOffer, lease: ExecutionJobLease, signal: AbortSignal): Promise<void>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 5 command; expect disconnect/Ack loss/expiry/reconnect cases pass without sleeps.

- [ ] **Step 5: Commit**

```text
git add apps/runner tests/unit/runner
git commit -m "feat(runner): execute leased jobs over durable transport"
```

### Task 6: Independent-process conformance Gate

**Files:**

- Create: `tests/component/core-runner/independent-process.test.ts`
- Create: `tests/component/core-runner/disconnect-recovery.test.ts`
- Modify: `package.json`
- Modify: `tests/smoke/node-package-imports.mjs`
- Modify: `docs/superpowers/implementation-status.md`

**Interfaces:** Adds no new public contract; proves the frozen Core/Runner gRPC handshake, capability negotiation, lease, spool recovery and terminal semantics across independent processes.

- [ ] **Step 1: Write child-process E2E**

Spawn Core and Runner with temporary TLS/data, wait for health/session condition, submit cart Job, assert result. Second test kills transport after first batch, restarts Core, and asserts exact Trace/no duplicate.

```ts
const system = await startCoreRunnerProcessPair(tempConfig);
const result = await system.submit(cartJob);
expect(result.status).toBe("finding");
expect(uniqueSequences(await system.trace(cartJob.runId))).toBe(true);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/component/core-runner`

Expected: process integration fails until binaries/config wiring are complete.

- [ ] **Step 3: Complete binary configuration**

Add environment config for endpoint/cert/data/runner ID, graceful SIGINT/SIGTERM, structured readiness and child cleanup. Do not add Launcher behavior from LS-06.

```ts
await Promise.all([
  startCoreDaemon(coreConfig, shutdownSignal),
  startRunner(runnerConfig, shutdownSignal),
]);
```

- [ ] **Step 4: Run LS-05 Gate**

```text
pnpm build
pnpm test
pnpm typecheck
pnpm smoke:node-imports
pnpm vitest run tests/conformance/runner-protocol tests/contract/runner-spool tests/component/core-runner
pnpm exec buf lint
git diff --check
```

Expected: all commands exit 0 and disconnect recovery contains every sequence exactly once.

- [ ] **Step 5: Commit/status**

```text
git add apps packages tests package.json docs/superpowers/implementation-status.md
git commit -m "feat(runtime): harden local core runner transport"
```

## Plan Self-Review

- Spec coverage: messages/proto, mapping, TLS, Capability, Lease, Spool encryption/capacity, disconnect and processes map to Tasks 1–6.
- Placeholder scan: every state transition and failure oracle is explicit.
- Type consistency: gRPC maps to runner-protocol domain messages; Core/Runner consume only ports.
