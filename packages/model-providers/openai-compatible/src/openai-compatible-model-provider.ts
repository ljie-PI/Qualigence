import OpenAI from "openai";
import type {
  ModelCapabilities,
  ModelMessage,
  ModelProvider,
  ModelProviderError,
  ModelProviderRequest,
  ModelProviderResponse,
} from "@qualigence/model-provider";

export interface OpenAICompatibleModelProviderOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly visionInput?: boolean;
}

const normalizedModelProviderErrorBrand: unique symbol = Symbol("NormalizedModelProviderError");
type NormalizedModelProviderError = ModelProviderError & {
  readonly [normalizedModelProviderErrorBrand]: true;
};

export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly capabilities: ModelCapabilities;

  private readonly client: OpenAI;

  constructor(options: OpenAICompatibleModelProviderOptions) {
    this.capabilities = {
      structuredOutput: true,
      visionInput: options.visionInput === true,
      toolCalling: false,
      streaming: false,
    };
    this.client = new OpenAI({
      baseURL: options.baseUrl,
      apiKey: options.apiKey,
      maxRetries: 0,
    });
  }

  async invoke(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: request.model,
          messages: request.messages.map((message) => this.mapMessage(message)),
          response_format: {
            type: "json_schema",
            json_schema: {
              name: request.operation.replaceAll(".", "_"),
              strict: true,
              schema: request.responseSchema,
            },
          },
          ...(request.maximumOutputTokens === undefined
            ? {}
            : { max_completion_tokens: request.maximumOutputTokens }),
        },
        {
          timeout: request.timeoutMs,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      );
      const content = completion.choices[0]?.message.content;
      let output: unknown = content;
      if (typeof content === "string") {
        try {
          output = JSON.parse(content);
        } catch {
          // Preserve malformed content so the gateway can apply its single
          // structured-output correction attempt instead of a transient retry.
        }
      }

      return {
        output,
        model: completion.model,
        providerRequestId: completion.id,
        finishReason: completion.choices[0]?.finish_reason ?? "unknown",
        ...(completion.usage === undefined
          ? {}
          : {
              usage: {
                inputTokens: completion.usage.prompt_tokens,
                outputTokens: completion.usage.completion_tokens,
                totalTokens: completion.usage.total_tokens,
              },
            }),
      };
    } catch (error) {
      if (isModelProviderError(error)) {
        throw error;
      }

      throw mapProviderError(error);
    }
  }

  private mapMessage(
    message: ModelMessage,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam {
    const images = message.images ?? [];
    if (images.length === 0 || !this.capabilities.visionInput || message.role !== "user") {
      return { role: message.role, content: message.content };
    }

    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: message.content },
      ...images.map((image) => ({
        type: "image_url" as const,
        image_url: { url: `data:${image.mediaType};base64,${image.dataBase64}` },
      })),
    ];

    return { role: "user", content: parts };
  }
}

function mapProviderError(error: unknown): ModelProviderError {
  const status = typeof error === "object" && error !== null
    ? (error as { readonly status?: unknown }).status
    : undefined;

  if (status === 401 || status === 403) {
    return modelProviderError(
      "AuthenticationFailed",
      "The model provider rejected authentication.",
      usageFromError(error),
    );
  }
  if (status === 429) {
    return modelProviderError(
      "RateLimited",
      "The model provider rate limited the request.",
      usageFromError(error),
    );
  }
  if (status === 408) {
    return modelProviderError(
      "TimedOut",
      "The model provider request timed out.",
      usageFromError(error),
    );
  }
  if (typeof status === "number" && status >= 400 && status < 500) {
    return modelProviderError(
      "InvalidRequest",
      "The model provider rejected the request.",
      usageFromError(error),
    );
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return modelProviderError(
      "TimedOut",
      "The model provider request timed out.",
      usageFromError(error),
    );
  }

  return modelProviderError(
    "ProviderUnavailable",
    "The model provider request failed.",
    usageFromError(error),
  );
}

function modelProviderError(
  code: ModelProviderError["code"],
  message: string,
  usage: ModelProviderError["usage"],
): NormalizedModelProviderError {
  return {
    code,
    message,
    ...(usage === undefined ? {} : { usage }),
    [normalizedModelProviderErrorBrand]: true,
  };
}

function usageFromError(error: unknown): ModelProviderError["usage"] {
  if (typeof error !== "object" || error === null) return undefined;
  const candidateError = error as {
    readonly usage?: unknown;
    readonly error?: { readonly usage?: unknown };
  };
  const usage = candidateError.usage ?? candidateError.error?.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const candidate = usage as {
    readonly inputTokens?: unknown;
    readonly outputTokens?: unknown;
    readonly totalTokens?: unknown;
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly total_tokens?: unknown;
  };
  const inputTokens = tokenCount(candidate.inputTokens ?? candidate.prompt_tokens);
  const outputTokens = tokenCount(candidate.outputTokens ?? candidate.completion_tokens);
  const totalTokens = tokenCount(candidate.totalTokens ?? candidate.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function isModelProviderError(error: unknown): error is NormalizedModelProviderError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  return (error as Partial<NormalizedModelProviderError>)[normalizedModelProviderErrorBrand] === true;
}
