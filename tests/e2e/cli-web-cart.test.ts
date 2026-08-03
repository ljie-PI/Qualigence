import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { RunExecutionResult } from "@qualigence/execution-application";
import type { TraceEvent } from "@qualigence/runner-protocol";
import { runCli } from "../helpers/cli-process.js";
import { withTempDataDir, type TempDataDir } from "../helpers/temp-data-dir.js";
import { startCartFixture } from "../fixtures/web-cart/server.js";
import {
  startMockModelServer,
  type FixtureHandle,
  type MockModelHandle,
  type MockModelMode,
} from "../fixtures/openai-compatible/mock-server.js";
import { CART_ORACLE, type CartMode } from "../fixtures/web-cart/page.js";

const CLI_ENTRY = fileURLToPath(new URL("../../apps/cli/dist/index.js", import.meta.url));
const MODEL_NAME = "qualigence-mock-model";
const FAKE_API_KEY = "sk-e2e-FAKE-DO-NOT-LEAK-0123456789abcdef";
const OBJECTIVE = "add one item to the cart";
const DEADLINE_MS = 120_000;

interface Scenario {
  readonly exitCode: number;
  readonly result: RunExecutionResult;
  readonly stdout: string;
  readonly stderr: string;
  readonly model: MockModelHandle;
  readonly temp: TempDataDir;
}

const openHandles: FixtureHandle[] = [];
const openModels: MockModelHandle[] = [];
const openTemps: { temp: TempDataDir; failed: boolean }[] = [];

afterEach(async (context) => {
  const failed = context.task.result?.state === "fail";
  while (openHandles.length > 0) {
    await openHandles.pop()?.close();
  }
  while (openModels.length > 0) {
    await openModels.pop()?.close();
  }
  while (openTemps.length > 0) {
    const entry = openTemps.pop();
    if (entry === undefined) {
      continue;
    }
    if (failed) {
      entry.temp.preserve();
    }
    await entry.temp.cleanup();
  }
});

async function waitForHealth(baseUrl: string): Promise<void> {
  const healthUrl = new URL("/health", baseUrl).toString();
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`health probe failed for ${baseUrl}: ${String(lastError)}`);
}

function parseSingleJsonLine(stdout: string): RunExecutionResult {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  expect(lines, `expected exactly one JSON line, received: ${stdout}`).toHaveLength(1);
  return JSON.parse(lines[0]!) as RunExecutionResult;
}

async function runScenario(
  name: string,
  cartMode: CartMode,
  modelMode: MockModelMode,
): Promise<Scenario> {
  const cart = await startCartFixture(cartMode);
  openHandles.push(cart);
  const model = await startMockModelServer({ mode: modelMode });
  openModels.push(model);
  const temp = await withTempDataDir(name);
  openTemps.push({ temp, failed: false });

  await waitForHealth(cart.url);
  await waitForHealth(model.url);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QUALIGENCE_MODEL_BASE_URL: model.url,
    QUALIGENCE_MODEL_API_KEY: FAKE_API_KEY,
    QUALIGENCE_MODEL_NAME: MODEL_NAME,
    QUALIGENCE_DATA_DIR: temp.path,
  };

  const cli = await runCli(
    [
      CLI_ENTRY,
      "run",
      "--url",
      cart.url,
      "--objective",
      OBJECTIVE,
      "--output",
      "json",
    ],
    env,
    DEADLINE_MS,
  );

  const result = parseSingleJsonLine(cli.stdout);
  return {
    exitCode: cli.exitCode,
    result,
    stdout: cli.stdout,
    stderr: cli.stderr,
    model,
    temp,
  };
}

async function assertNoApiKeyLeak(scenario: Scenario): Promise<void> {
  expect(scenario.stdout).not.toContain(FAKE_API_KEY);
  expect(scenario.stderr).not.toContain(FAKE_API_KEY);
  for (const file of await scenario.temp.listFiles()) {
    const contents = await readFile(file, "latin1");
    expect(contents.includes(FAKE_API_KEY), `API key leaked into ${file}`).toBe(false);
  }
}

function stageEvent(events: readonly TraceEvent[], stage: string): TraceEvent | undefined {
  return events.find((event) => event.stage === stage);
}

describe("black-box CLI web cart vertical slice", () => {
  it("normal: passes, exits 0 and persists verified evidence", async () => {
    const scenario = await runScenario("normal", "normal", "dynamic");

    expect(scenario.exitCode).toBe(0);
    expect(scenario.result.status).toBe("passed");
    expect(scenario.result.runId).not.toBe("");
    expect(scenario.result.finding).toBeUndefined();

    const persisted = await scenario.temp.readPersistedRun(scenario.result.runId);
    expect(persisted.run?.status).toBe("passed");
    expect(
      persisted.traceStages.filter((stage) => stage === "run_completed"),
    ).toHaveLength(1);
    expect(persisted.traceStages.at(-1)).toBe("run_completed");
    expect(persisted.traceStages).not.toContain("finding");

    expect(await scenario.temp.verifyArtifacts(scenario.result.runId)).toBe(true);
    const kinds = persisted.manifests.map((manifest) => manifest.kind);
    expect(kinds).toContain("observation");
    expect(kinds).toContain("screenshot");

    expect(scenario.model.requestCount()).toBeGreaterThanOrEqual(2);
    for (const invocation of persisted.modelInvocations) {
      expect(invocation.status).toBe("succeeded");
    }
    await assertNoApiKeyLeak(scenario);
  }, DEADLINE_MS + 30_000);

  it("fault: reports a Finding, exits 1 and cites $19 vs $29", async () => {
    const scenario = await runScenario("fault", "fault", "dynamic");

    expect(scenario.exitCode).toBe(1);
    expect(scenario.result.status).toBe("finding");
    expect(scenario.result.finding).toBeDefined();
    expect(scenario.result.finding!.evidenceRefs.length).toBeGreaterThan(0);

    const persisted = await scenario.temp.readPersistedRun(scenario.result.runId);
    expect(persisted.run?.status).toBe("finding");
    expect(
      persisted.traceStages.filter((stage) => stage === "run_completed"),
    ).toHaveLength(1);

    const verification = stageEvent(persisted.traceEvents, "verification");
    const payload = verification?.payload as
      | {
          status: string;
          claims: readonly {
            expected: { text: string };
            observed: { text: string };
          }[];
        }
      | undefined;
    expect(payload?.status).toBe("failed");
    expect(payload?.claims[0]?.expected.text).toBe(CART_ORACLE.itemPrice);
    expect(payload?.claims[0]?.observed.text).toBe(CART_ORACLE.totalAfter.fault);

    expect(await scenario.temp.verifyArtifacts(scenario.result.runId)).toBe(true);
    await assertNoApiKeyLeak(scenario);
  }, DEADLINE_MS + 30_000);

  it("blocked: exits 2, reports blocked and writes no Finding", async () => {
    const scenario = await runScenario("blocked", "normal", "blocked");

    expect(scenario.exitCode).toBe(2);
    expect(scenario.result.status).toBe("blocked");
    expect(scenario.result.finding).toBeUndefined();

    const persisted = await scenario.temp.readPersistedRun(scenario.result.runId);
    expect(persisted.run?.status).toBe("blocked");
    expect(persisted.traceStages).not.toContain("finding");
    expect(
      persisted.traceStages.filter((stage) => stage === "run_completed"),
    ).toHaveLength(1);

    // The Gateway makes exactly one structured-output correction attempt.
    expect(scenario.model.requestCount()).toBe(2);
    await assertNoApiKeyLeak(scenario);
  }, DEADLINE_MS + 30_000);

  it("unauthorized: exits 3 with an auth-failure outcome, one request, no retry", async () => {
    const scenario = await runScenario("unauthorized", "normal", "unauthorized");

    expect(scenario.exitCode).toBe(3);
    expect(scenario.result.status).toBe("error");
    expect(scenario.result.errorCode).toBe("ModelAuthenticationFailed");
    expect(scenario.result.finding).toBeUndefined();

    const persisted = await scenario.temp.readPersistedRun(scenario.result.runId);
    expect(persisted.run?.status).toBe("error");
    expect(persisted.traceStages).not.toContain("finding");

    // A 401 is not transient: exactly one provider request, no retry.
    expect(scenario.model.requestCount()).toBe(1);
    await assertNoApiKeyLeak(scenario);
  }, DEADLINE_MS + 30_000);
});
