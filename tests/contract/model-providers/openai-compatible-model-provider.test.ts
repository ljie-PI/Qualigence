import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleModelProvider } from "@qualigence/openai-compatible-model-provider";

describe("OpenAICompatibleModelProvider", () => {
  it("maps a structured chat-completions request and response", async () => {
    const requests: unknown[] = [];
    const server = createServer(async (request, response) => {
      requests.push(JSON.parse(await readBody(request)));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "chatcmpl-1",
          model: "compatible-model",
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"ok"}' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP listener.");
    }

    try {
      const provider = new OpenAICompatibleModelProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "test-key",
      });
      const result = await provider.invoke({
        operation: "execution.decision",
        model: "compatible-model",
        messages: [{ role: "user", content: "choose" }],
        responseSchema: { type: "object" },
        timeoutMs: 1_000,
        maximumOutputTokens: 321,
      });

      expect(result).toMatchObject({
        output: { answer: "ok" },
        model: "compatible-model",
        providerRequestId: "chatcmpl-1",
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      });
      expect(requests).toEqual([
        expect.objectContaining({
          model: "compatible-model",
          messages: [{ role: "user", content: "choose" }],
          response_format: expect.objectContaining({ type: "json_schema" }),
          max_completion_tokens: 321,
        }),
      ]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("normalizes an aborted SDK request as TimedOut", async () => {
    const server = createServer((_request, _response) => {
      // Keep the connection open until the SDK aborts it at the request timeout.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP listener.");
    }

    try {
      const provider = new OpenAICompatibleModelProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "test-key",
      });

      await expect(
        provider.invoke({
          operation: "execution.decision",
          model: "compatible-model",
          messages: [{ role: "user", content: "choose" }],
          responseSchema: { type: "object" },
          timeoutMs: 25,
        }),
      ).rejects.toMatchObject({ code: "TimedOut" });
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  it.each([
    {
      statusCode: 400,
      providerCode: "InvalidRequest",
      expectedCode: "InvalidRequest",
      expectedMessage: "The model provider rejected the request.",
    },
    {
      statusCode: 401,
      providerCode: "invalid_api_key",
      expectedCode: "AuthenticationFailed",
      expectedMessage: "The model provider rejected authentication.",
    },
    {
      statusCode: 403,
      providerCode: "forbidden",
      expectedCode: "AuthenticationFailed",
      expectedMessage: "The model provider rejected authentication.",
    },
    {
      statusCode: 408,
      providerCode: "request_timeout",
      expectedCode: "TimedOut",
      expectedMessage: "The model provider request timed out.",
    },
    {
      statusCode: 409,
      providerCode: "conflict",
      expectedCode: "InvalidRequest",
      expectedMessage: "The model provider rejected the request.",
    },
    {
      statusCode: 429,
      providerCode: "rate_limit_exceeded",
      expectedCode: "RateLimited",
      expectedMessage: "The model provider rate limited the request.",
    },
    {
      statusCode: 500,
      providerCode: "server_error",
      expectedCode: "ProviderUnavailable",
      expectedMessage: "The model provider request failed.",
    },
  ])(
    "normalizes HTTP $statusCode without leaking provider code $providerCode",
    async ({ statusCode, providerCode, expectedCode, expectedMessage }) => {
      const server = createServer((_request, response) => {
        response.statusCode = statusCode;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: {
              message: "provider detail",
              type: "provider_error",
              code: providerCode,
            },
          }),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected TCP listener.");
      }

      try {
        const provider = new OpenAICompatibleModelProvider({
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-key",
        });

        await expect(
          provider.invoke({
            operation: "execution.decision",
            model: "compatible-model",
            messages: [{ role: "user", content: "choose" }],
            responseSchema: { type: "object" },
            timeoutMs: 1_000,
          }),
        ).rejects.toMatchObject({ code: expectedCode, message: expectedMessage });
      } finally {
        server.closeAllConnections();
        server.close();
        await once(server, "close");
      }
    },
  );

  it("preserves provider-reported usage on a failed request", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 429;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        error: {
          message: "provider detail",
          type: "provider_error",
          code: "rate_limit_exceeded",
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        },
      }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP listener.");
    }

    try {
      const provider = new OpenAICompatibleModelProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "test-key",
      });

      await expect(provider.invoke({
        operation: "execution.decision",
        model: "compatible-model",
        messages: [{ role: "user", content: "choose" }],
        responseSchema: { type: "object" },
        timeoutMs: 1_000,
      })).rejects.toMatchObject({
        code: "RateLimited",
        usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
      });
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  it("returns malformed structured content for gateway schema correction", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "chatcmpl-malformed",
          model: "compatible-model",
          choices: [{ finish_reason: "stop", message: { content: "not-json" } }],
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP listener.");
    }

    try {
      const provider = new OpenAICompatibleModelProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "test-key",
      });

      await expect(
        provider.invoke({
          operation: "execution.decision",
          model: "compatible-model",
          messages: [{ role: "user", content: "choose" }],
          responseSchema: { type: "object" },
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ output: "not-json" });
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  it("returns null structured content for gateway schema correction", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "chatcmpl-no-content",
          model: "compatible-model",
          choices: [{ finish_reason: "stop", message: { content: null } }],
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP listener.");
    }

    try {
      const provider = new OpenAICompatibleModelProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "test-key",
      });

      await expect(
        provider.invoke({
          operation: "execution.decision",
          model: "compatible-model",
          messages: [{ role: "user", content: "choose" }],
          responseSchema: { type: "object" },
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ output: null });
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}
