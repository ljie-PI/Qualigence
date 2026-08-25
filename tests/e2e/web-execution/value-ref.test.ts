import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WEB_OBSERVATION_V1_CAPABILITY_TOKENS,
  type ExecutionJobLease,
  type ExecutionCompletion,
  type ExecutionEventBatch,
  type ExecutionJobOffer,
  type ExecutionPlanStep,
  type ObservationGraphV1,
} from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import { SqliteRunnerSpool } from "@qualigence/runner-spool";
import { FileActionValueProvider } from "../../../apps/runner/src/action-value-provider.js";
import type { RunnerConfig } from "../../../apps/runner/src/config.js";
import { RunnerOfferRuntime } from "../../../apps/runner/src/offer-runtime.js";
import { htmlDocument, startFixtureServer, type FixtureServer } from "../../component/web-execution/fixtures.js";

const INPUT_VALUE = "alpha\nbeta\r\ngamma\n";
const INPUT_BROWSER_VALUE = "alpha\nbeta\ngamma\n";
const INPUT_EQUAL_TEXT = "alpha beta gamma";
const SELECT_VALUE = "e2e-private-country-code";
const SELECT_TEXT = "Private Choice";
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
  spool = undefined;
  fixture = undefined;
  modelServer = undefined;
});

describe("production valueRef browser execution", () => {
  it("runs immutable input/select Plan jobs through RunnerOfferRuntime without plaintext leakage", async () => {
    fixture = await startFixtureServer({
      "/": htmlDocument(`
        <label>Notes <textarea aria-label="Notes"></textarea></label>
        <label>Country
          <select aria-label="Country">
            <option value="">Choose a country</option>
            <option value="${SELECT_VALUE}">${SELECT_TEXT}</option>
          </select>
        </label>
        <p data-qualigence-observe id="equal-text">${INPUT_EQUAL_TEXT}</p>
        <p data-qualigence-observe id="status">Waiting</p>
        <script>
          const notes = document.querySelector('textarea');
          const country = document.querySelector('select');
          const status = document.getElementById('status');
          notes.addEventListener('input', () => { status.textContent = 'Notes ready'; });
          country.addEventListener('change', () => { status.textContent = 'Country ready'; });
        </script>
      `, "ValueRef acceptance"),
    });

    const root = await mkdtemp(join(tmpdir(), "qualigence-value-ref-e2e-"));
    roots.push(root);
    await writeFile(join(root, "email.txt"), INPUT_VALUE, { mode: 0o600 });
    await writeFile(join(root, "country.txt"), SELECT_VALUE, { mode: 0o600 });
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
        readonly messages: readonly { readonly content: string }[];
        readonly response_format: { readonly json_schema: { readonly name: string } };
      };
      modelRequests.push(body);
      const operation = body.response_format.json_schema.name;
      const output = operation === "execution_verification"
        ? { status: "passed", summary: "visible state captured", claims: [] }
        : decisionFrom(body.messages.at(-1)?.content ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: `chatcmpl-${modelRequests.length}`,
        model: "ticket-18-model",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }));
    });
    modelServer.listen(0, "127.0.0.1");
    await once(modelServer, "listening");
    const modelAddress = modelServer.address();
    if (modelAddress === null || typeof modelAddress === "string") throw new Error("Expected model listener.");

    const logs: string[] = [];
    const batches: ExecutionEventBatch[] = [];
    const spooledEvents: ExecutionEventBatch["events"][number][] = [];
    const completions: ExecutionCompletion[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const session: RunnerSession = {
      welcome: {
        sessionId: "session-value-ref",
        resumeToken: "resume-value-ref",
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
      accept: async (offerId: string): Promise<ExecutionJobLease> => ({
        jobId: offerId.replace("offer", "job"),
        runId: offerId.replace("offer", "run"),
        leaseToken: `lease-${offerId}`,
        leaseEpoch: 1,
        expiresAt: "2099-08-21T00:00:00.000Z",
      }),
      renew: async () => { throw new Error("Unexpected lease renewal"); },
      submit: async (batch: ExecutionEventBatch) => {
        spooledEvents.push(...await spool!.pending(batch.runId, batch.firstSequenceNumber, {
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
      complete: async (_lease: ExecutionJobLease, completion: ExecutionCompletion) => { completions.push(completion); },
      close: async () => undefined,
    };
    const config: RunnerConfig = {
      runnerId: "runner-value-ref",
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
        modelName: "ticket-18-model",
        maximumTokensPerCall: 100,
      },
    };
    const runtime = new RunnerOfferRuntime({
      config,
      session,
      spool,
      valueProvider,
    });

    try {
      await runtime.run(offer("input", "profile.email", "Notes", "textbox"));
      await runtime.run(offer("select", "profile.country", "Country", "combobox"));
    } catch (error) {
      if (error instanceof Error && /browser.*(launch|executable)/i.test(error.message)) {
        throw new Error("ChromiumUnavailable", { cause: error });
      }
      throw error;
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }

    expect(completions).toEqual([
      { jobId: "job-input", runId: "run-input", status: "passed" },
      { jobId: "job-select", runId: "run-select", status: "passed" },
    ]);
    const trace = batches.flatMap((batch) => batch.events);
    expect(trace.filter((event) => event.stage === "run_completed")).toHaveLength(2);
    expect(trace.find((event) => event.runId === "run-input" && event.stage === "decision")?.payload)
      .toMatchObject({ kind: "input", valueRef: "profile.email" });
    expect(trace.find((event) => event.runId === "run-select" && event.stage === "decision")?.payload)
      .toMatchObject({ kind: "select", valueRef: "profile.country" });
    const inputObservation = finalObservation(trace, "run-input");
    const selectObservation = finalObservation(trace, "run-select");
    expect(inputObservation.nodes.some((node) => node.name === "Notes ready" || node.value === "Notes ready")).toBe(true);
    expect(selectObservation.nodes.some((node) => node.name === "Country ready" || node.value === "Country ready")).toBe(true);
    expect(inputObservation.nodes.some((node) => node.name === INPUT_EQUAL_TEXT || node.value === INPUT_EQUAL_TEXT)).toBe(true);
    expect(targetNode(inputObservation, "textbox", "Notes")).toMatchObject({ value: "[redacted]" });
    expect(targetNode(selectObservation, "combobox", "Country")).toMatchObject({
      text: "[redacted]",
      value: "[redacted]",
    });

    const preAckInputObservation = finalObservation(spooledEvents, "run-input");
    const preAckSelectObservation = finalObservation(spooledEvents, "run-select");
    expect(preAckInputObservation.nodes.some((node) => node.name === INPUT_EQUAL_TEXT || node.value === INPUT_EQUAL_TEXT)).toBe(true);
    expect(targetNode(preAckInputObservation, "textbox", "Notes")).toMatchObject({ value: "[redacted]" });
    expect(targetNode(preAckSelectObservation, "combobox", "Country")).toMatchObject({
      text: "[redacted]",
      value: "[redacted]",
    });

    await spool.close();
    spool = undefined;
    const spoolText = (await readFile(spoolFile)).toString("utf8");
    expect(JSON.stringify(logs)).not.toContain(INPUT_VALUE);
    expect(JSON.stringify(logs)).not.toContain(INPUT_BROWSER_VALUE);
    expect(JSON.stringify(logs)).not.toContain(SELECT_VALUE);
    expect(JSON.stringify(logs)).not.toContain(SELECT_TEXT);
    expect(spoolText).toContain("[redacted]");
    expect(spoolText).toContain(INPUT_EQUAL_TEXT);
    expect(spoolText).not.toContain(`\"value\":${JSON.stringify(INPUT_VALUE)}`);
    expect(spoolText).not.toContain(`\"value\":${JSON.stringify(INPUT_BROWSER_VALUE)}`);
    expect(spoolText).not.toContain(`\"value\":${JSON.stringify(SELECT_VALUE)}`);
    expect(spoolText).not.toContain(`\"text\":${JSON.stringify(SELECT_TEXT)}`);
    expect(spoolText).not.toContain(`\"name\":${JSON.stringify(SELECT_TEXT)}`);
  }, 60_000);
});

function offer(
  kind: "input" | "select",
  valueRef: string,
  name: string,
  role: string,
): ExecutionJobOffer {
  const step = {
    stepIndex: 0,
    kind,
    target: { role, name, purpose: `exercise ${kind}` },
    valueRef,
  } as const satisfies ExecutionPlanStep;
  return {
    offerId: `offer-${kind}`,
    job: {
      jobId: `job-${kind}`,
      runId: `run-${kind}`,
      projectId: "project-value-ref-e2e",
      target: { kind: "web", url: fixture!.url },
      objective: `Exercise ${kind} through a valueRef`,
      policy: {
        policyId: `policy-${kind}`,
        environment: "isolated_test",
        allowedOrigins: [fixture!.origin],
        allowedActionKinds: [kind],
        maximumRisk: "ExternalSideEffect",
        explorationAllowed: false,
        issuedAt: "2026-08-21T00:00:00.000Z",
        expiresAt: "2099-08-21T00:00:00.000Z",
      },
      plan: {
        missionId: "mission-1",
        missionRevision: 1,
        testCaseId: `case-${kind}`,
        steps: [step],
        expectedClaimIds: ["claim-1"],
        budget: { maximumStepsPerJob: 1, maximumWallClockMs: 20_000, maximumModelTokens: 100 },
      },
    },
    requiredCapabilities: ["target:web-playwright", ...WEB_OBSERVATION_V1_CAPABILITY_TOKENS, `action:${kind}`],
    leaseDurationMs: 60_000,
  };
}

function decisionFrom(content: string): { readonly nodeId: string; readonly reason: string } {
  const prompt = JSON.parse(content) as {
    readonly step: Extract<ExecutionPlanStep, { readonly kind: "input" | "select" }>;
    readonly observation: ObservationGraphV1;
  };
  if (prompt.step.kind !== "input" && prompt.step.kind !== "select") throw new Error("Unexpected Plan step.");
  const node = prompt.observation.nodes.find((candidate) =>
    candidate.role === prompt.step.target.role && candidate.name === prompt.step.target.name);
  if (node === undefined) throw new Error("Expected model-visible Plan target.");
  return { nodeId: node.id, reason: `ground ${prompt.step.kind}` };
}

function finalObservation(
  trace: readonly ExecutionEventBatch["events"][number][],
  runId: string,
): ObservationGraphV1 {
  const event = trace.filter((candidate) => candidate.runId === runId && candidate.stage === "observation").at(-1);
  if (event?.stage !== "observation") throw new Error(`Missing final observation for ${runId}.`);
  return event.payload;
}

function targetNode(graph: ObservationGraphV1, role: string, name: string): ObservationGraphV1["nodes"][number] {
  const node = graph.nodes.find((candidate) => candidate.role === role && candidate.name === name);
  if (node === undefined) throw new Error(`Missing ${role} ${name} node.`);
  return node;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
