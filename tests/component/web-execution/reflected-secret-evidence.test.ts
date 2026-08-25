import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcceptedExecutionJob, ObservationGraphV1 } from "@qualigence/runner-protocol";
import { ExecutionPermit } from "@qualigence/runner-kernel";
import {
  PlaywrightActionExecutor,
  PlaywrightActionResolver,
  PlaywrightBrowserSession,
  PlaywrightObserver,
  type WebSessionOptions,
} from "@qualigence/web-playwright/internal";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";

const SECRET = "reflect-secret@example.test";
const SAFE_EQUAL = SECRET;

const job: AcceptedExecutionJob = {
  jobId: "job-reflected-secret",
  runId: "run-reflected-secret",
  projectId: "project-test",
  target: { kind: "web", url: "http://placeholder.test" },
  objective: "Exercise reflected sensitive evidence",
  policy: {
    policyId: "policy-reflected-secret",
    environment: "isolated_test",
    allowedOrigins: ["http://placeholder.test"],
    allowedActionKinds: ["input", "select"],
    maximumRisk: "Normal",
    explorationAllowed: false,
    issuedAt: "2026-08-25T00:00:00.000Z",
    expiresAt: "2026-08-25T00:01:00.000Z",
  },
};

function allowedPermit(): ExecutionPermit {
  return ExecutionPermit.fromAllowedDecision({
    status: "allowed",
    reason: "component test",
  });
}

describe("Playwright reflected sensitive evidence", () => {
  let fixture: FixtureServer;
  let session: PlaywrightBrowserSession;

  beforeEach(async () => {
    fixture = await startFixtureServer({
      "/": htmlDocument(`
        <style>
          html, body { margin: 0; width: 360px; height: 220px; }
          label { display: block; margin-top: 130px; }
          #mirror, #equal {
            position: absolute;
            left: 10px;
            width: 180px;
            height: 32px;
            color: white;
            font: 16px sans-serif;
          }
          #mirror { top: 10px; background: rgb(250, 250, 250); }
          #equal { top: 60px; background: rgb(123, 45, 67); }
        </style>
        <div id="mirror" data-qualigence-observe>waiting</div>
        <div id="equal" data-qualigence-observe>${SAFE_EQUAL}</div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          const input = document.querySelector('input');
          input.addEventListener('input', event => {
            document.getElementById('mirror').textContent = event.target.value;
          });
        </script>
      `, "Reflected secret"),
      "/async": htmlDocument(`
        <div id="mirror" data-qualigence-observe>waiting</div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          const input = document.querySelector('input');
          input.addEventListener('input', event => {
            const value = event.target.value;
            setTimeout(() => { document.getElementById('mirror').textContent = value; }, 0);
          });
        </script>
      `, "Async reflected secret"),
      "/overflow": htmlDocument(`
        <div id="container" data-qualigence-observe>waiting</div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          const input = document.querySelector('input');
          input.addEventListener('input', event => {
            const container = document.getElementById('container');
            for (let index = 0; index < 257; index += 1) {
              const child = document.createElement('span');
              child.setAttribute('data-qualigence-observe', '');
              child.textContent = event.target.value;
              container.appendChild(child);
            }
          });
        </script>
      `, "Overflow reflected secret"),
      "/safe": htmlDocument(`
        <div id="mirror" data-qualigence-observe>waiting</div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          const input = document.querySelector('input');
          input.addEventListener('input', () => {
            document.getElementById('mirror').textContent = 'saved';
          });
        </script>
      `, "Safe reflected content"),
      "/delegated": htmlDocument(`
        <div id="mirror" data-qualigence-observe>waiting</div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          document.body.addEventListener('input', event => {
            document.getElementById('mirror').textContent = event.target.value;
          });
        </script>
      `, "Delegated reflected secret"),
      "/shadow-open": htmlDocument(`
        <div id="host"></div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          const input = document.querySelector('input');
          const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
          const mirror = document.createElement('div');
          mirror.textContent = 'waiting';
          shadow.appendChild(mirror);
          input.addEventListener('input', event => {
            mirror.textContent = event.target.value;
          });
        </script>
      `, "Open shadow reflected secret"),
      "/shadow-closed": htmlDocument(`
        <div id="host"></div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          const input = document.querySelector('input');
          const shadow = document.getElementById('host').attachShadow({ mode: 'closed' });
          const mirror = document.createElement('div');
          mirror.textContent = 'waiting';
          shadow.appendChild(mirror);
          input.addEventListener('input', event => {
            mirror.textContent = event.target.value;
          });
        </script>
      `, "Closed shadow reflected secret"),
      "/mutation-overflow": htmlDocument(`
        <div id="mirror" data-qualigence-observe>waiting</div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          const input = document.querySelector('input');
          input.addEventListener('input', () => {
            const mirror = document.getElementById('mirror');
            for (let index = 0; index < 1025; index += 1) {
              mirror.setAttribute('data-overflow-' + index, String(index));
            }
          });
        </script>
      `, "Mutation overflow reflected secret"),
      "/late": htmlDocument(`
        <style>
          html, body { margin: 0; width: 360px; height: 180px; }
          #mirror {
            position: absolute;
            left: 10px;
            top: 10px;
            width: 180px;
            height: 32px;
            color: white;
            background: rgb(250, 250, 250);
            font: 16px sans-serif;
          }
          label { display: block; margin-top: 80px; }
        </style>
        <div id="mirror" data-qualigence-observe>waiting</div>
        <label>Email <input aria-label="Email" /></label>
      `, "Late reflected secret"),
    });
  });

  afterEach(async () => {
    await session?.close();
    await fixture?.close();
  });

  function options(path = "/"): WebSessionOptions {
    return {
      url: `${fixture.origin}${path}`,
      expectedOrigin: fixture.origin,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      allowedOrigins: [fixture.origin],
    };
  }

  async function wire(path = "/"): Promise<{
    readonly observer: PlaywrightObserver;
    readonly resolver: PlaywrightActionResolver;
    readonly executor: PlaywrightActionExecutor;
  }> {
    session = new PlaywrightBrowserSession(options(path));
    await session.start();
    return {
      observer: new PlaywrightObserver(session),
      resolver: new PlaywrightActionResolver(session),
      executor: new PlaywrightActionExecutor(session, { resolve: async () => SECRET }),
    };
  }

  it("redacts a synchronous light-DOM reflection and masks only its screenshot region", async () => {
    const { observer, resolver, executor } = await wire();
    const before = await observer.capture({ ...job, target: { kind: "web", url: fixture.url } });
    const email = nodeNamed(before, "Email");

    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: email.id },
      valueRef: "customer.email",
      reason: "reflect secret",
    }, before);
    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });

    const after = await observer.capture({ ...job, target: { kind: "web", url: fixture.url } });
    expect(nodeNamed(after, "Email").value).toBe("[redacted]");
    expect(after.nodes.some((node) => node.name === "[redacted]" || node.value === "[redacted]")).toBe(true);
    expect(after.nodes.some((node) => node.name === SAFE_EQUAL || node.value === SAFE_EQUAL)).toBe(true);

    const png = session.artifactsFor(after.graphId).find((artifact) => artifact.mediaType === "image/png");
    expect(png).toBeDefined();
    const pixels = await samplePngPixels(session, png!.bytes, [
      [20, 20],
      [20, 70],
    ]);
    expect(pixels[0]).toEqual([0, 0, 0, 255]);
    expect(pixels[1]).toEqual([123, 45, 67, 255]);
  }, 60_000);

  it("fails evidence closed for scheduler-adjacent reflected matching content", async () => {
    const { observer, resolver, executor } = await wire("/async");
    const before = await observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}/async` } });
    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(before, "Email").id },
      valueRef: "customer.email",
      reason: "async reflect secret",
    }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await session.withPage((page) => page.waitForTimeout(25));
    await expect(observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}/async` } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-reflected-secret:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("fails evidence closed for delegated reflected matching content", async () => {
    const { observer, resolver, executor } = await wire("/delegated");
    const before = await observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}/delegated` } });
    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(before, "Email").id },
      valueRef: "customer.email",
      reason: "delegated reflect secret",
    }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await expect(observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}/delegated` } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-reflected-secret:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it.each(["/shadow-open", "/shadow-closed"])("fails evidence closed for %s reflected matching content", async (path) => {
    const { observer, resolver, executor } = await wire(path);
    const before = await observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}${path}` } });
    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(before, "Email").id },
      valueRef: "customer.email",
      reason: "shadow reflect secret",
    }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await expect(observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}${path}` } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-reflected-secret:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("fails evidence closed when the DOM-to-screenshot window exposes matching content", async () => {
    session = new PlaywrightBrowserSession(options("/late"));
    await session.start();
    let exposeLateSecret = false;
    const observer = new PlaywrightObserver(session, {
      afterDomCollection: async (page) => {
        if (!exposeLateSecret) return;
        await page.evaluate((secret) => {
          const browser = globalThis as unknown as {
            readonly document: { getElementById(id: string): { textContent: string } | null };
          };
          const mirror = browser.document.getElementById("mirror");
          if (mirror === null) throw new Error("Missing late mirror.");
          mirror.textContent = secret;
        }, SECRET);
      },
    });
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => SECRET });
    const before = await observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}/late` } });
    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(before, "Email").id },
      valueRef: "customer.email",
      reason: "late reflect secret",
    }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    exposeLateSecret = true;
    await expect(observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}/late` } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-reflected-secret:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("fails evidence closed when reflected mutation bounds are exceeded", async () => {
    const { observer, resolver, executor } = await wire("/mutation-overflow");
    const before = await observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}/mutation-overflow` } });
    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(before, "Email").id },
      valueRef: "customer.email",
      reason: "mutation overflow secret",
    }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await expect(observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}/mutation-overflow` } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-reflected-secret:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("fails evidence closed when reflected node bounds are exceeded", async () => {
    const { observer, resolver, executor } = await wire("/overflow");
    const before = await observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}/overflow` } });
    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(before, "Email").id },
      valueRef: "customer.email",
      reason: "overflow reflected secret",
    }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await expect(observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}/overflow` } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-reflected-secret:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("leaves non-sensitive synchronous reflected content ordinary", async () => {
    const { observer, resolver, executor } = await wire("/safe");
    const before = await observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}/safe` } });
    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(before, "Email").id },
      valueRef: "customer.email",
      reason: "safe reflection",
    }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    const after = await observer.capture({ ...job, target: { kind: "web", url: `${fixture.origin}/safe` } });
    expect(nodeNamed(after, "Email").value).toBe("[redacted]");
    expect(after.nodes.some((node) => node.name === "saved" || node.value === "saved")).toBe(true);
    expect(after.nodes.some((node) => node.name === SECRET || node.value === SECRET)).toBe(false);
  }, 60_000);
});

function nodeNamed(graph: ObservationGraphV1, name: string): ObservationGraphV1["nodes"][number] {
  const node = graph.nodes.find((candidate) => candidate.name === name);
  if (node === undefined) throw new Error(`Missing node named ${name}`);
  return node;
}

async function samplePngPixels(
  session: PlaywrightBrowserSession,
  bytes: Uint8Array,
  points: readonly (readonly [number, number])[],
): Promise<readonly (readonly [number, number, number, number])[]> {
  const result = await session.withPage(async (page) => page.evaluate(async ({ pngBytes, samplePoints }) => {
    const browser = globalThis as unknown as {
      readonly Blob: new (parts: unknown[], options: { readonly type: string }) => unknown;
      readonly createImageBitmap: (blob: unknown) => Promise<{ readonly width: number; readonly height: number }>;
      readonly document: {
        createElement(tagName: "canvas"): {
          width: number;
          height: number;
          getContext(contextId: "2d"): {
            drawImage(image: unknown, x: number, y: number): void;
            getImageData(x: number, y: number, width: number, height: number): { readonly data: Uint8ClampedArray };
          } | null;
        };
      };
    };
    const imageBytes = new Uint8Array(pngBytes);
    const bitmap = await browser.createImageBitmap(new browser.Blob([imageBytes], { type: "image/png" }));
    const canvas = browser.document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D context unavailable.");
    context.drawImage(bitmap, 0, 0);
    return samplePoints.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data));
  }, {
    pngBytes: Array.from(bytes),
    samplePoints: points,
  }));
  return result as unknown as readonly (readonly [number, number, number, number])[];
}
