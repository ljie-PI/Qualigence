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
  chromiumLauncher,
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

type PromiseScenario =
  | "base-undefined"
  | "base-value"
  | "base-resolved-promise"
  | "base-rejected-promise"
  | "base-source-rejection"
  | "base-custom-thenable"
  | "subclass-default-species"
  | "subclass-overridden-species"
  | "instance-custom-then"
  | "current-prototype-custom-then"
  | "prototype-custom-then"
  | "returned-promise-custom-then"
  | "hostile-thenable"
  | "catch-current-then";

interface PromiseScenarioObservation {
  readonly events: readonly string[];
  readonly customThenCalls: number;
  readonly speciesConstructorCalls: number;
  readonly callbackCalls: number;
  readonly settlement: "fulfilled" | "rejected";
  readonly settledValueIdentity: boolean;
  readonly settledReasonIdentity: boolean;
  readonly nativeCatchUnchanged: boolean;
  readonly nativeFinallyUnchanged: boolean;
  readonly catchSource: string;
  readonly finallySource: string;
}

async function promiseScenarioPage(
  input: { readonly scenario: PromiseScenario; readonly installOnInput: boolean },
): Promise<PromiseScenarioObservation | { readonly installed: true }> {
  const nativeCatch = Promise.prototype.catch;
  const nativeFinally = Promise.prototype.finally;
  let currentEvents: string[] | undefined;
  let currentPrototypeThenCalls = 0;
  if (input.scenario === "current-prototype-custom-then") {
    const inheritedThen = Promise.prototype.then;
    Promise.prototype.then = function (...args) {
      currentPrototypeThenCalls += 1;
      currentEvents?.push("current-prototype-then");
      return Reflect.apply(inheritedThen, this, args);
    };
  }
  const run = async (): Promise<PromiseScenarioObservation> => {
    const events: string[] = [];
    currentEvents = events;
    const sourceValue = { identity: "source-value" };
    const sourceReason = { identity: "source-reason" };
    const callbackValue = { identity: "callback-value" };
    const callbackReason = { identity: "callback-reason" };
    let expectedValue: unknown = sourceValue;
    let expectedReason: unknown;
    let customThenCalls = 0;
    let speciesConstructorCalls = 0;
    let callbackCalls = 0;
    let result: Promise<unknown>;

    const onfinally = (returned: unknown): (() => unknown) => () => {
      callbackCalls += 1;
      events.push("finally-callback");
      return returned;
    };

    events.push("scenario-start");
    switch (input.scenario) {
      case "base-undefined":
        result = Promise.resolve(sourceValue).finally(onfinally(undefined));
        break;
      case "base-value":
        result = Promise.resolve(sourceValue).finally(onfinally(callbackValue));
        break;
      case "base-resolved-promise":
        result = Promise.resolve(sourceValue).finally(onfinally(Promise.resolve(callbackValue)));
        break;
      case "base-rejected-promise":
        expectedValue = undefined;
        expectedReason = callbackReason;
        result = Promise.resolve(sourceValue).finally(onfinally(Promise.reject(callbackReason)));
        break;
      case "base-source-rejection":
        expectedValue = undefined;
        expectedReason = sourceReason;
        result = Promise.reject(sourceReason).finally(onfinally(undefined));
        break;
      case "base-custom-thenable":
        result = Promise.resolve(sourceValue).finally(onfinally({
          then(resolve: (value: unknown) => void): void {
            customThenCalls += 1;
            events.push("custom-then");
            resolve(callbackValue);
          },
        }));
        break;
      case "subclass-default-species": {
        class DefaultSpeciesPromise<T> extends Promise<T> {
          constructor(executor: (
            resolve: (value: T | PromiseLike<T>) => void,
            reject: (reason?: unknown) => void,
          ) => void) {
            speciesConstructorCalls += 1;
            events.push("default-species-constructor");
            super(executor);
          }
        }
        result = new DefaultSpeciesPromise<unknown>((resolve) => resolve(sourceValue))
          .finally(onfinally(callbackValue));
        break;
      }
      case "subclass-overridden-species": {
        class ResultSpeciesPromise<T> extends Promise<T> {
          constructor(executor: (
            resolve: (value: T | PromiseLike<T>) => void,
            reject: (reason?: unknown) => void,
          ) => void) {
            speciesConstructorCalls += 1;
            events.push("result-species-constructor");
            super(executor);
          }
        }
        class ReceiverPromise<T> extends Promise<T> {
          static get [Symbol.species](): PromiseConstructor { return ResultSpeciesPromise; }
        }
        result = new ReceiverPromise<unknown>((resolve) => resolve(sourceValue))
          .finally(onfinally(callbackValue));
        break;
      }
      case "instance-custom-then": {
        const receiver = Promise.resolve(sourceValue);
        const inheritedThen = receiver.then;
        receiver.then = function (...args) {
          customThenCalls += 1;
          events.push("instance-then");
          return Reflect.apply(inheritedThen, this, args);
        };
        result = receiver.finally(onfinally(callbackValue));
        break;
      }
      case "current-prototype-custom-then":
        result = Promise.resolve(sourceValue).finally(onfinally(callbackValue));
        break;
      case "prototype-custom-then": {
        class PrototypeThenPromise<T> extends Promise<T> {
          constructor(executor: (
            resolve: (value: T | PromiseLike<T>) => void,
            reject: (reason?: unknown) => void,
          ) => void) {
            speciesConstructorCalls += 1;
            events.push("prototype-species-constructor");
            super(executor);
          }

          override then<TResult1 = T, TResult2 = never>(
            onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ): Promise<TResult1 | TResult2> {
            customThenCalls += 1;
            events.push("prototype-then");
            return super.then(onfulfilled, onrejected);
          }
        }
        result = new PrototypeThenPromise<unknown>((resolve) => resolve(sourceValue))
          .finally(onfinally(callbackValue));
        break;
      }
      case "returned-promise-custom-then": {
        const returned = Promise.resolve(callbackValue);
        const inheritedThen = returned.then;
        returned.then = function (...args) {
          customThenCalls += 1;
          events.push("returned-promise-then");
          return Reflect.apply(inheritedThen, this, args);
        };
        result = Promise.resolve(sourceValue).finally(onfinally(returned));
        break;
      }
      case "hostile-thenable":
        result = Promise.resolve(sourceValue).finally(onfinally({
          then(resolve: (value: unknown) => void, reject: (reason: unknown) => void): void {
            customThenCalls += 1;
            events.push("hostile-then");
            events.push("resolve-first");
            resolve(callbackValue);
            events.push("reject-second");
            reject(sourceReason);
            events.push("resolve-third");
            resolve(sourceValue);
            events.push("throw-after-resolve");
            throw callbackReason;
          },
        }));
        break;
      case "catch-current-then": {
        const receiver = Promise.reject(sourceReason);
        const inheritedThen = receiver.then;
        receiver.then = function (...args) {
          customThenCalls += 1;
          events.push("catch-receiver-then");
          return Reflect.apply(inheritedThen, this, args);
        };
        expectedValue = callbackValue;
        result = receiver.catch((reason) => {
          callbackCalls += 1;
          events.push("catch-callback");
          if (reason !== sourceReason) throw new Error("reason identity changed");
          return callbackValue;
        });
        break;
      }
    }

    try {
      const value = await result;
      events.push("settled-fulfilled");
      return {
        events,
        customThenCalls: customThenCalls + currentPrototypeThenCalls,
        speciesConstructorCalls,
        callbackCalls,
        settlement: "fulfilled",
        settledValueIdentity: value === expectedValue,
        settledReasonIdentity: false,
        nativeCatchUnchanged: Promise.prototype.catch === nativeCatch,
        nativeFinallyUnchanged: Promise.prototype.finally === nativeFinally,
        catchSource: Function.prototype.toString.call(Promise.prototype.catch),
        finallySource: Function.prototype.toString.call(Promise.prototype.finally),
      };
    } catch (reason) {
      events.push("settled-rejected");
      return {
        events,
        customThenCalls: customThenCalls + currentPrototypeThenCalls,
        speciesConstructorCalls,
        callbackCalls,
        settlement: "rejected",
        settledValueIdentity: false,
        settledReasonIdentity: reason === expectedReason,
        nativeCatchUnchanged: Promise.prototype.catch === nativeCatch,
        nativeFinallyUnchanged: Promise.prototype.finally === nativeFinally,
        catchSource: Function.prototype.toString.call(Promise.prototype.catch),
        finallySource: Function.prototype.toString.call(Promise.prototype.finally),
      };
    }
  };

  if (!input.installOnInput) return run();
  const source = (globalThis as unknown as {
    document: {
      querySelector(selector: string): {
        addEventListener(type: string, listener: () => void, options: { readonly once: boolean }): void;
      } | null;
    };
  }).document.querySelector('input[aria-label="Email"]');
  if (source === null) throw new Error("matrix input unavailable");
  source.addEventListener("input", () => {
    void (async () => {
      (globalThis as typeof globalThis & { promiseScenarioObservation?: PromiseScenarioObservation })
        .promiseScenarioObservation = await run();
    })();
  }, { once: true });
  return { installed: true };
}

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

  it.each([32, 33] as const)(
    "counts a different-receiver Promise registration at the %i boundary",
    async (registrations) => {
      session = new PlaywrightBrowserSession(options());
      await session.start();
      const observer = new PlaywrightObserver(session);
      const resolver = new PlaywrightActionResolver(session);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => "receiver-secret" });
      const before = await observer.capture(job);
      const action = await resolver.resolve(
        valued("input", nodeNamed(before, "Email").id, "customer.receiver-boundary"),
        before,
      );
      await session.withPage(async (page) => page.evaluate((count) => {
        const source = (globalThis as unknown as {
          document: { querySelector(selector: string): { addEventListener(type: string, listener: () => void): void } | null };
        }).document.querySelector('input[aria-label="Email"]');
        source?.addEventListener("input", () => {
          for (let index = 0; index < count; index += 1) {
            const receiver = Promise.reject(index);
            const baseThen = receiver.then;
            receiver.then = function (...args) {
              Promise.resolve(index).then(() => undefined);
              return Reflect.apply(baseThen, this, args);
            };
            receiver.catch(() => undefined);
          }
        });
      }, registrations));

      const execution = executor.execute(action, allowedPermit());
      if (registrations === 33) {
        await expect(execution).rejects.toMatchObject({ code: "SensitiveEvidenceUnproven" });
      } else {
        await expect(execution).resolves.toEqual({ status: "ok" });
      }
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

  it("redacts and masks causal text and input reflections in an open shadow root", async () => {
    const secret = "open-shadow-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement {
        value: string;
        textContent: string | null;
        innerHTML: string;
        attachShadow(init: { mode: "open" }): TestRoot;
        addEventListener(type: string, listener: (event: { target: TestElement }) => void): void;
      }
      interface TestRoot {
        innerHTML: string;
        querySelector(selector: string): TestElement | null;
      }
      const state = globalThis as unknown as {
        document: {
          body: { append(element: TestElement): void };
          createElement(tag: string): TestElement;
          querySelector(selector: string): TestElement | null;
        };
      };
      const source = state.document.querySelector('input[aria-label="Email"]');
      const host = state.document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `
        <p data-qualigence-observe id="shadow-text" style="position:fixed;left:500px;top:80px;background:rgb(255,0,0);width:120px;height:40px;margin:0"></p>
        <input aria-label="Shadow reflection" style="position:fixed;left:500px;top:140px;background:rgb(255,0,0);border:0;padding:0;width:120px;height:40px" />
      `;
      state.document.body.append(host);
      source?.addEventListener("input", (event) => {
        const value = event.target.value;
        const text = root.querySelector("#shadow-text");
        const input = root.querySelector('input[aria-label="Shadow reflection"]');
        if (text !== null) text.textContent = value;
        if (input !== null) input.value = value;
      });
    }));
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.open-shadow"),
      before,
    );

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    const after = await observer.capture(job);
    const screenshot = session.artifactsFor(after.graphId)
      .find((artifact) => artifact.mediaType === "image/png");
    const boxes = await session.withPage(async (page) => ({
      text: await page.locator("#shadow-text").boundingBox(),
      input: await page.getByRole("textbox", { name: "Shadow reflection" }).boundingBox(),
    }));
    if (screenshot === undefined || boxes.text === null || boxes.input === null) {
      throw new Error("Expected open-shadow screenshot evidence.");
    }

    expect(JSON.stringify(after)).not.toContain(secret);
    expect(after.nodes.filter((node) => node.name === "[REDACTED]")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "[REDACTED]" }),
        expect.objectContaining({ value: "[REDACTED]" }),
      ]),
    );
    const image = decodePng(screenshot.bytes);
    expectSolidCrop(image, boxes.text, [0, 0, 0, 255]);
    expectSolidCrop(image, boxes.input, [0, 0, 0, 255]);
  });

  it("redacts a causal text reflection in a closed shadow root", async () => {
    const secret = "closed-shadow-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement {
        value: string;
        textContent: string | null;
        style: { cssText: string };
        setAttribute(name: string, value: string): void;
        attachShadow(init: { mode: "closed" }): { append(element: TestElement): void };
        addEventListener(type: string, listener: (event: { target: TestElement }) => void): void;
      }
      const state = globalThis as unknown as {
        document: {
          body: { append(element: TestElement): void };
          createElement(tag: string): TestElement;
          querySelector(selector: string): TestElement | null;
        };
      };
      const source = state.document.querySelector('input[aria-label="Email"]');
      const host = state.document.createElement("div");
      const root = host.attachShadow({ mode: "closed" });
      const reflection = state.document.createElement("p");
      reflection.setAttribute("data-qualigence-observe", "");
      reflection.style.cssText = "position:fixed;left:500px;top:80px;background:rgb(255,0,0);width:120px;height:40px;margin:0";
      root.append(reflection);
      state.document.body.append(host);
      source?.addEventListener("input", (event) => {
        reflection.textContent = event.target.value;
      });
    }));
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.closed-shadow"),
      before,
    );

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    const after = await observer.capture(job);
    expect(JSON.stringify(after)).not.toContain(secret);
    expect(after.nodes).toContainEqual(expect.objectContaining({
      name: "[REDACTED]",
      text: "[REDACTED]",
      value: "[REDACTED]",
    }));
  });

  it("redacts and masks a property-only reflection in an app-created closed shadow root", async () => {
    const secret = "closed-property-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const reflection = await session.withPage(async (page) => page.evaluateHandle(() => {
      interface TestElement {
        value: string;
        style: { cssText: string };
        setAttribute(name: string, value: string): void;
        addEventListener(type: string, listener: (event: { target: TestElement }) => void): void;
        attachShadow(init: { mode: "closed" }): { append(element: TestElement): void };
      }
      const state = globalThis as unknown as {
        document: {
          body: { append(element: TestElement): void };
          createElement(tag: string): TestElement;
          querySelector(selector: string): TestElement | null;
        };
      };
      const source = state.document.querySelector('input[aria-label="Email"]');
      const host = state.document.createElement("div");
      const root = host.attachShadow({ mode: "closed" });
      const reflected = state.document.createElement("input");
      reflected.setAttribute("aria-label", "Closed property reflection");
      reflected.style.cssText = "position:fixed;left:500px;top:200px;background:rgb(255,0,0);border:0;padding:0;width:120px;height:40px";
      root.append(reflected);
      state.document.body.append(host);
      source?.addEventListener("input", (event) => {
        reflected.value = event.target.value;
      });
      return reflected;
    }));
    const reflectedElement = reflection.asElement();
    if (reflectedElement === null) throw new Error("Expected a retained closed-root element.");
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.closed-property"),
      before,
    );

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    const after = await observer.capture(job);
    expect(await Promise.all(session.sensitiveTargets().map((target) =>
      target.handle.evaluate((element, expected) => element === expected, reflectedElement),
    ))).toContain(true);
    const closedTarget = session.sensitiveTargets().find((target) => target.closedShadowRoot);
    expect(closedTarget).toBeDefined();
    expect(after.nodes.find((node) => node.id === closedTarget?.nodeId)).toMatchObject({
      name: "[REDACTED]",
      value: "[REDACTED]",
      text: "[REDACTED]",
    });
    const artifact = session.artifactsFor(after.graphId)
      .find((candidate) => candidate.mediaType === "application/json");
    const screenshot = session.artifactsFor(after.graphId)
      .find((candidate) => candidate.mediaType === "image/png");
    const box = await reflectedElement.boundingBox();
    await reflection.dispose();
    if (artifact === undefined || screenshot === undefined || box === null) {
      throw new Error("Expected bounded closed-root evidence.");
    }

    expect(after.nodes).toContainEqual(expect.objectContaining({
      name: "[REDACTED]",
      value: "[REDACTED]",
      text: "[REDACTED]",
    }));
    expect(JSON.stringify(after)).not.toContain(secret);
    expect(new TextDecoder().decode(artifact.bytes)).not.toContain(secret);
    expectSolidCrop(decodePng(screenshot.bytes), box, [0, 0, 0, 255]);
  });

  it("keeps the shadow registry private and fails closed after attachShadow tampering", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "tamper-secret" });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.shadow-tamper"),
      before,
    );

    expect(await session.withPage(async (page) => page.evaluate(() =>
      Object.prototype.hasOwnProperty.call(globalThis, "__qualigenceShadowRegistry"),
    ))).toBe(false);
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement {
        attachShadow(init: unknown): unknown;
      }
      const prototype = (globalThis as unknown as {
        Element: { prototype: TestElement };
      }).Element.prototype;
      const installed = prototype.attachShadow;
      prototype.attachShadow = function (init: unknown) {
        return Reflect.apply(installed, this, [init]);
      };
    }));

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(JSON.stringify(before)).not.toContain("tamper-secret");
    expect(() => session.artifactsFor(before.graphId)).toThrowError(
      expect.objectContaining({ code: "SensitiveEvidenceUnproven" }),
    );
  });

  it("fails before action when a closed root bypasses the realm registry", async () => {
    const secret = "cross-realm-shadow-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.cross-realm-shadow"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement {
        contentWindow?: { Element: { prototype: { attachShadow(init: unknown): unknown } } };
      }
      const state = globalThis as unknown as {
        document: {
          body: { append(element: TestElement): void };
          createElement(tag: string): TestElement;
        };
      };
      const iframe = state.document.createElement("iframe");
      state.document.body.append(iframe);
      const foreignAttachShadow = iframe.contentWindow?.Element.prototype.attachShadow;
      if (foreignAttachShadow === undefined) throw new Error("Expected a reachable iframe realm.");
      const host = state.document.createElement("div");
      Reflect.apply(foreignAttachShadow, host, [{ mode: "closed" }]);
      state.document.body.append(host);
    }));

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(await session.withPage(async (page) =>
      page.locator('input[aria-label="Email"]').inputValue())).toBe("");
    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(session.latestGraphId).toBe(before.graphId);
  });

  it("fails closed for a declarative shadow root before registering evidence", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "declarative-secret" });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.declarative-shadow"),
      before,
    );
    const supported = await session.withPage(async (page) => page.evaluate(() => {
      interface TestHost {
        getHTML?: (options: { serializableShadowRoots: boolean }) => string;
        querySelector(selector: string): unknown;
      }
      interface TestContainer {
        setHTMLUnsafe?: (html: string) => void;
        querySelector(selector: string): TestHost | null;
      }
      const state = globalThis as unknown as {
        document: {
          body: { append(element: TestContainer): void };
          createElement(tag: string): TestContainer;
        };
      };
      const container = state.document.createElement("div");
      if (container.setHTMLUnsafe === undefined) return false;
      container.setHTMLUnsafe(
        '<div id="declarative"><template shadowrootmode="closed"><span>private</span></template></div>',
      );
      state.document.body.append(container);
      const host = container.querySelector("#declarative");
      return host !== null && host.querySelector("template") === null &&
        host.getHTML?.({ serializableShadowRoots: true }).includes("shadowrootmode") === true;
    }));
    if (!supported) return;

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(await session.withPage(async (page) =>
      page.locator('input[aria-label="Email"]').inputValue())).toBe("");
    expect(session.latestGraphId).toBe(before.graphId);
  });

  it("rewrites sensitive screenshot pixels despite hostile application CSS", async () => {
    const secret = "hostile-css-mask-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const reflection = await session.withPage(async (page) => page.evaluateHandle(() => {
      interface TestStyle { setProperty(name: string, value: string, priority: string): void }
      interface TestElement {
        value: string;
        textContent: string | null;
        style: TestStyle;
        setAttribute(name: string, value: string): void;
        addEventListener(type: string, listener: (event: { target: TestElement }) => void): void;
        attachShadow(init: { mode: "closed" }): { append(element: TestElement): void };
      }
      const state = globalThis as unknown as {
        document: {
          body: { append(element: TestElement): void };
          head: { append(element: TestElement): void };
          createElement(tag: string): TestElement;
          querySelector(selector: string): TestElement | null;
        };
      };
      const style = state.document.createElement("style");
      style.textContent = "*{all:unset!important;transform:translate(300px,300px)!important}";
      state.document.head.append(style);
      const source = state.document.querySelector('input[aria-label="Email"]');
      const host = state.document.createElement("div");
      const root = host.attachShadow({ mode: "closed" });
      const reflected = state.document.createElement("input");
      reflected.setAttribute("aria-label", "Hostile CSS reflection");
      for (const [name, value] of Object.entries({
        position: "fixed", left: "400px", top: "80px", width: "80px", height: "40px",
        background: "rgb(255, 0, 0)", transform: "none",
      })) reflected.style.setProperty(name, value, "important");
      root.append(reflected);
      state.document.body.append(host);
      const unrelated = state.document.createElement("div");
      unrelated.setAttribute("data-hostile-css-unrelated", "");
      for (const [name, value] of Object.entries({
        position: "fixed", left: "520px", top: "80px", width: "80px", height: "40px",
        background: "rgb(0, 255, 0)", transform: "none",
      })) unrelated.style.setProperty(name, value, "important");
      state.document.body.append(unrelated);
      source?.addEventListener("input", (event) => {
        reflected.value = event.target.value;
      });
      return reflected;
    }));
    const reflectedElement = reflection.asElement();
    if (reflectedElement === null) throw new Error("Expected a closed-root reflection.");
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.hostile-css-mask"),
      before,
    );

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    const after = await observer.capture(job);
    const screenshot = session.artifactsFor(after.graphId)
      .find((artifact) => artifact.mediaType === "image/png");
    const sensitiveBox = await reflectedElement.boundingBox();
    const unrelatedBox = await session.withPage(async (page) =>
      page.locator("[data-hostile-css-unrelated]").boundingBox());
    await reflection.dispose();
    if (screenshot === undefined || sensitiveBox === null || unrelatedBox === null) {
      throw new Error("Expected bounded hostile-CSS screenshot regions.");
    }
    const image = decodePng(screenshot.bytes);
    expectSolidCrop(image, sensitiveBox, [0, 0, 0, 255]);
    expectSolidCrop(image, unrelatedBox, [0, 255, 0, 255]);
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

  it("preserves unchanged pre-action URL and title text equal to a sensitive form", async () => {
    const secret = "a";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement { cloneNode(deep: boolean): TestElement; replaceWith(node: TestElement): void }
      const state = globalThis as unknown as {
        document: { title: string; querySelector(selector: string): TestElement | null };
        history: { replaceState(data: object, unused: string, url: string): void };
      };
      const source = state.document.querySelector('input[aria-label="Email"]');
      if (source !== null) source.replaceWith(source.cloneNode(true));
      state.history.replaceState({}, "", "/Page-a?existing=a#existing-a");
      state.document.title = "Page a";
    }));
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.short"),
      before,
    );

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    const after = await observer.capture(job);

    expect(after.url).toContain("/Page-a?existing=a#existing-a");
    expect(after.title).toBe("Page a");
  });

  it("redacts metadata changed from an equal pre-action baseline during the action", async () => {
    const secret = "a";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement {
        addEventListener(type: string, listener: () => void): void;
        cloneNode(deep: boolean): TestElement;
        replaceWith(node: TestElement): void;
      }
      const state = globalThis as unknown as {
        document: { title: string; querySelector(selector: string): TestElement | null };
        history: { replaceState(data: object, unused: string, url: string): void };
      };
      const original = state.document.querySelector('input[aria-label="Email"]');
      if (original !== null) original.replaceWith(original.cloneNode(true));
      state.history.replaceState({}, "", "/Page-a");
      state.document.title = "Page a";
      state.document.querySelector('input[aria-label="Email"]')?.addEventListener("input", () => {
        state.history.replaceState({}, "", "/Changed-a");
        state.document.title = "Changed a";
      });
    }));
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.short-change"),
      before,
    );

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    const after = await observer.capture(job);

    expect(after.url).not.toContain("Changed-a");
    expect(after.title).toBe("[REDACTED]");
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

  it("does not extend exact-target causality past a handler that stops propagation", async () => {
    const secret = "scope-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.scope"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement {
        value: string;
        addEventListener(type: string, listener: (event: { stopPropagation(): void }) => void): void;
        dispatchEvent(event: unknown): void;
      }
      interface TestRegion { textContent: string | null }
      const state = globalThis as unknown as {
        document: { querySelector(selector: string): TestElement | TestRegion | null };
        Event: new (type: string, options: { bubbles: boolean }) => unknown;
        setInterval(callback: () => void, timeout: number): number;
        clearInterval(id: number): void;
      };
      const source = state.document.querySelector('input[aria-label="Email"]') as TestElement | null;
      const unrelated = state.document.querySelector(
        'input[aria-label="Input property reflection"]',
      ) as TestElement | null;
      const unrelatedRegion = state.document.querySelector("[data-unrelated-region]") as TestRegion | null;
      let fired = false;
      const timer = state.setInterval(() => {
        if (!fired || unrelated === null) return;
        state.clearInterval(timer);
        if (unrelatedRegion !== null) unrelatedRegion.textContent = source?.value ?? "";
        unrelated.dispatchEvent(new state.Event("change", { bubbles: true }));
      }, 500);
      source?.addEventListener("input", (event) => {
        event.stopPropagation();
        fired = true;
      });
    }));

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
  });

  it.each([
    ["setTimeout", "setTimeout(reflect, 0)"],
    ["setInterval", "const id = setInterval(() => { clearInterval(id); reflect(); }, 0)"],
    ["requestAnimationFrame", "requestAnimationFrame(() => reflect())"],
    ["queueMicrotask", "queueMicrotask(reflect)"],
    ["Promise.then", "Promise.resolve().then(reflect)"],
    ["Promise.catch", "Promise.reject(new Error('expected')).catch(reflect)"],
    ["Promise.finally", "Promise.resolve().finally(reflect)"],
  ] as const)("masks a causal reflection scheduled with %s", async (_mechanism, source) => {
    const secret = `scheduled-${_mechanism}-secret`;
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, `customer.${_mechanism}`),
      before,
    );
    await session.withPage(async (page) => page.evaluate((scheduledSource) => {
      interface TestElement {
        value: string;
        textContent: string | null;
        addEventListener(type: string, listener: (event: { target: TestElement }) => void): void;
      }
      const state = globalThis as unknown as {
        document: {
          querySelector(selector: string): TestElement | null;
          getElementById(id: string): TestElement | null;
        };
        Function: FunctionConstructor;
      };
      const target = state.document.querySelector('input[aria-label="Email"]');
      const reflected = state.document.getElementById("normalized-reflection-second");
      target?.addEventListener("input", (event) => {
        const value = event.target.value;
        const reflect = () => { if (reflected !== null) reflected.textContent = value; };
        state.Function("reflect", scheduledSource)(reflect);
      });
    }, source));

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await observer.capture(job);
    const serialized = JSON.stringify(after);

    expect(serialized).not.toContain(secret);
    expect(after.nodes.filter((node) => node.name === "[REDACTED]")).toHaveLength(4);
  });

  it("does not grant causality to scheduled work created before the sensitive action", async () => {
    const secret = "preexisting-task-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.preexisting-task"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement {
        value: string;
        textContent: string | null;
        setAttribute(name: string, value: string): void;
      }
      const state = globalThis as unknown as {
        document: { querySelector(selector: string): TestElement | null };
        setTimeout(callback: () => void, timeout: number): void;
      };
      const source = state.document.querySelector('input[aria-label="Email"]');
      const unrelated = state.document.querySelector("[data-unrelated-region]");
      unrelated?.setAttribute("data-qualigence-observe", "");
      state.setTimeout(() => {
        if (unrelated !== null) unrelated.textContent = source?.value ?? "";
      }, 500);
    }));

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
  });

  it("poisons evidence when a causal scheduled callback executes after its deadline", async () => {
    const secret = "expired-generation-secret";
    session = new PlaywrightBrowserSession(options({ actionTimeoutMs: 100 }));
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.expired-generation"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement {
        value: string;
        textContent: string | null;
        addEventListener(type: string, listener: (event: { target: TestElement }) => void): void;
      }
      const state = globalThis as unknown as {
        document: {
          querySelector(selector: string): TestElement | null;
          getElementById(id: string): TestElement | null;
        };
        setTimeout(callback: () => void, timeout: number): void;
      };
      const target = state.document.querySelector('input[aria-label="Email"]');
      const reflected = state.document.getElementById("normalized-reflection-second");
      target?.addEventListener("input", (event) => {
        const value = event.target.value;
        state.setTimeout(() => {
          if (reflected !== null) reflected.textContent = value;
        }, 150);
      });
    }));

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
  });

  it("poisons over 64 pending registrations while preserving every native callback", async () => {
    const secret = "registration-overflow-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.registration-overflow"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement { addEventListener(type: string, listener: () => void): void }
      const state = globalThis as unknown as {
        document: { querySelector(selector: string): TestElement | null };
        registrationCounter?: number;
        setTimeout(callback: () => void, timeout: number): unknown;
        queueMicrotask(callback: () => void): void;
        requestAnimationFrame(callback: () => void): unknown;
      };
      const source = state.document.querySelector('input[aria-label="Email"]');
      state.registrationCounter = 0;
      source?.addEventListener("input", () => {
        for (let index = 0; index < 65; index += 1) {
          const increment = () => {
            state.registrationCounter = (state.registrationCounter ?? 0) + 1;
          };
          if (index % 3 === 0) state.setTimeout(increment, 0);
          else if (index % 3 === 1) state.queueMicrotask(increment);
          else state.requestAnimationFrame(increment);
        }
      });
    }));

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    await expect.poll(() => session.withPage(async (page) => page.evaluate(() =>
      (globalThis as typeof globalThis & { registrationCounter?: number }).registrationCounter,
    ))).toBe(65);
    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    expect(session.latestGraphId).toBe(before.graphId);
  });

  it("never clears an application interval after tracking is poisoned", async () => {
    const secret = "interval-overflow-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.interval-overflow"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement { addEventListener(type: string, listener: () => void): void }
      const state = globalThis as unknown as {
        document: { querySelector(selector: string): TestElement | null };
        intervalCounter?: number;
        intervalId?: unknown;
        clearIntervalCalls?: number;
        setTimeout(callback: () => void, timeout: number): unknown;
        setInterval(callback: () => void, timeout: number): unknown;
        clearInterval(id?: unknown): void;
      };
      const source = state.document.querySelector('input[aria-label="Email"]');
      state.intervalCounter = 0;
      state.clearIntervalCalls = 0;
      const nativeClearInterval = state.clearInterval;
      state.clearInterval = (id?: unknown) => {
        state.clearIntervalCalls = (state.clearIntervalCalls ?? 0) + 1;
        nativeClearInterval(id);
      };
      source?.addEventListener("input", () => {
        for (let index = 0; index < 64; index += 1) state.setTimeout(() => undefined, 0);
        state.intervalId = state.setInterval(() => {
          state.intervalCounter = (state.intervalCounter ?? 0) + 1;
        }, 10);
      });
    }));

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    await expect.poll(() => session.withPage(async (page) => page.evaluate(() =>
      (globalThis as typeof globalThis & { intervalCounter?: number }).intervalCounter,
    ))).toBeGreaterThanOrEqual(3);
    const beforeClear = await session.withPage(async (page) => page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        intervalCounter?: number;
        clearIntervalCalls?: number;
      };
      return { counter: state.intervalCounter ?? 0, clearCalls: state.clearIntervalCalls ?? 0 };
    }));
    expect(beforeClear.clearCalls).toBe(0);
    await session.withPage(async (page) => page.evaluate(() => {
      const state = globalThis as unknown as { intervalId?: unknown; clearInterval(id?: unknown): void };
      state.clearInterval(state.intervalId);
    }));
    expect(await session.withPage(async (page) => page.evaluate(() =>
      (globalThis as typeof globalThis & { clearIntervalCalls?: number }).clearIntervalCalls,
    ))).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterClear = await session.withPage(async (page) => page.evaluate(() =>
      (globalThis as typeof globalThis & { intervalCounter?: number }).intervalCounter,
    ));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await session.withPage(async (page) => page.evaluate(() =>
      (globalThis as typeof globalThis & { intervalCounter?: number }).intervalCounter,
    ))).toBe(afterClear);
  });

  it("bounds Promise registrations and restores scheduler wrappers on close", async () => {
    const secret = "promise-overflow-secret";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.promise-overflow"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement { addEventListener(type: string, listener: () => void): void }
      const state = globalThis as unknown as {
        document: { querySelector(selector: string): TestElement | null };
        promiseCounter?: number;
        originalSchedulers?: readonly unknown[];
        setTimeout: unknown;
        setInterval: unknown;
        requestAnimationFrame: unknown;
        queueMicrotask: unknown;
      };
      const source = state.document.querySelector('input[aria-label="Email"]');
      state.promiseCounter = 0;
      state.originalSchedulers = [
        state.setTimeout,
        state.setInterval,
        state.requestAnimationFrame,
        state.queueMicrotask,
        Promise.prototype.then,
        Promise.prototype.catch,
        Promise.prototype.finally,
      ];
      source?.addEventListener("input", () => {
        for (let index = 0; index < 65; index += 1) {
          Promise.resolve().then(() => {
            state.promiseCounter = (state.promiseCounter ?? 0) + 1;
          });
        }
      });
    }));

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    await expect.poll(() => session.withPage(async (page) => page.evaluate(() =>
      (globalThis as typeof globalThis & { promiseCounter?: number }).promiseCounter,
    ))).toBe(65);
    await session.abandonSensitiveActionTracking();
    expect(await session.withPage(async (page) => page.evaluate(() => {
      const expected = (globalThis as typeof globalThis & {
        originalSchedulers?: readonly unknown[];
      }).originalSchedulers;
      const state = globalThis as unknown as {
        setTimeout: unknown;
        setInterval: unknown;
        requestAnimationFrame: unknown;
        queueMicrotask: unknown;
      };
      return expected?.every((original, index) => original === [
        state.setTimeout,
        state.setInterval,
        state.requestAnimationFrame,
        state.queueMicrotask,
        Promise.prototype.then,
        Promise.prototype.catch,
        Promise.prototype.finally,
      ][index]);
    }))).toBe(true);
  });

  it.each([
    ["catch", 64],
    ["finally", 21],
  ] as const)(
    "counts each Promise.%s application continuation exactly once at %i registrations",
    async (method, registrations) => {
      const secret = `${method}-${registrations}-boundary-secret`;
      session = new PlaywrightBrowserSession(options());
      await session.start();
      const observer = new PlaywrightObserver(session);
      const resolver = new PlaywrightActionResolver(session);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
      const before = await observer.capture(job);
      const action = await resolver.resolve(
        valued("input", nodeNamed(before, "Email").id, `customer.${method}-${registrations}`),
        before,
      );
      await session.withPage(async (page) => page.evaluate(({ continuation, count }) => {
        const source = (globalThis as unknown as {
          document: { querySelector(selector: string): { addEventListener(type: string, listener: () => void): void } | null };
        }).document.querySelector('input[aria-label="Email"]');
        (globalThis as typeof globalThis & { promiseBoundaryCallbacks?: number })
          .promiseBoundaryCallbacks = 0;
        source?.addEventListener("input", () => {
          for (let index = 0; index < count; index += 1) {
            const callback = () => {
              const state = globalThis as typeof globalThis & { promiseBoundaryCallbacks?: number };
              state.promiseBoundaryCallbacks = (state.promiseBoundaryCallbacks ?? 0) + 1;
            };
            if (continuation === "catch") Promise.reject(index).catch(callback);
            else Promise.resolve(index).finally(callback);
          }
        });
      }, { continuation: method, count: registrations }));

      await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
      await expect.poll(() => session.withPage(async (page) => page.evaluate(() =>
        (globalThis as typeof globalThis & { promiseBoundaryCallbacks?: number })
          .promiseBoundaryCallbacks,
      ))).toBe(registrations);
      await session.close();
    },
  );

  it.each([
    ["catch", 32, false],
    ["catch", 33, true],
    ["finally", 16, false],
    ["finally", 17, true],
  ] as const)(
    "counts a Promise.%s override's second super.then at the %i boundary",
    async (method, registrations, poisoned) => {
      session = new PlaywrightBrowserSession(options());
      await session.start();
      const observer = new PlaywrightObserver(session);
      const resolver = new PlaywrightActionResolver(session);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => "override-secret" });
      const before = await observer.capture(job);
      const action = await resolver.resolve(
        valued("input", nodeNamed(before, "Email").id, `customer.${method}-override`),
        before,
      );
      await session.withPage(async (page) => page.evaluate(({ continuation, count }) => {
        const source = (globalThis as unknown as {
          document: { querySelector(selector: string): { addEventListener(type: string, listener: () => void): void } | null };
        }).document.querySelector('input[aria-label="Email"]');
        source?.addEventListener("input", () => {
          for (let index = 0; index < count; index += 1) {
            const receiver = continuation === "catch"
              ? Promise.reject(index)
              : Promise.resolve(index);
            const baseThen = receiver.then;
            receiver.then = function (...args) {
              Reflect.apply(baseThen, this, [undefined, () => undefined]);
              return Reflect.apply(baseThen, this, args);
            };
            if (continuation === "catch") receiver.catch(() => undefined);
            else receiver.finally(() => undefined);
          }
        });
      }, { continuation: method, count: registrations }));

      const execution = executor.execute(action, allowedPermit());
      if (poisoned) {
        await expect(execution).rejects.toMatchObject({ code: "SensitiveEvidenceUnproven" });
      } else {
        await expect(execution).resolves.toEqual({ status: "ok" });
      }
    },
  );

  it.each(["catch", "finally"] as const)(
    "poisons over 64 Promise.%s registrations without suppressing callbacks",
    async (method) => {
      session = new PlaywrightBrowserSession(options());
      await session.start();
      const observer = new PlaywrightObserver(session);
      const resolver = new PlaywrightActionResolver(session);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => `${method}-overflow-secret` });
      const before = await observer.capture(job);
      const action = await resolver.resolve(
        valued("input", nodeNamed(before, "Email").id, `customer.${method}-overflow`),
        before,
      );
      await session.withPage(async (page) => page.evaluate((continuation) => {
        const source = (globalThis as unknown as {
          document: { querySelector(selector: string): { addEventListener(type: string, listener: () => void): void } | null };
        }).document.querySelector('input[aria-label="Email"]');
        (globalThis as typeof globalThis & { promiseOverflowCallbacks?: number })
          .promiseOverflowCallbacks = 0;
        source?.addEventListener("input", () => {
          for (let index = 0; index < 65; index += 1) {
            const callback = () => {
              const state = globalThis as typeof globalThis & { promiseOverflowCallbacks?: number };
              state.promiseOverflowCallbacks = (state.promiseOverflowCallbacks ?? 0) + 1;
            };
            if (continuation === "catch") Promise.reject(index).catch(callback);
            else Promise.resolve(index).finally(callback);
          }
        });
      }, method));

      await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
        code: "SensitiveEvidenceUnproven",
      });
      await expect.poll(() => session.withPage(async (page) => page.evaluate(() =>
        (globalThis as typeof globalThis & { promiseOverflowCallbacks?: number })
          .promiseOverflowCallbacks,
      ))).toBe(65);
    },
  );

  it("preserves Promise finally callback, fulfillment, and rejection semantics", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "finally-semantics-secret" });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.finally-semantics"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      const source = (globalThis as unknown as {
        document: { querySelector(selector: string): { addEventListener(type: string, listener: () => void): void } | null };
      }).document.querySelector('input[aria-label="Email"]');
      source?.addEventListener("input", () => {
        const state = globalThis as typeof globalThis & {
          finallyCallbacks?: number;
          finallyFulfilled?: string;
          finallyRejected?: string;
        };
        state.finallyCallbacks = 0;
        Promise.resolve("fulfilled").finally(() => {
          state.finallyCallbacks = (state.finallyCallbacks ?? 0) + 1;
          return Promise.resolve("ignored");
        }).then((value) => { state.finallyFulfilled = value; });
        Promise.reject(new Error("rejected")).finally(() => {
          state.finallyCallbacks = (state.finallyCallbacks ?? 0) + 1;
        }).catch((error: Error) => { state.finallyRejected = error.message; });
      });
    }));

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await expect.poll(() => session.withPage(async (page) => page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        finallyCallbacks?: number;
        finallyFulfilled?: string;
        finallyRejected?: string;
      };
      return [state.finallyCallbacks, state.finallyFulfilled, state.finallyRejected];
    }))).toEqual([2, "fulfilled", "rejected"]);
  });

  it.each([
    "base-undefined",
    "base-value",
    "base-resolved-promise",
    "base-rejected-promise",
    "base-source-rejection",
    "base-custom-thenable",
    "instance-custom-then",
    "returned-promise-custom-then",
    "hostile-thenable",
    "catch-current-then",
  ] as const)("matches a fresh native page for Promise scenario %s", async (scenario) => {
    const browser = await chromiumLauncher.launch({ headless: true });
    const context = await browser.newContext();
    const nativePage = await context.newPage();
    let native: PromiseScenarioObservation;
    try {
      await nativePage.goto(fixture.url);
      await nativePage.evaluate(promiseScenarioPage, {
        scenario,
        installOnInput: true,
      });
      await nativePage.locator('input[aria-label="Email"]').fill(`matrix-${scenario}`);
      await nativePage.waitForFunction(() =>
        (globalThis as typeof globalThis & { promiseScenarioObservation?: unknown })
          .promiseScenarioObservation !== undefined);
      native = await nativePage.evaluate(() =>
        (globalThis as typeof globalThis & { promiseScenarioObservation: PromiseScenarioObservation })
          .promiseScenarioObservation);
    } finally {
      await context.close();
      await browser.close();
    }

    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => `matrix-${scenario}` });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, `customer.matrix-${scenario}`),
      before,
    );
    await session.withPage(async (page) => page.evaluate(promiseScenarioPage, {
      scenario,
      installOnInput: true,
    }));

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await expect.poll(() => session.withPage(async (page) => page.evaluate(() =>
      (globalThis as typeof globalThis & { promiseScenarioObservation?: PromiseScenarioObservation })
        .promiseScenarioObservation,
    ))).toEqual(native);
    const instrumented = await session.withPage(async (page) => page.evaluate(() =>
      (globalThis as typeof globalThis & { promiseScenarioObservation?: PromiseScenarioObservation })
        .promiseScenarioObservation,
    ));
    expect(JSON.stringify(instrumented)).toBe(JSON.stringify(native));
    expect(instrumented?.nativeCatchUnchanged).toBe(true);
    expect(instrumented?.nativeFinallyUnchanged).toBe(true);

    const counts = await session.sensitiveSchedulerCounts();
    const expectedCounts: Partial<Record<PromiseScenario, readonly [number, number]>> = {
      "base-undefined": [3, 3],
      "base-value": [3, 3],
      "base-resolved-promise": [3, 3],
      "base-rejected-promise": [3, 2],
      "base-source-rejection": [3, 3],
      "base-custom-thenable": [3, 3],
      "subclass-overridden-species": [4, 4],
      "instance-custom-then": [3, 3],
      "current-prototype-custom-then": [3, 3],
      "prototype-custom-then": [4, 4],
      "returned-promise-custom-then": [3, 3],
      "hostile-thenable": [3, 3],
      "catch-current-then": [1, 1],
    };
    expect([counts.registrations, counts.executions]).toEqual(expectedCounts[scenario]);
  });

  it.each([1, 2, 65] as const)(
    "poisons a pre-tracking captured-native then bypass after %i calls without guessing counts",
    async (calls) => {
      const browser = await chromiumLauncher.launch({ headless: true });
      const context = await browser.newContext();
      const nativePage = await context.newPage();
      let nativeResult: readonly number[];
      try {
        await nativePage.goto(fixture.url);
        await nativePage.evaluate((count) => {
          const capturedThen = Promise.prototype.then;
          Promise.prototype.then = function (...args) {
            return Reflect.apply(capturedThen, this, args);
          };
          const source = (globalThis as unknown as {
            document: { querySelector(selector: string): { addEventListener(type: string, listener: () => void): void } | null };
          }).document.querySelector('input[aria-label="Email"]');
          source?.addEventListener("input", () => {
            const results: number[] = [];
            for (let index = 0; index < count; index += 1) {
              Promise.resolve(index).then((value) => { results.push(value); });
            }
            (globalThis as typeof globalThis & { bypassResults?: number[] }).bypassResults = results;
          });
        }, calls);
        await nativePage.locator('input[aria-label="Email"]').fill(`native-bypass-${calls}`);
        await expect.poll(() => nativePage.evaluate(() =>
          (globalThis as typeof globalThis & { bypassResults?: number[] }).bypassResults?.length,
        )).toBe(calls);
        nativeResult = await nativePage.evaluate(() =>
          (globalThis as typeof globalThis & { bypassResults: number[] }).bypassResults);
      } finally {
        await context.close();
        await browser.close();
      }

      session = new PlaywrightBrowserSession(options());
      await session.start();
      const observer = new PlaywrightObserver(session);
      const resolver = new PlaywrightActionResolver(session);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => `bypass-${calls}` });
      await session.withPage(async (page) => page.evaluate((count) => {
        const capturedThen = Promise.prototype.then;
        Promise.prototype.then = function (...args) {
          return Reflect.apply(capturedThen, this, args);
        };
        const source = (globalThis as unknown as {
          document: { querySelector(selector: string): { addEventListener(type: string, listener: () => void): void } | null };
        }).document.querySelector('input[aria-label="Email"]');
        source?.addEventListener("input", () => {
          const results: number[] = [];
          for (let index = 0; index < count; index += 1) {
            Promise.resolve(index).then((value) => { results.push(value); });
          }
          (globalThis as typeof globalThis & { bypassResults?: number[] }).bypassResults = results;
        });
      }, calls));

      const before = await observer.capture(job);
      expect(session.latestGraphId).toBe(before.graphId);
      const action = await resolver.resolve(
        valued("input", nodeNamed(before, "Email").id, `customer.captured-bypass-${calls}`),
        before,
      );
      await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
        code: "SensitiveEvidenceUnproven",
      });
      await expect.poll(() => session.withPage(async (page) => page.evaluate(() =>
        (globalThis as typeof globalThis & { bypassResults?: number[] }).bypassResults,
      ))).toEqual(nativeResult);
      expect(session.latestGraphId).toBe(before.graphId);
      await expect(observer.capture(job)).rejects.toMatchObject({
        code: "SensitiveEvidenceUnproven",
      });
    },
  );

  it.each(["accessor", "prototype", "species", "subclass"] as const)(
    "poisons an unprovable Promise %s path while preserving application settlement",
    async (tamper) => {
      session = new PlaywrightBrowserSession(options());
      await session.start();
      const observer = new PlaywrightObserver(session);
      const resolver = new PlaywrightActionResolver(session);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => `${tamper}-secret` });
      if (tamper !== "subclass") {
        await session.withPage(async (page) => page.evaluate((kind) => {
          if (kind === "accessor") {
            const nativeThen = Promise.prototype.then;
            Object.defineProperty(Promise.prototype, "then", {
              configurable: true,
              get: () => nativeThen,
            });
          } else if (kind === "prototype") {
            const nativeThen = Promise.prototype.then;
            Promise.prototype.then = function (...args) {
              return Reflect.apply(nativeThen, this, args);
            };
          } else {
            Object.defineProperty(Promise, Symbol.species, {
              configurable: true,
              get: () => Promise,
            });
          }
        }, tamper));
      }
      const before = await observer.capture(job);
      const action = await resolver.resolve(
        valued("input", nodeNamed(before, "Email").id, `customer.promise-${tamper}`),
        before,
      );
      await session.withPage(async (page) => page.evaluate((kind) => {
        const source = (globalThis as unknown as {
          document: { querySelector(selector: string): { addEventListener(type: string, listener: () => void): void } | null };
        }).document.querySelector('input[aria-label="Email"]');
        source?.addEventListener("input", () => {
          if (kind === "subclass") {
            class CustomPromise<T> extends Promise<T> {
              override then<TResult1 = T, TResult2 = never>(
                onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
              ): Promise<TResult1 | TResult2> {
                return super.then(onfulfilled, onrejected);
              }
            }
            new CustomPromise<number>((resolve) => resolve(7)).then((value) => {
              (globalThis as typeof globalThis & { tamperResult?: number }).tamperResult = value;
            });
          } else {
            Promise.resolve(7).then((value) => {
              (globalThis as typeof globalThis & { tamperResult?: number }).tamperResult = value;
            });
          }
        });
      }, tamper));

      await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
        code: "SensitiveEvidenceUnproven",
      });
      await expect.poll(() => session.withPage(async (page) => page.evaluate(() =>
        (globalThis as typeof globalThis & { tamperResult?: number }).tamperResult,
      ))).toBe(7);
      expect(session.latestGraphId).toBe(before.graphId);
    },
  );

  it("poisons Promise species paths while preserving settlement semantics", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "promise-species-secret" });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.promise-species"),
      before,
    );
    await session.withPage(async (page) => page.evaluate(() => {
      const source = (globalThis as unknown as {
        document: {
          querySelector(selector: string): {
            addEventListener(type: string, listener: () => void): void;
          } | null;
        };
      }).document.querySelector('input[aria-label="Email"]');
      source?.addEventListener("input", () => {
        class SpeciesPromise<T> extends Promise<T> {
          static get [Symbol.species](): PromiseConstructor { return SpeciesResult; }
        }
        class SpeciesResult<T> extends Promise<T> {}
        const state = globalThis as typeof globalThis & {
          promiseSemantics?: readonly unknown[];
        };
        const caughtReceiver = new SpeciesPromise<string>((_resolve, reject) =>
          reject(new Error("caught-error")));
        const finalizedReceiver = new SpeciesPromise<string>((resolve) => resolve("value"));
        let overriddenThenCalls = 0;
        let overriddenCatchCalls = 0;
        let overriddenFinallyCalls = 0;
        const inheritedThen = caughtReceiver.then;
        caughtReceiver.then = function (...args) {
          overriddenThenCalls += 1;
          return Reflect.apply(inheritedThen, this, args);
        };
        const inheritedCatch = caughtReceiver.catch;
        caughtReceiver.catch = function (...args) {
          overriddenCatchCalls += 1;
          return Reflect.apply(inheritedCatch, this, args);
        };
        const inheritedFinally = finalizedReceiver.finally;
        finalizedReceiver.finally = function (...args) {
          overriddenFinallyCalls += 1;
          return Reflect.apply(inheritedFinally, this, args);
        };
        const resolve = Promise.resolve;
        Promise.resolve = (() => { throw new Error("mutable resolve used"); }) as PromiseConstructor["resolve"];
        const caught = caughtReceiver.catch((error: Error) => error.message);
        const finalized = finalizedReceiver.finally(() => "ignored");
        Promise.resolve = resolve;
        const values: unknown[] = [];
        const finish = (): void => {
          if (values.length !== 2) return;
          state.promiseSemantics = [
            caught instanceof SpeciesResult,
            finalized instanceof SpeciesResult,
            overriddenThenCalls,
            overriddenCatchCalls,
            overriddenFinallyCalls,
            ...values,
          ];
        };
        inheritedThen.call(caught, (value) => { values[0] = value; finish(); });
        inheritedThen.call(finalized, (value) => { values[1] = value; finish(); });
      });
    }));

    await expect(executor.execute(action, allowedPermit())).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
    await expect.poll(() => session.withPage(async (page) => page.evaluate(() =>
      (globalThis as typeof globalThis & { promiseSemantics?: readonly unknown[] }).promiseSemantics,
    ))).toEqual([true, true, 1, 1, 1, "caught-error", "value"]);
  });

  it.each([[1, true], [2, true]] as const)(
    "counts returned species custom then registrations at the %i finally boundary",
    async (registrations, poisoned) => {
      session = new PlaywrightBrowserSession(options());
      await session.start();
      const observer = new PlaywrightObserver(session);
      const resolver = new PlaywrightActionResolver(session);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => "species-then-secret" });
      const before = await observer.capture(job);
      const action = await resolver.resolve(
        valued("input", nodeNamed(before, "Email").id, "customer.species-then"),
        before,
      );
      await session.withPage(async (page) => page.evaluate((count) => {
        const source = (globalThis as unknown as {
          document: { querySelector(selector: string): { addEventListener(type: string, listener: () => void): void } | null };
        }).document.querySelector('input[aria-label="Email"]');
        source?.addEventListener("input", () => {
          const state = globalThis as typeof globalThis & { speciesThenCalls?: number };
          state.speciesThenCalls = 0;
          class SpeciesResult<T> extends Promise<T> {
            then<TResult1 = T, TResult2 = never>(
              onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ): Promise<TResult1 | TResult2> {
              state.speciesThenCalls = (state.speciesThenCalls ?? 0) + 1;
              return super.then(onfulfilled, onrejected);
            }
          }
          class SpeciesPromise<T> extends Promise<T> {
            static get [Symbol.species](): PromiseConstructor { return SpeciesResult; }
          }
          for (let index = 0; index < count; index += 1) {
            new SpeciesPromise<number>((resolve) => resolve(index)).finally(() => ({
              then: (resolve: (value: string) => void) => resolve("ignored"),
            }));
          }
        });
      }, registrations));

      const execution = executor.execute(action, allowedPermit());
      if (poisoned) {
        await expect(execution).rejects.toMatchObject({ code: "SensitiveEvidenceUnproven" });
      } else {
        await expect(execution).resolves.toEqual({ status: "ok" });
      }
      await expect.poll(() => session.withPage(async (page) => page.evaluate(() =>
        (globalThis as typeof globalThis & { speciesThenCalls?: number }).speciesThenCalls,
      ))).toBe(registrations * 2);
    },
  );

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

  it("retains unbounded legacy observation before sensitivity and fails hostile expansion afterward", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "bounded-secret" });
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestNode { append(node: TestNode): void }
      interface TestElement extends TestNode { textContent: string | null }
      const state = globalThis as unknown as {
        document: {
          body: { append(node: TestNode): void };
          createDocumentFragment(): TestNode;
          createElement(tag: string): TestElement;
        };
      };
      const fragment = state.document.createDocumentFragment();
      for (let index = 0; index < 600; index += 1) {
        const node = state.document.createElement("button");
        node.textContent = `ordinary-${index}`;
        fragment.append(node);
      }
      state.document.body.append(fragment);
    }));

    const before = await observer.capture(job);
    expect(before.nodes.length).toBeGreaterThan(512);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Email").id, "customer.bounds"),
      before,
    );
    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await session.withPage(async (page) => page.evaluate(() => {
      interface TestElement { textContent: string | null }
      const state = globalThis as unknown as {
        document: { body: { append(node: TestElement): void }; createElement(tag: string): TestElement };
      };
      const hostile = state.document.createElement("button");
      hostile.textContent = "hostile-expansion";
      state.document.body.append(hostile);
    }));
    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
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
