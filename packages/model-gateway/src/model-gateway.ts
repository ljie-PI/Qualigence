import type {
  ModelCapabilities,
  ModelInvocationContext,
  ModelProvider,
  ModelProviderErrorCode,
  StructuredModelRequest,
  StructuredOutputContract,
  StructuredOutputValidationError,
  ValidatedModelResult,
} from "@qualigence/model-provider";
import type { Clock } from "@qualigence/shared-kernel";
import { SystemClock } from "@qualigence/shared-kernel";
import { assertVisualInputAllowed, VisualInputPolicyError } from "./data-policy.js";
import type { VisualInputErrorCode } from "./data-policy.js";

export type ModelGatewayErrorCode =
  | ModelProviderErrorCode
  | "InvalidStructuredOutput"
  | "CapabilityMismatch"
  | VisualInputErrorCode;

export class ModelGatewayError extends Error {
  constructor(
    readonly code: ModelGatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

/**
 * A de-identified, provider-neutral summary of one logical model invocation
 * (all retry attempts collapse into a single report). It never carries prompt
 * messages or raw model output.
 */
export interface ModelInvocationReport {
  readonly context: ModelInvocationContext;
  readonly operation: string;
  readonly model: string;
  readonly status: "succeeded" | "failed";
  readonly latencyMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly providerRequestId?: string;
  readonly errorCode?: string;
  readonly occurredAt: string;
}

export interface ModelInvocationObserver {
  record(report: ModelInvocationReport): Promise<void>;
}

export interface ModelGatewayDependencies {
  readonly provider: ModelProvider;
  readonly delay?: (delayMs: number) => Promise<void>;
  readonly invocationObserver?: ModelInvocationObserver;
  readonly clock?: Clock;
}

export interface StructuredModelInvoker {
  invokeStructured<T>(
    request: StructuredModelRequest,
    output: StructuredOutputContract<T>,
  ): Promise<ValidatedModelResult<T>>;
}

export class ModelGateway implements StructuredModelInvoker {
  private readonly delay: (delayMs: number) => Promise<void>;
  private readonly clock: Clock;

  constructor(private readonly dependencies: ModelGatewayDependencies) {
    this.delay = dependencies.delay ?? defaultDelay;
    this.clock = dependencies.clock ?? new SystemClock();
  }

  async invokeStructured<T>(
    request: StructuredModelRequest,
    output: StructuredOutputContract<T>,
  ): Promise<ValidatedModelResult<T>> {
    const startedAtMs = Date.now();
    try {
      const result = await this.runStructured(request, output);
      await this.report(request, startedAtMs, {
        status: "succeeded",
        model: result.model,
        ...(result.providerRequestId === undefined
          ? {}
          : { providerRequestId: result.providerRequestId }),
        ...(result.usage?.inputTokens === undefined
          ? {}
          : { inputTokens: result.usage.inputTokens }),
        ...(result.usage?.outputTokens === undefined
          ? {}
          : { outputTokens: result.usage.outputTokens }),
      });
      return result;
    } catch (error) {
      await this.report(request, startedAtMs, {
        status: "failed",
        model: request.model,
        errorCode: errorCodeOf(error),
      });
      throw error;
    }
  }

  private async runStructured<T>(
    request: StructuredModelRequest,
    output: StructuredOutputContract<T>,
  ): Promise<ValidatedModelResult<T>> {
    if (!this.dependencies.provider.capabilities.structuredOutput) {
      throw new ModelGatewayError(
        "CapabilityMismatch",
        "The selected model provider does not support structured output.",
      );
    }

    this.assertVisualInputAllowed(request, this.dependencies.provider.capabilities);

    let schemaAttempts = 0;
    let transientAttempts = 0;
    let providerRequest = request;

    while (true) {
      const providerRequestWithSchema = {
        ...providerRequest,
        responseSchema: output.jsonSchema,
      };
      let response: Awaited<ReturnType<ModelProvider["invoke"]>>;
      try {
        response = await this.dependencies.provider.invoke(providerRequestWithSchema);
      } catch (error) {
        const normalized = normalizeProviderError(error);
        if (!isTransient(normalized.code) || transientAttempts >= 2) {
          throw normalized;
        }

        transientAttempts += 1;
        await this.delay(100 * 2 ** (transientAttempts - 1));
        continue;
      }

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
        if (!isStructuredOutputValidationError(error)) {
          throw error;
        }

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
    }
  }

  private async report(
    request: StructuredModelRequest,
    startedAtMs: number,
    fields: {
      readonly status: "succeeded" | "failed";
      readonly model: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly providerRequestId?: string;
      readonly errorCode?: string;
    },
  ): Promise<void> {
    const observer = this.dependencies.invocationObserver;
    if (observer === undefined || request.invocation === undefined) {
      return;
    }

    await observer.record({
      context: request.invocation,
      operation: request.operation,
      latencyMs: Math.max(0, Date.now() - startedAtMs),
      occurredAt: this.clock.now(),
      ...fields,
    });
  }

  private assertVisualInputAllowed(
    request: StructuredModelRequest,
    capabilities: ModelCapabilities,
  ): void {
    try {
      assertVisualInputAllowed(request, capabilities);
    } catch (error) {
      if (error instanceof VisualInputPolicyError) {
        throw new ModelGatewayError(error.code, error.message);
      }
      throw error;
    }
  }
}

function errorCodeOf(error: unknown): string {
  if (error instanceof ModelGatewayError) {
    return error.code;
  }
  return "ProviderUnavailable";
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
