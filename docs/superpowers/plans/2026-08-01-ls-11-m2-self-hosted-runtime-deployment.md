# [LS-11] M2 Self-hosted Runtime and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Linux single-node private deployment with Server, Intelligence Worker, shared Web Console, PostgreSQL, S3/MinIO, OIDC and enterprise KMS while preserving Local contracts.

**Architecture:** Domain/application packages stay shared. Provider packages adapt PostgreSQL/S3/KMS/OIDC. Server exposes DTO-only Public API and enrollment-bound mTLS gRPC; Worker leases only Intelligence Jobs and appends Results to a PostgreSQL inbox that only Server applies; React SPA calls only Public API and is shipped as static assets; one OCI image supplies server/worker/migrate/doctor/backup/restore roles.

**Tech Stack:** Node.js 24, Fastify 5, Kysely/pg, AWS S3 SDK, jose, `@peculiar/x509`, React 19.2, Vite, `oidc-client-ts`, TanStack Router/Query, Pino/OpenTelemetry, Docker Compose, PostgreSQL 17, MinIO.

**Direct Dependencies:** LS-05, LS-06, LS-08 and LS-10.

## Global Constraints

- Official production target is Linux single-node; no HA claim.
- PostgreSQL/S3/KMS/OIDC production dependencies fail closed; no Local fallback.
- Every tenant-scoped query receives tenantId explicitly.
- Tenant-owned PostgreSQL rows are protected by composite tenant keys plus forced RLS; runtime roles are non-owner and never have `BYPASSRLS`.
- Browser/Runner/Worker identities are separate; Web Console never accesses storage directly.
- Worker database access is limited to Intelligence Job lease columns and Result Inbox; it never writes aggregate tables.
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
- Create: `packages/storage-providers/postgres-runtime/src/tenant-transaction.ts`
- Create: `packages/storage-providers/postgres-runtime/src/migrations/row-level-security.ts`
- Create: `packages/storage-providers/postgres-runtime/src/index.ts`
- Modify: `packages/storage-providers/sqlite-runtime/src/migrations.ts`
- Test: `tests/conformance/storage/relational-schema.test.ts`
- Test: `tests/contract/postgres/postgres-runtime.test.ts`
- Test: `tests/contract/postgres/tenant-isolation.test.ts`

**Interfaces:** SQLite/PostgreSQL implement the same store contracts; dialect-specific lock/JSON/DDL remains in runtimes. PostgreSQL exposes `TenantTransactionProvider.withTenant(tenantId, operation)` and never exposes an unscoped application transaction.

- [ ] **Step 1: Write cross-provider contract**

Run identical create/version/trace/job/skill/investigation/review tests against SQLite and Testcontainers PostgreSQL. For every tenant table inspect the catalog and assert `(tenant_id, entity_id)` uniqueness, tenant-inclusive foreign keys, RLS enabled and forced. Run cross-tenant direct SQL and repository reads/writes as the real non-owner Server role; unset tenant context must return no rows/reject writes. Assert the role is not owner and lacks `BYPASSRLS`. Separately assert the Worker role cannot select or mutate projects/runs/evidence.

```ts
for (const provider of [sqliteProvider(), postgresProvider(container)]) {
  await relationalContract(provider);
}
await expect(postgres.projects.get("tenant-b", tenantAProjectId)).resolves.toBeUndefined();
await expect(serverRole.query("select * from projects")).resolves.toEqual([]);
await expect(workerRole.query("select * from projects")).rejects.toMatchObject({ code: "42501" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/conformance/storage/relational-schema.test.ts tests/contract/postgres/postgres-runtime.test.ts`

Expected: shared/PostgreSQL providers missing.

- [ ] **Step 3: Extract without changing SQLite behavior**

Move logical table definitions/migration metadata/query helpers; keep JSON structured columns/constraints; PostgreSQL 17 schema version equals SQLite logical version. Give every tenant-owned table a composite tenant key and every intra-tenant reference a composite foreign key. Enable and force RLS. `withTenant` opens a transaction and issues parameterized `set_config('app.tenant_id', tenantId, true)` before any query. Create separate non-owner Server, Worker and offline migration/backup roles; only the offline role may bypass application RLS. Keep `FOR UPDATE SKIP LOCKED` for the dedicated Worker tables.

```ts
export function createPostgresRuntime(config: PostgresRuntimeConfig): TenantTransactionProvider {
  const db = new Kysely<RuntimeDatabase>({ dialect: new PostgresDialect({ pool: createPool(config) }) });
  return new PostgresTenantTransactionProvider(db, postgresCapabilities);
}
export interface TenantTransactionProvider {
  withTenant<T>(tenantId: string, operation: (stores: RuntimeStores) => Promise<T>): Promise<T>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 1 plus existing SQLite contracts; all logical contracts, catalog assertions, forced-RLS attacks and role-grant tests must pass.

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

Put/read/hash/repeat/cross-tenant/partial upload; KMS publish a scope-bound LS-10 profile, wrap/unwrap/rotate/revoke/audit/unavailable. Wrong size/hash must not register Manifest; wrong tenant/case/recipient/purpose/region/policy or key status cannot wrap/unwrap. Assert RSA-OAEP SHA-256/MGF1 SHA-256 with empty label and immutable rewrap revisions.

```ts
const manifest = await s3.write(artifactFor("tenant-a"));
expect(await s3.verify(manifest)).toBe(true);
await expect(kms.unwrapDek({ ...unwrapInput, tenantId: "tenant-b" })).rejects.toMatchObject({ code: "KmsScopeDenied" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/artifact-s3 tests/contract/kms-self-hosted`

Expected: providers missing/incomplete.

- [ ] **Step 3: Implement providers**

Use content-addressed key and metadata SHA/size; put before Manifest; HEAD verification. KMS adapter invokes the configured Vault/enterprise endpoint through the LS-10 port, authenticates the request, builds profile scope from server-side policy rather than caller overrides, maps stable errors and records audit without plaintext. Rotation appends an immutable manifest revision; expiry/revocation disables unwrap before ciphertext cleanup.

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

### Task 3: Add Runner enrollment and mTLS principal

**Files:**

- Create: `packages/core-modules/runner-identity/package.json`
- Create: `packages/core-modules/runner-identity/tsconfig.json`
- Create: `packages/core-modules/runner-identity/src/domain/runner-principal.ts`
- Create: `packages/core-modules/runner-identity/src/domain/runner-enrollment.ts`
- Create: `packages/core-modules/runner-identity/src/application/runner-enrollment-service.ts`
- Create: `packages/core-modules/runner-identity/src/ports/runner-certificate-issuer.ts`
- Create: `packages/core-modules/runner-identity/src/public.ts`
- Create: `packages/core-modules/runner-identity/src/index.ts`
- Create: `packages/auth/runner-mtls/package.json`
- Create: `packages/auth/runner-mtls/tsconfig.json`
- Create: `packages/auth/runner-mtls/src/pem-ca-runner-certificate-issuer.ts`
- Create: `packages/auth/runner-mtls/src/self-hosted-runner-authenticator.ts`
- Create: `packages/auth/runner-mtls/src/index.ts`
- Test: `tests/unit/core-modules/runner-identity/runner-enrollment.test.ts`
- Test: `tests/contract/runner-identity/self-hosted-mtls.test.ts`

**Interfaces:** Implements exact `RunnerPrincipal`, `RunnerEnrollment`, `IssuedRunnerCertificate`, `RunnerCertificateIssuer`, `CreateRunnerEnrollment` and `IssueRunnerCertificate` contracts. The gRPC adapter maps an authenticated certificate to a Principal before processing `RunnerHello`.

- [ ] **Step 1: Write enrollment/certificate failures**

Create an enrollment and assert only its one-time response contains the raw token while persistence/log capture contains only its hash. Exchange a signed ECDSA P-256 CSR once; assert URI SAN, fingerprint, tenant/project scope and expiry. Reject replay, expired token, invalid CSR signature, RSA <3072, CSR-supplied SAN, revoked/suspended Runner, expired certificate, wrong chain/EKU, claimed runnerId mismatch and out-of-scope project before any Job Payload is sent.

```ts
const issued = await enrollments.issueCertificate(enrollment.enrollmentId, enrollment.token, validCsr);
expect(parseUriSan(issued.certificatePem)).toBe("spiffe://qualigence.local/tenants/tenant-a/runners/runner-1");
await expect(enrollments.issueCertificate(enrollment.enrollmentId, enrollment.token, validCsr))
  .rejects.toMatchObject({ code: "RunnerEnrollmentAlreadyConsumed" });
await expect(authenticator.authenticate(certForRunner1, helloFor("runner-2")))
  .rejects.toMatchObject({ code: "RunnerIdentityMismatch" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/unit/core-modules/runner-identity tests/contract/runner-identity`

Expected: identity aggregate, issuer port and self-hosted authenticator are missing.

- [ ] **Step 3: Implement single-use enrollment and authentication**

Hash the 256-bit enrollment token at rest, compare in constant time and atomically consume it with certificate issuance. Validate CSR signature/key strength; derive subject and URI SAN only from persisted enrollment. Implement `RunnerCertificateIssuer` in `packages/auth/runner-mtls` with a `@peculiar/x509` PEM-CA adapter whose key comes from `SecretProvider`, while keeping enterprise PKI replaceable. Store certificate fingerprint/expiry and status in `RunnerPrincipal`. Its `SelfHostedRunnerAuthenticator` implements the LS-05 TLS identity port and validates chain, validity, client-auth EKU, revocation, URI SAN, fingerprint and claimed `runnerId`; composition injects it into the gRPC adapter and applies tenant/project authorization before Offer payload serialization.

```ts
export interface RunnerCertificateIssuer {
  issue(input: { readonly runnerId: string; readonly tenantId: string; readonly csrPem: string; readonly uriSan: string }): Promise<IssuedRunnerCertificate>;
}
export class SelfHostedRunnerAuthenticator {
  authenticate(peer: PeerCertificate, hello: RunnerHello): Promise<RunnerPrincipal>;
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 3 command; expect token lifecycle, CSR policy, certificate binding, status and pre-payload scope tests pass.

- [ ] **Step 5: Commit**

```text
git add packages/core-modules/runner-identity packages/auth/runner-mtls tests/unit/core-modules/runner-identity tests/contract/runner-identity
git commit -m "feat(self-hosted): enroll and authenticate runners"
```

### Task 4: Add Public API v1 and OIDC authorization

**Files:**

- Create: `packages/contracts/public-api/package.json`
- Create: `packages/contracts/public-api/tsconfig.json`
- Create: `packages/contracts/public-api/src/v1.ts`
- Create: `packages/auth/oidc/package.json`
- Create: `packages/auth/oidc/tsconfig.json`
- Create: `packages/auth/oidc/src/oidc-authenticator.ts`
- Create: `packages/auth/oidc/src/claim-mapper.ts`
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/routes/projects.ts`
- Create: `apps/server/src/routes/runner-enrollments.ts`
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

**Interfaces:** Implement every Method/Path/permission/application-interface row and every frozen Project/Target/PRD/TestPlan/Mission/Run/Skill/Investigation/Review/Artifact/RunnerEnrollment/RunnerCertificate DTO in the Design Spec; use the list/command/error envelopes and `RequestPrincipal(subject,tenantId,roles)`; require mutation idempotency/expectedVersion.

- [ ] **Step 1: Write auth/tenant/API matrix**

Valid issuer/audience/JWKS and explicitly configured tenant/role claim mapping succeeds; expired/wrong audience/unknown tenant/unknown role fails. Tester can mission, reviewer can claim, viewer cannot mutate. Tenant A IDs requested under tenant B return 404. Admin creates an enrollment whose raw token appears once; certificate exchange is the only route that accepts that token. Domain-only fields are absent from DTOs.

```ts
expect((await apiAs(tester).post("/api/v1/missions", missionBody)).statusCode).toBe(201);
expect((await apiAs(viewer).post("/api/v1/missions", missionBody)).statusCode).toBe(403);
expect((await apiAs(tenantB).get(`/api/v1/runs/${tenantARunId}`)).statusCode).toBe(404);
expect((await apiAs(admin).post("/api/v1/runner-enrollments", enrollmentBody)).json())
  .toMatchObject({ enrollmentToken: expect.any(String) });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/contract/public-api tests/contract/auth`

Expected: contracts/server/auth missing.

- [ ] **Step 3: Implement Fastify adapters**

Validate request/response schemas, verify token signature/issuer/audience/expiry against rotating JWKS, map only allowlisted tenant/role claims per request, pass tenantId to every application query/command, use 409 for expected-version conflict with current safe state, and serve `/health/live|ready` and metrics separately. Never accept a user OIDC token on Runner gRPC or an enrollment token on another Public API route.

```ts
server.post("/api/v1/missions", { schema: createMissionSchema }, async (request, reply) => {
  const principal = await authenticator.requirePrincipal(request);
  authorizer.require(principal, "mission:create");
  const created = await missions.create(principal.tenantId, request.body);
  return reply.code(201).send(toMissionDto(created));
});
```

- [ ] **Step 4: Confirm GREEN**

Run Task 4 command; expect auth/claim-mapping/role/tenant/enrollment/DTO/version cases pass.

- [ ] **Step 5: Commit**

```text
git add packages/contracts/public-api packages/auth/oidc apps/server tests/contract/public-api tests/contract/auth
git commit -m "feat(server): expose tenant-safe public api v1"
```

### Task 5: Implement durable Intelligence Worker and Server Result Inbox consumer

**Files:**

- Create: `apps/intelligence-worker/package.json`
- Create: `apps/intelligence-worker/tsconfig.json`
- Create: `apps/intelligence-worker/src/worker-loop.ts`
- Create: `apps/intelligence-worker/src/main.ts`
- Create: `packages/storage-providers/postgres-runtime/src/postgres-intelligence-job-store.ts`
- Create: `packages/storage-providers/postgres-runtime/src/postgres-intelligence-result-inbox.ts`
- Create: `apps/server/src/intelligence/intelligence-result-consumer.ts`
- Test: `tests/component/intelligence-worker/lease-recovery.test.ts`
- Test: `tests/component/intelligence-worker/result-inbox.test.ts`

**Interfaces:** Implements the Design Spec `IntelligenceJobStore` and `IntelligenceResultInbox`. Worker leases accepted job types via `FOR UPDATE SKIP LOCKED`, renews and appends immutable Results; only the Server consumer invokes `IntelligenceResultApplier` and aggregate commands.

- [ ] **Step 1: Write two-worker/failure tests**

Two Workers never lease the same Job simultaneously; crash/restart after expiry re-leases; duplicate Result appends/applies once; stale base version recomputes; ExecutionJob never appears in the Worker lease query. Connect as the real Worker DB role and assert project/run/evidence tables are inaccessible. Kill Worker after Inbox append and before Server apply, then restart Server and assert exactly-once disposition. A forged/wrong/expired lease token, worker ID, lease attempt or base aggregate version cannot append.

```ts
const [a, b] = await Promise.all([store.leaseForWorker(workerA, types, now, duration), store.leaseForWorker(workerB, types, now, duration)]);
expect([a, b].filter(Boolean)).toHaveLength(1);
expect(await store.leaseExecutionJobAsIntelligence()).toBeNull();
expect(await inbox.append(validSubmission)).toEqual({ disposition: "accepted" });
expect(await inbox.append(validSubmission)).toEqual({ disposition: "duplicate" });
await expect(workerDatabase.selectFrom("runs").selectAll().execute()).rejects.toMatchObject({ code: "42501" });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/component/intelligence-worker/lease-recovery.test.ts`

Expected: Worker/store missing.

- [ ] **Step 3: Implement lease loop**

Use injected Clock/backoff, lease/3 renew, AbortSignal, accepted job types and bounded concurrency. `PostgresIntelligenceJobStore` uses a Worker-only transaction, hashes lease tokens at rest and conditionally renews by worker/token/expiry. `PostgresIntelligenceResultInbox.append` verifies the active Lease and inserts by `(tenant_id, job_id, result.idempotencyKey)`; it never calls an aggregate Repository. The Server consumer claims Inbox rows, calls the LS-10 deterministic `IntelligenceResultApplier`, and commits applied/recompute/rejected disposition idempotently. Grant the Worker role only the required Job lease columns and Inbox insert/select operations.

```ts
while (!signal.aborted) {
  const lease = await jobs.lease(workerId, acceptedTypes, clock.now(), leaseDuration);
  if (!lease) { await backoff.wait(signal); continue; }
  const result = await processor.execute(lease.job, signal);
  await resultInbox.append({ tenantId: lease.job.tenantId, jobId: lease.job.jobId, leaseToken: lease.token, leaseAttempt: lease.attempt, workerId, baseAggregateVersion: lease.job.baseAggregateVersion, result });
}
```

- [ ] **Step 4: Confirm GREEN**

Run Task 5 command; expect concurrency/crash/inbox replay/idempotency/role-separation cases pass.

- [ ] **Step 5: Commit**

```text
git add apps/intelligence-worker apps/server/src/intelligence packages/storage-providers/postgres-runtime tests/component/intelligence-worker
git commit -m "feat(worker): run durable intelligence jobs"
```

### Task 6: Implement shared static Web Console

**Files:**

- Create: `apps/web-console/package.json`
- Create: `apps/web-console/tsconfig.json`
- Create: `apps/web-console/vite.config.ts`
- Create: `apps/web-console/src/api/client.ts`
- Create: `apps/web-console/src/auth/oidc-session.ts`
- Create: `apps/web-console/src/auth/memory-token-store.ts`
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
- Test: `tests/component/web-console/oidc-flow.test.tsx`
- Test: `tests/e2e/web-console/review-conflict.test.ts`

**Interfaces:** Consumes Public API v1 only; implements the nine frozen browser routes; Local bootstrap session or Self-hosted OIDC Authorization Code + PKCE S256 with state/nonce; mutations send idempotency/expectedVersion. Vite produces static files only—there is no Web Console Node process in production.

- [ ] **Step 1: Write MSW component workflows**

Render Project→PRD→Draft Plan approval→Mission/Run→Finding/Case→Review. Concurrent claim 409 must replace stale assignee/version and show conflict; unauthorized Artifact does not download. For OIDC, assert unpredictable distinct state/nonce/code verifier per authorization, S256 challenge, state/nonce mismatch rejection, transient values cleared after callback, access token stored only in memory, no token in local/session storage, and logout clears Query caches.

```tsx
render(<App initialUrl="/reviews/task-1" />);
await user.click(screen.getByRole("button", { name: "Claim" }));
expect(await screen.findByText(/already claimed by bob/i)).toBeVisible();
expect(screen.getByText(/version 2/i)).toBeVisible();
expect(parseAuthorizationUrl(location.href)).toMatchObject({ code_challenge_method: "S256" });
expect(localStorage.getItem("oidc.user")).toBeNull();
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/component/web-console/workflows.test.tsx`

Expected: SPA missing.

- [ ] **Step 3: Implement routes/features**

Use generated/handwritten v1 client with strict schemas, TanStack Query keys including tenant/resource/version, Router auth guards and mutation idempotency UUID. Configure `oidc-client-ts` with `sessionStorage` only for short-lived state/nonce/verifier records and a `MemoryTokenStore` for the authenticated User/access token; use PKCE S256 and validate callback state/nonce before installing a session. Do not import domain/storage packages or display Evidence plaintext without an authorized endpoint.

```tsx
const claim = useMutation({
  mutationFn: () => api.claimReview(task.id, { expectedVersion: task.version, idempotencyKey: crypto.randomUUID() }),
  onError: (error) => error.code === "VersionConflict" && queryClient.setQueryData(reviewKey(task.id), error.current),
});
```

- [ ] **Step 4: Confirm GREEN**

Run `pnpm vitest run tests/component/web-console tests/e2e/web-console/review-conflict.test.ts`; OIDC and workflows pass against mock/real API.

- [ ] **Step 5: Commit**

```text
git add apps/web-console tests/component/web-console tests/e2e/web-console
git commit -m "feat(console): add shared local self-hosted workflows"
```

### Task 7: Build image, Compose, backup/restore operations and full Gate

**Files:**

- Create: `apps/admin-cli/src/main.ts`
- Create: `apps/admin-cli/src/commands/backup.ts`
- Create: `apps/admin-cli/src/commands/restore.ts`
- Create: `apps/admin-cli/src/commands/doctor.ts`
- Create: `apps/admin-cli/src/backup/backup-index.ts`
- Create: `apps/admin-cli/package.json`
- Create: `apps/admin-cli/tsconfig.json`
- Create: `deployments/self-hosted/compose/compose.yaml`
- Create: `deployments/self-hosted/compose/Caddyfile`
- Create: `deployments/self-hosted/compose/.env.example`
- Create: `deployments/self-hosted/compose/.gitignore`
- Create: `deployments/self-hosted/compose/secrets/README.md`
- Create: `deployments/self-hosted/compose/README.md`
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `tests/e2e/self-hosted/compose.test.ts`
- Create: `tests/e2e/self-hosted/backup-restore.test.ts`
- Create: `packages/observability/src/index.ts`
- Create: `packages/observability/package.json`
- Create: `packages/observability/tsconfig.json`
- Modify: `docs/superpowers/implementation-status.md`

**Interfaces:** One immutable image commands `server|worker|migrate|doctor|backup|restore`; static SPA; Compose internal dependencies/volumes/secrets; metrics/OTLP/Pino. `BackupIndexV1` binds the PostgreSQL dump and every copied object byte stream to SHA-256/size.

- [ ] **Step 1: Write Compose security/flow test**

Build/start, run migrate+doctor, login through test OIDC, enroll/connect an external Runner, and execute PRD→Mission→Skill/Investigation/Review through API/Console. Inspect rendered Compose and live containers: non-root, read-only root, all capabilities dropped, `no-new-privileges`, CPU/memory/PID/log limits, PostgreSQL/MinIO not host-published, production secrets mounted from `/run/secrets`, no secret values in environment, no default secrets, and every third-party image pinned by digest. Assert Caddy serves the exact CSP and static Web assets with no Web Console Node container. KMS unavailable makes ready/doctor fail.

For backup, create two tenants and several objects, run `backup`, and concurrently request Artifact GC; assert the backup lease delays deletion and `pg_dump` plus Manifest list share one exported snapshot. Destroy only the isolated test stack, start empty PostgreSQL/MinIO, run `restore`, and verify every database row plus every object by full GET, actual SHA-256 and size. Corrupt/delete one backup object and assert restore fails before marking completion. A Manifest-only export or missing completion marker must fail validation.

```ts
const stack = await compose.up();
expect((await stack.exec("qualigence", ["migrate"])).exitCode).toBe(0);
expect((await stack.exec("qualigence", ["doctor", "--json"])).exitCode).toBe(0);
expect(await stack.publishedPorts("postgres")).toEqual([]);
expect(await stack.security("server")).toMatchObject({ readOnly: true, noNewPrivileges: true, capDrop: ["ALL"] });
expect(await cleanRestore.verifyAllObjectBytes()).toEqual({ missing: [], corrupt: [] });
```

- [ ] **Step 2: Confirm RED**

Run: `pnpm vitest run tests/e2e/self-hosted/compose.test.ts tests/e2e/self-hosted/backup-restore.test.ts`

Expected: image/Compose/admin commands missing.

- [ ] **Step 3: Implement deployment/operations**

Use a multi-stage build and one production image; install only the PostgreSQL client needed by explicit backup/restore; serve Vite output through Caddy/Server static route, not a separate Node process. Make runtime containers non-root/read-only with declared volumes, dropped capabilities, `no-new-privileges` and resource/log limits. Pin external images by digest. Mount each secret as a Compose secret file and pass only its `/run/secrets/...` path. Reverse proxy TLS and the frozen CSP; doctor checks DB/S3/OIDC/KMS/Runner protocol and secret-file permissions.

`backup` first acquires a short backup lease that blocks Artifact GC, opens a `REPEATABLE READ` transaction and calls `pg_export_snapshot()`. Run `pg_dump --snapshot=<id>` and enumerate Artifact Manifests from that same snapshot; because object keys are content-addressed and immutable, stream every referenced S3/MinIO object into a content-addressed backup directory, recompute SHA-256/size and write a canonical `BackupIndexV1` plus a completion marker only after all checks pass. Always release the backup lease. `restore` requires an empty target, validates the complete index and all bytes before mutation, restores PostgreSQL and objects, then GETs every restored object and reruns tenant/reference integrity checks. Document backup→clean-restore rehearsal→migrate→start→verify; binary rollback only. Build/release commands produce OCI provenance and an SPDX/CycloneDX SBOM associated with the immutable image digest.

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
pnpm vitest run tests/e2e/self-hosted/compose.test.ts tests/e2e/self-hosted/backup-restore.test.ts
git diff --check
```

Expected: all exit 0; deployment works without Cloud; clean restore reproduces real object bytes; all identity, forced-RLS, secret, image and fail-closed assertions pass.

- [ ] **Step 5: Commit/status**

```text
git add apps packages deployments Dockerfile tests docs/superpowers/implementation-status.md
git commit -m "feat(self-hosted): ship private m2 deployment"
```

## Plan Self-Review

- Spec coverage: composite tenant keys/forced RLS, S3/KMS, Runner enrollment, OIDC/API, Worker Job/Result Inbox, static Web Console, immutable image/Compose/secrets, real-byte backup/clean restore and observability map to Tasks 1–7.
- Placeholder scan: every provider, identity, page, operation and Gate is named.
- Type consistency: Local/Self-hosted share ports/DTOs; external technologies remain Provider/Composition concerns.
