import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AcceptedExecutionJob,
  ObservationGraph,
  ObservationNode,
} from "@qualigence/runner-protocol";
import {
  ExecutionPermit,
  type AnyProposedAction,
  type ProposedAction,
} from "@qualigence/runner-kernel";
import {
  PlaywrightWebTargetAdapter,
  type WebSessionOptions,
} from "@qualigence/web-playwright";
import {
  chromiumLauncher,
  finalizeArtifactBatch,
  type BrowserLauncher,
  type BrowserSessionTestHooks,
  type SensitiveEvidenceDiagnosticReason,
} from "@qualigence/web-playwright/internal";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";

function allowedPermit(): ExecutionPermit {
  return ExecutionPermit.fromAllowedDecision({
    status: "allowed",
    reason: "allowed by facade test",
  });
}

function click(nodeId: string): ProposedAction {
  return { kind: "click", target: { nodeId }, reason: "facade test" };
}

function input(nodeId: string): AnyProposedAction {
  return {
    kind: "input",
    target: { nodeId },
    valueRef: "facade-sensitive-value",
    reason: "facade test",
  };
}

function nodeNamed(graph: ObservationGraph, name: string): ObservationNode {
  const node = graph.nodes.find((candidate) => candidate.name === name);
  if (!node) {
    throw new Error(`No node named ${name}`);
  }
  return node;
}

/**
 * PIDs of Playwright/Chromium processes that are direct children of this test
 * process. Tracking the delta created by our own launch keeps the assertion
 * robust even when other test files run browsers in parallel.
 */
function childBrowserPids(): Set<number> {
  const self = process.pid;
  const pids = new Set<number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const ppidMatch = status.match(/^PPid:\s*(\d+)/m);
      if (!ppidMatch || Number(ppidMatch[1]) !== self) {
        continue;
      }
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (cmdline.includes("ms-playwright") || cmdline.includes("headless_shell")) {
        pids.add(Number(entry));
      }
    } catch {
      // Process vanished between readdir and read; ignore.
    }
  }
  return pids;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasPngSignature(bytes: Uint8Array | undefined): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes !== undefined && signature.every((byte, index) => bytes[index] === byte);
}

const job: AcceptedExecutionJob = {
  jobId: "job-facade",
  runId: "run-facade",
  projectId: "project-test",
  target: { kind: "web", url: "http://placeholder.test" },
  objective: "Drive the facade",
  policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["http://placeholder.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
};

describe("PlaywrightWebTargetAdapter facade", () => {
  let fixture: FixtureServer;
  let adapter: PlaywrightWebTargetAdapter;

  beforeEach(async () => {
    fixture = await startFixtureServer({
      "/": htmlDocument(
        `
          <button id="add" onclick="document.getElementById('total').textContent='Cart total: $19'">Add to cart</button>
          <label>Email <input aria-label="Email" /></label>
          <p data-qualigence-observe id="total">Cart total: $0</p>
          <script>
            document.querySelector('input').addEventListener('input', () => {
              const receiver = Promise.resolve('delegated');
              const delegate = receiver.then;
              Object.defineProperty(receiver, 'then', {
                configurable: true,
                enumerable: false,
                writable: true,
                value: function (...args) { return Reflect.apply(delegate, this, args); },
              });
              Reflect.apply(Promise.prototype.then, receiver, []);
              window.observedPromiseOwner = receiver;
            });
          </script>
        `,
        "Facade",
      ),
    });
  });

  afterEach(async () => {
    await adapter?.close();
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

  function observedOwnerControl(): {
    readonly launcher: BrowserLauncher;
    readonly mutate: (timing: "immediate" | "timer" | "schedule-timer") => Promise<void>;
  } {
    let mutate: ((timing: "immediate" | "timer" | "schedule-timer") => Promise<void>) | undefined;
    const launcher: BrowserLauncher = {
      launch: async (launchOptions) => {
        const browser = await chromiumLauncher.launch(launchOptions);
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (...contextOptions) => {
          const context = await newContext(...contextOptions);
          const newPage = context.newPage.bind(context);
          context.newPage = async () => {
            const page = await newPage();
            if (mutate !== undefined) return page;
            mutate = async (timing) => page.evaluate(async (mutationTiming) => {
              const replaceOwner = () => {
                const owner = (globalThis as typeof globalThis & {
                  observedPromiseOwner?: Promise<string> & { then: Promise<string>["then"] };
                }).observedPromiseOwner;
                if (owner === undefined) throw new Error("Observed Promise owner is unavailable");
                Object.setPrototypeOf(owner, Object.create(Object.getPrototypeOf(owner)));
              };
              if (mutationTiming === "schedule-timer") {
                setTimeout(replaceOwner, 0);
              } else if (mutationTiming === "timer") {
                await new Promise<void>((resolve) => setTimeout(() => {
                  replaceOwner();
                  resolve();
                }, 0));
              } else {
                replaceOwner();
              }
            }, timing);
            return page;
          };
          return context;
        };
        return browser;
      },
    };
    return {
      launcher,
      mutate: async (timing) => {
        if (mutate === undefined) throw new Error("Application page was not captured");
        await mutate(timing);
      },
    };
  }

  async function captureSensitiveObservation(
    launcher: BrowserLauncher,
    testHooks?: BrowserSessionTestHooks,
  ): Promise<ObservationGraph> {
    adapter = new PlaywrightWebTargetAdapter({
      ...options(),
      valueProvider: { resolve: async () => "sensitive-value" },
    }, launcher, testHooks);
    await adapter.start();
    const before = await adapter.capture(job);
    const inputAction = await adapter.resolve(input(nodeNamed(before, "Email").id), before);
    await expect(adapter.execute(inputAction, allowedPermit())).resolves.toEqual({ status: "ok" });
    return adapter.capture(job);
  }

  // TODO(Task 21): remove this Windows quarantine after browser-process leak checks use a cross-platform lifecycle seam instead of /proc.
  it.skipIf(process.platform === "win32")(
    "runs observe -> resolve -> execute -> artifacts -> close and reaps the browser",
    async () => {
    adapter = new PlaywrightWebTargetAdapter(options());

    const before = childBrowserPids();
    await adapter.start();
    const created = [...childBrowserPids()].filter((pid) => !before.has(pid));
    expect(created.length).toBeGreaterThanOrEqual(1);

    const observed = await adapter.capture(job);
    const action = await adapter.resolve(
      click(nodeNamed(observed, "Add to cart").id),
      observed,
    );
    expect(action.target.selector).toBe(
      `pw:${observed.graphId}:${nodeNamed(observed, "Add to cart").id}`,
    );

    expect(await adapter.execute(action, allowedPermit())).toEqual({ status: "ok" });

    const after = await adapter.capture(job);
    expect(after.nodes.find((node) => node.text?.includes("Cart total"))?.text).toContain(
      "$19",
    );

    const artifacts = await adapter.captureArtifacts(observed.graphId);
    expect(artifacts).toHaveLength(2);
    const json = artifacts.find((a) => a.mediaType === "application/json");
    const png = artifacts.find((a) => a.mediaType === "image/png");
    expect(json?.name).toBe("1-observation.json");
    expect(png?.name).toBe("1.png");
    expect(Array.from(png!.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(new TextDecoder().decode(json!.bytes)).toContain(observed.graphId);

    await adapter.close();
    await adapter.close();

    for (const pid of created) {
      expect(isAlive(pid)).toBe(false);
    }

    await expect(adapter.capture(job)).rejects.toBeInstanceOf(Error);
    await expect(adapter.captureArtifacts(observed.graphId)).rejects.toBeInstanceOf(Error);
    },
  );

  it("rejects captureArtifacts for an unknown graph id", async () => {
    adapter = new PlaywrightWebTargetAdapter(options());
    await adapter.start();
    await expect(
      adapter.captureArtifacts("run-facade:observation:404"),
    ).rejects.toMatchObject({ code: "StaleObservation" });
  });

  it("returns no cached artifact batch after an observed Promise owner is replaced", async () => {
    const control = observedOwnerControl();
    const diagnostics: SensitiveEvidenceDiagnosticReason[] = [];
    const observed = await captureSensitiveObservation(control.launcher, {
      onSensitiveEvidenceDiagnostic: (reason) => {
        diagnostics.push(reason);
        throw new Error("ignored test sink failure");
      },
    });

    await control.mutate("immediate");
    const receivedArtifacts: string[] = [];
    let receivedBytes = 0;

    await expect((async () => {
      const artifacts = await adapter.captureArtifacts(observed.graphId);
      for (const artifact of artifacts) {
        receivedArtifacts.push(artifact.name);
        receivedBytes += artifact.bytes.byteLength;
      }
    })()).rejects.toMatchObject({ code: "SensitiveEvidenceUnproven" });
    expect(receivedArtifacts).toEqual([]);
    expect(receivedBytes).toBe(0);
    expect(diagnostics).toContain("PromiseOwnerIntegrityUnproven");
    await expect(adapter.captureArtifacts(observed.graphId)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
  });

  it("rejects with zero bytes when the final-boundary hook mutates an observed uninvoked owner", async () => {
    const control = observedOwnerControl();
    const events: string[] = [];
    const observed = await captureSensitiveObservation(control.launcher, {
      afterArtifactIntegrityChecks: async () => {
        events.push("hook");
        await control.mutate("immediate");
        events.push("mutated");
      },
    });
    let receivedBytes = 0;

    await expect((async () => {
      events.push("capture");
      const artifacts = await adapter.captureArtifacts(observed.graphId);
      events.push("returned");
      receivedBytes = artifacts.reduce((total, artifact) => total + artifact.bytes.byteLength, 0);
    })()).rejects.toMatchObject({ code: "SensitiveEvidenceUnproven" });
    expect(events).toEqual(["capture", "hook", "mutated"]);
    expect(receivedBytes).toBe(0);
  });

  it("catches a timer owner mutation scheduled while the last test seam is awaited", async () => {
    const control = observedOwnerControl();
    const observed = await captureSensitiveObservation(control.launcher, {
      afterArtifactIntegrityChecks: () => control.mutate("timer"),
    });

    await expect(adapter.captureArtifacts(observed.graphId)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
  });

  it("catches an owner mutation scheduled before the earlier awaited checks", async () => {
    const control = observedOwnerControl();
    const observed = await captureSensitiveObservation(control.launcher);
    await control.mutate("schedule-timer");

    await expect(adapter.captureArtifacts(observed.graphId)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
  });

  it("returns an unchanged frozen batch for an observed uninvoked owner", async () => {
    const control = observedOwnerControl();
    const observed = await captureSensitiveObservation(control.launcher);

    const artifacts = await adapter.captureArtifacts(observed.graphId);
    expect(artifacts).toHaveLength(2);
    expect(Object.isFrozen(artifacts)).toBe(true);
    expect(artifacts.every(Object.isFrozen)).toBe(true);
    const json = artifacts.find((artifact) => artifact.mediaType === "application/json");
    const pngs = artifacts.filter((artifact) =>
      artifact.name.endsWith(".png") && artifact.mediaType === "image/png");
    const pngManifests = pngs.map(({ name, mediaType, bytes }) => ({
      name,
      kind: "screenshot" as const,
      mediaType,
      size: bytes.byteLength,
    }));
    expect(pngManifests).toHaveLength(1);
    if (!hasPngSignature(pngs[0]?.bytes)) {
      throw new Error(`Invalid PNG artifact; safe manifest: ${JSON.stringify(pngManifests[0])}`);
    }
    expect(new TextDecoder().decode(json?.bytes)).toContain(observed.graphId);
    if (json === undefined) throw new Error("Observation artifact is unavailable");
    json.bytes.fill(0);

    await expect(adapter.captureArtifacts(observed.graphId)).rejects.toMatchObject({
      code: "SensitiveEvidenceUnproven",
    });
  });

  it("performs sticky poison, final owner validation, and byte copying synchronously in order", () => {
    const events: string[] = [];
    const bytes = new Uint8Array([1, 2, 3]);
    Object.defineProperty(bytes, Symbol.iterator, {
      value: function* () {
        events.push("copy");
        yield 1;
        yield 2;
        yield 3;
      },
    });

    const batch = finalizeArtifactBatch({
      snapshot: () => {
        events.push("snapshot");
        return { intact: true, descriptorShapeIntact: true };
      },
      revalidateOwners: () => {
        events.push("owners");
        return true;
      },
    }, {
      trackers: [{
        overflow: false,
        observerError: false,
        scheduledPoison: false,
        schedulerProvenanceUnproven: false,
        outstandingPromiseDelegations: 0,
        promiseIntegrity: () => {
          events.push("sticky");
          return true;
        },
        shadowPoison: false,
        ambiguousEvent: false,
      }],
      cache: {
        consumed: false,
        artifacts: [{
          name: "evidence.png",
          mediaType: "image/png",
          bytes,
        }],
      },
    });

    expect(events).toEqual(["snapshot", "sticky", "owners", "copy"]);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch[0])).toBe(true);
    expect(Object.isFrozen(batch[0]?.bytes)).toBe(true);
  });

  it("returns no batch when artifact byte copying throws", () => {
    const bytes = new Uint8Array([1]);
    Object.defineProperty(bytes, Symbol.iterator, {
      value: function* () {
        throw new Error("copy-failed");
      },
    });
    let batch: ReturnType<typeof finalizeArtifactBatch> | undefined;

    const cache = {
      consumed: false,
      artifacts: [{
        name: "evidence.png" as const,
        mediaType: "image/png" as const,
        bytes,
      }],
    };
    expect(() => {
      batch = finalizeArtifactBatch({
        snapshot: () => ({ intact: true, descriptorShapeIntact: true }),
        revalidateOwners: () => true,
      }, {
        trackers: [],
        cache,
      });
    }).toThrow("copy-failed");
    expect(batch).toBeUndefined();
    expect(cache).toEqual({ consumed: true, artifacts: [] });
  });

  it("rejects concurrent reentry with ConcurrentSessionOperation", async () => {
    adapter = new PlaywrightWebTargetAdapter(options());
    await adapter.start();

    const first = adapter.capture(job);
    const second = adapter.capture(job);
    const results = await Promise.allSettled([first, second]);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason?.code).toBe("ConcurrentSessionOperation");
  });
});
