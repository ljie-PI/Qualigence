import { describe, expect, it, vi } from "vitest";
import {
  PlaywrightBrowserSession,
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

function fakeLauncher(): { launcher: BrowserLauncher; launch: ReturnType<typeof vi.fn>; closed: () => boolean } {
  let browserClosed = false;
  const page = {
    goto: vi.fn(async () => null),
    url: () => "https://example.test/",
    close: vi.fn(async () => undefined),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
  };
  const context = {
    newPage: vi.fn(async () => page),
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
    const launch = vi.fn(async () => {
      throw new Error("no sandbox");
    });
    const session = new PlaywrightBrowserSession(
      baseOptions(),
      { launch } as unknown as BrowserLauncher,
    );

    await expect(session.start()).rejects.toMatchObject({
      code: "BrowserLaunchFailed",
    });
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
