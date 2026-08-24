import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
    expectedOrigin: "https://example.test",
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
  page: { goto: ReturnType<typeof vi.fn>; url(): string };
  closed: () => boolean;
} {
  let browserClosed = false;
  const page = {
    goto: vi.fn(async () => null),
    url: () => "https://example.test/",
    on: vi.fn(),
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
    page,
    closed: () => browserClosed,
  };
}

async function startServer(handler: RequestListener): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
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

  it("tracks main-frame cross-origin history independently from navigation generation", async () => {
    let currentUrl = "https://example.test/";
    const mainFrame = { url: () => currentUrl };
    const childFrame = { url: () => "https://other.test/child" };
    let frameNavigated: ((frame: object) => void) | undefined;
    const page = {
      goto: vi.fn(async () => null),
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn((event: string, listener: (frame: object) => void) => {
        if (event === "framenavigated") frameNavigated = listener;
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
    const session = new PlaywrightBrowserSession(baseOptions(), {
      launch: vi.fn(async () => browser),
    } as unknown as BrowserLauncher);
    await session.start();
    session.registerObservation("graph-child", { descriptors: new Map(), artifacts: [] });

    expect(session.currentNavigationGeneration).toBe(0);
    frameNavigated?.(childFrame);
    expect(session.hasGraph("graph-child")).toBe(true);
    expect(session.currentNavigationGeneration).toBe(0);
    expect(session.currentCrossOriginNavigationCount).toBe(0);

    session.registerObservation("graph-main", { descriptors: new Map(), artifacts: [] });
    currentUrl = "https://example.test/next";
    frameNavigated?.(mainFrame);
    expect(session.hasGraph("graph-main")).toBe(false);
    expect(session.currentNavigationGeneration).toBe(1);
    expect(session.currentCrossOriginNavigationCount).toBe(0);

    currentUrl = "https://other.test/temporary";
    frameNavigated?.(mainFrame);
    currentUrl = "https://example.test/returned";
    frameNavigated?.(mainFrame);
    expect(session.currentNavigationGeneration).toBe(3);
    expect(session.currentCrossOriginNavigationCount).toBe(1);

    currentUrl = "not a url";
    frameNavigated?.(mainFrame);
    expect(session.currentNavigationGeneration).toBe(4);
    expect(session.currentCrossOriginNavigationCount).toBe(2);

    await session.close();
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

  it.each([
    ["ordinary", new Error("net::ERR_CONNECTION_RESET"), "NavigationFailed"],
    ["timeout", new Error("page.goto: Timeout 5000ms exceeded"), "NavigationTimedOut"],
  ] as const)("classifies an %s page.goto rejection after dispatch as %s", async (_name, failure, code) => {
    const { launcher, page } = fakeLauncher();
    page.goto.mockRejectedValueOnce(failure);
    const session = new PlaywrightBrowserSession(baseOptions(), launcher);

    await expect(session.start()).rejects.toMatchObject({ code });
    expect(page.goto).toHaveBeenCalledOnce();
  });

  it("rejects a cross-origin initial redirect after page.goto resolves", async () => {
    const destination = await startServer((_request, response) => {
      response.end("destination");
    });
    const source = await startServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", `${destination.origin}/final`);
      response.end();
    });
    const session = new PlaywrightBrowserSession(baseOptions({
      url: `${source.origin}/redirect`,
      expectedOrigin: source.origin,
      allowedOrigins: [source.origin, destination.origin],
    }));

    try {
      await expect(session.start()).rejects.toMatchObject({ code: "OriginViolation" });
    } finally {
      await session.close();
      await source.close();
      await destination.close();
    }
  });

  it("rejects initial navigation that crosses origin and returns before page.goto resolves", async () => {
    let currentUrl = "about:blank";
    let frameNavigated: ((frame: object) => void) | undefined;
    const mainFrame = { url: () => currentUrl };
    const page = {
      goto: vi.fn(async () => {
        currentUrl = "https://other.test/temporary";
        frameNavigated?.(mainFrame);
        currentUrl = "https://example.test/returned";
        frameNavigated?.(mainFrame);
      }),
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn((event: string, listener: (frame: object) => void) => {
        if (event === "framenavigated") frameNavigated = listener;
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
    const session = new PlaywrightBrowserSession(baseOptions(), {
      launch: vi.fn(async () => browser),
    } as unknown as BrowserLauncher);

    await expect(session.start()).rejects.toMatchObject({ code: "OriginViolation" });
    expect(session.currentCrossOriginNavigationCount).toBe(1);
  });

  it("preserves OriginViolation when initial navigation crosses origin before page.goto rejects", async () => {
    let currentUrl = "about:blank";
    let frameNavigated: ((frame: object) => void) | undefined;
    const mainFrame = { url: () => currentUrl };
    const page = {
      goto: vi.fn(async () => {
        currentUrl = "https://other.test/temporary";
        frameNavigated?.(mainFrame);
        throw new Error("net::ERR_CONNECTION_RESET");
      }),
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn((event: string, listener: (frame: object) => void) => {
        if (event === "framenavigated") frameNavigated = listener;
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
    const session = new PlaywrightBrowserSession(baseOptions(), {
      launch: vi.fn(async () => browser),
    } as unknown as BrowserLauncher);

    await expect(session.start()).rejects.toMatchObject({ code: "OriginViolation" });
    expect(session.currentCrossOriginNavigationCount).toBe(1);
  });

  it("allows an initial redirect that remains on the configured target origin", async () => {
    let origin = "";
    const server = await startServer((request, response) => {
      if (request.url === "/redirect") {
        response.statusCode = 302;
        response.setHeader("location", `${origin}/final`);
        response.end();
        return;
      }
      response.end("same origin");
    });
    origin = server.origin;
    const session = new PlaywrightBrowserSession(baseOptions({
      url: `${origin}/redirect`,
      expectedOrigin: origin,
      allowedOrigins: [origin],
    }));

    try {
      await expect(session.start()).resolves.toBeUndefined();
      await expect(session.withPage(async (page) => page.url())).resolves.toBe(`${origin}/final`);
    } finally {
      await session.close();
      await server.close();
    }
  });

  it("closes acquired browser resources without waiting for aborted startup", async () => {
    const abort = new AbortController();
    const failure = new Error("lease lost");
    let rejectContext: ((reason: unknown) => void) | undefined;
    const newContext = vi.fn(() => new Promise<never>((_resolve, reject) => {
      rejectContext = reject;
    }));
    const close = vi.fn(async () => {
      rejectContext?.(new Error("browser closed"));
    });
    const session = new PlaywrightBrowserSession(baseOptions(), {
      launch: vi.fn(async () => ({ newContext, close })),
    } as unknown as BrowserLauncher);

    const starting = session.start(abort.signal);
    await vi.waitFor(() => expect(newContext).toHaveBeenCalledOnce());
    abort.abort(failure);
    await expect(session.close()).resolves.toBeUndefined();

    await expect(starting).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
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

  it("redacts only registered sensitive target fields", () => {
    const session = new PlaywrightBrowserSession(baseOptions(), fakeLauncher().launcher);
    const prepared = session.prepareSensitiveEvidenceRecord({
      navigationGeneration: session.currentNavigationGeneration,
      nodeId: "n-sensitive",
      sourceValue: "line-one\r\nline-two\r\n",
    });
    session.completeSensitiveEvidenceRecord(prepared, ["line-one\nline-two\n"]);

    expect(session.redactSensitiveTargetField(
      [prepared.markerId],
      "line-one\r\nline-two\r\n",
    )).toBe("[redacted]");
    expect(session.redactSensitiveTargetField(
      [prepared.markerId],
      "line-one\nline-two\n",
    )).toBe("[redacted]");
    expect(session.redactSensitiveTargetField(undefined, "line-one\nline-two\n"))
      .toBe("line-one\nline-two\n");
    expect(session.redactSensitiveTargetField([prepared.markerId], "Email"))
      .toBe("Email");
  });

  it("fails sensitive evidence closed on record, form, and byte limits", () => {
    const session = new PlaywrightBrowserSession(baseOptions(), fakeLauncher().launcher);
    const complete = (nodeId: string, sourceValue: string): void => {
      const prepared = session.prepareSensitiveEvidenceRecord({
        navigationGeneration: session.currentNavigationGeneration,
        nodeId,
        sourceValue,
      });
      session.completeSensitiveEvidenceRecord(prepared, [sourceValue]);
    };

    for (let index = 0; index < 100; index += 1) {
      complete(`n-${index}`, `value-${index}`);
    }
    expect(() => session.prepareSensitiveEvidenceRecord({
      navigationGeneration: session.currentNavigationGeneration,
      nodeId: "n-overflow",
      sourceValue: "value-overflow",
    })).toThrowError(expect.objectContaining({ code: "SensitiveEvidenceUnavailable" }));

    const oversized = "x".repeat((64 * 1024) + 1);
    const sourceOversizedSession = new PlaywrightBrowserSession(baseOptions(), fakeLauncher().launcher);
    expect(() => sourceOversizedSession.prepareSensitiveEvidenceRecord({
      navigationGeneration: sourceOversizedSession.currentNavigationGeneration,
      nodeId: "n-oversized-source",
      sourceValue: oversized,
    })).toThrowError(expect.objectContaining({ code: "SensitiveEvidenceUnavailable" }));

    const formOverflowSession = new PlaywrightBrowserSession(baseOptions(), fakeLauncher().launcher);
    const formOverflow = formOverflowSession.prepareSensitiveEvidenceRecord({
      navigationGeneration: formOverflowSession.currentNavigationGeneration,
      nodeId: "n-form-overflow",
      sourceValue: "a",
    });
    formOverflowSession.completeSensitiveEvidenceRecord(formOverflow, ["b", "c", "d", "e"]);
    expect(() => formOverflowSession.assertSensitiveEvidenceAvailable())
      .toThrowError(expect.objectContaining({ code: "SensitiveEvidenceUnavailable" }));

    const formOversizedSession = new PlaywrightBrowserSession(baseOptions(), fakeLauncher().launcher);
    const formOversized = formOversizedSession.prepareSensitiveEvidenceRecord({
      navigationGeneration: formOversizedSession.currentNavigationGeneration,
      nodeId: "n-form-oversized",
      sourceValue: "a",
    });
    formOversizedSession.completeSensitiveEvidenceRecord(formOversized, [oversized]);
    expect(() => formOversizedSession.assertSensitiveEvidenceAvailable())
      .toThrowError(expect.objectContaining({ code: "SensitiveEvidenceUnavailable" }));
  });

  it("exposes origin helpers used by the executor allowlist", () => {
    expect(normalizeOrigin("https://example.test/a/b?x=1")).toBe("https://example.test");
    expect(normalizeOrigin("https://EXAMPLE.TEST:443/a")).toBe("https://example.test");
    expect(isOriginAllowed("https://example.test/page", ["https://example.test"])).toBe(true);
    expect(isOriginAllowed("https://evil.test/page", ["https://example.test"])).toBe(false);
    expect(() => new WebTargetError("NavigationFailed")).not.toThrow();
  });
});
