import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrdIntakeService,
  PrdDocument,
  sha256Hex,
  uuidv7,
  verifySourceRef,
} from "@qualigence/context-intake";
import type { PrdSourceRef } from "@qualigence/context-intake";
import { TestPlanProposalValidator } from "@qualigence/application-model";
import { PrdPlanningAgent } from "@qualigence/model-agent";
import type { TargetCapabilitySummary as PlannerTargetSummary } from "@qualigence/model-agent";
import type {
  StructuredModelInvoker,
  StructuredModelRequest,
} from "@qualigence/model-gateway";
import type {
  StructuredOutputContract,
  ValidatedModelResult,
} from "@qualigence/model-provider";
import {
  approveTestPlan,
  createDraftTestPlan,
  MissionCompiler,
} from "@qualigence/mission";
import type {
  TargetCapabilitySummary,
  TestMission,
} from "@qualigence/mission";
import {
  MissionExecutionUseCase,
  type RunExecutionUseCase,
} from "@qualigence/execution-application";
import { SqlitePrdMissionStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import type { CliConfig } from "../../../apps/cli/src/config.js";
import { createLocalRunUseCase } from "../../../apps/cli/src/local-run-composition-root.js";
import {
  htmlDocument,
  startFixtureServer,
  type FixtureServer,
} from "../web-execution/fixtures.js";

const API_KEY = "sk-secret-DO-NOT-LEAK-abcdef123456";
const MODEL_NAME = "qualigence-test-model";
const fixedClock = { now: () => "2026-08-01T00:00:00.000Z" };

const CART_PRD =
  "Cart total equals the sum of item prices. Checkout is enabled once an item is added.";

function refFor(
  content: string,
  prdId: string,
  revision: number,
  quote: string,
): PrdSourceRef {
  const startOffset = content.indexOf(quote);
  if (startOffset < 0) {
    throw new Error(`quote not found in PRD: ${quote}`);
  }
  return {
    prdId,
    revision,
    startOffset,
    endOffset: startOffset + quote.length,
    quotedTextSha256: sha256Hex(quote),
  };
}

/**
 * A deterministic planner substitute: it returns a fixed, source-grounded
 * proposal so the test exercises the real deterministic validator and the whole
 * persistence/execution chain without a live model.
 */
class ScriptedGateway implements StructuredModelInvoker {
  readonly requests: StructuredModelRequest[] = [];
  constructor(private readonly output: unknown) {}
  async invokeStructured<T>(
    request: StructuredModelRequest,
    contract: StructuredOutputContract<T>,
  ): Promise<ValidatedModelResult<T>> {
    this.requests.push(request);
    return {
      value: contract.parse(this.output),
      model: request.model,
      finishReason: "stop",
    };
  }
}

// ---- Mock model HTTP server for the EXECUTION operations only ---------------
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

interface MockModelServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function startMockModelServer(): Promise<MockModelServer> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as {
        readonly model: string;
        readonly messages: readonly { readonly role: string; readonly content: string }[];
        readonly response_format: { readonly json_schema: { readonly name: string } };
      };
      const operation = body.response_format.json_schema.name;
      const userMessage = [...body.messages]
        .reverse()
        .find((message) => message.role === "user");
      const context = JSON.parse(userMessage?.content ?? "{}") as {
        readonly observation?: ObservationGraphLike;
      };

      let payload: unknown;
      if (operation === "execution_decision") {
        const button = findButton(context.observation!);
        payload = {
          action: { kind: "click", nodeId: button.id },
          reason: "click the add-to-cart control",
        };
      } else if (operation === "execution_verification") {
        payload = { status: "passed", summary: "objective satisfied", claims: [] };
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function groundedProposal(document: PrdDocument): unknown {
  const totalRef = refFor(
    document.content,
    document.prdId,
    document.revision,
    "Cart total equals the sum of item prices.",
  );
  return {
    expectedClaims: [
      {
        semanticKey: "cart-total",
        statement: "Cart total equals the sum of item prices.",
        sourceRefs: [totalRef],
        confidence: 0.9,
      },
    ],
    testCases: [
      {
        title: "Add item and verify total",
        objective: "add one item to the cart",
        preconditions: ["A product is available."],
        steps: [
          { kind: "navigate", path: "/" },
          {
            kind: "click",
            target: { role: "button", name: "Add to cart", purpose: "add the item" },
          },
          { kind: "verify", claimSemanticKeys: ["cart-total"] },
        ],
        expectedClaimSemanticKeys: ["cart-total"],
        sourceRefs: [totalRef],
        priority: "high",
      },
    ],
  };
}

function configFor(model: MockModelServer, dataDir: string): CliConfig {
  return {
    model: { baseUrl: model.baseUrl, apiKey: API_KEY, modelName: MODEL_NAME },
    dataDir,
  };
}

async function openStore(dataDir: string): Promise<{
  store: SqlitePrdMissionStore;
  close: () => Promise<void>;
}> {
  const runtime = await SqliteRuntime.open({
    filename: join(dataDir, "qualigence.db"),
    busyTimeoutMs: 5_000,
  });
  return {
    store: new SqlitePrdMissionStore(runtime),
    close: () => runtime.close(),
  };
}

describe("PRD → intake → plan → mission → execution (component)", () => {
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
        "Cart",
      ),
    });
    dataDir = await mkdtemp(join(process.cwd(), "apps/cli/.vitest-tmp-prd-"));
  });

  afterEach(async () => {
    await fixture?.close();
    await model?.close();
    if (dataDir !== undefined) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it(
    "plans, approves, compiles, executes and durably records a Mission with PRD provenance",
    async () => {
      // 1. Ingest the PRD into an immutable revision.
      const intake = new PrdIntakeService(fixedClock, () => "prd-cart");
      const ingested = await intake.ingest({
        projectId: "project-cart",
        title: "Cart",
        content: CART_PRD,
      });
      expect(ingested.ok).toBe(true);
      if (!ingested.ok) return;
      const document = ingested.value;

      const target: TargetCapabilitySummary & PlannerTargetSummary = {
        targetId: "target-web",
        supportedStepKinds: ["navigate", "click", "verify"],
        capabilities: ["web.navigate", "web.click", "web.assert"],
      };

      // 2. Model produces a proposal ONLY — no ids, no persistence.
      const agent = new PrdPlanningAgent(
        new ScriptedGateway(groundedProposal(document)),
        MODEL_NAME,
      );
      const proposal = await agent.propose(document, target);

      // 3. Deterministic validator grounds the proposal against the PRD.
      const validation = new TestPlanProposalValidator().validate(document, proposal);
      expect(validation.ok).toBe(true);
      if (!validation.ok) return;

      // 4. Core allocates identities and produces a draft, then approves it.
      const draft = createDraftTestPlan(
        {
          projectId: document.projectId,
          prdId: document.prdId,
          prdRevision: document.revision,
          proposal: validation.value,
        },
        uuidv7,
      );
      expect(draft.ok).toBe(true);
      if (!draft.ok) return;

      const approved = approveTestPlan(
        draft.value,
        { expectedVersion: 1, reviewerId: "reviewer-1", idempotencyKey: "approve-1" },
        fixedClock,
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;

      // 5. Compile the approved plan into an immutable, versioned Mission.
      const mission: TestMission = {
        missionId: "mission-cart",
        projectId: document.projectId,
        revision: 1,
        targetId: target.targetId,
        testCaseIds: [approved.value.testCases[0]!.id],
        executionBudget: {
          maximumJobs: 10,
          maximumStepsPerJob: 20,
          maximumWallClockMs: 120_000,
          maximumModelTokens: 100_000,
          stopOnBlockedTestCase: true,
        },
        executionPolicy: { policyId: "policy-mission", environment: "isolated_test", allowedOrigins: [fixture.origin], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2099-08-01T00:00:00.000Z", expiresAt: "2099-08-01T00:01:00.000Z" },
        status: "approved",
      };
      const compiled = new MissionCompiler().compile(approved.value, mission, target);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;

      // 6. Persist PRD, plan and compiled Mission with a pinned dispatch descriptor.
      const opened = await openStore(dataDir);
      await opened.store.savePrdDocument(document);
      await opened.store.saveTestPlanRevision(approved.value);
      await opened.store.saveCompiledMission({
        mission: compiled.value,
        projectId: document.projectId,
        planId: approved.value.planId,
        prdId: document.prdId,
        prdRevision: document.revision,
        dispatch: {
          targetUrl: fixture.url,
          modelProfileId: "default",
          headed: false,
          navigationTimeoutMs: 20_000,
          actionTimeoutMs: 15_000,
        },
        stopOnBlockedTestCase: true,
      });

      // 7. Execute the Mission through the SHARED RunExecutionUseCase (no CLI child process).
      const require = createRequire(import.meta.url);
      const childProcess = require("node:child_process") as typeof import("node:child_process");
      const spawnSpy = vi.spyOn(childProcess, "spawn");

      const runExecution: RunExecutionUseCase = await createLocalRunUseCase(
        configFor(model, dataDir),
      );
      const useCase = new MissionExecutionUseCase(opened.store, runExecution, {
        clock: fixedClock,
      });
      const result = await useCase.execute(mission.missionId);

      // The use case composes the shared in-process RunExecutionUseCase and must
      // never shell out to another `qualigence` CLI. Playwright legitimately
      // spawns the browser, so we assert precisely that no CLI entrypoint was
      // launched rather than that no process was spawned at all.
      const cliSpawns = spawnSpy.mock.calls.filter((call) => {
        const [command, args] = call;
        const parts = [
          String(command),
          ...(Array.isArray(args) ? (args as unknown[]).map(String) : []),
        ];
        return parts.some((part) =>
          /apps[/\\]cli|qualigence(-cli)?(\.[cm]?js)?$|cli[/\\]dist|bin[/\\]qualigence/i.test(
            part,
          ),
        );
      });
      expect(cliSpawns).toEqual([]);
      spawnSpy.mockRestore();
      await opened.close();

      // 8. Full-chain trace back to the PRD revision, plan, mission and run.
      expect(result.status).toBe("completed");
      expect(result.trace).toMatchObject({
        prdRevision: 1,
        planId: approved.value.planId,
        missionId: mission.missionId,
        runId: expect.any(String),
      });
      expect(result.trace.runId).not.toBe("");
      expect(result.jobResults).toHaveLength(1);

      // 9. Re-read the durable Mission execution record and verify provenance.
      const reopened = await openStore(dataDir);
      const record = await reopened.store.loadMissionExecution(mission.missionId);
      await reopened.close();

      expect(record).toBeDefined();
      expect(record?.status).toBe("completed");
      expect(record?.prdId).toBe(document.prdId);
      expect(record?.prdRevision).toBe(document.revision);
      const job = record?.jobs[0];
      expect(job?.attempts[0]?.runId).toBe(result.trace.runId);
      expect(job?.attempts[0]?.status).toBe("passed");
      // Every persisted source ref still resolves against the original PRD text.
      expect(job?.sourceRefs.length).toBeGreaterThan(0);
      for (const ref of job?.sourceRefs ?? []) {
        expect(verifySourceRef(document, ref)).toBe(true);
      }
    },
    120_000,
  );
});
