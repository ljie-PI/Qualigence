import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcceptedExecutionJob } from "@qualigence/runner-protocol";
import {
  PlaywrightBrowserSession,
  PlaywrightObserver,
  type WebSessionOptions,
} from "@qualigence/web-playwright/internal";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";

const OBSERVATION_FIXTURE = htmlDocument(
  `
    <h1 data-qualigence-observe>Storefront</h1>
    <button id="add">Add to cart</button>
    <p data-qualigence-observe id="total">Cart total: $0</p>
    <button disabled>Checkout</button>
    <label for="pw">Password</label>
    <input id="pw" type="password" value="hunter2" />
  `,
  "Storefront",
);

describe("PlaywrightObserver against real Chromium", () => {
  let fixture: FixtureServer;
  let session: PlaywrightBrowserSession;

  beforeEach(async () => {
    fixture = await startFixtureServer({ "/": OBSERVATION_FIXTURE });
  });

  afterEach(async () => {
    await session?.close();
    await fixture?.close();
  });

  function options(): WebSessionOptions {
    return {
      url: fixture.url,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      allowedOrigins: [fixture.origin],
    };
  }

  const job: AcceptedExecutionJob = {
    jobId: "job-observe",
    runId: "run-observe",
    target: { kind: "web", url: "http://placeholder.test" },
    objective: "Observe storefront",
    policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["http://placeholder.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
  };

  it("captures a semantic graph with stable, unique node ids and no leaked selectors", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);

    const graph = await observer.capture({ ...job, target: { kind: "web", url: fixture.url } });

    expect(graph.graphId).toBe("run-observe:observation:1");
    expect(graph.url).toBe(fixture.url);

    const ids = graph.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);

    const addButton = graph.nodes.find(
      (node) => node.role === "button" && node.name === "Add to cart",
    );
    expect(addButton).toBeDefined();

    const total = graph.nodes.find((node) => node.text?.includes("Cart total"));
    expect(total).toBeDefined();

    const disabled = graph.nodes.find((node) => node.disabled === true);
    expect(disabled).toMatchObject({ name: "Checkout" });

    const password = graph.nodes.find((node) => node.name === "Password");
    expect(password).toBeDefined();

    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("#add");
    expect(serialized).not.toContain("data-qualigence-node");
    expect(serialized.toLowerCase()).not.toContain("xpath");
    for (const node of graph.nodes) {
      expect(node).not.toHaveProperty("selector");
    }
  });

  it("advances the observation ordinal on each capture", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);

    const first = await observer.capture(job);
    const second = await observer.capture(job);
    expect(first.graphId).toBe("run-observe:observation:1");
    expect(second.graphId).toBe("run-observe:observation:2");
  });
});
