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
        }),
      ]);
    } finally {
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
