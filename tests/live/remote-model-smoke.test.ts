import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RunExecutionResult } from "@qualigence/execution-application";
import type { ObservationGraph, TraceEvent } from "@qualigence/runner-protocol";
import { runCli } from "../helpers/cli-process.js";
import { withTempDataDir, type TempDataDir } from "../helpers/temp-data-dir.js";
import { startCartFixture, type FixtureHandle } from "../fixtures/web-cart/server.js";

const CLI_ENTRY = fileURLToPath(new URL("../../apps/cli/dist/index.js", import.meta.url));
const OBJECTIVE = "add one item to the cart";
const DEADLINE_MS = 180_000;

/**
 * The four configuration variables the CLI needs to reach a real provider. All
 * must be present, alongside the explicit opt-in flag, before the Live Smoke
 * runs. This keeps real credentials out of the default `pnpm test` gate.
 */
export const REQUIRED_LIVE_MODEL_KEYS = [
  "QUALIGENCE_MODEL_BASE_URL",
  "QUALIGENCE_MODEL_API_KEY",
  "QUALIGENCE_MODEL_NAME",
  "QUALIGENCE_DATA_DIR",
] as const;

export function liveModelEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.QUALIGENCE_LIVE_MODEL_SMOKE === "true" &&
    REQUIRED_LIVE_MODEL_KEYS.every(
      (key) => typeof env[key] === "string" && env[key] !== "",
    )
  );
}

function parseSingleJsonLine(stdout: string): RunExecutionResult {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  expect(lines, `expected exactly one JSON line, received: ${stdout}`).toHaveLength(1);
  return JSON.parse(lines[0]!) as RunExecutionResult;
}

describe("liveModelEnabled", () => {
  const complete: NodeJS.ProcessEnv = {
    QUALIGENCE_LIVE_MODEL_SMOKE: "true",
    QUALIGENCE_MODEL_BASE_URL: "https://api.example.com/v1",
    QUALIGENCE_MODEL_API_KEY: "secret",
    QUALIGENCE_MODEL_NAME: "example-model",
    QUALIGENCE_DATA_DIR: "/data",
  };

  it("stays disabled without the opt-in flag", () => {
    expect(liveModelEnabled({})).toBe(false);
    expect(
      liveModelEnabled({ ...complete, QUALIGENCE_LIVE_MODEL_SMOKE: undefined }),
    ).toBe(false);
  });

  it("stays disabled with the flag but a missing model variable", () => {
    expect(liveModelEnabled({ QUALIGENCE_LIVE_MODEL_SMOKE: "true" })).toBe(false);
    for (const key of REQUIRED_LIVE_MODEL_KEYS) {
      expect(liveModelEnabled({ ...complete, [key]: undefined })).toBe(false);
    }
  });

  it("enables only with the flag plus every model variable", () => {
    expect(liveModelEnabled(complete)).toBe(true);
  });
});

const liveDescribe = liveModelEnabled(process.env) ? describe : describe.skip;

liveDescribe("remote model smoke (opt-in)", () => {
  const openCarts: FixtureHandle[] = [];
  const openTemps: TempDataDir[] = [];

  afterEach(async (context) => {
    const failed = context.task.result?.state === "fail";
    while (openCarts.length > 0) {
      await openCarts.pop()?.close();
    }
    while (openTemps.length > 0) {
      const temp = openTemps.pop();
      if (temp === undefined) {
        continue;
      }
      if (failed) {
        temp.preserve();
      }
      await temp.cleanup();
    }
  });

  it("drives the fault fixture against the real provider and verifies evidence", async () => {
    const cart = await startCartFixture("fault");
    openCarts.push(cart);
    const temp = await withTempDataDir("live-smoke");
    openTemps.push(temp);

    const env: NodeJS.ProcessEnv = { ...process.env, QUALIGENCE_DATA_DIR: temp.path };
    const cli = await runCli(
      [CLI_ENTRY, "run", "--url", cart.url, "--objective", OBJECTIVE, "--output", "json"],
      env,
      DEADLINE_MS,
    );

    // Stable, parseable outcome — no assertion on model wording.
    const result = parseSingleJsonLine(cli.stdout);
    expect([0, 1]).toContain(cli.exitCode);
    expect(["passed", "finding"]).toContain(result.status);
    expect(result.runId).not.toBe("");

    const persisted = await temp.readPersistedRun(result.runId);
    expect(persisted.run?.runId).toBe(result.runId);

    // The Decision must reference a node from the current Observation.
    const observationEvent = persisted.traceEvents.find(
      (event: TraceEvent) => event.stage === "observation",
    );
    const decisionEvent = persisted.traceEvents.find(
      (event: TraceEvent) => event.stage === "decision",
    );
    expect(observationEvent).toBeDefined();
    expect(decisionEvent).toBeDefined();
    const graph = observationEvent!.payload as ObservationGraph;
    const decision = decisionEvent!.payload as { target: { nodeId: string } };
    expect(graph.nodes.some((node) => node.id === decision.target.nodeId)).toBe(true);

    // Real artifacts with valid hashes; no fabricated evidence.
    expect(await temp.verifyArtifacts(result.runId)).toBe(true);

    // Persisted model invocations are summaries only — never the API key.
    const apiKey = process.env.QUALIGENCE_MODEL_API_KEY!;
    for (const invocation of persisted.modelInvocations) {
      expect(JSON.stringify(invocation)).not.toContain(apiKey);
    }
    expect(cli.stdout).not.toContain(apiKey);
    expect(cli.stderr).not.toContain(apiKey);
    for (const file of await temp.listFiles()) {
      const contents = await readFile(file, "latin1");
      expect(contents.includes(apiKey), `API key leaked into ${file}`).toBe(false);
    }
  }, DEADLINE_MS + 30_000);
});
