import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcceptedExecutionJob } from "@qualigence/runner-protocol";
import { ExecutionPermit } from "@qualigence/runner-kernel";
import {
  PlaywrightActionExecutor,
  PlaywrightActionResolver,
  PlaywrightBrowserSession,
  PlaywrightObserver,
  type CapturedArtifact,
  type WebSessionOptions,
} from "@qualigence/web-playwright/internal";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";

const SECRET = "cdp-secret@example.test";
const MASK_ATTRIBUTE = "data-qualigence-sensitive-mask";

const job: AcceptedExecutionJob = {
  jobId: "job-cdp-mask",
  runId: "run-cdp-mask",
  projectId: "project-test",
  target: { kind: "web", url: "http://placeholder.test" },
  objective: "Prove CDP screenshot masking",
  policy: {
    policyId: "policy-cdp-mask",
    environment: "isolated_test",
    allowedOrigins: ["http://placeholder.test"],
    allowedActionKinds: ["input"],
    maximumRisk: "Normal",
    explorationAllowed: false,
    issuedAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-18T00:01:00.000Z",
  },
};

function allowedPermit(): ExecutionPermit {
  return ExecutionPermit.fromAllowedDecision({ status: "allowed", reason: "component test" });
}

function pageHtml(): string {
  return htmlDocument(`
    <style>
      html, body { margin: 0; background: rgb(255, 255, 255); }
      #spacer { height: 90px; }
      #secret { position: absolute; left: 40px; top: 140px; width: 96px; height: 24px; background: rgb(255, 255, 255); color: rgb(0, 0, 255); }
      #mirror { position: absolute; left: 40px; top: 180px; width: 180px; height: 24px; background: rgb(255, 255, 255); color: rgb(0, 0, 255); }
      #unrelated { position: absolute; left: 220px; top: 145px; width: 32px; height: 32px; background: rgb(255, 0, 0); }
    </style>
    <div id="spacer"></div>
    <label>Email <input id="secret" aria-label="Email" /></label>
    <div id="mirror" data-qualigence-observe>Mirror pending</div>
    <div id="unrelated" data-qualigence-observe></div>
    <script>
      const secret = document.getElementById('secret');
      const mirror = document.getElementById('mirror');
      secret.addEventListener('input', () => {
        document.title = secret.value;
        mirror.textContent = secret.value;
      });
      scrollTo(0, 80);
    </script>
  `, "CDP mask");
}

describe("CDP screenshot masking", () => {
  let fixture: FixtureServer;
  let session: PlaywrightBrowserSession;

  beforeEach(async () => {
    fixture = await startFixtureServer({ "/": pageHtml() });
  });

  afterEach(async () => {
    await session?.close();
    await fixture?.close();
  });

  function options(): WebSessionOptions {
    return {
      url: fixture.url,
      expectedOrigin: fixture.origin,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      allowedOrigins: [fixture.origin],
    };
  }

  async function enterSecret(): Promise<PlaywrightObserver> {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => SECRET });
    const before = await observer.capture({ ...job, target: { kind: "web", url: fixture.url } });
    const email = before.nodes.find((node) => node.name === "Email");
    if (email === undefined) throw new Error("Missing Email node.");
    const action = await resolver.resolve({ kind: "input", target: { nodeId: email.id }, valueRef: "customer.email", reason: "test" }, before);
    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    return observer;
  }

  it("masks exactly the CDP backend-node rectangle and ignores page JavaScript geometry lies", async () => {
    await enterSecret();
    await session.withPage(async (page) => {
      await page.evaluate(() => {
        const host = globalThis as unknown as {
          readonly Element: { readonly prototype: Record<string, unknown> };
          readonly HTMLInputElement: { readonly prototype: Record<string, unknown> };
        };
        host.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
          return { x: 220, y: 145, left: 220, top: 145, right: 252, bottom: 177, width: 32, height: 32, toJSON: () => ({}) };
        };
        host.Element.prototype.getClientRects = function getClientRects() {
          return [{ x: 220, y: 145, left: 220, top: 145, right: 252, bottom: 177, width: 32, height: 32, toJSON: () => ({}) }];
        };
        Object.defineProperty(host.HTMLInputElement.prototype, "value", { configurable: true, get: () => "attacker-value" });
      });
    });

    const expected = await expectedRectFromCdp(session, "#secret");
    const unrelated = await expectedRectFromCdp(session, "#unrelated");
    const graph = await new PlaywrightObserver(session).capture({ ...job, target: { kind: "web", url: fixture.url } });
    const image = decodePngRgba(pngArtifact(session.artifactsFor(graph.graphId)).bytes);

    expect(expected.width).toBeGreaterThan(0);
    expect(expected.height).toBeGreaterThan(0);
    for (let y = expected.top; y < expected.bottom; y += 1) {
      for (let x = expected.left; x < expected.right; x += 1) {
        expect(pixelAt(image, x, y)).toEqual([0, 0, 0, 255]);
      }
    }
    expect(pixelAt(image, Math.floor((unrelated.left + unrelated.right) / 2), Math.floor((unrelated.top + unrelated.bottom) / 2))).toEqual([255, 0, 0, 255]);
    expect(JSON.stringify(graph)).not.toContain(SECRET);
  }, 60_000);

  it("ignores page-replaced Function.prototype.call during sensitive observation", async () => {
    await enterSecret();
    await session.withPage(async (page) => {
      await page.evaluate(() => {
        const host = globalThis as unknown as {
          readonly Element: { readonly prototype: Record<string, unknown> };
          readonly Function: { readonly prototype: { call: (receiver: unknown, ...args: unknown[]) => unknown } };
          readonly Reflect: { readonly apply: (target: unknown, receiver: unknown, args: readonly unknown[]) => unknown };
          readonly getComputedStyle: unknown;
        };
        const nativeReflectApply = host.Reflect.apply;
        const nativeCall = host.Function.prototype.call;
        host.Function.prototype.call = function call(receiver: unknown, ...args: unknown[]) {
          if (this === host.Element.prototype.getAttribute || this === host.Element.prototype.hasAttribute || this === host.Element.prototype.getClientRects || this === host.getComputedStyle) {
            return this === host.Element.prototype.hasAttribute ? false : null;
          }
          return nativeReflectApply(nativeCall, this, [receiver, ...args]);
        };
      });
    });

    const mirror = await expectedRectFromCdp(session, "#mirror");
    const graph = await new PlaywrightObserver(session).capture({ ...job, target: { kind: "web", url: fixture.url } });
    const image = decodePngRgba(pngArtifact(session.artifactsFor(graph.graphId)).bytes);

    expect(pixelAt(image, Math.floor((mirror.left + mirror.right) / 2), Math.floor((mirror.top + mirror.bottom) / 2))).toEqual([0, 0, 0, 255]);
    expect(JSON.stringify(graph)).not.toContain(SECRET);
  }, 60_000);

  it("uses captured WeakMap baseline authority when the page replaces WeakMap before a sensitive action", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    let graph = await observer.capture({ ...job, target: { kind: "web", url: fixture.url } });
    const email = graph.nodes.find((node) => node.name === "Email");
    if (email === undefined) throw new Error("Missing Email node.");
    await session.withPage(async (page) => {
      await page.evaluate((secret) => {
        (globalThis as unknown as { WeakMap: unknown }).WeakMap = class HostileWeakMap {
          get(): readonly string[] { return [secret]; }
          set(): this { return this; }
        };
      }, SECRET);
    });

    const executor = new PlaywrightActionExecutor(session, { resolve: async () => SECRET });
    const action = await resolver.resolve({ kind: "input", target: { nodeId: email.id }, valueRef: "customer.email", reason: "test" }, graph);
    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    const mirror = await expectedRectFromCdp(session, "#mirror");
    graph = await new PlaywrightObserver(session).capture({ ...job, target: { kind: "web", url: fixture.url } });
    const image = decodePngRgba(pngArtifact(session.artifactsFor(graph.graphId)).bytes);

    expect(pixelAt(image, Math.floor((mirror.left + mirror.right) / 2), Math.floor((mirror.top + mirror.bottom) / 2))).toEqual([0, 0, 0, 255]);
    expect(JSON.stringify(graph)).not.toContain(SECRET);
  }, 60_000);

  it("uses captured Array.from/Set-independent classification when page intrinsics are replaced", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    let graph = await observer.capture({ ...job, target: { kind: "web", url: fixture.url } });
    const email = graph.nodes.find((node) => node.name === "Email");
    if (email === undefined) throw new Error("Missing Email node.");
    await session.withPage(async (page) => {
      await page.evaluate(() => {
        Array.from = () => [];
        (globalThis as unknown as { Set: unknown }).Set = class HostileSet {
          readonly size = 0;
          add(): this { return this; }
          has(): boolean { return false; }
          [Symbol.iterator](): Iterator<unknown> { return [][Symbol.iterator](); }
        };
      });
    });

    const executor = new PlaywrightActionExecutor(session, { resolve: async () => SECRET });
    const action = await resolver.resolve({ kind: "input", target: { nodeId: email.id }, valueRef: "customer.email", reason: "test" }, graph);
    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    const mirror = await expectedRectFromCdp(session, "#mirror");
    graph = await new PlaywrightObserver(session).capture({ ...job, target: { kind: "web", url: fixture.url } });
    const image = decodePngRgba(pngArtifact(session.artifactsFor(graph.graphId)).bytes);

    expect(pixelAt(image, Math.floor((mirror.left + mirror.right) / 2), Math.floor((mirror.top + mirror.bottom) / 2))).toEqual([0, 0, 0, 255]);
    expect(JSON.stringify(graph)).not.toContain(SECRET);
  }, 60_000);

  it("uses captured CSSStyleDeclaration style reads when style accessors are replaced", async () => {
    await enterSecret();
    await session.withPage(async (page) => {
      await page.evaluate(() => {
        const host = globalThis as unknown as {
          readonly CSSStyleDeclaration: { readonly prototype: { getPropertyValue(name: string): string } };
          readonly Object: typeof Object;
        };
        const proto = host.CSSStyleDeclaration.prototype;
        host.Object.defineProperty(proto, "display", { configurable: true, get: () => "none" });
        host.Object.defineProperty(proto, "visibility", { configurable: true, get: () => "hidden" });
        proto.getPropertyValue = () => "none";
      });
    });

    const expected = await expectedRectFromCdp(session, "#secret");
    const graph = await new PlaywrightObserver(session).capture({ ...job, target: { kind: "web", url: fixture.url } });
    const image = decodePngRgba(pngArtifact(session.artifactsFor(graph.graphId)).bytes);

    expect(pixelAt(image, expected.left, expected.top)).toEqual([0, 0, 0, 255]);
    expect(JSON.stringify(graph)).not.toContain(SECRET);
  }, 60_000);

  it("masks when the page removes marker attributes and overrides marker accessors", async () => {
    await enterSecret();
    await session.withPage(async (page) => {
      await page.evaluate((attribute) => {
        const host = globalThis as unknown as {
          readonly Element: { readonly prototype: {
            setAttribute(name: string, value: string): void;
            hasAttribute(name: string): boolean;
            removeAttribute(name: string): void;
          } };
          readonly document: { querySelectorAll(selector: string): Iterable<unknown> };
        };
        const originalSetAttribute = host.Element.prototype.setAttribute;
        const originalHasAttribute = host.Element.prototype.hasAttribute;
        const originalRemoveAttribute = host.Element.prototype.removeAttribute;
        for (const element of host.document.querySelectorAll(`[${attribute}]`)) {
          originalRemoveAttribute.call(element, attribute);
        }
        host.Element.prototype.setAttribute = function setAttribute(name: string, value: string) {
          if (name === attribute) return undefined;
          return originalSetAttribute.call(this, name, value);
        };
        host.Element.prototype.hasAttribute = function hasAttribute(name: string) {
          if (name === attribute) return false;
          return originalHasAttribute.call(this, name);
        };
      }, MASK_ATTRIBUTE);
    });

    const expected = await expectedRectFromCdp(session, "#secret");
    const graph = await new PlaywrightObserver(session).capture({ ...job, target: { kind: "web", url: fixture.url } });
    const image = decodePngRgba(pngArtifact(session.artifactsFor(graph.graphId)).bytes);

    expect(pixelAt(image, expected.left, expected.top)).toEqual([0, 0, 0, 255]);
    expect(JSON.stringify(graph)).not.toContain(SECRET);
  }, 60_000);

  it("fails closed when page-mutated classifiedElements redirect the retained mask record to a decoy", async () => {
    await enterSecret();
    const observer = new PlaywrightObserver(session, {
      afterGraphAssembly: async (page) => {
        await page.evaluate((input) => {
          type MutableElement = { removeAttribute(name: string): void };
          const host = globalThis as unknown as Record<string, unknown> & {
            readonly document: { querySelector(selector: string): MutableElement | null };
          };
          const state = host[input.stateProperty] as {
            records?: { classifiedElements?: unknown[] }[];
          } | undefined;
          const secret = host.document.querySelector("#secret");
          const decoy = host.document.querySelector("#unrelated");
          const record = state?.records?.[0];
          if (record?.classifiedElements === undefined || secret === null || decoy === null) {
            throw new Error("Missing sensitive state.");
          }
          record.classifiedElements[0] = decoy;
          secret.removeAttribute(input.maskAttribute);
        }, {
          stateProperty: "__qualigenceSensitiveEvidenceState",
          maskAttribute: MASK_ATTRIBUTE,
        });
      },
    });

    await expect(observer.capture({ ...job, target: { kind: "web", url: fixture.url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-cdp-mask:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("fails closed when page state and target id arrays are mutated before graph capture", async () => {
    await enterSecret();
    await session.withPage(async (page) => {
      await page.evaluate((input) => {
        const host = globalThis as unknown as Record<string, unknown> & {
          readonly document: { querySelectorAll(selector: string): Iterable<Element> };
        };
        const state = host[input.stateProperty] as {
          records?: { forms?: string[] }[];
        } | undefined;
        const record = state?.records?.[0];
        if (record?.forms === undefined) throw new Error("Missing sensitive record.");
        record.forms.length = 0;
        for (const element of host.document.querySelectorAll(`[${input.maskAttribute}]`)) {
          const ids = (element as unknown as Record<string, unknown>)[input.targetIdsProperty];
          if (Array.isArray(ids)) ids.length = 0;
        }
      }, {
        stateProperty: "__qualigenceSensitiveEvidenceState",
        targetIdsProperty: "__qualigenceSensitiveTargetIds",
        maskAttribute: MASK_ATTRIBUTE,
      });
    });

    await expect(new PlaywrightObserver(session).capture({ ...job, target: { kind: "web", url: fixture.url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-cdp-mask:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("fails closed when marker attributes are reassigned to a non-sensitive backend node", async () => {
    await enterSecret();
    const observer = new PlaywrightObserver(session, {
      afterGraphAssembly: async (page) => {
        await page.evaluate((attribute) => {
          const host = globalThis as unknown as {
            readonly Element: { readonly prototype: {
              setAttribute(name: string, value: string): void;
              removeAttribute(name: string): void;
            } };
            readonly document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null };
          };
          const originalSetAttribute = host.Element.prototype.setAttribute;
          const originalRemoveAttribute = host.Element.prototype.removeAttribute;
          const secret = host.document.querySelector("#secret");
          const unrelated = host.document.querySelector("#unrelated");
          if (secret === null || unrelated === null) throw new Error("Missing fixture nodes.");
          const marker = secret.getAttribute(attribute);
          if (marker === null) throw new Error("Missing sensitive marker.");
          originalRemoveAttribute.call(secret, attribute);
          originalSetAttribute.call(unrelated, attribute, marker);
        }, MASK_ATTRIBUTE);
      },
    });

    await expect(observer.capture({ ...job, target: { kind: "web", url: fixture.url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-cdp-mask:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("fails closed when a classified region is hidden during host snapshot collection and later becomes visible", async () => {
    await fixture.close();
    fixture = await startFixtureServer({
      "/": htmlDocument(`
        <style>
          html, body { margin: 0; background: rgb(255, 255, 255); }
          #secret { position: absolute; left: 20px; top: 20px; width: 96px; height: 24px; }
          #mirror { display: none; position: absolute; left: 20px; top: 60px; width: 160px; height: 24px; }
        </style>
        <label>Email <input id="secret" aria-label="Email" /></label>
        <div id="mirror" data-qualigence-observe>Mirror pending</div>
        <script>
          const secret = document.getElementById('secret');
          const mirror = document.getElementById('mirror');
          secret.addEventListener('input', () => {
            mirror.textContent = secret.value;
          });
        </script>
      `, "Hidden sensitive region"),
    });
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => SECRET });
    const before = await observer.capture({ ...job, target: { kind: "web", url: fixture.url } });
    const email = before.nodes.find((node) => node.name === "Email");
    if (email === undefined) throw new Error("Missing Email node.");
    const action = await resolver.resolve({ kind: "input", target: { nodeId: email.id }, valueRef: "customer.email", reason: "test" }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await session.withPage(async (page) => {
      await page.locator("#mirror").evaluate((element) => {
        (element as unknown as { readonly style: { display: string } }).style.display = "block";
      });
    });
    await expect(observer.capture({ ...job, target: { kind: "web", url: fixture.url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-cdp-mask:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("fails closed when page script mutates active classifiedElements during the input event", async () => {
    await fixture.close();
    fixture = await startFixtureServer({
      "/": htmlDocument(`
        <label>Email <input id="secret" aria-label="Email" /></label>
        <div id="mirror" data-qualigence-observe>Mirror pending</div>
        <script>
          const secret = document.getElementById('secret');
          const mirror = document.getElementById('mirror');
          secret.addEventListener('input', () => {
            const state = window.__qualigenceSensitiveEvidenceState;
            if (state && state.active && Array.isArray(state.active.classifiedElements)) {
              state.active.classifiedElements.length = 0;
            }
            mirror.textContent = secret.value;
          });
        </script>
      `, "Mutated active classified elements"),
    });
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => SECRET });
    const before = await observer.capture({ ...job, target: { kind: "web", url: fixture.url } });
    const email = before.nodes.find((node) => node.name === "Email");
    if (email === undefined) throw new Error("Missing Email node.");
    const action = await resolver.resolve({ kind: "input", target: { nodeId: email.id }, valueRef: "customer.email", reason: "test" }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await expect(observer.capture({ ...job, target: { kind: "web", url: fixture.url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-cdp-mask:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("fails closed when reflected sensitive regions exceed the 256-region cap", async () => {
    await fixture.close();
    fixture = await startFixtureServer({
      "/": htmlDocument(`
        <label>Email <input id="secret" aria-label="Email" /></label>
        ${Array.from({ length: 257 }, (_, index) => `<span id="mirror-${index}" data-qualigence-observe>pending</span>`).join("\n")}
        <script>
          const secret = document.getElementById('secret');
          secret.addEventListener('input', () => {
            for (let index = 0; index < 257; index += 1) {
              document.getElementById('mirror-' + index).textContent = secret.value;
            }
          });
        </script>
      `, "Too many sensitive regions"),
    });
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => SECRET });
    const before = await observer.capture({ ...job, target: { kind: "web", url: fixture.url } });
    const email = before.nodes.find((node) => node.name === "Email");
    if (email === undefined) throw new Error("Missing Email node.");
    const action = await resolver.resolve({ kind: "input", target: { nodeId: email.id }, valueRef: "customer.email", reason: "test" }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await expect(observer.capture({ ...job, target: { kind: "web", url: fixture.url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-cdp-mask:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("fails closed with zero accepted bytes when screenshot returns invalid PNG bytes", async () => {
    await enterSecret();
    let screenshotCalls = 0;
    await session.withPage(async (page) => {
      page.screenshot = async () => {
        screenshotCalls += 1;
        return Buffer.from("not-a-png");
      };
    });

    await expect(new PlaywrightObserver(session).capture({ ...job, target: { kind: "web", url: fixture.url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });

    expect(screenshotCalls).toBe(1);
    expect(() => session.artifactsFor("run-cdp-mask:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("fails closed with zero accepted bytes when screenshot capture throws", async () => {
    await enterSecret();
    let screenshotCalls = 0;
    await session.withPage(async (page) => {
      page.screenshot = async () => {
        screenshotCalls += 1;
        throw new Error("injected screenshot failure");
      };
    });

    await expect(new PlaywrightObserver(session).capture({ ...job, target: { kind: "web", url: fixture.url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });

    expect(screenshotCalls).toBe(1);
    expect(() => session.artifactsFor("run-cdp-mask:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("performs exactly one bounded full recapture when CDP geometry races", async () => {
    await enterSecret();
    let screenshotCalls = 0;
    await session.withPage(async (page) => {
      const original = page.screenshot.bind(page);
      page.screenshot = async (options) => {
        screenshotCalls += 1;
        return original(options);
      };
    });
    const observer = new PlaywrightObserver(session, {
      afterScreenshotCapture: async (page) => {
        if (screenshotCalls === 1) {
          await page.locator("#secret").evaluate((element) => {
            (element as unknown as { readonly style: { left: string } }).style.left = "80px";
          });
        }
      },
    });

    const graph = await observer.capture({ ...job, target: { kind: "web", url: fixture.url } });

    expect(screenshotCalls).toBe(2);
    expect(session.artifactsFor(graph.graphId)).toHaveLength(2);
  }, 60_000);

  it("fails closed with zero accepted bytes when geometry races twice", async () => {
    await enterSecret();
    let screenshotCalls = 0;
    await session.withPage(async (page) => {
      const original = page.screenshot.bind(page);
      page.screenshot = async (options) => {
        screenshotCalls += 1;
        return original(options);
      };
    });
    const observer = new PlaywrightObserver(session, {
      afterScreenshotCapture: async (page) => {
        await page.locator("#secret").evaluate((element, call) => {
          (element as unknown as { readonly style: { left: string } }).style.left = `${40 + (call * 20)}px`;
        }, screenshotCalls);
      },
    });

    await expect(observer.capture({ ...job, target: { kind: "web", url: fixture.url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });

    expect(screenshotCalls).toBe(2);
    expect(() => session.artifactsFor("run-cdp-mask:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);
});

interface PixelImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

async function expectedRectFromCdp(session: PlaywrightBrowserSession, selector: string): Promise<PixelRect> {
  return session.withPage(async (page) => {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("DOM.enable");
      await cdp.send("Page.enable");
      const metrics = await cdp.send("Page.getLayoutMetrics") as {
        readonly cssVisualViewport: { readonly pageX: number; readonly pageY: number; readonly clientWidth: number; readonly clientHeight: number };
      };
      const document = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }) as { readonly root: { readonly nodeId: number } };
      const query = await cdp.send("DOM.querySelectorAll", { nodeId: document.root.nodeId, selector }) as { readonly nodeIds: readonly number[] };
      expect(query.nodeIds).toHaveLength(1);
      const box = await cdp.send("DOM.getBoxModel", { nodeId: query.nodeIds[0]! }) as { readonly model: { readonly border: readonly number[] } };
      const xs = [box.model.border[0]!, box.model.border[2]!, box.model.border[4]!, box.model.border[6]!];
      const ys = [box.model.border[1]!, box.model.border[3]!, box.model.border[5]!, box.model.border[7]!];
      const leftCss = Math.min(...xs) - metrics.cssVisualViewport.pageX;
      const rightCss = Math.max(...xs) - metrics.cssVisualViewport.pageX;
      const topCss = Math.min(...ys) - metrics.cssVisualViewport.pageY;
      const bottomCss = Math.max(...ys) - metrics.cssVisualViewport.pageY;
      const screenshot = await page.screenshot({ timeout: 5000 });
      const image = decodePngRgba(new Uint8Array(screenshot));
      const scaleX = image.width / metrics.cssVisualViewport.clientWidth;
      const scaleY = image.height / metrics.cssVisualViewport.clientHeight;
      const left = Math.max(0, Math.floor(leftCss * scaleX));
      const top = Math.max(0, Math.floor(topCss * scaleY));
      const right = Math.min(image.width, Math.ceil(rightCss * scaleX));
      const bottom = Math.min(image.height, Math.ceil(bottomCss * scaleY));
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  });
}

function pngArtifact(artifacts: readonly CapturedArtifact[]): CapturedArtifact {
  const artifact = artifacts.find((candidate) => candidate.mediaType === "image/png");
  if (artifact === undefined) throw new Error("Missing PNG artifact.");
  return artifact;
}

function pixelAt(image: PixelImage, x: number, y: number): readonly [number, number, number, number] {
  const offset = ((y * image.width) + x) * 4;
  return [image.rgba[offset]!, image.rgba[offset + 1]!, image.rgba[offset + 2]!, image.rgba[offset + 3]!];
}

function decodePngRgba(bytes: Uint8Array): PixelImage {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid PNG signature.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    offset += 4;
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    offset += 4;
    const data = buffer.subarray(offset, offset + length);
    offset += length + 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("Unsupported PNG format.");
      colorType = data[9] ?? -1;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (width <= 0 || height <= 0 || channels === 0) throw new Error("Unsupported PNG color type.");
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  const scanlines = new Uint8Array(stride * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source++] ?? -1;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[source++] ?? 0;
      const left = x >= channels ? scanlines[(y * stride) + x - channels]! : 0;
      const up = y > 0 ? scanlines[((y - 1) * stride) + x]! : 0;
      const upperLeft = y > 0 && x >= channels ? scanlines[((y - 1) * stride) + x - channels]! : 0;
      scanlines[(y * stride) + x] = (raw + pngFilterDelta(filter, left, up, upperLeft)) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const input = index * channels;
    const output = index * 4;
    rgba[output] = scanlines[input]!;
    rgba[output + 1] = channels === 1 ? scanlines[input]! : scanlines[input + 1]!;
    rgba[output + 2] = channels === 1 ? scanlines[input]! : scanlines[input + 2]!;
    rgba[output + 3] = channels === 4 ? scanlines[input + 3]! : 255;
  }
  return { width, height, rgba };
}

function pngFilterDelta(filter: number, left: number, up: number, upperLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) {
    const p = left + up - upperLeft;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - up);
    const pc = Math.abs(p - upperLeft);
    if (pa <= pb && pa <= pc) return left;
    if (pb <= pc) return up;
    return upperLeft;
  }
  throw new Error(`Unsupported PNG filter ${filter}.`);
}
