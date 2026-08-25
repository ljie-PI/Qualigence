import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcceptedExecutionJob,
  ObservationGraphV1,
  ObservationNodeV1,
} from "@qualigence/runner-protocol";
import {
  ExecutionPermit,
  ExecutionRuntime,
  type AnyProposedAction,
  type AnyResolvedAction,
  type ProposedAction,
} from "@qualigence/runner-kernel";
import { InMemoryTraceStore, TraceIngestor } from "@qualigence/evidence";
import { InMemoryProtocolTraceRecorder } from "@qualigence/in-memory-runner-protocol";
import { AllowAllRunnerPolicyGate } from "@qualigence/testkit";
import {
  PlaywrightActionExecutor,
  PlaywrightActionResolver,
  PlaywrightBrowserSession,
  PlaywrightObserver,
  type BrowserLauncher,
  type LocatorDescriptor,
  type WebSessionOptions,
} from "@qualigence/web-playwright/internal";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";
import { observationGraphV1 } from "../../helpers/observation-graph-v1.js";

function allowedPermit(): ExecutionPermit {
  return ExecutionPermit.fromAllowedDecision({
    status: "allowed",
    reason: "allowed by component test",
  });
}

function sensitiveTargetEvaluate(value = "private-value") {
  let markerId = "";
  return vi.fn(async (_callback: unknown, argument: unknown) => {
    if (
      typeof argument === "object" &&
      argument !== null &&
      "markerId" in argument &&
      "stateProperty" in argument
    ) {
      markerId = String(argument.markerId);
      return { status: "ok" };
    }
    if (
      typeof argument === "object" &&
      argument !== null &&
      "markerId" in argument
    ) {
      markerId = String(argument.markerId);
      return undefined;
    }
    return {
      sensitiveTargetIds: [markerId],
      value,
      selectedOptionValue: value,
      selectedOptionText: value,
    };
  });
}

function click(nodeId: string): ProposedAction {
  return { kind: "click", target: { nodeId }, reason: "component test" };
}

function navigate(path: string): ProposedAction<"navigate"> {
  return { kind: "navigate", path, reason: "component test" };
}

function valued(kind: "input" | "select", nodeId: string, valueRef: string) {
  return { kind, target: { nodeId }, valueRef, reason: "component test" } as const;
}

function elementAction(kind: "click" | "input" | "select" | "scroll", nodeId: string): AnyProposedAction {
  switch (kind) {
    case "click":
      return click(nodeId);
    case "input":
    case "select":
      return valued(kind, nodeId, `value.${kind}`);
    case "scroll":
      return {
        kind: "scroll",
        target: { nodeId },
        direction: "down",
        amount: "small",
        reason: "component test",
      };
  }
}

function nodeNamed(graph: ObservationGraphV1, name: string): ObservationNodeV1 {
  const node = graph.nodes.find((candidate) => candidate.name === name);
  if (!node) {
    throw new Error(`No node named ${name} in graph ${graph.graphId}`);
  }
  return node;
}

const job: AcceptedExecutionJob = {
  jobId: "job-click",
  runId: "run-click",
  projectId: "project-test",
  target: { kind: "web", url: "http://placeholder.test" },
  objective: "Exercise clicks",
  policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["http://placeholder.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
};

describe("Playwright resolve + execute against real Chromium", () => {
  let fixture: FixtureServer;
  let cross: FixtureServer;
  let session: PlaywrightBrowserSession;

  beforeEach(async () => {
    cross = await startFixtureServer({
      "/": htmlDocument("<h1>Other origin</h1>"),
      "/bounce": `<!doctype html><html><head><meta charset="utf-8"><script>
          const returnUrl = new URL(location.href).searchParams.get('return');
          if (returnUrl) location.replace(returnUrl);
        </script></head><body><p>Temporary other origin</p></body></html>`,
    });
    fixture = await startFixtureServer({
      "/": htmlDocument(
        `
          <button id="add" onclick="document.getElementById('total').textContent='Cart total: $19'">Add to cart</button>
          <p data-qualigence-observe id="total">Cart total: $0</p>
          <button disabled>Disabled action</button>
          <button class="twin">Twin</button>
          <button class="twin">Twin</button>
          <a id="leave" href="${cross.origin}/">Leave site</a>
          <a href="/next">Continue to next page</a>
          <a href="/next" onpointerdown="this.href='${cross.origin}/'">Cross after dispatch</a>
          <a href="/returned" onclick="event.preventDefault(); location.href='${cross.origin}/bounce?return='+encodeURIComponent(location.origin+'/returned')">Bounce and return</a>
          <span style="position:relative;display:inline-block">
            <button id="blocked">Blocked action</button>
            <span style="position:absolute;inset:0"></span>
          </span>
          <span style="position:relative;display:inline-block">
            <a href="/next">Blocked link</a>
            <span style="position:absolute;inset:0"></span>
          </span>
          <label>Email <input aria-label="Email" /></label>
          <label>Notes <textarea aria-label="Notes"></textarea></label>
          <label>Country <select aria-label="Country"><option value="private-country-code">Canada</option><option value="us">United States</option></select></label>
          <p data-qualigence-observe id="values"></p>
          <p data-qualigence-observe id="notes-copy"></p>
          <script>
            document.querySelector('input').addEventListener('input', event => document.getElementById('values').textContent = event.target.value);
            document.querySelector('textarea').addEventListener('input', event => document.getElementById('notes-copy').textContent = event.target.value);
            document.querySelector('select').addEventListener('change', event => document.getElementById('values').textContent += ':' + event.target.value);
          </script>
        `,
        "Clicks",
      ),
      "/next": htmlDocument(
        "<button onclick=\"document.body.dataset.clicked='true'\">Next action</button>",
        "Next",
      ),
      "/returned": htmlDocument(
        "<button onclick=\"document.body.dataset.clicked='true'\">Next action</button>",
        "Returned",
      ),
    });
  });

  afterEach(async () => {
    await session?.close();
    await fixture?.close();
    await cross?.close();
  });

  function options(overrides: Partial<WebSessionOptions> = {}): WebSessionOptions {
    return {
      url: fixture.url,
      expectedOrigin: fixture.origin,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      allowedOrigins: [fixture.origin],
      ...overrides,
    };
  }

  async function wire(overrides: Partial<WebSessionOptions> = {}): Promise<{
    observer: PlaywrightObserver;
    resolver: PlaywrightActionResolver;
    executor: PlaywrightActionExecutor;
  }> {
    session = new PlaywrightBrowserSession(options(overrides));
    await session.start();
    return {
      observer: new PlaywrightObserver(session),
      resolver: new PlaywrightActionResolver(session),
      executor: new PlaywrightActionExecutor(session),
    };
  }

  async function startTrackedFakeSession(
    locatorFactory: (navigate: (url: string) => void) => object,
  ): Promise<PlaywrightBrowserSession> {
    return (await startControllableTrackedFakeSession(locatorFactory)).trackedSession;
  }

  async function startControllableTrackedFakeSession(
    locatorFactory: (navigate: (url: string) => void) => object,
  ): Promise<{
    readonly trackedSession: PlaywrightBrowserSession;
    readonly navigate: (url: string) => void;
  }> {
    let currentUrl = fixture.url;
    const mainFrame = { url: () => currentUrl };
    let frameNavigated: ((frame: object) => void) | undefined;
    const navigate = (url: string): void => {
      currentUrl = url;
      frameNavigated?.(mainFrame);
    };
    const locator = locatorFactory(navigate);
    const page = {
      goto: vi.fn(async () => undefined),
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn((event: string, listener: (frame: object) => void) => {
        if (event === "framenavigated") frameNavigated = listener;
      }),
      getByRole: () => locator,
      close: vi.fn(async () => undefined),
    };
    const context = {
      newPage: vi.fn(async () => page),
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    const tracked = new PlaywrightBrowserSession(options(), {
      launch: vi.fn(async () => browser),
    } as unknown as BrowserLauncher);
    await tracked.start();
    return { trackedSession: tracked, navigate };
  }

  async function runTwoClickPlan(
    firstName: string,
    overrides: Partial<WebSessionOptions> = {},
  ) {
    const { observer, resolver, executor } = await wire(overrides);
    const observations: ObservationGraphV1[] = [];
    const resolvedActions: AnyResolvedAction[] = [];
    let oldDescriptorInvalidatedBeforeNextCapture = false;
    let decisions = 0;
    const traces = new InMemoryTraceStore();
    const runtime = new ExecutionRuntime({
      observer: {
        capture: async (acceptedJob) => {
          if (observations.length === 1) {
            oldDescriptorInvalidatedBeforeNextCapture = !session.hasGraph(observations[0]!.graphId);
          }
          const observation = await observer.capture(acceptedJob);
          observations.push(observation);
          return observation;
        },
      },
      decisionProvider: {
        decide: async (context) => {
          decisions += 1;
          if (context.step?.kind !== "click") throw new Error("Expected a click step.");
          const name = context.step.target.name;
          if (name === undefined) throw new Error("Expected a named click target.");
          return click(nodeNamed(context.observation, name).id);
        },
      },
      resolver: {
        resolve: async (action, graph) => {
          const resolved = await resolver.resolve(action, graph);
          resolvedActions.push(resolved);
          return resolved;
        },
      },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: executor,
      verifier: { verify: async () => ({ status: "passed", summary: "ok", claims: [] }) },
      traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(traces)),
    });
    const runId = `run-link-${firstName.toLowerCase().replaceAll(" ", "-")}`;
    const result = await runtime.run({
      ...job,
      jobId: `job-link-${firstName.toLowerCase().replaceAll(" ", "-")}`,
      runId,
      target: { kind: "web", url: fixture.url },
      plan: {
        missionId: "mission-link-navigation",
        missionRevision: 1,
        testCaseId: `case-link-${firstName.toLowerCase().replaceAll(" ", "-")}`,
        steps: [
          { stepIndex: 0, kind: "click", target: { role: "link", name: firstName, purpose: "navigate" } },
          { stepIndex: 1, kind: "click", target: { role: "button", name: "Next action", purpose: "continue" } },
          { stepIndex: 2, kind: "verify", claimIds: ["claim-link-navigation"] },
        ],
        expectedClaimIds: ["claim-link-navigation"],
        budget: { maximumStepsPerJob: 3, maximumWallClockMs: 15_000, maximumModelTokens: 100 },
      },
    });
    return {
      decisions,
      observations,
      oldDescriptorInvalidatedBeforeNextCapture,
      resolvedActions,
      result,
      trace: traces.eventsFor(runId),
    };
  }

  it("resolves to a de-identified token and performs a same-origin click", async () => {
    const { observer, resolver, executor } = await wire();

    const before = await observer.capture(job);
    const action = await resolver.resolve(
      click(nodeNamed(before, "Add to cart").id),
      before,
    );
    expect(action.target.selector).toBe(
      `pw:${before.graphId}:${nodeNamed(before, "Add to cart").id}`,
    );
    expect(action.target.selector).not.toContain("#add");

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });

    const after = await observer.capture(job);
    const total = after.nodes.find((node) => node.name?.includes("Cart total") || node.value?.includes("Cart total"));
    expect(total?.name ?? total?.value).toContain("$19");
  });

  it("uses a fresh observation generation after planned navigation", async () => {
    const { observer, resolver, executor } = await wire();
    const before = await observer.capture(job);
    const beforeGeneration = session.currentNavigationGeneration;
    const navigation = await resolver.resolve(navigate("/next"), before);

    expect(await executor.execute(navigation, allowedPermit())).toEqual({ status: "ok" });
    expect(session.currentNavigationGeneration).toBeGreaterThan(beforeGeneration);
    expect(session.hasGraph(before.graphId)).toBe(false);

    const after = await observer.capture(job);
    const nextAction = await resolver.resolve(
      click(nodeNamed(after, "Next action").id),
      after,
    );
    expect(await executor.execute(nextAction, allowedPermit())).toEqual({ status: "ok" });
  });

  it("continues a bounded plan after a same-origin link advances navigation generation", async () => {
    const result = await runTwoClickPlan("Continue to next page");

    expect(result.result).toMatchObject({ status: "passed" });
    expect(result.oldDescriptorInvalidatedBeforeNextCapture).toBe(true);
    await expect(new PlaywrightActionExecutor(session).execute(
      result.resolvedActions[0]!,
      allowedPermit(),
    )).resolves.toEqual({ status: "failed", errorCode: "OriginViolation" });
    const observedWeb = result.observations[1]?.extensions?.["web/v1"]?.payload;
    expect(`${observedWeb?.origin}${observedWeb?.pathname}`).toBe(`${fixture.origin}/next`);
    expect(result.trace.filter((event) => event.stage === "action_executed")).toEqual([
      expect.objectContaining({ stepIndex: 0, payload: { status: "ok" } }),
      expect.objectContaining({ stepIndex: 1, payload: { status: "ok" } }),
    ]);
    expect(result.trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
    await expect(session.withPage(async (page) => page.locator("body").getAttribute("data-clicked")))
      .resolves.toBe("true");
  });

  it("terminalizes a cross-origin link navigation as unknown without a later step", async () => {
    const result = await runTwoClickPlan("Cross after dispatch");

    expect(result.result).toMatchObject({ status: "error", errorCode: "ActionOutcomeUnknown" });
    expect(result.decisions).toBe(1);
    expect(result.observations).toHaveLength(1);
    expect(result.trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(result.trace.at(-1)).toMatchObject({
      stage: "run_completed",
      stepIndex: 0,
      payload: { status: "error", errorCode: "ActionOutcomeUnknown" },
    });
  });

  it("terminalizes an A-to-B-to-A link navigation as unknown without a later step", async () => {
    const result = await runTwoClickPlan("Bounce and return");

    expect(result.result).toMatchObject({ status: "error", errorCode: "ActionOutcomeUnknown" });
    expect(result.decisions).toBe(1);
    expect(result.observations).toHaveLength(1);
    expect(session.currentCrossOriginNavigationCount).toBeGreaterThan(0);
    await session.withPage(async (page) => page.waitForURL(`${fixture.origin}/returned`));
    await expect(session.withPage(async (page) => page.url())).resolves.toBe(`${fixture.origin}/returned`);
    expect(result.trace.filter((event) => event.stage === "action_executed")).toEqual([
      expect.objectContaining({
        stepIndex: 0,
        payload: { status: "failed", errorCode: "ActionOutcomeUnknown" },
      }),
    ]);
    expect(result.trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(result.trace.at(-1)).toMatchObject({
      stage: "run_completed",
      stepIndex: 0,
      payload: { status: "error", errorCode: "ActionOutcomeUnknown" },
    });
  });

  it("keeps a rejected link dispatch unknown without retrying or starting a later step", async () => {
    const result = await runTwoClickPlan("Blocked link", { actionTimeoutMs: 1_200 });

    expect(result.result).toMatchObject({ status: "error", errorCode: "ActionOutcomeUnknown" });
    expect(result.decisions).toBe(1);
    expect(result.observations).toHaveLength(1);
    expect(result.trace.filter((event) => event.stage === "action_executed")).toEqual([
      expect.objectContaining({
        stepIndex: 0,
        payload: { status: "failed", errorCode: "ActionOutcomeUnknown" },
      }),
    ]);
    expect(result.trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
  });

  it("rejects an unknown node without clicking", async () => {
    const { observer, resolver } = await wire();
    const before = await observer.capture(job);
    await expect(
      resolver.resolve(click("n-99-deadbeef"), before),
    ).rejects.toMatchObject({ code: "UnknownObservationNode" });
  });

  it("rejects a stale graph without clicking", async () => {
    const { observer, resolver } = await wire();
    const before = await observer.capture(job);
    const staleGraph: ObservationGraphV1 = { ...before, graphId: "run-click:observation:99" };
    await expect(
      resolver.resolve(click(before.nodes[0]!.id), staleGraph),
    ).rejects.toMatchObject({ code: "StaleObservation" });
  });

  it("reports AmbiguousTarget for two nodes sharing role and name", async () => {
    const { observer, resolver } = await wire();
    const before = await observer.capture(job);
    const twin = before.nodes.find((node) => node.name === "Twin");
    await expect(resolver.resolve(click(twin!.id), before)).rejects.toMatchObject({
      code: "AmbiguousTarget",
    });
  });

  it("fails a disabled target without clicking", async () => {
    const { observer, resolver, executor } = await wire();
    const before = await observer.capture(job);
    const disabled = nodeNamed(before, "Disabled action");
    const action = await resolver.resolve(click(disabled.id), before);
    expect(await executor.execute(action, allowedPermit())).toEqual({
      status: "failed",
      errorCode: "TargetDisabled",
    });
  });

  it("blocks a cross-origin navigation with OriginViolation and does not navigate", async () => {
    const { observer, resolver, executor } = await wire();
    const before = await observer.capture(job);
    const leave = nodeNamed(before, "Leave site");
    const action = await resolver.resolve(click(leave.id), before);
    expect(await executor.execute(action, allowedPermit())).toEqual({
      status: "failed",
      errorCode: "OriginViolation",
    });

    const after = await observer.capture(job);
    const web = after.extensions?.["web/v1"]?.payload;
    expect(`${web?.origin}${web?.pathname}`).toBe(fixture.url);
  });

  it("maps a dispatched click timeout to ActionOutcomeUnknown", async () => {
    const { observer, resolver, executor } = await wire({ actionTimeoutMs: 1_200 });
    const before = await observer.capture(job);
    const blocked = nodeNamed(before, "Blocked action");
    const action = await resolver.resolve(click(blocked.id), before);
    expect(await executor.execute(action, allowedPermit())).toEqual({
      status: "failed",
      errorCode: "ActionOutcomeUnknown",
    });
  });

  it("redacts input and select target fields without global equal-text replacement", async () => {
    const values = new Map([
      ["customer.email", "private@example.test"],
      ["customer.country", "private-country-code"],
    ]);
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, {
      resolve: async (valueRef) => {
        const value = values.get(valueRef);
        if (value === undefined) throw new Error("missing");
        return value;
      },
    });
    const before = await observer.capture(job);

    const inputAction = await resolver.resolve(valued("input", nodeNamed(before, "Email").id, "customer.email"), before);
    const inputOutcome = await executor.execute(inputAction, allowedPermit());
    const afterInput = await observer.capture(job);
    const selectAction = await resolver.resolve(valued("select", nodeNamed(afterInput, "Country").id, "customer.country"), afterInput);
    const selectOutcome = await executor.execute(selectAction, allowedPermit());

    expect(inputOutcome).toEqual({ status: "ok" });
    expect(selectOutcome).toEqual({ status: "ok" });
    const afterSelect = await observer.capture(job);

    expect(JSON.stringify([inputAction, inputOutcome, selectAction, selectOutcome]))
      .not.toContain("private@example.test");
    expect(nodeNamed(afterInput, "Email").value).toBe("[redacted]");
    expect(afterInput.nodes.some((node) => node.name === "[redacted]" || node.value === "[redacted]")).toBe(true);
    expect(afterInput.nodes.some((node) => node.name === "private@example.test" || node.value === "private@example.test")).toBe(false);
    expect(nodeNamed(afterSelect, "Email").value).toBe("[redacted]");
    expect(nodeNamed(afterSelect, "Country")).toMatchObject({
      value: "[redacted]",
    });
    expect(afterSelect.nodes.filter((node) => node.name === "[redacted]" || node.value === "[redacted]").length)
      .toBeGreaterThanOrEqual(2);
    expect(afterSelect.nodes.some((node) => node.name === "private@example.test:private-country-code" || node.value === "private@example.test:private-country-code"))
      .toBe(false);
  });

  it("registers browser-normalized textarea newline forms against only the authorized target", async () => {
    const source = "line-one\r\nline-two\r\n";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, {
      resolve: async () => source,
    });
    const before = await observer.capture(job);

    const action = await resolver.resolve(valued("input", nodeNamed(before, "Notes").id, "notes.body"), before);
    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    const after = await observer.capture(job);

    expect(nodeNamed(after, "Notes").value).toBe("[redacted]");
    expect(after.nodes.some((node) => node.name === "[redacted]" || node.value === "[redacted]")).toBe(true);
    expect(after.nodes.some((node) => node.name === "line-one line-two" || node.value === "line-one line-two")).toBe(false);
  });

  it("redacts input target fields from Trace and verifier context without global equal-text replacement", async () => {
    const secret = "trace-secret@example.test";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const traces = new InMemoryTraceStore();
    let serializedVerifierContext = "";
    const runtime = new ExecutionRuntime({
      observer,
      decisionProvider: {
        decide: async () => valued("input", "unused", "customer.email") as never,
      },
      resolver: {
        resolve: async (action, graph) => resolver.resolve(
          valued("input", nodeNamed(graph, "Email").id, "customer.email"),
          graph,
        ) as never,
      },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: executor,
      verifier: {
        verify: async (context) => {
          serializedVerifierContext = JSON.stringify(context);
          return { status: "passed", summary: "ok", claims: [] };
        },
      },
      traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(traces)),
      objectiveOnlyMaximumWallClockMs: 10_000,
      objectiveOnlyMaximumModelTokens: 100,
    });

    await expect(runtime.run(job)).resolves.toMatchObject({ status: "passed" });
    const events = traces.eventsFor(job.runId);
    const nonObservationTrace = JSON.stringify(events.filter((event) => event.stage !== "observation"));
    expect(nonObservationTrace).not.toContain(secret);
    const observations = events.filter((event) => event.stage === "observation");
    expect(observations).toHaveLength(2);
    const after = observations.at(-1)?.payload as ObservationGraphV1;
    expect(nodeNamed(after, "Email").value).toBe("[redacted]");
    expect(after.nodes.some((node) => node.name === "[redacted]" || node.value === "[redacted]")).toBe(true);
    expect(after.nodes.some((node) => node.name === secret || node.value === secret)).toBe(false);
    const verifierContext = JSON.parse(serializedVerifierContext) as { readonly after: ObservationGraphV1 };
    expect(nodeNamed(verifierContext.after, "Email").value).toBe("[redacted]");
  });

  it("blocks a redirect after the model decision before resolver locator reads", async () => {
    const graphId = "run-before-resolver-origin:observation:1";
    const nodeId = "n-0-safe-control";
    const descriptor: LocatorDescriptor = { kind: "role", role: "button", name: "Safe control" };
    const graph = observationGraphV1(graphId, [{ id: nodeId, role: "button", name: "Safe control", confidence: 1 }], { target: { kind: "web", targetId: fixture.origin } });
    let currentUrl = fixture.url;
    const locatorReads = {
      count: vi.fn(async () => 1),
      isVisible: vi.fn(async () => true),
      isEnabled: vi.fn(async () => true),
      getAttribute: vi.fn(async () => null),
    };
    session = new PlaywrightBrowserSession(options(), { launch: vi.fn() } as unknown as BrowserLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([[nodeId, descriptor]]),
      artifacts: [],
    });
    session.withPage = async (operation) => operation({
      url: () => currentUrl,
      getByRole: () => ({ ...locatorReads, click: vi.fn() }),
    } as never);
    const traces = new InMemoryTraceStore();
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph },
      decisionProvider: {
        decide: async () => {
          currentUrl = cross.url;
          return click(nodeId);
        },
      },
      resolver: new PlaywrightActionResolver(session),
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: new PlaywrightActionExecutor(session),
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(traces)),
      objectiveOnlyMaximumWallClockMs: 5_000,
      objectiveOnlyMaximumModelTokens: 100,
    });

    const result = await runtime.run({
      ...job,
      jobId: "job-before-resolver-origin",
      runId: "run-before-resolver-origin",
      target: { kind: "web", url: fixture.url },
    });

    const trace = traces.eventsFor("run-before-resolver-origin");
    expect(result).toMatchObject({ status: "blocked", errorCode: "OriginViolation" });
    expect(locatorReads.count).not.toHaveBeenCalled();
    expect(locatorReads.isVisible).not.toHaveBeenCalled();
    expect(locatorReads.isEnabled).not.toHaveBeenCalled();
    expect(locatorReads.getAttribute).not.toHaveBeenCalled();
    expect(trace.filter((event) => event.stage === "action_resolved")).toHaveLength(0);
    expect(trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(trace.at(-1)).toMatchObject({
      stage: "run_completed",
      payload: { status: "blocked", errorCode: "OriginViolation" },
    });
    expect(JSON.stringify(trace)).not.toContain(cross.origin);
  });

  it("discards a resolution when the page redirects during its locator read", async () => {
    const graphId = "run-raced-resolver-origin:observation:1";
    const nodeId = "n-0-safe-control";
    const descriptor: LocatorDescriptor = { kind: "role", role: "button", name: "Safe control" };
    const graph = observationGraphV1(graphId, [{ id: nodeId, role: "button", name: "Safe control", confidence: 1 }], { target: { kind: "web", targetId: fixture.origin } });
    let currentUrl = fixture.url;
    const count = vi.fn(async () => {
      currentUrl = cross.url;
      return 1;
    });
    const isVisible = vi.fn(async () => true);
    const isEnabled = vi.fn(async () => true);
    const getAttribute = vi.fn(async () => null);
    const clickEffect = vi.fn(async () => undefined);
    const policyGate = { authorize: vi.fn(async () => ({ status: "allowed", reason: "not reached" } as const)) };
    session = new PlaywrightBrowserSession(options(), { launch: vi.fn() } as unknown as BrowserLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([[nodeId, descriptor]]),
      artifacts: [],
    });
    session.withPage = async (operation) => operation({
      url: () => currentUrl,
      getByRole: () => ({
        count,
        isVisible,
        isEnabled,
        getAttribute,
        click: clickEffect,
      }),
    } as never);
    const traces = new InMemoryTraceStore();
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph },
      decisionProvider: { decide: async () => click(nodeId) },
      resolver: new PlaywrightActionResolver(session),
      policyGate,
      actionExecutor: new PlaywrightActionExecutor(session),
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(traces)),
      objectiveOnlyMaximumWallClockMs: 5_000,
      objectiveOnlyMaximumModelTokens: 100,
    });

    const result = await runtime.run({
      ...job,
      jobId: "job-raced-resolver-origin",
      runId: "run-raced-resolver-origin",
      target: { kind: "web", url: fixture.url },
    });

    const trace = traces.eventsFor("run-raced-resolver-origin");
    expect(result).toMatchObject({ status: "blocked", errorCode: "OriginViolation" });
    expect(count).toHaveBeenCalledOnce();
    expect(isVisible).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
    expect(getAttribute).not.toHaveBeenCalled();
    expect(clickEffect).not.toHaveBeenCalled();
    expect(policyGate.authorize).not.toHaveBeenCalled();
    expect(trace.filter((event) => event.stage === "action_resolved")).toHaveLength(0);
    expect(trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(trace.at(-1)).toMatchObject({
      stage: "run_completed",
      payload: { status: "blocked", errorCode: "OriginViolation" },
    });
    expect(JSON.stringify(trace)).not.toContain(cross.origin);
  });

  it("discards a resolution when its locator read navigates away and back", async () => {
    const graphId = "run-bounced-resolver-origin:observation:1";
    const nodeId = "n-0-safe-control";
    const descriptor: LocatorDescriptor = { kind: "role", role: "button", name: "Safe control" };
    const graph = observationGraphV1(graphId, [{ id: nodeId, role: "button", name: "Safe control", confidence: 1 }], { target: { kind: "web", targetId: fixture.origin } });
    const isVisible = vi.fn(async () => true);
    const isEnabled = vi.fn(async () => true);
    const getAttribute = vi.fn(async () => null);
    const clickEffect = vi.fn(async () => undefined);
    const count = vi.fn(async () => 1);
    session = await startTrackedFakeSession((navigate) => ({
      count: count.mockImplementation(async () => {
        navigate(cross.url);
        navigate(fixture.url);
        return 1;
      }),
      isVisible,
      isEnabled,
      getAttribute,
      click: clickEffect,
    }));
    session.registerObservation(graphId, {
      descriptors: new Map([[nodeId, descriptor]]),
      artifacts: [],
    });
    const traces = new InMemoryTraceStore();
    const policyGate = { authorize: vi.fn(async () => ({ status: "allowed", reason: "not reached" } as const)) };
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph },
      decisionProvider: { decide: async () => click(nodeId) },
      resolver: new PlaywrightActionResolver(session),
      policyGate,
      actionExecutor: new PlaywrightActionExecutor(session),
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(traces)),
      objectiveOnlyMaximumWallClockMs: 5_000,
      objectiveOnlyMaximumModelTokens: 100,
    });

    const result = await runtime.run({
      ...job,
      jobId: "job-bounced-resolver-origin",
      runId: "run-bounced-resolver-origin",
      target: { kind: "web", url: fixture.url },
    });

    const trace = traces.eventsFor("run-bounced-resolver-origin");
    expect(result).toMatchObject({ status: "blocked", errorCode: "OriginViolation" });
    expect(count).toHaveBeenCalledOnce();
    expect(isVisible).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
    expect(getAttribute).not.toHaveBeenCalled();
    expect(clickEffect).not.toHaveBeenCalled();
    expect(policyGate.authorize).not.toHaveBeenCalled();
    expect(trace.filter((event) => event.stage === "action_resolved")).toHaveLength(0);
    expect(trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(trace.at(-1)).toMatchObject({
      stage: "run_completed",
      payload: { status: "blocked", errorCode: "OriginViolation" },
    });
  });

  it("blocks an observation-to-resolution navigation bounce before locator reads", async () => {
    const graphId = "run-pre-resolution-bounce:observation:1";
    const nodeId = "n-0-safe-control";
    const descriptor: LocatorDescriptor = { kind: "role", role: "button", name: "Safe control" };
    const graph = observationGraphV1(graphId, [{ id: nodeId, role: "button", name: "Safe control", confidence: 1 }], { target: { kind: "web", targetId: fixture.origin } });
    const count = vi.fn(async () => 1);
    const sideEffect = vi.fn(async () => undefined);
    const controlled = await startControllableTrackedFakeSession(() => ({
      count,
      isVisible: vi.fn(async () => true),
      isEnabled: vi.fn(async () => true),
      getAttribute: vi.fn(async () => null),
      click: sideEffect,
    }));
    session = controlled.trackedSession;
    const traces = new InMemoryTraceStore();
    const policyGate = { authorize: vi.fn(async () => ({ status: "allowed", reason: "not reached" } as const)) };
    const runtime = new ExecutionRuntime({
      observer: {
        capture: async () => {
          session.registerObservation(graphId, {
            descriptors: new Map([[nodeId, descriptor]]),
            artifacts: [],
          });
          return graph;
        },
      },
      decisionProvider: {
        decide: async () => {
          controlled.navigate(cross.url);
          controlled.navigate(fixture.url);
          return click(nodeId);
        },
      },
      resolver: new PlaywrightActionResolver(session),
      policyGate,
      actionExecutor: new PlaywrightActionExecutor(session),
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(traces)),
      objectiveOnlyMaximumWallClockMs: 5_000,
      objectiveOnlyMaximumModelTokens: 100,
    });

    const result = await runtime.run({
      ...job,
      jobId: "job-pre-resolution-bounce",
      runId: "run-pre-resolution-bounce",
      target: { kind: "web", url: fixture.url },
    });

    const trace = traces.eventsFor("run-pre-resolution-bounce");
    expect(result).toMatchObject({ status: "blocked", errorCode: "OriginViolation" });
    expect(count).not.toHaveBeenCalled();
    expect(policyGate.authorize).not.toHaveBeenCalled();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(trace.filter((event) => event.stage === "action_resolved")).toHaveLength(0);
    expect(trace.at(-1)).toMatchObject({
      stage: "run_completed",
      payload: { status: "blocked", errorCode: "OriginViolation" },
    });
  });

  it("blocks a resolution-to-execution navigation bounce before executor reads", async () => {
    const graphId = "run-pre-execution-bounce:observation:1";
    const nodeId = "n-0-safe-control";
    const descriptor: LocatorDescriptor = { kind: "role", role: "button", name: "Safe control" };
    const graph = observationGraphV1(graphId, [{ id: nodeId, role: "button", name: "Safe control", confidence: 1 }], { target: { kind: "web", targetId: fixture.origin } });
    const count = vi.fn(async () => 1);
    const isVisible = vi.fn(async () => true);
    const sideEffect = vi.fn(async () => undefined);
    const controlled = await startControllableTrackedFakeSession(() => ({
      count,
      isVisible,
      isEnabled: vi.fn(async () => true),
      getAttribute: vi.fn(async () => null),
      click: sideEffect,
    }));
    session = controlled.trackedSession;
    const traces = new InMemoryTraceStore();
    const runtime = new ExecutionRuntime({
      observer: {
        capture: async () => {
          session.registerObservation(graphId, {
            descriptors: new Map([[nodeId, descriptor]]),
            artifacts: [],
          });
          return graph;
        },
      },
      decisionProvider: { decide: async () => click(nodeId) },
      resolver: new PlaywrightActionResolver(session),
      policyGate: {
        authorize: async () => {
          controlled.navigate(cross.url);
          controlled.navigate(fixture.url);
          return { status: "allowed", reason: "navigation raced execution" };
        },
      },
      actionExecutor: new PlaywrightActionExecutor(session),
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(traces)),
      objectiveOnlyMaximumWallClockMs: 5_000,
      objectiveOnlyMaximumModelTokens: 100,
    });

    const result = await runtime.run({
      ...job,
      jobId: "job-pre-execution-bounce",
      runId: "run-pre-execution-bounce",
      target: { kind: "web", url: fixture.url },
    });

    const trace = traces.eventsFor("run-pre-execution-bounce");
    expect(result).toMatchObject({ status: "blocked", errorCode: "OriginViolation" });
    expect(count).toHaveBeenCalledOnce();
    expect(isVisible).not.toHaveBeenCalled();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(trace.filter((event) => event.stage === "action_resolved")).toHaveLength(1);
    expect(trace.at(-1)).toMatchObject({
      stage: "run_completed",
      payload: { status: "blocked", errorCode: "OriginViolation" },
    });
  });

  it.each(["input", "select"] as const)(
    "blocks %s when navigation bounces while value resolution is pending",
    async (kind) => {
      const graphId = `run-value-bounce-${kind}:observation:1`;
      const nodeId = "n-0-safe-control";
      const descriptor: LocatorDescriptor = {
        kind: "role",
        role: kind === "input" ? "textbox" : "combobox",
        name: "Safe control",
      };
      const graph = observationGraphV1(graphId, [{ id: nodeId, role: descriptor.role, name: "Safe control", confidence: 1 }], { target: { kind: "web", targetId: fixture.origin } });
      let releaseValue: (() => void) | undefined;
      let markValueStarted: (() => void) | undefined;
      const valueRelease = new Promise<void>((resolve) => { releaseValue = resolve; });
      const valueStarted = new Promise<void>((resolve) => { markValueStarted = resolve; });
      const fill = vi.fn(async () => undefined);
      const selectOption = vi.fn(async () => undefined);
      const controlled = await startControllableTrackedFakeSession(() => ({
        count: vi.fn(async () => 1),
        isVisible: vi.fn(async () => true),
        isEnabled: vi.fn(async () => true),
        getAttribute: vi.fn(async () => null),
        fill,
        selectOption,
      }));
      session = controlled.trackedSession;
      const traces = new InMemoryTraceStore();
      const valueProvider = {
        resolve: vi.fn(async () => {
          markValueStarted?.();
          await valueRelease;
          return "private-value";
        }),
      };
      const runtime = new ExecutionRuntime({
        observer: {
          capture: async () => {
            session.registerObservation(graphId, {
              descriptors: new Map([[nodeId, descriptor]]),
              artifacts: [],
            });
            return graph;
          },
        },
        decisionProvider: { decide: async () => valued(kind, nodeId, `value.${kind}`) as never },
        resolver: new PlaywrightActionResolver(session),
        policyGate: new AllowAllRunnerPolicyGate(),
        actionExecutor: new PlaywrightActionExecutor(session, valueProvider),
        verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
        traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(traces)),
        objectiveOnlyMaximumWallClockMs: 5_000,
        objectiveOnlyMaximumModelTokens: 100,
      });

      const execution = runtime.run({
        ...job,
        jobId: `job-value-bounce-${kind}`,
        runId: `run-value-bounce-${kind}`,
        target: { kind: "web", url: fixture.url },
        plan: {
          missionId: "mission-value-bounce",
          missionRevision: 1,
          testCaseId: `case-value-bounce-${kind}`,
          steps: [{ stepIndex: 0, kind, target: { role: descriptor.role, purpose: "set value" }, valueRef: `value.${kind}` }],
          expectedClaimIds: ["claim-value-bounce"],
          budget: { maximumStepsPerJob: 1, maximumWallClockMs: 5_000, maximumModelTokens: 100 },
        },
      });
      await valueStarted;
      controlled.navigate(cross.url);
      controlled.navigate(fixture.url);
      releaseValue?.();

      await expect(execution).resolves.toMatchObject({ status: "blocked", errorCode: "OriginViolation" });
      expect(valueProvider.resolve).toHaveBeenCalledOnce();
      expect(fill).not.toHaveBeenCalled();
      expect(selectOption).not.toHaveBeenCalled();
      expect(traces.eventsFor(`run-value-bounce-${kind}`).at(-1)).toMatchObject({
        stage: "run_completed",
        payload: { status: "blocked", errorCode: "OriginViolation" },
      });
    },
  );

  it("blocks a delayed cross-origin redirect before the next observation can escape", async () => {
    const crossOriginContent = "private cross-origin account data";
    let currentUrl = fixture.url;
    const evaluate = vi.fn(async () => ({
      candidates: currentUrl === fixture.url
        ? [{ role: "button", name: "Continue" }]
        : [{ role: "button", name: crossOriginContent }],
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    }));
    const title = vi.fn(async () => currentUrl === fixture.url ? "Safe page" : crossOriginContent);
    const screenshot = vi.fn(async () => new TextEncoder().encode(
      currentUrl === fixture.url ? "safe screenshot" : crossOriginContent,
    ));
    const clickEffect = vi.fn(async () => undefined);

    session = new PlaywrightBrowserSession(options(), { launch: vi.fn() } as unknown as BrowserLauncher);
    session.withPage = async (operation) => operation({
      url: () => currentUrl,
      evaluate,
      title,
      screenshot,
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        getAttribute: async () => null,
        click: clickEffect,
      }),
    } as never);
    const observer = new PlaywrightObserver(session);
    const traces = new InMemoryTraceStore();
    const recorder = new InMemoryProtocolTraceRecorder(new TraceIngestor(traces));
    const modelContexts: string[] = [];
    const capturedArtifacts: string[] = [];
    const runtime = new ExecutionRuntime({
      observer,
      decisionProvider: {
        decide: async (context) => {
          modelContexts.push(JSON.stringify(context));
          capturedArtifacts.push(...session.artifactsFor(context.observation.graphId)
            .map((artifact) => new TextDecoder().decode(artifact.bytes)));
          return click(nodeNamed(context.observation, "Continue").id);
        },
      },
      resolver: new PlaywrightActionResolver(session),
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: new PlaywrightActionExecutor(session),
      verifier: { verify: async () => ({ status: "passed", summary: "ok", claims: [] }) },
      traceRecorder: {
        append: async (event) => {
          const recorded = await recorder.append(event);
          if (event.stage === "action_executed") {
            currentUrl = cross.url;
          }
          return recorded;
        },
      },
    });
    const result = await runtime.run({
      ...job,
      jobId: "job-delayed-origin",
      runId: "run-delayed-origin",
      target: { kind: "web", url: fixture.url },
      plan: {
        missionId: "mission-delayed-origin",
        missionRevision: 1,
        testCaseId: "case-delayed-origin",
        steps: [
          { stepIndex: 0, kind: "click", target: { role: "button", purpose: "continue" } },
          { stepIndex: 1, kind: "click", target: { role: "button", purpose: "continue again" } },
        ],
        expectedClaimIds: ["claim-delayed-origin"],
        budget: { maximumStepsPerJob: 2, maximumWallClockMs: 5_000, maximumModelTokens: 100 },
      },
    });

    const trace = traces.eventsFor("run-delayed-origin");
    expect(result).toMatchObject({ status: "blocked", errorCode: "OriginViolation" });
    expect(clickEffect).toHaveBeenCalledOnce();
    expect(modelContexts).toHaveLength(1);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(title).toHaveBeenCalledTimes(1);
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(trace.filter((event) => event.stage === "observation")).toHaveLength(1);
    expect(trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(trace.at(-1)).toMatchObject({
      stage: "run_completed",
      payload: { status: "blocked", errorCode: "OriginViolation" },
    });
    expect(JSON.stringify([trace, modelContexts])).not.toContain(crossOriginContent);
    expect(JSON.stringify([trace, modelContexts])).not.toContain(cross.origin);
    expect(capturedArtifacts.join("\n")).not.toContain(crossOriginContent);
    currentUrl = fixture.url;
    expect(() => session.artifactsFor("run-delayed-origin:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  });

  it("continues after a delayed same-origin path change", async () => {
    let currentUrl = fixture.url;
    const clickEffect = vi.fn(async () => undefined);
    session = new PlaywrightBrowserSession(options(), { launch: vi.fn() } as unknown as BrowserLauncher);
    session.withPage = async (operation) => operation({
      url: () => currentUrl,
      evaluate: async () => ({
        candidates: [{ role: "button", name: "Continue" }],
        viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
      }),
      title: async () => "Safe page",
      screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        getAttribute: async () => null,
        click: clickEffect,
      }),
    } as never);
    const traces = new InMemoryTraceStore();
    const recorder = new InMemoryProtocolTraceRecorder(new TraceIngestor(traces));
    const runtime = new ExecutionRuntime({
      observer: new PlaywrightObserver(session),
      decisionProvider: {
        decide: async (context) => click(nodeNamed(context.observation, "Continue").id),
      },
      resolver: new PlaywrightActionResolver(session),
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: new PlaywrightActionExecutor(session),
      verifier: { verify: async () => ({ status: "passed", summary: "ok", claims: [] }) },
      traceRecorder: {
        append: async (event) => {
          const recorded = await recorder.append(event);
          if (event.stage === "action_executed" && event.stepIndex === 0) {
            currentUrl = `${fixture.origin}/next`;
          }
          return recorded;
        },
      },
    });
    const result = await runtime.run({
      ...job,
      jobId: "job-delayed-path",
      runId: "run-delayed-path",
      target: { kind: "web", url: fixture.url },
      plan: {
        missionId: "mission-delayed-path",
        missionRevision: 1,
        testCaseId: "case-delayed-path",
        steps: [
          { stepIndex: 0, kind: "click", target: { role: "button", purpose: "continue" } },
          { stepIndex: 1, kind: "click", target: { role: "button", purpose: "continue again" } },
        ],
        expectedClaimIds: ["claim-delayed-path"],
        budget: { maximumStepsPerJob: 2, maximumWallClockMs: 5_000, maximumModelTokens: 100 },
      },
    });

    expect(result).toMatchObject({ status: "passed" });
    expect(clickEffect).toHaveBeenCalledTimes(2);
    expect(traces.eventsFor("run-delayed-path").filter((event) => event.stage === "observation"))
      .toContainEqual(expect.objectContaining({
        stepIndex: 1,
        payload: expect.objectContaining({ url: `${fixture.origin}/next` }),
      }));
  });

  it.each(["click", "input", "select", "scroll"] as const)(
    "blocks %s before its page side effect when the page silently leaves the observed origin",
    async (kind) => {
      const sideEffects = {
        click: vi.fn(async () => undefined),
        fill: vi.fn(async () => undefined),
        selectOption: vi.fn(async () => undefined),
        scroll: vi.fn(async () => undefined),
      };
      const graphId = `run-origin-${kind}:observation:1`;
      const nodeId = "n-0-matching";
      const descriptor: LocatorDescriptor = {
        kind: "role",
        role: kind === "input" ? "textbox" : kind === "select" ? "combobox" : "button",
        name: "Matching control",
      };
      const graph = observationGraphV1(graphId, [{ id: nodeId, role: descriptor.role, name: "Matching control", confidence: 1 }], { target: { kind: "web", targetId: fixture.origin } });
      let currentUrl = fixture.url;
      let locatorReads = 0;
      const valueProvider = { resolve: vi.fn(async () => "private-value") };
      session = new PlaywrightBrowserSession(options(), { launch: vi.fn() } as unknown as BrowserLauncher);
      session.registerObservation(graphId, {
        descriptors: new Map([[nodeId, descriptor]]),
        artifacts: [],
      });
      session.withPage = async (operation) => operation({
        url: () => currentUrl,
        getByRole: () => ({
          count: async () => { locatorReads += 1; return 1; },
          isVisible: async () => { locatorReads += 1; return true; },
          isEnabled: async () => { locatorReads += 1; return true; },
          getAttribute: async () => { locatorReads += 1; return null; },
          click: sideEffects.click,
          fill: sideEffects.fill,
          selectOption: sideEffects.selectOption,
          evaluate: sideEffects.scroll,
        }),
      } as never);
      const traces = new InMemoryTraceStore();
      const proposed = elementAction(kind, nodeId);
      const runtime = new ExecutionRuntime({
        observer: { capture: async () => graph },
        decisionProvider: { decide: async () => proposed as never },
        resolver: new PlaywrightActionResolver(session),
        policyGate: {
          authorize: async () => {
            locatorReads = 0;
            currentUrl = cross.url;
            return { status: "allowed", reason: "simulate an unobserved navigation" };
          },
        },
        actionExecutor: new PlaywrightActionExecutor(session, valueProvider),
        verifier: { verify: async () => ({ status: "passed", summary: "ok", claims: [] }) },
        traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(traces)),
      });
      const result = await runtime.run({
        ...job,
        jobId: `job-origin-${kind}`,
        runId: `run-origin-${kind}`,
        target: { kind: "web", url: fixture.url },
        plan: {
          missionId: "mission-origin",
          missionRevision: 1,
          testCaseId: `case-${kind}`,
          steps: [{ stepIndex: 0, ...elementPlanStep(kind) }],
          expectedClaimIds: ["claim-origin"],
          budget: { maximumStepsPerJob: 1, maximumWallClockMs: 5_000, maximumModelTokens: 100 },
        },
      });

      expect(result).toMatchObject({ status: "blocked", errorCode: "OriginViolation" });
      expect(sideEffects.click).not.toHaveBeenCalled();
      expect(sideEffects.fill).not.toHaveBeenCalled();
      expect(sideEffects.selectOption).not.toHaveBeenCalled();
      expect(sideEffects.scroll).not.toHaveBeenCalled();
      expect(locatorReads).toBe(0);
      expect(valueProvider.resolve).not.toHaveBeenCalled();
      expect(traces.eventsFor(`run-origin-${kind}`).filter((event) => event.stage === "run_completed")).toHaveLength(1);
    },
  );

  it("stops executor preflight when the count read redirects", async () => {
    const graphId = "run-count-redirect:observation:1";
    const nodeId = "n-0-safe-control";
    const descriptor: LocatorDescriptor = { kind: "role", role: "button", name: "Safe control" };
    const graph = observationGraphV1(graphId, [{ id: nodeId, role: "button", name: "Safe control", confidence: 1 }], { target: { kind: "web", targetId: fixture.origin } });
    let currentUrl = fixture.url;
    let countCalls = 0;
    const isVisible = vi.fn(async () => true);
    const isEnabled = vi.fn(async () => true);
    const getAttribute = vi.fn(async () => null);
    const clickEffect = vi.fn(async () => undefined);
    session = new PlaywrightBrowserSession(options(), { launch: vi.fn() } as unknown as BrowserLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([[nodeId, descriptor]]),
      artifacts: [],
    });
    session.withPage = async (operation) => operation({
      url: () => currentUrl,
      getByRole: () => ({
        count: async () => {
          countCalls += 1;
          if (countCalls === 2) currentUrl = cross.url;
          return 1;
        },
        isVisible,
        isEnabled,
        getAttribute,
        click: clickEffect,
      }),
    } as never);
    const traces = new InMemoryTraceStore();
    const authorizationWindow = { assertActionAuthorized: vi.fn() };
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph },
      decisionProvider: { decide: async () => click(nodeId) },
      resolver: new PlaywrightActionResolver(session),
      policyGate: new AllowAllRunnerPolicyGate(),
      actionAuthorizationWindow: authorizationWindow,
      actionExecutor: new PlaywrightActionExecutor(session),
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(traces)),
      objectiveOnlyMaximumWallClockMs: 5_000,
      objectiveOnlyMaximumModelTokens: 100,
    });

    const result = await runtime.run({
      ...job,
      jobId: "job-count-redirect",
      runId: "run-count-redirect",
      target: { kind: "web", url: fixture.url },
    });

    const trace = traces.eventsFor("run-count-redirect");
    expect(result).toMatchObject({ status: "blocked", errorCode: "OriginViolation" });
    expect(countCalls).toBe(2);
    expect(isVisible).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
    expect(getAttribute).not.toHaveBeenCalled();
    expect(authorizationWindow.assertActionAuthorized).not.toHaveBeenCalled();
    expect(clickEffect).not.toHaveBeenCalled();
    expect(trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(trace.at(-1)).toMatchObject({
      stage: "run_completed",
      payload: { status: "blocked", errorCode: "OriginViolation" },
    });
  });

  it("stops executor preflight when the visibility read redirects", async () => {
    const graphId = "run-raced-executor-origin:observation:1";
    const nodeId = "n-0-safe-control";
    const descriptor: LocatorDescriptor = { kind: "role", role: "button", name: "Safe control" };
    const graph = observationGraphV1(graphId, [{ id: nodeId, role: "button", name: "Safe control", confidence: 1 }], { target: { kind: "web", targetId: fixture.origin } });
    let currentUrl = fixture.url;
    let countCalls = 0;
    const isEnabled = vi.fn(async () => true);
    const getAttribute = vi.fn(async () => null);
    const clickEffect = vi.fn(async () => undefined);
    const authorizationWindow = { assertActionAuthorized: vi.fn() };
    session = new PlaywrightBrowserSession(options(), { launch: vi.fn() } as unknown as BrowserLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([[nodeId, descriptor]]),
      artifacts: [],
    });
    session.withPage = async (operation) => operation({
      url: () => currentUrl,
      getByRole: () => ({
        count: async () => {
          countCalls += 1;
          return 1;
        },
        isVisible: async () => {
          currentUrl = cross.url;
          return true;
        },
        isEnabled,
        getAttribute,
        click: clickEffect,
      }),
    } as never);
    const traces = new InMemoryTraceStore();
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph },
      decisionProvider: { decide: async () => click(nodeId) },
      resolver: new PlaywrightActionResolver(session),
      policyGate: new AllowAllRunnerPolicyGate(),
      actionAuthorizationWindow: authorizationWindow,
      actionExecutor: new PlaywrightActionExecutor(session),
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(traces)),
      objectiveOnlyMaximumWallClockMs: 5_000,
      objectiveOnlyMaximumModelTokens: 100,
    });

    const result = await runtime.run({
      ...job,
      jobId: "job-raced-executor-origin",
      runId: "run-raced-executor-origin",
      target: { kind: "web", url: fixture.url },
    });

    const trace = traces.eventsFor("run-raced-executor-origin");
    expect(result).toMatchObject({ status: "blocked", errorCode: "OriginViolation" });
    expect(trace.filter((event) => event.stage === "action_resolved")).toHaveLength(1);
    expect(countCalls).toBe(2);
    expect(isEnabled).not.toHaveBeenCalled();
    expect(getAttribute).not.toHaveBeenCalled();
    expect(authorizationWindow.assertActionAuthorized).not.toHaveBeenCalled();
    expect(clickEffect).not.toHaveBeenCalled();
    expect(trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(trace.at(-1)).toMatchObject({
      stage: "run_completed",
      payload: { status: "blocked", errorCode: "OriginViolation" },
    });
    expect(JSON.stringify(trace)).not.toContain(cross.origin);
  });

  it.each(["click", "input", "select", "scroll"] as const)(
    "allows %s when the page remains on the observed target origin",
    async (kind) => {
      const sideEffect = vi.fn(async () => undefined);
      const graphId = `run-same-origin-${kind}:observation:1`;
      const nodeId = "n-0-matching";
      const descriptor: LocatorDescriptor = {
        kind: "role",
        role: kind === "input" ? "textbox" : kind === "select" ? "combobox" : "button",
        name: "Matching control",
      };
      const graph = observationGraphV1(graphId, [{ id: nodeId, role: descriptor.role, name: "Matching control", confidence: 1 }], { target: { kind: "web", targetId: fixture.origin } });
      session = new PlaywrightBrowserSession(options(), { launch: vi.fn() } as unknown as BrowserLauncher);
      session.registerObservation(graphId, {
        descriptors: new Map([[nodeId, descriptor]]),
        artifacts: [],
      });
      session.withPage = async (operation) => operation({
        url: () => fixture.url,
        getByRole: () => ({
          count: async () => 1,
          isVisible: async () => true,
          isEnabled: async () => true,
          getAttribute: async () => null,
          click: sideEffect,
          fill: sideEffect,
          selectOption: sideEffect,
          evaluate: kind === "scroll" ? sideEffect : sensitiveTargetEvaluate(),
        }),
      } as never);
      const proposed = elementAction(kind, nodeId);
      const runtime = new ExecutionRuntime({
        observer: {
          capture: async () => {
            session.registerObservation(graphId, {
              descriptors: new Map([[nodeId, descriptor]]),
              artifacts: [],
            });
            return graph;
          },
        },
        decisionProvider: { decide: async () => proposed as never },
        resolver: new PlaywrightActionResolver(session),
        policyGate: new AllowAllRunnerPolicyGate(),
        actionExecutor: new PlaywrightActionExecutor(session, { resolve: async () => "private-value" }),
        verifier: { verify: async () => ({ status: "passed", summary: "ok", claims: [] }) },
        traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(new InMemoryTraceStore())),
      });

      await expect(runtime.run({
        ...job,
        jobId: `job-same-origin-${kind}`,
        runId: `run-same-origin-${kind}`,
        target: { kind: "web", url: fixture.url },
        plan: {
          missionId: "mission-origin",
          missionRevision: 1,
          testCaseId: `case-${kind}`,
          steps: [{ stepIndex: 0, ...elementPlanStep(kind) }],
          expectedClaimIds: ["claim-origin"],
          budget: { maximumStepsPerJob: 1, maximumWallClockMs: 5_000, maximumModelTokens: 100 },
        },
      })).resolves.toMatchObject({ status: "passed" });
      expect(sideEffect).toHaveBeenCalledOnce();
    },
  );
});

function elementPlanStep(kind: "click" | "input" | "select" | "scroll") {
  const target = { role: "control", purpose: "exercise origin guard" };
  switch (kind) {
    case "click":
      return { kind, target } as const;
    case "input":
    case "select":
      return { kind, target, valueRef: `value.${kind}` } as const;
    case "scroll":
      return { kind, target, direction: "down", amount: "small" } as const;
  }
}
