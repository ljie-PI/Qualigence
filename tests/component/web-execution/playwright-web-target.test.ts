import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcceptedExecutionJob,
  ObservationGraph,
  ObservationNode,
} from "@qualigence/runner-protocol";
import { ExecutionPermit, type ProposedAction } from "@qualigence/runner-kernel";
import {
  PlaywrightWebTargetAdapter,
  type WebSessionOptions,
} from "@qualigence/web-playwright";
import type { BrowserLauncher } from "@qualigence/web-playwright/internal";
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
          <p data-qualigence-observe id="total">Cart total: $0</p>
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
      expectedOrigin: fixture.origin,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      allowedOrigins: [fixture.origin],
    };
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

  it("does not return registered artifacts after the page leaves the Job target origin", async () => {
    let currentUrl = fixture.url;
    const page = {
      goto: vi.fn(async () => undefined),
      url: () => currentUrl,
      evaluate: vi.fn(async () => [{ role: "button", name: "Add to cart" }]),
      title: vi.fn(async () => "Facade"),
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
    adapter = new PlaywrightWebTargetAdapter(options(), {
      launch: vi.fn(async () => browser),
    } as unknown as BrowserLauncher);
    await adapter.start();
    const observed = await adapter.capture({
      ...job,
      target: { kind: "web", url: fixture.url },
    });
    currentUrl = "https://other.test/private";

    await expect(adapter.captureArtifacts(observed.graphId)).rejects.toMatchObject({
      code: "OriginViolation",
    });
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
