import { describe, expect, it, vi } from "vitest";
import type { ObservationGraph } from "@qualigence/runner-protocol";
import {
  ExecutionBlockedError,
  ExecutionPermit,
  type ActionAuthorizationWindow,
  type ProposedAction,
} from "@qualigence/runner-kernel";
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
    expectedOrigin: "https://example.test",
    headed: false,
    navigationTimeoutMs: 5_000,
    actionTimeoutMs: 5_000,
    allowedOrigins: ["https://example.test"],
  };
}

const noopLauncher = { launch: vi.fn() } as unknown as BrowserLauncher;
const permit = ExecutionPermit.fromAllowedDecision({ status: "allowed", reason: "test" });

function sensitiveTargetEvaluate(value = "private-value") {
  let markerId = "";
  return vi.fn(async (_callback: unknown, argument: unknown) => {
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

function bindResolved<TAction extends object>(
  session: PlaywrightBrowserSession,
  action: TAction,
): TAction {
  return session.bindResolvedAction(action, session.currentNavigationGeneration);
}

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
      url: () => "https://example.test/",
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
    session.withPage = async (operation) => operation({
      url: () => "https://example.test/start",
    } as never);
    session.registerObservation("run-1:observation:1", {
      descriptors: new Map(),
      artifacts: [],
    });
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
      url: () => "https://example.test/",
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

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "navigate",
      url: "https://other.test/checkout",
    }), permit)).resolves.toEqual({ status: "failed", errorCode: "OriginViolation" });
    expect(goto).not.toHaveBeenCalled();
  });

  it("rejects credentialed same-origin navigation before page.goto", async () => {
    const goto = vi.fn(async () => undefined);
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.withPage = async (operation) => operation({ goto, url: () => "https://example.test/" } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "navigate",
      url: "https://user:pass@example.test/checkout",
    }), permit)).resolves.toEqual({ status: "failed", errorCode: "OriginViolation" });
    expect(goto).not.toHaveBeenCalled();
  });

  it("returns unknown outcome when page.goto reaches another origin before throwing", async () => {
    let currentUrl = "https://example.test/";
    const goto = vi.fn(async () => {
      currentUrl = "https://other.test/checkout";
      throw new Error("navigation timeout");
    });
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.withPage = async (operation) => operation({ goto, url: () => currentUrl } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "navigate",
      url: "https://example.test/checkout",
    }), permit)).resolves.toEqual({ status: "failed", errorCode: "ActionOutcomeUnknown" });
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

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "click",
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      graphId,
    }), permit)).resolves.toEqual({ status: "failed", errorCode: "OriginViolation" });
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

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "click",
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      graphId,
    }), permit, abort.signal)).rejects.toThrow("cancelled");
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

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "click",
      target: { nodeId, selector: actionToken(graphId, nodeId) },
      graphId,
    }), permit)).resolves.toEqual({ status: "failed", errorCode: "StaleObservation" });
    expect(click).not.toHaveBeenCalled();
  });

  it("returns unknown outcome when an element action crosses origin before throwing", async () => {
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

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "click",
      target: { nodeId, selector: actionToken(graphId, nodeId) },
      graphId,
    }), permit)).resolves.toEqual({ status: "failed", errorCode: "ActionOutcomeUnknown" });
  });

  it.each(["navigate", "click", "input", "select", "scroll"] as const)(
    "rechecks action authority after asynchronous %s preflight and before dispatch",
    async (kind) => {
      const graphId = "run-1:observation:1";
      const nodeId = "n-0-abcd1234";
      const descriptor: LocatorDescriptor = { kind: "role", role: "button", name: "Add" };
      const session = new PlaywrightBrowserSession(options(), noopLauncher);
      session.registerObservation(graphId, {
        descriptors: new Map([[nodeId, descriptor]]),
        artifacts: [],
      });
      let releasePreflight: (() => void) | undefined;
      let markPreflightStarted: (() => void) | undefined;
      const preflight = new Promise<void>((resolve) => { releasePreflight = resolve; });
      const preflightStarted = new Promise<void>((resolve) => { markPreflightStarted = resolve; });
      const sideEffect = vi.fn(async () => undefined);
      const page = {
        goto: sideEffect,
        evaluate: sideEffect,
        url: () => "https://example.test/",
        getByRole: () => ({
          count: async () => {
            markPreflightStarted?.();
            await preflight;
            return 1;
          },
          isVisible: async () => true,
          isEnabled: async () => true,
          getAttribute: async () => null,
          click: sideEffect,
          fill: sideEffect,
          selectOption: sideEffect,
          evaluate: kind === "scroll" ? sideEffect : sensitiveTargetEvaluate(),
        }),
      };
      session.withPage = async (operation) => {
        if (kind === "navigate") {
          markPreflightStarted?.();
          await preflight;
        }
        return operation(page as never);
      };
      let authorized = true;
      const authorizationWindow: ActionAuthorizationWindow = {
        assertActionAuthorized: () => {
          if (!authorized) throw new ExecutionBlockedError("LeaseExpired");
        },
      };
      const dispatchPermit = ExecutionPermit.fromAllowedDecision(
        { status: "allowed", reason: "test" },
        authorizationWindow,
      );
      const target = { nodeId, selector: actionToken(graphId, nodeId) };
      const action = kind === "navigate"
        ? { targetKind: "web", kind, url: "https://example.test/next" }
        : kind === "input" || kind === "select"
          ? { targetKind: "web", kind, target, graphId, valueRef: "profile.value" }
          : kind === "scroll"
            ? { targetKind: "web", kind, target, graphId, direction: "down", amount: "small" }
            : { targetKind: "web", kind, target, graphId };
      bindResolved(session, action);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => "private-value" });

      const execution = executor.execute(action as never, dispatchPermit);
      await preflightStarted;
      authorized = false;
      releasePreflight?.();

      await expect(execution).rejects.toMatchObject({ errorCode: "LeaseExpired" });
      expect(sideEffect).not.toHaveBeenCalled();
    },
  );

  it.each(["navigate", "click", "input", "select", "scroll"] as const)(
    "maps a successful %s dispatch followed by a cross-origin redirect to unknown outcome",
    async (kind) => {
      const graphId = "run-1:observation:1";
      const nodeId = "n-0-abcd1234";
      let currentUrl = "https://example.test/";
      const dispatch = vi.fn(async () => { currentUrl = "https://other.test/"; });
      const session = new PlaywrightBrowserSession(options(), noopLauncher);
      session.registerObservation(graphId, {
        descriptors: new Map([[nodeId, { kind: "role", role: "button", name: "Add" }]]),
        artifacts: [],
      });
      session.withPage = async (operation) => operation({
        goto: dispatch,
        evaluate: dispatch,
        url: () => currentUrl,
        getByRole: () => ({
          count: async () => 1,
          isVisible: async () => true,
          isEnabled: async () => true,
          getAttribute: async () => null,
          click: dispatch,
          fill: dispatch,
          selectOption: dispatch,
          evaluate: kind === "scroll" ? dispatch : sensitiveTargetEvaluate(),
        }),
      } as never);
      const target = { nodeId, selector: actionToken(graphId, nodeId) };
      const action = kind === "navigate"
        ? { targetKind: "web", kind, url: "https://example.test/next" }
        : kind === "input" || kind === "select"
          ? { targetKind: "web", kind, target, graphId, valueRef: "profile.value" }
          : kind === "scroll"
            ? { targetKind: "web", kind, target, graphId, direction: "down", amount: "small" }
            : { targetKind: "web", kind, target, graphId };
      bindResolved(session, action);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => "private-value" });

      await expect(executor.execute(action as never, permit)).resolves.toEqual({
        status: "failed",
        errorCode: "ActionOutcomeUnknown",
      });
      expect(dispatch).toHaveBeenCalledOnce();
    },
  );

  it("maps a successful A-to-B-to-A dispatch to unknown without poisoning a fresh dispatch", async () => {
    const graphId = "run-1:observation:1";
    const freshGraphId = "run-1:observation:2";
    const nodeId = "n-0-abcd1234";
    const descriptor: LocatorDescriptor = { kind: "role", role: "button", name: "Add" };
    let currentUrl = "https://example.test/";
    let dispatchNumber = 0;
    let frameNavigated: ((frame: object) => void) | undefined;
    const mainFrame = { url: () => currentUrl };
    const navigate = (url: string): void => {
      currentUrl = url;
      frameNavigated?.(mainFrame);
    };
    const dispatch = vi.fn(async () => {
      dispatchNumber += 1;
      if (dispatchNumber === 1) {
        navigate("https://other.test/temporary");
        navigate("https://example.test/returned");
        return;
      }
      navigate("https://example.test/next");
    });
    const page = {
      goto: vi.fn(async () => undefined),
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn((event: string, listener: (frame: object) => void) => {
        if (event === "framenavigated") frameNavigated = listener;
      }),
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        getAttribute: async () => null,
        click: dispatch,
      }),
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
    const session = new PlaywrightBrowserSession(options(), {
      launch: vi.fn(async () => browser),
    } as unknown as BrowserLauncher);
    await session.start();
    const executor = new PlaywrightActionExecutor(session);

    try {
      session.registerObservation(graphId, {
        descriptors: new Map([[nodeId, descriptor]]),
        artifacts: [],
      });
      const bouncedAction = bindResolved(session, {
        targetKind: "web" as const,
        kind: "click" as const,
        target: { nodeId, selector: actionToken(graphId, nodeId) },
        graphId,
      });

      const bouncedPermit = ExecutionPermit.fromAllowedDecision({ status: "allowed", reason: "test" });
      await expect(executor.execute(
        bouncedAction,
        bouncedPermit,
      )).resolves.toEqual({ status: "failed", errorCode: "ActionOutcomeUnknown" });
      expect(currentUrl).toBe("https://example.test/returned");
      expect(bouncedPermit.dispatchSnapshot).toEqual({ crossOriginNavigationCount: 0 });
      expect(session.currentCrossOriginNavigationCount).toBe(1);
      expect(session.hasGraph(graphId)).toBe(false);

      session.registerObservation(freshGraphId, {
        descriptors: new Map([[nodeId, descriptor]]),
        artifacts: [],
      });
      const sameOriginAction = bindResolved(session, {
        targetKind: "web" as const,
        kind: "click" as const,
        target: { nodeId, selector: actionToken(freshGraphId, nodeId) },
        graphId: freshGraphId,
      });
      const sameOriginPermit = ExecutionPermit.fromAllowedDecision({ status: "allowed", reason: "test" });
      await expect(executor.execute(
        sameOriginAction,
        sameOriginPermit,
      )).resolves.toEqual({ status: "ok" });
      expect(currentUrl).toBe("https://example.test/next");
      expect(sameOriginPermit.dispatchSnapshot).toEqual({ crossOriginNavigationCount: 1 });
      expect(session.currentCrossOriginNavigationCount).toBe(1);
      expect(dispatch).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
    }
  });

  it.each(["click", "input", "select", "scroll"] as const)(
    "accepts successful %s dispatch when a handler advances navigation generation on the target origin",
    async (kind) => {
      const graphId = "run-1:observation:1";
      const nodeId = "n-0-abcd1234";
      let currentUrl = "https://example.test/";
      const mainFrame = { url: () => currentUrl };
      let frameNavigated: ((frame: object) => void) | undefined;
      const dispatch = vi.fn(async () => {
        currentUrl = "https://example.test/next";
        frameNavigated?.(mainFrame);
      });
      const page = {
        goto: vi.fn(async () => undefined),
        url: () => currentUrl,
        mainFrame: () => mainFrame,
        on: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") frameNavigated = listener;
        }),
        getByRole: () => ({
          count: async () => 1,
          isVisible: async () => true,
          isEnabled: async () => true,
          getAttribute: async () => null,
          click: dispatch,
          fill: dispatch,
          selectOption: dispatch,
          evaluate: kind === "scroll" ? dispatch : sensitiveTargetEvaluate(),
        }),
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
      const session = new PlaywrightBrowserSession(options(), {
        launch: vi.fn(async () => browser),
      } as unknown as BrowserLauncher);
      await session.start();
      session.registerObservation(graphId, {
        descriptors: new Map([[nodeId, { kind: "role", role: "button", name: "Add" }]]),
        artifacts: [],
      });
      const target = { nodeId, selector: actionToken(graphId, nodeId) };
      const action = kind === "input" || kind === "select"
        ? { targetKind: "web", kind, target, graphId, valueRef: "profile.value" }
        : kind === "scroll"
          ? { targetKind: "web", kind, target, graphId, direction: "down", amount: "small" }
          : { targetKind: "web", kind, target, graphId };
      bindResolved(session, action);
      const executor = new PlaywrightActionExecutor(session, { resolve: async () => "private-value" });

      try {
        await expect(executor.execute(
          action as never,
          ExecutionPermit.fromAllowedDecision({ status: "allowed", reason: "test" }),
        )).resolves.toEqual({ status: "ok" });
        expect(session.currentNavigationGeneration).toBe(1);
        expect(session.hasGraph(graphId)).toBe(false);
        await expect(executor.execute(
          action as never,
          ExecutionPermit.fromAllowedDecision({ status: "allowed", reason: "test" }),
        )).resolves.toEqual({ status: "failed", errorCode: "OriginViolation" });
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        await session.close();
      }
    },
  );

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

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "navigate",
      url: "https://example.test/checkout",
    }), permit)).resolves.toEqual({ status: "ok" });
    session.registerObservation(graphId, {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "button", name: "Add" }]]),
      artifacts: [],
    });
    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "scroll",
      graphId,
      direction: "down",
      amount: "page",
    }), permit)).resolves.toEqual({ status: "ok" });

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

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "scroll",
      graphId,
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      direction: "down",
      amount,
    }), permit)).resolves.toEqual({ status: "ok" });

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
      evaluate: sensitiveTargetEvaluate("plaintext-secret"),
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

    await expect(executor.execute(bindResolved(session, action), permit)).resolves.toEqual({ status: "ok" });
    expect(calls).toEqual(["resolve:customer.email", `${method}:plaintext-secret`]);
  });

  it("fails evidence availability when post-dispatch target identity cannot be proven", async () => {
    const graphId = "run-1:observation:1";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "textbox", name: "Email" }]]),
      artifacts: [],
    });
    const locator = {
      count: async () => 1,
      isVisible: async () => true,
      isEnabled: async () => true,
      getAttribute: async () => null,
      fill: async () => undefined,
      evaluate: vi.fn(async (_callback: unknown, argument: unknown) => {
        if (typeof argument === "object" && argument !== null && "markerId" in argument) {
          return undefined;
        }
        return { sensitiveTargetIds: [], value: "plaintext-secret" };
      }),
    };
    session.withPage = async (operation) => operation({
      getByRole: () => locator,
      url: () => "https://example.test/",
    } as never);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "plaintext-secret" });

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "input",
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      graphId,
      valueRef: "customer.email",
    }), ExecutionPermit.fromAllowedDecision({ status: "allowed", reason: "test" }))).resolves.toEqual({ status: "ok" });
    expect(() => session.assertSensitiveEvidenceAvailable())
      .toThrowError(expect.objectContaining({ code: "SensitiveEvidenceUnavailable" }));
    expect(JSON.stringify(locator.evaluate.mock.calls)).not.toContain("plaintext-secret");
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

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "input",
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      graphId,
      valueRef: "customer.email",
    }), permit)).resolves.toEqual({ status: "failed", errorCode: "ActionValueUnavailable" });
  });

  it("returns unknown outcome for an invoked infrastructure failure without Playwright plaintext", async () => {
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

    const failure = await executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "input",
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      graphId,
      valueRef: "customer.email",
    }), permit);
    expect(failure).toEqual({ status: "failed", errorCode: "ActionOutcomeUnknown" });
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain("plaintext-secret");
  });

  it.each([
    ["navigate", "goto"],
    ["click", "click"],
    ["input", "fill"],
    ["select", "selectOption"],
    ["scroll", "evaluate"],
  ] as const)("maps a generic %s rejection after %s invocation to unknown outcome", async (kind, method) => {
    const graphId = "run-1:observation:1";
    const nodeId = "n-0-abcd1234";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([[nodeId, { kind: "role", role: "button", name: "Add" }]]),
      artifacts: [],
    });
    const invoked = vi.fn(async () => { throw new Error("generic Playwright failure"); });
    session.withPage = async (operation) => operation({
      goto: method === "goto" ? invoked : vi.fn(),
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        getAttribute: async () => null,
        click: method === "click" ? invoked : vi.fn(),
        fill: method === "fill" ? invoked : vi.fn(),
        selectOption: method === "selectOption" ? invoked : vi.fn(),
        evaluate: method === "evaluate" ? invoked : vi.fn(),
      }),
      url: () => "https://example.test/",
    } as never);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => "secret" });
    const target = { nodeId, selector: actionToken(graphId, nodeId) };
    const action = kind === "navigate"
      ? { targetKind: "web", kind, url: "https://example.test/next" }
      : kind === "input" || kind === "select"
        ? { targetKind: "web", kind, target, graphId, valueRef: "profile.value" }
        : kind === "scroll"
          ? { targetKind: "web", kind, target, graphId, direction: "down", amount: "small" }
          : { targetKind: "web", kind, target, graphId };
    bindResolved(session, action);

    await expect(executor.execute(action as never, permit)).resolves.toEqual({
      status: "failed",
      errorCode: "ActionOutcomeUnknown",
    });
    expect(invoked).toHaveBeenCalledOnce();
  });

  it("maps a page crash that also makes URL inspection fail to unknown outcome", async () => {
    const graphId = "run-1:observation:1";
    const nodeId = "n-0-abcd1234";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([[nodeId, { kind: "role", role: "button", name: "Add" }]]),
      artifacts: [],
    });
    let crashed = false;
    session.withPage = async (operation) => operation({
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        getAttribute: async () => null,
        click: async () => {
          crashed = true;
          throw new Error("page crashed");
        },
      }),
      url: () => {
        if (crashed) throw new Error("page closed");
        return "https://example.test/";
      },
    } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "click",
      target: { nodeId, selector: actionToken(graphId, nodeId) },
      graphId,
    }), permit)).resolves.toEqual({ status: "failed", errorCode: "ActionOutcomeUnknown" });
  });

  it("maps an unreadable post-dispatch page origin to unknown outcome", async () => {
    const graphId = "run-1:observation:1";
    const nodeId = "n-0-abcd1234";
    let dispatched = false;
    const click = vi.fn(async () => { dispatched = true; });
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
        click,
      }),
      url: () => {
        if (dispatched) throw new Error("page closed");
        return "https://example.test/";
      },
    } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "click",
      target: { nodeId, selector: actionToken(graphId, nodeId) },
      graphId,
    }), permit)).resolves.toEqual({ status: "failed", errorCode: "ActionOutcomeUnknown" });
    expect(click).toHaveBeenCalledOnce();
  });

  it("keeps disabled-target rejection blocked before click dispatch", async () => {
    const graphId = "run-1:observation:1";
    const nodeId = "n-0-abcd1234";
    const click = vi.fn();
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([[nodeId, { kind: "role", role: "button", name: "Add" }]]),
      artifacts: [],
    });
    session.withPage = async (operation) => operation({
      getByRole: () => ({
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => false,
        getAttribute: async () => null,
        click,
      }),
      url: () => "https://example.test/",
    } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "click",
      target: { nodeId, selector: actionToken(graphId, nodeId) },
      graphId,
    }), permit)).resolves.toEqual({ status: "failed", errorCode: "TargetDisabled" });
    expect(click).not.toHaveBeenCalled();
  });

  it("keeps a generic pre-dispatch locator failure blocked without invoking click", async () => {
    const graphId = "run-1:observation:1";
    const nodeId = "n-0-abcd1234";
    const click = vi.fn();
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([[nodeId, { kind: "role", role: "button", name: "Add" }]]),
      artifacts: [],
    });
    session.withPage = async (operation) => operation({
      getByRole: () => ({
        count: async () => { throw new Error("locator transport failure"); },
        click,
      }),
      url: () => "https://example.test/",
    } as never);
    const executor = new PlaywrightActionExecutor(session);

    await expect(executor.execute(bindResolved(session, {
      targetKind: "web",
      kind: "click",
      target: { nodeId, selector: actionToken(graphId, nodeId) },
      graphId,
    }), permit)).resolves.toEqual({ status: "failed", errorCode: "ActionFailed" });
    expect(click).not.toHaveBeenCalled();
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
    ["SensitiveEvidenceUnavailable", "error"],
    ["UnsupportedAction", "blocked"],
    ["ConcurrentSessionOperation", "error"],
    ["SessionClosed", "error"],
    ["ActionInfrastructureFailure", "error"],
  ] as const)("classifies WebTargetError %s as %s", (code, completionStatus) => {
    expect(new WebTargetError(code)).toMatchObject({ code, completionStatus });
  });
});
