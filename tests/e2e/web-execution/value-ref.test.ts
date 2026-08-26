import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { inflateSync } from "node:zlib";
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
import { AesGcmSpoolCrypto, SqliteRunnerSpool } from "@qualigence/runner-spool";
import { PlaywrightWebTargetAdapter, type CapturedArtifact } from "@qualigence/web-playwright";
import {
  PlaywrightObserver,
  type PlaywrightBrowserSession,
  type PlaywrightObserverHooks,
} from "@qualigence/web-playwright/internal";
import { FileActionValueProvider } from "../../../apps/runner/src/action-value-provider.js";
import type { RunnerConfig } from "../../../apps/runner/src/config.js";
import { RunnerOfferRuntime } from "../../../apps/runner/src/offer-runtime.js";
import { htmlDocument, startFixtureServer, type FixtureServer } from "../../component/web-execution/fixtures.js";
import { SENSITIVE_SHADOW_ROOTS_PROPERTY } from "../../../packages/target-adapters/web-playwright/src/sensitive-evidence-authority.js";

const INPUT_VALUE = "alpha\nbeta\r\ngamma\n";
const INPUT_BROWSER_VALUE = "alpha\nbeta\ngamma\n";
const INPUT_EQUAL_TEXT = "alpha beta gamma";
const SELECT_VALUE = "e2e-private-country-code";
const SELECT_TEXT = "Private Choice";
const PROMISE_OWNER_SECRET = "ticket-43-private-owner-value";
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


type Ticket43PromiseOwnerBoundary = "graph" | "artifact";

interface Ticket43OwnerSummary {
  readonly count: number;
  readonly hasPromisePrototype: boolean;
  readonly hasTrackedReceiver: boolean;
  readonly hasTrackedPrototype: boolean;
  readonly hasCustomReceiver: boolean;
  readonly hasCustomThenOwner: boolean;
  readonly trackedPrototypeThenKind: string;
  readonly trackedReceiverThenOwner: string;
}

interface Ticket43NativeSnapshot {
  readonly phase: "mutated";
  readonly boundary: Ticket43PromiseOwnerBoundary;
  readonly callbackRuns: readonly string[];
  readonly statusText: string;
  readonly title: string;
  readonly summary: Ticket43OwnerSummary;
  readonly mutations: {
    readonly descriptorMutated: boolean;
    readonly descriptorRestored: boolean;
    readonly prototypeMutated: boolean;
    readonly prototypeRestored: boolean;
    readonly reRegistrationRuns: readonly string[];
  };
}

interface HookedAdapterInternals {
  readonly session: PlaywrightBrowserSession;
  observer: PlaywrightObserver;
}

class HookedWebTargetAdapter extends PlaywrightWebTargetAdapter {
  constructor(
    options: ConstructorParameters<typeof PlaywrightWebTargetAdapter>[0],
    hooks: PlaywrightObserverHooks,
  ) {
    super(options);
    const internals = this as unknown as HookedAdapterInternals;
    internals.observer = new PlaywrightObserver(internals.session, hooks);
  }
}

describe("production valueRef browser execution", () => {
  it("runs immutable input/select Plan jobs through RunnerOfferRuntime without plaintext leakage", async () => {
    fixture = await startFixtureServer({
      "/": htmlDocument(`
        <style>
          html, body { margin: 0; width: 520px; height: 260px; font: 16px sans-serif; }
          label { display: block; margin-left: 20px; }
          label:first-of-type { margin-top: 170px; }
          #input-reflection, #select-reflection, #equal-text {
            position: absolute;
            left: 20px;
            width: 260px;
            height: 32px;
            margin: 0;
            color: white;
            font: 16px sans-serif;
          }
          #input-reflection { top: 20px; background: rgb(250, 250, 250); }
          #select-reflection { top: 70px; background: rgb(250, 250, 250); }
          #equal-text { top: 120px; background: rgb(123, 45, 67); }
        </style>
        <label>Notes <textarea aria-label="Notes"></textarea></label>
        <label>Country
          <select aria-label="Country">
            <option value="">Choose a country</option>
            <option value="${SELECT_VALUE}">${SELECT_TEXT}</option>
          </select>
        </label>
        <p data-qualigence-observe id="equal-text">${INPUT_EQUAL_TEXT}</p>
        <p data-qualigence-observe id="status">Waiting</p>
        <p data-qualigence-observe id="input-reflection">Input mirror pending</p>
        <p data-qualigence-observe id="select-reflection">Select mirror pending</p>
        <script>
          const notes = document.querySelector('textarea');
          const country = document.querySelector('select');
          const status = document.getElementById('status');
          notes.addEventListener('input', () => {
            status.textContent = 'Notes ready';
            document.title = notes.value;
            document.getElementById('input-reflection').textContent = notes.value;
          });
          country.addEventListener('change', () => {
            status.textContent = 'Country ready';
            document.title = country.selectedOptions[0].text;
            document.getElementById('select-reflection').textContent = country.selectedOptions[0].text;
          });
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
    spool = await SqliteRunnerSpool.open({
      databaseFile: spoolFile,
      crypto: new AesGcmSpoolCrypto(randomBytes(32)),
    });

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
    const capturedArtifacts = new Map<string, readonly CapturedArtifact[]>();
    class ArtifactCapturingWebTargetAdapter extends PlaywrightWebTargetAdapter {
      override async capture(job: ExecutionJobOffer["job"], signal?: AbortSignal): Promise<ObservationGraphV1> {
        const graph = await super.capture(job, signal);
        capturedArtifacts.set(graph.graphId, await super.captureArtifacts(graph.graphId));
        return graph;
      }
    }

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
      createTarget: (targetOptions) => new ArtifactCapturingWebTargetAdapter(targetOptions),
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
    expect(inputObservation.extensions?.["web/v1"]?.payload).toMatchObject({ title: "[redacted]" });
    expect(inputObservation.nodes.some((node) => node.name === "[redacted]" || node.value === "[redacted]")).toBe(true);
    const selectTarget = targetNode(selectObservation, "combobox", "Country");
    expect(selectTarget).toMatchObject({ value: "[redacted]" });
    expect(selectObservation.extensions?.["web/v1"]?.payload).toMatchObject({ title: "[redacted]" });
    expect(JSON.stringify(selectObservation)).not.toContain(SELECT_TEXT);
    expect(selectObservation.nodes.filter((node) => node.name === "[redacted]" || node.value === "[redacted]").length).toBeGreaterThanOrEqual(2);

    const inputArtifacts = artifactsForGraph(capturedArtifacts, inputObservation.graphId);
    const selectArtifacts = artifactsForGraph(capturedArtifacts, selectObservation.graphId);
    assertArtifactJsonRedacted(inputArtifacts, [INPUT_VALUE, INPUT_BROWSER_VALUE, SELECT_VALUE, SELECT_TEXT], ["[redacted]", INPUT_EQUAL_TEXT]);
    assertArtifactJsonRedacted(selectArtifacts, [INPUT_VALUE, INPUT_BROWSER_VALUE, SELECT_VALUE, SELECT_TEXT], ["[redacted]", INPUT_EQUAL_TEXT]);
    const [inputMirrorPixel, inputEqualPixel] = await samplePngPixels(pngArtifact(inputArtifacts).bytes, [
      [250, 30],
      [250, 130],
    ]);
    expect(inputMirrorPixel).toEqual([0, 0, 0, 255]);
    expect(inputEqualPixel).toEqual([123, 45, 67, 255]);
    const [selectMirrorPixel, selectEqualPixel] = await samplePngPixels(pngArtifact(selectArtifacts).bytes, [
      [250, 80],
      [250, 130],
    ]);
    expect(selectMirrorPixel).toEqual([0, 0, 0, 255]);
    expect(selectEqualPixel).toEqual([123, 45, 67, 255]);

    const preAckInputObservation = finalObservation(spooledEvents, "run-input");
    const preAckSelectObservation = finalObservation(spooledEvents, "run-select");
    expect(preAckInputObservation.nodes.some((node) => node.name === INPUT_EQUAL_TEXT || node.value === INPUT_EQUAL_TEXT)).toBe(true);
    expect(targetNode(preAckInputObservation, "textbox", "Notes")).toMatchObject({ value: "[redacted]" });
    expect(preAckInputObservation.extensions?.["web/v1"]?.payload).toMatchObject({ title: "[redacted]" });
    expect(preAckInputObservation.nodes.some((node) => node.name === "[redacted]" || node.value === "[redacted]")).toBe(true);
    const preAckSelectTarget = targetNode(preAckSelectObservation, "combobox", "Country");
    expect(preAckSelectTarget).toMatchObject({ value: "[redacted]" });
    expect(preAckSelectObservation.extensions?.["web/v1"]?.payload).toMatchObject({ title: "[redacted]" });
    expect(JSON.stringify(preAckSelectObservation)).not.toContain(SELECT_TEXT);
    expect(preAckSelectObservation.nodes.filter((node) => node.name === "[redacted]" || node.value === "[redacted]").length).toBeGreaterThanOrEqual(2);

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
    expect(spoolText).not.toContain(`\"text\":${JSON.stringify(INPUT_BROWSER_VALUE)}`);
    expect(spoolText).not.toContain(`\"name\":${JSON.stringify(INPUT_BROWSER_VALUE)}`);
  }, 60_000);

  it("fails closed when Promise owner descriptors/prototypes mutate, restore, and re-register at capture boundaries", async () => {
    fixture = await startFixtureServer({
      "/": htmlDocument(`
        <style>
          html, body { margin: 0; width: 520px; height: 260px; font: 16px sans-serif; }
          label { display: block; margin: 24px; }
          #owner-status { margin: 24px; }
        </style>
        <label>Secret <textarea aria-label="Secret"></textarea></label>
        <p data-qualigence-observe id="owner-status">Waiting for owner callbacks</p>
        <script>
          const secret = document.querySelector('textarea');
          const status = document.getElementById('owner-status');
          secret.addEventListener('input', () => {
            document.title = 'owner callbacks running';
            globalThis.__ticket43NativeDone = exerciseTicket43PromiseOwners(secret.value)
              .catch((error) => {
                globalThis.__ticket43NativeError = String(error && error.message ? error.message : error);
                throw error;
              });
          });

          async function exerciseTicket43PromiseOwners(value) {
            const callbackRuns = [];
            const trackedReceiver = Promise.resolve('tracked-receiver:' + value.length);
            const trackedPrototype = Object.create(Promise.prototype);
            Object.defineProperty(trackedPrototype, 'then', {
              configurable: true,
              enumerable: false,
              writable: true,
              value: Promise.prototype.then,
            });
            const customReceiver = Promise.resolve('custom-receiver');
            Object.setPrototypeOf(customReceiver, trackedPrototype);
            const customThenOwner = {
              then(onfulfilled) {
                callbackRuns.push('custom-then-owner');
                if (typeof onfulfilled === 'function') onfulfilled('custom-owner-value');
                return 'custom-owner-return';
              },
            };
            globalThis.__ticket43TrackedReceiver = trackedReceiver;
            globalThis.__ticket43TrackedPrototype = trackedPrototype;
            globalThis.__ticket43CustomReceiver = customReceiver;
            globalThis.__ticket43CustomThenOwner = customThenOwner;

            const customReturn = Promise.prototype.catch.call(customThenOwner, () => 'handled');
            const callbacks = [
              trackedReceiver.then((resolved) => {
                callbackRuns.push('receiver-then:' + resolved);
                return resolved;
              }),
              Promise.reject('native-catch').catch((reason) => {
                callbackRuns.push('prototype-catch:' + reason);
                return 'handled';
              }),
              Promise.resolve('native-finally').finally(() => {
                callbackRuns.push('prototype-finally');
              }),
              Promise.prototype.then.call(customReceiver, (resolved) => {
                callbackRuns.push('tracked-prototype-then:' + resolved);
                return resolved;
              }),
            ];
            await Promise.all(callbacks);
            callbackRuns.push('custom-return:' + customReturn);
            globalThis.__ticket43NativeCallbacks = callbackRuns;
            globalThis.__ticket43OwnerSummary = summarizeTicket43Owners();
            document.title = 'owner callbacks complete';
            status.textContent = 'Promise owner callbacks ready: ' + callbackRuns.join('|');
          }

          function summarizeTicket43Owners() {
            const registry = globalThis.__qualigenceSensitiveShadowRoots;
            const owners = registry && Array.isArray(registry.promiseOwners) ? registry.promiseOwners : [];
            const trackedReceiver = globalThis.__ticket43TrackedReceiver;
            const trackedPrototype = globalThis.__ticket43TrackedPrototype;
            const customReceiver = globalThis.__ticket43CustomReceiver;
            const customThenOwner = globalThis.__ticket43CustomThenOwner;
            const trackedReceiverRecord = owners.find((record) => record.owner === trackedReceiver);
            const trackedPrototypeRecord = owners.find((record) => record.owner === trackedPrototype);
            const thenOwner = trackedReceiverRecord && trackedReceiverRecord.resolvedMethodOwners.then.owner;
            return {
              count: owners.length,
              hasPromisePrototype: owners.some((record) => record.owner === Promise.prototype),
              hasTrackedReceiver: trackedReceiverRecord !== undefined,
              hasTrackedPrototype: trackedPrototypeRecord !== undefined,
              hasCustomReceiver: owners.some((record) => record.owner === customReceiver),
              hasCustomThenOwner: owners.some((record) => record.owner === customThenOwner),
              trackedPrototypeThenKind: trackedPrototypeRecord && trackedPrototypeRecord.descriptors.then.kind || 'missing',
              trackedReceiverThenOwner: thenOwner === Promise.prototype
                ? 'Promise.prototype'
                : thenOwner === trackedPrototype
                  ? 'trackedPrototype'
                  : 'other',
            };
          }
        </script>
      `, "Ticket 43 Promise owner E2E"),
    });

    const root = await mkdtemp(join(tmpdir(), "qualigence-ticket43-e2e-"));
    roots.push(root);
    await writeFile(join(root, "secret.txt"), PROMISE_OWNER_SECRET, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(join(root, "secret.txt"), 0o600);
    }
    const configFile = join(root, "values.json");
    await writeFile(configFile, JSON.stringify({ "profile.promiseOwnerSecret": "secret.txt" }));
    const valueProvider = await FileActionValueProvider.open({ root, configFile });
    const spoolFile = join(root, "runner-spool.db");
    spool = await SqliteRunnerSpool.open({
      databaseFile: spoolFile,
      crypto: new AesGcmSpoolCrypto(randomBytes(32)),
    });

    modelServer = createServer(async (request, response) => {
      const body = JSON.parse(await readBody(request)) as {
        readonly messages: readonly { readonly content: string }[];
        readonly response_format: { readonly json_schema: { readonly name: string } };
      };
      const operation = body.response_format.json_schema.name;
      const output = operation === "execution_verification"
        ? { status: "passed", summary: "not expected after failed revalidation", claims: [] }
        : decisionFrom(body.messages.at(-1)?.content ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: `chatcmpl-ticket43-${Date.now()}`,
        model: "ticket-43-model",
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
    const nativeSnapshots: Ticket43NativeSnapshot[] = [];
    const capturedGraphs: { readonly runId: string; readonly graphId: string; readonly artifacts: readonly CapturedArtifact[] }[] = [];
    const mutationBoundaryByRun = new Map<string, Ticket43PromiseOwnerBoundary>([
      ["run-ticket43-graph", "graph"],
      ["run-ticket43-artifact", "artifact"],
    ]);
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
        sessionId: "session-ticket43-owner-e2e",
        resumeToken: "resume-ticket43-owner-e2e",
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

    let currentTicket43RunId = "run-ticket43-graph";
    class Ticket43PromiseOwnerTargetAdapter extends HookedWebTargetAdapter {
      constructor(options: ConstructorParameters<typeof PlaywrightWebTargetAdapter>[0]) {
        const boundary = mutationBoundaryByRun.get(currentTicket43RunId);
        if (boundary === undefined) throw new Error(`Missing Ticket 43 boundary for ${currentTicket43RunId}.`);
        super(options, ticket43PromiseOwnerHooks(boundary, nativeSnapshots));
      }

      override async capture(job: ExecutionJobOffer["job"], signal?: AbortSignal): Promise<ObservationGraphV1> {
        const graph = await super.capture(job, signal);
        capturedGraphs.push({
          runId: job.runId,
          graphId: graph.graphId,
          artifacts: await super.captureArtifacts(graph.graphId),
        });
        return graph;
      }
    }

    const config: RunnerConfig = {
      runnerId: "runner-ticket43-owner-e2e",
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
        modelName: "ticket-43-model",
        maximumTokensPerCall: 100,
      },
    };
    const runtime = new RunnerOfferRuntime({
      config,
      session,
      spool,
      valueProvider,
      createTarget: (targetOptions) => new Ticket43PromiseOwnerTargetAdapter(targetOptions),
    });

    try {
      currentTicket43RunId = "run-ticket43-graph";
      await runtime.run(offer("input", "profile.promiseOwnerSecret", "Secret", "textbox", "ticket43-graph"));
      currentTicket43RunId = "run-ticket43-artifact";
      await runtime.run(offer("input", "profile.promiseOwnerSecret", "Secret", "textbox", "ticket43-artifact"));
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
      { jobId: "job-ticket43-graph", runId: "run-ticket43-graph", status: "error", errorCode: "SensitiveEvidenceUnavailable" },
      { jobId: "job-ticket43-artifact", runId: "run-ticket43-artifact", status: "error", errorCode: "SensitiveEvidenceUnavailable" },
    ]);
    expect(nativeSnapshots.map((snapshot) => snapshot.boundary).sort()).toEqual(["artifact", "graph"]);
    for (const snapshot of nativeSnapshots) {
      expect(snapshot.callbackRuns).toEqual(expect.arrayContaining([
        "custom-then-owner",
        "receiver-then:tracked-receiver:" + PROMISE_OWNER_SECRET.length,
        "prototype-catch:native-catch",
        "prototype-finally",
        "tracked-prototype-then:custom-receiver",
        "custom-return:custom-owner-return",
      ]));
      expect(snapshot.statusText).toContain("Promise owner callbacks ready");
      expect(snapshot.title).toBe("owner callbacks complete");
      expect(snapshot.summary.count).toBeGreaterThanOrEqual(5);
      expect(snapshot.summary).toMatchObject({
        hasPromisePrototype: true,
        hasTrackedReceiver: true,
        hasTrackedPrototype: true,
        hasCustomReceiver: true,
        hasCustomThenOwner: true,
        trackedPrototypeThenKind: "data",
      });
      expect(["Promise.prototype", "trackedPrototype"]).toContain(snapshot.summary.trackedReceiverThenOwner);
      expect(snapshot.mutations).toMatchObject({
        descriptorMutated: true,
        descriptorRestored: true,
        prototypeMutated: true,
        prototypeRestored: true,
      });
      expect(snapshot.mutations.reRegistrationRuns).toEqual(expect.arrayContaining([
        "mutated-descriptor:custom-receiver",
        "mutated-prototype:tracked-receiver:" + PROMISE_OWNER_SECRET.length,
        "restored-descriptor:custom-receiver",
        "restored-prototype:tracked-receiver:" + PROMISE_OWNER_SECRET.length,
      ]));
    }

    const trace = batches.flatMap((batch) => batch.events);
    for (const runId of ["run-ticket43-graph", "run-ticket43-artifact"]) {
      expect(trace.filter((event) => event.runId === runId && event.stage === "observation")).toHaveLength(1);
      expect(spooledEvents.filter((event) => event.runId === runId && event.stage === "observation")).toHaveLength(1);
      expect(capturedGraphs.filter((capture) => capture.runId === runId)).toHaveLength(1);
      expect(trace.find((event) => event.runId === runId && event.stage === "run_completed")?.payload)
        .toMatchObject({ status: "error", errorCode: "SensitiveEvidenceUnavailable" });
      expect(spooledEvents.find((event) => event.runId === runId && event.stage === "run_completed")?.payload)
        .toMatchObject({ status: "error", errorCode: "SensitiveEvidenceUnavailable" });
    }
    const acceptedArtifactJson = capturedGraphs
      .flatMap((capture) => capture.artifacts)
      .filter((artifact) => artifact.mediaType === "application/json")
      .map((artifact) => new TextDecoder().decode(artifact.bytes))
      .join("\n");
    expect(JSON.stringify(trace)).not.toContain("Promise owner callbacks ready");
    expect(JSON.stringify(trace)).not.toContain(PROMISE_OWNER_SECRET);
    expect(JSON.stringify(spooledEvents)).not.toContain("Promise owner callbacks ready");
    expect(JSON.stringify(spooledEvents)).not.toContain(PROMISE_OWNER_SECRET);
    expect(acceptedArtifactJson).not.toContain("Promise owner callbacks ready");
    expect(acceptedArtifactJson).not.toContain(PROMISE_OWNER_SECRET);

    await spool.close();
    spool = undefined;
    const spoolText = (await readFile(spoolFile)).toString("utf8");
    expect(JSON.stringify(logs)).not.toContain(PROMISE_OWNER_SECRET);
    expect(spoolText).not.toContain(PROMISE_OWNER_SECRET);
    expect(spoolText).not.toContain("Promise owner callbacks ready");
    expect(spoolText).toContain("SensitiveEvidenceUnavailable");
  }, 90_000);
});

function ticket43PromiseOwnerHooks(
  boundary: Ticket43PromiseOwnerBoundary,
  snapshots: Ticket43NativeSnapshot[],
): PlaywrightObserverHooks {
  const mutateAtBoundary: NonNullable<PlaywrightObserverHooks["afterGraphAssembly"]> = async (page) => {
    const snapshot = await page.evaluate(async (input): Promise<
      | { readonly phase: "skipped" }
      | { readonly phase: "pending"; readonly nativeError: string }
      | Ticket43NativeSnapshot
    > => {
      type BrowserOwnerRecord = {
        readonly owner: object;
        readonly descriptors: Record<"then" | "catch" | "finally", { readonly kind?: string }>;
        readonly resolvedMethodOwners: Record<"then" | "catch" | "finally", { readonly owner?: object }>;
      };
      type BrowserHost = Record<string, unknown>;
      const host = globalThis as BrowserHost;
      const done = host.__ticket43NativeDone;
      if (!(done instanceof Promise) || host.__ticket43MutationApplied === true) return { phase: "skipped" };
      const native = await Promise.race([
        done.then(
          () => ({ done: true as const }),
          (error: unknown) => ({ done: false as const, error: error instanceof Error ? error.message : String(error) }),
        ),
        new Promise<{ readonly done: false; readonly error: string }>((resolve) => {
          setTimeout(() => resolve({ done: false, error: "native callbacks timed out" }), 2_000);
        }),
      ]);
      if (!native.done) return { phase: "pending", nativeError: native.error };

      const summary = summarizeOwnerRegistry(input.runtimeRegistryProperty);
      const callbackRuns = Array.isArray(host.__ticket43NativeCallbacks)
        ? host.__ticket43NativeCallbacks.map((entry) => String(entry))
        : [];
      const browserDocument = (globalThis as unknown as {
        readonly document: {
          readonly title: string;
          getElementById(id: string): { readonly textContent: string | null } | null;
        };
      }).document;
      const statusText = browserDocument.getElementById("owner-status")?.textContent ?? "";
      const title = browserDocument.title;
      const mutations = await mutateOwners();
      host.__ticket43MutationApplied = true;
      return {
        phase: "mutated",
        boundary: input.boundary,
        callbackRuns,
        statusText,
        title,
        summary,
        mutations,
      };

      function summarizeOwnerRegistry(runtimeRegistryProperty: string): Ticket43OwnerSummary {
        const registry = (globalThis as Record<string, { readonly promiseOwners?: readonly BrowserOwnerRecord[] } | undefined>)[runtimeRegistryProperty];
        const owners = registry?.promiseOwners ?? [];
        const trackedReceiver = host.__ticket43TrackedReceiver;
        const trackedPrototype = host.__ticket43TrackedPrototype;
        const customReceiver = host.__ticket43CustomReceiver;
        const customThenOwner = host.__ticket43CustomThenOwner;
        const trackedReceiverRecord = owners.find((record) => record.owner === trackedReceiver);
        const trackedPrototypeRecord = owners.find((record) => record.owner === trackedPrototype);
        const thenOwner = trackedReceiverRecord?.resolvedMethodOwners.then.owner;
        return {
          count: owners.length,
          hasPromisePrototype: owners.some((record) => record.owner === Promise.prototype),
          hasTrackedReceiver: trackedReceiverRecord !== undefined,
          hasTrackedPrototype: trackedPrototypeRecord !== undefined,
          hasCustomReceiver: owners.some((record) => record.owner === customReceiver),
          hasCustomThenOwner: owners.some((record) => record.owner === customThenOwner),
          trackedPrototypeThenKind: trackedPrototypeRecord?.descriptors.then.kind ?? "missing",
          trackedReceiverThenOwner: thenOwner === Promise.prototype
            ? "Promise.prototype"
            : thenOwner === trackedPrototype
              ? "trackedPrototype"
              : "other",
        };
      }

      async function mutateOwners(): Promise<Ticket43NativeSnapshot["mutations"]> {
        const reRegistrationRuns: string[] = [];
        const customReceiver = host.__ticket43CustomReceiver;
        const trackedPrototype = host.__ticket43TrackedPrototype;
        const originalTrackedPrototypeThen = trackedPrototype !== null && typeof trackedPrototype === "object"
          ? Object.getOwnPropertyDescriptor(trackedPrototype, "then")
          : undefined;
        let descriptorMutated = false;
        if (trackedPrototype !== null && typeof trackedPrototype === "object") {
          Object.defineProperty(trackedPrototype, "then", {
            configurable: true,
            enumerable: false,
            writable: true,
            value: function ticket44ReplacementThen(this: unknown, onfulfilled?: unknown, onrejected?: unknown) {
              return Promise.prototype.then.call(this, onfulfilled as never, onrejected as never);
            },
          });
          descriptorMutated = true;
          if (customReceiver !== null && typeof customReceiver === "object") {
            await Promise.prototype.then.call(customReceiver as Promise<string>, (resolved) => {
              reRegistrationRuns.push(`mutated-descriptor:${resolved}`);
              return resolved;
            });
          }
        }
        const trackedReceiver = host.__ticket43TrackedReceiver;
        const originalTrackedReceiverPrototype = trackedReceiver !== null && typeof trackedReceiver === "object"
          ? Object.getPrototypeOf(trackedReceiver)
          : undefined;
        let prototypeMutated = false;
        if (trackedReceiver !== null && typeof trackedReceiver === "object") {
          const replacementPrototype = Object.create(Promise.prototype) as Record<string, unknown>;
          Object.defineProperty(replacementPrototype, "then", {
            configurable: true,
            enumerable: false,
            writable: true,
            value: Promise.prototype.then,
          });
          Object.setPrototypeOf(trackedReceiver, replacementPrototype);
          host.__ticket43ReplacementPrototype = replacementPrototype;
          prototypeMutated = true;
          await Promise.prototype.then.call(trackedReceiver as Promise<string>, (resolved) => {
            reRegistrationRuns.push(`mutated-prototype:${resolved}`);
            return resolved;
          });
        }
        let descriptorRestored = false;
        if (trackedPrototype !== null && typeof trackedPrototype === "object" && originalTrackedPrototypeThen !== undefined) {
          Object.defineProperty(trackedPrototype, "then", originalTrackedPrototypeThen);
          descriptorRestored = true;
          if (customReceiver !== null && typeof customReceiver === "object") {
            await Promise.prototype.then.call(customReceiver as Promise<string>, (resolved) => {
              reRegistrationRuns.push(`restored-descriptor:${resolved}`);
              return resolved;
            });
          }
        }
        let prototypeRestored = false;
        if (trackedReceiver !== null && typeof trackedReceiver === "object" && originalTrackedReceiverPrototype !== undefined) {
          Object.setPrototypeOf(trackedReceiver, originalTrackedReceiverPrototype);
          prototypeRestored = true;
          await Promise.prototype.then.call(trackedReceiver as Promise<string>, (resolved) => {
            reRegistrationRuns.push(`restored-prototype:${resolved}`);
            return resolved;
          });
        }
        return { descriptorMutated, descriptorRestored, prototypeMutated, prototypeRestored, reRegistrationRuns };
      }
    }, { boundary, runtimeRegistryProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY });
    if (snapshot.phase === "pending") {
      throw new Error(`Ticket 43 native Promise callbacks did not complete: ${snapshot.nativeError}`);
    }
    if (snapshot.phase === "mutated") snapshots.push(snapshot);
  };
  return boundary === "graph"
    ? { afterGraphAssembly: mutateAtBoundary }
    : { afterScreenshotCapture: mutateAtBoundary };
}

function offer(
  kind: "input" | "select",
  valueRef: string,
  name: string,
  role: string,
  suffix: string = kind,
): ExecutionJobOffer {
  const step = {
    stepIndex: 0,
    kind,
    target: { role, name, purpose: `exercise ${kind}` },
    valueRef,
  } as const satisfies ExecutionPlanStep;
  return {
    offerId: `offer-${suffix}`,
    job: {
      jobId: `job-${suffix}`,
      runId: `run-${suffix}`,
      projectId: "project-value-ref-e2e",
      target: { kind: "web", url: fixture!.url },
      objective: `Exercise ${kind} through a valueRef`,
      policy: {
        policyId: `policy-${suffix}`,
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
        testCaseId: `case-${suffix}`,
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

function artifactsForGraph(
  artifactsByGraph: ReadonlyMap<string, readonly CapturedArtifact[]>,
  graphId: string,
): readonly CapturedArtifact[] {
  const artifacts = artifactsByGraph.get(graphId);
  if (artifacts === undefined) throw new Error(`Missing captured artifacts for ${graphId}.`);
  expect(artifacts.some((artifact) => artifact.mediaType === "application/json")).toBe(true);
  expect(artifacts.some((artifact) => artifact.mediaType === "image/png")).toBe(true);
  return artifacts;
}

function pngArtifact(artifacts: readonly CapturedArtifact[]): CapturedArtifact {
  const artifact = artifacts.find((candidate) => candidate.mediaType === "image/png");
  if (artifact === undefined) throw new Error("Missing PNG artifact.");
  return artifact;
}

function assertArtifactJsonRedacted(
  artifacts: readonly CapturedArtifact[],
  forbidden: readonly string[],
  required: readonly string[],
): void {
  const text = artifacts
    .filter((artifact) => artifact.mediaType === "application/json")
    .map((artifact) => new TextDecoder().decode(artifact.bytes))
    .join("\n");
  for (const value of forbidden) {
    expect(text).not.toContain(value);
  }
  for (const value of required) {
    expect(text).toContain(value);
  }
}

async function samplePngPixels(
  bytes: Uint8Array,
  points: readonly (readonly [number, number])[],
): Promise<readonly (readonly [number, number, number, number])[]> {
  const image = decodePngRgba(bytes);
  return points.map(([x, y]) => {
    const offset = (y * image.width + x) * 4;
    return Array.from(image.rgba.slice(offset, offset + 4)) as [number, number, number, number];
  });
}

function decodePngRgba(bytes: Uint8Array): { readonly width: number; readonly rgba: Uint8Array } {
  const buffer = Buffer.from(bytes);
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) throw new Error("Invalid PNG signature.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      const interlace = data[12]!;
      if (bitDepth !== 8 || interlace !== 0) throw new Error("Unsupported PNG format.");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (width <= 0 || height <= 0 || channels === 0) throw new Error("Unsupported PNG color type.");
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const scanlines = new Uint8Array(height * stride);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset]!;
    sourceOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset]!;
      sourceOffset += 1;
      const left = x >= channels ? scanlines[y * stride + x - channels]! : 0;
      const up = y > 0 ? scanlines[(y - 1) * stride + x]! : 0;
      const upperLeft = y > 0 && x >= channels ? scanlines[(y - 1) * stride + x - channels]! : 0;
      scanlines[y * stride + x] = (raw + pngFilterDelta(filter, left, up, upperLeft)) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    if (channels === 1) {
      rgba[target] = scanlines[source]!;
      rgba[target + 1] = scanlines[source]!;
      rgba[target + 2] = scanlines[source]!;
      rgba[target + 3] = 255;
    } else {
      rgba[target] = scanlines[source]!;
      rgba[target + 1] = scanlines[source + 1]!;
      rgba[target + 2] = scanlines[source + 2]!;
      rgba[target + 3] = channels === 4 ? scanlines[source + 3]! : 255;
    }
  }
  return { width, rgba };
}

function pngFilterDelta(filter: number, left: number, up: number, upperLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) return paeth(left, up, upperLeft);
  throw new Error(`Unsupported PNG filter ${filter}.`);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
