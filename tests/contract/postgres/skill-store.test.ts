import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSkillStore, createPostgresRuntime, provisionPostgres, type TenantTransactionProvider } from "@qualigence/postgres-runtime";
import { REQUIRED_REPLAY_ORACLES, SkillLifecycleService } from "@qualigence/skill";
import { dockerAvailable, startPostgres, type StartedPostgres } from "../../helpers/docker-container.js";
import { skillLifecycleCommandContract, seedVerifiedSkill, TrustingSkillSigner } from "../sqlite/skill-lifecycle-command.contract.js";

if (!dockerAvailable()) throw new Error("DockerUnavailable: PostgreSQL Skill store contract requires Docker.");

describe("PostgresSkillStore", () => {
  let container: StartedPostgres;
  let provider: TenantTransactionProvider;
  let tenantCounter = 0;

  beforeAll(async () => {
    container = await startPostgres();
    const admin = { host: container.host, port: container.port, database: container.database, user: container.superuser, password: container.password };
    await provisionPostgres({ admin, roles: { server: { name: "skill_server", password: "server_pw" }, worker: { name: "skill_worker", password: "worker_pw" } } });
    provider = createPostgresRuntime({ ...admin, user: "skill_server", password: "server_pw" });
  }, 180_000);

  afterAll(async () => {
    await provider?.close();
    await container?.stop();
  });

  skillLifecycleCommandContract({
    async open() {
      const tenantId = `tenant-contract-${tenantCounter++}`;
      return {
        signer: new TrustingSkillSigner(),
        tenantId,
        withStore: (operation) => provider.withTenant(tenantId, ({ db }) => operation(new PostgresSkillStore(db, tenantId))),
        withFailingStore: (failAfterLifecycleWrite, operation) => provider.withTenant(tenantId, ({ db }) => operation(new PostgresSkillStore(db, tenantId, { failAfterLifecycleWrite }))),
        close: async () => {},
      };
    },
  });

  it("keeps tenant Skill reads isolated", async () => {
    await provider.withTenant("tenant-a", async ({ db }) => {
      const store = new PostgresSkillStore(db, "tenant-a");
      await seedVerifiedSkill(store, new TrustingSkillSigner(), "tenant-secret");
    });
    await provider.withTenant("tenant-b", async ({ db }) => {
      const store = new PostgresSkillStore(db, "tenant-b");
      expect(await store.latestVersion("tenant-secret")).toBeUndefined();
    });
  });

  it("allows only one winner when two lifecycle writers race on the same expected version", async () => {
    await provider.withTenant("tenant-race", async ({ db }) => {
      await seedVerifiedSkill(new PostgresSkillStore(db, "tenant-race"), new TrustingSkillSigner(), "skill-race");
    });

    const signer = new TrustingSkillSigner();
    const results = await Promise.allSettled([
      provider.withTenant("tenant-race", async ({ db }) => new SkillLifecycleService({ repository: new PostgresSkillStore(db, "tenant-race"), signer }).promote({ operation: "promote", skillId: "skill-race", expectedVersion: 3, idempotencyKey: "pg-race-promote", requiredOracles: REQUIRED_REPLAY_ORACLES, actor: { actorId: "tester-a", tenantId: "tenant-race", roles: ["tester"] }, occurredAt: "2026-08-01T00:08:00.000Z" })),
      provider.withTenant("tenant-race", async ({ db }) => new SkillLifecycleService({ repository: new PostgresSkillStore(db, "tenant-race"), signer }).deprecate({ operation: "deprecate", skillId: "skill-race", expectedVersion: 3, idempotencyKey: "pg-race-deprecate", reason: "race loser", actor: { actorId: "tester-b", tenantId: "tenant-race", roles: ["tester"] }, occurredAt: "2026-08-01T00:08:00.000Z" })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "SkillVersionConflict" } });
    await provider.withTenant("tenant-race", async ({ db }) => {
      const store = new PostgresSkillStore(db, "tenant-race");
      expect((await store.latestVersion("skill-race"))?.version).toBe(4);
      expect(await store.lifecycleAuditEvents("skill-race")).toHaveLength(1);
    });
  });
});
