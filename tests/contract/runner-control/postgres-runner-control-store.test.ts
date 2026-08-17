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
let primaryRuntime: TenantTransactionProvider | undefined;
let concurrentRuntime: TenantTransactionProvider | undefined;

beforeAll(async () => {
  if (!dockerAvailable()) {
    throw new Error("DockerUnavailable: RunnerControlStore PostgreSQL contract requires Docker.");
  }
  fixture = await setupPostgresFixture();
  primaryRuntime = createPostgresRuntime(fixture.serverConfig);
  concurrentRuntime = createPostgresRuntime(fixture.serverConfig);
}, 120_000);

afterAll(async () => {
  await concurrentRuntime?.close();
  await primaryRuntime?.close();
  await fixture?.stop();
});

async function createHarness(): Promise<RunnerControlStoreContractHarness> {
  if (!dockerAvailable()) {
    throw new Error("DockerUnavailable: RunnerControlStore PostgreSQL contract requires Docker.");
  }
  if (fixture === undefined || primaryRuntime === undefined || concurrentRuntime === undefined) {
    throw new Error("PostgreSQL RunnerControlStore fixture was not initialized.");
  }
  const primary = primaryRuntime;
  const concurrent = concurrentRuntime;
  const provisioned = fixture;
  const admin = await import("pg").then((module) => new module.default.Client(provisioned.adminConfig));
  await admin.connect();
  try {
    await admin.query(
      "TRUNCATE TABLE execution_completions, execution_leases, runner_resume_tokens, runner_sessions",
    );
  } finally {
    await admin.end();
  }

  return {
    runPrimary: (operation) =>
      primary.withTenant(TENANT_ID, ({ db }) =>
        operation(new PostgresRunnerControlStore(db, TENANT_ID)),
      ),
    runConcurrent: (operation) =>
      concurrent.withTenant(TENANT_ID, ({ db }) =>
        operation(new PostgresRunnerControlStore(db, TENANT_ID)),
      ),
    reopen: async () => {},
    close: async () => {},
  };
}

runnerControlStoreContract("PostgreSQL", createHarness);
