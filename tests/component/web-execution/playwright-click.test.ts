import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import type {
  AcceptedExecutionJob,
  ObservationGraph,
  ObservationNode,
} from "@qualigence/runner-protocol";
import {
  DeterministicRunnerPolicyGate,
  ExecutionPermit,
  ExecutionRuntime,
  type ProposedAction,
} from "@qualigence/runner-kernel";
import { InMemoryTraceStore, TraceIngestor } from "@qualigence/evidence";
import { InMemoryProtocolTraceRecorder } from "@qualigence/in-memory-runner-protocol";
import { AllowAllRunnerPolicyGate, InMemoryTraceRecorder } from "@qualigence/testkit";
import {
  PlaywrightActionExecutor,
  PlaywrightActionResolver,
  PlaywrightBrowserSession,
  PlaywrightObserver,
  PRIVATE_TARGET_ATTRIBUTE,
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
           <label>Email <input aria-label="Email" style="position:fixed;left:40px;top:200px;background:rgb(255,0,0);border:0;border-radius:0;padding:0;width:180px;height:40px;appearance:none" /></label>
           <label>Normalized secret <input aria-label="Normalized secret" style="position:fixed;left:40px;top:80px;background:rgb(255,0,0);border:0;border-radius:0;padding:0;width:180px;height:40px;appearance:none" /></label>
           <label>Mutable secret <input aria-label="Mutable secret" style="position:fixed;left:40px;top:140px;background:rgb(255,0,0);border:0;border-radius:0;padding:0;width:180px;height:40px;appearance:none" /></label>
           <label>Country <select aria-label="Country" style="position:fixed;left:40px;top:260px;background:rgb(255,0,0);border:0;border-radius:0;padding:0;width:180px;height:40px;appearance:none"><option value="private-country-code">Canada</option><option value="us">United States</option></select></label>
           <input aria-label="Input property reflection" style="position:fixed;left:280px;top:310px;background:rgb(255,0,0);border:0;border-radius:0;padding:0;width:180px;height:40px;appearance:none" />
           <textarea aria-label="Select property reflection" style="position:fixed;left:280px;top:360px;background:rgb(255,0,0);border:0;border-radius:0;padding:0;width:180px;height:40px;appearance:none"></textarea>
           <p data-qualigence-observe id="values" style="position:fixed;left:280px;top:20px;width:100px;height:40px;margin:0"></p>
           <p data-qualigence-observe id="normalized-reflection" style="position:fixed;left:280px;top:200px;background:rgb(255,0,0);width:100px;height:40px;margin:0"></p>
           <p data-qualigence-observe id="normalized-reflection-second" style="position:fixed;left:280px;top:250px;background:rgb(255,0,0);width:100px;height:40px;margin:0"></p>
           <p data-qualigence-observe>ab</p>
           <p data-qualigence-observe>property-input-secret</p>
           <p data-qualigence-observe>private-country-code</p>
           <div data-unrelated-region style="position:fixed;left:400px;top:80px;width:60px;height:60px;background:rgb(0,255,0)"></div>
           <script>
             document.querySelector('input').addEventListener('input', event => {
               document.getElementById('values').textContent = event.target.value;
               document.querySelector('input[aria-label="Input property reflection"]').value = event.target.value;
             });
             document.querySelector('input[aria-label="Normalized secret"]').addEventListener('input', event => {
               const normalized = event.target.value;
               document.getElementById('normalized-reflection').textContent = normalized;
               event.target.value = '';
               setTimeout(() => {
                 document.getElementById('normalized-reflection-second').textContent = 'reflected:' + normalized;
               }, 350);
             });
             document.querySelector('input[aria-label="Mutable secret"]').addEventListener('input', event => {
               event.target.setAttribute('aria-label', event.target.value);
               document.getElementById('values').textContent = 'Mutable ready';
             });
             document.querySelector('select').addEventListener('change', event => {
               document.getElementById('values').textContent += ':' + event.target.value;
               document.querySelector('textarea[aria-label="Select property reflection"]').value = event.target.value;
             });
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
    expect(afterSelect.nodes.filter((node) => node.name === "[REDACTED]"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "[REDACTED]", value: "[REDACTED]", text: "[REDACTED]" }),
        expect.objectContaining({ name: "[REDACTED]", value: "[REDACTED]", text: "[REDACTED]" }),
      ]));
    expect(afterSelect.nodes.filter((node) => node.name === "[REDACTED]")).toHaveLength(5);
    const screenshot = session.artifactsFor(afterSelect.graphId)
      .find((artifact) => artifact.mediaType === "image/png");
    const boxes = await session.withPage(async (page) => ({
      input: await page.locator('input[aria-label="Email"]').boundingBox(),
      select: await page.locator('select[aria-label="Country"]').boundingBox(),
      unrelated: await page.locator("[data-unrelated-region]").boundingBox(),
    }));
    if (screenshot === undefined || boxes.input === null || boxes.select === null || boxes.unrelated === null) {
      throw new Error("Expected screenshot and bounded regions.");
    }
    const image = decodePng(screenshot.bytes);
    expectSolidCrop(image, boxes.input, [0, 0, 0, 255]);
    expectSolidCrop(image, boxes.select, [0, 0, 0, 255]);
    expectSolidCrop(image, boxes.unrelated, [0, 255, 0, 255]);
    const serializedPublicValues = JSON.stringify([
      inputAction,
      inputOutcome,
      afterInput,
      selectAction,
      selectOutcome,
      afterSelect,
    ]);
    expect(serializedPublicValues).not.toContain("private@example.test");
    expect(afterSelect.nodes.filter((node) => node.text === "private-country-code"))
      .toHaveLength(1);
  });

  it.each([
    ["input", "Email", "customer.email", "private@example.test"],
    ["select", "Country", "customer.country", "private-country-code"],
  ] as const)(
    "does not mutate the page for denied %s and registers its allowed target for masking",
    async (kind, targetName, valueRef, value) => {
      session = new PlaywrightBrowserSession(options());
      await session.start();
      const observer = new PlaywrightObserver(session);
      const resolver = new PlaywrightActionResolver(session);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => value });

      const run = async (maximumRisk: "Normal" | "ExternalSideEffect") => {
        const policy = {
          ...job.policy,
          allowedOrigins: [fixture.origin],
          allowedActionKinds: [kind],
          maximumRisk,
          expiresAt: "2027-08-21T00:00:00.000Z",
        };
        const runtimeObserver = {
          capture: async (acceptedJob: AcceptedExecutionJob) => {
            const graph = await observer.capture(acceptedJob);
            if (session.sensitiveTargets().length === 0) {
              await session.withPage(async (page) => {
                await page.evaluate(() => {
                  interface PageMutationObserver {
                    disconnect(): void;
                    observe(target: unknown, options: {
                      attributes: boolean;
                      characterData: boolean;
                      childList: boolean;
                      subtree: boolean;
                    }): void;
                  }
                  const state = globalThis as unknown as {
                    document: unknown;
                    MutationObserver: new (
                      callback: (records: readonly unknown[]) => void,
                    ) => PageMutationObserver;
                    qualigenceMutationCount?: number;
                    qualigenceMutationObserver?: PageMutationObserver;
                  };
                  state.qualigenceMutationObserver?.disconnect();
                  state.qualigenceMutationCount = 0;
                  state.qualigenceMutationObserver = new state.MutationObserver((records) => {
                    state.qualigenceMutationCount =
                      (state.qualigenceMutationCount ?? 0) + records.length;
                  });
                  state.qualigenceMutationObserver.observe(state.document, {
                    attributes: true,
                    characterData: true,
                    childList: true,
                    subtree: true,
                  });
                });
              });
            }
            return graph;
          },
        };
        const runtime = new ExecutionRuntime({
          observer: runtimeObserver,
          decisionProvider: {
            decide: async () => valued(kind, "unused", valueRef) as never,
          },
          resolver: {
            resolve: async (_action, graph) => resolver.resolve(
              valued(kind, nodeNamed(graph, targetName).id, valueRef),
              graph,
            ) as never,
          },
          policyGate: new DeterministicRunnerPolicyGate(policy, {
            now: () => Date.parse("2026-08-21T00:00:00.000Z"),
          }),
          actionExecutor: executor,
          verifier: {
            verify: async () => ({ status: "passed", summary: "masked", claims: [] }),
          },
          traceRecorder: new InMemoryTraceRecorder(),
          objectiveOnlyMaximumWallClockMs: 10_000,
          objectiveOnlyMaximumModelTokens: 100,
        });
        return runtime.run({
          ...job,
          jobId: `job-${kind}-${maximumRisk}`,
          runId: `run-${kind}-${maximumRisk}`,
          target: { kind: "web", url: fixture.url },
          policy,
        });
      };

      await expect(run("Normal")).resolves.toMatchObject({
        status: "blocked",
        errorCode: "PolicyDenied",
      });
      expect(await session.withPage(async (page) => page.evaluate(() =>
        (globalThis as { qualigenceMutationCount?: number }).qualigenceMutationCount ?? -1,
      ))).toBe(0);
      expect(await session.withPage(async (page) =>
        page.locator(`[${PRIVATE_TARGET_ATTRIBUTE}]`).count(),
      )).toBe(0);

      await expect(run("ExternalSideEffect")).resolves.toMatchObject({ status: "passed" });
      expect(session.sensitiveTargets()).toHaveLength(3);
      expect(await session.withPage(async (page) =>
        page.locator(`[${PRIVATE_TARGET_ATTRIBUTE}]`).count(),
      )).toBe(3);
      const graphId = session.latestGraphId;
      const target = session.sensitiveTargets()[0];
      if (graphId === undefined || target === undefined) {
        throw new Error("Expected a registered sensitive target and observation.");
      }
      const screenshot = session.artifactsFor(graphId)
        .find((artifact) => artifact.mediaType === "image/png");
      const box = await target.handle.boundingBox();
      if (screenshot === undefined || box === null) {
        throw new Error("Expected a masked screenshot target.");
      }
      expectSolidCrop(decodePng(screenshot.bytes), box, [0, 0, 0, 255]);
    },
  );

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

  it("redacts only causally changed nodes after Chromium normalizes a single-line input", async () => {
    const source = "a\r\nb\r\n";
    const browserValue = "a b";
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
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await session.withPage(async (page) => page.locator("#normalized-reflection").allTextContents()))
      .toEqual([browserValue]);
    expect(await session.withPage(async (page) =>
      page.locator("#normalized-reflection-second").allTextContents()))
      .toEqual([`reflected:${browserValue}`]);
    const after = await observer.capture(job);
    const serialized = JSON.stringify(after);
    const redacted = after.nodes.filter((node) => node.name === "[REDACTED]");
    const artifact = session.artifactsFor(after.graphId)
      .find((candidate) => candidate.mediaType === "application/json");
    const artifactGraph = JSON.parse(new TextDecoder().decode(artifact?.bytes)) as ObservationGraph;
    const artifactRedacted = artifactGraph.nodes.filter((node) => node.name === "[REDACTED]");
    const screenshot = session.artifactsFor(after.graphId)
      .find((candidate) => candidate.mediaType === "image/png");
    const boxes = await session.withPage(async (page) => ({
      target: await page.locator('input[aria-label="Normalized secret"]').boundingBox(),
      firstReflection: await page.locator("#normalized-reflection").boundingBox(),
      secondReflection: await page.locator("#normalized-reflection-second").boundingBox(),
      unrelated: await page.locator("[data-unrelated-region]").boundingBox(),
    }));
    if (screenshot === undefined || Object.values(boxes).some((box) => box === null)) {
      throw new Error("Expected screenshot and bounded reflected regions.");
    }

    expect(serialized).not.toContain(source);
    expect(serialized).not.toContain(`reflected:${browserValue}`);
    expect(redacted).toHaveLength(3);
    expect(redacted).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "[REDACTED]", text: "[REDACTED]" }),
      expect.objectContaining({ text: "[REDACTED]" }),
      expect.objectContaining({ text: "[REDACTED]" }),
    ]));
    expect(artifactRedacted).toHaveLength(3);
    expect(session.sensitiveTargets().map((sensitive) => sensitive.nodeId).sort())
      .toEqual(redacted.map((node) => node.id).sort());
    expect(after.nodes.some((node) => node.text === "ab")).toBe(true);
    expect(artifactGraph.nodes.some((node) => node.text === "ab")).toBe(true);
    const image = decodePng(screenshot.bytes);
    expectSolidCrop(image, boxes.target!, [0, 0, 0, 255]);
    expectSolidCrop(image, boxes.firstReflection!, [0, 0, 0, 255]);
    expectSolidCrop(image, boxes.secondReflection!, [0, 0, 0, 255]);
    expectSolidCrop(image, boxes.unrelated!, [0, 255, 0, 255]);
  });

  it("redacts causally reflected URL fields and document title before serialization", async () => {
    const secret = "route-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.route"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface InputEventTarget { value: string }
      interface InputElement {
        addEventListener(type: string, listener: (event: { target: InputEventTarget }) => void): void;
      }
      const state = globalThis as unknown as {
        document: { title: string; querySelector(selector: string): InputElement | null };
        history: { replaceState(data: object, unused: string, url: string): void };
      };
      const source = state.document.querySelector('input[aria-label="Email"]');
      source?.addEventListener("input", (event) => {
        const value = event.target.value;
        state.history.replaceState({}, "", `/orders/${value}?keep=public&${value}=${value}#${value}`);
        state.document.title = `Receipt ${value}`;
      });
    }));

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    const after = await observer.capture(job);
    const artifact = session.artifactsFor(after.graphId)
      .find((candidate) => candidate.mediaType === "application/json");
    const serialized = JSON.stringify([after, new TextDecoder().decode(artifact?.bytes)]);

    expect(after.title).toBe("[REDACTED]");
    expect(after.url).toContain("keep=public");
    expect(after.url).toContain("%5BREDACTED%5D");
    expect(serialized).not.toContain(secret);
  });

  it("fails closed when URL or title contains an unproven sensitive form", async () => {
    const secret = "unproven-route-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.unproven-route"),
      before,
    );

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    await session.withPage(async (page) => page.evaluate((value) => {
      const state = globalThis as unknown as {
        document: { title: string };
        history: { replaceState(data: object, unused: string, url: string): void };
      };
      state.history.replaceState({}, "", `/outside/${value}`);
      state.document.title = value;
    }, secret));

    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(session.latestGraphId).toBe(before.graphId);
  });

  it("retains delayed reflection authority after a clean first capture", async () => {
    const secret = "late-after-capture-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.late"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface InputEventTarget { value: string }
      interface InputElement {
        addEventListener(type: string, listener: (event: { target: InputEventTarget }) => void): void;
      }
      interface TextElement { textContent: string | null }
      const state = globalThis as unknown as {
        document: {
          querySelector(selector: string): InputElement | null;
          getElementById(id: string): TextElement | null;
        };
        setTimeout(callback: () => void, delay: number): void;
      };
      state.document.querySelector('input[aria-label="Email"]')
        ?.addEventListener("input", (event) => {
          const value = event.target.value;
          state.setTimeout(() => {
            const reflected = state.document.getElementById("normalized-reflection-second");
            if (reflected !== null) reflected.textContent = value;
          }, 350);
        });
    }));

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    const clean = await observer.capture(job);
    expect(JSON.stringify(clean)).not.toContain(secret);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await observer.capture(job);
    const artifact = session.artifactsFor(after.graphId)
      .find((candidate) => candidate.mediaType === "application/json");
    const screenshot = session.artifactsFor(after.graphId)
      .find((candidate) => candidate.mediaType === "image/png");
    const reflectedBox = await session.withPage(async (page) =>
      page.locator("#normalized-reflection-second").boundingBox());
    if (screenshot === undefined || reflectedBox === null) {
      throw new Error("Expected delayed reflected screenshot evidence.");
    }

    expect(after.nodes.filter((node) => node.name === "[REDACTED]")).toHaveLength(4);
    expect(JSON.stringify([after, new TextDecoder().decode(artifact?.bytes)])).not.toContain(secret);
    expectSolidCrop(decodePng(screenshot.bytes), reflectedBox, [0, 0, 0, 255]);
  });

  it("keeps the exact authorized input event and synchronous reflections causal", async () => {
    const secret = "ab";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.authorized-event"),
      before,
    );

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    const after = await observer.capture(job);

    expect(after.nodes.filter((node) => node.name === "[REDACTED]")).toHaveLength(3);
    expect(after.nodes.filter((node) => node.text === secret)).toHaveLength(1);
    expect(JSON.stringify(after)).not.toContain('"value":"ab"');
  });

  it("poisons tracking when an unrelated input event carries the same sensitive form", async () => {
    const secret = "ab";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.event-causality"),
      before,
    );

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    await session.withPage(async (page) => page.evaluate((value) => {
      interface InputElement {
        value: string;
        dispatchEvent(event: unknown): void;
      }
      const state = globalThis as unknown as {
        document: { querySelector(selector: string): InputElement | null };
        Event: new (type: string, options: { bubbles: boolean }) => unknown;
      };
      const unrelated = state.document.querySelector(
        'input[aria-label="Input property reflection"]',
      );
      if (unrelated === null) return;
      unrelated.value = value;
      unrelated.dispatchEvent(new state.Event("input", { bubbles: true }));
    }, secret));

    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(session.latestGraphId).toBe(before.graphId);
    expect(() => session.artifactsFor(before.graphId)).toThrowError(
      expect.objectContaining({ code: "SensitiveEvidenceUnproven" }),
    );
  });

  it.each([
    ["option-count", 5_000, 1],
    ["option-value", 1, 64 * 1024 + 1],
  ] as const)(
    "fails bounded select normalization for hostile %s before transferring options",
    async (_case, optionCount, valueLength) => {
      session = new PlaywrightBrowserSession(options());
      await session.start();
      const observer = new PlaywrightObserver(session);
      const resolver = new PlaywrightActionResolver(session);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => "hostile-option" });
      const before = await observer.capture(job);
      const action = await resolver.resolve(
        valued("select", nodeNamed(before, "Country").id, "customer.hostile-options"),
        before,
      );
      await session.withPage(async (page) => page.evaluate(({ count, length }) => {
        interface TestNode { append(node: TestNode): void }
        interface OptionNode extends TestNode { value: string }
        const state = globalThis as unknown as {
          document: {
            querySelector(selector: string): TestNode | null;
            createDocumentFragment(): TestNode;
            createElement(tag: string): OptionNode;
          };
        };
        const select = state.document.querySelector('select[aria-label="Country"]');
        if (select === null) return;
        const fragment = state.document.createDocumentFragment();
        for (let index = 0; index < count; index += 1) {
          const option = state.document.createElement("option");
          option.value = "x".repeat(length);
          fragment.append(option);
        }
        select.append(fragment);
      }, { count: optionCount, length: valueLength }));

      await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
        code: "SensitiveEvidenceUnproven",
      });
      expect(session.latestGraphId).toBe(before.graphId);
    },
  );

  it("rejects a hostile source form by code-unit length before page action", async () => {
    const secret = "s".repeat(64 * 1024 + 1);
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.hostile-source"),
      before,
    );

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(await session.withPage(async (page) =>
      page.locator('input[aria-label="Email"]').inputValue())).toBe("");
    expect(session.latestGraphId).toBe(before.graphId);
  });

  it.each([
    ["input", "Email", "customer.property-input", "property-input-secret", "Input property reflection"],
    ["select", "Country", "customer.property-select", "private-country-code", "Select property reflection"],
  ] as const)(
    "redacts a control changed only through an %s event property assignment",
    async (kind, targetName, valueRef, secret, reflectedName) => {
      session = new PlaywrightBrowserSession(options());
      await session.start();
      const observer = new PlaywrightObserver(session);
      const resolver = new PlaywrightActionResolver(session);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
      const before = await observer.capture(job);
      const action = await resolver.resolve(
        valued(kind, nodeNamed(before, targetName).id, valueRef),
        before,
      );

      expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
      const reflectedHandle = await session.withPage(async (page) =>
        page.getByRole("textbox", { name: reflectedName }).elementHandle());
      const after = await observer.capture(job);
      const screenshot = session.artifactsFor(after.graphId)
        .find((artifact) => artifact.mediaType === "image/png");
      const reflectedEvidence = reflectedHandle === null ? undefined : await session.withPage(async () => {
        for (const sensitive of session.sensitiveTargets()) {
          if (await sensitive.handle.evaluate(
            (element, reflectedElement) => element === reflectedElement,
            reflectedHandle,
          )) {
            return {
              box: await sensitive.handle.boundingBox(),
              nodeId: sensitive.nodeId,
            };
          }
        }
        return undefined;
      });
      await reflectedHandle?.dispose();
      if (reflectedEvidence?.box === null || reflectedEvidence?.box === undefined ||
          reflectedEvidence.nodeId === undefined || screenshot === undefined) {
        throw new Error("Expected property-reflected screenshot evidence.");
      }

      expect(after.nodes.filter((node) => node.text === secret)).toHaveLength(1);
      expect(after.nodes.find((node) => node.id === reflectedEvidence.nodeId)).toMatchObject({
        name: "[REDACTED]",
        value: "[REDACTED]",
        text: "[REDACTED]",
      });
      expectSolidCrop(decodePng(screenshot.bytes), reflectedEvidence.box, [0, 0, 0, 255]);
    },
  );

  it("poisons all later evidence capture when actual browser-form extraction fails", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "form-secret" });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.form"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface InputElement {
        addEventListener(type: string, listener: () => void): void;
      }
      const state = globalThis as unknown as {
        document: { querySelector(selector: string): InputElement | null };
      };
      const source = state.document.querySelector('input[aria-label="Email"]');
      source?.addEventListener("input", () => {
        Object.defineProperty(source, "value", {
          configurable: true,
          get() {
            throw new Error("actual form unavailable");
          },
        });
      });
    }));

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(() => session.artifactsFor(before.graphId)).toThrowError(
      expect.objectContaining({ code: "SensitiveEvidenceUnproven" }),
    );
  });

  it("poisons all later evidence capture when the post-action property snapshot fails", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "snapshot-secret" });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.snapshot"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface InputElement {
        value: string;
        addEventListener(type: string, listener: () => void): void;
      }
      const state = globalThis as unknown as {
        document: { querySelector(selector: string): InputElement | null };
      };
      const source = state.document.querySelector('input[aria-label="Email"]');
      const reflected = state.document.querySelector(
        'input[aria-label="Input property reflection"]',
      );
      source?.addEventListener("input", () => {
        if (reflected === null) return;
        Object.defineProperty(reflected, "value", {
          configurable: true,
          get() {
            throw new Error("post-action snapshot failed");
          },
        });
      });
    }));

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(() => session.artifactsFor(before.graphId)).toThrowError(
      expect.objectContaining({ code: "SensitiveEvidenceUnproven" }),
    );
    expect(session.latestGraphId).toBe(before.graphId);
  });

  it("fails closed before a sensitive action when property snapshot candidates overflow", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "overflow-secret" });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.candidate-overflow"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestNode {
        append(node: TestNode): void;
        setAttribute(name: string, value: string): void;
      }
      const state = globalThis as unknown as {
        document: {
          body: { append(node: TestNode): void };
          createDocumentFragment(): TestNode;
          createElement(tag: string): TestNode;
        };
      };
      const fragment = state.document.createDocumentFragment();
      for (let index = 0; index < 513; index += 1) {
        const input = state.document.createElement("input");
        input.setAttribute("aria-label", `candidate-${index}`);
        fragment.append(input);
      }
      state.document.body.append(fragment);
    }));

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(await session.withPage(async (page) =>
      page.locator('input[aria-label="Email"]').inputValue(),
    )).toBe("");
  });

  it("fails closed when sensitive provenance tracking cannot be installed", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "observer-secret" });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Normalized secret").id, "customer.observer"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      Object.defineProperty(globalThis, "MutationObserver", {
        configurable: true,
        value: class {
          constructor() {
            throw new Error("observer unavailable");
          }
        },
      });
    }));

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(session.latestGraphId).toBe(before.graphId);
  });

  it("fails closed when sensitive action mutations exceed the bounded tracker", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "overflow-secret" });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Normalized secret").id, "customer.overflow"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      const state = globalThis as unknown as {
        document: {
          querySelector(selector: string): { addEventListener(type: string, listener: () => void): void } | null;
          getElementById(id: string): { setAttribute(name: string, value: string): void } | null;
        };
      };
      state.document.querySelector('input[aria-label="Normalized secret"]')?.addEventListener("input", () => {
        const reflection = state.document.getElementById("normalized-reflection");
        for (let index = 0; index < 129; index += 1) {
          reflection?.setAttribute(`data-overflow-${index}`, "overflow-secret");
        }
      });
    }));

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
  });

  it("fails closed when a reflected secret node is removed before evidence", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "removed-secret" });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Normalized secret").id, "customer.removed"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestNode {
        textContent: string | null;
        remove(): void;
      }
      const state = globalThis as unknown as {
        document: {
          body: { append(node: TestNode): void };
          createElement(tag: string): TestNode;
          querySelector(selector: string): {
            addEventListener(type: string, listener: (event: { target: { value: string } }) => void): void;
          } | null;
        };
      };
      state.document.querySelector('input[aria-label="Normalized secret"]')?.addEventListener("input", (event) => {
        const reflected = state.document.createElement("p");
        reflected.textContent = event.target.value;
        state.document.body.append(reflected);
        reflected.remove();
      });
    }));

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await expect(observer.capture(job)).resolves.toMatchObject({ graphId: expect.any(String) });
  });

  it.each([
    ["input", "Email", "ambiguous-input-secret"],
    ["select", "Country", "private-country-code"],
  ] as const)(
    "fails evidence closed when an unrelated node concurrently changes to the same %s value",
    async (kind, targetName, secret) => {
      session = new PlaywrightBrowserSession(options());
      await session.start();
      const observer = new PlaywrightObserver(session);
      const resolver = new PlaywrightActionResolver(session);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
      const before = await observer.capture(job);
      const action = await resolver.resolve(
        valued(kind, nodeNamed(before, targetName).id, `customer.ambiguous-${kind}`),
        before,
      );

      expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
      await session.withPage(async (page) => page.evaluate((value) => {
        const state = globalThis as unknown as {
          document: { querySelector(selector: string): { textContent: string | null } | null };
        };
        const unrelated = state.document.querySelector("[data-unrelated-region]");
        if (unrelated !== null) unrelated.textContent = value;
      }, secret));

      await expect(observer.capture(job)).rejects.toMatchObject({
        code: "SensitiveEvidenceUnproven",
      });
      expect(session.latestGraphId).toBe(before.graphId);
      expect(() => session.artifactsFor(before.graphId)).toThrowError(
        expect.objectContaining({ code: "SensitiveEvidenceUnproven" }),
      );
    },
  );

  it.each(["input", "select"] as const)(
    "fails bounded observation before materializing hostile oversized %s text",
    async (kind) => {
      session = new PlaywrightBrowserSession(options());
      await session.start();
      const observer = new PlaywrightObserver(session);
      const resolver = new PlaywrightActionResolver(session);
      const secret = kind === "input" ? "oversized-input-secret" : "private-country-code";
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
      const before = await observer.capture(job);
      const action = await resolver.resolve(
        valued(kind, nodeNamed(before, kind === "input" ? "Email" : "Country").id, `customer.large-${kind}`),
        before,
      );
      expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
      await session.withPage(async (page) => page.evaluate(() => {
        interface TestElement {
          setAttribute(name: string, value: string): void;
          textContent: string | null;
        }
        const state = globalThis as unknown as {
          document: {
            body: { append(element: TestElement): void };
            createElement(tag: string): TestElement;
          };
        };
        const hostile = state.document.createElement("p");
        hostile.setAttribute("data-qualigence-observe", "");
        hostile.textContent = "x".repeat(64 * 1024 + 1);
        state.document.body.append(hostile);
      }));

      await expect(observer.capture(job)).rejects.toMatchObject({
        code: "SensitiveEvidenceUnproven",
      });
      expect(session.latestGraphId).toBe(before.graphId);
    },
  );

  it("keeps the exact acted element redacted when its accessible identity changes", async () => {
    const source = "a\r\nb\r\n";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => source });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Mutable secret").id, "customer.mutable"),
      before,
    );

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    const after = await observer.capture(job);
    const target = nodeNamed(after, "[REDACTED]");
    const observationArtifact = session.artifactsFor(after.graphId)
      .find((artifact) => artifact.mediaType === "application/json");
    const screenshotArtifact = session.artifactsFor(after.graphId)
      .find((artifact) => artifact.mediaType === "image/png");
    const artifactGraph = JSON.parse(
      new TextDecoder().decode(observationArtifact?.bytes),
    ) as ObservationGraph;
    const boxes = await session.withPage(async (page) => ({
      target: await session.sensitiveTargets()[0]?.handle.boundingBox(),
      unrelated: await page.locator("[data-unrelated-region]").boundingBox(),
    }));
    if (
      boxes.target === null ||
      boxes.target === undefined ||
      boxes.unrelated === null ||
      screenshotArtifact === undefined
    ) {
      throw new Error("Expected screenshot regions and artifact.");
    }

    expect(target).toMatchObject({ value: "[REDACTED]", text: "[REDACTED]" });
    expect(nodeNamed(artifactGraph, "[REDACTED]"))
      .toMatchObject({ name: "[REDACTED]", value: "[REDACTED]", text: "[REDACTED]" });
    expect(after.nodes.some((node) => node.text === "ab")).toBe(true);
    const image = decodePng(screenshotArtifact.bytes);
    expectSolidCrop(image, boxes.target, [0, 0, 0, 255]);
    expectSolidCrop(image, boxes.unrelated, [0, 255, 0, 255]);
  });

  it("fails closed before artifacts when an earlier sensitive target is replaced", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, {
      resolve: async (valueRef) => valueRef === "customer.country"
        ? "private-country-code"
        : "replace-secret",
    });
    const before = await observer.capture(job);
    const inputAction = await resolver.resolve(
      valued("input", nodeNamed(before, "Mutable secret").id, "customer.replace"),
      before,
    );

    expect(await executor.execute(inputAction, allowedPermit())).toEqual({ status: "ok" });
    const afterInput = await observer.capture(job);
    const selectAction = await resolver.resolve(
      valued("select", nodeNamed(afterInput, "Country").id, "customer.country"),
      afterInput,
    );
    expect(await executor.execute(selectAction, allowedPermit())).toEqual({ status: "ok" });
    await session.withPage(async (page) => {
      await page.getByRole("textbox", { name: "replace-secret" }).evaluate((element) => {
        element.replaceWith(element.cloneNode(true));
      });
    });

    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(session.latestGraphId).toBe(afterInput.graphId);
    expect(() => session.artifactsFor("run-click:observation:3")).toThrowError(
      expect.objectContaining({ code: "SensitiveEvidenceUnproven" }),
    );
  });
});

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly pixels: Buffer;
}

function decodePng(bytes: Uint8Array): DecodedPng {
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
  if (channels === 0) throw new Error("Unsupported PNG color type.");
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
  return { width, height, channels, pixels };
}

function expectSolidCrop(
  image: DecodedPng,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  expected: readonly [number, number, number, number],
): void {
  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const right = Math.min(image.width, Math.ceil(box.x + box.width));
  const bottom = Math.min(image.height, Math.ceil(box.y + box.height));
  if (left >= right || top >= bottom) throw new Error("Crop does not intersect the PNG.");
  const stride = image.width * image.channels;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = y * stride + x * image.channels;
      expect([
        image.pixels[offset]!,
        image.pixels[offset + 1]!,
        image.pixels[offset + 2]!,
        image.channels === 4 ? image.pixels[offset + 3]! : 255,
      ], `pixel (${x}, ${y})`).toEqual(expected);
    }
  }
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
