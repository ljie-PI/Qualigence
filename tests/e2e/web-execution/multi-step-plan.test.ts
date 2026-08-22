import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExecutionCompletion,
  ExecutionEventBatch,
  ExecutionJobLease,
  ExecutionJobOffer,
  ExecutionPlanStep,
  ObservationGraph,
} from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import { SqliteRunnerSpool } from "@qualigence/runner-spool";
import { FileActionValueProvider } from "../../../apps/runner/src/action-value-provider.js";
import type { RunnerConfig } from "../../../apps/runner/src/config.js";
import { RunnerOfferRuntime } from "../../../apps/runner/src/offer-runtime.js";
import {
  htmlDocument,
  startFixtureServer,
  type FixtureServer,
} from "../../component/web-execution/fixtures.js";

const EMAIL = "ticket19-private@example.test";
const COUNTRY = "ticket19-private-country";
const roots: string[] = [];
let fixture: FixtureServer | undefined;
let modelServer: Server | undefined;
let spool: SqliteRunnerSpool | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await spool?.close();
  await fixture?.close();
  if (modelServer !== undefined) {
    modelServer.closeAllConnections();
    modelServer.close();
    await once(modelServer, "close");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  fixture = undefined;
  modelServer = undefined;
  spool = undefined;
});

describe("bounded multi-step production Web Runtime", () => {
  it("executes navigate -> input -> select -> click -> scroll -> verify with indexed redacted Trace", async () => {
    fixture = await startFixtureServer({
      "/": htmlDocument("<p>Start page</p>", "Start"),
      "/form": htmlDocument(`
        <label>Email <input aria-label="Email" /></label>
        <label>Country
          <select aria-label="Country">
            <option value="">Choose a country</option>
            <option value="${COUNTRY}">Canada</option>
          </select>
        </label>
        <button type="button" aria-label="Submit">Submit</button>
        <div style="height: 150vh"></div>
        <p data-qualigence-observe id="result">Waiting</p>
        <script>
          document.querySelector('button').addEventListener('click', () => {
            const email = document.querySelector('input').value;
            const country = document.querySelector('select').value;
            document.getElementById('result').textContent = email && country ? 'Completed' : 'Incomplete';
          });
        </script>
      `, "Multi-step form"),
    });

    const root = await mkdtemp(join(tmpdir(), "qualigence-ticket19-e2e-"));
    roots.push(root);
    await writeFile(join(root, "email.txt"), EMAIL, { mode: 0o600 });
    await writeFile(join(root, "country.txt"), COUNTRY, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(join(root, "email.txt"), 0o600);
      await chmod(join(root, "country.txt"), 0o600);
    }
    const configFile = join(root, "values.json");
    await writeFile(configFile, JSON.stringify({
      "profile.email": "email.txt",
      "profile.country": "country.txt",
    }));
    const valueProvider = await FileActionValueProvider.open({ root, configFile });
    const spoolFile = join(root, "runner-spool.db");
    spool = await SqliteRunnerSpool.open({ databaseFile: spoolFile });

    const modelRequests: unknown[] = [];
    modelServer = createServer(async (request, response) => {
      const body = JSON.parse(await readBody(request)) as {
        readonly messages: readonly { readonly role: string; readonly content: string }[];
        readonly response_format: { readonly json_schema: { readonly name: string } };
      };
      modelRequests.push(body);
      const operation = body.response_format.json_schema.name;
      const output = operation === "execution_verification"
        ? { status: "passed", summary: "the approved claims are satisfied", claims: [] }
        : decisionFrom(body.messages.findLast((message) => message.role === "user")?.content ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: `chatcmpl-${modelRequests.length}`,
        model: "ticket-19-model",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }));
    });
    modelServer.listen(0, "127.0.0.1");
    await once(modelServer, "listening");
    const modelAddress = modelServer.address();
    if (modelAddress === null || typeof modelAddress === "string") throw new Error("Expected model listener.");

    const batches: ExecutionEventBatch[] = [];
    const preAckEvents: ExecutionEventBatch["events"][number][] = [];
    const completions: ExecutionCompletion[] = [];
    const logs: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const lease: ExecutionJobLease = {
      jobId: "job-multi-step",
      runId: "run-multi-step",
      leaseToken: "lease-multi-step",
      leaseEpoch: 1,
      expiresAt: "2099-08-22T00:00:00.000Z",
    };
    const session: RunnerSession = {
      welcome: {
        sessionId: "session-multi-step",
        resumeToken: "resume-multi-step",
        selectedProtocolMajor: 1,
        serverVersion: "test",
        heartbeatIntervalMs: 10_000,
        leaseDurationMs: 60_000,
        traceBatchMaximumEvents: 100,
        traceBatchMaximumBytes: 1_000_000,
        maximumInFlightBatches: 1,
        maximumPendingWriteBytes: 1_000_000,
      },
      nextOffer: async () => { throw new Error("Unexpected nextOffer"); },
      accept: async () => lease,
      renew: async () => { throw new Error("Unexpected lease renewal"); },
      submit: async (batch) => {
        preAckEvents.push(...await spool!.pending(batch.runId, batch.firstSequenceNumber, {
          maximumEvents: 100,
          maximumBytes: 1_000_000,
        }));
        batches.push(batch);
        return {
          batchId: batch.batchId,
          runId: batch.runId,
          nextExpectedSequenceNumber: batch.firstSequenceNumber + batch.events.length,
        };
      },
      complete: async (_currentLease, completion) => { completions.push(completion); },
      close: async () => undefined,
    };
    const config: RunnerConfig = {
      runnerId: "runner-multi-step",
      coreAddress: "unused",
      authority: "unused",
      tls: { ca: Buffer.alloc(0), cert: Buffer.alloc(0), key: Buffer.alloc(0) },
      dataDir: root,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      model: {
        baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
        apiKey: "acceptance-api-key",
        modelName: "ticket-19-model",
        maximumTokensPerCall: 100,
      },
    };
    const runtime = new RunnerOfferRuntime({ config, session, spool, valueProvider });

    try {
      await runtime.run(offer());
    } catch (error) {
      if (error instanceof Error && /browser.*(launch|executable)/i.test(error.message)) {
        throw new Error("ChromiumUnavailable", { cause: error });
      }
      throw error;
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }

    expect(completions).toEqual([{ jobId: "job-multi-step", runId: "run-multi-step", status: "passed" }]);
    const trace = batches.flatMap((batch) => batch.events);
    expect(trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(trace.map((event) => event.stepIndex)).toEqual([
      0, 0, 0, 0, 0,
      1, 1, 1, 1, 1,
      2, 2, 2, 2, 2,
      3, 3, 3, 3, 3,
      4, 4, 4, 4, 4,
      5, 5, 5,
    ]);
    expect(trace.filter((event) => event.stage === "decision").map((event) => event.payload.kind)).toEqual([
      "navigate", "input", "select", "click", "scroll",
    ]);
    expect(finalObservation(trace).nodes.some((node) => node.text === "Completed")).toBe(true);
    expect(modelRequests).toHaveLength(6);

    await spool.close();
    spool = undefined;
    const serializedEvidence = Buffer.concat([
      Buffer.from(JSON.stringify({ trace, preAckEvents, completions, logs, modelRequests }), "utf8"),
      await readFile(spoolFile),
    ]).toString("utf8");
    expect(serializedEvidence).not.toContain(EMAIL);
    expect(serializedEvidence).not.toContain(COUNTRY);
  }, 60_000);
});

function offer(): ExecutionJobOffer {
  const steps = [
    { stepIndex: 0, kind: "navigate", path: "/form" },
    { stepIndex: 1, kind: "input", target: { role: "textbox", name: "Email", purpose: "enter email" }, valueRef: "profile.email" },
    { stepIndex: 2, kind: "select", target: { role: "combobox", name: "Country", purpose: "choose country" }, valueRef: "profile.country" },
    { stepIndex: 3, kind: "click", target: { role: "button", name: "Submit", purpose: "submit form" } },
    { stepIndex: 4, kind: "scroll", target: { role: "text", purpose: "review result" }, direction: "down", amount: "page" },
    { stepIndex: 5, kind: "verify", claimIds: ["claim-completed"] },
  ] as const satisfies readonly ExecutionPlanStep[];
  return {
    offerId: "offer-multi-step",
    job: {
      jobId: "job-multi-step",
      runId: "run-multi-step",
      projectId: "project-ticket-19",
      target: { kind: "web", url: fixture!.url },
      objective: "complete and verify the form",
      policy: {
        policyId: "policy-multi-step",
        environment: "isolated_test",
        allowedOrigins: [fixture!.origin],
        allowedActionKinds: ["navigate", "input", "select", "click", "scroll"],
        maximumRisk: "ExternalSideEffect",
        explorationAllowed: false,
        issuedAt: "2026-08-22T00:00:00.000Z",
        expiresAt: "2099-08-22T00:00:00.000Z",
      },
      plan: {
        missionId: "mission-ticket-19",
        missionRevision: 1,
        testCaseId: "case-multi-step",
        steps,
        expectedClaimIds: ["claim-completed"],
        budget: { maximumStepsPerJob: 6, maximumWallClockMs: 30_000, maximumModelTokens: 100 },
      },
    },
    requiredCapabilities: [
      "target:web-playwright",
      "model:structured-output",
      "action:navigate",
      "action:input",
      "action:select",
      "action:click",
      "action:scroll",
    ],
    leaseDurationMs: 60_000,
  };
}

function decisionFrom(content: string): { readonly nodeId?: string; readonly reason: string } {
  const prompt = JSON.parse(content) as {
    readonly step: Exclude<ExecutionPlanStep, { readonly kind: "verify" }>;
    readonly observation: ObservationGraph;
  };
  const step = prompt.step;
  if (step.kind === "navigate") return { reason: "follow the approved path" };
  const node = step.kind === "scroll"
    ? prompt.observation.nodes.find((candidate) => candidate.text === "Completed")
    : prompt.observation.nodes.find((candidate) =>
        candidate.role === step.target.role && candidate.name === step.target.name);
  if (node === undefined) throw new Error(`No current node grounds ${prompt.step.kind}.`);
  return { nodeId: node.id, reason: `ground ${prompt.step.kind}` };
}

function finalObservation(trace: readonly ExecutionEventBatch["events"][number][]): ObservationGraph {
  const event = trace.filter((candidate) => candidate.stage === "observation").at(-1);
  if (event?.stage !== "observation") throw new Error("Missing final observation.");
  return event.payload;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
