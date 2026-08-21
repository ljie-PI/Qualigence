import type { ModelDataPolicy, ModelImageInput } from "./content.js";

export type {
  ModelDataPolicy,
  ModelImageInput,
  ModelImageMediaType,
  ModelImageSensitivity,
  SafeImageMetadata,
} from "./content.js";
export { base64ByteLength, describeImage } from "./content.js";

export type ModelOperation =
  | "execution.decision"
  | "execution.verification"
  | "planning.prd-test-cases"
  | "skill.induction"
  | "exploration.next-action"
  | "investigation.reproduction-planning"
  | "investigation.bug-analysis";

export interface ModelCapabilities {
  readonly structuredOutput: boolean;
  readonly visionInput: boolean;
  readonly toolCalling: boolean;
  readonly streaming: boolean;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonSchema = { readonly [key: string]: JsonValue };

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly images?: readonly ModelImageInput[];
}

/**
 * Optional per-invocation audit context. Carried on {@link StructuredModelRequest}
 * so the Gateway can emit a single de-identified invocation report without the
 * provider or gateway depending on the Evidence module.
 */
export interface ModelInvocationContext {
  readonly runId: string;
  readonly invocationId: string;
}

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export type ModelUsageState =
  | { readonly status: "available"; readonly usage: ModelUsage }
  | { readonly status: "unavailable"; readonly knownUsage?: ModelUsage };

export interface ModelProviderRequest {
  readonly operation: ModelOperation;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly responseSchema: JsonSchema;
  readonly timeoutMs: number;
  readonly maximumOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface ModelProviderResponse {
  readonly output: unknown;
  readonly model: string;
  readonly providerRequestId?: string;
  readonly finishReason: string;
  readonly usage?: ModelUsage;
}

export type ModelProviderErrorCode =
  | "AuthenticationFailed"
  | "InvalidRequest"
  | "RateLimited"
  | "TimedOut"
  | "ProviderUnavailable";

export interface ModelProviderError {
  readonly code: ModelProviderErrorCode;
  readonly message: string;
  readonly usage?: ModelUsage;
}

export interface ModelProvider {
  readonly capabilities: ModelCapabilities;
  invoke(request: ModelProviderRequest): Promise<ModelProviderResponse>;
}

export interface StructuredModelRequest {
  readonly operation: ModelOperation;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly timeoutMs: number;
  readonly maximumOutputTokens?: number;
  readonly signal?: AbortSignal;
  readonly invocation?: ModelInvocationContext;
  readonly dataPolicy?: ModelDataPolicy;
}

export interface StructuredOutputContract<T> {
  readonly name: string;
  readonly jsonSchema: JsonSchema;
  parse(value: unknown): T;
}

export interface StructuredOutputValidationIssue {
  readonly path: string;
  readonly reason: string;
}

export interface StructuredOutputValidationError extends Error {
  readonly name: "StructuredOutputValidationError";
  readonly issues: readonly StructuredOutputValidationIssue[];
}

export interface ValidatedModelResult<T> {
  readonly value: T;
  readonly model: string;
  readonly providerRequestId?: string;
  readonly finishReason: string;
  readonly usage?: ModelUsage;
  readonly usageState?: ModelUsageState;
}
