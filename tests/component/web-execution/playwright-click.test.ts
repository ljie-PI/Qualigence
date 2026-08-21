import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import type {
  AcceptedExecutionJob,
  ObservationGraph,
  ObservationNode,
} from "@qualigence/runner-protocol";
import { ExecutionPermit, ExecutionRuntime, type ProposedAction } from "@qualigence/runner-kernel";
import { InMemoryTraceStore, TraceIngestor } from "@qualigence/evidence";
import { InMemoryProtocolTraceRecorder } from "@qualigence/in-memory-runner-protocol";
import { AllowAllRunnerPolicyGate } from "@qualigence/testkit";
import {
  PlaywrightActionExecutor,
  PlaywrightActionResolver,
  PlaywrightBrowserSession,
  PlaywrightObserver,
  type WebSessionOptions,
} from "@qualigence/web-playwright/internal";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";

function allowedPermit(): ExecutionPermit {
  return ExecutionPermit.fromAllowedDecision({
    status: "allowed",
    reason: "allowed by component test",
  });
}

function click(nodeId: string): ProposedAction {
  return { kind: "click", target: { nodeId }, reason: "component test" };
}

function valued(kind: "input" | "select", nodeId: string, valueRef: string) {
  return { kind, target: { nodeId }, valueRef, reason: "component test" } as const;
}

function nodeNamed(graph: ObservationGraph, name: string): ObservationNode {
  const node = graph.nodes.find((candidate) => candidate.name === name);
  if (!node) {
    throw new Error(`No node named ${name} in graph ${graph.graphId}`);
  }
  return node;
}

const job: AcceptedExecutionJob = {
  jobId: "job-click",
  runId: "run-click",
  projectId: "project-test",
  target: { kind: "web", url: "http://placeholder.test" },
  objective: "Exercise clicks",
  policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["http://placeholder.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
};

describe("Playwright resolve + execute against real Chromium", () => {
  let fixture: FixtureServer;
  let cross: FixtureServer;
  let session: PlaywrightBrowserSession;

  beforeEach(async () => {
    cross = await startFixtureServer({ "/": htmlDocument("<h1>Other origin</h1>") });
    fixture = await startFixtureServer({
      "/": htmlDocument(
        `
          <button id="add" onclick="document.getElementById('total').textContent='Cart total: $19'">Add to cart</button>
          <p data-qualigence-observe id="total">Cart total: $0</p>
          <button disabled>Disabled action</button>
          <button class="twin">Twin</button>
          <button class="twin">Twin</button>
          <a id="leave" href="${cross.origin}/">Leave site</a>
          <span style="position:relative;display:inline-block">
            <button id="blocked">Blocked action</button>
            <span style="position:absolute;inset:0"></span>
          </span>
           <label>Email <input aria-label="Email" style="position:fixed;left:40px;top:200px;background:rgb(255,0,0);border:0;border-radius:0;padding:0;width:180px;height:40px;appearance:none" /></label>
           <label>Normalized secret <input aria-label="Normalized secret" /></label>
           <label>Mutable secret <input aria-label="Mutable secret" style="position:fixed;left:40px;top:140px;background:rgb(255,0,0);border:0;border-radius:0;padding:0;width:180px;height:40px;appearance:none" /></label>
           <label>Country <select aria-label="Country" style="position:fixed;left:40px;top:260px;background:rgb(255,0,0);border:0;border-radius:0;padding:0;width:180px;height:40px;appearance:none"><option value="private-country-code">Canada</option><option value="us">United States</option></select></label>
           <p data-qualigence-observe id="values"></p>
           <p data-qualigence-observe>ab</p>
           <div data-unrelated-region style="position:fixed;left:400px;top:80px;width:60px;height:60px;background:rgb(0,255,0)"></div>
           <script>
             document.querySelector('input').addEventListener('input', event => document.getElementById('values').textContent = event.target.value);
             document.querySelector('input[aria-label="Normalized secret"]').addEventListener('input', () => document.getElementById('values').textContent = 'Normalized ready');
             document.querySelector('input[aria-label="Mutable secret"]').addEventListener('input', event => {
               event.target.setAttribute('aria-label', event.target.value);
               document.getElementById('values').textContent = 'Mutable ready';
             });
             document.querySelector('select').addEventListener('change', event => document.getElementById('values').textContent += ':' + event.target.value);
           </script>
        `,
        "Clicks",
      ),
    });
  });

  afterEach(async () => {
    await session?.close();
    await fixture?.close();
    await cross?.close();
  });

  function options(overrides: Partial<WebSessionOptions> = {}): WebSessionOptions {
    return {
      url: fixture.url,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      allowedOrigins: [fixture.origin],
      ...overrides,
    };
  }

  async function wire(overrides: Partial<WebSessionOptions> = {}): Promise<{
    observer: PlaywrightObserver;
    resolver: PlaywrightActionResolver;
    executor: PlaywrightActionExecutor;
  }> {
    session = new PlaywrightBrowserSession(options(overrides));
    await session.start();
    return {
      observer: new PlaywrightObserver(session),
      resolver: new PlaywrightActionResolver(session),
      executor: new PlaywrightActionExecutor(session),
    };
  }

  it("resolves to a de-identified token and performs a same-origin click", async () => {
    const { observer, resolver, executor } = await wire();

    const before = await observer.capture(job);
    const action = await resolver.resolve(
      click(nodeNamed(before, "Add to cart").id),
      before,
    );
    expect(action.target.selector).toBe(
      `pw:${before.graphId}:${nodeNamed(before, "Add to cart").id}`,
    );
    expect(action.target.selector).not.toContain("#add");

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });

    const after = await observer.capture(job);
    const total = after.nodes.find((node) => node.text?.includes("Cart total"));
    expect(total?.text).toContain("$19");
  });

  it("rejects an unknown node without clicking", async () => {
    const { observer, resolver } = await wire();
    const before = await observer.capture(job);
    await expect(
      resolver.resolve(click("n-99-deadbeef"), before),
    ).rejects.toMatchObject({ code: "UnknownObservationNode" });
  });

  it("rejects a stale graph without clicking", async () => {
    const { observer, resolver } = await wire();
    const before = await observer.capture(job);
    const staleGraph: ObservationGraph = { ...before, graphId: "run-click:observation:99" };
    await expect(
      resolver.resolve(click(before.nodes[0]!.id), staleGraph),
    ).rejects.toMatchObject({ code: "StaleObservation" });
  });

  it("reports AmbiguousTarget for two nodes sharing role and name", async () => {
    const { observer, resolver } = await wire();
    const before = await observer.capture(job);
    const twin = before.nodes.find((node) => node.name === "Twin");
    await expect(resolver.resolve(click(twin!.id), before)).rejects.toMatchObject({
      code: "AmbiguousTarget",
    });
  });

  it("fails a disabled target without clicking", async () => {
    const { observer, resolver, executor } = await wire();
    const before = await observer.capture(job);
    const disabled = nodeNamed(before, "Disabled action");
    const action = await resolver.resolve(click(disabled.id), before);
    expect(await executor.execute(action, allowedPermit())).toEqual({
      status: "failed",
      errorCode: "TargetDisabled",
    });
  });

  it("blocks a cross-origin navigation with OriginViolation and does not navigate", async () => {
    const { observer, resolver, executor } = await wire();
    const before = await observer.capture(job);
    const leave = nodeNamed(before, "Leave site");
    const action = await resolver.resolve(click(leave.id), before);
    expect(await executor.execute(action, allowedPermit())).toEqual({
      status: "failed",
      errorCode: "OriginViolation",
    });

    const after = await observer.capture(job);
    expect(after.url).toBe(fixture.url);
  });

  it("maps a blocked click to ActionTimedOut", async () => {
    const { observer, resolver, executor } = await wire({ actionTimeoutMs: 1_200 });
    const before = await observer.capture(job);
    const blocked = nodeNamed(before, "Blocked action");
    const action = await resolver.resolve(click(blocked.id), before);
    expect(await executor.execute(action, allowedPermit())).toEqual({
      status: "failed",
      errorCode: "ActionTimedOut",
    });
  });

  it("executes input and select through valueRefs without returning plaintext", async () => {
    const values = new Map([
      ["customer.email", "private@example.test"],
      ["customer.country", "private-country-code"],
    ]);
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, {
      resolve: async (valueRef) => {
        const value = values.get(valueRef);
        if (value === undefined) throw new Error("missing");
        return value;
      },
    });
    const before = await observer.capture(job);

    const inputAction = await resolver.resolve(valued("input", nodeNamed(before, "Email").id, "customer.email"), before);
    const inputOutcome = await executor.execute(inputAction, allowedPermit());
    const afterInput = await observer.capture(job);
    const selectAction = await resolver.resolve(valued("select", nodeNamed(afterInput, "Country").id, "customer.country"), afterInput);
    const selectOutcome = await executor.execute(selectAction, allowedPermit());

    expect(inputOutcome).toEqual({ status: "ok" });
    expect(selectOutcome).toEqual({ status: "ok" });
    const afterSelect = await observer.capture(job);
    expect(afterSelect.nodes.filter((node) => node.name === "[REDACTED]"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "[REDACTED]", value: "[REDACTED]", text: "[REDACTED]" }),
        expect.objectContaining({ name: "[REDACTED]", value: "[REDACTED]", text: "[REDACTED]" }),
      ]));
    expect(afterSelect.nodes.filter((node) => node.name === "[REDACTED]")).toHaveLength(2);
    const screenshot = session.artifactsFor(afterSelect.graphId)
      .find((artifact) => artifact.mediaType === "image/png");
    const boxes = await session.withPage(async (page) => ({
      input: await page.locator('input[aria-label="Email"]').boundingBox(),
      select: await page.locator('select[aria-label="Country"]').boundingBox(),
      unrelated: await page.locator("[data-unrelated-region]").boundingBox(),
    }));
    if (screenshot === undefined || boxes.input === null || boxes.select === null || boxes.unrelated === null) {
      throw new Error("Expected screenshot and bounded regions.");
    }
    const image = decodePng(screenshot.bytes);
    expectSolidCrop(image, boxes.input, [0, 0, 0, 255]);
    expectSolidCrop(image, boxes.select, [0, 0, 0, 255]);
    expectSolidCrop(image, boxes.unrelated, [0, 255, 0, 255]);
    const serializedPublicValues = JSON.stringify([
      inputAction,
      inputOutcome,
      afterInput,
      selectAction,
      selectOutcome,
      afterSelect,
    ]);
    expect(serializedPublicValues).not.toContain("private@example.test");
    expect(serializedPublicValues).not.toContain("private-country-code");
  });

  it("redacts input plaintext from the complete Trace and verifier context", async () => {
    const secret = "trace-secret@example.test";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => secret });
    const traces = new InMemoryTraceStore();
    let serializedVerifierContext = "";
    const runtime = new ExecutionRuntime({
      observer,
      decisionProvider: {
        decide: async () => valued("input", "unused", "customer.email") as never,
      },
      resolver: {
        resolve: async (action, graph) => resolver.resolve(
          valued("input", nodeNamed(graph, "Email").id, "customer.email"),
          graph,
        ) as never,
      },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: executor,
      verifier: {
        verify: async (context) => {
          serializedVerifierContext = JSON.stringify(context);
          return { status: "passed", summary: "ok", claims: [] };
        },
      },
      traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(traces)),
      objectiveOnlyMaximumWallClockMs: 10_000,
      objectiveOnlyMaximumModelTokens: 100,
    });

    await expect(runtime.run(job)).resolves.toMatchObject({ status: "passed" });
    const serializedTrace = JSON.stringify(traces.eventsFor(job.runId));
    expect(serializedTrace).not.toContain(secret);
    expect(serializedVerifierContext).not.toContain(secret);
    expect(traces.eventsFor(job.runId).filter((event) => event.stage === "observation")).toHaveLength(2);
  });

  it("redacts only the acted node after Chromium normalizes a single-line input", async () => {
    const source = "a\r\nb\r\n";
    const browserValue = "ab";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => source });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Normalized secret").id, "customer.normalized"),
      before,
    );

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    const after = await observer.capture(job);
    const serialized = JSON.stringify(after);
    const target = nodeNamed(after, "[REDACTED]");
    const artifact = session.artifactsFor(after.graphId)
      .find((candidate) => candidate.mediaType === "application/json");
    const artifactGraph = JSON.parse(new TextDecoder().decode(artifact?.bytes)) as ObservationGraph;
    const artifactTarget = nodeNamed(artifactGraph, "[REDACTED]");

    expect(serialized).not.toContain(source);
    expect(target).toMatchObject({ value: "[REDACTED]", text: "[REDACTED]" });
    expect(artifactTarget).toMatchObject({ value: "[REDACTED]", text: "[REDACTED]" });
    expect(session.sensitiveTargets()[0]?.nodeId).toBe(target.id);
    expect(after.nodes.some((node) => node.text === "ab")).toBe(true);
    expect(artifactGraph.nodes.some((node) => node.text === browserValue)).toBe(true);
  });

  it("keeps the exact acted element redacted when its accessible identity changes", async () => {
    const source = "a\r\nb\r\n";
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, { resolve: async () => source });
    const before = await observer.capture(job);
    const action = await resolver.resolve(
      valued("input", nodeNamed(before, "Mutable secret").id, "customer.mutable"),
      before,
    );

    expect(await executor.execute(action, allowedPermit())).toEqual({ status: "ok" });
    const after = await observer.capture(job);
    const target = nodeNamed(after, "[REDACTED]");
    const observationArtifact = session.artifactsFor(after.graphId)
      .find((artifact) => artifact.mediaType === "application/json");
    const screenshotArtifact = session.artifactsFor(after.graphId)
      .find((artifact) => artifact.mediaType === "image/png");
    const artifactGraph = JSON.parse(
      new TextDecoder().decode(observationArtifact?.bytes),
    ) as ObservationGraph;
    const boxes = await session.withPage(async (page) => ({
      target: await session.sensitiveTargets()[0]?.handle.boundingBox(),
      unrelated: await page.locator("[data-unrelated-region]").boundingBox(),
    }));
    if (
      boxes.target === null ||
      boxes.target === undefined ||
      boxes.unrelated === null ||
      screenshotArtifact === undefined
    ) {
      throw new Error("Expected screenshot regions and artifact.");
    }

    expect(target).toMatchObject({ value: "[REDACTED]", text: "[REDACTED]" });
    expect(nodeNamed(artifactGraph, "[REDACTED]"))
      .toMatchObject({ name: "[REDACTED]", value: "[REDACTED]", text: "[REDACTED]" });
    expect(after.nodes.some((node) => node.text === "ab")).toBe(true);
    const image = decodePng(screenshotArtifact.bytes);
    expectSolidCrop(image, boxes.target, [0, 0, 0, 255]);
    expectSolidCrop(image, boxes.unrelated, [0, 255, 0, 255]);
  });

  it("fails closed before artifacts when an earlier sensitive target is replaced", async () => {
    session = new PlaywrightBrowserSession(options());
    await session.start();
    const observer = new PlaywrightObserver(session);
    const resolver = new PlaywrightActionResolver(session);
    const executor = new PlaywrightActionExecutor(session, {
      resolve: async (valueRef) => valueRef === "customer.country"
        ? "private-country-code"
        : "replace-secret",
    });
    const before = await observer.capture(job);
    const inputAction = await resolver.resolve(
      valued("input", nodeNamed(before, "Mutable secret").id, "customer.replace"),
      before,
    );

    expect(await executor.execute(inputAction, allowedPermit())).toEqual({ status: "ok" });
    const afterInput = await observer.capture(job);
    const selectAction = await resolver.resolve(
      valued("select", nodeNamed(afterInput, "Country").id, "customer.country"),
      afterInput,
    );
    expect(await executor.execute(selectAction, allowedPermit())).toEqual({ status: "ok" });
    await session.withPage(async (page) => {
      await page.getByRole("textbox", { name: "replace-secret" }).evaluate((element) => {
        element.replaceWith(element.cloneNode(true));
      });
    });

    await expect(observer.capture(job)).rejects.toMatchObject({
      code: "SensitiveTargetUnproven",
    });
    expect(session.latestGraphId).toBe(afterInput.graphId);
    expect(() => session.artifactsFor("run-click:observation:3")).toThrowError(
      expect.objectContaining({ code: "StaleObservation" }),
    );
  });
});

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly pixels: Buffer;
}

function decodePng(bytes: Uint8Array): DecodedPng {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => bytes[index] === byte)) throw new Error("Invalid PNG signature.");
  let width = 0;
  let height = 0;
  let colorType = -1;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const length = view.getUint32(0);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      if (data[8] !== 8 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("Unsupported PNG encoding.");
      }
      colorType = data[9]!;
    } else if (type === "IDAT") {
      compressed.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new Error("Unsupported PNG color type.");
  const filtered = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[sourceOffset++]!;
    const rowOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = filtered[sourceOffset++]!;
      const left = column >= channels ? pixels[rowOffset + column - channels]! : 0;
      const above = row > 0 ? pixels[rowOffset - stride + column]! : 0;
      const upperLeft = row > 0 && column >= channels
        ? pixels[rowOffset - stride + column - channels]!
        : 0;
      pixels[rowOffset + column] = (raw + pngFilterDelta(filter, left, above, upperLeft)) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function expectSolidCrop(
  image: DecodedPng,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  expected: readonly [number, number, number, number],
): void {
  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const right = Math.min(image.width, Math.ceil(box.x + box.width));
  const bottom = Math.min(image.height, Math.ceil(box.y + box.height));
  if (left >= right || top >= bottom) throw new Error("Crop does not intersect the PNG.");
  const stride = image.width * image.channels;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = y * stride + x * image.channels;
      expect([
        image.pixels[offset]!,
        image.pixels[offset + 1]!,
        image.pixels[offset + 2]!,
        image.channels === 4 ? image.pixels[offset + 3]! : 255,
      ], `pixel (${x}, ${y})`).toEqual(expected);
    }
  }
}

function pngFilterDelta(filter: number, left: number, above: number, upperLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return above;
  if (filter === 3) return Math.floor((left + above) / 2);
  if (filter !== 4) throw new Error(`Unsupported PNG filter ${filter}.`);
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance ? above : upperLeft;
}
