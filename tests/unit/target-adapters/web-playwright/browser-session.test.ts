import { describe, expect, it, vi } from "vitest";
import {
  PlaywrightBrowserSession,
  PRIVATE_TARGET_ATTRIBUTE,
  WebTargetError,
  createBoundedCdpSession,
  inventoryPiercedDom,
  isOriginAllowed,
  normalizeOrigin,
  type BrowserLauncher,
  type RawCdpSession,
  type WebSessionOptions,
} from "@qualigence/web-playwright/internal";

function baseOptions(
  overrides: Partial<WebSessionOptions> = {},
): WebSessionOptions {
  return {
    url: "https://example.test/",
    headed: false,
    navigationTimeoutMs: 5_000,
    actionTimeoutMs: 5_000,
    allowedOrigins: ["https://example.test"],
    ...overrides,
  };
}

function fakeLauncher(promiseAttested = true): {
  launcher: BrowserLauncher;
  launch: ReturnType<typeof vi.fn>;
  addInitScript: ReturnType<typeof vi.fn>;
  newPage: ReturnType<typeof vi.fn>;
  closed: () => boolean;
} {
  let browserClosed = false;
  const registry = {
    snapshot: () => ({ roots: [], hosts: [], count: 0, closedMutationCount: 0, overflow: false, intact: true }),
  };
  const registryHandle = {
    evaluate: vi.fn(async (callback: (value: typeof registry, maximumRoots: number) => unknown, maximumRoots: number) =>
      callback(registry, maximumRoots)),
    dispose: vi.fn(async () => undefined),
  };
  const promiseAuthority = {
    attest: (_epoch: string) => promiseAttested,
    close: () => true,
  };
  const promiseHandle = {
    evaluate: vi.fn(async (
      callback: (value: typeof promiseAuthority, argument?: string) => unknown,
      argument?: string,
    ) => callback(promiseAuthority, argument)),
    dispose: vi.fn(async () => undefined),
  };
  let handleIndex = 0;
  const page = {
    goto: vi.fn(async () => null),
    url: () => "https://example.test/",
    close: vi.fn(async () => undefined),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    evaluateHandle: vi.fn(async () => handleIndex++ === 0 ? registryHandle : promiseHandle),
  };
  const newPage = vi.fn(async () => page);
  const addInitScript = vi.fn(async () => undefined);
  const context = {
    newPage,
    addInitScript,
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {
      browserClosed = true;
    }),
  };
  const launch = vi.fn(async () => browser);
  return {
    launcher: { launch } as unknown as BrowserLauncher,
    launch,
    addInitScript,
    newPage,
    closed: () => browserClosed,
  };
}

describe("PlaywrightBrowserSession", () => {
  it("stops bounded pierced CDP inventory before a hostile shadow tree exceeds its cap", async () => {
    const requests: { readonly method: string; readonly depth: number | undefined }[] = [];
    const raw: RawCdpSession = {
      getDocument: async () => {
        requests.push({ method: "DOM.getDocument", depth: 0 });
        return {
          root: { nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: "#document", childNodeCount: 1 },
        };
      },
      describeNode: async (params) => {
        requests.push({ method: "DOM.describeNode", depth: 1 });
        if (!("nodeId" in params)) throw new Error("Unexpected backend node reference");
        const nodeId = params.nodeId;
        if (nodeId === 1 || nodeId >= 3) {
          return {
            node: {
              nodeId,
              backendNodeId: nodeId,
              nodeType: nodeId === 1 ? 9 : 1,
              nodeName: nodeId === 1 ? "#document" : "DIV",
              childNodeCount: 1,
              children: [{
                nodeId: nodeId + 1,
                backendNodeId: nodeId + 1,
                nodeType: 1,
                nodeName: "DIV",
                childNodeCount: 0,
              }],
            },
          };
        }
        return {
          node: {
            nodeId,
            backendNodeId: nodeId,
            nodeType: 1,
            nodeName: "DIV",
            childNodeCount: 0,
            shadowRoots: [{
              nodeId: 3,
              backendNodeId: 3,
              nodeType: 11,
              nodeName: "#document-fragment",
              childNodeCount: 1,
              shadowRootType: "open",
            }],
          },
        };
      },
      resolveNode: async () => ({}),
      callFunctionOn: async () => ({}),
      releaseObjectGroup: async () => ({}),
    };
    const session = createBoundedCdpSession(raw, 4_096);

    await expect(inventoryPiercedDom(session, {
      maximumNodes: 4_096,
      maximumShadowRoots: 64,
      maximumFrames: 64,
    })).rejects.toThrow();

    expect(requests.every(({ depth }) => depth === 0 || depth === 1)).toBe(true);
    expect(requests.some(({ method }) => method === "DOMSnapshot.captureSnapshot")).toBe(false);
    expect(requests.length).toBeLessThanOrEqual(4_096);
  });

  it("rejects oversized raw CDP children before reading an array entry", async () => {
    let firstChildRead = false;
    const children = new Array(4_097);
    Object.defineProperty(children, 0, {
      get: () => {
        firstChildRead = true;
        throw new Error("raw child was materialized");
      },
    });
    const session = createBoundedCdpSession({
      getDocument: async () => ({
        root: { nodeId: 1, backendNodeId: 1, nodeType: 9, childNodeCount: 0 },
      }),
      describeNode: async () => ({
        node: {
          nodeId: 1,
          backendNodeId: 1,
          nodeType: 9,
          childNodeCount: children.length,
          children,
        },
      }),
      resolveNode: async () => ({}),
      callFunctionOn: async () => ({}),
      releaseObjectGroup: async () => ({}),
    }, 4_096);

    await expect(inventoryPiercedDom(session, {
      maximumNodes: 4_096,
      maximumShadowRoots: 64,
      maximumFrames: 64,
    })).rejects.toThrow("cdp-response-unproven");
    expect(firstChildRead).toBe(false);
  });

  it("rejects raw CDP accessors and descendants deeper than the requested response", async () => {
    const hostileRoot = { nodeId: 1, backendNodeId: 1, nodeType: 9, childNodeCount: 0 };
    Object.defineProperty(hostileRoot, "children", {
      get: () => { throw new Error("hostile children getter"); },
    });
    const accessorSession = createBoundedCdpSession({
      getDocument: async () => ({ root: hostileRoot }),
      describeNode: async () => ({}),
      resolveNode: async () => ({}),
      callFunctionOn: async () => ({}),
      releaseObjectGroup: async () => ({}),
    }, 4_096);

    await expect(inventoryPiercedDom(accessorSession, {
      maximumNodes: 4_096,
      maximumShadowRoots: 64,
      maximumFrames: 64,
    })).rejects.toThrow("cdp-response-unproven");

    const nestedSession = createBoundedCdpSession({
      getDocument: async () => ({
        root: { nodeId: 1, backendNodeId: 1, nodeType: 9, childNodeCount: 0 },
      }),
      describeNode: async () => ({
        node: {
          nodeId: 1,
          backendNodeId: 1,
          nodeType: 9,
          childNodeCount: 1,
          children: [{
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            childNodeCount: 1,
            children: [{ nodeId: 3, backendNodeId: 3, nodeType: 1, childNodeCount: 0 }],
          }],
        },
      }),
      resolveNode: async () => ({}),
      callFunctionOn: async () => ({}),
      releaseObjectGroup: async () => ({}),
    }, 4_096);

    await expect(inventoryPiercedDom(nestedSession, {
      maximumNodes: 4_096,
      maximumShadowRoots: 64,
      maximumFrames: 64,
    })).rejects.toThrow("cdp-response-unproven");
  });

  it("starts once and closes idempotently", async () => {
    const { launcher, launch, closed } = fakeLauncher();
    const session = new PlaywrightBrowserSession(baseOptions(), launcher);

    await Promise.all([session.start(), session.start()]);
    expect(launch).toHaveBeenCalledTimes(1);

    await session.close();
    await session.close();
    expect(closed()).toBe(true);
  });

  it("installs private shadow and Promise instrumentation before creating or navigating the application page", async () => {
    const { launcher, addInitScript, newPage } = fakeLauncher();
    const session = new PlaywrightBrowserSession(baseOptions(), launcher);

    await session.start();

    expect(addInitScript).toHaveBeenCalledOnce();
    expect(newPage).toHaveBeenCalledOnce();
    expect(addInitScript.mock.invocationCallOrder[0]).toBeLessThan(
      newPage.mock.invocationCallOrder[0]!,
    );
    const page = await newPage.mock.results[0]?.value;
    expect(newPage.mock.invocationCallOrder[0]).toBeLessThan(
      page.goto.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects sensitive activation for a page adopted after application execution", async () => {
    const { launcher } = fakeLauncher(false);
    const session = new PlaywrightBrowserSession(baseOptions(), launcher);
    await session.start();

    await expect(session.beginSensitiveActionTracking(
      {} as never,
      "input",
      "sensitive-value",
    )).rejects.toMatchObject({ code: "SensitiveEvidenceUnproven" });
  });

  it("removes an installed private target marker before closing the page", async () => {
    const { launcher } = fakeLauncher();
    const session = new PlaywrightBrowserSession(baseOptions(), launcher);
    await session.start();
    const attributes = new Map<string, string>();
    const dispose = vi.fn(async () => undefined);
    interface FakeHandle {
      setAttribute(name: string, value: string): void;
      getAttribute(name: string): string | null;
      removeAttribute(name: string): void;
      evaluate(
        callback: (element: FakeHandle, argument: never) => unknown,
        argument: never,
      ): Promise<unknown>;
      dispose(): Promise<void>;
    }
    const handle: FakeHandle = {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name) ?? null,
      removeAttribute: (name: string) => attributes.delete(name),
      evaluate: async (callback, argument) =>
        callback(handle, argument),
      dispose,
    };
    const locator = { elementHandle: async () => handle };
    await session.establishPrivateActionTarget(
      "run-1:observation:1",
      "n-0-abcd1234",
      locator as never,
    );
    await session.registerSensitiveActionTarget(
      "run-1:observation:1",
      "n-0-abcd1234",
    );
    expect(attributes.has(PRIVATE_TARGET_ATTRIBUTE)).toBe(true);

    await session.close();

    expect(attributes.has(PRIVATE_TARGET_ATTRIBUTE)).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects a non-http(s) scheme before launching a browser", async () => {
    const { launcher, launch } = fakeLauncher();
    const session = new PlaywrightBrowserSession(
      baseOptions({ url: "file:///etc/passwd", allowedOrigins: [] }),
      launcher,
    );

    await expect(session.start()).rejects.toMatchObject({
      code: "NavigationFailed",
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a URL that embeds credentials", async () => {
    const { launcher, launch } = fakeLauncher();
    const session = new PlaywrightBrowserSession(
      baseOptions({ url: "https://user:secret@example.test/" }),
      launcher,
    );

    await expect(session.start()).rejects.toMatchObject({
      code: "NavigationFailed",
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a target origin that is not in the allowlist", async () => {
    const { launcher, launch } = fakeLauncher();
    const session = new PlaywrightBrowserSession(
      baseOptions({ url: "https://evil.test/", allowedOrigins: ["https://example.test"] }),
      launcher,
    );

    await expect(session.start()).rejects.toMatchObject({
      code: "OriginViolation",
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("wraps a browser launch failure as BrowserLaunchFailed", async () => {
    const source = "source-plaintext-secret";
    const normalized = "normalized-plaintext-secret";
    const launch = vi.fn(async () => {
      throw new Error(`no sandbox ${source} ${normalized}`);
    });
    const session = new PlaywrightBrowserSession(
      baseOptions(),
      { launch } as unknown as BrowserLauncher,
    );

    const failure = await session.start().catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "BrowserLaunchFailed" });
    expect(String(failure)).not.toContain(source);
    expect(String(failure)).not.toContain(normalized);
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(source);
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(normalized);
    expect(failure).not.toHaveProperty("cause");
  });

  it("rejects page operations after the session is closed", async () => {
    const { launcher } = fakeLauncher();
    const session = new PlaywrightBrowserSession(baseOptions(), launcher);
    await session.start();
    await session.close();

    await expect(session.withPage(async () => "unreachable")).rejects.toMatchObject({
      code: "SessionClosed",
    });
  });

  it("exposes origin helpers used by the executor allowlist", () => {
    expect(normalizeOrigin("https://example.test/a/b?x=1")).toBe("https://example.test");
    expect(isOriginAllowed("https://example.test/page", ["https://example.test"])).toBe(true);
    expect(isOriginAllowed("https://evil.test/page", ["https://example.test"])).toBe(false);
    expect(() => new WebTargetError("NavigationFailed")).not.toThrow();
  });
});
