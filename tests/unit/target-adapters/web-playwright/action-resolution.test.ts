import { describe, expect, it, vi } from "vitest";
import type { ObservationGraph } from "@qualigence/runner-protocol";
import { ExecutionPermit, type ProposedAction } from "@qualigence/runner-kernel";
import {
  PlaywrightActionExecutor,
  PlaywrightActionResolver,
  PlaywrightBrowserSession,
  WebTargetError,
  actionToken,
  isActionToken,
  type BrowserLauncher,
  type LocatorDescriptor,
  type WebSessionOptions,
} from "@qualigence/web-playwright/internal";

function options(): WebSessionOptions {
  return {
    url: "https://example.test/",
    headed: false,
    navigationTimeoutMs: 5_000,
    actionTimeoutMs: 5_000,
    allowedOrigins: ["https://example.test"],
  };
}

const noopLauncher = { launch: vi.fn() } as unknown as BrowserLauncher;
const permit = ExecutionPermit.fromAllowedDecision({ status: "allowed", reason: "test" });

function click(nodeId: string): ProposedAction {
  return { kind: "click", target: { nodeId }, reason: "test" };
}

function input(nodeId: string, valueRef: string): ProposedAction<"input"> {
  return { kind: "input", target: { nodeId }, valueRef, reason: "test" };
}

function navigate(path: string): ProposedAction<"navigate"> {
  return { kind: "navigate", path, reason: "test" };
}

function scroll(nodeId?: string): ProposedAction<"scroll"> {
  return {
    kind: "scroll",
    ...(nodeId === undefined ? {} : { target: { nodeId } }),
    direction: "down",
    amount: "page",
    reason: "test",
  };
}

function graphWith(graphId: string, nodeId: string): ObservationGraph {
  return {
    graphId,
    nodes: [{ id: nodeId, role: "button", name: "Add", confidence: 1 }],
  };
}

describe("action token", () => {
  it("builds and validates a de-identified token", () => {
    const token = actionToken("run-1:observation:1", "n-0-abcd1234");
    expect(token).toBe("pw:run-1:observation:1:n-0-abcd1234");
    expect(token).not.toContain("button");
    expect(isActionToken(token, "run-1:observation:1", "n-0-abcd1234")).toBe(true);
    expect(isActionToken(token, "run-1:observation:2", "n-0-abcd1234")).toBe(false);
  });
});

describe("PlaywrightActionResolver negative paths", () => {
  function sessionWithGraph(graphId: string): PlaywrightBrowserSession {
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    const descriptors = new Map<string, LocatorDescriptor>([
      ["n-0-abcd1234", { kind: "role", role: "button", name: "Add" }],
    ]);
    session.registerObservation(graphId, { descriptors, artifacts: [] });
    return session;
  }

  it("rejects an unknown nodeId with UnknownObservationNode", async () => {
    const graphId = "run-1:observation:1";
    const resolver = new PlaywrightActionResolver(sessionWithGraph(graphId));
    await expect(
      resolver.resolve(click("n-9-missing0"), graphWith(graphId, "n-9-missing0")),
    ).rejects.toMatchObject({ code: "UnknownObservationNode" });
  });

  it("rejects a graph the session never registered with StaleObservation", async () => {
    const resolver = new PlaywrightActionResolver(sessionWithGraph("run-1:observation:1"));
    await expect(
      resolver.resolve(
        click("n-0-abcd1234"),
        graphWith("run-1:observation:0", "n-0-abcd1234"),
      ),
    ).rejects.toMatchObject({ code: "StaleObservation" });
  });

  it("preserves an input valueRef without resolving plaintext", async () => {
    const graphId = "run-1:observation:1";
    const session = sessionWithGraph(graphId);
    session.withPage = async (operation) => operation({
      getByRole: () => ({ count: async () => 1 }),
    } as never);
    const resolver = new PlaywrightActionResolver(session);

    await expect(
      resolver.resolve(input("n-0-abcd1234", "customer.email"), graphWith(graphId, "n-0-abcd1234")),
    ).resolves.toMatchObject({ kind: "input", valueRef: "customer.email" });
  });

  it("canonicalizes an immutable navigation path against the Job target origin", async () => {
    const session = new PlaywrightBrowserSession({
      ...options(),
      url: "https://example.test:443/start",
      allowedOrigins: ["https://example.test", "https://other.test"],
    }, noopLauncher);
    const resolver = new PlaywrightActionResolver(session);

    await expect(
      resolver.resolve(navigate("/checkout?source=plan#summary"), graphWith("run-1:observation:1", "n-0-abcd1234")),
    ).resolves.toEqual({
      targetKind: "web",
      kind: "navigate",
      url: "https://example.test/checkout?source=plan#summary",
    });
    await expect(
      resolver.resolve(navigate("https://other.test/checkout"), graphWith("run-1:observation:1", "n-0-abcd1234")),
    ).rejects.toMatchObject({ code: "OriginViolation" });
    await expect(
      resolver.resolve(navigate("https://user:pass@example.test/checkout"), graphWith("run-1:observation:1", "n-0-abcd1234")),
    ).rejects.toMatchObject({ code: "NavigationFailed" });
  });

  it("preserves only fixed scroll parameters and optional current-graph grounding", async () => {
    const graphId = "run-1:observation:1";
    const session = sessionWithGraph(graphId);
    session.withPage = async (operation) => operation({
      getByRole: () => ({ count: async () => 1 }),
    } as never);
    const resolver = new PlaywrightActionResolver(session);

    await expect(resolver.resolve(scroll(), graphWith(graphId, "n-0-abcd1234"))).resolves.toEqual({
      targetKind: "web",
      kind: "scroll",
      graphId,
      direction: "down",
      amount: "page",
    });
    await expect(resolver.resolve(scroll("n-0-abcd1234"), graphWith(graphId, "n-0-abcd1234"))).resolves.toMatchObject({
      targetKind: "web",
      kind: "scroll",
      target: { nodeId: "n-0-abcd1234" },
      graphId,
      direction: "down",
      amount: "page",
    });
  });

  it("rejects a prior descriptor after a fresh observation is registered", async () => {
    const session = sessionWithGraph("run-1:observation:1");
    session.registerObservation("run-1:observation:2", {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "button", name: "Add" }]]),
      artifacts: [],
    });
    const resolver = new PlaywrightActionResolver(session);

    await expect(
      resolver.resolve(click("n-0-abcd1234"), graphWith("run-1:observation:1", "n-0-abcd1234")),
    ).rejects.toMatchObject({ code: "StaleObservation" });
  });
});

describe("PlaywrightActionExecutor value resolution", () => {
  it("rejects a policy-allowed origin that differs from the Job target before page.goto", async () => {
    const goto = vi.fn(async () => undefined);
    const session = new PlaywrightBrowserSession({
      ...options(),
      allowedOrigins: ["https://example.test", "https://other.test"],
    }, noopLauncher);
    session.withPage = async (operation) => operation({ goto, url: () => "https://example.test/" } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute({
      targetKind: "web",
      kind: "navigate",
      url: "https://other.test/checkout",
    }, permit)).resolves.toEqual({ status: "failed", errorCode: "OriginViolation" });
    expect(goto).not.toHaveBeenCalled();
  });

  it("rejects credentialed same-origin navigation before page.goto", async () => {
    const goto = vi.fn(async () => undefined);
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.withPage = async (operation) => operation({ goto, url: () => "https://example.test/" } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute({
      targetKind: "web",
      kind: "navigate",
      url: "https://user:pass@example.test/checkout",
    }, permit)).resolves.toEqual({ status: "failed", errorCode: "OriginViolation" });
    expect(goto).not.toHaveBeenCalled();
  });

  it("retains OriginViolation when page.goto reaches another origin before throwing", async () => {
    let currentUrl = "https://example.test/";
    const goto = vi.fn(async () => {
      currentUrl = "https://other.test/checkout";
      throw new Error("navigation timeout");
    });
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.withPage = async (operation) => operation({ goto, url: () => currentUrl } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute({
      targetKind: "web",
      kind: "navigate",
      url: "https://example.test/checkout",
    }, permit)).resolves.toEqual({ status: "failed", errorCode: "OriginViolation" });
    expect(goto).toHaveBeenCalledOnce();
  });

  it("rejects a malformed link destination before click", async () => {
    const click = vi.fn(async () => undefined);
    const graphId = "run-1:observation:1";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "button", name: "Add" }]]),
      artifacts: [],
    });
    session.withPage = async (operation) => operation({
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        getAttribute: async () => "http://[invalid",
        click,
      }),
      url: () => "https://example.test/",
    } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute({
      targetKind: "web",
      kind: "click",
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      graphId,
    }, permit)).resolves.toEqual({ status: "failed", errorCode: "OriginViolation" });
    expect(click).not.toHaveBeenCalled();
  });

  it("does not dispatch an action when its AbortSignal is already aborted", async () => {
    const click = vi.fn(async () => undefined);
    const graphId = "run-1:observation:1";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "button", name: "Add" }]]),
      artifacts: [],
    });
    session.withPage = async (operation) => operation({
      getByRole: () => ({ count: async () => 1, isVisible: async () => true, isEnabled: async () => true, getAttribute: async () => null, click }),
      url: () => "https://example.test/",
    } as never);
    const executor = new PlaywrightActionExecutor(session);
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));

    await expect(executor.execute({
      targetKind: "web",
      kind: "click",
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      graphId,
    }, permit, abort.signal)).rejects.toThrow("cancelled");
    expect(click).not.toHaveBeenCalled();
  });

  it("re-proves descriptor identity immediately before the element side effect", async () => {
    const click = vi.fn(async () => undefined);
    const graphId = "run-1:observation:1";
    const nodeId = "n-0-abcd1234";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    const descriptor: LocatorDescriptor = { kind: "role", role: "button", name: "Add" };
    session.registerObservation(graphId, {
      descriptors: new Map([[nodeId, descriptor]]),
      artifacts: [],
    });
    session.withPage = async (operation) => operation({
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => {
          session.registerObservation(graphId, {
            descriptors: new Map([[nodeId, { ...descriptor }]]),
            artifacts: [],
          });
          return true;
        },
        getAttribute: async () => null,
        click,
      }),
      url: () => "https://example.test/",
    } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute({
      targetKind: "web",
      kind: "click",
      target: { nodeId, selector: actionToken(graphId, nodeId) },
      graphId,
    }, permit)).resolves.toEqual({ status: "failed", errorCode: "StaleObservation" });
    expect(click).not.toHaveBeenCalled();
  });

  it("retains OriginViolation when an element action crosses origin before throwing", async () => {
    const graphId = "run-1:observation:1";
    const nodeId = "n-0-abcd1234";
    let currentUrl = "https://example.test/";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([[nodeId, { kind: "role", role: "button", name: "Add" }]]),
      artifacts: [],
    });
    session.withPage = async (operation) => operation({
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        getAttribute: async () => null,
        click: async () => {
          currentUrl = "https://other.test/";
          throw new Error("action timeout");
        },
      }),
      url: () => currentUrl,
    } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute({
      targetKind: "web",
      kind: "click",
      target: { nodeId, selector: actionToken(graphId, nodeId) },
      graphId,
    }, permit)).resolves.toEqual({ status: "failed", errorCode: "OriginViolation" });
  });

  it("executes approved navigation and page scroll then invalidates old descriptors", async () => {
    const graphId = "run-1:observation:1";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "button", name: "Add" }]]),
      artifacts: [],
    });
    const calls: string[] = [];
    session.withPage = async (operation) => operation({
      goto: async (url: string) => { calls.push(`goto:${url}`); },
      evaluate: async (_callback: unknown, value: unknown) => { calls.push(`scroll:${JSON.stringify(value)}`); },
      url: () => "https://example.test/checkout",
    } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute({
      targetKind: "web",
      kind: "navigate",
      url: "https://example.test/checkout",
    }, permit)).resolves.toEqual({ status: "ok" });
    session.registerObservation(graphId, {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "button", name: "Add" }]]),
      artifacts: [],
    });
    await expect(executor.execute({
      targetKind: "web",
      kind: "scroll",
      graphId,
      direction: "down",
      amount: "page",
    }, permit)).resolves.toEqual({ status: "ok" });

    expect(calls[0]).toBe("goto:https://example.test/checkout");
    expect(calls[1]).toContain("scroll:");
    expect(session.hasGraph(graphId)).toBe(false);
  });

  it.each([
    ["small", 0.25],
    ["page", 1],
  ] as const)("executes targeted %s scroll with its bounded viewport amount", async (amount, distance) => {
    const graphId = "run-1:observation:1";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "button", name: "Add" }]]),
      artifacts: [],
    });
    const evaluate = vi.fn(async () => undefined);
    session.withPage = async (operation) => operation({
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        getAttribute: async () => null,
        evaluate,
      }),
      url: () => "https://example.test/",
    } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute({
      targetKind: "web",
      kind: "scroll",
      graphId,
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      direction: "down",
      amount,
    }, permit)).resolves.toEqual({ status: "ok" });

    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), { direction: "down", distance });
  });

  it.each([
    ["input", "fill"],
    ["select", "selectOption"],
  ] as const)("resolves a %s valueRef only immediately before the target action", async (kind, method) => {
    const graphId = "run-1:observation:1";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "textbox", name: "Email" }]]),
      artifacts: [],
    });
    const calls: string[] = [];
    const locator = {
      count: async () => 1,
      isVisible: async () => true,
      isEnabled: async () => true,
      getAttribute: async () => null,
      fill: async (value: string) => { calls.push(`fill:${value}`); },
      selectOption: async (value: string) => { calls.push(`selectOption:${value}`); },
    };
    session.withPage = async (operation) => operation({
      getByRole: () => locator,
      url: () => "https://example.test/",
    } as never);
    const provider = { resolve: vi.fn(async (valueRef: string) => {
      calls.push(`resolve:${valueRef}`);
      return "plaintext-secret";
    }) };
    const executor = new PlaywrightActionExecutor(session, provider);
    const action = {
      targetKind: "web",
      kind,
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      graphId,
      valueRef: "customer.email",
    } as const;

    await expect(executor.execute(action, permit)).resolves.toEqual({ status: "ok" });
    expect(calls).toEqual(["resolve:customer.email", `${method}:plaintext-secret`]);
  });

  it("returns a stable code without plaintext when the provider cannot resolve a valueRef", async () => {
    const graphId = "run-1:observation:1";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "textbox", name: "Email" }]]),
      artifacts: [],
    });
    session.withPage = async (operation) => operation({
      getByRole: () => ({ count: async () => 1, isVisible: async () => true, isEnabled: async () => true, getAttribute: async () => null }),
      url: () => "https://example.test/",
    } as never);
    const executor = new PlaywrightActionExecutor(session, {
      resolve: async () => { throw new Error("plaintext-secret"); },
    });

    await expect(executor.execute({
      targetKind: "web",
      kind: "input",
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      graphId,
      valueRef: "customer.email",
    }, permit)).resolves.toEqual({ status: "failed", errorCode: "ActionValueUnavailable" });
  });

  it("rethrows an infrastructure failure without Playwright plaintext", async () => {
    const graphId = "run-1:observation:1";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "textbox", name: "Email" }]]),
      artifacts: [],
    });
    session.withPage = async (operation) => operation({
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        getAttribute: async () => null,
        fill: async () => { throw new Error('Target closed while running fill("plaintext-secret")'); },
      }),
      url: () => "https://example.test/",
    } as never);
    const executor = new PlaywrightActionExecutor(session, {
      resolve: async () => "plaintext-secret",
    });

    const failure = await executor.execute({
      targetKind: "web",
      kind: "input",
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      graphId,
      valueRef: "customer.email",
    }, permit).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "ActionInfrastructureFailure" });
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain("plaintext-secret");
  });

  it.each([
    ["BrowserLaunchFailed", "error"],
    ["NavigationFailed", "error"],
    ["NavigationTimedOut", "error"],
    ["StaleObservation", "blocked"],
    ["UnknownObservationNode", "blocked"],
    ["TargetNotFound", "blocked"],
    ["AmbiguousTarget", "blocked"],
    ["OriginViolation", "blocked"],
    ["ActionTimedOut", "blocked"],
    ["TargetNotVisible", "blocked"],
    ["TargetDisabled", "blocked"],
    ["ActionValueUnavailable", "blocked"],
    ["UnsupportedAction", "blocked"],
    ["ConcurrentSessionOperation", "error"],
    ["SessionClosed", "error"],
    ["ActionInfrastructureFailure", "error"],
  ] as const)("classifies WebTargetError %s as %s", (code, completionStatus) => {
    expect(new WebTargetError(code)).toMatchObject({ code, completionStatus });
  });
});
