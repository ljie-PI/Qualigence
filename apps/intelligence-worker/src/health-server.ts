import { createServer, type Server, type ServerResponse } from "node:http";
import type { WorkerLoopReadiness } from "./worker-loop.js";

export type WorkerReadinessCheckName = "postgres" | "object_storage" | "worker_loop";

export interface WorkerReadinessCheck {
  readonly name: WorkerReadinessCheckName;
  readonly status: "pass" | "fail";
  readonly code?: string;
  readonly safeMessage: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface WorkerReadinessReport {
  readonly status: "ready" | "not-ready";
  readonly checks: readonly WorkerReadinessCheck[];
}

export interface WorkerHealthServerOptions {
  readonly host: string;
  readonly port: number;
  readonly postgresProbe: () => Promise<void>;
  readonly objectStorageReadinessUrl?: string;
  readonly loopReadiness: () => WorkerLoopReadiness;
  readonly fetcher?: typeof fetch;
}

/**
 * Small in-process Worker health server. Liveness is deliberately cheap; readiness
 * re-probes constructed dependencies and the lease loop so Compose cannot mark a
 * Worker ready merely because the process is alive.
 */
export class WorkerHealthServer {
  private readonly server: Server;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: WorkerHealthServerOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.server = createServer((request, response) => {
      void this.handle(request.url ?? "/", response);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  async readiness(): Promise<WorkerReadinessReport> {
    const checks = [
      await postgresCheck(this.options.postgresProbe),
      await objectStorageCheck(this.options.objectStorageReadinessUrl, this.fetcher),
      workerLoopCheck(this.options.loopReadiness()),
    ];
    return {
      status: checks.every((check) => check.status === "pass") ? "ready" : "not-ready",
      checks,
    };
  }

  private async handle(path: string, response: ServerResponse): Promise<void> {
    if (path.split("?", 1)[0] === "/livez") {
      sendJson(response, 200, { status: "live" });
      return;
    }
    if (path.split("?", 1)[0] === "/readyz") {
      const report = await this.readiness();
      sendJson(response, report.status === "ready" ? 200 : 503, report);
      return;
    }
    sendJson(response, 404, { status: "not-found" });
  }
}

async function postgresCheck(probe: () => Promise<void>): Promise<WorkerReadinessCheck> {
  try {
    await probe();
    return { name: "postgres", status: "pass", safeMessage: "Worker PostgreSQL dependency is reachable and schema-current" };
  } catch (error) {
    return fail("postgres", "Unavailable", "Worker PostgreSQL dependency probe failed", { error: errorMessage(error) });
  }
}

async function objectStorageCheck(
  readinessUrl: string | undefined,
  fetcher: typeof fetch,
): Promise<WorkerReadinessCheck> {
  if (readinessUrl === undefined) {
    return fail("object_storage", "NotConfigured", "object storage readiness URL is not configured");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetcher(readinessUrl, { signal: controller.signal });
    if (!response.ok) {
      return fail("object_storage", "Unavailable", "object storage readiness endpoint is not healthy", { status: response.status });
    }
    return { name: "object_storage", status: "pass", safeMessage: "object storage readiness endpoint is healthy" };
  } catch (error) {
    return fail("object_storage", "Unavailable", "object storage readiness endpoint failed", { error: errorMessage(error) });
  } finally {
    clearTimeout(timeout);
  }
}

function workerLoopCheck(readiness: WorkerLoopReadiness): WorkerReadinessCheck {
  const pass = readiness.status === "ready";
  return {
    name: "worker_loop",
    status: pass ? "pass" : "fail",
    ...(pass ? {} : { code: "LoopNotReady" }),
    safeMessage: pass
      ? "Intelligence Worker lease loop is running"
      : "Intelligence Worker lease loop cannot make progress",
    details: readiness as unknown as Readonly<Record<string, unknown>>,
  };
}

function fail(
  name: WorkerReadinessCheckName,
  code: string,
  safeMessage: string,
  details?: Readonly<Record<string, unknown>>,
): WorkerReadinessCheck {
  return {
    name,
    status: "fail",
    code,
    safeMessage,
    ...(details === undefined ? {} : { details }),
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
