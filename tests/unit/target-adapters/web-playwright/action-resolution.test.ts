import { describe, expect, it, vi } from "vitest";
import type { ObservationGraph } from "@qualigence/runner-protocol";
import { ExecutionPermit, type ProposedAction } from "@qualigence/runner-kernel";
import {
  PlaywrightActionExecutor,
  PlaywrightActionResolver,
  PlaywrightBrowserSession,
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
});

describe("PlaywrightActionExecutor value resolution", () => {
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
      selectOption: async (value: string) => {
        calls.push(`selectOption:${value}`);
        return [value];
      },
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

  it("keeps browser-normalized input forms out of global redaction", async () => {
    const graphId = "run-1:observation:1";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "textbox", name: "Notes" }]]),
      artifacts: [],
    });
    const source = "a\r\nb\r\n";
    const browserValue = "ab";
    const locator = {
      count: async () => 1,
      isVisible: async () => true,
      isEnabled: async () => true,
      getAttribute: async () => null,
      fill: async () => undefined,
    };
    session.withPage = async (operation) => operation({
      getByRole: () => locator,
      url: () => "https://example.test/",
    } as never);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => source });

    await expect(executor.execute({
      targetKind: "web",
      kind: "input",
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      graphId,
      valueRef: "customer.notes",
    }, permit)).resolves.toEqual({ status: "ok" });

    expect(session.redactSensitiveText(source)).toBe("[REDACTED]");
    expect(session.redactSensitiveText(browserValue)).toBe(browserValue);
    expect(session.redactSensitiveText("ab")).toBe("ab");
  });

  it("maps a sensitive target descriptor to its next observation identity", async () => {
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    const descriptor = { kind: "role", role: "textbox", name: "Notes" } as const;
    session.registerSensitiveActionTarget("n-old", descriptor);

    expect(session.sensitiveTargetFor(new Map<string, LocatorDescriptor>([
      ["n-unrelated", { kind: "text", role: "text", text: "ab" } as const],
      ["n-new", descriptor],
    ]))).toEqual({ nodeId: "n-new", descriptor });
  });

  it("clears sensitive target and source state when the session closes", async () => {
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    const descriptor = { kind: "role", role: "textbox", name: "Notes" } as const;
    session.registerSensitiveActionTarget("n-old", descriptor);
    session.registerSensitiveValue("source-secret");

    await session.close();

    expect(session.sensitiveTargetFor(new Map([["n-new", descriptor]]))).toBeUndefined();
    expect(session.redactSensitiveText("source-secret")).toBe("source-secret");
  });

  it("keeps browser-normalized select forms out of global redaction", async () => {
    const graphId = "run-1:observation:1";
    const session = new PlaywrightBrowserSession(options(), noopLauncher);
    session.registerObservation(graphId, {
      descriptors: new Map([["n-0-abcd1234", { kind: "role", role: "combobox", name: "Country" }]]),
      artifacts: [],
    });
    const locator = {
      count: async () => 1,
      isVisible: async () => true,
      isEnabled: async () => true,
      getAttribute: async () => null,
      selectOption: async () => ["browser-selected-option"],
    };
    session.withPage = async (operation) => operation({
      getByRole: () => locator,
      url: () => "https://example.test/",
    } as never);
    const executor = new PlaywrightActionExecutor(session, {
      resolve: async () => "provider-option",
    });

    await expect(executor.execute({
      targetKind: "web",
      kind: "select",
      target: { nodeId: "n-0-abcd1234", selector: actionToken(graphId, "n-0-abcd1234") },
      graphId,
      valueRef: "customer.country",
    }, permit)).resolves.toEqual({ status: "ok" });

    expect(session.redactSensitiveText("provider-option")).toBe("[REDACTED]");
    expect(session.redactSensitiveText("browser-selected-option")).toBe("browser-selected-option");
    expect(session.redactSensitiveText("browser-selected remains unrelated")).toBe(
      "browser-selected remains unrelated",
    );
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
});
