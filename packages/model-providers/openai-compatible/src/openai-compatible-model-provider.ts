import OpenAI from "openai";
import type {
  ModelProvider,
  ModelProviderError,
  ModelProviderRequest,
  ModelProviderResponse,
} from "@qualigence/model-provider";

export interface OpenAICompatibleModelProviderOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
}

const normalizedModelProviderErrorBrand: unique symbol = Symbol("NormalizedModelProviderError");
type NormalizedModelProviderError = ModelProviderError & {
  readonly [normalizedModelProviderErrorBrand]: true;
};

export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly capabilities = {
    structuredOutput: true,
    visionInput: false,
    toolCalling: false,
    streaming: false,
  } as const;

  private readonly client: OpenAI;

  constructor(options: OpenAICompatibleModelProviderOptions) {
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
          messages: [...request.messages],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: request.operation.replaceAll(".", "_"),
              strict: true,
              schema: request.responseSchema,
            },
          },
        },
        { timeout: request.timeoutMs },
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
}

function mapProviderError(error: unknown): ModelProviderError {
  const status = typeof error === "object" && error !== null
    ? (error as { readonly status?: unknown }).status
    : undefined;

  if (status === 401 || status === 403) {
    return modelProviderError("AuthenticationFailed", "The model provider rejected authentication.");
  }
  if (status === 429) {
    return modelProviderError("RateLimited", "The model provider rate limited the request.");
  }
  if (status === 408) {
    return modelProviderError("TimedOut", "The model provider request timed out.");
  }
  if (typeof status === "number" && status >= 400 && status < 500) {
    return modelProviderError("InvalidRequest", "The model provider rejected the request.");
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return modelProviderError("TimedOut", "The model provider request timed out.");
  }

  return modelProviderError("ProviderUnavailable", "The model provider request failed.");
}

function modelProviderError(
  code: ModelProviderError["code"],
  message: string,
): NormalizedModelProviderError {
  return { code, message, [normalizedModelProviderErrorBrand]: true };
}

function isModelProviderError(error: unknown): error is NormalizedModelProviderError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  return (error as Partial<NormalizedModelProviderError>)[normalizedModelProviderErrorBrand] === true;
}
