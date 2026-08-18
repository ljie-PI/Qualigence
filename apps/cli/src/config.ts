import { Command, CommanderError } from "commander";
import { z } from "zod";
import { isValidExecutionTargetUrl } from "@qualigence/execution-application";
import type { RunExecutionRequest } from "@qualigence/execution-application";

export type OutputMode = "human" | "json";

/** Model connection settings. Secrets are only read from the environment. */
export interface ModelConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelName: string;
}

export interface CliConfig {
  readonly model: ModelConfig;
  readonly dataDir: string;
}

export interface RunInvocation {
  readonly request: RunExecutionRequest;
  readonly output: OutputMode;
}

/** A user-safe configuration error mapped to CLI exit code 3. */
export class CliConfigError extends Error {
  readonly code = "InvalidConfiguration" as const;
  constructor(message: string) {
    super(message);
    this.name = "CliConfigError";
  }
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL_PROFILE_ID = "default";
const DEFAULT_DATA_DIR = ".qualigence/data";
const LOCAL_POLICY_DURATION_MS = 15_000;

const environmentSchema = z.object({
  QUALIGENCE_MODEL_BASE_URL: z
    .string()
    .trim()
    .min(1, "QUALIGENCE_MODEL_BASE_URL is required"),
  QUALIGENCE_MODEL_API_KEY: z
    .string()
    .trim()
    .min(1, "QUALIGENCE_MODEL_API_KEY is required"),
  QUALIGENCE_MODEL_NAME: z
    .string()
    .trim()
    .min(1, "QUALIGENCE_MODEL_NAME is required"),
  QUALIGENCE_DATA_DIR: z.string().trim().min(1).optional(),
});

/**
 * Reads model connection settings and the data directory from the environment.
 * The API key is only accepted as a secret environment variable and never as a
 * CLI argument. Missing or empty required values raise `InvalidConfiguration`.
 */
export function loadConfig(env: NodeJS.ProcessEnv): CliConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new CliConfigError(issue?.message ?? "Invalid model configuration.");
  }

  return {
    model: {
      baseUrl: parsed.data.QUALIGENCE_MODEL_BASE_URL,
      apiKey: parsed.data.QUALIGENCE_MODEL_API_KEY,
      modelName: parsed.data.QUALIGENCE_MODEL_NAME,
    },
    dataDir: parsed.data.QUALIGENCE_DATA_DIR ?? DEFAULT_DATA_DIR,
  };
}

/**
 * Parses the `run` command options into a stable {@link RunExecutionRequest}.
 * Only `--url`, `--objective`, `--output` and `--headed` are recognized; there
 * is deliberately no `--api-key`-style secret flag. Unknown options, missing
 * required options or an invalid `--output` value raise `InvalidConfiguration`.
 */
export function parseRunRequest(argv: readonly string[]): RunInvocation {
  const options = parseRunOptions(argv);

  const output = options.output ?? "human";
  if (output !== "human" && output !== "json") {
    throw new CliConfigError(
      `--output must be "human" or "json", received "${output}".`,
    );
  }

  const request: RunExecutionRequest = {
    projectId: "local",
    target: { kind: "web", url: options.url },
    objective: options.objective,
    policy: localPolicy(options.url),
    executionProfile: {
      modelProfileId: DEFAULT_MODEL_PROFILE_ID,
      headed: options.headed === true,
      navigationTimeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
      actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    },
  };

  return { request, output };
}

function localPolicy(url: string): RunExecutionRequest["policy"] {
  if (!isValidExecutionTargetUrl(url)) {
    throw new CliConfigError("--url must be a valid HTTP(S) URL.");
  }
  const origin = new URL(url).origin;
  const issuedAt = new Date().toISOString();
  return {
    policyId: "local-cli-isolated-test",
    environment: "isolated_test",
    allowedOrigins: [origin],
    allowedActionKinds: ["click"],
    maximumRisk: "Normal",
    explorationAllowed: false,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + LOCAL_POLICY_DURATION_MS).toISOString(),
  };
}

interface RunOptions {
  readonly url: string;
  readonly objective: string;
  readonly output?: string;
  readonly headed?: boolean;
}

function parseRunOptions(argv: readonly string[]): RunOptions {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  program.name("qualigence").description("Qualigence local execution CLI");

  let captured: RunOptions | undefined;
  program
    .command("run")
    .requiredOption("--url <url>", "target web URL")
    .requiredOption("--objective <text>", "execution objective")
    .option("--output <mode>", "output format: human or json", "human")
    .option("--headed", "run the browser headed", false)
    .action((opts: RunOptions) => {
      captured = opts;
    });

  try {
    program.parse([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new CliConfigError(sanitizeCommanderMessage(error));
    }
    throw error;
  }

  if (captured === undefined) {
    throw new CliConfigError("No command was provided. Expected: run.");
  }
  return captured;
}

function sanitizeCommanderMessage(error: CommanderError): string {
  const message = error.message.trim();
  return message.length === 0
    ? `Invalid CLI arguments (${error.code}).`
    : message;
}
