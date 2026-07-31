import type {
  ModelProvider,
  ModelProviderErrorCode,
  StructuredModelRequest,
  StructuredOutputContract,
  StructuredOutputValidationError,
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
        } catch (error) {
          if (schemaAttempts >= 1) {
            throw new ModelGatewayError(
              "InvalidStructuredOutput",
              `The provider returned output that does not match ${output.name}.`,
            );
          }

          schemaAttempts += 1;
          const validationSummary = summarizeValidationIssues(error);
          providerRequest = {
            ...providerRequest,
            messages: [
              ...providerRequest.messages,
              {
                role: "user",
                content: `The previous response failed schema validation for ${output.name}.${validationSummary === undefined ? "" : ` Validation issues: ${validationSummary}.`} Return only JSON that matches the supplied schema.`,
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
      candidate.code === "InvalidRequest" ||
      candidate.code === "RateLimited" ||
      candidate.code === "TimedOut" ||
      candidate.code === "ProviderUnavailable") &&
    typeof candidate.message === "string"
  );
}

function isTransient(code: ModelGatewayErrorCode): boolean {
  return code === "RateLimited" || code === "TimedOut" || code === "ProviderUnavailable";
}

function summarizeValidationIssues(error: unknown): string | undefined {
  if (!isStructuredOutputValidationError(error)) {
    return undefined;
  }

  const issues = error.issues.slice(0, 3).map((issue) => {
    const path = sanitizeValidationToken(issue.path, 96);
    const reason = sanitizeValidationToken(issue.reason, 64);
    return `${path}:${reason}`;
  });
  return issues.length === 0 ? undefined : issues.join(", ");
}

function isStructuredOutputValidationError(
  error: unknown,
): error is StructuredOutputValidationError {
  if (!(error instanceof Error) || error.name !== "StructuredOutputValidationError") {
    return false;
  }

  const issues = (error as { readonly issues?: unknown }).issues;
  return Array.isArray(issues) && issues.every((issue) => {
    if (typeof issue !== "object" || issue === null) {
      return false;
    }
    const candidate = issue as { readonly path?: unknown; readonly reason?: unknown };
    return typeof candidate.path === "string" && typeof candidate.reason === "string";
  });
}

function sanitizeValidationToken(value: string, maximumLength: number): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.[\]-]/g, "_").slice(0, maximumLength);
  return sanitized.length === 0 ? "output" : sanitized;
}

async function defaultDelay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
