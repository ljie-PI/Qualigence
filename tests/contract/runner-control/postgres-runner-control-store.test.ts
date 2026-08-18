import { afterAll, beforeAll } from "vitest";
import {
  createPostgresRuntime,
  PostgresRunnerControlStore,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { dockerAvailable } from "../../helpers/docker-container.js";
import {
  setupPostgresFixture,
  type PostgresFixture,
} from "../../helpers/postgres-fixture.js";
import {
  runnerControlStoreContract,
  type RunnerControlStoreContractHarness,
} from "./runner-control-store.contract.js";

const TENANT_ID = "tenant-runner-control";

let fixture: PostgresFixture | undefined;

beforeAll(async () => {
  if (!dockerAvailable()) {
    throw new Error("DockerUnavailable: RunnerControlStore PostgreSQL contract requires Docker.");
  }
  fixture = await setupPostgresFixture();
}, 120_000);

afterAll(async () => {
  await fixture?.stop();
});

async function truncateRunnerControlTables(fixtureToClean: PostgresFixture): Promise<void> {
  const admin = await import("pg").then((module) => new module.default.Client(fixtureToClean.adminConfig));
  await admin.connect();
  try {
    await admin.query(
      "TRUNCATE TABLE execution_completions, execution_leases, runner_resume_tokens, runner_sessions",
    );
  } finally {
    await admin.end();
  }
}

function storeIn(
  getRuntime: () => TenantTransactionProvider,
): RunnerControlStoreContractHarness["runPrimary"] {
  return (operation) =>
    getRuntime().withTenant(TENANT_ID, ({ db }) =>
      operation(new PostgresRunnerControlStore(db, TENANT_ID)),
    );
}

async function createHarness(): Promise<RunnerControlStoreContractHarness> {
  if (!dockerAvailable()) {
    throw new Error("DockerUnavailable: RunnerControlStore PostgreSQL contract requires Docker.");
  }
  if (fixture === undefined) {
    throw new Error("PostgreSQL RunnerControlStore fixture was not initialized.");
  }
  const f = fixture;
  await truncateRunnerControlTables(f);
  let primary = createPostgresRuntime(f.serverConfig);
  let concurrent = createPostgresRuntime(f.serverConfig);

  return {
    runPrimary: storeIn(() => primary),
    runConcurrent: storeIn(() => concurrent),
    // A real reopen: fresh pools and connections against the same database, so
    // the restart contract observes durable state across connections.
    async reopen() {
      await concurrent.close();
      await primary.close();
      primary = createPostgresRuntime(f.serverConfig);
      concurrent = createPostgresRuntime(f.serverConfig);
    },
    async close() {
      await concurrent.close();
      await primary.close();
    },
  };
}

runnerControlStoreContract("PostgreSQL", createHarness);