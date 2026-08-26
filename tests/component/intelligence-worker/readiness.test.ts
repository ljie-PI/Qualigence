import { describe, expect, it } from "vitest";
import { WorkerHealthServer, WorkerLoop } from "@qualigence/intelligence-worker";
import type { IntelligenceJobStore, IntelligenceResultInbox } from "@qualigence/core-application";
import type { JobProcessor } from "@qualigence/intelligence-worker";
import type { Clock } from "@qualigence/intelligence-worker";

const clock: Clock = {
  now: () => "2026-08-26T00:00:00.000Z",
  sleep: async (_ms, signal) => new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    signal?.addEventListener("abort", () => resolve(), { once: true });
  }),
};

function emptyStore(): IntelligenceJobStore & IntelligenceResultInbox {
  return {
    lease: async () => undefined,
    renew: async () => {
      throw new Error("renew should not run without a lease");
    },
    abandon: async () => ({ disposition: "not-active" }),
    append: async () => ({ disposition: "accepted" }),
  };
}

function loop(): WorkerLoop {
  const processor: JobProcessor = { process: async () => {
    throw new Error("processor should not run without a lease");
  } };
  return new WorkerLoop({
    store: emptyStore(),
    inbox: emptyStore(),
    processor,
    workerId: "worker-ready",
    acceptedTypes: ["investigation.reproduction-planning"],
    leaseDurationMs: 60_000,
    idleBackoffMs: 5,
    clock,
  });
}

describe("Intelligence Worker readiness", () => {
  it("fails closed before the lease loop starts and recovers after a successful idle step", async () => {
    const workerLoop = loop();
    const health = new WorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      postgresProbe: async () => undefined,
      objectStorageReadinessUrl: "http://object-storage.ready/healthz",
      loopReadiness: () => workerLoop.readiness(),
      fetcher: async () => new Response("ok", { status: 200 }),
    });

    await expect(health.readiness()).resolves.toMatchObject({
      status: "not-ready",
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "worker_loop", status: "fail" }),
      ]),
    });

    const controller = new AbortController();
    const running = workerLoop.run(controller.signal);
    await Promise.resolve();
    await expect(health.readiness()).resolves.toMatchObject({
      status: "ready",
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "postgres", status: "pass" }),
        expect.objectContaining({ name: "object_storage", status: "pass" }),
        expect.objectContaining({ name: "worker_loop", status: "pass" }),
      ]),
    });
    controller.abort();
    await running;
  });

  it("turns not-ready while dependencies fail and ready again after recovery", async () => {
    const workerLoop = loop();
    const controller = new AbortController();
    const running = workerLoop.run(controller.signal);
    await Promise.resolve();

    let postgresHealthy = false;
    let objectStorageHealthy = false;
    const health = new WorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      postgresProbe: async () => {
        if (!postgresHealthy) throw new Error("postgres down");
      },
      objectStorageReadinessUrl: "http://object-storage.ready/healthz",
      loopReadiness: () => workerLoop.readiness(),
      fetcher: async () => new Response(objectStorageHealthy ? "ok" : "no", { status: objectStorageHealthy ? 200 : 503 }),
    });

    const failing = await health.readiness();
    expect(failing.status).toBe("not-ready");
    expect(failing.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "postgres", status: "fail" }),
      expect.objectContaining({ name: "object_storage", status: "fail" }),
    ]));

    postgresHealthy = true;
    objectStorageHealthy = true;
    await expect(health.readiness()).resolves.toMatchObject({ status: "ready" });

    controller.abort();
    await running;
  });
});
