import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { SqliteRunnerControlStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import {
  runnerControlStoreContract,
  type RunnerControlStoreContractHarness,
} from "./runner-control-store.contract.js";

async function createHarness(): Promise<RunnerControlStoreContractHarness> {
  const directory = await mkdtemp(join(process.cwd(), ".tmp-runner-control-sqlite-"));
  const filename = join(directory, "qualigence.db");
  let primary = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
  let concurrent = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });

  return {
    runPrimary: (operation) => operation(new SqliteRunnerControlStore(primary)),
    runConcurrent: (operation) => operation(new SqliteRunnerControlStore(concurrent)),
    async reopen() {
      await concurrent.close();
      await primary.close();
      primary = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
      concurrent = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    },
    async close() {
      await concurrent.close();
      await primary.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

runnerControlStoreContract("SQLite", createHarness);
