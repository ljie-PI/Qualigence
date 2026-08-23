import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcceptedExecutionJob,
  ObservationGraph,
  ObservationNode,
} from "@qualigence/runner-protocol";
import {
  ExecutionPermit,
  ExecutionRuntime,
  type AnyProposedAction,
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

function allowedPermit(): ExecutionPermit {
  return ExecutionPermit.fromAllowedDecision({
    status: "allowed",
    reason: "allowed by component test",
  });
}

function click(nodeId: string): ProposedAction {
  return { kind: "click", target: { nodeId }, reason: "component test" };
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

function nodeNamed(graph: ObservationGraph, name: string): ObservationNode {
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
    cross = await startFixtureServer({ "/": htmlDocument("<h1>Other origin</h1>") });
    fixture = await startFixtureServer({
      "/": htmlDocument(
        `
          <button id="add" onclick="document.getElementById('total').textContent='Cart total: $19'">Add to cart</button>
          <p data-qualigence-observe id="total">Cart total: $0</p>
          <button disabled>Disabled action</button>
          <button class="twin">Twin</button>
          <button class="twin">Twin</button>
          <a id="leave" href="${cross.origin}/">Leave site</a>
          <span style="position:relative;display:inline-block">
            <button id="blocked">Blocked action</button>
            <span style="position:absolute;inset:0"></span>
          </span>
          <label>Email <input aria-label="Email" /></label>
          <label>Country <select aria-label="Country"><option value="private-country-code">Canada</option><option value="us">United States</option></select></label>
          <p data-qualigence-observe id="values"></p>
          <script>
            document.querySelector('input').addEventListener('input', event => document.getElementById('values').textContent = event.target.value);
            document.querySelector('select').addEventListener('change', event => document.getElementById('values').textContent += ':' + event.target.value);
          </script>
        `,
        "Clicks",
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
    const total = after.nodes.find((node) => node.text?.includes("Cart total"));
    expect(total?.text).toContain("$19");
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
    const staleGraph: ObservationGraph = { ...before, graphId: "run-click:observation:99" };
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
    expect(after.url).toBe(fixture.url);
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

  it("executes input and select through valueRefs without returning plaintext", async () => {
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
    const serializedPublicValues = JSON.stringify([
      inputAction,
      inputOutcome,
      afterInput,
      selectAction,
      selectOutcome,
      await observer.capture(job),
    ]);
    expect(serializedPublicValues).not.toContain("private@example.test");
    expect(serializedPublicValues).not.toContain("private-country-code");
  });

  it("redacts input plaintext from the complete Trace and verifier context", async () => {
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
    const serializedTrace = JSON.stringify(traces.eventsFor(job.runId));
    expect(serializedTrace).not.toContain(secret);
    expect(serializedVerifierContext).not.toContain(secret);
    expect(traces.eventsFor(job.runId).filter((event) => event.stage === "observation")).toHaveLength(2);
  });

  it("blocks a redirect after the model decision before resolver locator reads", async () => {
    const graphId = "run-before-resolver-origin:observation:1";
    const nodeId = "n-0-safe-control";
    const descriptor: LocatorDescriptor = { kind: "role", role: "button", name: "Safe control" };
    const graph: ObservationGraph = {
      graphId,
      url: fixture.url,
      nodes: [{ id: nodeId, role: "button", name: "Safe control", confidence: 1 }],
    };
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
    const graph: ObservationGraph = {
      graphId,
      url: fixture.url,
      nodes: [{ id: nodeId, role: "button", name: "Safe control", confidence: 1 }],
    };
    let currentUrl = fixture.url;
    const count = vi.fn(async () => {
      currentUrl = cross.url;
      return 1;
    });
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
        isVisible: async () => true,
        isEnabled: async () => true,
        getAttribute: async () => null,
        click: vi.fn(),
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
    expect(policyGate.authorize).not.toHaveBeenCalled();
    expect(trace.filter((event) => event.stage === "action_resolved")).toHaveLength(0);
    expect(trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(JSON.stringify(trace)).not.toContain(cross.origin);
  });

  it("blocks a delayed cross-origin redirect before the next observation can escape", async () => {
    const crossOriginContent = "private cross-origin account data";
    let currentUrl = fixture.url;
    const evaluate = vi.fn(async () => currentUrl === fixture.url
      ? [{ role: "button", name: "Continue" }]
      : [{ role: "button", name: crossOriginContent }]);
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
    expect(evaluate).toHaveBeenCalledTimes(1);
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
      evaluate: async () => [{ role: "button", name: "Continue" }],
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
      const graph: ObservationGraph = {
        graphId,
        url: fixture.url,
        nodes: [{ id: nodeId, role: descriptor.role, name: "Matching control", confidence: 1 }],
      };
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

  it("blocks when the page redirects during executor preflight before authorization or dispatch", async () => {
    const graphId = "run-raced-executor-origin:observation:1";
    const nodeId = "n-0-safe-control";
    const descriptor: LocatorDescriptor = { kind: "role", role: "button", name: "Safe control" };
    const graph: ObservationGraph = {
      graphId,
      url: fixture.url,
      nodes: [{ id: nodeId, role: "button", name: "Safe control", confidence: 1 }],
    };
    let currentUrl = fixture.url;
    let countCalls = 0;
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
          if (countCalls === 2) currentUrl = cross.url;
          return 1;
        },
        isVisible: async () => true,
        isEnabled: async () => true,
        getAttribute: async () => null,
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
    expect(authorizationWindow.assertActionAuthorized).not.toHaveBeenCalled();
    expect(clickEffect).not.toHaveBeenCalled();
    expect(trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
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
      const graph: ObservationGraph = {
        graphId,
        url: fixture.url,
        nodes: [{ id: nodeId, role: descriptor.role, name: "Matching control", confidence: 1 }],
      };
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
          evaluate: sideEffect,
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
