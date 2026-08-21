import { describe, expect, it, vi } from "vitest";
import {
  PlaywrightBrowserSession,
  PRIVATE_TARGET_ATTRIBUTE,
  WebTargetError,
  isOriginAllowed,
  normalizeOrigin,
  type BrowserLauncher,
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

function fakeLauncher(): {
  launcher: BrowserLauncher;
  launch: ReturnType<typeof vi.fn>;
  addInitScript: ReturnType<typeof vi.fn>;
  newPage: ReturnType<typeof vi.fn>;
  closed: () => boolean;
} {
  let browserClosed = false;
  const registry = {
    snapshot: () => ({ roots: [], count: 0, closedMutationCount: 0, overflow: false, intact: true }),
  };
  const registryHandle = {
    evaluate: vi.fn(async (callback: (value: typeof registry, maximumRoots: number) => unknown, maximumRoots: number) =>
      callback(registry, maximumRoots)),
    dispose: vi.fn(async () => undefined),
  };
  const page = {
    goto: vi.fn(async () => null),
    url: () => "https://example.test/",
    close: vi.fn(async () => undefined),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    evaluateHandle: vi.fn(async () => registryHandle),
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
  it("starts once and closes idempotently", async () => {
    const { launcher, launch, closed } = fakeLauncher();
    const session = new PlaywrightBrowserSession(baseOptions(), launcher);

    await Promise.all([session.start(), session.start()]);
    expect(launch).toHaveBeenCalledTimes(1);

    await session.close();
    await session.close();
    expect(closed()).toBe(true);
  });

  it("installs the private shadow hook before creating the application page", async () => {
    const { launcher, addInitScript, newPage } = fakeLauncher();
    const session = new PlaywrightBrowserSession(baseOptions(), launcher);

    await session.start();

    expect(addInitScript).toHaveBeenCalledOnce();
    expect(newPage).toHaveBeenCalledOnce();
    expect(addInitScript.mock.invocationCallOrder[0]).toBeLessThan(
      newPage.mock.invocationCallOrder[0]!,
    );
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
