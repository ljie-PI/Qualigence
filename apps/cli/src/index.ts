import type { RunExecutionResult, RunExecutionUseCase } from "@qualigence/execution-application";
import { CliConfigError, parseRunRequest, type OutputMode } from "./config.js";
import { renderHuman, renderJson } from "./output.js";
import { exitCodeFor } from "./exit-code.js";

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
