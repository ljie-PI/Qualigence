# [LS-11] M2 Self-hosted Runtime and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Linux single-node private deployment with Server, Intelligence Worker, shared Web Console, PostgreSQL, S3/MinIO, OIDC and enterprise KMS while preserving Local contracts.

**Architecture:** Domain/application packages stay shared. Provider packages adapt PostgreSQL/S3/KMS/OIDC. Server exposes DTO-only Public API and gRPC; Worker leases Intelligence Jobs; React SPA calls only Public API; one OCI image supplies server/worker/migrate/doctor roles.

**Tech Stack:** Node.js 24, Fastify 5, Kysely/pg, AWS S3 SDK, jose, React 19.2, Vite, TanStack Router/Query, Pino/OpenTelemetry, Docker Compose, PostgreSQL 17, MinIO.

**Direct Dependencies:** LS-05, LS-06, LS-08 and LS-10.

## Global Constraints

- Official production target is Linux single-node; no HA claim.
- PostgreSQL/S3/KMS/OIDC production dependencies fail closed; no Local fallback.
- Every tenant-scoped query receives tenantId explicitly.
- Browser/Runner/Worker identities are separate; Web Console never accesses storage directly.
- Tests stay under top-level `tests/`.
- Every Task creating a TypeScript package/app also modifies root `package.json`, `pnpm-lock.yaml`, `tsconfig.json` and `tsconfig.test.json` in that Task; a public library package also adds a `tests/smoke/node-package-imports.mjs` import.

---

### Task 1: Extract shared relational schema and add PostgreSQL runtime

**Files:**

- Create: `packages/storage-providers/relational-kysely/package.json`
- Create: `packages/storage-providers/relational-kysely/tsconfig.json`
- Create: `packages/storage-providers/relational-kysely/src/schema.ts`
- Create: `packages/storage-providers/relational-kysely/src/migrations.ts`
- Create: `packages/storage-providers/postgres-runtime/package.json`
- Create: `packages/storage-providers/postgres-runtime/tsconfig.json`
- Create: `packages/storage-providers/postgres-runtime/src/postgres-runtime.ts`
- Create: `packages/storage-providers/postgres-runtime/src/index.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/migrations.ts`
- Test: `tests/conformance/storage/relational-schema.test.ts`
- Test: `tests/contract/postgres/postgres-runtime.test.ts`

**Interfaces:** SQLite/PostgreSQL implement the same store contracts; dialect-specific lock/JSON/DDL remains in runtimes.

- [ ] **Step 1: Write cross-provider contract**

Run identical create/version/trace/job/skill/investigation/review tests against SQLite and Testcontainers PostgreSQL. Add cross-tenant negative query and expected-version race.

```ts
for (const provider of [sqliteProvider(), postgresProvider(container)]) {
  await relationalContract(provider);
}
await expect(postgres.projects.get("tenant-b", tenantAProjectId)).resolves.toBeUndefined();
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/conformance/storage/relational-schema.test.ts tests/contract/postgres/postgres-runtime.test.ts`

Expected: shared/PostgreSQL providers missing.

- [ ] **Step 3: Extract without changing SQLite behavior**

Move logical table definitions/migration metadata/query helpers; implement pg pool, transaction and `FOR UPDATE SKIP LOCKED`; keep JSON structured columns/constraints; PostgreSQL 17 schema version equals SQLite logical version.

```ts
export function createPostgresRuntime(config: PostgresRuntimeConfig): RuntimeStores {
  const db = new Kysely<RuntimeDatabase>({ dialect: new PostgresDialect({ pool: createPool(config) }) });
  return createRelationalStores(db, postgresCapabilities);
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 1 plus existing SQLite contracts; all must pass.

- [ ] **Step 5: Commit**

```text
git add packages/storage-providers tests/conformance/storage tests/contract/postgres
git commit -m "feat(self-hosted): add conformant postgres runtime"
```

### Task 2: Implement S3 and Self-hosted KMS Providers

**Files:**

- Create: `packages/storage-providers/artifact-s3/package.json`
- Create: `packages/storage-providers/artifact-s3/tsconfig.json`
- Create: `packages/storage-providers/artifact-s3/src/s3-artifact-store.ts`
- Create: `packages/storage-providers/artifact-s3/src/index.ts`
- Create: `packages/storage-providers/kms-self-hosted/src/kms-provider.ts`
- Test: `tests/contract/artifact-s3/s3-artifact-store.test.ts`
- Test: `tests/contract/kms-self-hosted/kms-provider.test.ts`

**Interfaces:** Implements existing `ArtifactStore` and `KeyManagementProvider`; uses tenant/project/hash object keys.

- [ ] **Step 1: Write MinIO/KMS contracts**

Put/read/hash/repeat/cross-tenant/partial upload; KMS publish profile/wrap/unwrap/rotate/revoke/audit/unavailable. Wrong size/hash must not register Manifest; wrong purpose/tenant cannot unwrap.

```ts
const manifest = await s3.write(artifactFor("tenant-a"));
expect(await s3.verify(manifest)).toBe(true);
await expect(kms.unwrapDek({ ...unwrapInput, tenantId: "tenant-b" })).rejects.toMatchObject({ code: "KmsScopeDenied" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/artifact-s3 tests/contract/kms-self-hosted`

Expected: providers missing/incomplete.

- [ ] **Step 3: Implement providers**

Use content-addressed key and metadata SHA/size; put before Manifest; HEAD verification. KMS adapter invokes configured Vault/enterprise endpoint through port, maps stable errors and records audit without plaintext.

```ts
const objectKey = `${scope.tenantId}/${scope.projectId}/${artifact.sha256}`;
await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: artifact.bytes }));
await verifyHead(s3, bucket, objectKey, artifact);
return manifestFor(objectKey, artifact);
```

- [ ] **Step 4: Confirm GREEN**

Run Task 2 command against Testcontainers MinIO/test KMS; expect all contracts pass.

- [ ] **Step 5: Commit**

```text
git add packages/storage-providers/artifact-s3 packages/storage-providers/kms-self-hosted tests/contract/artifact-s3 tests/contract/kms-self-hosted
git commit -m "feat(self-hosted): add s3 and kms providers"
```

### Task 3: Add Public API v1 and OIDC authorization

**Files:**

- Create: `packages/contracts/public-api/package.json`
- Create: `packages/contracts/public-api/tsconfig.json`
- Create: `packages/contracts/public-api/src/v1.ts`
- Create: `packages/auth/oidc/package.json`
- Create: `packages/auth/oidc/tsconfig.json`
- Create: `packages/auth/oidc/src/oidc-authenticator.ts`
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/routes/projects.ts`
- Create: `apps/server/src/routes/test-plans.ts`
- Create: `apps/server/src/routes/missions.ts`
- Create: `apps/server/src/routes/runs.ts`
- Create: `apps/server/src/routes/skills.ts`
- Create: `apps/server/src/routes/investigations.ts`
- Create: `apps/server/src/routes/reviews.ts`
- Create: `apps/server/src/routes/evidence.ts`
- Create: `apps/server/src/main.ts`
- Test: `tests/contract/public-api/api-v1.test.ts`
- Test: `tests/contract/auth/oidc.test.ts`

**Interfaces:** Implement every Method/Path/permission/application-interface row and every frozen Project/Target/PRD/TestPlan/Mission/Run/Skill/Investigation/Review/Artifact DTO in the Design Spec; use the list/command/error envelopes and `RequestPrincipal(subject,tenantId,roles)`; require mutation idempotency/expectedVersion.

- [ ] **Step 1: Write auth/tenant/API matrix**

Valid issuer/audience/JWKS role succeeds; expired/wrong audience/unknown tenant fails. Tester can mission, reviewer can claim, viewer cannot mutate. Tenant A IDs requested under tenant B return 404. Domain-only field is absent from DTO.

```ts
expect((await apiAs(tester).post("/api/v1/missions", missionBody)).statusCode).toBe(201);
expect((await apiAs(viewer).post("/api/v1/missions", missionBody)).statusCode).toBe(403);
expect((await apiAs(tenantB).get(`/api/v1/runs/${tenantARunId}`)).statusCode).toBe(404);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/public-api tests/contract/auth`

Expected: contracts/server/auth missing.

- [ ] **Step 3: Implement Fastify adapters**

Validate request/response schemas, map principal per request, pass tenantId to every application query/command, use 409 for expected-version conflict with current safe state, serve `/health/live|ready` and metrics separately.

```ts
server.post("/api/v1/missions", { schema: createMissionSchema }, async (request, reply) => {
  const principal = await authenticator.requirePrincipal(request);
  authorizer.require(principal, "mission:create");
  const created = await missions.create(principal.tenantId, request.body);
  return reply.code(201).send(toMissionDto(created));
});
```

- [ ] **Step 4: Confirm GREEN**

Run Task 3 command; expect auth/role/tenant/DTO/version cases pass.

- [ ] **Step 5: Commit**

```text
git add packages/contracts/public-api packages/auth/oidc apps/server tests/contract/public-api tests/contract/auth
git commit -m "feat(server): expose tenant-safe public api v1"
```

### Task 4: Implement durable Intelligence Worker

**Files:**

- Create: `apps/intelligence-worker/package.json`
- Create: `apps/intelligence-worker/tsconfig.json`
- Create: `apps/intelligence-worker/src/worker-loop.ts`
- Create: `apps/intelligence-worker/src/main.ts`
- Create: `packages/storage-providers/postgres-runtime/src/postgres-intelligence-job-store.ts`
- Test: `tests/component/intelligence-worker/lease-recovery.test.ts`

**Interfaces:** Worker leases accepted job types via `FOR UPDATE SKIP LOCKED`, renews and submits Result through shared contract.

- [ ] **Step 1: Write two-worker/failure tests**

Two Workers never lease same Job simultaneously; crash/restart after expiry re-leases; duplicate Result applies once; stale base version recomputes; ExecutionJob never appears in Worker lease query.

```ts
const [a, b] = await Promise.all([store.leaseForWorker(workerA, types, now, duration), store.leaseForWorker(workerB, types, now, duration)]);
expect([a, b].filter(Boolean)).toHaveLength(1);
expect(await store.leaseExecutionJobAsIntelligence()).toBeNull();
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/component/intelligence-worker/lease-recovery.test.ts`

Expected: Worker/store missing.

- [ ] **Step 3: Implement lease loop**

Use injected Clock/backoff, lease/3 renew, AbortSignal, accepted job types and bounded concurrency. Worker has no aggregate Repository; result goes to deterministic Server application endpoint/store.

```ts
while (!signal.aborted) {
  const lease = await jobs.lease(workerId, acceptedTypes, clock.now(), leaseDuration);
  if (!lease) { await backoff.wait(signal); continue; }
  const result = await processor.execute(lease.job, signal);
  await resultSink.submit(lease.token, result);
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 4 command; expect concurrency/crash/idempotency/separation cases pass.

- [ ] **Step 5: Commit**

```text
git add apps/intelligence-worker packages/storage-providers/postgres-runtime tests/component/intelligence-worker
git commit -m "feat(worker): run durable intelligence jobs"
```

### Task 5: Implement shared Web Console

**Files:**

- Create: `apps/web-console/package.json`
- Create: `apps/web-console/tsconfig.json`
- Create: `apps/web-console/vite.config.ts`
- Create: `apps/web-console/src/api/client.ts`
- Create: `apps/web-console/src/routes/router.tsx`
- Create: `apps/web-console/src/features/projects/project-page.tsx`
- Create: `apps/web-console/src/features/projects/prd-plan-page.tsx`
- Create: `apps/web-console/src/features/missions/mission-page.tsx`
- Create: `apps/web-console/src/features/runs/run-page.tsx`
- Create: `apps/web-console/src/features/skills/skill-page.tsx`
- Create: `apps/web-console/src/features/investigations/investigation-page.tsx`
- Create: `apps/web-console/src/features/reviews/review-queue-page.tsx`
- Create: `apps/web-console/src/features/reviews/review-task-page.tsx`
- Test: `tests/component/web-console/workflows.test.tsx`
- Test: `tests/e2e/web-console/review-conflict.test.ts`

**Interfaces:** Consumes Public API v1 only; implements the nine frozen browser routes; Local bootstrap session or Self-hosted OIDC PKCE; mutations send idempotency/expectedVersion.

- [ ] **Step 1: Write MSW component workflows**

Render Project→PRD→Draft Plan approval→Mission/Run→Finding/Case→Review. Concurrent claim 409 must replace stale assignee/version and show conflict; unauthorized Artifact does not download.

```tsx
render(<App initialUrl="/reviews/task-1" />);
await user.click(screen.getByRole("button", { name: "Claim" }));
expect(await screen.findByText(/already claimed by bob/i)).toBeVisible();
expect(screen.getByText(/version 2/i)).toBeVisible();
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/component/web-console/workflows.test.tsx`

Expected: SPA missing.

- [ ] **Step 3: Implement routes/features**

Use generated/handwritten v1 client with strict schemas, TanStack Query keys including tenant/resource/version, Router auth guards and mutation idempotency UUID. Do not import domain/storage packages or display Evidence plaintext without authorized endpoint.

```tsx
const claim = useMutation({
  mutationFn: () => api.claimReview(task.id, { expectedVersion: task.version, idempotencyKey: crypto.randomUUID() }),
  onError: (error) => error.code === "VersionConflict" && queryClient.setQueryData(reviewKey(task.id), error.current),
});
```

- [ ] **Step 4: Confirm GREEN**

Run component test and `pnpm vitest run tests/e2e/web-console/review-conflict.test.ts`; both workflows pass against mock/real API.

- [ ] **Step 5: Commit**

```text
git add apps/web-console tests/component/web-console tests/e2e/web-console
git commit -m "feat(console): add shared local self-hosted workflows"
```

### Task 6: Build image, Compose, operations and full Gate

**Files:**

- Create: `apps/admin-cli/src/main.ts`
- Create: `apps/admin-cli/package.json`
- Create: `apps/admin-cli/tsconfig.json`
- Create: `deployments/self-hosted/compose/compose.yaml`
- Create: `deployments/self-hosted/compose/Caddyfile`
- Create: `deployments/self-hosted/compose/.env.example`
- Create: `deployments/self-hosted/compose/README.md`
- Create: `Dockerfile`
- Create: `tests/e2e/self-hosted/compose.test.ts`
- Create: `packages/observability/src/index.ts`
- Create: `packages/observability/package.json`
- Create: `packages/observability/tsconfig.json`
- Modify: `docs/superpowers/implementation-status.md`

**Interfaces:** One image commands `server|worker|migrate|doctor`; static SPA; Compose internal dependencies/volumes; metrics/OTLP/Pino.

- [ ] **Step 1: Write Compose security/flow test**

Build/start, run migrate+doctor, login test OIDC, connect external Runner, execute PRD→Mission→Skill/Investigation/Review through API/Console, verify backup. Inspect containers: non-root, dropped caps, PostgreSQL/MinIO not host-published, no default secrets. KMS unavailable makes ready/doctor fail.

```ts
const stack = await compose.up();
expect((await stack.exec("qualigence", ["migrate"])).exitCode).toBe(0);
expect((await stack.exec("qualigence", ["doctor", "--json"])).exitCode).toBe(0);
expect(await stack.publishedPorts("postgres")).toEqual([]);
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/e2e/self-hosted/compose.test.ts`

Expected: image/Compose/admin commands missing.

- [ ] **Step 3: Implement deployment/operations**

Multi-stage build; one production image; read-only root with declared volumes; reverse proxy TLS; explicit migrate; doctor checks DB/S3/OIDC/KMS/Runner protocol; backup→migrate→start→verify docs; binary rollback only.

```dockerfile
FROM node:24-bookworm-slim AS runtime
USER node
COPY --from=build --chown=node:node /workspace/dist /app/dist
ENTRYPOINT ["node", "/app/dist/apps/admin-cli/main.js"]
```

- [ ] **Step 4: Run LS-11 Gate**

```text
pnpm build
pnpm test
pnpm typecheck
pnpm smoke:node-imports
docker compose -f deployments/self-hosted/compose/compose.yaml config
pnpm vitest run tests/e2e/self-hosted/compose.test.ts
git diff --check
```

Expected: all exit 0; deployment works without Cloud and all fail-closed/security assertions pass.

- [ ] **Step 5: Commit/status**

```text
git add apps packages deployments Dockerfile tests docs/superpowers/implementation-status.md
git commit -m "feat(self-hosted): ship private m2 deployment"
```

## Plan Self-Review

- Spec coverage: relational conformance, S3/KMS, OIDC/API/tenant, Worker lease, Web Console, image/Compose/operations/observability map to Tasks 1–6.
- Placeholder scan: every provider, identity, page, operation and Gate is named.
- Type consistency: Local/Self-hosted share ports/DTOs; external technologies remain Provider/Composition concerns.
