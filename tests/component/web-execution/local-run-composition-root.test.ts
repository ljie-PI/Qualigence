import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRunStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import type { RunExecutionRequest } from "@qualigence/execution-application";
import type { CliConfig } from "../../../apps/cli/src/config.js";
import { createLocalRunUseCase } from "../../../apps/cli/src/local-run-composition-root.js";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";

const API_KEY = "sk-secret-DO-NOT-LEAK-abcdef123456";
const MODEL_NAME = "qualigence-test-model";

type VerificationMode = "passed" | "finding";

interface MockModelServer {
  readonly baseUrl: string;
  mode: VerificationMode;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface ObservationNodeLike {
  readonly id: string;
  readonly role?: string;
  readonly name?: string;
  readonly text?: string | null;
}

interface ObservationGraphLike {
  readonly graphId: string;
  readonly nodes: readonly ObservationNodeLike[];
}

function findButton(graph: ObservationGraphLike): ObservationNodeLike {
  const node =
    graph.nodes.find((candidate) => candidate.name === "Add to cart") ??
    graph.nodes.find((candidate) => candidate.role === "button");
  if (node === undefined) {
    throw new Error("Mock model server found no clickable button node.");
  }
  return node;
}

function findTotal(graph: ObservationGraphLike): ObservationNodeLike {
  const node = graph.nodes.find(
    (candidate) =>
      typeof candidate.text === "string" &&
      candidate.text.includes("Cart total"),
  );
  if (node === undefined) {
    throw new Error("Mock model server found no cart-total node.");
  }
  return node;
}

function completion(model: string, payload: unknown): string {
  return JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(payload) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

async function startMockModelServer(): Promise<MockModelServer> {
  const state: { mode: VerificationMode } = { mode: "passed" };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as {
        readonly model: string;
        readonly messages: readonly { readonly role: string; readonly content: string }[];
        readonly response_format: {
          readonly json_schema: { readonly name: string };
        };
      };
      const operation = body.response_format.json_schema.name;
      const userMessage = [...body.messages]
        .reverse()
        .find((message) => message.role === "user");
      const context = JSON.parse(userMessage?.content ?? "{}") as {
        readonly observation?: ObservationGraphLike;
        readonly before?: ObservationGraphLike;
        readonly after?: ObservationGraphLike;
      };

      let payload: unknown;
      if (operation === "execution_decision") {
        const button = findButton(context.observation!);
        payload = {
          action: { kind: "click", nodeId: button.id },
          reason: "click the add-to-cart control",
        };
      } else if (operation === "execution_verification") {
        if (state.mode === "passed") {
          payload = { status: "passed", summary: "objective satisfied", claims: [] };
        } else {
          const before = findTotal(context.before!);
          const after = findTotal(context.after!);
          payload = {
            status: "failed",
            summary: "cart total changed unexpectedly",
            severitySuggestion: "medium",
            claims: [
              {
                expected: {
                  graphId: context.before!.graphId,
                  nodeId: before.id,
                  text: before.text,
                },
                observed: {
                  graphId: context.after!.graphId,
                  nodeId: after.id,
                  text: after.text,
                },
              },
            ],
          };
        }
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: `unknown operation ${operation}` }));
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(completion(body.model, payload));
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get mode() {
      return state.mode;
    },
    set mode(value: VerificationMode) {
      state.mode = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function configFor(model: MockModelServer, dataDir: string): CliConfig {
  return {
    model: { baseUrl: model.baseUrl, apiKey: API_KEY, modelName: MODEL_NAME },
    dataDir,
  };
}

function requestFor(url: string): RunExecutionRequest {
  return {
    target: { kind: "web", url },
    objective: "add one item to the cart",
    executionProfile: {
      modelProfileId: "default",
      headed: false,
      navigationTimeoutMs: 20_000,
      actionTimeoutMs: 15_000,
    },
  };
}

async function reopenRun(dataDir: string, runId: string) {
  const runtime = await SqliteRuntime.open({
    filename: join(dataDir, "qualigence.db"),
    busyTimeoutMs: 5_000,
  });
  try {
    return await new SqliteRunStore(runtime).get(runId);
  } finally {
    await runtime.close();
  }
}

function allFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...allFilesUnder(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

describe("local-run composition root", () => {
  let model: MockModelServer;
  let fixture: FixtureServer;
  let dataDir: string;

  beforeEach(async () => {
    model = await startMockModelServer();
    fixture = await startFixtureServer({
      "/": htmlDocument(
        `
          <button id="add" onclick="document.getElementById('total').textContent='Cart total: $19'">Add to cart</button>
          <p data-qualigence-observe id="total">Cart total: $0</p>
        `,
        "Composition",
      ),
    });
    dataDir = await mkdtemp(join(process.cwd(), "apps/cli/.vitest-tmp-"));
  });

  afterEach(async () => {
    await fixture?.close();
    await model?.close();
    if (dataDir !== undefined) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("exposes only execute and hides every concrete dependency", async () => {
    const useCase = await createLocalRunUseCase(configFor(model, dataDir));
    expect(Object.keys(useCase)).toEqual(["execute"]);
  });

  it("runs a real observe->decide->act->verify cycle and persists a passing Run", async () => {
    model.mode = "passed";
    const useCase = await createLocalRunUseCase(configFor(model, dataDir));

    const result = await useCase.execute(requestFor(fixture.url));

    expect(result.status).toBe("passed");
    expect(result.runId).not.toBe("");
    const persisted = await reopenRun(dataDir, result.runId);
    expect(persisted).toBeDefined();
    expect(persisted?.status).toBe("passed");
    expect(result.evidenceRefs.length).toBeGreaterThan(0);
  }, 60_000);

  it("produces a Finding with evidence references from a real failure", async () => {
    model.mode = "finding";
    const useCase = await createLocalRunUseCase(configFor(model, dataDir));

    const result = await useCase.execute(requestFor(fixture.url));

    expect(result.status).toBe("finding");
    expect(result.finding).toBeDefined();
    expect(result.evidenceRefs.length).toBeGreaterThan(0);
    const persisted = await reopenRun(dataDir, result.runId);
    expect(persisted?.status).toBe("finding");
  }, 60_000);

  it("isolates state across sequential runs and never leaks the API key", async () => {
    const useCase = await createLocalRunUseCase(configFor(model, dataDir));

    model.mode = "passed";
    const first = await useCase.execute(requestFor(fixture.url));
    model.mode = "finding";
    const second = await useCase.execute(requestFor(fixture.url));

    expect(first.runId).not.toBe(second.runId);
    expect(await reopenRun(dataDir, first.runId)).toBeDefined();
    expect(await reopenRun(dataDir, second.runId)).toBeDefined();

    for (const file of allFilesUnder(dataDir)) {
      const contents = readFileSync(file, "latin1");
      expect(contents.includes(API_KEY)).toBe(false);
    }
  }, 90_000);
});
