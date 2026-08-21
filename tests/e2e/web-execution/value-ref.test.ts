import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExecutionJobLease,
  ExecutionCompletion,
  ExecutionEventBatch,
  ExecutionJobOffer,
  ExecutionPlanStep,
  ObservationGraph,
} from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import { SqliteRunnerSpool } from "@qualigence/runner-spool";
import {
  PlaywrightWebTargetAdapter,
  type CapturedArtifact,
  type PlaywrightWebTargetOptions,
} from "@qualigence/web-playwright";
import { FileActionValueProvider } from "../../../apps/runner/src/action-value-provider.js";
import type { RunnerConfig } from "../../../apps/runner/src/config.js";
import { RunnerOfferRuntime } from "../../../apps/runner/src/offer-runtime.js";
import { htmlDocument, startFixtureServer, type FixtureServer } from "../../component/web-execution/fixtures.js";

const LF_INPUT_VALUE = "e2e-lf-first-line\ne2e-lf-second-line\n";
const CRLF_INPUT_VALUE = "a\r\nb\r\n";
const CRLF_BROWSER_VALUE = "ab";
const SELECT_VALUE = "e2e-private-country-code";
const SELECT_LABEL_SOURCE = "e2e-private-country\r\n    normalized-label";
const SELECT_LABEL_BROWSER_VALUE = "e2e-private-country normalized-label";
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
        <style>
          #lf-secret { position:fixed;left:40px;top:40px;width:200px;height:40px;padding:0;border:0;background:rgb(255,0,0) }
          #crlf-secret { position:fixed;left:40px;top:100px;width:200px;height:40px;padding:0;border:0;background:rgb(255,0,0) }
          #country-secret { position:fixed;left:40px;top:160px;width:200px;height:40px;padding:0;border:0;background:rgb(255,0,0) }
          #unrelated-region { position:fixed;left:300px;top:100px;width:80px;height:80px;background:rgb(0,255,0) }
        </style>
        <label>LF secret <textarea id="lf-secret" aria-label="LF secret"></textarea></label>
        <label>CRLF secret <input id="crlf-secret" aria-label="CRLF secret" /></label>
        <label>Country
          <select id="country-secret" aria-label="Country">
            <option value="">Choose a country</option>
            <option value="${SELECT_VALUE}">${SELECT_LABEL_SOURCE}</option>
          </select>
        </label>
        <p data-qualigence-observe id="status">Waiting</p>
        <p data-qualigence-observe>e2e-lf-first-line remains unrelated</p>
        <p data-qualigence-observe>ab</p>
        <div id="unrelated-region"></div>
        <script>
          const lfInput = document.querySelector('textarea');
          const crlfInput = document.querySelector('input');
          const country = document.querySelector('select');
          const status = document.getElementById('status');
          lfInput.addEventListener('input', () => { status.textContent = 'LF ready'; });
          crlfInput.addEventListener('input', () => {
            crlfInput.setAttribute('aria-label', crlfInput.value);
            status.textContent = 'CRLF ready';
          });
          country.addEventListener('change', () => {
            country.setAttribute('aria-label', country.selectedOptions[0].textContent);
            status.textContent = 'Country ready';
          });
        </script>
      `, "ValueRef acceptance"),
    });

    const root = await mkdtemp(join(tmpdir(), "qualigence-value-ref-e2e-"));
    roots.push(root);
    await writeFile(join(root, "lf-input.txt"), LF_INPUT_VALUE, { mode: 0o600 });
    await writeFile(join(root, "crlf-input.txt"), CRLF_INPUT_VALUE, { mode: 0o600 });
    await writeFile(join(root, "country.txt"), SELECT_VALUE, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(join(root, "lf-input.txt"), 0o600);
      await chmod(join(root, "crlf-input.txt"), 0o600);
      await chmod(join(root, "country.txt"), 0o600);
    }
    const configFile = join(root, "values.json");
    await writeFile(configFile, JSON.stringify({
      "profile.lf": "lf-input.txt",
      "profile.crlf": "crlf-input.txt",
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
        ? verificationFrom(body.messages.at(-1)?.content ?? "")
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
    const artifacts: { readonly runId: string; readonly artifact: CapturedArtifact }[] = [];
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
      createTarget: (options: PlaywrightWebTargetOptions) => {
        const adapter = new PlaywrightWebTargetAdapter(options);
        const capture = adapter.capture.bind(adapter);
        adapter.capture = async (job) => {
          const graph = await capture(job);
          for (const artifact of await adapter.captureArtifacts(graph.graphId)) {
            artifacts.push({ runId: job.runId, artifact });
          }
          return graph;
        };
        return adapter;
      },
    });

    try {
      await runtime.run(offer("input-lf", "input", "profile.lf", "LF secret", "textbox"));
      await runtime.run(offer("input-crlf", "input", "profile.crlf", "CRLF secret", "textbox"));
      await runtime.run(offer("select", "select", "profile.country", "Country", "combobox"));
    } catch (error) {
      if (error instanceof Error && /browser.*(launch|executable)/i.test(error.message)) {
        throw new Error("ChromiumUnavailable", { cause: error });
      }
      throw error;
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }

    expect(completions.slice(0, 2)).toEqual([
      { jobId: "job-input-lf", runId: "run-input-lf", status: "passed" },
      { jobId: "job-input-crlf", runId: "run-input-crlf", status: "passed" },
    ]);
    expect(completions[2]).toMatchObject({
      jobId: "job-select",
      runId: "run-select",
      status: "finding",
      finding: { summary: "selected state requires review" },
    });
    const trace = batches.flatMap((batch) => batch.events);
    expect(trace.filter((event) => event.stage === "run_completed")).toHaveLength(3);
    expect(trace.find((event) => event.runId === "run-input-lf" && event.stage === "decision")?.payload)
      .toMatchObject({ kind: "input", valueRef: "profile.lf" });
    expect(trace.find((event) => event.runId === "run-input-crlf" && event.stage === "decision")?.payload)
      .toMatchObject({ kind: "input", valueRef: "profile.crlf" });
    expect(trace.find((event) => event.runId === "run-select" && event.stage === "decision")?.payload)
      .toMatchObject({ kind: "select", valueRef: "profile.country" });
    expect(finalObservation(trace, "run-input-lf").nodes.some((node) => node.text === "LF ready")).toBe(true);
    expect(finalObservation(trace, "run-input-crlf").nodes.some((node) => node.text === "CRLF ready")).toBe(true);
    expect(nodeNamed(finalObservation(trace, "run-input-crlf"), "[REDACTED]"))
      .toMatchObject({ name: "[REDACTED]", value: "[REDACTED]", text: "[REDACTED]" });
    expect(nodeNamed(finalObservation(trace, "run-select"), "[REDACTED]"))
      .toMatchObject({ name: "[REDACTED]", value: "[REDACTED]", text: "[REDACTED]" });
    expect(finalObservation(trace, "run-input-lf").nodes.some((node) =>
      node.text === "e2e-lf-first-line remains unrelated")).toBe(true);
    expect(finalObservation(trace, "run-input-crlf").nodes.some((node) => node.text === "ab")).toBe(true);
    expect(trace.some((event) => event.runId === "run-select" && event.stage === "finding")).toBe(true);

    const observationArtifacts = artifacts
      .filter(({ artifact }) => artifact.mediaType === "application/json")
      .map(({ artifact }) => new TextDecoder().decode(artifact.bytes));
    const screenshotMetadata = artifacts
      .filter(({ artifact }) => artifact.mediaType === "image/png")
      .map(({ runId, artifact }) => ({ runId, name: artifact.name, mediaType: artifact.mediaType }));
    expect(observationArtifacts).toHaveLength(6);
    expect(screenshotMetadata).toHaveLength(6);
    const parsedObservationArtifacts = observationArtifacts.map((artifact) =>
      JSON.parse(artifact) as ObservationGraph);
    const crlfArtifact = parsedObservationArtifacts.find((graph) =>
      graph.graphId === finalObservation(trace, "run-input-crlf").graphId);
    const selectArtifact = parsedObservationArtifacts.find((graph) =>
      graph.graphId === finalObservation(trace, "run-select").graphId);
    expect(crlfArtifact).toBeDefined();
    expect(selectArtifact).toBeDefined();
    expect(nodeNamed(crlfArtifact!, "[REDACTED]"))
      .toMatchObject({ name: "[REDACTED]", value: "[REDACTED]", text: "[REDACTED]" });
    expect(nodeNamed(selectArtifact!, "[REDACTED]"))
      .toMatchObject({ name: "[REDACTED]", value: "[REDACTED]", text: "[REDACTED]" });
    expect(crlfArtifact!.nodes.some((node) => node.text === CRLF_BROWSER_VALUE)).toBe(true);

    const finalScreenshots = new Map(screenshotMetadata.map(({ runId, name }) => {
      const screenshot = artifacts.find(({ runId: candidateRunId, artifact }) =>
        candidateRunId === runId && artifact.name === name);
      return [runId, screenshot?.artifact.bytes] as const;
    }));
    for (const [runId, target] of [
      ["run-input-lf", { x: 140, y: 60 }],
      ["run-input-crlf", { x: 140, y: 120 }],
      ["run-select", { x: 140, y: 180 }],
    ] as const) {
      const screenshot = finalScreenshots.get(runId);
      if (screenshot === undefined) throw new Error(`Missing final screenshot for ${runId}.`);
      expect(pngPixel(screenshot, target.x, target.y)).toEqual([0, 0, 0, 255]);
      expect(pngPixel(screenshot, 340, 140)).toEqual([0, 255, 0, 255]);
    }

    await spool.close();
    spool = undefined;
    const spoolBytes = await readFile(spoolFile);
    const securitySurfaces = {
      trace: JSON.stringify(trace),
      findings: JSON.stringify({
        events: trace.filter((event) => event.stage === "finding"),
        completions: completions.filter((completion) => completion.status === "finding"),
      }),
      observationArtifacts: observationArtifacts.join("\n"),
      screenshotMetadata: JSON.stringify(screenshotMetadata),
      logs: logs.join(""),
      dtos: JSON.stringify({ batches, completions, modelRequests }),
      spooledEvents: JSON.stringify(spooledEvents),
      durableSpool: spoolBytes.toString("utf8"),
    };
    const sensitiveForms = [
      LF_INPUT_VALUE,
      CRLF_INPUT_VALUE,
      SELECT_VALUE,
      SELECT_LABEL_SOURCE,
      SELECT_LABEL_BROWSER_VALUE,
    ];
    for (const surface of Object.values(securitySurfaces)) {
      for (const form of sensitiveForms) {
        expect(surface).not.toContain(form);
        expect(surface).not.toContain(JSON.stringify(form).slice(1, -1));
      }
    }
  }, 60_000);
});

function nodeNamed(graph: ObservationGraph, name: string) {
  const node = graph.nodes.find((candidate) => candidate.name === name);
  if (node === undefined) throw new Error(`Expected node named ${name}.`);
  return node;
}

function offer(
  id: string,
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
    offerId: `offer-${id}`,
    job: {
      jobId: `job-${id}`,
      runId: `run-${id}`,
      projectId: "project-value-ref-e2e",
      target: { kind: "web", url: fixture!.url },
      objective: `Exercise ${kind} through a valueRef`,
      policy: {
        policyId: `policy-${id}`,
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
        testCaseId: `case-${id}`,
        steps: [step],
        expectedClaimIds: ["claim-1"],
        budget: { maximumStepsPerJob: 1, maximumWallClockMs: 20_000, maximumModelTokens: 100 },
      },
    },
    requiredCapabilities: [`action:${kind}`],
    leaseDurationMs: 60_000,
  };
}

function decisionFrom(content: string): { readonly nodeId: string; readonly reason: string } {
  const prompt = JSON.parse(content) as {
    readonly step: Extract<ExecutionPlanStep, { readonly kind: "input" | "select" }>;
    readonly observation: ObservationGraph;
  };
  if (prompt.step.kind !== "input" && prompt.step.kind !== "select") throw new Error("Unexpected Plan step.");
  const node = prompt.observation.nodes.find((candidate) =>
    candidate.role === prompt.step.target.role && candidate.name === prompt.step.target.name);
  if (node === undefined) throw new Error("Expected model-visible Plan target.");
  return { nodeId: node.id, reason: `ground ${prompt.step.kind}` };
}

function verificationFrom(content: string) {
  const prompt = JSON.parse(content) as {
    readonly before: ObservationGraph;
    readonly after: ObservationGraph;
  };
  if (!prompt.after.graphId.startsWith("run-select:")) {
    return { status: "passed", summary: "visible state captured", claims: [] } as const;
  }
  const expected = prompt.before.nodes.find((node) => node.text !== undefined);
  const observed = prompt.after.nodes.find((node) => node.text !== undefined);
  if (expected?.text === undefined || observed?.text === undefined) {
    throw new Error("Expected model-visible verification evidence.");
  }
  return {
    status: "failed",
    summary: "selected state requires review",
    severitySuggestion: "low",
    claims: [{
      expected: { graphId: prompt.before.graphId, nodeId: expected.id, text: expected.text },
      observed: { graphId: prompt.after.graphId, nodeId: observed.id, text: observed.text },
    }],
  } as const;
}

function finalObservation(
  trace: readonly ExecutionEventBatch["events"][number][],
  runId: string,
): ObservationGraph {
  const event = trace.filter((candidate) => candidate.runId === runId && candidate.stage === "observation").at(-1);
  if (event?.stage !== "observation") throw new Error(`Missing final observation for ${runId}.`);
  return event.payload;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function pngPixel(bytes: Uint8Array, x: number, y: number): readonly number[] {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => bytes[index] === byte)) throw new Error("Invalid PNG signature.");
  let width = 0;
  let height = 0;
  let colorType = -1;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const length = view.getUint32(0);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      if (data[8] !== 8 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("Unsupported PNG encoding.");
      }
      colorType = data[9]!;
    } else if (type === "IDAT") {
      compressed.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0 || x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error("Unsupported PNG pixel request.");
  }
  const filtered = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[sourceOffset++]!;
    const rowOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = filtered[sourceOffset++]!;
      const left = column >= channels ? pixels[rowOffset + column - channels]! : 0;
      const above = row > 0 ? pixels[rowOffset - stride + column]! : 0;
      const upperLeft = row > 0 && column >= channels
        ? pixels[rowOffset - stride + column - channels]!
        : 0;
      pixels[rowOffset + column] = (raw + pngFilterDelta(filter, left, above, upperLeft)) & 0xff;
    }
  }
  const pixelOffset = y * stride + x * channels;
  return [
    pixels[pixelOffset]!,
    pixels[pixelOffset + 1]!,
    pixels[pixelOffset + 2]!,
    channels === 4 ? pixels[pixelOffset + 3]! : 255,
  ];
}

function pngFilterDelta(filter: number, left: number, above: number, upperLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return above;
  if (filter === 3) return Math.floor((left + above) / 2);
  if (filter !== 4) throw new Error(`Unsupported PNG filter ${filter}.`);
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance ? above : upperLeft;
}
