import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleModelProvider } from "@qualigence/openai-compatible-model-provider";
import type { ModelImageInput } from "@qualigence/model-provider";

const PNG_MARKER = "QUALIGENCE_SECRET_PIXELS_DO_NOT_LOG";

describe("OpenAICompatibleModelProvider vision mapping", () => {
  it("maps image attachments to OpenAI image_url content parts when vision is enabled", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      bodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "chatcmpl-vision",
          model: "vision-model",
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"ok"}' } }],
        }),
      );
    });
    const port = await listen(server);

    try {
      const provider = new OpenAICompatibleModelProvider({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test-key",
        visionInput: true,
      });
      expect(provider.capabilities.visionInput).toBe(true);

      const result = await provider.invoke({
        operation: "execution.decision",
        model: "vision-model",
        messages: [{ role: "user", content: "describe", images: [imageInput()] }],
        responseSchema: { type: "object" },
        timeoutMs: 1_000,
      });

      expect(result.output).toEqual({ answer: "ok" });
      const message = (bodies[0]?.messages as Array<Record<string, unknown>>)[0];
      expect(message?.content).toEqual([
        { type: "text", text: "describe" },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${base64Payload()}` },
        },
      ]);
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  it("keeps text-only content as a plain string", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      bodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "chatcmpl-text",
          model: "vision-model",
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"ok"}' } }],
        }),
      );
    });
    const port = await listen(server);

    try {
      const provider = new OpenAICompatibleModelProvider({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test-key",
        visionInput: true,
      });

      await provider.invoke({
        operation: "execution.decision",
        model: "vision-model",
        messages: [{ role: "user", content: "choose" }],
        responseSchema: { type: "object" },
        timeoutMs: 1_000,
      });

      const message = (bodies[0]?.messages as Array<Record<string, unknown>>)[0];
      expect(message?.content).toBe("choose");
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  it("defaults to no vision capability", () => {
    const provider = new OpenAICompatibleModelProvider({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test-key",
    });
    expect(provider.capabilities.visionInput).toBe(false);
  });

  it("does not leak base64 image data when the provider request fails", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { message: "boom" } }));
    });
    const port = await listen(server);

    try {
      const provider = new OpenAICompatibleModelProvider({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test-key",
        visionInput: true,
      });

      let captured: unknown;
      try {
        await provider.invoke({
          operation: "execution.decision",
          model: "vision-model",
          messages: [{ role: "user", content: "describe", images: [imageInput()] }],
          responseSchema: { type: "object" },
          timeoutMs: 1_000,
        });
      } catch (error) {
        captured = error;
      }

      const serialized = JSON.stringify({
        value: captured,
        message: (captured as { message?: string }).message,
      });
      expect(serialized).not.toContain(PNG_MARKER);
      expect(serialized).not.toContain(base64Payload());
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });
});

function base64Payload(): string {
  return Buffer.from(PNG_MARKER, "utf8").toString("base64");
}

function imageInput(): ModelImageInput {
  const dataBase64 = base64Payload();
  return {
    mediaType: "image/png",
    dataBase64,
    sha256: createHash("sha256").update(Buffer.from(dataBase64, "base64")).digest("hex"),
    sensitivity: "internal",
    sourceArtifactId: "artifact-1",
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP listener.");
  }
  return address.port;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
