import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { WorkerHealthServer } from "../../../apps/intelligence-worker/src/health-server.js";
import { S3ContextSource } from "../../../apps/intelligence-worker/src/s3-context-source.js";
import { WorkerLoop, type Clock } from "../../../apps/intelligence-worker/src/worker-loop.js";
import type { IntelligenceJobStore, IntelligenceResultInbox } from "@qualigence/core-application";
import type { JobProcessor } from "../../../apps/intelligence-worker/src/job-processor.js";

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
      objectStorageProbe: async () => undefined,
      loopReadiness: () => workerLoop.readiness(),
    });

    await expect(health.readiness()).resolves.toMatchObject({
      status: "not-ready",
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "worker_loop", status: "fail" }),
      ]),
    });

    const controller = new AbortController();
    const running = workerLoop.run(controller.signal);
    await waitFor(() => workerLoop.readiness().status === "ready");
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
    await waitFor(() => workerLoop.readiness().status === "ready");

    let postgresHealthy = false;
    let objectStorageHealthy = false;
    const health = new WorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      postgresProbe: async () => {
        if (!postgresHealthy) throw new Error("postgres down");
      },
      objectStorageProbe: async () => {
        if (!objectStorageHealthy) throw new Error("object storage data-plane down");
      },
      loopReadiness: () => workerLoop.readiness(),
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

  it("returns stable not-ready instead of hanging when the S3 readiness probe stalls", async () => {
    const workerLoop = loop();
    const controller = new AbortController();
    const running = workerLoop.run(controller.signal);
    await waitFor(() => workerLoop.readiness().status === "ready");

    let probeSignal: AbortSignal | undefined;
    const health = new WorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      postgresProbe: async () => undefined,
      objectStorageProbe: async (signal) => {
        probeSignal = signal;
        await new Promise<void>(() => undefined);
      },
      loopReadiness: () => workerLoop.readiness(),
      objectStorageProbeTimeoutMs: 5,
    });

    await expect(health.readiness()).resolves.toMatchObject({
      status: "not-ready",
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: "object_storage",
          status: "fail",
          code: "Unavailable",
          details: expect.objectContaining({ error: expect.stringContaining("timed out") }),
        }),
      ]),
    });
    expect(probeSignal?.aborted).toBe(true);

    controller.abort();
    await running;
  });

  it("passes the readiness AbortSignal through S3 write, read, and cleanup operations", async () => {
    const source = new S3ContextSource({
      region: "us-east-1",
      bucket: "qualigence-artifacts",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      forcePathStyle: true,
    });
    const sends: { readonly command: string; readonly signal: AbortSignal | undefined }[] = [];
    const fakeClient = {
      send: async (command: unknown, options?: { readonly abortSignal?: AbortSignal }) => {
        sends.push({ command: command instanceof Object ? command.constructor.name : "unknown", signal: options?.abortSignal });
        if (command instanceof GetObjectCommand) {
          return { Body: { transformToByteArray: async () => Buffer.from("qualigence-worker-object-storage-readiness", "utf8") } };
        }
        return {};
      },
    } as unknown as Pick<S3Client, "send">;
    (source as unknown as { client: Pick<S3Client, "send"> }).client = fakeClient;

    const controller = new AbortController();
    await source.verifyReadiness(controller.signal);

    expect(sends.map((send) => send.command)).toEqual(["PutObjectCommand", "GetObjectCommand", "DeleteObjectCommand"]);
    expect(sends.map((send) => send.signal)).toEqual([controller.signal, controller.signal, controller.signal]);
  });

  it("does not carry a previous successful loop observation across a restart", async () => {
    const workerLoop = loop();
    const first = new AbortController();
    const firstRun = workerLoop.run(first.signal);
    await waitFor(() => workerLoop.readiness().status === "ready");
    first.abort();
    await firstRun;
    expect(workerLoop.readiness()).toMatchObject({ status: "not-ready", active: false, aborted: true });

    const second = new AbortController();
    const secondRun = workerLoop.run(second.signal);
    expect(workerLoop.readiness()).toMatchObject({ status: "not-ready", active: true });
    await waitFor(() => workerLoop.readiness().status === "ready");
    second.abort();
    await secondRun;
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not observed before timeout");
}
