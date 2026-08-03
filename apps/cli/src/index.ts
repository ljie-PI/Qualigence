import { pathToFileURL } from "node:url";
import type { RunExecutionResult, RunExecutionUseCase } from "@qualigence/execution-application";
import { CliConfigError, loadConfig, parseRunRequest, type OutputMode } from "./config.js";
import { renderHuman, renderJson, createLogger } from "./output.js";
import { exitCodeFor } from "./exit-code.js";
import { createLocalRunUseCase } from "./local-run-composition-root.js";

export {
  loadConfig,
  parseRunRequest,
  CliConfigError,
  type CliConfig,
  type ModelConfig,
  type OutputMode,
  type RunInvocation,
} from "./config.js";
export {
  renderHuman,
  renderJson,
  createLogger,
  type LoggerOptions,
} from "./output.js";
export { exitCodeFor } from "./exit-code.js";
export {
  createLocalRunUseCase,
  LocalRunResourceFactory,
} from "./local-run-composition-root.js";

export interface CliIo {
  readonly stdout: { write(chunk: string): unknown };
}

/**
 * Runs the `run` command against an injected {@link RunExecutionUseCase}. It
 * parses arguments, executes the use case, writes exactly one result to stdout
 * (JSON is the machine contract) and returns the mapped exit code. It never
 * calls `process.exit`.
 */
export async function runCli(
  argv: readonly string[],
  _env: NodeJS.ProcessEnv,
  useCase: RunExecutionUseCase,
  io: CliIo = { stdout: process.stdout },
): Promise<number> {
  let output: OutputMode = "human";
  let result: RunExecutionResult;
  try {
    const invocation = parseRunRequest(argv);
    output = invocation.output;
    result = await useCase.execute(invocation.request);
  } catch (error) {
    if (error instanceof CliConfigError) {
      result = {
        runId: "",
        status: "error",
        errorCode: error.code,
        evidenceRefs: [],
      };
    } else {
      throw error;
    }
  }

  io.stdout.write(output === "json" ? renderJson(result) : renderHuman(result));
  return exitCodeFor(result);
}

/**
 * The CLI entry point. It loads model settings from the environment, builds the
 * local use case through the composition root and runs the requested command.
 * A configuration failure is reported as a `cli-result/v1` error (exit code 3)
 * without a stack trace, so a missing or invalid secret never leaks. The
 * process exit code is set, never forced via `process.exit`.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const logger = createLogger();
  let useCase: RunExecutionUseCase;
  try {
    const config = loadConfig(env);
    useCase = await createLocalRunUseCase(config);
  } catch (error) {
    if (error instanceof CliConfigError) {
      const result: RunExecutionResult = {
        runId: "",
        status: "error",
        errorCode: error.code,
        evidenceRefs: [],
      };
      process.stdout.write(renderHuman(result));
      return exitCodeFor(result);
    }
    logger.error({ err: error }, "Failed to initialize the CLI.");
    throw error;
  }

  const code = await runCli(argv, env, useCase);
  return code;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.exitCode = 1;
      process.stderr.write(`${String(error)}\n`);
    },
  );
}
