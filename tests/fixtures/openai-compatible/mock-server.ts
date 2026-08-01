import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import {
  blockedDecisionPayload,
  completion,
  decisionPayload,
  parseUserContext,
  verificationPayload,
  type ChatCompletionRequestBody,
} from "./responses.js";

export interface FixtureHandle {
  readonly url: string;
  close(): Promise<void>;
}

export type MockModelMode = "dynamic" | "blocked" | "unauthorized";

export interface MockModelHandle extends FixtureHandle {
  requestCount(): number;
}

export interface StartMockModelServerOptions {
  readonly mode?: MockModelMode;
}

/**
 * A fully local OpenAI-compatible endpoint. It binds `127.0.0.1:0`, exposes
 * `/health`, counts requests for retry assertions and answers
 * `/v1/chat/completions` by deriving the Decision/Verification from the current
 * Observation. It never reaches the public network.
 *
 * - `dynamic`: drives the cart to success and reports a Finding only when the
 *   observed cart total diverges from the item price.
 * - `blocked`: returns a Decision referencing a node absent from the graph so
 *   the Gateway's single correction fails and the run blocks.
 * - `unauthorized`: rejects every completion with HTTP 401.
 */
export async function startMockModelServer(
  options: StartMockModelServerOptions = {},
): Promise<MockModelHandle> {
  const mode: MockModelMode = options.mode ?? "dynamic";
  const app: FastifyInstance = Fastify();
  let requests = 0;

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/v1/chat/completions", async (request, reply) => {
    requests += 1;

    if (mode === "unauthorized") {
      return reply.code(401).send({
        error: {
          message: "invalid api key",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      });
    }

    const body = request.body as ChatCompletionRequestBody;
    const operation = body.response_format.json_schema.name;
    const context = parseUserContext(body.messages);

    let payload: unknown;
    if (operation === "execution_decision") {
      if (context.observation === undefined) {
        return reply.code(400).send({ error: "missing observation in decision request" });
      }
      payload =
        mode === "blocked"
          ? blockedDecisionPayload(context.observation)
          : decisionPayload(context.observation);
    } else if (operation === "execution_verification") {
      if (context.before === undefined || context.after === undefined) {
        return reply
          .code(400)
          .send({ error: "missing before/after in verification request" });
      }
      payload = verificationPayload(context.before, context.after);
    } else {
      return reply.code(400).send({ error: `unknown operation ${operation}` });
    }

    return reply
      .code(200)
      .header("content-type", "application/json")
      .send(completion(body.model, payload));
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requests,
    close: async () => {
      await app.close();
    },
  };
}
