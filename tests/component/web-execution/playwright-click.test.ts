import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AcceptedExecutionJob,
  ObservationGraph,
  ObservationNode,
} from "@qualigence/runner-protocol";
import { ExecutionPermit, ExecutionRuntime, type ProposedAction } from "@qualigence/runner-kernel";
import { InMemoryTraceStore, TraceIngestor } from "@qualigence/evidence";
import { InMemoryProtocolTraceRecorder } from "@qualigence/in-memory-runner-protocol";
import { AllowAllRunnerPolicyGate } from "@qualigence/testkit";
import {
  PlaywrightActionExecutor,
  PlaywrightActionResolver,
  PlaywrightBrowserSession,
  PlaywrightObserver,
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
          <label>Normalized secret <input aria-label="Normalized secret" /></label>
          <label>Country <select aria-label="Country"><option value="private-country-code">Canada</option><option value="us">United States</option></select></label>
          <p data-qualigence-observe id="values"></p>
          <p data-qualigence-observe>ab</p>
          <script>
            document.querySelector('input').addEventListener('input', event => document.getElementById('values').textContent = event.target.value);
            document.querySelector('input[aria-label="Normalized secret"]').addEventListener('input', () => document.getElementById('values').textContent = 'Normalized ready');
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

  it("maps a blocked click to ActionTimedOut", async () => {
    const { observer, resolver, executor } = await wire({ actionTimeoutMs: 1_200 });
    const before = await observer.capture(job);
    const blocked = nodeNamed(before, "Blocked action");
    const action = await resolver.resolve(click(blocked.id), before);
    expect(await executor.execute(action, allowedPermit())).toEqual({
      status: "failed",
      errorCode: "ActionTimedOut",
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
    const afterSelect = await observer.capture(job);
    expect(nodeNamed(afterSelect, "Country"))
      .toMatchObject({ value: "[REDACTED]", text: "[REDACTED]" });
    const serializedPublicValues = JSON.stringify([
      inputAction,
      inputOutcome,
      afterInput,
      selectAction,
      selectOutcome,
      afterSelect,
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

  it("redacts only the acted node after Chromium normalizes a single-line input", async () => {
    const source = "a\r\nb\r\n";
    const browserValue = "ab";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => source });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Normalized secret").id, "customer.normalized"),
      before,
    );

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    const after = await observer.capture(job);
    const serialized = JSON.stringify(after);
    const target = nodeNamed(after, "Normalized secret");
    const artifact = session.artifactsFor(after.graphId)
      .find((candidate) => candidate.mediaType === "application/json");
    const artifactGraph = JSON.parse(new TextDecoder().decode(artifact?.bytes)) as ObservationGraph;
    const artifactTarget = nodeNamed(artifactGraph, "Normalized secret");

    expect(serialized).not.toContain(source);
    expect(target).toMatchObject({ value: "[REDACTED]", text: "[REDACTED]" });
    expect(artifactTarget).toMatchObject({ value: "[REDACTED]", text: "[REDACTED]" });
    expect(after.nodes.some((node) => node.text === "ab")).toBe(true);
    expect(artifactGraph.nodes.some((node) => node.text === browserValue)).toBe(true);
  });
});
