import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LocalArtifactStore } from "@qualigence/artifact-fs";
import { TraceIngestor } from "@qualigence/evidence";
import {
  ArtifactRecordingObserver,
  PersistedModelInvocationObserver,
  RunExecutionUseCaseImpl,
  type ArtifactSource,
  type RunExecutionRequest,
  type RunExecutionResult,
  type RunExecutionUseCase,
  type RunResourceFactory,
  type RunResourceScope,
} from "@qualigence/execution-application";
import { InMemoryProtocolTraceRecorder } from "@qualigence/in-memory-runner-protocol";
import {
  ModelBackedDecisionProvider,
  ModelBackedVerifier,
} from "@qualigence/model-agent";
import { ModelGateway } from "@qualigence/model-gateway";
import { OpenAICompatibleModelProvider } from "@qualigence/openai-compatible-model-provider";
import {
  DeterministicRunnerPolicyGate,
  ExecutionRuntime,
} from "@qualigence/runner-kernel";
import { SystemClock } from "@qualigence/shared-kernel";
import {
  SqliteArtifactManifestStore,
  SqliteModelInvocationStore,
  SqliteRunStore,
  SqliteRuntime,
  SqliteTraceStore,
} from "@qualigence/sqlite-runtime";
import { PlaywrightWebTargetAdapter } from "@qualigence/web-playwright";
import type { CliConfig } from "./config.js";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const DATABASE_FILE = "qualigence.db";
const ARTIFACT_DIR = "artifacts";

/**
 * The sole local construction seam. It assembles the SQLite-backed persistence
 * ports, the filesystem Artifact store, a Playwright web target and the
 * model-backed Decision/Verifier chain into one {@link RunResourceScope}. LS-05
 * will provide an alternative {@link RunResourceFactory} backed by a remote
 * Runner without changing {@link RunExecutionUseCase} or the CLI.
 */
export class LocalRunResourceFactory implements RunResourceFactory {
  constructor(private readonly config: CliConfig) {}

  async open(
    runId: string,
    request: RunExecutionRequest,
  ): Promise<RunResourceScope> {
    const clock = new SystemClock();
    await mkdir(this.config.dataDir, { recursive: true });

    const runtime = await SqliteRuntime.open({
      filename: join(this.config.dataDir, DATABASE_FILE),
      busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
      clock,
    });

    let adapter: PlaywrightWebTargetAdapter | undefined;
    try {
      const runs = new SqliteRunStore(runtime);
      const traces = new SqliteTraceStore(runtime, clock);
      const manifests = new SqliteArtifactManifestStore(runtime);
      const modelInvocations = new SqliteModelInvocationStore(runtime);
      const artifacts = new LocalArtifactStore(
        join(this.config.dataDir, ARTIFACT_DIR),
        clock,
      );

      adapter = new PlaywrightWebTargetAdapter({
        url: request.target.url,
        headed: request.executionProfile.headed,
        navigationTimeoutMs: request.executionProfile.navigationTimeoutMs,
        actionTimeoutMs: request.executionProfile.actionTimeoutMs,
        allowedOrigins: request.policy.allowedOrigins,
      });

      const provider = new OpenAICompatibleModelProvider({
        baseUrl: this.config.model.baseUrl,
        apiKey: this.config.model.apiKey,
      });
      const gateway = new ModelGateway({
        provider,
        invocationObserver: new PersistedModelInvocationObserver(
          modelInvocations,
        ),
        clock,
      });
      const decisionProvider = new ModelBackedDecisionProvider(
        gateway,
        this.config.model.modelName,
      );
      const verifier = new ModelBackedVerifier(
        gateway,
        this.config.model.modelName,
      );

      const source: ArtifactSource = {
        captureArtifacts: (graphId) => adapter!.captureArtifacts(graphId),
      };
      const observer = new ArtifactRecordingObserver({
        observer: adapter,
        source,
        artifacts,
        manifests,
        runId,
        createArtifactId: uuidv7,
      });

      const traceRecorder = new InMemoryProtocolTraceRecorder(
        new TraceIngestor(traces),
      );

      const executionRuntime = new ExecutionRuntime({
        observer,
        decisionProvider,
        resolver: adapter,
        policyGate: new DeterministicRunnerPolicyGate(request.policy),
        actionExecutor: adapter,
        verifier,
        traceRecorder,
        objectiveOnlyMaximumWallClockMs: request.executionProfile.actionTimeoutMs,
        objectiveOnlyMaximumModelTokens: requiredModelTokenCeiling(this.config),
      });

      await adapter.start();

      const boundAdapter = adapter;
      return {
        execute: (job) => executionRuntime.run(job),
        artifacts,
        manifests,
        runs,
        traces,
        close: async () => {
          let firstError: unknown;
          try {
            await boundAdapter.close();
          } catch (cause) {
            firstError = cause;
          }
          try {
            await runtime.close();
          } catch (cause) {
            firstError ??= cause;
          }
          if (firstError !== undefined) {
            throw firstError;
          }
        },
      };
    } catch (cause) {
      // Opening the scope failed before any Run was created; release the
      // resources acquired so far and let the use case map the error.
      if (adapter !== undefined) {
        await adapter.close().catch(() => undefined);
      }
      await runtime.close().catch(() => undefined);
      throw cause;
    }
  }
}

/**
 * Builds the shared {@link RunExecutionUseCase} for the local CLI. The returned
 * object intentionally exposes only `execute`, hiding every concrete dependency
 * behind the {@link LocalRunResourceFactory} seam.
 */
export async function createLocalRunUseCase(
  config: CliConfig,
): Promise<RunExecutionUseCase> {
  const useCase = new RunExecutionUseCaseImpl(new LocalRunResourceFactory(config));
  return {
    execute: (request: RunExecutionRequest): Promise<RunExecutionResult> =>
      useCase.execute(request),
  };
}

function requiredModelTokenCeiling(config: CliConfig): number {
  const value = config.model.maximumTokensPerCall;
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) {
    throw new Error("Local model maximumTokensPerCall must be configured");
  }
  return value;
}

/**
 * Generates a UUIDv7 Artifact identifier for persisted captures.
 */
function uuidv7(): string {
  const bytes = randomBytes(16);
  const timestamp = Date.now();
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
