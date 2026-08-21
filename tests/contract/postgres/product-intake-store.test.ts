import { afterAll, beforeAll, describe } from "vitest";
import { createPostgresRuntime, PostgresPrdMissionRepository, PostgresProjectTargetRepository, PostgresTestPlanRepository, provisionPostgres, type TenantTransactionProvider } from "@qualigence/postgres-runtime";
import { dockerAvailable, startPostgres, type StartedPostgres } from "../../helpers/docker-container.js";
import { productIntakeProviderContract, type ProductIntakeProvider } from "../sqlite/product-intake-store.contract.js";

if (!dockerAvailable()) throw new Error("DockerUnavailable: PostgreSQL product intake contract requires Docker.");

describe("PostgreSQL product intake provider contract", () => {
  let container: StartedPostgres;
  let provider: TenantTransactionProvider;
  beforeAll(async () => {
    container = await startPostgres();
    const admin = { host: container.host, port: container.port, database: container.database, user: container.superuser, password: container.password };
    await provisionPostgres({ admin, roles: { server: { name: "product_server", password: "server_pw" }, worker: { name: "product_worker", password: "worker_pw" } } });
    provider = createPostgresRuntime({ ...admin, user: "product_server", password: "server_pw" });
  }, 180_000);
  afterAll(async () => { await provider?.close(); await container?.stop(); });

  productIntakeProviderContract({
    async open() {
      let resolve!: (value: ProductIntakeProvider) => void;
      let release!: () => void;
      const ready = new Promise<ProductIntakeProvider>((done) => { resolve = done; });
      const held = new Promise<void>((done) => { release = done; });
      const transaction = provider.withTenant("tenant-a", async ({ db }) => {
        const plans = new PostgresTestPlanRepository(db, "tenant-a");
        resolve({ targets: new PostgresProjectTargetRepository(db, "tenant-a"), plans, missions: new PostgresPrdMissionRepository(db, "tenant-a"), seedPrd: (document) => plans.savePrdDocument(document), close: async () => release() });
        await held;
      });
      const opened = await ready;
      return { ...opened, close: async () => { await opened.close(); await transaction; } };
    },
    async concurrent(operation) {
      return Promise.allSettled([0, 1].map((index) => provider.withTenant("tenant-a", async ({ db }) => { const plans = new PostgresTestPlanRepository(db, "tenant-a"); return operation({ targets: new PostgresProjectTargetRepository(db, "tenant-a"), plans, missions: new PostgresPrdMissionRepository(db, "tenant-a"), seedPrd: (document) => plans.savePrdDocument(document), close: async () => {} }, index); })));
    },
  });
});
