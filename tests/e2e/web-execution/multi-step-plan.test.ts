import { randomBytes } from "node:crypto";
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
  ObservationGraphV1,
} from "@qualigence/runner-protocol";
import { WEB_OBSERVATION_V1_CAPABILITY_TOKENS, capabilities } from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import { AesGcmSpoolCrypto, SqliteRunnerSpool } from "@qualigence/runner-spool";
import {
  DeterministicExecutionBudget,
  type AgentContext,
  type AnyProposedAction,
  type ExecutionBudget,
  type RunnerPolicyGate,
} from "@qualigence/runner-kernel";
import { AllowAllRunnerPolicyGate } from "@qualigence/testkit";
import {
  PlaywrightActionExecutor,
  PlaywrightActionResolver,
  PlaywrightBrowserSession,
  PlaywrightObserver,
} from "@qualigence/web-playwright/internal";
import { FileActionValueProvider } from "../../../apps/runner/src/action-value-provider.js";
import type { RunnerConfig } from "../../../apps/runner/src/config.js";
import { LeasedJobExecutor } from "../../../apps/runner/src/job-executor.js";
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
let crossFixture: FixtureServer | undefined;
let modelServer: Server | undefined;
let spool: SqliteRunnerSpool | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await spool?.close();
  await fixture?.close();
  await crossFixture?.close();
  if (modelServer !== undefined) {
    modelServer.closeAllConnections();
    modelServer.close();
    await once(modelServer, "close");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  fixture = undefined;
  crossFixture = undefined;
  modelServer = undefined;
  spool = undefined;
});

describe("bounded multi-step production Web Runtime", () => {
  it("executes same-origin link -> input -> select -> click -> scroll -> verify with fresh indexed observations", async () => {
    fixture = await startFixtureServer({
      "/": htmlDocument("<a href='/next'>Continue</a>", "Start"),
      "/next": htmlDocument(`
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
    spool = await SqliteRunnerSpool.open({
      databaseFile: spoolFile,
      crypto: new AesGcmSpoolCrypto(randomBytes(32)),
    });

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
      "click", "input", "select", "click", "scroll",
    ]);
    expect(trace.find((event) => event.stage === "action_executed" && event.stepIndex === 0))
      .toMatchObject({ payload: { status: "ok" } });
    const observations = trace.filter((event) => event.stage === "observation");
    expect(observations[0]).toMatchObject({ stepIndex: 0, payload: { url: fixture.url } });
    expect(observations[1]).toMatchObject({ stepIndex: 1, payload: { url: `${fixture.origin}/next` } });
    expect(observations[1]?.payload.graphId).not.toBe(observations[0]?.payload.graphId);
    expect(finalObservation(trace).nodes.some((node) => node.name === "Completed" || node.value === "Completed")).toBe(true);
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

describe("bounded multi-step Chromium failure classifications", () => {
  it.each([
    {
      name: "stale descriptor after DOM change",
      html: '<button aria-label="Continue">Continue</button>',
      steps: [
        { stepIndex: 0, kind: "click", target: { role: "button", name: "Continue", purpose: "continue" } },
        { stepIndex: 1, kind: "verify", claimIds: ["claim-later"] },
      ],
      decide: nodeDecision("click", "Continue"),
      policyGate: (session: PlaywrightBrowserSession): RunnerPolicyGate => ({
        authorize: async () => {
          await session.withPage(async (page) => {
            await page.setContent(htmlDocument("<p>Target changed</p>", "Changed"));
          });
          return { status: "allowed", reason: "test" };
        },
      }),
      expectedStatus: "blocked",
      errorCode: "TargetNotFound",
      failureStepIndex: 0,
      expectedDecisions: 1,
    },
    {
      name: "cross-origin navigation",
      html: "<p>Start</p>",
      steps: [
        { stepIndex: 0, kind: "navigate", path: "https://other.test/checkout" },
        { stepIndex: 1, kind: "verify", claimIds: ["claim-later"] },
      ],
      decide: stepDecision,
      allowedOrigins: (origin: string) => [origin, "https://other.test"],
      expectedStatus: "blocked",
      errorCode: "OriginViolation",
      failureStepIndex: 0,
      expectedDecisions: 1,
    },
    {
      name: "cross-origin link after dispatch",
      html: (crossOrigin: string) => `<a aria-label="Leave" href="/next" onpointerdown="this.href='${crossOrigin}/'">Leave</a>`,
      routes: { "/next": "<p>Same-origin fallback</p>" },
      steps: [
        { stepIndex: 0, kind: "click", target: { role: "link", name: "Leave", purpose: "leave" } },
        { stepIndex: 1, kind: "verify", claimIds: ["claim-later"] },
      ],
      decide: nodeDecision("click", "Leave"),
      expectedStatus: "error",
      errorCode: "ActionOutcomeUnknown",
      failureStepIndex: 0,
      expectedDecisions: 1,
    },
    {
      name: "rejected link dispatch",
      html: '<span style="position:relative;display:inline-block"><a aria-label="Continue" href="/next">Continue</a><span style="position:absolute;inset:0"></span></span>',
      routes: { "/next": "<p>Later page</p>" },
      steps: [
        { stepIndex: 0, kind: "click", target: { role: "link", name: "Continue", purpose: "continue" } },
        { stepIndex: 1, kind: "verify", claimIds: ["claim-later"] },
      ],
      decide: nodeDecision("click", "Continue"),
      expectedStatus: "error",
      errorCode: "ActionOutcomeUnknown",
      failureStepIndex: 0,
      expectedDecisions: 1,
    },
    {
      name: "disabled input",
      html: '<label>Email <input aria-label="Email" disabled /></label>',
      steps: [
        { stepIndex: 0, kind: "input", target: { role: "textbox", name: "Email", purpose: "enter email" }, valueRef: "profile.email" },
        { stepIndex: 1, kind: "verify", claimIds: ["claim-later"] },
      ],
      decide: nodeDecision("input", "Email", "profile.email"),
      valueProvider: { resolve: async () => EMAIL },
      expectedStatus: "blocked",
      errorCode: "TargetDisabled",
      failureStepIndex: 0,
      expectedDecisions: 1,
    },
    {
      name: "missing valueRef",
      html: '<label>Email <input aria-label="Email" /></label>',
      steps: [
        { stepIndex: 0, kind: "input", target: { role: "textbox", name: "Email", purpose: "enter email" }, valueRef: "profile.missing" },
        { stepIndex: 1, kind: "verify", claimIds: ["claim-later"] },
      ],
      decide: nodeDecision("input", "Email", "profile.missing"),
      valueProvider: { resolve: async () => { throw new Error("missing"); } },
      expectedStatus: "blocked",
      errorCode: "ActionValueUnavailable",
      failureStepIndex: 0,
      expectedDecisions: 1,
    },
    {
      name: "step budget",
      html: "<p>Start</p>",
      routes: { "/next": "<p>Next</p>" },
      steps: [
        { stepIndex: 0, kind: "navigate", path: "/next" },
        { stepIndex: 1, kind: "navigate", path: "/later" },
      ],
      decide: stepDecision,
      budgetLimits: { maximumStepsPerJob: 1, maximumWallClockMs: 10_000, maximumModelTokens: 100 },
      expectedStatus: "blocked",
      errorCode: "StepBudgetExceeded",
      failureStepIndex: 1,
      expectedDecisions: 1,
    },
    {
      name: "wall budget",
      html: '<button aria-label="Continue">Continue</button>',
      steps: [
        { stepIndex: 0, kind: "click", target: { role: "button", name: "Continue", purpose: "continue" } },
        { stepIndex: 1, kind: "verify", claimIds: ["claim-later"] },
      ],
      decide: nodeDecision("click", "Continue"),
      budgetFactory: (clock: { now: number }): ExecutionBudget => new DeterministicExecutionBudget({
        clock: { now: () => clock.now },
      }),
      afterDecision: (clock: { now: number }) => { clock.now = 10; },
      budgetLimits: { maximumStepsPerJob: 2, maximumWallClockMs: 10, maximumModelTokens: 100 },
      expectedStatus: "blocked",
      errorCode: "WallClockBudgetExceeded",
      failureStepIndex: 0,
      expectedDecisions: 1,
    },
    {
      name: "model budget",
      html: '<button aria-label="Continue">Continue</button>',
      steps: [
        { stepIndex: 0, kind: "click", target: { role: "button", name: "Continue", purpose: "continue" } },
        { stepIndex: 1, kind: "verify", claimIds: ["claim-later"] },
      ],
      decide: async (context: AgentContext) => {
        context.budget?.consumeModelUsage(context.job.runId, { totalTokens: 2 });
        return nodeDecision("click", "Continue")(context);
      },
      budgetLimits: { maximumStepsPerJob: 2, maximumWallClockMs: 10_000, maximumModelTokens: 1 },
      expectedStatus: "blocked",
      errorCode: "ModelBudgetExceeded",
      failureStepIndex: 0,
      expectedDecisions: 1,
    },
  ] satisfies readonly BrowserFailureCase[])(
    "$name is terminal and does not execute a later step",
    async (testCase) => {
      const result = await runBrowserFailure(testCase);

      expect(result.completion).toMatchObject({
        status: testCase.expectedStatus,
        errorCode: testCase.errorCode,
      });
      expect(result.leaseCompletions).toEqual([result.completion]);
      expect(result.trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
      expect(result.trace.at(-1)).toMatchObject({
        stage: "run_completed",
        stepIndex: testCase.failureStepIndex,
        payload: { status: testCase.expectedStatus, errorCode: testCase.errorCode },
      });
      expect(result.trace.some((event) =>
        event.stage !== "run_completed" &&
        event.stepIndex !== undefined &&
        event.stepIndex >= testCase.failureStepIndex + 1)).toBe(false);
      expect(result.decisions).toBe(testCase.expectedDecisions);
    },
    60_000,
  );
});

type PlanSteps = readonly [ExecutionPlanStep, ...ExecutionPlanStep[]];

interface BrowserFailureCase {
  readonly name: string;
  readonly html: string | ((crossOrigin: string) => string);
  readonly routes?: Readonly<Record<string, string>>;
  readonly steps: PlanSteps;
  readonly decide: (context: AgentContext) => Promise<AnyProposedAction>;
  readonly policyGate?: (session: PlaywrightBrowserSession) => RunnerPolicyGate;
  readonly valueProvider?: { resolve(valueRef: string): Promise<string> };
  readonly allowedOrigins?: (origin: string) => readonly string[];
  readonly budgetLimits?: {
    readonly maximumStepsPerJob: number;
    readonly maximumWallClockMs: number;
    readonly maximumModelTokens: number;
  };
  readonly budgetFactory?: (clock: { now: number }) => ExecutionBudget;
  readonly afterDecision?: (clock: { now: number }) => void;
  readonly expectedStatus: "blocked" | "error";
  readonly errorCode: string;
  readonly failureStepIndex: number;
  readonly expectedDecisions: number;
}

async function runBrowserFailure(testCase: BrowserFailureCase) {
  if (typeof testCase.html === "function") {
    crossFixture = await startFixtureServer({ "/": htmlDocument("<p>Other origin</p>", "Other") });
  }
  const body = typeof testCase.html === "function"
    ? testCase.html(crossFixture!.origin)
    : testCase.html;
  fixture = await startFixtureServer({
    "/": htmlDocument(body, testCase.name),
    ...(testCase.routes ?? {}),
  });
  const root = await mkdtemp(join(tmpdir(), "qualigence-ticket19-failure-"));
  roots.push(root);
  spool = await SqliteRunnerSpool.open({
    databaseFile: join(root, "runner-spool.db"),
    crypto: new AesGcmSpoolCrypto(randomBytes(32)),
  });
  const session = new PlaywrightBrowserSession({
    url: fixture.url,
    headed: false,
    navigationTimeoutMs: 10_000,
    actionTimeoutMs: 5_000,
    allowedOrigins: testCase.allowedOrigins?.(fixture.origin) ?? [fixture.origin],
  });
  try {
    await session.start();
  } catch (error) {
    if (error instanceof Error && /browser.*(launch|executable)/i.test(error.message)) {
      throw new Error("ChromiumUnavailable", { cause: error });
    }
    throw error;
  }

  const clock = { now: 0 };
  let decisions = 0;
  const leaseCompletions: ExecutionCompletion[] = [];
  const lease: ExecutionJobLease = {
    jobId: `job-${testCase.name}`,
    runId: `run-${testCase.name}`,
    leaseToken: `lease-${testCase.name}`,
    leaseEpoch: 1,
    expiresAt: "2099-08-22T00:00:00.000Z",
  };
  const runnerSession: RunnerSession = {
    welcome: {
      sessionId: "session-failure",
      resumeToken: "resume-failure",
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
    renew: async () => lease,
    submit: async (batch) => ({
      batchId: batch.batchId,
      runId: batch.runId,
      nextExpectedSequenceNumber: batch.firstSequenceNumber + batch.events.length,
    }),
    complete: async (_lease: ExecutionJobLease, completion: ExecutionCompletion) => {
      leaseCompletions.push(completion);
    },
    close: async () => undefined,
  };
  const observer = new PlaywrightObserver(session);
  const resolver = new PlaywrightActionResolver(session);
  const actionExecutor = new PlaywrightActionExecutor(session, testCase.valueProvider);
  const executor = new LeasedJobExecutor({
    observer,
    resolver,
    actionExecutor,
    decisionProvider: {
      decide: async (context) => {
        decisions += 1;
        const decision = await testCase.decide(context);
        testCase.afterDecision?.(clock);
        return decision as never;
      },
    },
    policyGate: testCase.policyGate?.(session) ?? new AllowAllRunnerPolicyGate(),
    verifier: { verify: async () => { throw new Error("later verification must not run"); } },
    spool,
    capabilities: capabilities({
      targetAdapters: ["web-playwright"],
      actionKinds: ["navigate", "click", "input", "select", "scroll"],
    }),
    actionDeadlineSafetyMarginMs: 0,
    ...(testCase.budgetFactory === undefined ? {} : { budget: testCase.budgetFactory(clock) }),
  });
  const budget = testCase.budgetLimits ?? {
    maximumStepsPerJob: testCase.steps.length,
    maximumWallClockMs: 10_000,
    maximumModelTokens: 100,
  };
  const offer: ExecutionJobOffer = {
    offerId: `offer-${testCase.name}`,
    job: {
      jobId: lease.jobId,
      runId: lease.runId,
      projectId: "project-ticket-19",
      target: { kind: "web", url: fixture.url },
      objective: testCase.name,
      policy: {
        policyId: `policy-${testCase.name}`,
        environment: "isolated_test",
        allowedOrigins: testCase.allowedOrigins?.(fixture.origin) ?? [fixture.origin],
        allowedActionKinds: ["navigate", "click", "input", "select", "scroll"],
        maximumRisk: "ExternalSideEffect",
        explorationAllowed: false,
        issuedAt: "2026-08-22T00:00:00.000Z",
        expiresAt: "2099-08-22T00:00:00.000Z",
      },
      plan: {
        missionId: "mission-ticket-19",
        missionRevision: 1,
        testCaseId: `case-${testCase.name}`,
        steps: testCase.steps,
        expectedClaimIds: ["claim-later"],
        budget,
      },
    },
    requiredCapabilities: [],
    leaseDurationMs: 60_000,
  };

  try {
    const result = await executor.execute(offer, runnerSession);
    await runnerSession.complete(result.lease, result.completion);
    const trace = await spool.pending(lease.runId, 1, {
      maximumEvents: 100,
      maximumBytes: 1_000_000,
    });
    return { completion: result.completion, leaseCompletions, trace, decisions };
  } finally {
    await session.close();
  }
}

function nodeDecision(
  kind: "click" | "input",
  name: string,
  valueRef?: string,
): (context: AgentContext) => Promise<AnyProposedAction> {
  return async (context) => {
    const node = context.observation.nodes.find((candidate) => candidate.name === name);
    if (node === undefined) throw new Error(`Missing ${name} node.`);
    return kind === "input"
      ? { kind, target: { nodeId: node.id }, valueRef: valueRef!, reason: "ground input" }
      : { kind, target: { nodeId: node.id }, reason: "ground click" };
  };
}

async function stepDecision(context: AgentContext): Promise<AnyProposedAction> {
  const step = context.step;
  if (step?.kind !== "navigate") throw new Error("Expected navigation step.");
  return { kind: "navigate", path: step.path, reason: "follow approved path" };
}

function offer(): ExecutionJobOffer {
  const steps = [
    { stepIndex: 0, kind: "click", target: { role: "link", name: "Continue", purpose: "open the form" } },
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
      ...WEB_OBSERVATION_V1_CAPABILITY_TOKENS,
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
    readonly observation: ObservationGraphV1;
  };
  const step = prompt.step;
  if (step.kind === "navigate") return { reason: "follow the approved path" };
  const node = step.kind === "scroll"
    ? prompt.observation.nodes.find((candidate) => candidate.name === "Completed" || candidate.value === "Completed")
    : prompt.observation.nodes.find((candidate) =>
        candidate.role === step.target.role && candidate.name === step.target.name);
  if (node === undefined) throw new Error(`No current node grounds ${prompt.step.kind}.`);
  return { nodeId: node.id, reason: `ground ${prompt.step.kind}` };
}

function finalObservation(trace: readonly ExecutionEventBatch["events"][number][]): ObservationGraphV1 {
  const event = trace.filter((candidate) => candidate.stage === "observation").at(-1);
  if (event?.stage !== "observation") throw new Error("Missing final observation.");
  return event.payload;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
