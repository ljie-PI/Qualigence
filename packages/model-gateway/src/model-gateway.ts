import type {
  ModelProvider,
  ModelProviderErrorCode,
  StructuredModelRequest,
  StructuredOutputContract,
  ValidatedModelResult,
} from "@qualigence/model-provider";

export type ModelGatewayErrorCode =
  | ModelProviderErrorCode
  | "InvalidStructuredOutput"
  | "CapabilityMismatch";

export class ModelGatewayError extends Error {
  constructor(
    readonly code: ModelGatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

export interface ModelGatewayDependencies {
  readonly provider: ModelProvider;
  readonly delay?: (delayMs: number) => Promise<void>;
}

export interface StructuredModelInvoker {
  invokeStructured<T>(
    request: StructuredModelRequest,
    output: StructuredOutputContract<T>,
  ): Promise<ValidatedModelResult<T>>;
}

export class ModelGateway implements StructuredModelInvoker {
  private readonly delay: (delayMs: number) => Promise<void>;

  constructor(private readonly dependencies: ModelGatewayDependencies) {
    this.delay = dependencies.delay ?? defaultDelay;
  }

  async invokeStructured<T>(
    request: StructuredModelRequest,
    output: StructuredOutputContract<T>,
  ): Promise<ValidatedModelResult<T>> {
    if (!this.dependencies.provider.capabilities.structuredOutput) {
      throw new ModelGatewayError(
        "CapabilityMismatch",
        "The selected model provider does not support structured output.",
      );
    }

    let schemaAttempts = 0;
    let transientAttempts = 0;
    let providerRequest = request;

    while (true) {
      try {
        const response = await this.dependencies.provider.invoke({
          ...providerRequest,
          responseSchema: output.jsonSchema,
        });

        try {
          return {
            value: output.parse(response.output),
            model: response.model,
            finishReason: response.finishReason,
            ...(response.providerRequestId === undefined
              ? {}
              : { providerRequestId: response.providerRequestId }),
            ...(response.usage === undefined ? {} : { usage: response.usage }),
          };
        } catch {
          if (schemaAttempts >= 1) {
            throw new ModelGatewayError(
              "InvalidStructuredOutput",
              `The provider returned output that does not match ${output.name}.`,
            );
          }

          schemaAttempts += 1;
          providerRequest = {
            ...providerRequest,
            messages: [
              ...providerRequest.messages,
              {
                role: "user",
                content: `The previous response failed schema validation for ${output.name}. Return only JSON that matches the supplied schema.`,
              },
            ],
          };
        }
      } catch (error) {
        if (error instanceof ModelGatewayError) {
          throw error;
        }

        const normalized = normalizeProviderError(error);
        if (!isTransient(normalized.code) || transientAttempts >= 2) {
          throw normalized;
        }

        transientAttempts += 1;
        await this.delay(100 * 2 ** (transientAttempts - 1));
      }
    }
  }
}

function normalizeProviderError(error: unknown): ModelGatewayError {
  if (isProviderError(error)) {
    return new ModelGatewayError(error.code, error.message);
  }

  return new ModelGatewayError("ProviderUnavailable", "The model provider is unavailable.");
}

function isProviderError(
  error: unknown,
): error is { readonly code: ModelProviderErrorCode; readonly message: string } {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  return (
    (candidate.code === "AuthenticationFailed" ||
      candidate.code === "RateLimited" ||
      candidate.code === "TimedOut" ||
      candidate.code === "ProviderUnavailable") &&
    typeof candidate.message === "string"
  );
}

function isTransient(code: ModelGatewayErrorCode): boolean {
  return code === "RateLimited" || code === "TimedOut" || code === "ProviderUnavailable";
}

async function defaultDelay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
