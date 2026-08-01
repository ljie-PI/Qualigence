import { describe, expect, it, vi } from "vitest";
import type { ObservationGraph } from "@qualigence/runner-protocol";
import type { ProposedAction } from "@qualigence/runner-kernel";
import {
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

function click(nodeId: string): ProposedAction {
  return { kind: "click", target: { nodeId }, reason: "test" };
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
});
