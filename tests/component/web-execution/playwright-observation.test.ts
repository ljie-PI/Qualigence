import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEB_EXTENSION_V1_REDACTION_MARKER,
  WEB_EXTENSION_V1_TYPE,
  observationGraphHash,
  validateObservationGraphV1,
  type AcceptedExecutionJob,
  type ObservationGraphV1,
} from "@qualigence/runner-protocol";
import {
  PlaywrightBrowserSession,
  PlaywrightObserver,
  type BrowserLauncher,
  type WebSessionOptions,
} from "@qualigence/web-playwright/internal";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";

function isPromiseOwnerValidation(functionValue: unknown): boolean {
  return typeof functionValue === "function" && functionValue.name === "validateSensitivePromiseOwnerRegistryInPage";
}

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
      url: `${fixture.url}?ref=abc&token=secret#frag`,
      expectedOrigin: fixture.origin,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      allowedOrigins: [fixture.origin],
      allowedWebQueryKeys: ["ref"],
    };
  }

  const job: AcceptedExecutionJob = {
    jobId: "job-observe",
    runId: "run-observe",
    projectId: "project-test",
    target: { kind: "web", url: "http://placeholder.test" },
    objective: "Observe storefront",
    policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["http://placeholder.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
  };

  it("captures a validated Graph v1 with web/v1 metadata and no leaked selectors or query values", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);

    const graph = await observer.capture({ ...job, target: { kind: "web", url: fixture.url } }) as ObservationGraphV1;

    expect(graph.graphId).toBe("run-observe:observation:1");
    expect(() => validateObservationGraphV1(graph, { allowedWebQueryKeys: ["ref"] })).not.toThrow();
    expect(observationGraphHash(graph, { allowedWebQueryKeys: ["ref"] })).toMatch(/^[0-9a-f]{64}$/);
    expect(graph.target).toEqual({ kind: "web", targetId: fixture.origin });
    expect(graph.rootNodeIds).toEqual(["n-000000-document"]);
    expect(graph.evidenceRefs).toEqual(["1-observation.json", "1.png"]);
    expect(graph.extensions?.[WEB_EXTENSION_V1_TYPE]).toMatchObject({
      type: WEB_EXTENSION_V1_TYPE,
      payload: {
        origin: fixture.origin,
        pathname: "/",
        title: "Storefront",
        query: { ref: WEB_EXTENSION_V1_REDACTION_MARKER },
      },
    });

    const ids = graph.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(graph.nodes[0]).toMatchObject({
      id: "n-000000-document",
      role: "document",
      source: { adapterId: "web-playwright", sourceKind: "document" },
      sensitivity: "public",
    });

    const addButton = graph.nodes.find(
      (node) => node.role === "button" && node.name === "Add to cart",
    );
    expect(addButton).toMatchObject({
      source: { adapterId: "web-playwright", sourceKind: "dom" },
      state: { disabled: false },
      sensitivity: "public",
    });

    const total = graph.nodes.find((node) => node.name?.includes("Cart total"));
    expect(total).toBeDefined();

    const disabled = graph.nodes.find((node) => node.state.disabled === true);
    expect(disabled).toMatchObject({ name: "Checkout" });

    const password = graph.nodes.find((node) => node.name === "Password");
    expect(password).toBeDefined();
    expect(password).not.toHaveProperty("value");

    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("#add");
    expect(serialized).not.toContain("data-qualigence-node");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("abc");
    expect(serialized).not.toContain("frag");
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

  it("discards a capture when the page crosses origin during DOM collection", async () => {
    const otherOrigin = "https://other.test";
    let currentUrl = fixture.url;
    const evaluate = vi.fn(async () => ({
      candidates: [{ role: "button", name: "Private account" }],
      viewport: { width: 800, height: 600, devicePixelRatio: 1 },
    }));
    const title = vi.fn(async () => "Private account");
    const screenshot = vi.fn(async () => new TextEncoder().encode("private screenshot"));
    session = new PlaywrightBrowserSession(options());
    session.withPage = async (operation) => operation({
      url: () => currentUrl,
      evaluate,
      title,
      screenshot,
    } as never);
    const observer = new PlaywrightObserver(session, {
      afterDomCollection: () => {
        currentUrl = `${otherOrigin}/private`;
      },
    });

    await expect(observer.capture({
      ...job,
      target: { kind: "web", url: fixture.url },
    })).rejects.toMatchObject({ code: "OriginViolation" });

    expect(evaluate).toHaveBeenCalledOnce();
    expect(title).not.toHaveBeenCalled();
    expect(screenshot).not.toHaveBeenCalled();
    currentUrl = fixture.url;
    expect(() => session.artifactsFor("run-observe:observation:1"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  });

  it("discards a capture when main-frame navigation leaves and returns during collection", async () => {
    let currentUrl = fixture.url;
    const mainFrame = { url: () => currentUrl };
    let frameNavigated: ((frame: object) => void) | undefined;
    const page = {
      goto: vi.fn(async () => undefined),
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn((event: string, listener: (frame: object) => void) => {
        if (event === "framenavigated") frameNavigated = listener;
      }),
      evaluate: vi.fn(async () => ({
        candidates: [{ role: "button", name: "Matching control" }],
        viewport: { width: 800, height: 600, devicePixelRatio: 1 },
      })),
      title: vi.fn(async () => "Matching page"),
      screenshot: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
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
    session = new PlaywrightBrowserSession(options(), {
      launch: vi.fn(async () => browser),
    } as unknown as BrowserLauncher);
    await session.start();
    const observer = new PlaywrightObserver(session, {
      afterDomCollection: () => {
        currentUrl = "https://other.test/private";
        frameNavigated?.(mainFrame);
        currentUrl = fixture.url;
        frameNavigated?.(mainFrame);
      },
    });

    await expect(observer.capture(job)).rejects.toMatchObject({ code: "OriginViolation" });
    expect(page.title).not.toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(() => session.artifactsFor("run-observe:observation:1"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  });

  it("blocks an unreadable URL before reading the DOM", async () => {
    const evaluate = vi.fn();
    const title = vi.fn();
    const screenshot = vi.fn();
    session = new PlaywrightBrowserSession(options());
    session.withPage = async (operation) => operation({
      url: () => { throw new Error("page crashed"); },
      evaluate,
      title,
      screenshot,
    } as never);

    await expect(new PlaywrightObserver(session).capture({
      ...job,
      target: { kind: "web", url: fixture.url },
    })).rejects.toMatchObject({ code: "OriginViolation" });

    expect(evaluate).not.toHaveBeenCalled();
    expect(title).not.toHaveBeenCalled();
    expect(screenshot).not.toHaveBeenCalled();
  });

  it("allows a delayed path change on the configured target origin", async () => {
    let currentUrl = fixture.url;
    const evaluate = vi.fn(async (functionValue: unknown) => isPromiseOwnerValidation(functionValue)
      ? { status: "ok" }
      : {
        candidates: [{ role: "button", name: "Continue" }],
        viewport: { width: 800, height: 600, devicePixelRatio: 1 },
      });
    const title = vi.fn(async () => "Same origin");
    const screenshot = vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    session = new PlaywrightBrowserSession(options());
    session.withPage = async (operation) => operation({
      url: () => currentUrl,
      evaluate,
      title,
      screenshot,
    } as never);
    const observer = new PlaywrightObserver(session, {
      afterDomCollection: () => {
        currentUrl = `${fixture.origin}/after`;
      },
    });

    const graph = await observer.capture({
      ...job,
      target: { kind: "web", url: fixture.url },
    }) as ObservationGraphV1;

    expect(graph.extensions?.[WEB_EXTENSION_V1_TYPE]?.payload).toMatchObject({
      origin: fixture.origin,
      pathname: "/after",
      title: "Same origin",
    });
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "button", name: "Continue" }),
    ]));
    expect(session.artifactsFor(graph.graphId)).toHaveLength(2);
  });
});
