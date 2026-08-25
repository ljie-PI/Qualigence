import { InvestigationAgent } from "@qualigence/model-agent";
import { pathToFileURL } from "node:url";
import { ModelGateway } from "@qualigence/model-gateway";
import { OpenAICompatibleModelProvider } from "@qualigence/openai-compatible-model-provider";
import {
  acquirePostgresOperationLock,
  assertPostgresSchemaCurrent,
  PostgresIntelligenceQueue,
} from "@qualigence/postgres-runtime";
import type { IntelligenceJobType } from "@qualigence/intelligence";
import { loadWorkerConfig } from "./config.js";
import { InvestigationJobProcessor } from "./investigation-job-processor.js";
import { S3ContextSource } from "./s3-context-source.js";
import { WorkerLoop } from "./worker-loop.js";

const ACCEPTED_TYPES: readonly IntelligenceJobType[] = [
  "investigation.reproduction-planning",
  "investigation.bug-analysis",
];

/**
 * Boot the standalone Intelligence Worker: connect to PostgreSQL as the
 * least-privilege Worker role, wire the Model Gateway + investigation agent +
 * S3 context source, and run the lease/process/append loop until interrupted.
 */
export async function main(
  env: NodeJS.ProcessEnv = process.env,
  assertSchema = assertPostgresSchemaCurrent,
): Promise<void> {
  const config = loadWorkerConfig(env);
  await assertSchema(config.postgres, config.serverPostgresRole);

  const queue = new PostgresIntelligenceQueue(
    {
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
    },
    acquirePostgresOperationLock,
  );

  const provider = new OpenAICompatibleModelProvider({
    baseUrl: config.model.baseUrl,
    apiKey: config.model.apiKey,
  });
  const gateway = new ModelGateway({ provider });
  const agent = new InvestigationAgent(gateway, config.model.modelName);
  const contextSource = new S3ContextSource(config.artifacts);
  const processor = new InvestigationJobProcessor(agent, contextSource);

  const loop = new WorkerLoop({
    store: queue,
    inbox: queue,
    processor,
    workerId: config.workerId,
    acceptedTypes: ACCEPTED_TYPES,
    leaseDurationMs: config.leaseDurationMs,
    idleBackoffMs: config.idleBackoffMs,
    onError: (error) => {
      console.error("[intelligence-worker] job processing failed", error);
    },
  });

  const abort = new AbortController();
  const shutdown = (): void => {
    abort.abort();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.error(`[intelligence-worker] ${config.workerId} started`);
  try {
    await loop.run(abort.signal);
  } finally {
    await queue.close();
    console.error(`[intelligence-worker] ${config.workerId} stopped`);
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error("[intelligence-worker] fatal", error);
    process.exitCode = 1;
  });
}
