export type ModelOperation = "execution.decision" | "execution.verification";

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
}

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ModelProviderRequest {
  readonly operation: ModelOperation;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly responseSchema: JsonSchema;
  readonly timeoutMs: number;
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
  | "RateLimited"
  | "TimedOut"
  | "ProviderUnavailable";

export interface ModelProviderError {
  readonly code: ModelProviderErrorCode;
  readonly message: string;
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
}

export interface StructuredOutputContract<T> {
  readonly name: string;
  readonly jsonSchema: JsonSchema;
  parse(value: unknown): T;
}

export interface ValidatedModelResult<T> {
  readonly value: T;
  readonly model: string;
  readonly providerRequestId?: string;
  readonly finishReason: string;
  readonly usage?: ModelUsage;
}
