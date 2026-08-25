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
import { RunnerAppError } from "../../../apps/runner/src/errors.js";
import { safeRunnerErrorCode, safeRunnerLogLine } from "../../../apps/runner/src/safe-runner-log.js";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";

const SECRET = "shadow-scheduler-secret@example.test";

const job: AcceptedExecutionJob = {
  jobId: "job-shadow-scheduler",
  runId: "run-shadow-scheduler",
  projectId: "project-test",
  target: { kind: "web", url: "http://placeholder.test" },
  objective: "Exercise Shadow DOM and scheduler sensitive evidence",
  policy: {
    policyId: "policy-shadow-scheduler",
    environment: "isolated_test",
    allowedOrigins: ["http://placeholder.test"],
    allowedActionKinds: ["input"],
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

describe("Shadow DOM, scheduler, and Runner safe logs", () => {
  let fixture: FixtureServer;
  let session: PlaywrightBrowserSession;

  beforeEach(async () => {
    fixture = await startFixtureServer({
      "/open-shadow-timer": htmlDocument(`
        <style>
          html, body { margin: 0; width: 420px; height: 220px; }
          #host { position: absolute; left: 10px; top: 10px; width: 220px; height: 34px; }
          label { display: block; margin-top: 120px; }
        </style>
        <div id="host"></div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
          shadow.innerHTML = '<span data-qualigence-observe id="mirror" style="display:block;width:220px;height:34px;background:rgb(250,250,250);color:white;font:16px sans-serif">waiting</span>';
          const input = document.querySelector('input');
          window.callbackRuns = [];
          input.addEventListener('input', event => {
            const value = event.target.value;
            setTimeout(() => { window.callbackRuns.push('timer'); shadow.getElementById('mirror').textContent = value; }, 0);
            requestAnimationFrame(() => { window.callbackRuns.push('raf'); });
            queueMicrotask(() => { window.callbackRuns.push('microtask'); });
            Promise.resolve().then(() => { window.callbackRuns.push('promise'); });
            Promise.reject(new Error('handled')).catch(() => { window.callbackRuns.push('catch'); });
            Promise.resolve().finally(() => { window.callbackRuns.push('finally'); });
          });
        </script>
      `, "Open Shadow Scheduler"),
      "/open-shadow-direct-text": htmlDocument(`
        <style>
          html, body { margin: 0; width: 420px; height: 220px; }
          #host { position: absolute; left: 10px; top: 10px; width: 220px; height: 34px; display: block; background: rgb(250,250,250); color: white; }
          label { display: block; margin-top: 120px; }
        </style>
        <div id="host"></div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
          shadow.textContent = 'waiting';
          document.querySelector('input').addEventListener('input', event => {
            shadow.textContent = event.target.value;
          });
        </script>
      `, "Open Shadow Direct Text"),
      "/closed-shadow": htmlDocument(`
        <div id="host"></div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          const shadow = document.getElementById('host').attachShadow({ mode: 'closed' });
          const mirror = document.createElement('span');
          mirror.textContent = 'waiting';
          shadow.appendChild(mirror);
          document.querySelector('input').addEventListener('input', event => {
            mirror.textContent = event.target.value;
          });
        </script>
      `, "Closed Shadow"),
      "/epoch-overflow": htmlDocument(`
        <div id="mirror" data-qualigence-observe>waiting</div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          window.callbackRuns = 0;
          document.querySelector('input').addEventListener('input', event => {
            const value = event.target.value;
            for (let index = 0; index < 1025; index += 1) {
              queueMicrotask(() => { window.callbackRuns += 1; if (index === 1024) document.getElementById('mirror').textContent = value; });
            }
          });
        </script>
      `, "Epoch Scheduler Overflow"),
      "/root-overflow": htmlDocument(`
        <div id="mirror" data-qualigence-observe>waiting</div>
        <div id="roots"></div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          const roots = document.getElementById('roots');
          for (let index = 0; index < 129; index += 1) {
            roots.appendChild(document.createElement('span')).attachShadow({ mode: 'open' }).textContent = 'ordinary-' + index;
          }
          document.querySelector('input').addEventListener('input', event => {
            document.getElementById('mirror').textContent = event.target.value;
          });
        </script>
      `, "Shadow Root Overflow"),
      "/session-overflow": htmlDocument(`
        <div id="mirror" data-qualigence-observe>waiting</div>
        <label>Email <input aria-label="Email" /></label>
        <script>
          window.callbackRuns = 0;
          document.querySelector('input').addEventListener('input', event => {
            const value = event.target.value;
            const count = value === 'overflow' ? 1 : 1024;
            for (let index = 0; index < count; index += 1) {
              queueMicrotask(() => { window.callbackRuns += 1; if (index === count - 1) document.getElementById('mirror').textContent = value; });
            }
          });
        </script>
      `, "Session Scheduler Overflow"),
    });
  });

  afterEach(async () => {
    await session?.close();
    await fixture?.close();
  });

  function options(path: string): WebSessionOptions {
    return {
      url: `${fixture.origin}${path}`,
      expectedOrigin: fixture.origin,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      allowedOrigins: [fixture.origin],
    };
  }

  async function wire(path: string, value = SECRET): Promise<{
    readonly observer: PlaywrightObserver;
    readonly resolver: PlaywrightActionResolver;
    readonly executor: PlaywrightActionExecutor;
  }> {
    session = new PlaywrightBrowserSession(options(path));
    await session.start();
    return {
      observer: new PlaywrightObserver(session),
      resolver: new PlaywrightActionResolver(session),
      executor: new PlaywrightActionExecutor(session, { resolve: async () => value }),
    };
  }

  it("redacts and masks a sensitive timer reflection in an open shadow root while preserving callbacks", async () => {
    const { observer, resolver, executor } = await wire("/open-shadow-timer");
    const url = `${fixture.origin}/open-shadow-timer`;
    const before = await observer.capture({ ...job, target: { kind: "web", url } });
    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(before, "Email").id },
      valueRef: "customer.email",
      reason: "reflect through open shadow scheduler",
    }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await session.withPage((page) => page.waitForTimeout(50));
    const after = await observer.capture({ ...job, target: { kind: "web", url } });

    expect(after.nodes.some((node) => node.name === "[redacted]" || node.value === "[redacted]")).toBe(true);
    expect(JSON.stringify(after)).not.toContain(SECRET);
    await expect(session.withPage((page) => page.evaluate(() => (globalThis as unknown as { callbackRuns: string[] }).callbackRuns)))
      .resolves.toEqual(expect.arrayContaining(["timer", "raf", "microtask", "promise", "catch", "finally"]));
    const png = session.artifactsFor(after.graphId).find((artifact) => artifact.mediaType === "image/png");
    expect(png).toBeDefined();
    expect((await samplePngPixels(session, png!.bytes, [[20, 20]]))[0]).toEqual([0, 0, 0, 255]);
  }, 60_000);

  it("masks an open shadow root host when direct shadow text reflects sensitive content", async () => {
    const { observer, resolver, executor } = await wire("/open-shadow-direct-text");
    const url = `${fixture.origin}/open-shadow-direct-text`;
    const before = await observer.capture({ ...job, target: { kind: "web", url } });
    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(before, "Email").id },
      valueRef: "customer.email",
      reason: "reflect direct shadow text",
    }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    const after = await observer.capture({ ...job, target: { kind: "web", url } });
    expect(JSON.stringify(after)).not.toContain(SECRET);
    const png = session.artifactsFor(after.graphId).find((artifact) => artifact.mediaType === "image/png");
    expect(png).toBeDefined();
    expect((await samplePngPixels(session, png!.bytes, [[20, 20]]))[0]).toEqual([0, 0, 0, 255]);
  }, 60_000);

  it("fails evidence closed for sensitive reflection in a closed shadow root", async () => {
    const { observer, resolver, executor } = await wire("/closed-shadow");
    const url = `${fixture.origin}/closed-shadow`;
    const before = await observer.capture({ ...job, target: { kind: "web", url } });
    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(before, "Email").id },
      valueRef: "customer.email",
      reason: "reflect into closed shadow",
    }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await expect(observer.capture({ ...job, target: { kind: "web", url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-shadow-scheduler:observation:2"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  }, 60_000);

  it("fails evidence closed when observed shadow-root discovery exceeds 128 roots", async () => {
    const { observer, resolver, executor } = await wire("/root-overflow");
    const url = `${fixture.origin}/root-overflow`;
    const before = await observer.capture({ ...job, target: { kind: "web", url } });
    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(before, "Email").id },
      valueRef: "customer.email",
      reason: "exceed shadow root bound",
    }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await expect(session.withPage((page) => page.locator("#mirror").textContent()))
      .resolves.toBe(SECRET);
    await expect(observer.capture({ ...job, target: { kind: "web", url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
  }, 60_000);

  it("counts scheduler registrations before native registration and preserves callbacks on epoch overflow", async () => {
    const { observer, resolver, executor } = await wire("/epoch-overflow");
    const url = `${fixture.origin}/epoch-overflow`;
    const before = await observer.capture({ ...job, target: { kind: "web", url } });
    const action = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(before, "Email").id },
      valueRef: "customer.email",
      reason: "overflow epoch scheduler registrations",
    }, before);

    await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
    await session.withPage((page) => page.waitForTimeout(50));
    await expect(session.withPage((page) => page.evaluate(() => (globalThis as unknown as { callbackRuns: number }).callbackRuns)))
      .resolves.toBe(1025);
    await expect(observer.capture({ ...job, target: { kind: "web", url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
  }, 60_000);

  it("poisons evidence on the 4,097th sensitive scheduler registration in a session", async () => {
    const { observer, resolver, executor } = await wire("/session-overflow", "safe");
    const url = `${fixture.origin}/session-overflow`;
    for (let round = 0; round < 4; round += 1) {
      const before = await observer.capture({ ...job, target: { kind: "web", url } });
      const action = await resolver.resolve({
        kind: "input",
        target: { nodeId: nodeNamed(before, "Email").id },
        valueRef: `customer.email.${round}`,
        reason: "fill scheduler session bound",
      }, before);
      await expect(executor.execute(action, allowedPermit())).resolves.toEqual({ status: "ok" });
      await session.withPage((page) => page.waitForTimeout(25));
    }

    const beforeOverflow = await observer.capture({ ...job, target: { kind: "web", url } });
    const overflowAction = await resolver.resolve({
      kind: "input",
      target: { nodeId: nodeNamed(beforeOverflow, "Email").id },
      valueRef: "customer.email.overflow",
      reason: "exceed scheduler session bound",
    }, beforeOverflow);
    const overflowExecutor = new PlaywrightActionExecutor(session, { resolve: async () => "overflow" });

    await expect(overflowExecutor.execute(overflowAction, allowedPermit())).resolves.toEqual({ status: "ok" });
    await session.withPage((page) => page.waitForTimeout(25));
    await expect(session.withPage((page) => page.evaluate(() => (globalThis as unknown as { callbackRuns: number }).callbackRuns)))
      .resolves.toBe(4097);
    await expect(observer.capture({ ...job, target: { kind: "web", url } }))
      .rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
  }, 60_000);

  it("emits only allowlisted Runner log codes", () => {
    expect(safeRunnerErrorCode(new RunnerAppError("CapabilityMismatch", "contains plaintext")))
      .toBe("CapabilityMismatch");
    expect(safeRunnerErrorCode({ code: "PolicyDenied", message: SECRET }))
      .toBe("UnexpectedRunnerError");
    const fatal = safeRunnerLogLine("runner.fatal", new Error(`boom ${SECRET}`));
    const reconnecting = safeRunnerLogLine("runner.reconnecting", new RunnerAppError("TransportError", `lost ${SECRET}`));

    expect(JSON.parse(fatal)).toEqual({ event: "runner.fatal", code: "UnexpectedRunnerError" });
    expect(JSON.parse(reconnecting)).toEqual({ event: "runner.reconnecting", code: "TransportError" });
    expect(`${fatal}${reconnecting}`).not.toContain(SECRET);
    expect(`${fatal}${reconnecting}`).not.toContain("message");
    expect(`${fatal}${reconnecting}`).not.toContain("stack");
    expect(`${fatal}${reconnecting}`).not.toContain("details");
  });
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
  return session.withPage(async (page) => page.evaluate(async ({ pngBytes, samplePoints }) => {
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
  }, { pngBytes: Array.from(bytes), samplePoints: points })) as unknown as Promise<readonly (readonly [number, number, number, number])[]>;
}
