import type {
  ModelCapabilities,
  ModelInvocationContext,
  ModelProvider,
  ModelProviderErrorCode,
  ModelUsage,
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
    readonly usage?: ModelUsage,
    readonly providerAttempted = false,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

export class ModelGatewayAbortError extends Error {
  constructor(
    readonly reason: unknown,
    readonly usage?: ModelUsage,
    readonly usageUnavailable = false,
    readonly providerAttempted = false,
  ) {
    super(reason instanceof Error ? reason.message : "The model invocation was aborted.");
    this.name = "ModelGatewayAbortError";
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
      request.signal?.throwIfAborted();
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
      if (error instanceof ModelGatewayAbortError) {
        throw error;
      }
      if (request.signal?.aborted === true) {
        throw request.signal.reason;
      }
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

    if (
      request.maximumOutputTokens !== undefined &&
      (!Number.isSafeInteger(request.maximumOutputTokens) || request.maximumOutputTokens <= 0)
    ) {
      throw new ModelGatewayError(
        "InvalidRequest",
        "maximumOutputTokens must be a positive safe integer.",
      );
    }

    this.assertVisualInputAllowed(request, this.dependencies.provider.capabilities);

    let schemaAttempts = 0;
    let transientAttempts = 0;
    let providerRequest = request;
    let accumulatedUsage: ModelUsage | undefined;
    let accumulatedTotalTokens = 0;
    let usageAvailable = true;
    let knownUsageAvailable = false;
    let providerAttempts = 0;

    while (true) {
      if (request.signal?.aborted === true) {
        if (providerAttempts === 0) {
          throw request.signal.reason;
        }
        throw abortError(
          request.signal,
          accumulatedUsage,
          accumulatedTotalTokens,
          knownUsageAvailable,
          !usageAvailable,
        );
      }
      const providerRequestWithSchema = {
        ...providerRequest,
        responseSchema: output.jsonSchema,
      };
      let response: Awaited<ReturnType<ModelProvider["invoke"]>>;
      try {
        providerAttempts += 1;
        response = await awaitWithAbort(
          this.dependencies.provider.invoke(providerRequestWithSchema),
          request.signal,
        );
      } catch (error) {
        if (error instanceof ProviderInvocationAborted) {
          throw abortError(
            request.signal,
            accumulatedUsage,
            accumulatedTotalTokens,
            knownUsageAvailable,
            true,
          );
        }
        const normalized = normalizeProviderError(error);
        const attemptUsage = accumulateUsage(
          accumulatedUsage,
          accumulatedTotalTokens,
          usageAvailable,
          knownUsageAvailable,
          normalized.usage,
        );
        accumulatedUsage = attemptUsage.usage;
        accumulatedTotalTokens = attemptUsage.totalTokens;
        usageAvailable = attemptUsage.available;
        knownUsageAvailable = attemptUsage.known;
        if (isAborted(request.signal)) {
          throw abortError(
            request.signal,
            accumulatedUsage,
            accumulatedTotalTokens,
            knownUsageAvailable,
            !usageAvailable,
          );
        }
        if (!isTransient(normalized.code) || transientAttempts >= 1) {
          throw new ModelGatewayError(
            normalized.code,
            normalized.message,
            completeUsage(accumulatedUsage, accumulatedTotalTokens, usageAvailable),
            true,
          );
        }

        transientAttempts += 1;
        try {
          await awaitWithAbort(
            this.delay(100 * 2 ** (transientAttempts - 1)),
            request.signal,
          );
        } catch (delayError) {
          if (delayError instanceof ProviderInvocationAborted) {
            throw abortError(
              request.signal,
              accumulatedUsage,
              accumulatedTotalTokens,
              knownUsageAvailable,
              !usageAvailable,
            );
          }
          throw delayError;
        }
        continue;
      }

      const attemptUsage = accumulateUsage(
        accumulatedUsage,
        accumulatedTotalTokens,
        usageAvailable,
        knownUsageAvailable,
        response.usage,
      );
      accumulatedUsage = attemptUsage.usage;
      accumulatedTotalTokens = attemptUsage.totalTokens;
      usageAvailable = attemptUsage.available;
      knownUsageAvailable = attemptUsage.known;
      if (isAborted(request.signal)) {
        throw abortError(
          request.signal,
          accumulatedUsage,
          accumulatedTotalTokens,
          knownUsageAvailable,
          !usageAvailable,
        );
      }

      try {
        const usage = completeUsage(accumulatedUsage, accumulatedTotalTokens, usageAvailable);
        const result = {
          value: output.parse(response.output),
          model: response.model,
          finishReason: response.finishReason,
          ...(response.providerRequestId === undefined
            ? {}
            : { providerRequestId: response.providerRequestId }),
          ...(usage === undefined ? {} : { usage }),
        };
        if (isAborted(request.signal)) {
          throw abortError(
            request.signal,
            accumulatedUsage,
            accumulatedTotalTokens,
            knownUsageAvailable,
            !usageAvailable,
          );
        }
        return result;
      } catch (error) {
        if (error instanceof ModelGatewayAbortError) {
          throw error;
        }
        if (!isStructuredOutputValidationError(error)) {
          throw error;
        }

        if (schemaAttempts >= 1) {
          throw new ModelGatewayError(
            "InvalidStructuredOutput",
            `The provider returned output that does not match ${output.name}.`,
            completeUsage(accumulatedUsage, accumulatedTotalTokens, usageAvailable),
            true,
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

function normalizedUsage(usage: ModelUsage, totalTokens: number): ModelUsage {
  return { ...usage, totalTokens };
}

function completeUsage(
  usage: ModelUsage | undefined,
  totalTokens: number,
  available: boolean,
): ModelUsage | undefined {
  return available && usage !== undefined ? normalizedUsage(usage, totalTokens) : undefined;
}

function accumulateUsage(
  current: ModelUsage | undefined,
  currentTotalTokens: number,
  currentlyAvailable: boolean,
  currentlyKnown: boolean,
  next: ModelUsage | undefined,
): {
  readonly usage: ModelUsage | undefined;
  readonly totalTokens: number;
  readonly available: boolean;
  readonly known: boolean;
} {
  if (next === undefined) {
    return {
      usage: current,
      totalTokens: currentTotalTokens,
      available: false,
      known: currentlyKnown,
    };
  }
  const nextTotal = usageTotal(next);
  return {
    usage: addUsage(current, next),
    totalTokens: nextTotal === undefined ? currentTotalTokens : currentTotalTokens + nextTotal,
    available: currentlyAvailable && nextTotal !== undefined,
    known: currentlyKnown || nextTotal !== undefined,
  };
}

function abortError(
  signal: AbortSignal | undefined,
  usage: ModelUsage | undefined,
  totalTokens: number,
  knownUsageAvailable: boolean,
  usageUnavailable: boolean,
): ModelGatewayAbortError {
  return new ModelGatewayAbortError(
    signal?.reason,
    knownUsageAvailable && usage !== undefined ? normalizedUsage(usage, totalTokens) : usage,
    usageUnavailable,
    true,
  );
}

class ProviderInvocationAborted extends Error {}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let abortTimeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (abortTimeout !== undefined) clearTimeout(abortTimeout);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => {
      abortTimeout = setTimeout(() => settle(() => reject(new ProviderInvocationAborted())), 0);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function usageTotal(usage: ModelUsage): number | undefined {
  if (isNonNegativeSafeInteger(usage.totalTokens)) return usage.totalTokens;
  if (
    isNonNegativeSafeInteger(usage.inputTokens) &&
    isNonNegativeSafeInteger(usage.outputTokens)
  ) {
    const total = usage.inputTokens + usage.outputTokens;
    return Number.isSafeInteger(total) ? total : undefined;
  }
  return undefined;
}

function isNonNegativeSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function addUsage(current: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  return {
    ...addUsageField("inputTokens", current, next),
    ...addUsageField("outputTokens", current, next),
    ...addUsageField("totalTokens", current, next),
  };
}

function addUsageField(
  field: keyof ModelUsage,
  current: ModelUsage | undefined,
  next: ModelUsage,
): Partial<ModelUsage> {
  const nextValue = next[field];
  if (nextValue === undefined) {
    return {};
  }
  return { [field]: (current?.[field] ?? 0) + nextValue };
}

function errorCodeOf(error: unknown): string {
  if (error instanceof ModelGatewayError) {
    return error.code;
  }
  return "ProviderUnavailable";
}

function normalizeProviderError(error: unknown): ModelGatewayError {
  if (isProviderError(error)) {
    return new ModelGatewayError(error.code, error.message, error.usage, true);
  }

  return new ModelGatewayError(
    "ProviderUnavailable",
    "The model provider is unavailable.",
    undefined,
    true,
  );
}

function isProviderError(
  error: unknown,
): error is {
  readonly code: ModelProviderErrorCode;
  readonly message: string;
  readonly usage?: ModelUsage;
} {
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
