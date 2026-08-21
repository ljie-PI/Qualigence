import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe } from "vitest";
import { SqliteProjectTargetStore, SqliteRuntime, SqliteTestPlanStore } from "@qualigence/sqlite-runtime";
import { productIntakeProviderContract, type ProductIntakeProvider } from "./product-intake-store.contract.js";

describe("SQLite product intake provider contract", () => {
  let directory: string;
  let filename: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(process.cwd(), ".tmp-product-intake-"));
    filename = join(directory, "product.db");
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  async function open(): Promise<ProductIntakeProvider> {
    const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    const plans = new SqliteTestPlanStore(runtime);
    return { targets: new SqliteProjectTargetStore(runtime), plans, seedPrd: (document) => plans.savePrdDocument(document), close: () => runtime.close() };
  }

  productIntakeProviderContract({
    open,
    async concurrent(operation) {
      const providers = await Promise.all([open(), open()]);
      const outcomes = await Promise.allSettled(providers.map(async (provider, index) => {
        try {
          if (index === 1) await new Promise((resolve) => setTimeout(resolve, 25));
          return await operation(provider);
        } finally { await provider.close(); }
      }));
      return outcomes;
    },
  });
});
