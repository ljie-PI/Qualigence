import { ExplorationAgent } from "@qualigence/model-agent";
import {
  ModelGateway,
  type ModelGatewayDependencies,
  type StructuredModelInvoker,
} from "@qualigence/model-gateway";
import { OpenAICompatibleModelProvider } from "@qualigence/openai-compatible-model-provider";
import type { ReferenceModelProfile } from "@qualigence/benchmarking-detection";
import type { BenchmarkAgentFactory } from "./run.js";

export interface ReferenceModelProviderEnvironment {
  readonly QUALIGENCE_REFERENCE_MODEL_BASE_URL?: string | undefined;
  readonly QUALIGENCE_REFERENCE_MODEL_API_KEY?: string | undefined;
  readonly QUALIGENCE_MODEL_BASE_URL?: string | undefined;
  readonly QUALIGENCE_MODEL_API_KEY?: string | undefined;
}

export interface ReferenceModelAgentFactoryDependencies {
  readonly invocationObserver?: ModelGatewayDependencies["invocationObserver"];
  readonly clock?: ModelGatewayDependencies["clock"];
}

const SUPPORTED_EXPLORATION_PROMPT_VERSION = "prompt/2026-08-01";

export class ReferenceModelProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceModelProviderConfigurationError";
  }
}

/**
 * Construct the release Reference Model agent from the manifest's frozen
 * profile. Secrets and endpoint location are environment-supplied, but the
 * provider identity and model ID are taken from the manifest so acceptance cannot
 * silently run a different model than the reported profile hash.
 */
export function createReferenceModelAgentFactory(
  profile: ReferenceModelProfile,
  env: ReferenceModelProviderEnvironment = process.env,
  dependencies: ReferenceModelAgentFactoryDependencies = {},
): BenchmarkAgentFactory {
  if (profile.promptVersion !== SUPPORTED_EXPLORATION_PROMPT_VERSION) {
    throw new ReferenceModelProviderConfigurationError(
      `Unsupported Reference Model promptVersion "${profile.promptVersion}". ` +
        `This benchmark runner is bound to ${SUPPORTED_EXPLORATION_PROMPT_VERSION}.`,
    );
  }

  if (profile.providerId !== "openai-compatible") {
    throw new ReferenceModelProviderConfigurationError(
      `Unsupported Reference Model provider "${profile.providerId}". ` +
        "Detection Benchmark v1 release acceptance is configured for providerId \"openai-compatible\".",
    );
  }

  const baseUrl = firstNonEmpty(
    env.QUALIGENCE_REFERENCE_MODEL_BASE_URL,
    env.QUALIGENCE_MODEL_BASE_URL,
  );
  const apiKey = firstNonEmpty(
    env.QUALIGENCE_REFERENCE_MODEL_API_KEY,
    env.QUALIGENCE_MODEL_API_KEY,
  );
  if (baseUrl === undefined || apiKey === undefined) {
    throw new ReferenceModelProviderConfigurationError(
      "Reference Model provider credentials are unavailable. Set " +
        "QUALIGENCE_REFERENCE_MODEL_BASE_URL and QUALIGENCE_REFERENCE_MODEL_API_KEY " +
        "(or the legacy QUALIGENCE_MODEL_BASE_URL / QUALIGENCE_MODEL_API_KEY aliases) " +
        "before running the real Reference Model benchmark acceptance.",
    );
  }

  const gateway = new ModelGateway({
    provider: new OpenAICompatibleModelProvider({ baseUrl, apiKey }),
    ...(dependencies.invocationObserver === undefined ? {} : { invocationObserver: dependencies.invocationObserver }),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const invoker = assertManifestModelInvoker(gateway, profile.modelId);

  return {
    provenance: "model-provider",
    createAgent: () => new ExplorationAgent(invoker, profile.modelId),
  };
}

function assertManifestModelInvoker(
  gateway: ModelGateway,
  expectedModelId: string,
): StructuredModelInvoker {
  return {
    async invokeStructured(request, output) {
      if (request.model !== expectedModelId) {
        throw new ReferenceModelProviderConfigurationError(
          `Reference Model invocation requested model "${request.model}" but manifest pins "${expectedModelId}".`,
        );
      }
      const result = await gateway.invokeStructured(request, output);
      if (result.model !== expectedModelId) {
        throw new ReferenceModelProviderConfigurationError(
          `Reference Model provider returned model "${result.model}" but manifest pins "${expectedModelId}".`,
        );
      }
      return result;
    },
  };
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}
