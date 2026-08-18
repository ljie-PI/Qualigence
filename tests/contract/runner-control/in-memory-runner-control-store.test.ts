import {
  runnerControlStoreContract,
  type RunnerControlStoreContractHarness,
} from "./runner-control-store.contract.js";
import { InMemoryRunnerControlStore } from "../../helpers/in-memory-runner-control-store.js";

function createHarness(): Promise<RunnerControlStoreContractHarness> {
  // The in-memory store serializes every operation internally, so the
  // "concurrent caller" shares the same instance: both callers observe exactly
  // one rotation, exactly like two connections to one database.
  const primary = new InMemoryRunnerControlStore();
  return Promise.resolve({
    runPrimary: (operation) => operation(primary),
    runConcurrent: (operation) => operation(primary),
    reopen: async () => {},
    close: async () => {},
  });
}

runnerControlStoreContract("InMemory", createHarness);